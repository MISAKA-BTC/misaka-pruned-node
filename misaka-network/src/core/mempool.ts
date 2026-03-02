// ============================================================
// Misaka Network - Mempool
// ============================================================
import {
  Transaction, ConfidentialTransaction, AnyTransaction,
  FeeTier, DEFAULT_FEE_TIERS, UTXOEntry, isConfidentialTx,
} from '../types';
import { validateTransaction } from './transaction';
import { validateConfidentialTransaction } from './confidential';
import { ConfidentialUTXOStore } from './confidential-utxo';

const MAX_MEMPOOL_SIZE = 5000;
const MAX_TX_AGE_MS = 60 * 60 * 1000; // 1 hour

export class Mempool {
  private transactions: Map<string, Transaction> = new Map();
  private confidentialTxs: Map<string, ConfidentialTransaction> = new Map();
  private feeTiers: FeeTier[];

  constructor(feeTiers: FeeTier[] = DEFAULT_FEE_TIERS) {
    this.feeTiers = feeTiers;
  }

  /**
   * Add a transparent transaction to the mempool after validation.
   */
  addTransaction(
    tx: Transaction,
    getUTXO: (txId: string, index: number) => UTXOEntry | undefined
  ): string | null {
    if (this.totalSize >= MAX_MEMPOOL_SIZE) return 'Mempool full';
    if (this.transactions.has(tx.id)) return 'Transaction already in mempool';
    if (Date.now() - tx.timestamp > MAX_TX_AGE_MS) return 'Transaction too old';

    const error = validateTransaction(tx, getUTXO, this.feeTiers);
    if (error) return error;

    this.transactions.set(tx.id, tx);
    return null;
  }

  /**
   * Add a confidential transaction to the mempool.
   * Validates ring signatures, key images, Pedersen balance — no plaintext needed.
   */
  addConfidentialTransaction(
    tx: ConfidentialTransaction,
    confidentialUTXOs: ConfidentialUTXOStore
  ): string | null {
    if (this.totalSize >= MAX_MEMPOOL_SIZE) return 'Mempool full';
    if (this.confidentialTxs.has(tx.id)) return 'Transaction already in mempool';
    if (Date.now() - tx.timestamp > MAX_TX_AGE_MS) return 'Transaction too old';

    // Check key images aren't already in mempool
    for (const ki of tx.keyImages) {
      for (const existing of this.confidentialTxs.values()) {
        if (existing.keyImages.includes(ki)) {
          return `Key image conflict with mempool tx ${existing.id.slice(0, 16)}...`;
        }
      }
    }

    const error = validateConfidentialTransaction(tx, confidentialUTXOs, this.feeTiers);
    if (error) return error;

    this.confidentialTxs.set(tx.id, tx);
    return null;
  }

  /**
   * Get transactions for block inclusion (both transparent and confidential).
   */
  getTransactionsForBlock(maxTxs: number = 100): AnyTransaction[] {
    const txs: AnyTransaction[] = [];

    for (const tx of this.transactions.values()) {
      if (txs.length >= maxTxs) break;
      txs.push(tx);
    }
    for (const tx of this.confidentialTxs.values()) {
      if (txs.length >= maxTxs) break;
      txs.push(tx);
    }

    return txs;
  }

  /**
   * Remove transactions that were included in a block.
   */
  removeTransactions(txIds: string[]): void {
    for (const id of txIds) {
      this.transactions.delete(id);
      this.confidentialTxs.delete(id);
    }
  }

  /**
   * Remove a single transaction.
   */
  removeTransaction(txId: string): void {
    this.transactions.delete(txId);
    this.confidentialTxs.delete(txId);
  }

  /**
   * Check if transaction exists in mempool.
   */
  hasTransaction(txId: string): boolean {
    return this.transactions.has(txId) || this.confidentialTxs.has(txId);
  }

  /**
   * Get total mempool size (transparent + confidential).
   */
  get size(): number {
    return this.transactions.size;
  }

  get totalSize(): number {
    return this.transactions.size + this.confidentialTxs.size;
  }

  get confidentialSize(): number {
    return this.confidentialTxs.size;
  }

  /**
   * Cleanup expired transactions.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [id, tx] of this.transactions) {
      if (now - tx.timestamp > MAX_TX_AGE_MS) {
        this.transactions.delete(id);
      }
    }
    for (const [id, tx] of this.confidentialTxs) {
      if (now - tx.timestamp > MAX_TX_AGE_MS) {
        this.confidentialTxs.delete(id);
      }
    }
  }

  /**
   * Get all transparent transactions (for debugging).
   */
  getAll(): Transaction[] {
    return Array.from(this.transactions.values());
  }

  /**
   * Get all confidential transactions.
   */
  getAllConfidential(): ConfidentialTransaction[] {
    return Array.from(this.confidentialTxs.values());
  }
}
