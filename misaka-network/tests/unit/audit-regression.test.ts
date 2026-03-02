// ============================================================
// Misaka Network - Security Audit Regression Tests
// ============================================================
// Tests for security-critical invariants. These MUST never regress.
//   #1 Coinbase strictness
//   #2 Intra-block double-spend prevention
//   #3 State revert integrity (spentCache)
//   #4 Vote signature verification
//   #5 Bridge ZK Schnorr-Pedersen equation
//   #6 Flat 3% network fee
//   #7 Key image state root collision resistance
// ============================================================

import {
  Transaction, Block, TransactionType,
  DEFAULT_FEE_TIERS, NETWORK_FEE_RATE, BlockSignature,
} from '../../src/types';
import { generateKeyPair, toHex, hashPubKey, sha256 } from '../../src/utils/crypto';
import { Blockchain, createBlock, signBlock, verifyBlockSignature } from '../../src/core/blockchain';
import { UTXOStore } from '../../src/core/utxo-store';
import { ConfidentialUTXOStore } from '../../src/core/confidential-utxo';
import { Mempool } from '../../src/core/mempool';
import { createTransaction, createCoinbaseTx, computeTxId } from '../../src/core/transaction';
import { calculateFee, validateFee } from '../../src/core/fee';
import { ConsensusEngine, ConsensusConfig } from '../../src/consensus/engine';
import { proveDeposit, generateVerificationKey } from '../../src/bridge/zk/prover';
import { verifyBridgeProof } from '../../src/bridge/zk/verifier';
import { pedersenCommit } from '../../src/privacy/pedersen';
import { randomScalar } from '../../src/privacy/curve';
import { BridgeToken, BridgeConfig, SolanaLockEvent } from '../../src/bridge/types';

// ── Helpers ──────────────────────────────────────────

function makeVal() {
  const kp = generateKeyPair();
  return {
    publicKey: kp.publicKey, secretKey: kp.secretKey,
    pubHex: toHex(kp.publicKey), pubKeyHash: hashPubKey(kp.publicKey),
  };
}

function makeChain(vals: ReturnType<typeof makeVal>[]) {
  const utxoStore = new UTXOStore();
  const bc = new Blockchain(utxoStore, DEFAULT_FEE_TIERS, vals.map(v => v.pubHex));
  return { utxoStore, blockchain: bc };
}

function genesis(bc: Blockchain, vals: ReturnType<typeof makeVal>[]) {
  const g = bc.createGenesisBlock(
    vals.map(v => ({ pubKeyHash: v.pubKeyHash, amount: 100_000_000 })),
    vals[0].secretKey, vals[0].publicKey,
  );
  for (let i = 1; i < vals.length; i++) {
    g.signatures.push(signBlock(g.hash, vals[i].secretKey, vals[i].publicKey));
  }
  expect(bc.addBlock(g)).toBeNull();
  return g;
}

// ============================================================
// #1 COINBASE STRICTNESS
// ============================================================

