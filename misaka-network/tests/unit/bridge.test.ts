// ============================================================
// Misaka Network - ZK Bridge Tests
// ============================================================
// Tests all 5 bridge components:
//   1. Solana Program (lock/unlock)
//   2. ZK Proof Generation (deposit/withdraw proofs)
//   3. Misaka Verifier (proof verification)
//   4. Relayer (end-to-end relay)
//   5. Reverse flow (Misaka → Solana)
// ============================================================

import { initCurve } from '../../src/privacy/curve';
import { pedersenCommit, toBaseUnits } from '../../src/privacy/pedersen';
import {
  SolanaBridgeProgram,
  MisakaBridgeHandler,
  BridgeRelayer,
  generateVerificationKey,
  proveDeposit,
  proveWithdraw,
  verifyBridgeProof,
  quickVerify,
  hashProgramId,
  hashRecipient,
  computeLockEventHash,
  evaluateCircuit,
  BridgeToken,
  BridgeDirection,
  BridgeStatus,
  defaultBridgeConfig,
} from '../../src/bridge';
import type { SolanaLockEvent, ZKProof } from '../../src/bridge/types';
import { validateTransaction } from '../../src/core/transaction';
import { TransactionType } from '../../src/types';
import { hashPubKey, toHex } from '../../src/utils/crypto';
import nacl from 'tweetnacl';

const PROGRAM_ID = 'BridgeMisakaProgram1111111111111111111111111';

beforeAll(async () => {
  await initCurve();
}, 15000);

// ============================================================
// 1. Solana Bridge Program Tests
// ============================================================

describe('Solana Bridge Program', () => {
  let program: SolanaBridgeProgram;

  beforeEach(() => {
    program = new SolanaBridgeProgram(PROGRAM_ID, 'authority1');
  });

  test('fund account and check balance', () => {
    program.fundAccount('alice_sol', BridgeToken.SOL, 10_000_000_000n);
    expect(program.getBalance('alice_sol', BridgeToken.SOL)).toBe(10_000_000_000n);
  });

  test('lock SOL on Solana', () => {
    program.fundAccount('alice_sol', BridgeToken.SOL, 10_000_000_000n);
    const result = program.lock('alice_sol', 1_000_000_000n, BridgeToken.SOL, 'misaka_recipient_hash');

    expect('txSignature' in result).toBe(true);
    if ('txSignature' in result) {
      expect(result.amount).toBe(1_000_000_000n);
      expect(result.token).toBe(BridgeToken.SOL);
      expect(result.nonce).toBeTruthy();
      expect(result.programId).toBe(PROGRAM_ID);
    }
  });

  test('lock reduces balance', () => {
    program.fundAccount('alice_sol', BridgeToken.SOL, 10_000_000_000n);
    program.lock('alice_sol', 3_000_000_000n, BridgeToken.SOL, 'recipient');
    expect(program.getBalance('alice_sol', BridgeToken.SOL)).toBe(7_000_000_000n);
  });

  test('lock increases locked balance', () => {
    program.fundAccount('alice_sol', BridgeToken.SOL, 10_000_000_000n);
    program.lock('alice_sol', 3_000_000_000n, BridgeToken.SOL, 'recipient');
    expect(program.getLockedBalance(BridgeToken.SOL)).toBe(3_000_000_000n);
  });

  test('lock fails with insufficient balance', () => {
    program.fundAccount('alice_sol', BridgeToken.SOL, 100n);
    const result = program.lock('alice_sol', 1_000_000_000n, BridgeToken.SOL, 'recipient');
    expect('error' in result).toBe(true);
  });

  test('lock fails with zero amount', () => {
    program.fundAccount('alice_sol', BridgeToken.SOL, 10_000_000_000n);
    const result = program.lock('alice_sol', 0n, BridgeToken.SOL, 'recipient');
    expect('error' in result).toBe(true);
  });

  test('retrieve lock event by nonce', () => {
    program.fundAccount('alice_sol', BridgeToken.SOL, 10_000_000_000n);
    const lockResult = program.lock('alice_sol', 1_000_000_000n, BridgeToken.SOL, 'recipient');
    if ('nonce' in lockResult) {
      const event = program.getLockEvent(lockResult.nonce);
      expect(event).toBeDefined();
      expect(event!.amount).toBe(1_000_000_000n);
    }
  });

  test('unlock after valid proof', () => {
    program.fundAccount('alice_sol', BridgeToken.SOL, 10_000_000_000n);
    program.lock('alice_sol', 5_000_000_000n, BridgeToken.SOL, 'recipient');

    const proof = createMockProof(5_000_000_000n, BridgeDirection.MISAKA_TO_SOLANA);

    const result = program.unlock({
      burnTxId: 'misaka_burn_001',
      recipientAddress: 'bob_sol',
      amount: 5_000_000_000n,
      token: BridgeToken.SOL,
      proof,
      nonce: 'unlock_nonce_001',
    });

    expect('txSignature' in result).toBe(true);
    if ('txSignature' in result) {
      expect(result.amount).toBe(5_000_000_000n);
    }
    expect(program.getBalance('bob_sol', BridgeToken.SOL)).toBe(5_000_000_000n);
    expect(program.getLockedBalance(BridgeToken.SOL)).toBe(0n);
  });

  test('unlock fails on double-process', () => {
    program.fundAccount('alice_sol', BridgeToken.SOL, 10_000_000_000n);
    program.lock('alice_sol', 5_000_000_000n, BridgeToken.SOL, 'recipient');

    const proof = createMockProof(5_000_000_000n, BridgeDirection.MISAKA_TO_SOLANA);
    const instruction = {
      burnTxId: 'burn_001',
      recipientAddress: 'bob_sol',
      amount: 5_000_000_000n,
      token: BridgeToken.SOL,
      proof,
      nonce: 'nonce_001',
    };

    program.unlock(instruction);
    const result = program.unlock(instruction);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('already processed');
  });

  test('get state summary', () => {
    program.fundAccount('alice_sol', BridgeToken.SOL, 10_000_000_000n);
    program.lock('alice_sol', 1_000_000_000n, BridgeToken.SOL, 'rec');

    const summary = program.getStateSummary();
    expect(summary.programId).toBe(PROGRAM_ID);
    expect(summary.totalLockEvents).toBe(1);
  });
});

