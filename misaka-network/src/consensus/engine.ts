// ============================================================
// Misaka Network - BFT Consensus Engine
// ============================================================
import { EventEmitter } from 'events';
import { Block, BlockSignature, Transaction, AnyTransaction, isConfidentialTx } from '../types';
import { Blockchain, createBlock, signBlock, computeBlockHash, verifyBlockSignature } from '../core/blockchain';
import { Mempool } from '../core/mempool';
import { createCoinbaseTx } from '../core/transaction';
import { toHex, hashPubKey, sha256 } from '../utils/crypto';

const BLOCK_REWARD = 1000;

export interface ConsensusConfig {
  validators: { pubKey: Uint8Array; pubKeyHex: string }[];
  mySecretKey: Uint8Array;
  myPubKey: Uint8Array;
  blockInterval: number;      // ms between blocks
}

export type ConsensusEvent =
  | { type: 'propose'; block: Block }
  | { type: 'vote'; blockHash: string; signature: BlockSignature }
  | { type: 'committed'; block: Block }
  | { type: 'error'; message: string };

/**
 * Simple BFT Consensus:
 * - Round-robin leader selection
 * - Leader proposes block
 * - Validators vote (sign block hash)
 * - When 2/3+1 signatures collected, block is committed
 */
export class ConsensusEngine extends EventEmitter {
  private blockchain: Blockchain;
  private mempool: Mempool;
  private config: ConsensusConfig;
  private myPubKeyHex: string;
  private running: boolean = false;
  private timer: NodeJS.Timeout | null = null;
  private pendingVotes: Map<string, BlockSignature[]> = new Map();
  private pendingBlock: Block | null = null;

  constructor(blockchain: Blockchain, mempool: Mempool, config: ConsensusConfig) {
    super();
    this.blockchain = blockchain;
    this.mempool = mempool;
    this.config = config;
    this.myPubKeyHex = toHex(config.myPubKey);
  }

  /** Get the current round proposer (round-robin) */
  private getProposer(height: number): string {
    const index = height % this.config.validators.length;
    return this.config.validators[index].pubKeyHex;
  }

  /** Check if I'm the proposer for the given height */
  private amIProposer(height: number): boolean {
    return this.getProposer(height) === this.myPubKeyHex;
  }

  /** Required signature count: floor(2N/3) + 1 */
  private requiredSignatures(): number {
    return Math.floor((this.config.validators.length * 2) / 3) + 1;
  }