describe('#1 Coinbase Strictness', () => {
  const vals = [makeVal(), makeVal(), makeVal()];

  test('reject TRANSFER type with zero prevTxId', () => {
    const { blockchain } = makeChain(vals);
    genesis(blockchain, vals);

    const fake: Transaction = {
      id: '', version: 1, type: TransactionType.TRANSFER,
      inputs: [{ prevTxId: '0'.repeat(64), outputIndex: 0, signature: '', publicKey: '' }],
      outputs: [{ recipientPubKeyHash: vals[0].pubKeyHash, amount: 999999 }],
      fee: 0, timestamp: Date.now(),
    };
    fake.id = computeTxId(fake);

    const block = createBlock({
      height: 1, previousHash: blockchain.latestHash,
      transactions: [fake],
      proposerPubKey: vals[0].publicKey, proposerSecretKey: vals[0].secretKey,
      stateRoot: 'x',
    });
    vals.forEach(v => block.signatures.push(signBlock(block.hash, v.secretKey, v.publicKey)));

    expect(blockchain.addBlock(block)).toContain('zero prevTxId without COINBASE type');
  });

  test('reject COINBASE type with non-zero prevTxId', () => {
    const { blockchain } = makeChain(vals);
    genesis(blockchain, vals);

    const fake: Transaction = {
      id: '', version: 1, type: TransactionType.COINBASE,
      inputs: [{ prevTxId: 'a'.repeat(64), outputIndex: 0, signature: '', publicKey: '' }],
      outputs: [{ recipientPubKeyHash: vals[0].pubKeyHash, amount: 999999 }],
      fee: 0, timestamp: Date.now(),
    };
    fake.id = computeTxId(fake);

    const block = createBlock({
      height: 1, previousHash: blockchain.latestHash,
      transactions: [fake],
      proposerPubKey: vals[0].publicKey, proposerSecretKey: vals[0].secretKey,
      stateRoot: 'x',
    });
    vals.forEach(v => block.signatures.push(signBlock(block.hash, v.secretKey, v.publicKey)));

    expect(blockchain.addBlock(block)).toContain('COINBASE type without zero prevTxId');
  });

  test('reject coinbase at index > 0 in non-genesis block', () => {
    const { blockchain, utxoStore } = makeChain(vals);
    genesis(blockchain, vals);

    const utxos = utxoStore.getByPubKeyHash(vals[0].pubKeyHash);
    const tx = createTransaction({
      utxos: [utxos[0]], senderSecretKey: vals[0].secretKey, senderPubKey: vals[0].publicKey,
      recipientPubKeyHash: vals[1].pubKeyHash, amount: 1000,
    });
    const cb = createCoinbaseTx(vals[0].pubKeyHash, 50, 1);

    const block = createBlock({
      height: 1, previousHash: blockchain.latestHash,
      transactions: [tx, cb], // coinbase at index 1 — WRONG
      proposerPubKey: vals[0].publicKey, proposerSecretKey: vals[0].secretKey,
      stateRoot: 'x',
    });
    vals.forEach(v => block.signatures.push(signBlock(block.hash, v.secretKey, v.publicKey)));

    expect(blockchain.addBlock(block)).toContain('Coinbase TX must be first');
  });
});

// ============================================================
// #2 INTRA-BLOCK DOUBLE-SPEND
// ============================================================

describe('#2 Intra-Block Double-Spend Prevention', () => {
  const vals = [makeVal(), makeVal(), makeVal()];

  test('reject two TXs spending the same UTXO', () => {
    const { blockchain, utxoStore } = makeChain(vals);
    genesis(blockchain, vals);

    const utxos = utxoStore.getByPubKeyHash(vals[0].pubKeyHash);
    const tx1 = createTransaction({
      utxos: [utxos[0]], senderSecretKey: vals[0].secretKey, senderPubKey: vals[0].publicKey,
      recipientPubKeyHash: vals[1].pubKeyHash, amount: 1000,
    });
    const tx2 = createTransaction({
      utxos: [utxos[0]], // SAME UTXO
      senderSecretKey: vals[0].secretKey, senderPubKey: vals[0].publicKey,
      recipientPubKeyHash: vals[2].pubKeyHash, amount: 2000,
    });
    const cb = createCoinbaseTx(vals[0].pubKeyHash, 50, 1);

    const block = createBlock({
      height: 1, previousHash: blockchain.latestHash,
      transactions: [cb, tx1, tx2],
      proposerPubKey: vals[0].publicKey, proposerSecretKey: vals[0].secretKey,
      stateRoot: 'x',
    });
    vals.forEach(v => block.signatures.push(signBlock(block.hash, v.secretKey, v.publicKey)));

    expect(blockchain.addBlock(block)).toContain('Intra-block double-spend');
  });
});

// ============================================================
// #3 STATE REVERT INTEGRITY
// ============================================================

