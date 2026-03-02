// ============================================================
// Misaka Network - Explorer / Indexer (32GB VPS)
// ============================================================
// Maintains rich indexes for a block explorer UI:
//   - Address → TX history
//   - TX → Block mapping
//   - Rich list (top balances)
//   - Address activity timeline
//   - Fee statistics per block
//   - Validator block production stats
//   - Supply / burn tracking
//
// This is the heaviest node role (32GB).
// Only operators who serve the explorer UI need this.
// ============================================================

import { Block, Transaction, UTXOEntry, AnyTransaction, isConfidentialTx, ConfidentialTransaction } from '../types';
import { UTXOStore } from '../core/utxo-store';
import { decryptAuditEnvelope, AuditData } from '../privacy/audit';

/** Single indexed transaction record */
export interface IndexedTx {
  txId: string;
  blockHeight: number;
  blockHash: string;
  timestamp: number;
  type: string;
  fee: number;
  inputCount: number;
  outputCount: number;
  totalOutputAmount: number;
  /** Addresses involved (sender and recipient pubkey hashes) */
  involvedAddresses: string[];
}

/** Address activity record */
export interface AddressActivity {
  txId: string;
  blockHeight: number;
  timestamp: number;
  direction: 'in' | 'out';
  amount: number;
  counterparty?: string; // other party's pubkey hash (if determinable)
}

/** Rich list entry */
export interface RichListEntry {
  pubKeyHash: string;
  balance: number;
  utxoCount: number;
  lastActive: number;       // block height
  totalReceived: number;
  totalSent: number;
}

/** Block stats for explorer dashboard */
export interface BlockStats {
  height: number;
  hash: string;
  proposer: string;
  txCount: number;
  totalFees: number;
  totalVolume: number;     // sum of all output amounts
  timestamp: number;
  sizeEstimate: number;    // bytes
}

/** Validator production stats */
export interface ValidatorStats {
  pubKeyHex: string;
  blocksProposed: number;
  totalFeesEarned: number;
  lastBlock: number;       // height
  uptime: number;          // ratio of proposed/expected blocks
}

/** Fee statistics */
export interface FeeStats {
  avgFeePerBlock: number;
  totalFees: number;
  feesByTier: Map<number, number>; // tier index → total fees
  blocksAnalyzed: number;
}

/** Supply statistics */
export interface SupplyStats {
  totalMinted: number;      // total coinbase rewards
  totalBurned: number;      // burned (bridge withdrawals, etc.)
  circulatingSupply: number;
  utxoCount: number;
  addressCount: number;     // unique addresses with balance
}

// ============================================================
// Indexer
// ============================================================

export class ExplorerIndexer {
  // ── Archive audit key (archive nodes only) ────────────
  /** If set, confidential txs are decrypted and fully indexed */
  private archiveSecretKey: string | null = null;

  // ── Core indexes ──────────────────────────────────────
  /** TX ID → indexed info */
  private txIndex = new Map<string, IndexedTx>();
  /** Address → TX IDs (ordered by block height) */
  private addressTxIndex = new Map<string, string[]>();
  /** Address → activity records */
  private addressActivity = new Map<string, AddressActivity[]>();
  /** Block height → block stats */
  private blockStatsIndex = new Map<number, BlockStats>();
  /** Validator pubkey → stats */
  private validatorStats = new Map<string, ValidatorStats>();

  // ── Aggregate counters ────────────────────────────────
  private totalMinted = 0;
  private totalBurned = 0;
  private totalFees = 0;
  private totalVolume = 0;
  private highestIndexedHeight = -1;

  /** Total indexed TXs */
  get txCount(): number { return this.txIndex.size; }
  /** Total unique addresses seen */
  get addressCount(): number { return this.addressTxIndex.size; }
  /** Highest block indexed */
  get latestHeight(): number { return this.highestIndexedHeight; }

  // ── Archive Audit Key ─────────────────────────────────

  /**
   * Set the archive secret key for decrypting confidential transactions.
   * Only archive/explorer nodes should call this.
   * Pruned nodes never have this key.
   */
  setArchiveKey(secretKeyHex: string): void {
    this.archiveSecretKey = secretKeyHex;
  }

  /** Check if this indexer can decrypt confidential txs */
  get canDecrypt(): boolean {
    return this.archiveSecretKey !== null;
  }

  // ============================================================
  // Indexing (called when a new block is added)
  // ============================================================

