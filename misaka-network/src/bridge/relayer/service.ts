// ============================================================
// Misaka Network - Bridge Relayer Service
// ============================================================
// Off-chain service that monitors both chains and relays proofs.
//
// Deposit flow (Solana → Misaka):
//   1. Monitor Solana for lock events
//   2. Generate ZK proof of lock
//   3. Submit deposit TX to Misaka
//
// Withdraw flow (Misaka → Solana):
//   1. Monitor Misaka for burn (withdraw) TXs
//   2. Generate ZK proof of burn
//   3. Submit unlock instruction to Solana
//
// The relayer is a trustless intermediary — anyone can run one.
// Security comes from ZK proofs, not relayer honesty.
// ============================================================

import { createHash, randomBytes } from 'crypto';
import {
  RelayerConfig, RelayerOperation, BridgeDirection, BridgeStatus,
  BridgeToken, SolanaLockEvent, DepositTxData, WithdrawTxData,
  ZKProof, SolanaUnlockInstruction,
} from '../types';
import { SolanaBridgeProgram } from '../solana/program';
import { MisakaBridgeHandler } from '../misaka/handler';
import { proveDeposit, proveWithdraw } from '../zk/prover';
import { pedersenCommit } from '../../privacy/pedersen';
import { hashProgramId, hashRecipient, computeLockEventHash } from '../zk/circuit';
import { Transaction } from '../../types';

/** Event emitted by the relayer */
export interface RelayerEvent {
  type: 'deposit_detected' | 'proof_generated' | 'deposit_submitted'
       | 'withdraw_detected' | 'unlock_submitted' | 'error';
  operation: RelayerOperation;
  data?: any;
}

/**
 * Bridge Relayer Service.
 *
 * Monitors both chains and relays bridge operations.
 * Anyone can run a relayer — security comes from ZK proofs.
 */
export class BridgeRelayer {
  private solana: SolanaBridgeProgram;
  private misaka: MisakaBridgeHandler;
  private operations: Map<string, RelayerOperation> = new Map();
  private eventListeners: ((event: RelayerEvent) => void)[] = [];
  private processedLockNonces: Set<string> = new Set();
  private processedBurnTxIds: Set<string> = new Set();

  constructor(
    solana: SolanaBridgeProgram,
    misaka: MisakaBridgeHandler,
  ) {
    this.solana = solana;
    this.misaka = misaka;
  }

  /** Register event listener */
  onEvent(listener: (event: RelayerEvent) => void): void {
    this.eventListeners.push(listener);
  }

  private emit(event: RelayerEvent): void {
    for (const l of this.eventListeners) l(event);
  }

  // ════════════════════════════════════════════════════════
  // Deposit: Solana → Misaka
  // ════════════════════════════════════════════════════════

