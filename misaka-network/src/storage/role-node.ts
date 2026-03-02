// ============================================================
// Misaka Network - Role-Aware Node
// ============================================================
// Wraps MisakaNode with storage tier behavior:
//
//   PRUNED_VALIDATOR (4GB):
//     - Participates in consensus
//     - Keeps last N blocks only
//     - Periodically snapshots UTXO state
//     - Bootstraps from snapshot when joining
//
//   ARCHIVE (16GB):
//     - Does NOT participate in consensus
//     - Stores every block since genesis
//     - Serves historical data to pruned nodes
//
//   EXPLORER (32GB):
//     - Everything archive has
//     - Maintains rich indexes (address→TX, richlist, etc.)
//     - Serves REST API for block explorer UI
// ============================================================

import { EventEmitter } from 'events';
import { Block, Transaction, BlockSignature, NodeConfig, UTXOEntry } from '../types';
import { UTXOStore } from '../core/utxo-store';
import { Blockchain } from '../core/blockchain';
import { Mempool } from '../core/mempool';
import { sha256, toHex, fromHex, hashPubKey } from '../utils/crypto';
import {
  NodeRole, StorageConfig, MEMORY_BUDGET,
  IBlockStore, Snapshot, SnapshotMeta,
  defaultStorageConfig,
} from '../storage/types';
import { createBlockStore, PrunedBlockStore, ArchiveBlockStore } from '../storage/block-store';
import { SnapshotManager } from '../storage/snapshot';
import { ExplorerIndexer } from '../explorer/indexer';
import { ExplorerAPI, ExplorerAPIConfig } from '../explorer/api';

// ============================================================
// Configuration
// ============================================================

export interface RoleNodeConfig {
  /** Core config (chainId, ports, validators, etc.) */
  node: NodeConfig;
  /** Storage configuration */
  storage: StorageConfig;
  /** Explorer API config (only for EXPLORER role) */
  explorerAPI?: ExplorerAPIConfig;
}

/** Convenience: create config for a specific role */
export function createRoleConfig(
  nodeConfig: NodeConfig,
  role: NodeRole,
  overrides?: Partial<StorageConfig>,
): RoleNodeConfig {
  const storage = { ...defaultStorageConfig(role), ...overrides };
  return {
    node: nodeConfig,
    storage,
    explorerAPI: role === NodeRole.EXPLORER
      ? { port: nodeConfig.rpcPort + 1000, host: '0.0.0.0' }
      : undefined,
  };
}

// ============================================================
// Role-Aware Node
// ============================================================

export class RoleAwareNode extends EventEmitter {
  readonly role: NodeRole;
  readonly blockStore: IBlockStore;
  readonly snapshotManager: SnapshotManager;
  readonly utxoStore: UTXOStore;
  readonly blockchain: Blockchain;
  readonly mempool: Mempool;
  readonly indexer: ExplorerIndexer | null;
  private explorerAPI: ExplorerAPI | null = null;
  private config: RoleNodeConfig;
  private validatorKey?: { publicKey: Uint8Array; secretKey: Uint8Array };
  private running = false;

  constructor(config: RoleNodeConfig) {
    super();
    this.config = config;
    this.role = config.storage.role;

    // Create stores based on role
    this.blockStore = createBlockStore(
      this.role,
      config.storage.pruningWindow
    );
    this.snapshotManager = new SnapshotManager(config.storage);
    this.utxoStore = new UTXOStore();
    this.blockchain = new Blockchain(
      this.utxoStore,
      config.node.feeTiers,
      config.node.validators,
    );
    this.mempool = new Mempool(config.node.feeTiers);

    // Explorer-only: create indexer
    this.indexer = this.role === NodeRole.EXPLORER
      ? new ExplorerIndexer()
      : null;
  }

  /** Set validator key (only PRUNED_VALIDATOR role) */
  setValidatorKey(secretKey: Uint8Array, publicKey: Uint8Array): void {
    if (this.role !== NodeRole.PRUNED_VALIDATOR) {
      throw new Error(`Only pruned_validator nodes can validate. This is a ${this.role} node.`);
    }
    this.validatorKey = { secretKey, publicKey };
  }

  /** Start the node */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Start explorer API if applicable
    if (this.role === NodeRole.EXPLORER && this.config.explorerAPI) {
      this.explorerAPI = new ExplorerAPI(
        this.indexer!,
        this.utxoStore,
        this.blockStore,
        this.config.explorerAPI,
      );
      await this.explorerAPI.start();
    }