  /**
   * Index a block. Extracts all data needed for explorer queries.
   */
  indexBlock(block: Block): void {
    const height = block.header.height;
    if (height <= this.highestIndexedHeight) return; // already indexed

    let blockFees = 0;
    let blockVolume = 0;

    for (const tx of block.transactions) {
      blockFees += tx.fee;

      if (isConfidentialTx(tx)) {
        // Confidential TX: only fee is visible, no addresses/amounts
        this.indexConfidentialTransaction(tx, height, block.hash, block.header.timestamp);
        // Volume unknown for confidential txs
      } else {
        const transparentTx = tx as Transaction;
        this.indexTransaction(transparentTx, height, block.hash, block.header.timestamp);

        const outputTotal = transparentTx.outputs.reduce((s: number, o: any) => s + o.amount, 0);
        blockVolume += outputTotal;

        // Track minting (coinbase)
        if (transparentTx.inputs[0]?.prevTxId === '0'.repeat(64)) {
          this.totalMinted += outputTotal;
        }

        // Track burning (withdraw to burn address)
        for (const out of transparentTx.outputs) {
          if (out.recipientPubKeyHash === '0'.repeat(64)) {
            this.totalBurned += out.amount;
          }
        }
      }
    }

    this.totalFees += blockFees;
    this.totalVolume += blockVolume;

    // Block stats
    this.blockStatsIndex.set(height, {
      height,
      hash: block.hash,
      proposer: block.header.proposer,
      txCount: block.transactions.length,
      totalFees: blockFees,
      totalVolume: blockVolume,
      timestamp: block.header.timestamp,
      sizeEstimate: JSON.stringify(block).length,
    });

    // Validator stats
    this.updateValidatorStats(block);
    this.highestIndexedHeight = height;
  }

  private indexTransaction(tx: Transaction, blockHeight: number, blockHash: string, timestamp: number): void {
    const involvedAddresses = new Set<string>();

    // Collect output addresses
    for (const out of tx.outputs) {
      involvedAddresses.add(out.recipientPubKeyHash);
    }

    // Collect input addresses (the publicKey's hash — approximate)
    for (const inp of tx.inputs) {
      if (inp.prevTxId !== '0'.repeat(64) && inp.publicKey) {
        involvedAddresses.add(inp.publicKey);
      }
    }

    const totalOutputAmount = tx.outputs.reduce((s, o) => s + o.amount, 0);

    const indexed: IndexedTx = {
      txId: tx.id,
      blockHeight,
      blockHash,
      timestamp,
      type: tx.type,
      fee: tx.fee,
      inputCount: tx.inputs.length,
      outputCount: tx.outputs.length,
      totalOutputAmount,
      involvedAddresses: Array.from(involvedAddresses),
    };

    this.txIndex.set(tx.id, indexed);

    // Update address → TX index
    for (const addr of involvedAddresses) {
      if (!this.addressTxIndex.has(addr)) {
        this.addressTxIndex.set(addr, []);
      }
      this.addressTxIndex.get(addr)!.push(tx.id);
    }

    // Build address activity records
    // Outputs: recipients receive funds
    for (const out of tx.outputs) {
      const addr = out.recipientPubKeyHash;
      if (!this.addressActivity.has(addr)) {
        this.addressActivity.set(addr, []);
      }
      this.addressActivity.get(addr)!.push({
        txId: tx.id,
        blockHeight,
        timestamp,
        direction: 'in',
        amount: out.amount,
      });
    }

    // Inputs: senders spend funds
    for (const inp of tx.inputs) {
      if (inp.prevTxId === '0'.repeat(64)) continue; // coinbase
      const addr = inp.publicKey || 'unknown';
      if (!this.addressActivity.has(addr)) {
        this.addressActivity.set(addr, []);
      }
      this.addressActivity.get(addr)!.push({
        txId: tx.id,
        blockHeight,
        timestamp,
        direction: 'out',
        amount: 0, // actual amount resolved via UTXO lookup
      });
    }
  }

