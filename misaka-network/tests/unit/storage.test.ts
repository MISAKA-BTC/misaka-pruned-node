// ============================================================
// Misaka Network - Storage & Explorer Tests
// ============================================================
// Tests for 3 node roles:
//   4GB  pruned_validator — prune + snapshot + consensus
//   16GB archive          — full history, no indexing
//   32GB explorer         — full history + rich indexes
// ============================================================

import nacl from 'tweetnacl';
import {
  PrunedBlockStore,
  ArchiveBlockStore,
  createBlockStore,
} from '../../src/storage/block-store';
import {
  NodeRole,
  MEMORY_BUDGET,
  defaultStorageConfig,
} from '../../src/storage/types';
import { SnapshotManager } from '../../src/storage/snapshot';
import { RoleAwareNode, createRoleConfig } from '../../src/storage/role-node';
import { ExplorerIndexer } from '../../src/explorer/indexer';
import { UTXOStore } from '../../src/core/utxo-store';
import { Blockchain, createBlock, computeBlockHash } from '../../src/core/blockchain';
import { createCoinbaseTx } from '../../src/core/transaction';
import { toHex, hashPubKey, sha256 } from '../../src/utils/crypto';
import { ConfidentialUTXOStore } from '../../src/core/confidential-utxo';
import {
  Block, Transaction, TransactionType,
  DEFAULT_FEE_TIERS, NodeConfig,
} from '../../src/types';

// ── Test Helpers ────────────────────────────────────────

function makeValidatorKeyPair() {
  const kp = nacl.sign.keyPair();
  return {
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    pubHex: toHex(kp.publicKey),
    pubKeyHash: hashPubKey(kp.publicKey),
  };
}

function makeTestBlock(
  height: number,
  previousHash: string,
  proposer: { publicKey: Uint8Array; secretKey: Uint8Array },
  utxoStore: UTXOStore,
  txs?: Transaction[],
  confStore?: ConfidentialUTXOStore,
): Block {
  const coinbase = createCoinbaseTx(hashPubKey(proposer.publicKey), 1000, height);
  const transactions = txs ? [coinbase, ...txs] : [coinbase];

  // Apply to get state root
  for (const tx of transactions) utxoStore.applyTransaction(tx, height);
  const confRoot = confStore ? confStore.computeStateRoot() : new ConfidentialUTXOStore().computeStateRoot();
  const stateRoot = sha256(utxoStore.computeStateRoot() + '|' + confRoot);
  for (const tx of [...transactions].reverse()) {
    utxoStore.revertTransaction(tx, () => undefined);
  }

  return createBlock({
    height,
    previousHash,
    transactions,
    proposerPubKey: proposer.publicKey,
    proposerSecretKey: proposer.secretKey,
    stateRoot,
  });
}

function defaultNodeConfig(validators: string[]): NodeConfig {
  return {
    chainId: 'misaka-test',
    network: 'testnet',
    listenHost: '0.0.0.0',
    listenPort: 26656,
    rpcPort: 26657,
    peers: [],
    dataDir: './data/test',
    pruningWindow: 100,
    feeTiers: DEFAULT_FEE_TIERS,
    validators,
    blockInterval: 5000,
    checkpointInterval: 100,
  };
}

// ============================================================
// PrunedBlockStore Tests
// ============================================================

