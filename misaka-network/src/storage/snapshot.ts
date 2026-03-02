// ============================================================
// Misaka Network - Snapshot Manager
// ============================================================
// Creates periodic UTXO state snapshots so that pruned nodes
// can bootstrap without replaying the entire chain.
//
// Flow:
//   1. Every `snapshotInterval` blocks, capture full UTXO set
//   2. Validators sign the snapshot (attesting correctness)
//   3. Pruned node joins → downloads latest snapshot
//   4. Applies only blocks after the snapshot height
//   5. Starts validating from there
//
// This is how a 4GB VPS can run a validator without 16GB of
// historical block data.
// ============================================================

import { Block, BlockSignature, UTXOEntry, ConfidentialUTXOEntry } from '../types';
import { UTXOStore } from '../core/utxo-store';
import { ConfidentialUTXOStore } from '../core/confidential-utxo';
import { sha256, sign, verify, toHex, fromHex } from '../utils/crypto';
import { Snapshot, SnapshotMeta, StorageConfig, NodeRole } from './types';

export class SnapshotManager {
  private snapshots: Map<number, Snapshot> = new Map(); // height → snapshot
  private config: StorageConfig;

  constructor(config: StorageConfig) {
    this.config = config;
  }

  /**
   * Check if a snapshot should be taken at this height.
   */
  shouldSnapshot(blockHeight: number): boolean {
    if (blockHeight === 0) return true; // always snapshot genesis
    return blockHeight > 0 && blockHeight % this.config.snapshotInterval === 0;
  }

  /**
   * Create a snapshot of the current UTXO state (transparent + confidential).
   *
   * @param height    - Block height
   * @param blockHash - Hash of the block at this height
   * @param utxoStore - Current transparent UTXO store
   * @param confidentialStore - Current confidential UTXO store (optional for backward compat)
   */
  createSnapshot(
    height: number,
    blockHash: string,
    utxoStore: UTXOStore,
    confidentialStore?: ConfidentialUTXOStore,
  ): Snapshot {
    const utxos = utxoStore.getAll();
    const confidentialUtxos = confidentialStore ? confidentialStore.getAll() : [];
    const keyImages = confidentialStore ? confidentialStore.getAllKeyImages() : [];

    // Combined state root matching blockchain.addBlock() formula
    const transparentRoot = utxoStore.computeStateRoot();
    const confidentialRoot = confidentialStore
      ? confidentialStore.computeStateRoot()
      : sha256('');
    const stateRoot = sha256(transparentRoot + '|' + confidentialRoot);

    // Estimate size: ~128 bytes per UTXO, ~96 per confidential, ~64 per key image
    const sizeBytes = utxos.length * 128 + confidentialUtxos.length * 96 + keyImages.length * 64 + 256;

    const snapshot: Snapshot = {
      height,
      blockHash,
      stateRoot,
      utxos,
      confidentialUtxos,
      keyImages,
      signatures: [],
      createdAt: Date.now(),
      sizeBytes,
    };

    // Store, respecting maxSnapshots limit
    this.snapshots.set(height, snapshot);
    this.enforceMaxSnapshots();

    return snapshot;
  }

  /**
   * Sign a snapshot (as a validator, attesting to its correctness).
   */
  signSnapshot(
    height: number,
    validatorSecretKey: Uint8Array,
    validatorPubKey: Uint8Array,
  ): boolean {
    const snapshot = this.snapshots.get(height);
    if (!snapshot) return false;

    const msg = this.snapshotSignatureMessage(snapshot);
    const sigBytes = sign(new Uint8Array(Buffer.from(msg, 'hex')), validatorSecretKey);

    // Don't duplicate signatures
    const pubHex = toHex(validatorPubKey);
    if (snapshot.signatures.some(s => s.validatorPubKey === pubHex)) return true;

    snapshot.signatures.push({
      validatorPubKey: pubHex,
      signature: toHex(sigBytes),
    });

    return true;
  }