  /**
   * Index a confidential transaction.
   *
   * WITHOUT archive key (pruned node):
   *   Only fee and metadata visible — no sender, recipient, or amounts.
   *
   * WITH archive key (archive/explorer node):
   *   Decrypts audit envelope → indexes sender, recipient, amounts.
   *   Full address activity and rich list tracking.
   */
  private indexConfidentialTransaction(
    tx: ConfidentialTransaction,
    blockHeight: number,
    blockHash: string,
    timestamp: number
  ): void {
    // Try to decrypt audit envelope (archive nodes only)
    let auditData: AuditData | null = null;
    if (this.archiveSecretKey && tx.auditEnvelope) {
      auditData = decryptAuditEnvelope(tx.auditEnvelope, this.archiveSecretKey);
    }

    if (auditData) {
      // ── Archive mode: full indexing with decrypted data ──
      const involvedAddresses: string[] = [auditData.senderPubKeyHash];
      const totalAmount = auditData.outputs.reduce((s, o) => s + o.amount, 0);

      for (const out of auditData.outputs) {
        if (!involvedAddresses.includes(out.recipientPubKeyHash)) {
          involvedAddresses.push(out.recipientPubKeyHash);
        }
      }

      const indexed: IndexedTx = {
        txId: tx.id,
        blockHeight,
        blockHash,
        timestamp,
        type: 'confidential',
        fee: tx.fee,
        inputCount: tx.ringInputs.length,
        outputCount: tx.stealthOutputs.length,
        totalOutputAmount: totalAmount,
        involvedAddresses,
      };

      this.txIndex.set(tx.id, indexed);

      // Index address mappings
      for (const addr of involvedAddresses) {
        if (!this.addressTxIndex.has(addr)) this.addressTxIndex.set(addr, []);
        this.addressTxIndex.get(addr)!.push(tx.id);
      }

      // Index address activity (outgoing for sender)
      for (const out of auditData.outputs) {
        if (out.recipientPubKeyHash !== auditData.senderPubKeyHash) {
          // Sender activity (out)
          if (!this.addressActivity.has(auditData.senderPubKeyHash)) {
            this.addressActivity.set(auditData.senderPubKeyHash, []);
          }
          this.addressActivity.get(auditData.senderPubKeyHash)!.push({
            txId: tx.id,
            blockHeight,
            timestamp,
            direction: 'out',
            amount: out.amount,
            counterparty: out.recipientPubKeyHash,
          });

          // Recipient activity (in)
          if (!this.addressActivity.has(out.recipientPubKeyHash)) {
            this.addressActivity.set(out.recipientPubKeyHash, []);
          }
          this.addressActivity.get(out.recipientPubKeyHash)!.push({
            txId: tx.id,
            blockHeight,
            timestamp,
            direction: 'in',
            amount: out.amount,
            counterparty: auditData.senderPubKeyHash,
          });
        }
      }
    } else {
      // ── Pruned mode: minimal indexing (no plaintext) ──
      const indexed: IndexedTx = {
        txId: tx.id,
        blockHeight,
        blockHash,
        timestamp,
        type: 'confidential',
        fee: tx.fee,
        inputCount: tx.ringInputs.length,
        outputCount: tx.stealthOutputs.length,
        totalOutputAmount: 0, // unknown — hidden by Pedersen commitment
        involvedAddresses: [], // unknown — hidden by ring + stealth
      };

      this.txIndex.set(tx.id, indexed);
    }
  }

  private updateValidatorStats(block: Block): void {
    const proposer = block.header.proposer;
    const existing = this.validatorStats.get(proposer);
    const fees = block.transactions.reduce((s, tx) => s + tx.fee, 0);

    if (existing) {
      existing.blocksProposed++;
      existing.totalFeesEarned += fees;
      existing.lastBlock = block.header.height;
    } else {
      this.validatorStats.set(proposer, {
        pubKeyHex: proposer,
        blocksProposed: 1,
        totalFeesEarned: fees,
        lastBlock: block.header.height,
        uptime: 0, // computed on query
      });
    }
  }

  // ============================================================
  // Query API (for explorer REST endpoints)
  // ============================================================

  /** Get transaction by ID */
  getTx(txId: string): IndexedTx | undefined {
    return this.txIndex.get(txId);
  }

  /** Get transactions for an address (paginated) */
  getAddressTxs(pubKeyHash: string, offset = 0, limit = 20): IndexedTx[] {
    const txIds = this.addressTxIndex.get(pubKeyHash);
    if (!txIds) return [];
    return txIds
      .slice(offset, offset + limit)
      .map(id => this.txIndex.get(id)!)
      .filter(Boolean);
  }

  /** Get activity history for an address (paginated) */
  getAddressActivity(pubKeyHash: string, offset = 0, limit = 50): AddressActivity[] {
    const activity = this.addressActivity.get(pubKeyHash);
    if (!activity) return [];
    return activity
      .sort((a, b) => b.blockHeight - a.blockHeight)
      .slice(offset, offset + limit);
  }

  /** Get TX count for an address */
  getAddressTxCount(pubKeyHash: string): number {
    return this.addressTxIndex.get(pubKeyHash)?.length ?? 0;
  }

  /** Get block stats */
  getBlockStats(height: number): BlockStats | undefined {
    return this.blockStatsIndex.get(height);
  }

  /** Get recent block stats (for dashboard) */
  getRecentBlockStats(count = 10): BlockStats[] {
    const stats: BlockStats[] = [];
    for (let h = this.highestIndexedHeight; h >= 0 && stats.length < count; h--) {
      const s = this.blockStatsIndex.get(h);
      if (s) stats.push(s);
    }
    return stats;
  }

