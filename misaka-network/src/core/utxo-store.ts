// ============================================================
// Misaka Network - UTXO Store
// ============================================================
import { UTXOEntry, Transaction } from '../types';
import { sha256 } from '../utils/crypto';

/**
 * In-memory UTXO store. 
 * For production, replace with LevelDB/RocksDB.
 */
export class UTXOStore {
  private utxos: Map<string, UTXOEntry> = new Map();

  /** Generate UTXO key */
  private key(txId: string, outputIndex: number): string {
    return `${txId}:${outputIndex}`;
  }

  /** Get a UTXO */
  get(txId: string, outputIndex: number): UTXOEntry | undefined {
    return this.utxos.get(this.key(txId, outputIndex));
  }

  /** Add a UTXO */
  add(entry: UTXOEntry): void {
    this.utxos.set(this.key(entry.txId, entry.outputIndex), entry);
  }

  /** Remove (spend) a UTXO */
  remove(txId: string, outputIndex: number): boolean {
    return this.utxos.delete(this.key(txId, outputIndex));
  }

  /** Check if UTXO exists */
  has(txId: string, outputIndex: number): boolean {
    return this.utxos.has(this.key(txId, outputIndex));
  }

  /** Get all UTXOs for a given public key hash */
  getByPubKeyHash(pubKeyHash: string): UTXOEntry[] {
    const result: UTXOEntry[] = [];
    for (const utxo of this.utxos.values()) {
      if (utxo.recipientPubKeyHash === pubKeyHash) {
        result.push(utxo);
      }
    }
    return result;
  }

  /** Get total balance for a public key hash */
  getBalance(pubKeyHash: string): number {
    return this.getByPubKeyHash(pubKeyHash).reduce((sum, u) => sum + u.amount, 0);
  }

  /** Cache of recently removed UTXOs for safe revert */
  private spentCache = new Map<string, UTXOEntry>();

  /** Apply a transaction: remove spent UTXOs, add new UTXOs */
  applyTransaction(tx: Transaction, blockHeight: number): void {
    // Remove spent UTXOs (skip coinbase inputs)
    for (const input of tx.inputs) {
      if (input.prevTxId !== '0'.repeat(64)) {
        const key = `${input.prevTxId}:${input.outputIndex}`;
        const existing = this.get(input.prevTxId, input.outputIndex);
        if (existing) {
          this.spentCache.set(key, { ...existing });
        }
        this.remove(input.prevTxId, input.outputIndex);
      }
    }

    // Add new UTXOs
    for (let i = 0; i < tx.outputs.length; i++) {
      this.add({
        txId: tx.id,
        outputIndex: i,
        amount: tx.outputs[i].amount,
        recipientPubKeyHash: tx.outputs[i].recipientPubKeyHash,
        blockHeight,
      });
    }
  }

  /** Revert a transaction: re-add spent UTXOs, remove created UTXOs */
  revertTransaction(
    tx: Transaction,
    getOriginalUTXO?: (txId: string, index: number) => UTXOEntry | undefined
  ): void {
    // Remove created UTXOs
    for (let i = 0; i < tx.outputs.length; i++) {
      this.remove(tx.id, i);
    }

    // Re-add spent UTXOs from cache first, then fallback
    for (const input of tx.inputs) {
      if (input.prevTxId !== '0'.repeat(64)) {
        const key = `${input.prevTxId}:${input.outputIndex}`;
        const cached = this.spentCache.get(key);
        if (cached) {
          this.add(cached);
          this.spentCache.delete(key);
        } else if (getOriginalUTXO) {
          const original = getOriginalUTXO(input.prevTxId, input.outputIndex);
          if (original) {
            this.add(original);
          }
        }
      }
    }
  }

  /** Clear the spent cache (call after block is committed) */
  clearSpentCache(): void {
    this.spentCache.clear();
  }

  /** Compute state root (hash of all UTXOs) */
  computeStateRoot(): string {
    const entries: string[] = [];
    const sortedKeys = Array.from(this.utxos.keys()).sort();
    for (const key of sortedKeys) {
      const utxo = this.utxos.get(key)!;
      entries.push(`${key}:${utxo.amount}:${utxo.recipientPubKeyHash}`);
    }
    return sha256(entries.join('|'));
  }

  /** Get total number of UTXOs */
  get size(): number {
    return this.utxos.size;
  }

  /** Get all UTXOs (for snapshot) */
  getAll(): UTXOEntry[] {
    return Array.from(this.utxos.values());
  }

  /** Load from snapshot */
  loadFromSnapshot(entries: UTXOEntry[]): void {
    this.utxos.clear();
    for (const entry of entries) {
      this.add(entry);
    }
  }

  /** Clear all UTXOs */
  clear(): void {
    this.utxos.clear();
  }

  /** Select UTXOs for a transaction (simple greedy algorithm) */
  selectUTXOs(pubKeyHash: string, targetAmount: number): UTXOEntry[] {
    const available = this.getByPubKeyHash(pubKeyHash)
      .sort((a, b) => b.amount - a.amount); // largest first

    const selected: UTXOEntry[] = [];
    let total = 0;

    for (const utxo of available) {
      selected.push(utxo);
      total += utxo.amount;
      if (total >= targetAmount) break;
    }

    if (total < targetAmount) {
      throw new Error(`Insufficient UTXOs: have ${total}, need ${targetAmount}`);
    }

    return selected;
  }
}
