// ============================================================
// Misaka Network - Confidential UTXO Store
// ============================================================
// Stores UTXOs from confidential transactions.
// Unlike the transparent UTXOStore, this only has:
//   - Pedersen commitment (amount hidden)
//   - One-time public key (recipient hidden)
//   - Key images (double-spend tracking)
//
// Pruned nodes: can verify ring sigs, commitments, key images
// Archive nodes: additionally decrypt audit envelopes for plaintext
// ============================================================

import { ConfidentialUTXOEntry, ConfidentialTransaction } from '../types';
import { sha256 } from '../utils/crypto';

export class ConfidentialUTXOStore {
  /** commitment:oneTimePubKey → entry */
  private utxos = new Map<string, ConfidentialUTXOEntry>();

  /** All known one-time public keys (for ring member validation) */
  private knownPubKeys = new Set<string>();

  /** Spent key images (double-spend prevention) */
  private keyImages = new Set<string>();

  // ---- Key ----
  private key(txId: string, outputIndex: number): string {
    return `${txId}:${outputIndex}`;
  }

  // ---- Get/Add/Remove ----

  get(txId: string, outputIndex: number): ConfidentialUTXOEntry | undefined {
    return this.utxos.get(this.key(txId, outputIndex));
  }

  add(entry: ConfidentialUTXOEntry): void {
    this.utxos.set(this.key(entry.txId, entry.outputIndex), entry);
    this.knownPubKeys.add(entry.oneTimePubKey);
  }

  remove(txId: string, outputIndex: number): boolean {
    const entry = this.utxos.get(this.key(txId, outputIndex));
    if (entry) {
      this.knownPubKeys.delete(entry.oneTimePubKey);
    }
    return this.utxos.delete(this.key(txId, outputIndex));
  }

  // ---- Key Image Tracking ----

  hasKeyImage(keyImage: string): boolean {
    return this.keyImages.has(keyImage);
  }

  addKeyImage(keyImage: string): void {
    this.keyImages.add(keyImage);
  }

  // ---- Public Key Validation ----

  /** Check if a one-time public key is known (for ring member validation) */
  isKnownPubKey(pubKey: string): boolean {
    return this.knownPubKeys.has(pubKey);
  }

  /** Get all known one-time public keys (for decoy selection) */
  getAllPubKeys(): string[] {
    return Array.from(this.knownPubKeys);
  }

  // ---- Apply/Revert ----

  /**
   * Apply a confidential transaction:
   * - Record key images as spent
   * - Add new stealth outputs as UTXOs
   */
  applyConfidentialTx(tx: ConfidentialTransaction, blockHeight: number): void {
    // Mark key images as spent
    for (const ki of tx.keyImages) {
      this.keyImages.add(ki);
    }

    // Add new confidential UTXOs
    for (const output of tx.stealthOutputs) {
      this.add({
        txId: tx.id,
        outputIndex: output.outputIndex,
        commitment: output.commitment,
        oneTimePubKey: output.oneTimePubKey,
        blockHeight,
      });
    }
  }

  /**
   * Revert a confidential transaction:
   * - Remove key images
   * - Remove created UTXOs
   */
  revertConfidentialTx(tx: ConfidentialTransaction): void {
    for (const ki of tx.keyImages) {
      this.keyImages.delete(ki);
    }
    for (const output of tx.stealthOutputs) {
      this.remove(tx.id, output.outputIndex);
    }
  }

  // ---- State Root ----

  /**
   * Compute state root including confidential UTXOs.
   * Uses commitments (not amounts) — pruned nodes can verify consistency
   * without knowing plaintext values.
   */
  computeStateRoot(): string {
    const entries: string[] = [];
    const sortedKeys = Array.from(this.utxos.keys()).sort();
    for (const key of sortedKeys) {
      const utxo = this.utxos.get(key)!;
      entries.push(`C:${key}:${utxo.commitment}:${utxo.oneTimePubKey}`);
    }
    // Include sorted key images — not just count, to prevent collision
    const sortedKeyImages = Array.from(this.keyImages).sort();
    for (const ki of sortedKeyImages) {
      entries.push(`KI:${ki}`);
    }
    return sha256(entries.join('|'));
  }

  // ---- Stats ----

  get size(): number { return this.utxos.size; }
  get keyImageCount(): number { return this.keyImages.size; }
  get pubKeyCount(): number { return this.knownPubKeys.size; }

  getAll(): ConfidentialUTXOEntry[] {
    return Array.from(this.utxos.values());
  }

  getAllKeyImages(): string[] {
    return Array.from(this.keyImages);
  }

  loadFromSnapshot(entries: ConfidentialUTXOEntry[], keyImages: string[]): void {
    this.utxos.clear();
    this.knownPubKeys.clear();
    this.keyImages.clear();
    for (const entry of entries) {
      this.add(entry);
    }
    for (const ki of keyImages) {
      this.keyImages.add(ki);
    }
  }

  clear(): void {
    this.utxos.clear();
    this.knownPubKeys.clear();
    this.keyImages.clear();
  }
}