// ============================================================
// 2. ZK Proof Generation Tests
// ============================================================

describe('ZK Proof Generation', () => {
  test('generate verification key', () => {
    const vk = generateVerificationKey();
    expect(vk.version).toBe('schnorr_bridge_v1');
    expect(vk.alpha).toHaveLength(64);
    expect(vk.beta).toHaveLength(64);
    expect(vk.delta).toHaveLength(64);
    expect(vk.gamma.length).toBeGreaterThan(0);
  });

  test('prove deposit (Solana → Misaka)', () => {
    const amount = toBaseUnits(1000);
    const commitment = pedersenCommit(amount);

    const lockEvent = createMockLockEvent(amount);
    const proof = proveDeposit(
      lockEvent,
      commitment,
      PROGRAM_ID,
      'recipient_hash_001',
    );

    expect(proof.protocol).toBe('schnorr_bridge');
    expect(proof.proofA).toHaveLength(64);
    expect(proof.proofB).toHaveLength(64);
    expect(proof.proofC).toHaveLength(64);
    expect(proof.publicInputs.direction).toBe(BridgeDirection.SOLANA_TO_MISAKA);
    expect(proof.publicInputs.amount).toBe(amount);
    expect(proof.publicInputs.amountCommitment).toBe(commitment.point);
  });

  test('prove withdraw (Misaka → Solana)', () => {
    const amount = 500_000n;
    const proof = proveWithdraw(
      'burn_tx_001',
      amount,
      'solana_recipient_addr',
      'withdraw_nonce_001',
      ['key_image_001', 'key_image_002'],
      PROGRAM_ID,
    );

    expect(proof.protocol).toBe('schnorr_bridge');
    expect(proof.publicInputs.direction).toBe(BridgeDirection.MISAKA_TO_SOLANA);
    expect(proof.publicInputs.amount).toBe(amount);
  });

  test('circuit evaluation passes for valid witness', () => {
    const amount = toBaseUnits(5000);
    const commitment = pedersenCommit(amount);
    const programHash = hashProgramId(PROGRAM_ID);
    const recipientHash = hashRecipient('recipient_001');

    const constraints = evaluateCircuit(
      amount, commitment.blinding, commitment.point,
      'tx_sig_123', 'locker_addr', 42, 'nonce_123',
      programHash, recipientHash,
    );

    const allSatisfied = constraints.every(c => c.satisfied);
    expect(allSatisfied).toBe(true);
  });

  test('circuit fails for zero amount', () => {
    const commitment = pedersenCommit(0n, 0n);
    const constraints = evaluateCircuit(
      0n, 0n, commitment.point,
      'tx_sig', 'locker', 1, 'nonce',
      hashProgramId(PROGRAM_ID), hashRecipient('r'),
    );
    const amountCheck = constraints.find(c => c.name === 'amount_positive');
    expect(amountCheck?.satisfied).toBe(false);
  });
});