  /**
   * Build rich list from current UTXO set.
   * @param utxoStore - Current UTXO store
   * @param limit     - Top N entries
   */
  buildRichList(utxoStore: UTXOStore, limit = 100): RichListEntry[] {
    const balances = new Map<string, RichListEntry>();

    for (const utxo of utxoStore.getAll()) {
      const addr = utxo.recipientPubKeyHash;
      if (!balances.has(addr)) {
        balances.set(addr, {
          pubKeyHash: addr,
          balance: 0,
          utxoCount: 0,
          lastActive: 0,
          totalReceived: 0,
          totalSent: 0,
        });
      }
      const entry = balances.get(addr)!;
      entry.balance += utxo.amount;
      entry.utxoCount++;
      if (utxo.blockHeight > entry.lastActive) {
        entry.lastActive = utxo.blockHeight;
      }
    }

    // Enrich with activity data
    for (const [addr, entry] of balances) {
      const activity = this.addressActivity.get(addr);
      if (activity) {
        entry.totalReceived = activity
          .filter(a => a.direction === 'in')
          .reduce((s, a) => s + a.amount, 0);
      }
    }

    return Array.from(balances.values())
      .sort((a, b) => b.balance - a.balance)
      .slice(0, limit);
  }

  /** Get validator stats */
  getValidatorStats(pubKeyHex: string): ValidatorStats | undefined {
    return this.validatorStats.get(pubKeyHex);
  }

  /** Get all validators ranked by blocks proposed */
  getAllValidatorStats(): ValidatorStats[] {
    const stats = Array.from(this.validatorStats.values());

    // Compute uptime: blocksProposed / expected blocks
    const totalBlocks = this.highestIndexedHeight + 1;
    const validatorCount = stats.length || 1;
    const expectedPerValidator = totalBlocks / validatorCount;

    for (const s of stats) {
      s.uptime = expectedPerValidator > 0
        ? Math.min(1, s.blocksProposed / expectedPerValidator)
        : 0;
    }

    return stats.sort((a, b) => b.blocksProposed - a.blocksProposed);
  }

  /** Get fee statistics */
  getFeeStats(): FeeStats {
    const blocksAnalyzed = this.blockStatsIndex.size;
    return {
      avgFeePerBlock: blocksAnalyzed > 0 ? this.totalFees / blocksAnalyzed : 0,
      totalFees: this.totalFees,
      feesByTier: new Map(), // would be populated by analyzing individual TXs
      blocksAnalyzed,
    };
  }

  /** Get supply statistics */
  getSupplyStats(utxoStore: UTXOStore): SupplyStats {
    const allUtxos = utxoStore.getAll();
    const uniqueAddresses = new Set(allUtxos.map(u => u.recipientPubKeyHash));

    return {
      totalMinted: this.totalMinted,
      totalBurned: this.totalBurned,
      circulatingSupply: this.totalMinted - this.totalBurned,
      utxoCount: allUtxos.length,
      addressCount: uniqueAddresses.size,
    };
  }

  /** Search by TX ID prefix */
  searchTx(prefix: string, limit = 10): IndexedTx[] {
    const results: IndexedTx[] = [];
    for (const [txId, indexed] of this.txIndex) {
      if (txId.startsWith(prefix)) {
        results.push(indexed);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  /** Search by address prefix */
  searchAddress(prefix: string, limit = 10): string[] {
    const results: string[] = [];
    for (const addr of this.addressTxIndex.keys()) {
      if (addr.startsWith(prefix)) {
        results.push(addr);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  // ============================================================
  // Memory stats
  // ============================================================

  getMemoryStats(): {
    txIndexSize: number;
    addressIndexSize: number;
    blockStatsSize: number;
    validatorStatsSize: number;
    estimatedMemoryMB: number;
  } {
    // Rough estimates
    const txBytes = this.txIndex.size * 512;
    const addrBytes = this.addressTxIndex.size * 256;
    const activityBytes = Array.from(this.addressActivity.values())
      .reduce((s, a) => s + a.length * 128, 0);
    const blockStatsBytes = this.blockStatsIndex.size * 256;
    const validatorBytes = this.validatorStats.size * 128;

    const totalBytes = txBytes + addrBytes + activityBytes + blockStatsBytes + validatorBytes;

    return {
      txIndexSize: this.txIndex.size,
      addressIndexSize: this.addressTxIndex.size,
      blockStatsSize: this.blockStatsIndex.size,
      validatorStatsSize: this.validatorStats.size,
      estimatedMemoryMB: Math.ceil(totalBytes / (1024 * 1024)),
    };
  }
}