    this.emit('started', {
      role: this.role,
      memoryBudget: MEMORY_BUDGET[this.role],
    });
  }

  /** Stop the node */
  async stop(): Promise<void> {
    this.running = false;
    if (this.explorerAPI) await this.explorerAPI.stop();
    this.emit('stopped');
  }

  // ============================================================
  // Block Processing (role-dependent behavior)
  // ============================================================

  /**
   * Process a new block. Behavior varies by role:
   *
   * PRUNED_VALIDATOR:
   *   - Add to blockchain (validate + apply UTXOs)
   *   - Store in pruned block store (auto-prune old)
   *   - Snapshot UTXO state periodically
   *
   * ARCHIVE:
   *   - Add to blockchain
   *   - Store in archive block store (keep all)
   *   - Snapshot less frequently
   *
   * EXPLORER:
   *   - Same as archive
   *   - Additionally index all TX data
   */
  processBlock(block: Block): string | null {
    // 1. Validate and apply to blockchain
    const error = this.blockchain.addBlock(block);
    if (error) return error;

    // 2. Store in block store
    this.blockStore.put(block);

    // 3. Role-specific processing
    const height = block.header.height;

    // Snapshot if interval reached
    if (this.snapshotManager.shouldSnapshot(height)) {
      const snapshot = this.snapshotManager.createSnapshot(
        height,
        block.hash,
        this.utxoStore,
        this.blockchain.getConfidentialUTXOStore(),
      );

      // Validators sign the snapshot
      if (this.validatorKey) {
        this.snapshotManager.signSnapshot(
          height,
          this.validatorKey.secretKey,
          this.validatorKey.publicKey,
        );
      }

      this.emit('snapshot', {
        height,
        utxoCount: snapshot.utxos.length,
        sizeBytes: snapshot.sizeBytes,
      });

      // Pruned nodes: discard blocks older than snapshot - pruningWindow
      if (this.role === NodeRole.PRUNED_VALIDATOR) {
        const pruneBelow = Math.max(0, height - this.config.storage.pruningWindow);
        const pruned = this.blockStore.pruneBelow(pruneBelow);
        if (pruned > 0) {
          this.emit('pruned', { prunedCount: pruned, newLowest: pruneBelow });
        }
      }
    }

    // Explorer: index block
    if (this.indexer) {
      this.indexer.indexBlock(block);
    }

    // Remove confirmed TXs from mempool
    this.mempool.removeTransactions(block.transactions.map(tx => tx.id));

    this.emit('block', {
      height,
      hash: block.hash,
      txCount: block.transactions.length,
    });

    return null;
  }

  // ============================================================
  // Snapshot Bootstrap (for pruned nodes joining the network)
  // ============================================================

  /**
   * Bootstrap from a snapshot (pruned node joining).
   *
   * Flow:
   *   1. Download latest snapshot from archive/explorer node
   *   2. Verify snapshot signatures (2/3 validators)
   *   3. Load UTXO state from snapshot
   *   4. Request blocks from snapshot height onward
   *   5. Apply remaining blocks
   *   6. Start validating
   */
  bootstrapFromSnapshot(
    snapshot: Snapshot,
    validatorPubs: Set<string>,
  ): { success: boolean; error?: string } {
    // 1. Verify snapshot
    const requiredSigs = Math.floor((validatorPubs.size * 2) / 3) + 1;
    const verification = this.snapshotManager.verifySnapshot(
      snapshot,
      validatorPubs,
      requiredSigs,
    );

    if (!verification.valid) {
      return { success: false, error: verification.error };
    }

    // 2. Load UTXO state (transparent + confidential)
    this.snapshotManager.loadSnapshot(
      snapshot, this.utxoStore, this.blockchain.getConfidentialUTXOStore()
    );

    // 3. Update blockchain state
    this.blockchain.currentHeight = snapshot.height;
    this.blockchain.latestHash = snapshot.blockHash;

    this.emit('bootstrap', {
      snapshotHeight: snapshot.height,
      utxoCount: snapshot.utxos.length,
      stateRoot: snapshot.stateRoot,
    });

    return { success: true };
  }

  /**
   * Catch up by applying blocks after the snapshot.
   * Called after bootstrapFromSnapshot.
   *
   * @param blocks - Blocks from snapshot.height+1 to current
   */
  applyCatchUpBlocks(blocks: Block[]): { applied: number; errors: string[] } {
    let applied = 0;
    const errors: string[] = [];

    for (const block of blocks) {
      const error = this.processBlock(block);
      if (error) {
        errors.push(`Block ${block.header.height}: ${error}`);
      } else {
        applied++;
      }
    }

    return { applied, errors };
  }

  // ============================================================
  // Queries
  // ============================================================

  /** Get node status */
  getStatus(): {
    role: string;
    height: number;
    stateRoot: string;
    utxoCount: number;
    mempoolSize: number;
    blockStoreStats: any;
    snapshotCount: number;
    latestSnapshot: SnapshotMeta | null;
    indexerStats: any;
    memoryBudget: any;
  } {
    const latestSnap = this.snapshotManager.getLatestSnapshot();
    return {
      role: this.role,
      height: this.blockchain.currentHeight,
      stateRoot: this.utxoStore.computeStateRoot(),
      utxoCount: this.utxoStore.size,
      mempoolSize: this.mempool.size,
      blockStoreStats: this.blockStore.getStats(),
      snapshotCount: this.snapshotManager.listSnapshots().length,
      latestSnapshot: latestSnap ? {
        height: latestSnap.height,
        blockHash: latestSnap.blockHash,
        stateRoot: latestSnap.stateRoot,
        signatureCount: latestSnap.signatures.length,
        sizeBytes: latestSnap.sizeBytes,
        createdAt: latestSnap.createdAt,
      } : null,
      indexerStats: this.indexer?.getMemoryStats() || null,
      memoryBudget: MEMORY_BUDGET[this.role],
    };
  }

  /** Get block by height (may return undefined on pruned nodes) */
  getBlock(height: number): Block | undefined {
    return this.blockStore.getByHeight(height);
  }

  /** Get blocks in range */
  getBlocks(fromHeight: number, toHeight: number): Block[] {
    return this.blockStore.getRange(fromHeight, toHeight);
  }

  /** Check if this node has a specific block height */
  hasBlock(height: number): boolean {
    return this.blockStore.getByHeight(height) !== undefined;
  }

  /** Get available block range */
  getAvailableRange(): { lowest: number; highest: number } {
    return {
      lowest: this.blockStore.getLowestHeight(),
      highest: this.blockStore.getLatestHeight(),
    };
  }

  /** Request blocks from archive node (for pruned node sync) */
  getRequiredBlockRange(): { from: number; to: number } | null {
    const latest = this.blockchain.currentHeight;
    const storeLowest = this.blockStore.getLowestHeight();
    const storeHighest = this.blockStore.getLatestHeight();

    if (storeHighest < latest) {
      return { from: storeHighest + 1, to: latest };
    }
    return null;
  }

  /** Get balance for an address */
  getBalance(pubKeyHash: string): number {
    return this.utxoStore.getBalance(pubKeyHash);
  }

  /** Get UTXOs for an address */
  getUTXOs(pubKeyHash: string): UTXOEntry[] {
    return this.utxoStore.getByPubKeyHash(pubKeyHash);
  }

  /** Submit a transaction */
  submitTransaction(tx: Transaction): string | null {
    return this.mempool.addTransaction(
      tx,
      (txId, idx) => this.utxoStore.get(txId, idx),
    );
  }

  /** Memory estimate (MB) */
  estimateMemoryUsage(): {
    blockStoreMB: number;
    utxoStoreMB: number;
    snapshotsMB: number;
    indexerMB: number;
    totalMB: number;
    budgetMB: number;
    usagePercent: number;
  } {
    const blockMB = this.blockStore.getStats().estimatedMemoryMB;
    const utxoMB = Math.ceil((this.utxoStore.size * 128) / (1024 * 1024));
    const snapMB = Math.ceil(this.snapshotManager.getMemoryUsage() / (1024 * 1024));
    const idxMB = this.indexer?.getMemoryStats().estimatedMemoryMB || 0;
    const totalMB = blockMB + utxoMB + snapMB + idxMB;
    const budgetMB = MEMORY_BUDGET[this.role].maxMemoryMB;

    return {
      blockStoreMB: blockMB,
      utxoStoreMB: utxoMB,
      snapshotsMB: snapMB,
      indexerMB: idxMB,
      totalMB,
      budgetMB,
      usagePercent: Math.round((totalMB / budgetMB) * 100),
    };
  }
}