describe('PrunedBlockStore (4GB VPS)', () => {
  const v = makeValidatorKeyPair();
  let utxo: UTXOStore;

  beforeEach(() => {
    utxo = new UTXOStore();
  });

  test('stores blocks up to maxBlocks', () => {
    const store = new PrunedBlockStore(5);

    let prevHash = '0'.repeat(64);
    for (let i = 0; i < 5; i++) {
      const block = makeTestBlock(i, prevHash, v, utxo);
      store.put(block);
      prevHash = block.hash;
    }

    expect(store.blockCount()).toBe(5);
    expect(store.getByHeight(0)).toBeDefined();
    expect(store.getByHeight(4)).toBeDefined();
  });

  test('auto-prunes when exceeding maxBlocks', () => {
    const store = new PrunedBlockStore(3);

    let prevHash = '0'.repeat(64);
    for (let i = 0; i < 7; i++) {
      const block = makeTestBlock(i, prevHash, v, utxo);
      store.put(block);
      prevHash = block.hash;
    }

    expect(store.blockCount()).toBe(3);
    expect(store.getLowestHeight()).toBe(4);
    expect(store.getLatestHeight()).toBe(6);
    expect(store.getByHeight(0)).toBeUndefined(); // pruned
    expect(store.getByHeight(3)).toBeUndefined(); // pruned
    expect(store.getByHeight(4)).toBeDefined();   // kept
    expect(store.getByHeight(6)).toBeDefined();   // kept
  });

  test('manual pruneBelow removes specified blocks', () => {
    const store = new PrunedBlockStore(100);

    let prevHash = '0'.repeat(64);
    for (let i = 0; i < 10; i++) {
      const block = makeTestBlock(i, prevHash, v, utxo);
      store.put(block);
      prevHash = block.hash;
    }

    const pruned = store.pruneBelow(7);
    expect(pruned).toBe(7);
    expect(store.blockCount()).toBe(3);
    expect(store.getLowestHeight()).toBe(7);
  });

  test('stats reflect pruning', () => {
    const store = new PrunedBlockStore(3);

    let prevHash = '0'.repeat(64);
    for (let i = 0; i < 10; i++) {
      const block = makeTestBlock(i, prevHash, v, utxo);
      store.put(block);
      prevHash = block.hash;
    }

    const stats = store.getStats();
    expect(stats.role).toBe(NodeRole.PRUNED_VALIDATOR);
    expect(stats.pruned).toBe(true);
    expect(stats.prunedCount).toBe(7);
    expect(stats.totalBlocks).toBe(3);
    expect(stats.lowestHeight).toBe(7);
    expect(stats.highestHeight).toBe(9);
  });

  test('getRange respects pruned boundaries', () => {
    const store = new PrunedBlockStore(5);

    let prevHash = '0'.repeat(64);
    for (let i = 0; i < 10; i++) {
      const block = makeTestBlock(i, prevHash, v, utxo);
      store.put(block);
      prevHash = block.hash;
    }

    const range = store.getRange(0, 9);
    expect(range.length).toBe(5); // only 5 kept
    expect(range[0].header.height).toBe(5);
    expect(range[4].header.height).toBe(9);
  });
});

// ============================================================
// ArchiveBlockStore Tests
// ============================================================

describe('ArchiveBlockStore (16GB VPS)', () => {
  const v = makeValidatorKeyPair();
  let utxo: UTXOStore;

  beforeEach(() => {
    utxo = new UTXOStore();
  });

  test('stores all blocks (never prunes)', () => {
    const store = new ArchiveBlockStore();

    let prevHash = '0'.repeat(64);
    for (let i = 0; i < 20; i++) {
      const block = makeTestBlock(i, prevHash, v, utxo);
      store.put(block);
      prevHash = block.hash;
    }

    expect(store.blockCount()).toBe(20);
    expect(store.getByHeight(0)).toBeDefined();
    expect(store.getByHeight(19)).toBeDefined();
    expect(store.getLowestHeight()).toBe(0);
  });

  test('pruneBelow is a no-op', () => {
    const store = new ArchiveBlockStore();

    let prevHash = '0'.repeat(64);
    for (let i = 0; i < 10; i++) {
      const block = makeTestBlock(i, prevHash, v, utxo);
      store.put(block);
      prevHash = block.hash;
    }

    const pruned = store.pruneBelow(5);
    expect(pruned).toBe(0);
    expect(store.blockCount()).toBe(10);
  });

  test('stats are correct', () => {
    const store = new ArchiveBlockStore();
    let prevHash = '0'.repeat(64);
    for (let i = 0; i < 5; i++) {
      const block = makeTestBlock(i, prevHash, v, utxo);
      store.put(block);
      prevHash = block.hash;
    }

    const stats = store.getStats();
    expect(stats.role).toBe(NodeRole.ARCHIVE);
    expect(stats.pruned).toBe(false);
    expect(stats.totalBlocks).toBe(5);
    expect(stats.lowestHeight).toBe(0);
    expect(stats.highestHeight).toBe(4);
  });
});