  /**
   * Process a Solana lock event into a Misaka deposit.
   *
   * Full flow:
   *   1. Observe lock event on Solana
   *   2. Generate ZK proof
   *   3. Submit deposit to Misaka handler
   *   4. Return minted TX
   */
  processLockEvent(
    lockEvent: SolanaLockEvent,
  ): { tx: Transaction; operation: RelayerOperation } | { error: string } {
    // Check if already processed
    if (this.processedLockNonces.has(lockEvent.nonce)) {
      return { error: `Lock nonce already processed: ${lockEvent.nonce}` };
    }

    // Create operation record
    const opId = randomBytes(8).toString('hex');
    const operation: RelayerOperation = {
      id: opId,
      direction: BridgeDirection.SOLANA_TO_MISAKA,
      status: BridgeStatus.LOCKED,
      lockEvent,
      retries: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.operations.set(opId, operation);

    this.emit({ type: 'deposit_detected', operation });

    try {
      // Step 1: Create Pedersen commitment for the amount
      // BRIDGE > PRIVACY: amount is public, but we still create a commitment
      // for the ZK proof structure. Lock event amounts are in base units.
      const commitment = pedersenCommit(lockEvent.amount);

      // Step 2: Generate ZK proof
      const proof = proveDeposit(
        lockEvent,
        commitment,
        this.solana.getProgramId(),
        lockEvent.misakaRecipient,
      );

      operation.proof = proof;
      operation.status = BridgeStatus.PROOF_GENERATED;
      operation.updatedAt = Date.now();
      this.emit({ type: 'proof_generated', operation });

      // Step 3: Submit deposit to Misaka
      const lockEventHash = computeLockEventHash(
        lockEvent.txSignature,
        lockEvent.lockerAddress,
        lockEvent.amount,
        lockEvent.slot,
        lockEvent.nonce,
        lockEvent.programId,
      );

      const depositData: DepositTxData = {
        proof,
        lockEventHash,
        amount: Number(lockEvent.amount),
        recipientPubKeyHash: lockEvent.misakaRecipient,
        token: lockEvent.token,
        nonce: lockEvent.nonce,
      };

      const result = this.misaka.processDeposit(depositData);

      if ('error' in result) {
        operation.status = BridgeStatus.FAILED;
        operation.error = result.error;
        operation.updatedAt = Date.now();
        this.emit({ type: 'error', operation, data: result.error });
        return { error: result.error };
      }

      // Success
      operation.status = BridgeStatus.MINTED;
      operation.misakaTxId = result.tx.id;
      operation.updatedAt = Date.now();
      this.processedLockNonces.add(lockEvent.nonce);

      this.emit({ type: 'deposit_submitted', operation, data: result.tx });

      return { tx: result.tx, operation };

    } catch (e: any) {
      operation.status = BridgeStatus.FAILED;
      operation.error = e.message;
      operation.updatedAt = Date.now();
      return { error: e.message };
    }
  }

  // ════════════════════════════════════════════════════════
  // Withdraw: Misaka → Solana
  // ════════════════════════════════════════════════════════

  /**
   * Process a Misaka burn into a Solana unlock.
   *
   * Full flow:
   *   1. Observe burn TX on Misaka
   *   2. Generate ZK proof of burn
   *   3. Submit unlock to Solana
   *   4. Complete the withdrawal
   */
  processWithdrawEvent(
    burnTxId: string,
    withdrawData: WithdrawTxData,
  ): { solanaTxSig: string; operation: RelayerOperation } | { error: string } {
    if (this.processedBurnTxIds.has(burnTxId)) {
      return { error: `Burn TX already processed: ${burnTxId}` };
    }

    const opId = randomBytes(8).toString('hex');
    const operation: RelayerOperation = {
      id: opId,
      direction: BridgeDirection.MISAKA_TO_SOLANA,
      status: BridgeStatus.BURNED,
      withdrawData,
      misakaTxId: burnTxId,
      retries: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.operations.set(opId, operation);

    this.emit({ type: 'withdraw_detected', operation });

    try {
      // Step 1: Generate ZK proof of burn
      const proof = proveWithdraw(
        burnTxId,
        BigInt(Math.round(withdrawData.amount)),
        withdrawData.solanaRecipient,
        withdrawData.nonce,
        withdrawData.burnKeyImages,
        this.solana.getProgramId(),
      );

      operation.proof = proof;
      operation.status = BridgeStatus.PROOF_GENERATED;
      operation.updatedAt = Date.now();

      // Step 2: Submit unlock to Solana
      const unlockInstruction: SolanaUnlockInstruction = {
        burnTxId,
        recipientAddress: withdrawData.solanaRecipient,
        amount: BigInt(Math.round(withdrawData.amount)),
        token: withdrawData.token,
        proof,
        nonce: withdrawData.nonce,
      };

      const unlockResult = this.solana.unlock(unlockInstruction);

      if ('error' in unlockResult) {
        operation.status = BridgeStatus.FAILED;
        operation.error = unlockResult.error;
        operation.updatedAt = Date.now();
        this.emit({ type: 'error', operation, data: unlockResult.error });
        return { error: unlockResult.error };
      }

      // Success
      operation.status = BridgeStatus.COMPLETED;
      operation.solanaTxSig = unlockResult.txSignature;
      operation.updatedAt = Date.now();
      this.processedBurnTxIds.add(burnTxId);
      this.misaka.completeWithdrawal(withdrawData.nonce);

      this.emit({ type: 'unlock_submitted', operation, data: unlockResult });

      return { solanaTxSig: unlockResult.txSignature, operation };

    } catch (e: any) {
      operation.status = BridgeStatus.FAILED;
      operation.error = e.message;
      operation.updatedAt = Date.now();
      return { error: e.message };
    }
  }

  // ════════════════════════════════════════════════════════
  // Monitoring / Queries
  // ════════════════════════════════════════════════════════

  /**
   * Scan for unprocessed lock events on Solana.
   * Returns events that haven't been relayed yet.
   */
  scanForPendingLocks(): SolanaLockEvent[] {
    const allEvents = this.solana.getAllLockEvents();
    return allEvents.filter(e => !this.processedLockNonces.has(e.nonce));
  }

  /**
   * Process all pending lock events.
   */
  processAllPendingLocks(): Array<{ tx: Transaction; nonce: string } | { error: string; nonce: string }> {
    const pending = this.scanForPendingLocks();
    return pending.map(event => {
      const result = this.processLockEvent(event);
      if ('error' in result) {
        return { error: result.error, nonce: event.nonce };
      }
      return { tx: result.tx, nonce: event.nonce };
    });
  }

  /** Get all operations */
  getOperations(): RelayerOperation[] {
    return Array.from(this.operations.values());
  }

  /** Get operation by ID */
  getOperation(id: string): RelayerOperation | undefined {
    return this.operations.get(id);
  }

  /** Get operations by status */
  getOperationsByStatus(status: BridgeStatus): RelayerOperation[] {
    return Array.from(this.operations.values()).filter(o => o.status === status);
  }

  /** Get relayer stats */
  getStats() {
    const ops = Array.from(this.operations.values());
    return {
      totalOperations: ops.length,
      deposits: ops.filter(o => o.direction === BridgeDirection.SOLANA_TO_MISAKA).length,
      withdrawals: ops.filter(o => o.direction === BridgeDirection.MISAKA_TO_SOLANA).length,
      completed: ops.filter(o => o.status === BridgeStatus.COMPLETED || o.status === BridgeStatus.MINTED).length,
      failed: ops.filter(o => o.status === BridgeStatus.FAILED).length,
      pending: ops.filter(o =>
        o.status !== BridgeStatus.COMPLETED &&
        o.status !== BridgeStatus.MINTED &&
        o.status !== BridgeStatus.FAILED
      ).length,
    };
  }
}
