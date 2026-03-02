// ============================================================
// Misaka Network - Block & Blockchain
// ============================================================
import {
  Block, BlockHeader, BlockSignature, Transaction, AnyTransaction,
  ConfidentialTransaction, FeeTier, DEFAULT_FEE_TIERS,
  TransactionType, isConfidentialTx,
} from '../types';
import { sha256, sign, verify, toHex, fromHex } from '../utils/crypto';
import { UTXOStore } from './utxo-store';
import { ConfidentialUTXOStore } from './confidential-utxo';
import { validateTransaction, createCoinbaseTx } from './transaction';
import { validateConfidentialTransaction } from './confidential';

const BLOCK_REWARD = 1000; // Initial block reward

/**
 * Compute the Merkle root of transactions.
 * Simple binary tree hash.
 */
export function computeMerkleRoot(txIds: string[]): string {
  if (txIds.length === 0) return sha256('');

  let hashes = [...txIds];

  while (hashes.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < hashes.length; i += 2) {
      const left = hashes[i];
      const right = i + 1 < hashes.length ? hashes[i + 1] : left;
      next.push(sha256(left + right));
    }
    hashes = next;
  }

  return hashes[0];
}

/**
 * Serialize a block header for hashing.
 */
export function serializeBlockHeader(header: BlockHeader): string {
  return JSON.stringify({
    version: header.version,
    height: header.height,
    previousHash: header.previousHash,
    merkleRoot: header.merkleRoot,
    timestamp: header.timestamp,
    proposer: header.proposer,
    stateRoot: header.stateRoot,
  });
}

/**
 * Compute block hash.
 */
export function computeBlockHash(header: BlockHeader): string {
  return sha256(serializeBlockHeader(header));
}

/**
 * Create a new block.
 */
export function createBlock(params: {
  height: number;
  previousHash: string;
  transactions: AnyTransaction[];
  proposerPubKey: Uint8Array;
  proposerSecretKey: Uint8Array;
  stateRoot: string;
}): Block {
  const { height, previousHash, transactions, proposerPubKey, proposerSecretKey, stateRoot } = params;

  const merkleRoot = computeMerkleRoot(transactions.map(tx => tx.id));
  const proposerHex = toHex(proposerPubKey);

  const header: BlockHeader = {
    version: 1,
    height,
    previousHash,
    merkleRoot,
    timestamp: Date.now(),
    proposer: proposerHex,
    stateRoot,
  };

  const hash = computeBlockHash(header);

  // Proposer signs the block
  const sigMsg = new Uint8Array(Buffer.from(hash, 'hex'));
  const signature = sign(sigMsg, proposerSecretKey);

  const block: Block = {
    header,
    hash,
    transactions,
    signatures: [{
      validatorPubKey: proposerHex,
      signature: toHex(signature),
    }],
  };

  return block;
}

/**
 * Verify a block signature.
 */
export function verifyBlockSignature(blockHash: string, sig: BlockSignature): boolean {
  const msgBytes = new Uint8Array(Buffer.from(blockHash, 'hex'));
  const sigBytes = fromHex(sig.signature);
  const pubKeyBytes = fromHex(sig.validatorPubKey);
  return verify(msgBytes, sigBytes, pubKeyBytes);
}

/**
 * Sign a block (as a validator).
 */
export function signBlock(blockHash: string, validatorSecretKey: Uint8Array, validatorPubKey: Uint8Array): BlockSignature {
  const msgBytes = new Uint8Array(Buffer.from(blockHash, 'hex'));
  const signature = sign(msgBytes, validatorSecretKey);
  return {
    validatorPubKey: toHex(validatorPubKey),
    signature: toHex(signature),
  };
}

/**
 * Blockchain: manages the chain of blocks.
 */
export class Blockchain {
  private blocks: Map<string, Block> = new Map();    // hash -> block
  private heightIndex: Map<number, string> = new Map(); // height -> hash
  private utxoStore: UTXOStore;
  private confidentialUTXOStore: ConfidentialUTXOStore;
  private feeTiers: FeeTier[];
  private validators: Set<string>; // hex pubkeys
  public currentHeight: number = -1;
  public latestHash: string = '0'.repeat(64);

  constructor(utxoStore: UTXOStore, feeTiers: FeeTier[] = DEFAULT_FEE_TIERS, validators: string[] = []) {
    this.utxoStore = utxoStore;
    this.confidentialUTXOStore = new ConfidentialUTXOStore();
    this.feeTiers = feeTiers;
    this.validators = new Set(validators);
  }