  /** Start the consensus loop */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNextRound();
  }

  /** Stop the consensus loop */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNextRound(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => this.runRound(), this.config.blockInterval);
  }

  /** Run a consensus round */
  private async runRound(): Promise<void> {
    if (!this.running) return;

    const nextHeight = this.blockchain.currentHeight + 1;

    if (this.amIProposer(nextHeight)) {
      this.proposeBlock(nextHeight);
    }

    this.scheduleNextRound();
  }

  /** Propose a new block */
  private proposeBlock(height: number): void {
    try {
      // Get transactions from mempool
      const txs = this.mempool.getTransactionsForBlock(50);

      // Create coinbase tx (block reward + fees to proposer)
      const totalFees = txs.reduce((sum, tx) => sum + tx.fee, 0);
      const proposerPubKeyHash = hashPubKey(this.config.myPubKey);
      const coinbaseTx = createCoinbaseTx(proposerPubKeyHash, BLOCK_REWARD + totalFees, height);

      const allTxs = [coinbaseTx, ...txs];

      // Calculate state root after applying txs
      const utxoStore = this.blockchain.getUTXOStore();
      const confidentialUTXOStore = this.blockchain.getConfidentialUTXOStore();

      // Temporarily apply transactions to compute combined state root
      for (const tx of allTxs) {
        if (isConfidentialTx(tx)) {
          confidentialUTXOStore.applyConfidentialTx(tx, height);
        } else {
          utxoStore.applyTransaction(tx as Transaction, height);
        }
      }
      const transparentRoot = utxoStore.computeStateRoot();
      const confidentialRoot = confidentialUTXOStore.computeStateRoot();
      const stateRoot = sha256(transparentRoot + '|' + confidentialRoot);

      // Revert (will be re-applied in addBlock)
      for (const tx of [...allTxs].reverse()) {
        if (isConfidentialTx(tx)) {
          confidentialUTXOStore.revertConfidentialTx(tx);
        } else {
          utxoStore.revertTransaction(tx as Transaction);
        }
      }

      const block = createBlock({
        height,
        previousHash: this.blockchain.latestHash,
        transactions: allTxs,
        proposerPubKey: this.config.myPubKey,
        proposerSecretKey: this.config.mySecretKey,
        stateRoot,
      });

      // Store pending block and our own vote
      this.pendingBlock = block;
      this.pendingVotes.set(block.hash, [...block.signatures]);

      // Emit propose event (P2P layer will broadcast)
      this.emit('consensus', { type: 'propose', block } as ConsensusEvent);

      // Check if we already have enough signatures
      this.tryCommit(block.hash);
    } catch (err: any) {
      this.emit('consensus', { type: 'error', message: err.message } as ConsensusEvent);
    }
  }

  /** Handle a proposed block from another validator */
  handleProposedBlock(block: Block): void {
    const nextHeight = this.blockchain.currentHeight + 1;

    // Verify it's for the right height
    if (block.header.height !== nextHeight) return;

    // Verify the proposer is correct for this round
    const expectedProposer = this.getProposer(nextHeight);
    if (block.header.proposer !== expectedProposer) return;

    // Verify block hash
    const computedHash = computeBlockHash(block.header);
    if (block.hash !== computedHash) return;

    // Store the block
    this.pendingBlock = block;

    // Vote for this block
    const vote = signBlock(block.hash, this.config.mySecretKey, this.config.myPubKey);

    // Store votes
    if (!this.pendingVotes.has(block.hash)) {
      this.pendingVotes.set(block.hash, []);
    }
    const votes = this.pendingVotes.get(block.hash)!;

    // Add proposer's signatures
    for (const sig of block.signatures) {
      if (!votes.find(v => v.validatorPubKey === sig.validatorPubKey)) {
        votes.push(sig);
      }
    }

    // Add our vote
    if (!votes.find(v => v.validatorPubKey === this.myPubKeyHex)) {
      votes.push(vote);
    }

    // Emit vote event
    this.emit('consensus', { type: 'vote', blockHash: block.hash, signature: vote } as ConsensusEvent);

    this.tryCommit(block.hash);
  }

  /** Handle a vote from another validator */
  handleVote(blockHash: string, signature: BlockSignature): void {
    // Verify voter is a known validator
    if (!this.config.validators.find(v => v.pubKeyHex === signature.validatorPubKey)) {
      return; // Ignore votes from non-validators
    }

    // Verify the signature is cryptographically valid
    if (!verifyBlockSignature(blockHash, signature)) {
      return; // Ignore invalid signatures
    }

    if (!this.pendingVotes.has(blockHash)) {
      this.pendingVotes.set(blockHash, []);
    }

    const votes = this.pendingVotes.get(blockHash)!;

    // Don't add duplicate votes
    if (votes.find(v => v.validatorPubKey === signature.validatorPubKey)) return;

    votes.push(signature);
    this.tryCommit(blockHash);
  }

  /** Try to commit a block if we have enough signatures */
  private tryCommit(blockHash: string): void {
    const votes = this.pendingVotes.get(blockHash);
    if (!votes || votes.length < this.requiredSignatures()) return;

    if (!this.pendingBlock || this.pendingBlock.hash !== blockHash) return;

    // Commit the block with all collected signatures
    const block = {
      ...this.pendingBlock,
      signatures: votes,
    };

    const error = this.blockchain.addBlock(block);
    if (error) {
      this.emit('consensus', { type: 'error', message: `Commit failed: ${error}` } as ConsensusEvent);
      return;
    }

    // Remove committed transactions from mempool
    this.mempool.removeTransactions(block.transactions.map(tx => tx.id));

    // Clear pending state
    this.pendingBlock = null;
    this.pendingVotes.delete(blockHash);

    // Emit committed event
    this.emit('consensus', { type: 'committed', block } as ConsensusEvent);
  }

  /** Get consensus status */
  getStatus(): {
    running: boolean;
    pendingBlock: string | null;
    pendingVotes: number;
    requiredVotes: number;
    nextProposer: string;
  } {
    const nextHeight = this.blockchain.currentHeight + 1;
    const pendingHash = this.pendingBlock?.hash || null;
    return {
      running: this.running,
      pendingBlock: pendingHash,
      pendingVotes: pendingHash ? (this.pendingVotes.get(pendingHash)?.length || 0) : 0,
      requiredVotes: this.requiredSignatures(),
      nextProposer: this.getProposer(nextHeight),
    };
  }
}