// ============================================================
// 3. ZK Proof Verification Tests
// ============================================================

describe('ZK Proof Verification', () => {
  let vk: ReturnType<typeof generateVerificationKey>;
  let config: ReturnType<typeof defaultBridgeConfig>;

  beforeAll(() => {
    vk = generateVerificationKey();
    config = defaultBridgeConfig(vk);
  });

  test('verify valid deposit proof', () => {
    const amount = toBaseUnits(1000);
    const commitment = pedersenCommit(amount);
    const lockEvent = createMockLockEvent(amount);

    const proof = proveDeposit(lockEvent, commitment, PROGRAM_ID, 'recipient_001');

    const result = verifyBridgeProof(proof, vk, config, new Set());
    expect(result.valid).toBe(true);
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.every(c => c.passed)).toBe(true);
  });

  test('reject replayed nonce', () => {
    const amount = toBaseUnits(500);
    const commitment = pedersenCommit(amount);
    const lockEvent = createMockLockEvent(amount);
    const proof = proveDeposit(lockEvent, commitment, PROGRAM_ID, 'recipient');

    const usedNonces = new Set([proof.publicInputs.nonce]);
    const result = verifyBridgeProof(proof, vk, config, usedNonces);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('replay');
  });

  test('quick verify returns boolean', () => {
    const amount = 50_000_000n; // Within default bridge limits
    const commitment = pedersenCommit(amount);
    const lockEvent = createMockLockEvent(amount);
    const proof = proveDeposit(lockEvent, commitment, PROGRAM_ID, 'recipient');

    expect(quickVerify(proof, vk, config, new Set())).toBe(true);
  });

  test('verify valid withdraw proof', () => {
    const proof = proveWithdraw(
      'burn_tx_001', 5_000_000n, 'sol_recipient', 'nonce_001',
      ['ki_001'], PROGRAM_ID,
    );
    const result = verifyBridgeProof(proof, vk, config, new Set());
    expect(result.valid).toBe(true);
  });
});

// ============================================================
// 4. Misaka Bridge Handler Tests
// ============================================================