// ============================================================
// Factory Tests
// ============================================================

describe('createBlockStore factory', () => {
  test('pruned_validator creates PrunedBlockStore', () => {
    const store = createBlockStore(NodeRole.PRUNED_VALIDATOR, 50);
    expect(store).toBeInstanceOf(PrunedBlockStore);
  });

  test('archive creates ArchiveBlockStore', () => {
    const store = createBlockStore(NodeRole.ARCHIVE);
    expect(store).toBeInstanceOf(ArchiveBlockStore);
  });

  test('explorer creates ArchiveBlockStore', () => {
    const store = createBlockStore(NodeRole.EXPLORER);
    expect(store).toBeInstanceOf(ArchiveBlockStore);
  });
});

// ============================================================
// Snapshot Manager Tests
// ============================================================

describe('SnapshotManager', () => {
  const v = makeValidatorKeyPair();

  test('shouldSnapshot at correct intervals', () => {
    const mgr = new SnapshotManager(defaultStorageConfig(NodeRole.PRUNED_VALIDATOR));
    // pruned default: snapshotInterval = 100
    expect(mgr.shouldSnapshot(0)).toBe(true);
    expect(mgr.shouldSnapshot(1)).toBe(false);
    expect(mgr.shouldSnapshot(99)).toBe(false);
    expect(mgr.shouldSnapshot(100)).toBe(true);
    expect(mgr.shouldSnapshot(200)).toBe(true);
  });

  test('create and list snapshots', () => {
    const mgr = new SnapshotManager(defaultStorageConfig(NodeRole.PRUNED_VALIDATOR));
    const utxo = new UTXOStore();

    utxo.add({ txId: 'tx1', outputIndex: 0, amount: 5000, recipientPubKeyHash: 'abc', blockHeight: 0 });
    utxo.add({ txId: 'tx2', outputIndex: 0, amount: 3000, recipientPubKeyHash: 'def', blockHeight: 0 });

    const snap = mgr.createSnapshot(100, 'block_hash_100', utxo);

    expect(snap.height).toBe(100);
    expect(snap.utxos).toHaveLength(2);
    expect(snap.stateRoot).toBeTruthy();
    expect(snap.sizeBytes).toBeGreaterThan(0);

    const list = mgr.listSnapshots();
    expect(list).toHaveLength(1);
    expect(list[0].height).toBe(100);
  });

  test('sign and verify snapshot', () => {
    const mgr = new SnapshotManager(defaultStorageConfig(NodeRole.PRUNED_VALIDATOR));
    const utxo = new UTXOStore();
    utxo.add({ txId: 'tx1', outputIndex: 0, amount: 1000, recipientPubKeyHash: v.pubKeyHash, blockHeight: 0 });

    mgr.createSnapshot(100, 'hash100', utxo);
    mgr.signSnapshot(100, v.secretKey, v.publicKey);

    const snap = mgr.getSnapshot(100)!;
    expect(snap.signatures).toHaveLength(1);

    const validatorPubs = new Set([v.pubHex]);
    const result = mgr.verifySnapshot(snap, validatorPubs, 1);
    expect(result.valid).toBe(true);
  });

  test('reject snapshot with insufficient signatures', () => {
    const mgr = new SnapshotManager(defaultStorageConfig(NodeRole.PRUNED_VALIDATOR));
    const utxo = new UTXOStore();
    utxo.add({ txId: 'tx1', outputIndex: 0, amount: 1000, recipientPubKeyHash: 'abc', blockHeight: 0 });

    const snap = mgr.createSnapshot(100, 'hash100', utxo);
    // No signatures

    const validatorPubs = new Set([v.pubHex]);
    const result = mgr.verifySnapshot(snap, validatorPubs, 1);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Insufficient signatures');
  });

  test('load snapshot into UTXO store', () => {
    const mgr = new SnapshotManager(defaultStorageConfig(NodeRole.PRUNED_VALIDATOR));
    const sourceUtxo = new UTXOStore();

    sourceUtxo.add({ txId: 'a', outputIndex: 0, amount: 100, recipientPubKeyHash: 'alice', blockHeight: 5 });
    sourceUtxo.add({ txId: 'b', outputIndex: 1, amount: 200, recipientPubKeyHash: 'bob', blockHeight: 7 });

    const snap = mgr.createSnapshot(100, 'h100', sourceUtxo);

    // Load into a fresh UTXO store
    const targetUtxo = new UTXOStore();
    mgr.loadSnapshot(snap, targetUtxo);

    expect(targetUtxo.size).toBe(2);
    expect(targetUtxo.getBalance('alice')).toBe(100);
    expect(targetUtxo.getBalance('bob')).toBe(200);
  });

  test('enforces maxSnapshots limit', () => {
    const config = defaultStorageConfig(NodeRole.PRUNED_VALIDATOR);
    config.maxSnapshots = 2;
    config.snapshotInterval = 10;
    const mgr = new SnapshotManager(config);
    const utxo = new UTXOStore();
    utxo.add({ txId: 'tx1', outputIndex: 0, amount: 100, recipientPubKeyHash: 'a', blockHeight: 0 });

    mgr.createSnapshot(10, 'h10', utxo);
    mgr.createSnapshot(20, 'h20', utxo);
    mgr.createSnapshot(30, 'h30', utxo);

    const list = mgr.listSnapshots();
    expect(list.length).toBeLessThanOrEqual(2);
    // Latest should always be kept
    expect(list.some(s => s.height === 30)).toBe(true);
  });

  test('serialize and deserialize snapshot', () => {
    const mgr = new SnapshotManager(defaultStorageConfig(NodeRole.PRUNED_VALIDATOR));
    const utxo = new UTXOStore();
    utxo.add({ txId: 'tx1', outputIndex: 0, amount: 5000, recipientPubKeyHash: 'abc', blockHeight: 10 });

    mgr.createSnapshot(100, 'hash100', utxo);
    const serialized = mgr.serializeSnapshot(100)!;
    expect(serialized).toBeTruthy();

    const deserialized = SnapshotManager.deserializeSnapshot(serialized);
    expect(deserialized.height).toBe(100);
    expect(deserialized.utxos).toHaveLength(1);
    expect(deserialized.utxos[0].amount).toBe(5000);
  });
});

