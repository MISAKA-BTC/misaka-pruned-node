// ============================================================
// Misaka Network - Bridge Handler (Deposit/Withdraw)
// ============================================================
// Handles bridge operations on the Misaka chain:
//
// DEPOSIT (Solana → Misaka):
//   1. Receive ZK proof of Solana lock
//   2. Verify proof against verification key
//   3. Mint equivalent tokens as a deposit TX
//   4. Amount is public (bridge > privacy)
//   5. Recipient uses pubkey hash (stealth possible but optional)
//
// WITHDRAW (Misaka → Solana):
//   1. User creates a withdraw TX (burns tokens)
//   2. Amount is public (bridge > privacy)
//   3. Generates proof for Solana-side unlock
//   4. Key images prevent double-withdrawal
// ============================================================

import { createHash, randomBytes } from 'crypto';
import {
  Transaction, TransactionType, TxInput, TxOutput,
} from '../../types';
import { computeTxId } from '../../core/transaction';
import { calculateFee } from '../../core/fee';
import {
  BridgeState, BridgeConfig, BridgeToken, BridgeStatus,
  DepositTxData, WithdrawTxData, ZKProof,
  VerificationKey, BridgeDirection,
  defaultBridgeConfig,
} from '../types';
import { verifyBridgeProof, VerificationResult } from '../zk/verifier';
import { generateVerificationKey } from '../zk/prover';

// ============================================================
// Bridge State Manager
// ============================================================

export class MisakaBridgeHandler {
  private state: BridgeState;
  private config: BridgeConfig;

  constructor(config?: BridgeConfig) {
    const vk = generateVerificationKey();
    this.config = config || defaultBridgeConfig(vk);
    this.state = {
      processedNonces: new Set(),
      totalMinted: new Map([
        [BridgeToken.SOL, 0n],
        [BridgeToken.USDC, 0n],
      ]),
      totalBurned: new Map([
        [BridgeToken.SOL, 0n],
        [BridgeToken.USDC, 0n],
      ]),
      pendingDeposits: new Map(),
      pendingWithdrawals: new Map(),
      verificationKey: this.config.verificationKey,
    };
  }

  // ── Deposit (Solana → Misaka) ─────────────────────────

  /**
   * Process a deposit: verify ZK proof and create mint TX.
   *
   * BRIDGE > PRIVACY: Amount is in cleartext for verifiable minting.
   */
  processDeposit(
    depositData: DepositTxData,
  ): { tx: Transaction; verificationResult: VerificationResult } | { error: string } {
    // 1. Verify the ZK proof
    const vResult = verifyBridgeProof(
      depositData.proof,
      this.state.verificationKey,
      this.config,
      this.state.processedNonces,
    );

    if (!vResult.valid) {
      return { error: `Proof verification failed: ${vResult.error}` };
    }

    // 2. Check proof public inputs match deposit data
    const pi = depositData.proof.publicInputs;
    if (pi.direction !== BridgeDirection.SOLANA_TO_MISAKA) {
      return { error: `Wrong direction: expected deposit, got ${pi.direction}` };
    }

    // 2a. Recipient binding: proof must commit to the same recipient
    const { hashRecipient } = require('../zk/circuit');
    const expectedRecipientHash = hashRecipient(depositData.recipientPubKeyHash);
    if (pi.recipientHash !== expectedRecipientHash) {
      return { error: `Recipient mismatch: proof binds to ${pi.recipientHash.slice(0, 16)}... but deposit claims ${expectedRecipientHash.slice(0, 16)}...` };
    }

    // 3. Amount matches (bridge > privacy: amount is public)
    const proofAmount = Number(pi.amount);
    if (Math.abs(proofAmount - depositData.amount) > 0.001) {
      return { error: `Amount mismatch: proof=${proofAmount}, deposit=${depositData.amount}` };
    }

    // 4. Nonce not replayed
    if (this.state.processedNonces.has(depositData.nonce)) {
      return { error: `Nonce already processed: ${depositData.nonce}` };
    }

    // 5. Create deposit (mint) transaction
    // BRIDGE > PRIVACY: Amount is in cleartext in the TX outputs
    const bridgeFee = this.config.bridgeFee;
    const mintAmount = depositData.amount - bridgeFee;

    if (mintAmount <= 0) {
      return { error: `Amount too small: ${depositData.amount} - ${bridgeFee} fee = ${mintAmount}` };
    }

    const tx = this.createDepositTx(
      depositData.recipientPubKeyHash,
      mintAmount,
      depositData.nonce,
      depositData.lockEventHash,
    );

    // 6. Record
    this.state.processedNonces.add(depositData.nonce);
    const tokenMinted = this.state.totalMinted.get(depositData.token) ?? 0n;
    this.state.totalMinted.set(depositData.token, tokenMinted + BigInt(Math.round(mintAmount)));

    return { tx, verificationResult: vResult };
  }