describe('Misaka Bridge Handler', () => {
  let handler: MisakaBridgeHandler;

  beforeEach(() => {
    handler = new MisakaBridgeHandler();
  });

  test('process valid deposit', () => {
    const amount = toBaseUnits(1000);
    const commitment = pedersenCommit(amount);
    const lockEvent = createMockLockEvent(amount);

    const proof = proveDeposit(
      lockEvent, commitment, PROGRAM_ID, 'recipient_hash',
    );

    const lockEventHash = computeLockEventHash(
      lockEvent.txSignature, lockEvent.lockerAddress,
      lockEvent.amount, lockEvent.slot, lockEvent.nonce, lockEvent.programId,
    );

    const result = handler.processDeposit({
      proof,
      lockEventHash,
      amount: Number(amount),
      recipientPubKeyHash: 'recipient_hash',
      token: BridgeToken.SOL,
      nonce: lockEvent.nonce,
    });

    expect('tx' in result).toBe(true);
    if ('tx' in result) {
      expect(result.tx.type).toBe(TransactionType.DEPOSIT);
      expect(result.tx.outputs.length).toBeGreaterThanOrEqual(1);
      expect(result.tx.fee).toBe(0); // Bridge deposits have no Misaka fee
    }
  });

  test('deposit TX passes validation with bridge enabled', () => {
    const amount = toBaseUnits(1000);
    const commitment = pedersenCommit(amount);
    const lockEvent = createMockLockEvent(amount);
    const proof = proveDeposit(lockEvent, commitment, PROGRAM_ID, 'recipient_hash');
    const lockEventHash = computeLockEventHash(
      lockEvent.txSignature, lockEvent.lockerAddress,
      lockEvent.amount, lockEvent.slot, lockEvent.nonce, lockEvent.programId,
    );

    const result = handler.processDeposit({
      proof, lockEventHash, amount: Number(amount),
      recipientPubKeyHash: 'recipient_hash',
      token: BridgeToken.SOL, nonce: lockEvent.nonce,
    });

    if ('tx' in result) {
      // With bridge enabled: should pass
      const err = validateTransaction(result.tx, () => undefined, undefined, { bridgeEnabled: true });
      expect(err).toBeNull();

      // Without bridge: should be rejected
      const err2 = validateTransaction(result.tx, () => undefined);
      expect(err2).toContain('reserved');
    }
  });

  test('reject duplicate nonce', () => {
    const amount = toBaseUnits(500);
    const commitment = pedersenCommit(amount);
    const lockEvent = createMockLockEvent(amount);
    const proof = proveDeposit(lockEvent, commitment, PROGRAM_ID, 'recipient');
    const lockEventHash = computeLockEventHash(
      lockEvent.txSignature, lockEvent.lockerAddress,
      lockEvent.amount, lockEvent.slot, lockEvent.nonce, lockEvent.programId,
    );

    const depositData = {
      proof, lockEventHash, amount: Number(amount),
      recipientPubKeyHash: 'recipient',
      token: BridgeToken.SOL, nonce: lockEvent.nonce,
    };

    handler.processDeposit(depositData); // First: OK
    const result = handler.processDeposit(depositData); // Second: FAIL
    expect('error' in result).toBe(true);
  });

  test('process withdrawal', () => {
    const result = handler.processWithdraw(
      {
        amount: 5000,
        solanaRecipient: 'sol_addr_bob',
        token: BridgeToken.SOL,
        burnKeyImages: ['ki_001'],
        nonce: 'withdraw_nonce_001',
      },
      'spender_hash',
      [{ prevTxId: 'prev_001', outputIndex: 0, signature: 'sig', publicKey: 'pk' }],
    );

    expect('tx' in result).toBe(true);
    if ('tx' in result) {
      expect(result.tx.type).toBe(TransactionType.WITHDRAW);
      // Burn output goes to zero address
      expect(result.tx.outputs[0].recipientPubKeyHash).toBe('0'.repeat(64));
    }
  });

  test('withdraw TX passes validation with bridge enabled', () => {
    const result = handler.processWithdraw(
      {
        amount: 5000, solanaRecipient: 'sol_addr',
        token: BridgeToken.SOL, burnKeyImages: ['ki_001'], nonce: 'n1',
      },
      'spender', [{ prevTxId: 'p1', outputIndex: 0, signature: 's', publicKey: 'pk' }],
    );

    if ('tx' in result) {
      const err = validateTransaction(result.tx, () => undefined, undefined, { bridgeEnabled: true });
      expect(err).toBeNull();
    }
  });

  test('bridge state tracking', () => {
    const amount = 50_000_000n; // Within bridge limits
    const commitment = pedersenCommit(amount);
    const lockEvent = createMockLockEvent(amount);
    const proof = proveDeposit(lockEvent, commitment, PROGRAM_ID, 'r');
    const lockEventHash = computeLockEventHash(
      lockEvent.txSignature, lockEvent.lockerAddress,
      lockEvent.amount, lockEvent.slot, lockEvent.nonce, lockEvent.programId,
    );

    handler.processDeposit({
      proof, lockEventHash, amount: Number(amount),
      recipientPubKeyHash: 'r', token: BridgeToken.SOL, nonce: lockEvent.nonce,
    });

    const state = handler.getState();
    expect(state.processedNonces).toBe(1);
    expect(state.enabled).toBe(true);
  });
});