// ============================================================
// Explorer Indexer Tests
// ============================================================

describe('ExplorerIndexer (32GB VPS)', () => {
  const v = makeValidatorKeyPair();
  let utxo: UTXOStore;
  let indexer: ExplorerIndexer;

  beforeEach(() => {
    utxo = new UTXOStore();
    indexer = new ExplorerIndexer();
  });

  function feedBlocks(count: number): Block[] {
    const blocks: Block[] = [];
    let prevHash = '0'.repeat(64);
    for (let i = 0; i < count; i++) {
      const block = makeTestBlock(i, prevHash, v, utxo);
      // Apply to UTXO to advance state
      for (const tx of block.transactions) utxo.applyTransaction(tx as Transaction, i);
      indexer.indexBlock(block);
      blocks.push(block);
      prevHash = block.hash;
    }
    return blocks;
  }

  test('index blocks and track TX count', () => {
    feedBlocks(10);
    expect(indexer.txCount).toBe(10); // 1 coinbase per block
    expect(indexer.latestHeight).toBe(9);
  });

  test('query TX by ID', () => {
    const blocks = feedBlocks(5);
    const txId = blocks[2].transactions[0].id;
    const indexed = indexer.getTx(txId);

    expect(indexed).toBeDefined();
    expect(indexed!.blockHeight).toBe(2);
    expect(indexed!.type).toBe('coinbase');
  });

  test('query address TX history', () => {
    feedBlocks(10);
    // All coinbase rewards go to v.pubKeyHash
    const txs = indexer.getAddressTxs(v.pubKeyHash);
    expect(txs.length).toBeGreaterThan(0);
  });

  test('address activity tracking', () => {
    feedBlocks(5);
    const activity = indexer.getAddressActivity(v.pubKeyHash);
    expect(activity.length).toBe(5); // 5 incoming coinbase rewards
    expect(activity[0].direction).toBe('in');
  });

  test('block stats', () => {
    feedBlocks(5);
    const stats = indexer.getBlockStats(3);
    expect(stats).toBeDefined();
    expect(stats!.height).toBe(3);
    expect(stats!.proposer).toBe(v.pubHex);
    expect(stats!.txCount).toBe(1);
  });

  test('recent block stats', () => {
    feedBlocks(10);
    const recent = indexer.getRecentBlockStats(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].height).toBe(9); // newest first
  });

  test('validator stats', () => {
    feedBlocks(10);
    const stats = indexer.getValidatorStats(v.pubHex);
    expect(stats).toBeDefined();
    expect(stats!.blocksProposed).toBe(10);
  });

  test('all validator stats with uptime', () => {
    feedBlocks(10);
    const all = indexer.getAllValidatorStats();
    expect(all).toHaveLength(1);
    expect(all[0].uptime).toBeCloseTo(1, 1);
  });

  test('rich list', () => {
    feedBlocks(10);
    const richList = indexer.buildRichList(utxo);
    expect(richList.length).toBeGreaterThan(0);
    expect(richList[0].pubKeyHash).toBe(v.pubKeyHash);
    expect(richList[0].balance).toBe(10000); // 1000 * 10 blocks
  });

  test('supply stats', () => {
    feedBlocks(5);
    const supply = indexer.getSupplyStats(utxo);
    expect(supply.totalMinted).toBe(5000);
    expect(supply.circulatingSupply).toBe(5000);
    expect(supply.utxoCount).toBe(5);
  });

  test('fee stats', () => {
    feedBlocks(10);
    const fees = indexer.getFeeStats();
    expect(fees.blocksAnalyzed).toBe(10);
    expect(fees.totalFees).toBe(0); // coinbase TXs have 0 fee
  });

  test('search TX by prefix', () => {
    const blocks = feedBlocks(5);
    const txId = blocks[0].transactions[0].id;
    const prefix = txId.slice(0, 8);

    const results = indexer.searchTx(prefix);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].txId).toBe(txId);
  });

  test('search address by prefix', () => {
    feedBlocks(5);
    const prefix = v.pubKeyHash.slice(0, 8);
    const results = indexer.searchAddress(prefix);
    expect(results).toContain(v.pubKeyHash);
  });

  test('memory stats', () => {
    feedBlocks(100);
    const mem = indexer.getMemoryStats();
    expect(mem.txIndexSize).toBe(100);
    expect(mem.blockStatsSize).toBe(100);
    expect(mem.estimatedMemoryMB).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================
// RoleAwareNode Tests
// ============================================================

describe('RoleAwareNode', () => {
  const v1 = makeValidatorKeyPair();
  const v2 = makeValidatorKeyPair();
  // Use single validator for block tests so 1 signature suffices (2/3+1 = 1)
  const singleValidator = [v1.pubHex];
  // Both validators for snapshot attestation tests
  const bothValidators = [v1.pubHex, v2.pubHex];

  function makeNode(role: NodeRole, validators: string[] = singleValidator): RoleAwareNode {
    const nodeConfig = defaultNodeConfig(validators);
    const config = createRoleConfig(nodeConfig, role, {
      snapshotInterval: 5,
      pruningWindow: 10,
    });
    return new RoleAwareNode(config);
  }

  function buildGenesisBlock(node: RoleAwareNode): Block {
    const txs = [createCoinbaseTx(v1.pubKeyHash, 100_000_000, 0)];
    for (const tx of txs) node.utxoStore.applyTransaction(tx, 0);
    const confRoot = node.blockchain.getConfidentialUTXOStore().computeStateRoot();
    const stateRoot = sha256(node.utxoStore.computeStateRoot() + '|' + confRoot);
    for (const tx of txs.reverse()) node.utxoStore.revertTransaction(tx, () => undefined);
    txs.reverse();

    return createBlock({
      height: 0,
      previousHash: '0'.repeat(64),
      transactions: txs,
      proposerPubKey: v1.publicKey,
      proposerSecretKey: v1.secretKey,
      stateRoot,
    });
  }

  function buildNextBlock(node: RoleAwareNode): Block {
    const height = node.blockchain.currentHeight + 1;
    const tx = createCoinbaseTx(v1.pubKeyHash, 1000, height);
    node.utxoStore.applyTransaction(tx, height);
    const confRoot = node.blockchain.getConfidentialUTXOStore().computeStateRoot();
    const stateRoot = sha256(node.utxoStore.computeStateRoot() + '|' + confRoot);
    node.utxoStore.revertTransaction(tx, () => undefined);

    return createBlock({
      height,
      previousHash: node.blockchain.latestHash,
      transactions: [tx],
      proposerPubKey: v1.publicKey,
      proposerSecretKey: v1.secretKey,
      stateRoot,
    });
  }

  describe('Pruned Validator (4GB)', () => {
    test('role is set correctly', () => {
      const node = makeNode(NodeRole.PRUNED_VALIDATOR);
      expect(node.role).toBe(NodeRole.PRUNED_VALIDATOR);
    });

    test('validator key accepted', () => {
      const node = makeNode(NodeRole.PRUNED_VALIDATOR);
      expect(() => node.setValidatorKey(v1.secretKey, v1.publicKey)).not.toThrow();
    });

    test('process blocks and auto-prune', () => {
      const node = makeNode(NodeRole.PRUNED_VALIDATOR);
      node.setValidatorKey(v1.secretKey, v1.publicKey);

      // Genesis
      const genesis = buildGenesisBlock(node);
      node.processBlock(genesis);
      expect(node.blockchain.currentHeight).toBe(0);

      // Add 20 blocks (pruningWindow=10, snapshotInterval=5)
      for (let i = 0; i < 20; i++) {
        const block = buildNextBlock(node);
        const err = node.processBlock(block);
        expect(err).toBeNull();
      }

      expect(node.blockchain.currentHeight).toBe(20);

      // Should have pruned old blocks
      const stats = node.blockStore.getStats();
      expect(stats.totalBlocks).toBeLessThanOrEqual(11); // ~10 window
      expect(stats.pruned).toBe(true);
    });

    test('snapshot created at interval', () => {
      const node = makeNode(NodeRole.PRUNED_VALIDATOR);
      node.setValidatorKey(v1.secretKey, v1.publicKey);

      const genesis = buildGenesisBlock(node);
      node.processBlock(genesis);

      for (let i = 0; i < 10; i++) {
        node.processBlock(buildNextBlock(node));
      }

      // snapshotInterval=5, so snapshots at 0, 5, 10
      const snapshots = node.snapshotManager.listSnapshots();
      expect(snapshots.length).toBeGreaterThanOrEqual(2);
    });

    test('no indexer on pruned node', () => {
      const node = makeNode(NodeRole.PRUNED_VALIDATOR);
      expect(node.indexer).toBeNull();
    });

    test('memory estimate within budget', () => {
      const node = makeNode(NodeRole.PRUNED_VALIDATOR);
      const genesis = buildGenesisBlock(node);
      node.processBlock(genesis);

      for (let i = 0; i < 5; i++) {
        node.processBlock(buildNextBlock(node));
      }

      const mem = node.estimateMemoryUsage();
      expect(mem.budgetMB).toBe(MEMORY_BUDGET[NodeRole.PRUNED_VALIDATOR].maxMemoryMB);
      // Small test data should be well within budget
      expect(mem.totalMB).toBeLessThan(mem.budgetMB);
    });
  });

  describe('Archive Node (16GB)', () => {
    test('role is set correctly', () => {
      const node = makeNode(NodeRole.ARCHIVE);
      expect(node.role).toBe(NodeRole.ARCHIVE);
    });

    test('rejects validator key', () => {
      const node = makeNode(NodeRole.ARCHIVE);
      expect(() => node.setValidatorKey(v1.secretKey, v1.publicKey))
        .toThrow('Only pruned_validator');
    });

    test('keeps all blocks (no pruning)', () => {
      const node = makeNode(NodeRole.ARCHIVE);

      const genesis = buildGenesisBlock(node);
      node.processBlock(genesis);

      for (let i = 0; i < 20; i++) {
        node.processBlock(buildNextBlock(node));
      }

      const stats = node.blockStore.getStats();
      expect(stats.totalBlocks).toBe(21); // all kept
      expect(stats.pruned).toBe(false);
      expect(stats.lowestHeight).toBe(0);
    });

    test('no indexer on archive node', () => {
      const node = makeNode(NodeRole.ARCHIVE);
      expect(node.indexer).toBeNull();
    });
  });

  describe('Explorer Node (32GB)', () => {
    test('role is set correctly', () => {
      const node = makeNode(NodeRole.EXPLORER);
      expect(node.role).toBe(NodeRole.EXPLORER);
    });

    test('has indexer', () => {
      const node = makeNode(NodeRole.EXPLORER);
      expect(node.indexer).not.toBeNull();
    });

    test('indexes blocks automatically', () => {
      const node = makeNode(NodeRole.EXPLORER);

      const genesis = buildGenesisBlock(node);
      node.processBlock(genesis);

      for (let i = 0; i < 10; i++) {
        node.processBlock(buildNextBlock(node));
      }

      expect(node.indexer!.txCount).toBe(11); // 11 coinbase TXs
      expect(node.indexer!.latestHeight).toBe(10);
    });

    test('rich list available', () => {
      const node = makeNode(NodeRole.EXPLORER);

      const genesis = buildGenesisBlock(node);
      node.processBlock(genesis);

      for (let i = 0; i < 5; i++) {
        node.processBlock(buildNextBlock(node));
      }

      const richList = node.indexer!.buildRichList(node.utxoStore);
      expect(richList.length).toBeGreaterThan(0);
      expect(richList[0].balance).toBeGreaterThan(0);
    });

    test('validator stats tracked', () => {
      const node = makeNode(NodeRole.EXPLORER);

      const genesis = buildGenesisBlock(node);
      node.processBlock(genesis);

      for (let i = 0; i < 5; i++) {
        node.processBlock(buildNextBlock(node));
      }

      const stats = node.indexer!.getValidatorStats(v1.pubHex);
      expect(stats).toBeDefined();
      expect(stats!.blocksProposed).toBe(6);
    });

    test('keeps all blocks', () => {
      const node = makeNode(NodeRole.EXPLORER);

      const genesis = buildGenesisBlock(node);
      node.processBlock(genesis);

      for (let i = 0; i < 20; i++) {
        node.processBlock(buildNextBlock(node));
      }

      const stats = node.blockStore.getStats();
      expect(stats.totalBlocks).toBe(21);
      expect(stats.pruned).toBe(false);
    });
  });

  describe('Snapshot Bootstrap (pruned node joining)', () => {
    test('bootstrap from snapshot', () => {
      // Source node (archive) builds chain — single validator for block signing
      const archive = makeNode(NodeRole.ARCHIVE);
      const genesis = buildGenesisBlock(archive);
      archive.processBlock(genesis);

      for (let i = 0; i < 10; i++) {
        archive.processBlock(buildNextBlock(archive));
      }

      // Take snapshot and sign with both validators
      const snap = archive.snapshotManager.createSnapshot(
        10, archive.blockchain.latestHash, archive.utxoStore
      );
      archive.snapshotManager.signSnapshot(10, v1.secretKey, v1.publicKey);
      archive.snapshotManager.signSnapshot(10, v2.secretKey, v2.publicKey);

      const signedSnap = archive.snapshotManager.getSnapshot(10)!;

      // New pruned node bootstraps from snapshot (needs both validator sigs)
      const pruned = makeNode(NodeRole.PRUNED_VALIDATOR);
      pruned.setValidatorKey(v1.secretKey, v1.publicKey);

      const result = pruned.bootstrapFromSnapshot(
        signedSnap,
        new Set(bothValidators),
      );

      expect(result.success).toBe(true);
      expect(pruned.blockchain.currentHeight).toBe(10);
      expect(pruned.utxoStore.size).toBe(archive.utxoStore.size);

      // Verify state roots match
      expect(pruned.utxoStore.computeStateRoot())
        .toBe(archive.utxoStore.computeStateRoot());
    });

    test('reject snapshot with bad signatures', () => {
      const archive = makeNode(NodeRole.ARCHIVE);
      const genesis = buildGenesisBlock(archive);
      archive.processBlock(genesis);

      const snap = archive.snapshotManager.createSnapshot(
        0, archive.blockchain.latestHash, archive.utxoStore
      );
      // No signatures — needs 2/3+1 of bothValidators = 2

      const pruned = makeNode(NodeRole.PRUNED_VALIDATOR);
      const result = pruned.bootstrapFromSnapshot(
        snap,
        new Set(bothValidators),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient signatures');
    });
  });

  describe('Node Status', () => {
    test('status shows role and memory budget', () => {
      const node = makeNode(NodeRole.PRUNED_VALIDATOR);
      const genesis = buildGenesisBlock(node);
      node.processBlock(genesis);

      const status = node.getStatus();
      expect(status.role).toBe('pruned_validator');
      expect(status.height).toBe(0);
      expect(status.memoryBudget.maxMemoryMB).toBe(3072);
    });

    test('explorer status includes indexer stats', () => {
      const node = makeNode(NodeRole.EXPLORER);
      const genesis = buildGenesisBlock(node);
      node.processBlock(genesis);

      const status = node.getStatus();
      expect(status.indexerStats).not.toBeNull();
      expect(status.indexerStats.txIndexSize).toBe(1);
    });

    test('available range reflects pruning', () => {
      const node = makeNode(NodeRole.PRUNED_VALIDATOR);
      node.setValidatorKey(v1.secretKey, v1.publicKey);

      const genesis = buildGenesisBlock(node);
      node.processBlock(genesis);
      for (let i = 0; i < 20; i++) {
        node.processBlock(buildNextBlock(node));
      }

      const range = node.getAvailableRange();
      expect(range.highest).toBe(20);
      // Should have pruned some blocks
      expect(range.lowest).toBeGreaterThan(0);
    });
  });
});

// ============================================================
// Memory Budget Tests
// ============================================================

describe('Memory Budget Configuration', () => {
  test('pruned_validator: 4GB budget', () => {
    const budget = MEMORY_BUDGET[NodeRole.PRUNED_VALIDATOR];
    expect(budget.maxMemoryMB).toBe(3072);
    expect(budget.maxBlocks).toBe(1000);
    expect(budget.indexEnabled).toBe(false);
  });

  test('archive: 16GB budget', () => {
    const budget = MEMORY_BUDGET[NodeRole.ARCHIVE];
    expect(budget.maxMemoryMB).toBe(14336);
    expect(budget.maxBlocks).toBe(Infinity);
    expect(budget.indexEnabled).toBe(false);
  });

  test('explorer: 32GB budget', () => {
    const budget = MEMORY_BUDGET[NodeRole.EXPLORER];
    expect(budget.maxMemoryMB).toBe(28672);
    expect(budget.maxBlocks).toBe(Infinity);
    expect(budget.indexEnabled).toBe(true);
  });
});

// ============================================================
// Default Config Tests
// ============================================================

describe('Default Storage Configs', () => {
  test('pruned config', () => {
    const cfg = defaultStorageConfig(NodeRole.PRUNED_VALIDATOR);
    expect(cfg.pruningWindow).toBe(1000);
    expect(cfg.snapshotInterval).toBe(100);
    expect(cfg.maxSnapshots).toBe(3);
  });

  test('archive config', () => {
    const cfg = defaultStorageConfig(NodeRole.ARCHIVE);
    expect(cfg.pruningWindow).toBe(Infinity);
    expect(cfg.snapshotInterval).toBe(1000);
    expect(cfg.maxSnapshots).toBe(10);
  });

  test('explorer config', () => {
    const cfg = defaultStorageConfig(NodeRole.EXPLORER);
    expect(cfg.pruningWindow).toBe(Infinity);
    expect(cfg.snapshotInterval).toBe(1000);
    expect(cfg.maxSnapshots).toBe(10);
  });
});