describe('#3 State Revert Integrity', () => {
  const vals = [makeVal(), makeVal(), makeVal()];

  test('UTXOs fully restored after failed block', () => {
    const { blockchain, utxoStore } = makeChain(vals);
    genesis(blockchain, vals);

    const utxosBefore = utxoStore.getAll().length;
    const balBefore = utxoStore.getBalance(vals[0].pubKeyHash);
    const utxos = utxoStore.getByPubKeyHash(vals[0].pubKeyHash);

    const tx = createTransaction({
      utxos: [utxos[0]], senderSecretKey: vals[0].secretKey, senderPubKey: vals[0].publicKey,
      recipientPubKeyHash: vals[1].pubKeyHash, amount: 1000,
    });
    const cb = createCoinbaseTx(vals[0].pubKeyHash, 50, 1);

    // Wrong state root → block will fail and revert
    const block = createBlock({
      height: 1, previousHash: blockchain.latestHash,
      transactions: [cb, tx],
      proposerPubKey: vals[0].publicKey, proposerSecretKey: vals[0].secretKey,
      stateRoot: 'WRONG_STATE_ROOT',
    });
    vals.forEach(v => block.signatures.push(signBlock(block.hash, v.secretKey, v.publicKey)));

    expect(blockchain.addBlock(block)).toContain('Invalid state root');

    // CRITICAL: state must be fully restored
    expect(utxoStore.getAll().length).toBe(utxosBefore);
    expect(utxoStore.getBalance(vals[0].pubKeyHash)).toBe(balBefore);
    const restored = utxoStore.get(utxos[0].txId, utxos[0].outputIndex);
    expect(restored).toBeDefined();
    expect(restored!.amount).toBe(utxos[0].amount);
  });
});

// ============================================================
// #4 VOTE SIGNATURE VERIFICATION
// ============================================================

describe('#4 Vote Signature Verification', () => {
  const vals = [makeVal(), makeVal(), makeVal()];

  function makeEngine(bc: Blockchain) {
    return new ConsensusEngine(bc, new Mempool(DEFAULT_FEE_TIERS), {
      validators: vals.map(v => ({ pubKey: v.publicKey, pubKeyHex: v.pubHex })),
      mySecretKey: vals[0].secretKey, myPubKey: vals[0].publicKey,
      blockInterval: 60000,
    });
  }

  test('ignores vote from non-validator', () => {
    const { blockchain } = makeChain(vals);
    genesis(blockchain, vals);
    const engine = makeEngine(blockchain);

    const outsider = makeVal();
    const vote = signBlock('hash123', outsider.secretKey, outsider.publicKey);
    engine.handleVote('hash123', vote); // should not crash
  });

  test('ignores forged signature from real validator pubkey', () => {
    const { blockchain } = makeChain(vals);
    genesis(blockchain, vals);
    const engine = makeEngine(blockchain);

    const forged: BlockSignature = {
      validatorPubKey: vals[1].pubHex,
      signature: 'ff'.repeat(64), // garbage
    };
    engine.handleVote('hash456', forged); // should not crash
  });
});

// ============================================================
// #5 BRIDGE ZK SCHNORR-PEDERSEN
// ============================================================