// ============================================================
// 5. Relayer E2E Tests
// ============================================================

describe('Bridge Relayer (end-to-end)', () => {
  let solana: SolanaBridgeProgram;
  let misaka: MisakaBridgeHandler;
  let relayer: BridgeRelayer;

  beforeEach(() => {
    solana = new SolanaBridgeProgram(PROGRAM_ID, 'authority');
    misaka = new MisakaBridgeHandler();
    relayer = new BridgeRelayer(solana, misaka);
  });

  test('full deposit flow: Solana lock → ZK proof → Misaka mint', () => {
    // 1. Alice locks SOL on Solana
    solana.fundAccount('alice_sol', BridgeToken.SOL, 10_000_000_000n);
    const lockResult = solana.lock(
      'alice_sol', 1_000_000_000n, BridgeToken.SOL, 'misaka_alice_hash'
    );
    expect('nonce' in lockResult).toBe(true);
    if (!('nonce' in lockResult)) return;

    // 2. Relayer processes the lock event
    const relayResult = relayer.processLockEvent(lockResult);
    expect('tx' in relayResult).toBe(true);

    if ('tx' in relayResult) {
      expect(relayResult.tx.type).toBe(TransactionType.DEPOSIT);
      expect(relayResult.tx.outputs[0].recipientPubKeyHash).toBe('misaka_alice_hash');
      expect(relayResult.operation.status).toBe(BridgeStatus.MINTED);
    }
  });

  test('full withdraw flow: Misaka burn → ZK proof → Solana unlock', () => {
    // Setup: Lock some SOL first (so there's balance to unlock)
    solana.fundAccount('alice_sol', BridgeToken.SOL, 10_000_000_000n);
    solana.lock('alice_sol', 5_000_000_000n, BridgeToken.SOL, 'misaka_alice');

    // 1. Alice burns on Misaka
    const withdrawData = {
      amount: 2_000_000_000,
      solanaRecipient: 'bob_sol',
      token: BridgeToken.SOL,
      burnKeyImages: ['ki_alice_001'],
      nonce: 'withdraw_nonce_abc',
    };

    // 2. Relayer processes the withdrawal
    const result = relayer.processWithdrawEvent('misaka_burn_tx_001', withdrawData);
    expect('solanaTxSig' in result).toBe(true);

    if ('solanaTxSig' in result) {
      expect(result.operation.status).toBe(BridgeStatus.COMPLETED);
      // Bob should have received SOL
      expect(solana.getBalance('bob_sol', BridgeToken.SOL)).toBe(2_000_000_000n);
      // Locked balance should decrease
      expect(solana.getLockedBalance(BridgeToken.SOL)).toBe(3_000_000_000n);
    }
  });

  test('relayer detects pending locks', () => {
    solana.fundAccount('a', BridgeToken.SOL, 10_000_000_000n);
    solana.lock('a', 10_000_000n, BridgeToken.SOL, 'r1');
    solana.lock('a', 20_000_000n, BridgeToken.SOL, 'r2');

    const pending = relayer.scanForPendingLocks();
    expect(pending.length).toBe(2);
  });

  test('process all pending locks', () => {
    solana.fundAccount('a', BridgeToken.SOL, 10_000_000_000n);
    solana.lock('a', 10_000_000n, BridgeToken.SOL, 'r1');
    solana.lock('a', 20_000_000n, BridgeToken.SOL, 'r2');

    const results = relayer.processAllPendingLocks();
    expect(results.length).toBe(2);
    for (const r of results) {
      expect('tx' in r).toBe(true);
    }

    // No more pending
    expect(relayer.scanForPendingLocks().length).toBe(0);
  });

  test('relayer prevents double processing', () => {
    solana.fundAccount('a', BridgeToken.SOL, 10_000_000_000n);
    const lockResult = solana.lock('a', 10_000_000n, BridgeToken.SOL, 'r1');
    if (!('nonce' in lockResult)) return;

    const r1 = relayer.processLockEvent(lockResult);
    expect('tx' in r1).toBe(true);

    const r2 = relayer.processLockEvent(lockResult);
    expect('error' in r2).toBe(true);
  });

  test('relayer event emission', () => {
    const events: string[] = [];
    relayer.onEvent(e => events.push(e.type));

    solana.fundAccount('a', BridgeToken.SOL, 10_000_000_000n);
    const lockResult = solana.lock('a', 10_000_000n, BridgeToken.SOL, 'r');
    if ('nonce' in lockResult) {
      relayer.processLockEvent(lockResult);
    }

    expect(events).toContain('deposit_detected');
    expect(events).toContain('proof_generated');
    expect(events).toContain('deposit_submitted');
  });

  test('relayer stats', () => {
    solana.fundAccount('a', BridgeToken.SOL, 10_000_000_000n);
    const lock = solana.lock('a', 10_000_000n, BridgeToken.SOL, 'r');
    if ('nonce' in lock) relayer.processLockEvent(lock);

    const stats = relayer.getStats();
    expect(stats.totalOperations).toBe(1);
    expect(stats.deposits).toBe(1);
    expect(stats.completed).toBe(1);
  });
});