  /**
   * Create a deposit (mint) transaction.
   * This is a special coinbase-like TX that mints bridged tokens.
   */
  private createDepositTx(
    recipientPubKeyHash: string,
    amount: number,
    nonce: string,
    lockEventHash: string,
  ): Transaction {
    const tx: Omit<Transaction, 'id'> = {
      version: 1,
      type: TransactionType.DEPOSIT,
      inputs: [{
        prevTxId: lockEventHash,    // Reference to Solana lock
        outputIndex: 0,
        signature: nonce,            // Nonce as "signature" (proof was verified)
        publicKey: 'bridge',         // Bridge authority
      }],
      outputs: [{
        amount,
        recipientPubKeyHash,
      }],
      fee: 0, // Bridge deposits don't pay Misaka fee (bridge fee already deducted)
      timestamp: Date.now(),
    };

    const id = computeTxId(tx);
    return { id, ...tx };
  }

  // ── Withdraw (Misaka → Solana) ────────────────────────

  /**
   * Process a withdrawal: create burn TX on Misaka.
   *
   * BRIDGE > PRIVACY: Amount must be in cleartext for Solana unlock.
   *
   * @returns Withdraw TX (burn) to be included in a Misaka block
   */
  processWithdraw(
    withdrawData: WithdrawTxData,
    spenderPubKeyHash: string,
    spenderInputs: Array<{ prevTxId: string; outputIndex: number; signature: string; publicKey: string }>,
  ): { tx: Transaction } | { error: string } {
    // 1. Validate amount
    if (withdrawData.amount <= 0) {
      return { error: 'Withdraw amount must be positive' };
    }

    // 2. Check nonce
    if (this.state.processedNonces.has(withdrawData.nonce)) {
      return { error: `Nonce already processed: ${withdrawData.nonce}` };
    }

    // 3. Check key images for double-withdrawal
    for (const ki of withdrawData.burnKeyImages) {
      // Key images would be checked against global spent set
      // This is handled at the chain level
    }

    // 4. Create burn TX
    // BRIDGE > PRIVACY: Amount is in cleartext
    const bridgeFee = this.config.bridgeFee;
    const burnAmount = withdrawData.amount;

    const tx = this.createWithdrawTx(
      spenderInputs,
      burnAmount,
      bridgeFee,
      withdrawData.nonce,
      withdrawData.solanaRecipient,
    );

    // 5. Record
    this.state.processedNonces.add(withdrawData.nonce);
    const tokenBurned = this.state.totalBurned.get(withdrawData.token) ?? 0n;
    this.state.totalBurned.set(withdrawData.token, tokenBurned + BigInt(Math.round(burnAmount)));
    this.state.pendingWithdrawals.set(withdrawData.nonce, withdrawData);

    return { tx };
  }

  /**
   * Create a withdraw (burn) transaction.
   * Tokens are burned on Misaka; proof is sent to Solana for unlock.
   */
  private createWithdrawTx(
    inputs: Array<{ prevTxId: string; outputIndex: number; signature: string; publicKey: string }>,
    burnAmount: number,
    bridgeFee: number,
    nonce: string,
    solanaRecipient: string,
  ): Transaction {
    // The burn output goes to a special "burn address" (all zeros)
    const burnPubKeyHash = '0'.repeat(64);

    const tx: Omit<Transaction, 'id'> = {
      version: 1,
      type: TransactionType.WITHDRAW,
      inputs,
      outputs: [
        {
          amount: burnAmount,
          recipientPubKeyHash: burnPubKeyHash, // Burn address
        },
      ],
      fee: bridgeFee,
      memo: {
        ciphertext: Buffer.from(JSON.stringify({
          solanaRecipient,
          nonce,
        })).toString('hex'),
        nonce: randomBytes(24).toString('hex'),
        ephemeralPubKey: 'bridge_withdraw',
      },
      timestamp: Date.now(),
    };

    const id = computeTxId(tx);
    return { id, ...tx };
  }

  // ── Queries ───────────────────────────────────────────

  /** Get bridge state summary */
  getState() {
    return {
      enabled: this.config.enabled,
      totalMinted: Object.fromEntries(
        Array.from(this.state.totalMinted.entries()).map(([k, v]) => [k, v.toString()])
      ),
      totalBurned: Object.fromEntries(
        Array.from(this.state.totalBurned.entries()).map(([k, v]) => [k, v.toString()])
      ),
      processedNonces: this.state.processedNonces.size,
      pendingWithdrawals: this.state.pendingWithdrawals.size,
    };
  }

  /** Check if a nonce has been processed */
  isNonceProcessed(nonce: string): boolean {
    return this.state.processedNonces.has(nonce);
  }

  /** Get pending withdrawal by nonce */
  getPendingWithdrawal(nonce: string): WithdrawTxData | undefined {
    return this.state.pendingWithdrawals.get(nonce);
  }

  /** Mark a withdrawal as completed (after Solana unlock) */
  completeWithdrawal(nonce: string): void {
    this.state.pendingWithdrawals.delete(nonce);
  }

  /** Get verification key */
  getVerificationKey(): VerificationKey {
    return this.state.verificationKey;
  }

  /** Get config */
  getConfig(): BridgeConfig {
    return this.config;
  }
}