  /**
   * Verify a snapshot's integrity and validator signatures.
   *
   * @param snapshot       - The snapshot to verify
   * @param validatorPubs  - Set of valid validator public keys (hex)
   * @param requiredSigs   - Minimum signatures required (2/3 + 1)
   */
  verifySnapshot(
    snapshot: Snapshot,
    validatorPubs: Set<string>,
    requiredSigs: number,
  ): { valid: boolean; error?: string } {
    // 1. Verify state root matches UTXOs (combined transparent + confidential)
    const tempStore = new UTXOStore();
    tempStore.loadFromSnapshot(snapshot.utxos);
    const transparentRoot = tempStore.computeStateRoot();

    const tempConfStore = new ConfidentialUTXOStore();
    if (snapshot.confidentialUtxos?.length || snapshot.keyImages?.length) {
      tempConfStore.loadFromSnapshot(snapshot.confidentialUtxos || [], snapshot.keyImages || []);
    }
    const confidentialRoot = tempConfStore.computeStateRoot();
    const computedRoot = sha256(transparentRoot + '|' + confidentialRoot);

    if (computedRoot !== snapshot.stateRoot) {
      return { valid: false, error: `State root mismatch: expected ${snapshot.stateRoot}, got ${computedRoot}` };
    }

    // 2. Verify signatures
    const msg = this.snapshotSignatureMessage(snapshot);
    const msgBytes = new Uint8Array(Buffer.from(msg, 'hex'));

    let validSigs = 0;
    for (const sig of snapshot.signatures) {
      if (!validatorPubs.has(sig.validatorPubKey)) continue;
      try {
        const sigBytes = fromHex(sig.signature);
        const pubBytes = fromHex(sig.validatorPubKey);
        if (verify(msgBytes, sigBytes, pubBytes)) {
          validSigs++;
        }
      } catch {
        // Invalid sig format, skip
      }
    }

    if (validSigs < requiredSigs) {
      return {
        valid: false,
        error: `Insufficient signatures: have ${validSigs}, need ${requiredSigs}`,
      };
    }

    return { valid: true };
  }

  /**
   * Load a snapshot into a UTXO store (for pruned node bootstrap).
   */
  loadSnapshot(snapshot: Snapshot, utxoStore: UTXOStore, confidentialStore?: ConfidentialUTXOStore): void {
    utxoStore.loadFromSnapshot(snapshot.utxos);
    if (confidentialStore && snapshot.confidentialUtxos) {
      confidentialStore.loadFromSnapshot(snapshot.confidentialUtxos, snapshot.keyImages || []);
    }
  }

  /**
   * Get the latest snapshot.
   */
  getLatestSnapshot(): Snapshot | undefined {
    let latest: Snapshot | undefined;
    for (const s of this.snapshots.values()) {
      if (!latest || s.height > latest.height) latest = s;
    }
    return latest;
  }

  /**
   * Get snapshot at a specific height.
   */
  getSnapshot(height: number): Snapshot | undefined {
    return this.snapshots.get(height);
  }

  /**
   * Get metadata for all snapshots (without the heavy UTXO data).
   */
  listSnapshots(): SnapshotMeta[] {
    return Array.from(this.snapshots.values())
      .map(s => ({
        height: s.height,
        blockHash: s.blockHash,
        stateRoot: s.stateRoot,
        signatureCount: s.signatures.length,
        sizeBytes: s.sizeBytes,
        createdAt: s.createdAt,
      }))
      .sort((a, b) => b.height - a.height);
  }

  /**
   * Import a snapshot received from a peer.
   */
  importSnapshot(snapshot: Snapshot): void {
    this.snapshots.set(snapshot.height, snapshot);
    this.enforceMaxSnapshots();
  }

  /**
   * Serialize snapshot for network transfer.
   * Returns JSON string (in production: use protobuf/msgpack).
   */
  serializeSnapshot(height: number): string | null {
    const snapshot = this.snapshots.get(height);
    if (!snapshot) return null;

    return JSON.stringify({
      ...snapshot,
      utxos: snapshot.utxos.map(u => ({
        txId: u.txId,
        outputIndex: u.outputIndex,
        amount: u.amount,
        recipientPubKeyHash: u.recipientPubKeyHash,
        blockHeight: u.blockHeight,
      })),
    });
  }

  /**
   * Deserialize snapshot from network data.
   */
  static deserializeSnapshot(data: string): Snapshot {
    const parsed = JSON.parse(data);
    return {
      height: parsed.height,
      blockHash: parsed.blockHash,
      stateRoot: parsed.stateRoot,
      utxos: parsed.utxos,
      confidentialUtxos: parsed.confidentialUtxos || [],
      keyImages: parsed.keyImages || [],
      signatures: parsed.signatures,
      createdAt: parsed.createdAt,
      sizeBytes: parsed.sizeBytes,
    };
  }

  /** Get total memory used by all snapshots */
  getMemoryUsage(): number {
    let total = 0;
    for (const s of this.snapshots.values()) total += s.sizeBytes;
    return total;
  }

  // ── Internal ──────────────────────────────────────────

  private snapshotSignatureMessage(snapshot: Snapshot): string {
    return sha256(
      `misaka_snapshot:${snapshot.height}:${snapshot.blockHash}:${snapshot.stateRoot}`
    );
  }

  private enforceMaxSnapshots(): void {
    if (this.snapshots.size <= this.config.maxSnapshots) return;

    // Remove oldest, but always keep the latest
    const sorted = Array.from(this.snapshots.keys()).sort((a, b) => a - b);
    while (this.snapshots.size > this.config.maxSnapshots && sorted.length > 1) {
      const oldest = sorted.shift()!;
      this.snapshots.delete(oldest);
    }
  }
}