// ============================================================
// 6. Bridge > Privacy Priority Tests
// ============================================================

describe('Bridge > Privacy Priority', () => {
  test('deposit amounts are publicly visible (bridge requirement)', () => {
    const amount = toBaseUnits(5000);
    const commitment = pedersenCommit(amount);
    const lockEvent = createMockLockEvent(amount);

    const proof = proveDeposit(lockEvent, commitment, PROGRAM_ID, 'recipient');

    // Amount is in public inputs — NOT hidden
    expect(proof.publicInputs.amount).toBe(amount);
    expect(proof.publicInputs.amountCommitment).toBeTruthy();
  });

  test('withdraw amounts are publicly visible', () => {
    const proof = proveWithdraw(
      'burn_001', 1_000_000n, 'sol_recipient', 'nonce', ['ki'], PROGRAM_ID,
    );
    // Amount is public
    expect(proof.publicInputs.amount).toBe(1_000_000n);
  });

  test('deposit TX outputs have cleartext amounts', () => {
    const handler = new MisakaBridgeHandler();
    const amount = toBaseUnits(1000);
    const commitment = pedersenCommit(amount);
    const lockEvent = createMockLockEvent(amount);
    const proof = proveDeposit(lockEvent, commitment, PROGRAM_ID, 'r');
    const lockEventHash = computeLockEventHash(
      lockEvent.txSignature, lockEvent.lockerAddress,
      lockEvent.amount, lockEvent.slot, lockEvent.nonce, lockEvent.programId,
    );

    const result = handler.processDeposit({
      proof, lockEventHash, amount: Number(amount),
      recipientPubKeyHash: 'r', token: BridgeToken.SOL, nonce: lockEvent.nonce,
    });

    if ('tx' in result) {
      // Amount is cleartext (not hidden in Pedersen commitment)
      const outputAmount = result.tx.outputs[0].amount;
      expect(outputAmount).toBeGreaterThan(0);
      // Bridge fee deducted
      expect(outputAmount).toBeLessThan(Number(amount));
    }
  });

  test('withdraw burn output has cleartext amount', () => {
    const handler = new MisakaBridgeHandler();
    const result = handler.processWithdraw(
      { amount: 5000, solanaRecipient: 'sol', token: BridgeToken.SOL, burnKeyImages: [], nonce: 'n' },
      'spender', [{ prevTxId: 'p', outputIndex: 0, signature: 's', publicKey: 'pk' }],
    );

    if ('tx' in result) {
      expect(result.tx.outputs[0].amount).toBe(5000);
    }
  });
});

// ============================================================
// 7. Security Tests
// ============================================================