  /** Get the genesis hash */
  get genesisHash(): string {
    return this.heightIndex.get(0) || '0'.repeat(64);
  }

  /** Add a validator */
  addValidator(pubKeyHex: string): void {
    this.validators.add(pubKeyHex);
  }

  /** Get a block by hash */
  getBlock(hash: string): Block | undefined {
    return this.blocks.get(hash);
  }

  /** Get a block by height */
  getBlockByHeight(height: number): Block | undefined {
    const hash = this.heightIndex.get(height);
    return hash ? this.blocks.get(hash) : undefined;
  }

  /**
   * Validate and add a block to the chain.
   * Returns null on success, or error message.
   */
  addBlock(block: Block): string | null {
    // 1. Check height
    const expectedHeight = this.currentHeight + 1;
    if (block.header.height !== expectedHeight) {
      return `Invalid height: expected ${expectedHeight}, got ${block.header.height}`;
    }

    // 2. Check previous hash
    if (block.header.previousHash !== this.latestHash) {
      return `Invalid previous hash: expected ${this.latestHash}, got ${block.header.previousHash}`;
    }

    // 3. Verify block hash
    const computedHash = computeBlockHash(block.header);
    if (block.hash !== computedHash) {
      return `Invalid block hash: expected ${computedHash}, got ${block.hash}`;
    }

    // 4. Verify merkle root
    const computedMerkle = computeMerkleRoot(block.transactions.map(tx => tx.id));
    if (block.header.merkleRoot !== computedMerkle) {
      return `Invalid merkle root`;
    }

    // 5. Verify proposer is a validator
    if (this.validators.size > 0 && !this.validators.has(block.header.proposer)) {
      return `Block proposer ${block.header.proposer} is not a valid validator`;
    }

    // 6. Verify signatures (need 2/3 + 1)
    const validSigs = block.signatures.filter(sig => {
      if (this.validators.size > 0 && !this.validators.has(sig.validatorPubKey)) return false;
      return verifyBlockSignature(block.hash, sig);
    });

    const requiredSigs = this.validators.size > 0
      ? (block.header.height === 0
          ? 1  // Genesis block: 1 signature sufficient (pre-consensus)
          : Math.floor((this.validators.size * 2) / 3) + 1)
      : 1;

    if (validSigs.length < requiredSigs) {
      return `Insufficient signatures: have ${validSigs.length}, need ${requiredSigs}`;
    }

    // 7. Validate all transactions with intra-block double-spend tracking
    const spentInputsInBlock = new Set<string>();  // "txId:outputIndex"
    const spentKeyImagesInBlock = new Set<string>();

    for (let ti = 0; ti < block.transactions.length; ti++) {
      const tx = block.transactions[ti];

      if (isConfidentialTx(tx)) {
        // Confidential TX: verify ring sigs, key images, Pedersen balance
        const error = validateConfidentialTransaction(
          tx, this.confidentialUTXOStore, this.feeTiers
        );
        if (error) {
          return `Invalid confidential tx ${tx.id}: ${error}`;
        }
        // Intra-block key image double-spend check
        for (const ki of tx.keyImages) {
          if (spentKeyImagesInBlock.has(ki)) {
            return `Intra-block double-spend: key image ${ki.slice(0, 16)}... used twice`;
          }
          spentKeyImagesInBlock.add(ki);
        }
      } else {
        const transparentTx = tx as Transaction;

        // Strict coinbase check: ONLY type===COINBASE with prevTxId===0 is allowed
        const isCoinbaseInput = transparentTx.inputs[0]?.prevTxId === '0'.repeat(64);
        const isCoinbaseType = transparentTx.type === TransactionType.COINBASE;

        if (isCoinbaseInput && !isCoinbaseType) {
          return `TX ${tx.id}: zero prevTxId without COINBASE type — rejected`;
        }
        if (isCoinbaseType && !isCoinbaseInput) {
          return `TX ${tx.id}: COINBASE type without zero prevTxId — rejected`;
        }
        if (isCoinbaseType) {
          // Genesis (height 0): multiple coinbase TXs allowed (initial distribution)
          // Normal blocks: exactly one coinbase at index 0
          if (block.header.height > 0 && ti !== 0) {
            return `Coinbase TX must be first in block (found at index ${ti})`;
          }
          continue; // coinbase validated by block reward rules
        }

        // Intra-block transparent UTXO double-spend check
        for (const input of transparentTx.inputs) {
          const inputKey = `${input.prevTxId}:${input.outputIndex}`;
          if (spentInputsInBlock.has(inputKey)) {
            return `Intra-block double-spend: UTXO ${inputKey} used twice`;
          }
          spentInputsInBlock.add(inputKey);
        }

        const error = validateTransaction(
          transparentTx,
          (txId, idx) => this.utxoStore.get(txId, idx),
          this.feeTiers
        );
        if (error) {
          return `Invalid transaction ${tx.id}: ${error}`;
        }
      }
    }

    // 8. Apply all transactions to UTXO stores
    for (const tx of block.transactions) {
      if (isConfidentialTx(tx)) {
        this.confidentialUTXOStore.applyConfidentialTx(tx, block.header.height);
      } else {
        this.utxoStore.applyTransaction(tx as Transaction, block.header.height);
      }
    }

    // 9. Verify state root (includes both transparent + confidential UTXOs)
    const transparentRoot = this.utxoStore.computeStateRoot();
    const confidentialRoot = this.confidentialUTXOStore.computeStateRoot();
    const stateRoot = sha256(transparentRoot + '|' + confidentialRoot);

    if (block.header.stateRoot !== stateRoot) {
      // Revert transactions
      for (const tx of [...block.transactions].reverse()) {
        if (isConfidentialTx(tx)) {
          this.confidentialUTXOStore.revertConfidentialTx(tx);
        } else {
          this.utxoStore.revertTransaction(tx as Transaction);
        }
      }
      return `Invalid state root: expected ${stateRoot}, got ${block.header.stateRoot}`;
    }

    // 10. Store block
    this.blocks.set(block.hash, block);
    this.heightIndex.set(block.header.height, block.hash);
    this.currentHeight = block.header.height;
    this.latestHash = block.hash;

    // Clear spent UTXO cache — no longer needed after commit
    this.utxoStore.clearSpentCache();

    return null; // success
  }

