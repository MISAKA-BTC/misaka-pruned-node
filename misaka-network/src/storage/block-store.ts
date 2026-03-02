// ============================================================
// Misaka Network - Block Store Implementations
// ============================================================
// PrunedBlockStore: keeps only the latest N blocks (4GB VPS)
// ArchiveBlockStore: keeps all blocks since genesis (16GB+)
// ============================================================

import { Block } from '../types';
import { IBlockStore, BlockStoreStats, NodeRole, MEMORY_BUDGET } from './types';

// Rough estimate: 1 block ≈ 2KB average (header + ~5 TXs)
const ESTIMATED_BLOCK_BYTES = 2048;

// ============================================================
// Pruned Block Store (4GB VPS — validator node)
// ============================================================

/**
 * Stores only the most recent `maxBlocks` blocks.
 * Older blocks are discarded. UTXO state is maintained
 * via snapshots, so pruned blocks can be safely dropped.
 *
 * Memory: O(maxBlocks) — typically ~1000 blocks ≈ 2MB
 */
export class PrunedBlockStore implements IBlockStore {
  private blocks = new Map<string, Block>();       // hash → block
  private heightIndex = new Map<number, string>();  // height → hash
  private maxBlocks: number;
  private lowestHeight = 0;
  private highestHeight = -1;
  private prunedTotal = 0;

  constructor(maxBlocks: number = 1000) {
    this.maxBlocks = maxBlocks;
  }

  put(block: Block): void {
    const h = block.header.height;
    this.blocks.set(block.hash, block);
    this.heightIndex.set(h, block.hash);

    if (h > this.highestHeight) this.highestHeight = h;
    if (this.blocks.size === 1) this.lowestHeight = h;

    // Prune if over limit
    if (this.blocks.size > this.maxBlocks) {
      this.pruneOldest();
    }
  }

  getByHash(hash: string): Block | undefined {
    return this.blocks.get(hash);
  }

  getByHeight(height: number): Block | undefined {
    const hash = this.heightIndex.get(height);
    return hash ? this.blocks.get(hash) : undefined;
  }

  getRange(fromHeight: number, toHeight: number): Block[] {
    const result: Block[] = [];
    const lo = Math.max(fromHeight, this.lowestHeight);
    const hi = Math.min(toHeight, this.highestHeight);
    for (let h = lo; h <= hi; h++) {
      const block = this.getByHeight(h);
      if (block) result.push(block);
    }
    return result;
  }

  getLatestHeight(): number { return this.highestHeight; }
  getLowestHeight(): number { return this.lowestHeight; }
  blockCount(): number { return this.blocks.size; }

  pruneBelow(height: number): number {
    let pruned = 0;
    for (const [h, hash] of this.heightIndex) {
      if (h < height) {
        this.blocks.delete(hash);
        this.heightIndex.delete(h);
        pruned++;
      }
    }
    this.prunedTotal += pruned;
    this.lowestHeight = height;
    return pruned;
  }

  getStats(): BlockStoreStats {
    return {
      role: NodeRole.PRUNED_VALIDATOR,
      totalBlocks: this.blocks.size,
      lowestHeight: this.lowestHeight,
      highestHeight: this.highestHeight,
      estimatedMemoryMB: Math.ceil((this.blocks.size * ESTIMATED_BLOCK_BYTES) / (1024 * 1024)),
      pruned: true,
      prunedCount: this.prunedTotal,
    };
  }

  /** Is a given height still available? */
  hasHeight(height: number): boolean {
    return this.heightIndex.has(height);
  }

  /** Get max blocks setting */
  getMaxBlocks(): number { return this.maxBlocks; }

  private pruneOldest(): void {
    // Remove the lowest height block
    while (this.blocks.size > this.maxBlocks && this.lowestHeight <= this.highestHeight) {
      const hash = this.heightIndex.get(this.lowestHeight);
      if (hash) {
        this.blocks.delete(hash);
        this.heightIndex.delete(this.lowestHeight);
        this.prunedTotal++;
      }
      this.lowestHeight++;
    }
  }
}

// ============================================================
// Archive Block Store (16GB VPS — archive node)
// ============================================================

/**
 * Stores all blocks since genesis. Never prunes.
 * Used by archive nodes (operators only) and explorer nodes.
 *
 * Memory: O(totalBlocks) — grows unbounded
 * In production, would be backed by LevelDB/RocksDB.
 */
export class ArchiveBlockStore implements IBlockStore {
  private blocks = new Map<string, Block>();
  private heightIndex = new Map<number, string>();
  private highestHeight = -1;

  put(block: Block): void {
    this.blocks.set(block.hash, block);
    this.heightIndex.set(block.header.height, block.hash);
    if (block.header.height > this.highestHeight) {
      this.highestHeight = block.header.height;
    }
  }

  getByHash(hash: string): Block | undefined {
    return this.blocks.get(hash);
  }

  getByHeight(height: number): Block | undefined {
    const hash = this.heightIndex.get(height);
    return hash ? this.blocks.get(hash) : undefined;
  }

  getRange(fromHeight: number, toHeight: number): Block[] {
    const result: Block[] = [];
    const hi = Math.min(toHeight, this.highestHeight);
    for (let h = fromHeight; h <= hi; h++) {
      const block = this.getByHeight(h);
      if (block) result.push(block);
    }
    return result;
  }

  getLatestHeight(): number { return this.highestHeight; }
  getLowestHeight(): number { return 0; }
  blockCount(): number { return this.blocks.size; }

  /** Archive nodes never prune — returns 0 */
  pruneBelow(_height: number): number { return 0; }

  getStats(): BlockStoreStats {
    return {
      role: NodeRole.ARCHIVE,
      totalBlocks: this.blocks.size,
      lowestHeight: 0,
      highestHeight: this.highestHeight,
      estimatedMemoryMB: Math.ceil((this.blocks.size * ESTIMATED_BLOCK_BYTES) / (1024 * 1024)),
      pruned: false,
      prunedCount: 0,
    };
  }

  /** Get all block hashes (for sync protocol) */
  getAllHashes(): string[] {
    return Array.from(this.blocks.keys());
  }

  /** Get blocks by proposer */
  getByProposer(proposerHex: string): Block[] {
    return Array.from(this.blocks.values())
      .filter(b => b.header.proposer === proposerHex);
  }
}

// ============================================================
// Factory
// ============================================================

/** Create block store for a given role */
export function createBlockStore(role: NodeRole, pruningWindow?: number): IBlockStore {
  switch (role) {
    case NodeRole.PRUNED_VALIDATOR:
      return new PrunedBlockStore(pruningWindow ?? 1000);
    case NodeRole.ARCHIVE:
    case NodeRole.EXPLORER:
      return new ArchiveBlockStore();
  }
}