describe('Bridge Security', () => {
  test('nonce replay prevention on Solana', () => {
    const program = new SolanaBridgeProgram(PROGRAM_ID, 'auth');
    program.fundAccount('a', BridgeToken.SOL, 10_000_000_000n);

    const lock = program.lock('a', 1_000_000n, BridgeToken.SOL, 'r');
    if (!('nonce' in lock)) return;

    const proof = createMockProof(1_000_000n, BridgeDirection.MISAKA_TO_SOLANA);

    // First unlock: OK
    program.unlock({
      burnTxId: 'burn_1', recipientAddress: 'bob', amount: 1_000_000n,
      token: BridgeToken.SOL, proof, nonce: 'n1',
    });

    // Same burnTxId: FAIL
    const result = program.unlock({
      burnTxId: 'burn_1', recipientAddress: 'bob', amount: 0n,
      token: BridgeToken.SOL, proof, nonce: 'n2',
    });
    expect('error' in result).toBe(true);
  });

  test('nonce replay prevention on Misaka', () => {
    const handler = new MisakaBridgeHandler();
    const amount = toBaseUnits(1000);
    const commitment = pedersenCommit(amount);
    const lockEvent = createMockLockEvent(amount);
    const proof = proveDeposit(lockEvent, commitment, PROGRAM_ID, 'r');
    const lockEventHash = computeLockEventHash(
      lockEvent.txSignature, lockEvent.lockerAddress,
      lockEvent.amount, lockEvent.slot, lockEvent.nonce, lockEvent.programId,
    );

    const data = {
      proof, lockEventHash, amount: Number(amount),
      recipientPubKeyHash: 'r', token: BridgeToken.SOL, nonce: lockEvent.nonce,
    };

    handler.processDeposit(data);
    const result = handler.processDeposit(data);
    expect('error' in result).toBe(true);
  });

  test('unlock fails with insufficient locked balance', () => {
    const program = new SolanaBridgeProgram(PROGRAM_ID, 'auth');
    // No funds locked
    const proof = createMockProof(1_000_000n, BridgeDirection.MISAKA_TO_SOLANA);
    const result = program.unlock({
      burnTxId: 'burn', recipientAddress: 'bob', amount: 1_000_000n,
      token: BridgeToken.SOL, proof, nonce: 'n',
    });
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('Insufficient');
  });

  test('proof amount must match unlock amount', () => {
    const program = new SolanaBridgeProgram(PROGRAM_ID, 'auth');
    program.fundAccount('a', BridgeToken.SOL, 10_000_000_000n);
    program.lock('a', 5_000_000_000n, BridgeToken.SOL, 'r');

    const proof = createMockProof(1_000_000n, BridgeDirection.MISAKA_TO_SOLANA);
    const result = program.unlock({
      burnTxId: 'burn', recipientAddress: 'bob',
      amount: 5_000_000_000n, // Doesn't match proof amount (1M)
      token: BridgeToken.SOL, proof, nonce: 'n',
    });
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('amount does not match');
  });
});

// ============================================================
// Helpers
// ============================================================

function createMockLockEvent(amount: bigint): SolanaLockEvent {
  return {
    txSignature: 'mock_tx_sig_' + Math.random().toString(36).slice(2),
    slot: Math.floor(Math.random() * 100000),
    programId: PROGRAM_ID,
    lockerAddress: 'mock_locker_' + Math.random().toString(36).slice(2),
    amount,
    token: BridgeToken.SOL,
    misakaRecipient: 'mock_recipient',
    nonce: 'nonce_' + Math.random().toString(36).slice(2, 18),
    timestamp: Date.now(),
  };
}

function createMockProof(amount: bigint, direction: BridgeDirection): ZKProof {
  const dummyPoint = '0'.repeat(64);
  return {
    protocol: 'schnorr_bridge',
    proofA: dummyPoint,
    proofB: dummyPoint,
    proofC: dummyPoint,
    publicInputs: {
      amountCommitment: dummyPoint,
      programIdHash: hashProgramId(PROGRAM_ID),
      nonce: 'mock_nonce',
      recipientHash: 'mock_recipient_hash',
      direction,
      token: BridgeToken.SOL,
      amount,
    },
    createdAt: Date.now(),
    proverVersion: 'test',
  };
}