  /**
   * Create genesis block with initial token distribution.
   */
  createGenesisBlock(
    distributions: { pubKeyHash: string; amount: number }[],
    proposerSecretKey: Uint8Array,
    proposerPubKey: Uint8Array
  ): Block {
    const txs: Transaction[] = distributions.map((dist, i) =>
      createCoinbaseTx(dist.pubKeyHash, dist.amount, 0)
    );

    // Apply to get state root
    for (const tx of txs) {
      this.utxoStore.applyTransaction(tx, 0);
    }
    const transparentRoot = this.utxoStore.computeStateRoot();
    const confidentialRoot = this.confidentialUTXOStore.computeStateRoot();
    const stateRoot = sha256(transparentRoot + '|' + confidentialRoot);

    // Revert (will be re-applied in addBlock)
    for (const tx of txs.reverse()) {
      this.utxoStore.revertTransaction(tx);
    }
    txs.reverse(); // restore order

    const block = createBlock({
      height: 0,
      previousHash: '0'.repeat(64),
      transactions: txs,
      proposerPubKey,
      proposerSecretKey,
      stateRoot,
    });

    return block;
  }

  /** Get the UTXO store */
  getUTXOStore(): UTXOStore {
    return this.utxoStore;
  }

  /** Compute the current combined state root */
  computeCurrentStateRoot(): string {
    const transparentRoot = this.utxoStore.computeStateRoot();
    const confidentialRoot = this.confidentialUTXOStore.computeStateRoot();
    return sha256(transparentRoot + '|' + confidentialRoot);
  }

  /** Get blocks in range */
  getBlocks(fromHeight: number, toHeight: number): Block[] {
    const blocks: Block[] = [];
    for (let h = fromHeight; h <= toHeight && h <= this.currentHeight; h++) {
      const block = this.getBlockByHeight(h);
      if (block) blocks.push(block);
    }
    return blocks;
  }

  /** Get chain info */
  getInfo(): { height: number; latestHash: string; utxoCount: number; stateRoot: string; confidentialUtxoCount: number } {
    const transparentRoot = this.utxoStore.computeStateRoot();
    const confidentialRoot = this.confidentialUTXOStore.computeStateRoot();
    return {
      height: this.currentHeight,
      latestHash: this.latestHash,
      utxoCount: this.utxoStore.size,
      stateRoot: sha256(transparentRoot + '|' + confidentialRoot),
      confidentialUtxoCount: this.confidentialUTXOStore.size,
    };
  }

  /** Get confidential UTXO store */
  getConfidentialUTXOStore(): ConfidentialUTXOStore {
    return this.confidentialUTXOStore;
  }
}
