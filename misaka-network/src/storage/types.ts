// ============================================================
// Misaka Network - Storage Types
// ============================================================

import { Block, Transaction, UTXOEntry, ConfidentialUTXOEntry, BlockSignature, Checkpoint } from '../types';

/** Node role determines resource usage and data retention */
export enum NodeRole {
  /**
   * Pruned Validator Node (4GB VPS)
   * - Latest UTXO set (snapshot)
   * - Last N blocks only (default 1000)
   * - Participates in consensus
   * - Minimum storage footprint
   */
  PRUNED_VALIDATOR = 'pruned_validator',

  /**
   * Archive Node (16GB VPS)
   * - Full block history since genesis
   * - Full UTXO set with historical states
   * - Does NOT participate in consensus
   * - Serves block data to pruned nodes
   */
  ARCHIVE = 'archive',

  /**
   * Explorer / Indexer Node (32GB VPS)
   * - Everything archive has
   * - Address → TX index
   * - TX → Block index
   * - Rich list (top balances)
   * - Address activity timeline
   * - Fee statistics
   * - Block production stats
   * - Serves REST API for block explorer UI
   */
  EXPLORER = 'explorer',
}

/** Memory budget per role */
export const MEMORY_BUDGET: Record<NodeRole, {
  maxMemoryMB: number;
  maxBlocks: number;
  maxUTXOCacheMB: number;
  indexEnabled: boolean;
  description: string;
}> = {
  [NodeRole.PRUNED_VALIDATOR]: {
    maxMemoryMB: 3072,     // 3GB usable of 4GB
    maxBlocks: 1000,       // ~last 1000 blocks
    maxUTXOCacheMB: 1024,  // 1GB UTXO cache
    indexEnabled: false,
    description: '4GB VPS — validator, pruned storage',
  },
  [NodeRole.ARCHIVE]: {
    maxMemoryMB: 14336,    // 14GB usable of 16GB
    maxBlocks: Infinity,   // all blocks
    maxUTXOCacheMB: 4096,  // 4GB UTXO cache
    indexEnabled: false,
    description: '16GB VPS — full history, no indexing',
  },
  [NodeRole.EXPLORER]: {
    maxMemoryMB: 28672,    // 28GB usable of 32GB
    maxBlocks: Infinity,   // all blocks
    maxUTXOCacheMB: 8192,  // 8GB UTXO cache
    indexEnabled: true,
    description: '32GB VPS — full history + indexes',
  },
};

/** Block store interface — abstraction over pruned/full storage */
export interface IBlockStore {
  /** Store a block */
  put(block: Block): void;
  /** Get block by hash */
  getByHash(hash: string): Block | undefined;
  /** Get block by height */
  getByHeight(height: number): Block | undefined;
  /** Get blocks in height range */
  getRange(fromHeight: number, toHeight: number): Block[];
  /** Get latest stored height */
  getLatestHeight(): number;
  /** Get lowest stored height (for pruned nodes, > 0) */
  getLowestHeight(): number;
  /** Total blocks currently stored */
  blockCount(): number;
  /** Prune blocks below height (no-op for archive/explorer) */
  pruneBelow(height: number): number;
  /** Get storage stats */
  getStats(): BlockStoreStats;
}

/** Block store statistics */
export interface BlockStoreStats {
  role: NodeRole;
  totalBlocks: number;
  lowestHeight: number;
  highestHeight: number;
  estimatedMemoryMB: number;
  pruned: boolean;
  prunedCount: number;
}

/** Snapshot: complete UTXO state at a given height */
export interface Snapshot {
  /** Block height this snapshot was taken at */
  height: number;
  /** Block hash at this height */
  blockHash: string;
  /** UTXO state root (Merkle hash) */
  stateRoot: string;
  /** All transparent UTXO entries */
  utxos: UTXOEntry[];
  /** All confidential UTXO entries */
  confidentialUtxos: ConfidentialUTXOEntry[];
  /** Spent key images (for confidential double-spend prevention) */
  keyImages: string[];
  /** Validator signatures attesting to this snapshot */
  signatures: BlockSignature[];
  /** Timestamp */
  createdAt: number;
  /** Byte size estimate */
  sizeBytes: number;
}

/** Snapshot metadata (without the heavy UTXO data) */
export interface SnapshotMeta {
  height: number;
  blockHash: string;
  stateRoot: string;
  signatureCount: number;
  sizeBytes: number;
  createdAt: number;
}

/** Storage configuration */
export interface StorageConfig {
  /** Node role */
  role: NodeRole;
  /** Maximum blocks to retain (pruned mode) */
  pruningWindow: number;
  /** Snapshot interval (blocks between snapshots) */
  snapshotInterval: number;
  /** Maximum snapshots to keep */
  maxSnapshots: number;
  /** Checkpoint interval (blocks between signed checkpoints) */
  checkpointInterval: number;
  /** Data directory path (for future disk-backed storage) */
  dataDir: string;
}

/** Default storage configs per role */
export function defaultStorageConfig(role: NodeRole): StorageConfig {
  switch (role) {
    case NodeRole.PRUNED_VALIDATOR:
      return {
        role,
        pruningWindow: 1000,
        snapshotInterval: 100,
        maxSnapshots: 3,
        checkpointInterval: 100,
        dataDir: './data/pruned',
      };
    case NodeRole.ARCHIVE:
      return {
        role,
        pruningWindow: Infinity,
        snapshotInterval: 1000,
        maxSnapshots: 10,
        checkpointInterval: 1000,
        dataDir: './data/archive',
      };
    case NodeRole.EXPLORER:
      return {
        role,
        pruningWindow: Infinity,
        snapshotInterval: 1000,
        maxSnapshots: 10,
        checkpointInterval: 1000,
        dataDir: './data/explorer',
      };
  }
}