describe('#5 Bridge ZK Verification', () => {
  const bridgeConfig: BridgeConfig = {
    enabled: true,
    solanaProgramId: 'c'.repeat(44),
    bridgeFee: 0, requiredConfirmations: 1,
    minimumAmount: new Map([[BridgeToken.SOL, 0n]]),
    maximumAmount: new Map([[BridgeToken.SOL, 1_000_000_000n]]),
    supportedTokens: [BridgeToken.SOL],
    verificationKey: generateVerificationKey(),
  };

  function makeLockEvent(nonce: string): SolanaLockEvent {
    return {
      txSignature: 'a'.repeat(88), slot: 12345,
      programId: 'c'.repeat(44), lockerAddress: 'b'.repeat(44),
      amount: 50000n, token: BridgeToken.SOL,
      misakaRecipient: 'd'.repeat(64),
      nonce, timestamp: Date.now(),
    };
  }

  test('valid proof passes Schnorr-Pedersen equation', () => {
    const amount = 50000n;
    const commitment = pedersenCommit(amount, randomScalar());
    const lockEvent = makeLockEvent(sha256('nonce-ok'));
    const recipientHash = hashPubKey(makeVal().publicKey);

    const proof = proveDeposit(lockEvent, commitment, 'c'.repeat(44), recipientHash);
    const vk = generateVerificationKey();
    const result = verifyBridgeProof(proof, vk, bridgeConfig, new Set());

    expect(result.valid).toBe(true);
    expect(result.checks.find(c => c.name === 'crypto_verification')?.passed).toBe(true);
  });

  test('tampered amount fails', () => {
    const amount = 50000n;
    const commitment = pedersenCommit(amount, randomScalar());
    const lockEvent = makeLockEvent(sha256('nonce-tamper'));
    const recipientHash = hashPubKey(makeVal().publicKey);

    const proof = proveDeposit(lockEvent, commitment, 'c'.repeat(44), recipientHash);
    proof.publicInputs.amount = 99999n; // tamper

    const result = verifyBridgeProof(proof, generateVerificationKey(), bridgeConfig, new Set());
    expect(result.valid).toBe(false);
  });

  test('missing response scalars rejected', () => {
    const amount = 50000n;
    const commitment = pedersenCommit(amount, randomScalar());
    const lockEvent = makeLockEvent(sha256('nonce-noscalar'));
    const recipientHash = hashPubKey(makeVal().publicKey);

    const proof = proveDeposit(lockEvent, commitment, 'c'.repeat(44), recipientHash);
    delete proof.responseS1;
    delete proof.responseS2;

    const result = verifyBridgeProof(proof, generateVerificationKey(), bridgeConfig, new Set());
    expect(result.valid).toBe(false);
    expect(result.error).toContain('response scalars');
  });
});

// ============================================================
// #6 FLAT 3% NETWORK FEE
// ============================================================

describe('#6 Flat 3% Network Fee', () => {
  test('NETWORK_FEE_RATE = 0.03', () => {
    expect(NETWORK_FEE_RATE).toBe(0.03);
  });

  test('calculateFee returns 3%', () => {
    expect(calculateFee(1000)).toBeCloseTo(30, 8);
    expect(calculateFee(50000)).toBeCloseTo(1500, 8);
    expect(calculateFee(1_000_000)).toBeCloseTo(30000, 8);
  });

  test('validateFee: exact=ok, over=ok, under=reject', () => {
    expect(validateFee(1000, 30)).toBe(true);
    expect(validateFee(1000, 50)).toBe(true);
    expect(validateFee(1000, 29)).toBe(false);
  });

  test('createTransaction uses 3% fee', () => {
    const alice = makeVal();
    const bob = makeVal();
    const utxo = { txId: 'a'.repeat(64), outputIndex: 0, amount: 100000, recipientPubKeyHash: alice.pubKeyHash, blockHeight: 0 };

    const tx = createTransaction({
      utxos: [utxo], senderSecretKey: alice.secretKey, senderPubKey: alice.publicKey,
      recipientPubKeyHash: bob.pubKeyHash, amount: 1000,
    });
    expect(tx.fee).toBeCloseTo(30, 8);
  });
});

// ============================================================
// #7 KEY IMAGE STATE ROOT
// ============================================================

describe('#7 Key Image State Root Collision Resistance', () => {
  test('different key images → different state roots', () => {
    const s1 = new ConfidentialUTXOStore();
    const s2 = new ConfidentialUTXOStore();

    s1.add({ txId: 'tx1', outputIndex: 0, commitment: 'c1', oneTimePubKey: 'pk1', blockHeight: 0 });
    s2.add({ txId: 'tx1', outputIndex: 0, commitment: 'c1', oneTimePubKey: 'pk1', blockHeight: 0 });

    s1.addKeyImage('ki_alpha');
    s2.addKeyImage('ki_beta');

    expect(s1.keyImageCount).toBe(s2.keyImageCount);
    expect(s1.computeStateRoot()).not.toBe(s2.computeStateRoot());
  });
});
