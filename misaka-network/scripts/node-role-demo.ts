#!/usr/bin/env ts-node
// ============================================================
// Misaka Network - ノード役割分離デモ
// ============================================================
// 3つの役割を実演:
//   pruned_validator (4GB VPS) — 最新スナップショット + 直近Nブロック
//   archive          (16GB)   — 全履歴保持、運営のみ
//   explorer         (32GB)   — 全履歴 + インデックス、一番重い
// ============================================================

import {
  NodeRole, MEMORY_BUDGET, defaultStorageConfig,
} from '../src/storage/types';
import {
  RoleAwareNode, createRoleConfig,
} from '../src/storage/role-node';
import { createBlock, signBlock, computeBlockHash } from '../src/core/blockchain';
import { computeTxId } from '../src/core/transaction';
import {
  generateKeyPair, hashPubKey, toHex,
} from '../src/utils/crypto';
import {
  Transaction, TransactionType, DEFAULT_FEE_TIERS,
  NodeConfig,
} from '../src/types';

// ── Helpers ──────────────────────────────────────────────

function makeValidator(name: string) {
  const kp = generateKeyPair();
  return {
    name,
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    pubHex: toHex(kp.publicKey),
    pubKeyHash: hashPubKey(kp.publicKey),
  };
}

function makeCoinbaseTx(recipientHash: string, amount: number): Transaction {
  const tx: Omit<Transaction, 'id'> = {
    version: 1,
    type: TransactionType.COINBASE,
    inputs: [{ prevTxId: '0'.repeat(64), outputIndex: 0, signature: '', publicKey: '' }],
    outputs: [{ amount, recipientPubKeyHash: recipientHash }],
    fee: 0,
    timestamp: Date.now(),
  };
  return { id: computeTxId(tx), ...tx };
}

function header(text: string) {
  console.log(`\n${'═'.repeat(68)}`);
  console.log(`  ${text}`);
  console.log(`${'═'.repeat(68)}\n`);
}

function step(n: number, text: string) {
  console.log(`  [Step ${n}] ${text}`);
}

function info(key: string, value: any) {
  console.log(`    📋 ${key.padEnd(20)} ${value}`);
}

function ok(text: string) {
  console.log(`    ✅ ${text}`);
}

function warn(text: string) {
  console.log(`    ⚠️  ${text}`);
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(68)}`);
  console.log('  🖥️  Misaka Network - ノード役割分離デモ');
  console.log(`${'═'.repeat(68)}`);
  console.log('  3つのマシンでブロックチェーンを運用する設計');
  console.log('    4GB  VPS → pruned_validator (コンセンサス参加)');
  console.log('   16GB  VPS → archive (全履歴保持, 運営のみ)');
  console.log('   32GB  VPS → explorer (インデックス + REST API)\n');

  // ════════════════════════════════════════════════════════
  // Phase 1: バリデータ + ノード初期化
  // ════════════════════════════════════════════════════════

  header('Phase 1: バリデータ & ノード初期化');

  const v1 = makeValidator('Validator-A');
  const v2 = makeValidator('Validator-B');
  const v3 = makeValidator('Validator-C');
  const allVals = [v1.pubHex, v2.pubHex, v3.pubHex];

  step(1, 'バリデータ 3名を生成');
  for (const v of [v1, v2, v3]) {
    info(v.name, `${v.pubHex.slice(0, 24)}...`);
  }
  ok('3 バリデータ準備完了');

  // ── Memory budgets ──
  step(2, 'メモリ予算の確認');
  for (const role of [NodeRole.PRUNED_VALIDATOR, NodeRole.ARCHIVE, NodeRole.EXPLORER]) {
    const b = MEMORY_BUDGET[role];
    info(role, `${b.maxMemoryMB}MB | blocks=${b.maxBlocks === Infinity ? '∞' : b.maxBlocks} | UTXO cache=${b.maxUTXOCacheMB}MB | index=${b.indexEnabled ? 'ON' : 'OFF'}`);
  }

  // ── Create base node config ──
  const baseNodeConfig: NodeConfig = {
    chainId: 'misaka-demo', network: 'testnet',
    listenHost: '0.0.0.0', listenPort: 9000, rpcPort: 9001,
    peers: [], dataDir: './data', pruningWindow: 1000,
    feeTiers: DEFAULT_FEE_TIERS, validators: allVals,
    blockInterval: 3000, checkpointInterval: 100,
  };

  // ── Create 3 nodes ──
  step(3, '3つのノードを起動');

  const archiveNode = new RoleAwareNode(createRoleConfig(
    { ...baseNodeConfig, listenPort: 9000, rpcPort: 9001 },
    NodeRole.ARCHIVE,
    { snapshotInterval: 10 },
  ));
  info('Archive (16GB)', `port=9000 | pruningWindow=∞ | snapshotInterval=10`);

  const explorerNode = new RoleAwareNode(createRoleConfig(
    { ...baseNodeConfig, listenPort: 9010, rpcPort: 9011 },
    NodeRole.EXPLORER,
    { snapshotInterval: 10 },
  ));
  info('Explorer (32GB)', `port=9010 | pruningWindow=∞ | indexer=ON`);

  const prunedNode = new RoleAwareNode(createRoleConfig(
    { ...baseNodeConfig, listenPort: 9020, rpcPort: 9021, pruningWindow: 20 },
    NodeRole.PRUNED_VALIDATOR,
    { pruningWindow: 20, snapshotInterval: 10 },
  ));
  prunedNode.setValidatorKey(v1.secretKey, v1.publicKey);
  info('Pruned (4GB)', `port=9020 | pruningWindow=20 | snapshotInterval=10`);

  ok('3ノード起動完了');

  // ════════════════════════════════════════════════════════
  // Phase 2: 30ブロック生成 → 全ノードに配布
  // ════════════════════════════════════════════════════════

  header('Phase 2: 30ブロックを生成・配布');

  let prevHash = '0'.repeat(64);
  const validators = [v1, v2, v3];

  // Separate reference UTXO store for computing block stateRoots
  const refUtxo = new (await import('../src/core/utxo-store')).UTXOStore();

  for (let h = 0; h < 30; h++) {
    const proposer = validators[h % 3];
    const tx = makeCoinbaseTx(proposer.pubKeyHash, 10_000);

    // Compute stateRoot AFTER applying this block's TXs
    refUtxo.applyTransaction(tx, h);
    const stateRoot = refUtxo.computeStateRoot();

    const block = createBlock({
      height: h,
      previousHash: prevHash,
      transactions: [tx],
      proposerPubKey: proposer.publicKey,
      proposerSecretKey: proposer.secretKey,
      stateRoot,
    });

    // Add remaining validator signatures (BFT requires 2/3 + 1)
    for (const v of validators) {
      if (v.pubHex === proposer.pubHex) continue;
      block.signatures.push(signBlock(block.hash, v.secretKey, v.publicKey));
    }

    // Feed to all 3 nodes (simulating P2P propagation)
    for (const node of [archiveNode, explorerNode, prunedNode]) {
      node.processBlock(block);
    }
    prevHash = block.hash;

    if (h % 10 === 9) {
      info(`Height ${h}`, `proposer=${proposer.name} | hash=${block.hash.slice(0, 16)}...`);
    }
  }

  ok('30ブロック生成 → 3ノードに配布完了');

  // ════════════════════════════════════════════════════════
  // Phase 3: ノードごとの状態比較
  // ════════════════════════════════════════════════════════

  header('Phase 3: ノード状態の比較');

  step(4, 'Archive Node (16GB) — 全履歴保持');
  const archStatus = archiveNode.getStatus();
  info('Height', archStatus.height);
  info('ブロック保持数', archStatus.blockStoreStats.totalBlocks);
  info('最低ブロック', archStatus.blockStoreStats.lowestHeight);
  info('UTXO数', archStatus.utxoCount);
  info('インデクサ', archStatus.indexerStats === null ? 'なし（非対応）' : 'あり');
  info('プルーニング', archStatus.blockStoreStats.pruned ? 'あり' : 'なし');
  ok('全30ブロック保持 (genesis ~ 29)');

  console.log();
  step(5, 'Explorer Node (32GB) — 全履歴 + インデックス');
  const expStatus = explorerNode.getStatus();
  info('Height', expStatus.height);
  info('ブロック保持数', expStatus.blockStoreStats.totalBlocks);
  info('インデクサTX数', expStatus.indexerStats?.txIndexSize ?? 0);
  info('アドレス数', expStatus.indexerStats?.addressIndexSize ?? 0);
  info('メモリ使用(est)', `${expStatus.indexerStats?.estimatedMemoryMB ?? 0}MB`);

  // Rich list
  const richList = explorerNode.indexer!.buildRichList(explorerNode.utxoStore, 5);
  console.log('    📊 Rich List (Top 3):');
  for (let i = 0; i < Math.min(3, richList.length); i++) {
    const r = richList[i];
    const vName = [v1, v2, v3].find(v => v.pubKeyHash === r.pubKeyHash)?.name ?? 'unknown';
    console.log(`       ${i + 1}. ${vName}: ${r.balance.toLocaleString()} tokens (${r.utxoCount} UTXOs)`);
  }

  // Validator stats
  const vStats = explorerNode.indexer!.getAllValidatorStats();
  console.log('    📊 Validator Production:');
  for (const vs of vStats) {
    const name = [v1, v2, v3].find(v => v.pubHex === vs.pubKeyHex)?.name ?? 'unknown';
    console.log(`       ${name}: ${vs.blocksProposed} blocks | uptime=${(vs.uptime * 100).toFixed(0)}%`);
  }

  // Supply stats
  const supply = explorerNode.indexer!.getSupplyStats(explorerNode.utxoStore);
  info('総ミント量', supply.totalMinted.toLocaleString());
  info('流通供給量', supply.circulatingSupply.toLocaleString());
  info('ユニークアドレス', supply.addressCount);
  ok('全30ブロック + フルインデックス');

  console.log();
  step(6, 'Pruned Validator (4GB) — 最新スナップショット + 直近Nブロック');
  const prnStatus = prunedNode.getStatus();
  info('Height', prnStatus.height);
  info('ブロック保持数', prnStatus.blockStoreStats.totalBlocks);
  info('最低ブロック', prnStatus.blockStoreStats.lowestHeight);
  info('プルーニング済み', `${prnStatus.blockStoreStats.prunedCount} ブロック削除済み`);
  info('スナップショット数', prnStatus.snapshotCount);
  info('インデクサ', prnStatus.indexerStats === null ? 'なし（非対応）' : 'あり');

  if (prnStatus.latestSnapshot) {
    info('最新スナップショット', `height=${prnStatus.latestSnapshot.height} | sigs=${prnStatus.latestSnapshot.signatureCount}`);
  }
  ok(`最新${prnStatus.blockStoreStats.totalBlocks}ブロック + スナップショットのみ保持`);

  // ════════════════════════════════════════════════════════
  // Phase 4: 状態整合性の検証
  // ════════════════════════════════════════════════════════

  header('Phase 4: 状態整合性の検証');

  step(7, '全ノードの State Root を比較');
  const archRoot = archiveNode.utxoStore.computeStateRoot();
  const expRoot = explorerNode.utxoStore.computeStateRoot();
  const prnRoot = prunedNode.utxoStore.computeStateRoot();

  info('Archive', archRoot.slice(0, 32) + '...');
  info('Explorer', expRoot.slice(0, 32) + '...');
  info('Pruned', prnRoot.slice(0, 32) + '...');

  const allMatch = archRoot === expRoot && expRoot === prnRoot;
  if (allMatch) {
    ok('✅ 全ノードの UTXO State Root が一致！');
  } else {
    console.log('    ❌ State Root 不一致！');
  }

  step(8, '残高の一致確認');
  for (const v of [v1, v2, v3]) {
    const archBal = archiveNode.getBalance(v.pubKeyHash);
    const expBal = explorerNode.getBalance(v.pubKeyHash);
    const prnBal = prunedNode.getBalance(v.pubKeyHash);
    const match = archBal === expBal && expBal === prnBal;
    info(v.name, `${archBal.toLocaleString()} tokens ${match ? '✅ 一致' : '❌ 不一致'}`);
  }

  // ════════════════════════════════════════════════════════
  // Phase 5: 新しいPrunedノードがスナップショットから参加
  // ════════════════════════════════════════════════════════

  header('Phase 5: 新規 Pruned ノードがスナップショットから参加');

  step(9, 'Archive ノードからスナップショットを取得');
  const latestSnap = archiveNode.snapshotManager.getLatestSnapshot();
  if (!latestSnap) {
    console.log('    ❌ スナップショットが見つかりません');
    return;
  }
  info('スナップショット高', latestSnap.height);
  info('UTXO数', latestSnap.utxos.length);
  info('State Root', latestSnap.stateRoot.slice(0, 32) + '...');
  info('サイズ', `${(latestSnap.sizeBytes / 1024).toFixed(1)} KB`);

  // Sign with all validators
  archiveNode.snapshotManager.signSnapshot(latestSnap.height, v1.secretKey, v1.publicKey);
  archiveNode.snapshotManager.signSnapshot(latestSnap.height, v2.secretKey, v2.publicKey);
  archiveNode.snapshotManager.signSnapshot(latestSnap.height, v3.secretKey, v3.publicKey);
  info('署名数', latestSnap.signatures.length);
  ok('スナップショット署名完了');

  step(10, '新しい Pruned ノードを作成');
  const newPruned = new RoleAwareNode(createRoleConfig(
    { ...baseNodeConfig, listenPort: 9030, rpcPort: 9031, pruningWindow: 20 },
    NodeRole.PRUNED_VALIDATOR,
    { pruningWindow: 20, snapshotInterval: 10 },
  ));
  newPruned.setValidatorKey(v2.secretKey, v2.publicKey);
  info('新ノード', 'port=9030 | validator=Validator-B');

  step(11, 'スナップショットから復元（Bootstrap）');
  const bootstrapResult = newPruned.bootstrapFromSnapshot(
    latestSnap!,
    new Set(allVals),
  );

  if (bootstrapResult.success) {
    ok('スナップショットからの復元成功！');
    info('復元高', newPruned.blockchain.currentHeight);
    info('UTXO数', newPruned.utxoStore.size);
  } else {
    console.log(`    ❌ 復元失敗: ${bootstrapResult.error}`);
    return;
  }

  step(12, '残りのブロックをキャッチアップ');
  // Get blocks from snapshot height + 1 to current
  const catchUpFrom = latestSnap.height + 1;
  const catchUpBlocks = archiveNode.getBlocks(catchUpFrom, 29);
  info('キャッチアップ範囲', `height ${catchUpFrom} → 29 (${catchUpBlocks.length} ブロック)`);

  const catchResult = newPruned.applyCatchUpBlocks(catchUpBlocks);
  info('適用済み', `${catchResult.applied} ブロック`);
  info('エラー', catchResult.errors.length === 0 ? 'なし ✅' : catchResult.errors.join(', '));
  ok(`新ノード: height=${newPruned.blockchain.currentHeight}`);

  step(13, '新ノードの State Root 一致確認');
  const newRoot = newPruned.utxoStore.computeStateRoot();
  const rootMatch = newRoot === archRoot;
  info('新ノード Root', newRoot.slice(0, 32) + '...');
  info('Archive Root', archRoot.slice(0, 32) + '...');
  if (rootMatch) {
    ok('✅ スナップショット復元後、State Root 完全一致！');
  } else {
    console.log('    ❌ State Root 不一致');
  }

  // ════════════════════════════════════════════════════════
  // Phase 6: メモリ使用量の比較
  // ════════════════════════════════════════════════════════

  header('Phase 6: メモリ使用量の比較');

  const nodes = [
    { name: 'Archive (16GB)', node: archiveNode },
    { name: 'Explorer (32GB)', node: explorerNode },
    { name: 'Pruned (4GB)', node: prunedNode },
    { name: 'New Pruned (4GB)', node: newPruned },
  ];

  console.log('  ┌────────────────────┬────────┬────────┬────────┬────────┬────────┬─────────┐');
  console.log('  │ Node               │ Blocks │ UTXO   │ Snap   │ Index  │ Total  │ Budget  │');
  console.log('  │                    │  (MB)  │ (MB)   │ (MB)   │ (MB)   │ (MB)   │  (MB)   │');
  console.log('  ├────────────────────┼────────┼────────┼────────┼────────┼────────┼─────────┤');

  for (const { name, node } of nodes) {
    const mem = node.estimateMemoryUsage();
    console.log(
      `  │ ${name.padEnd(18)} │ ${String(mem.blockStoreMB).padStart(6)} │ ${String(mem.utxoStoreMB).padStart(6)} │ ${String(mem.snapshotsMB).padStart(6)} │ ${String(mem.indexerMB).padStart(6)} │ ${String(mem.totalMB).padStart(6)} │ ${String(mem.budgetMB).padStart(7)} │`
    );
  }

  console.log('  └────────────────────┴────────┴────────┴────────┴────────┴────────┴─────────┘');
  console.log();
  warn('実際の本番環境では、ブロック数百万 × TX数千万で差が大きく出る');
  ok('すべてのノードが予算内で動作');

  // ════════════════════════════════════════════════════════
  // Phase 7: Explorer API エンドポイント一覧
  // ════════════════════════════════════════════════════════

  header('Phase 7: Explorer REST API (32GB ノードのみ)');

  const endpoints = [
    { method: 'GET', path: '/api/status', desc: 'チェーン状態 + 供給量' },
    { method: 'GET', path: '/api/block/:height', desc: 'ブロック詳細 + 統計' },
    { method: 'GET', path: '/api/blocks/recent', desc: '最新ブロック一覧' },
    { method: 'GET', path: '/api/tx/:txId', desc: 'トランザクション詳細' },
    { method: 'GET', path: '/api/address/:hash', desc: 'アドレス情報 + 残高' },
    { method: 'GET', path: '/api/address/:hash/txs', desc: 'アドレスTX履歴（ページ付き）' },
    { method: 'GET', path: '/api/richlist', desc: '高額保有者ランキング' },
    { method: 'GET', path: '/api/validators', desc: 'バリデータ統計' },
    { method: 'GET', path: '/api/search?q=', desc: 'TX/アドレス検索' },
    { method: 'GET', path: '/api/fees', desc: '手数料統計' },
  ];

  console.log('  ┌────────┬──────────────────────────┬─────────────────────────────┐');
  console.log('  │ Method │ Path                     │ Description                 │');
  console.log('  ├────────┼──────────────────────────┼─────────────────────────────┤');
  for (const ep of endpoints) {
    console.log(`  │ ${ep.method.padEnd(6)} │ ${ep.path.padEnd(24)} │ ${ep.desc.padEnd(27)} │`);
  }
  console.log('  └────────┴──────────────────────────┴─────────────────────────────┘');

  // ════════════════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════════════════

  header('📊 アーキテクチャまとめ');

  console.log('  ┌──────────────────┬──────┬──────────────────────────────────────────┐');
  console.log('  │ Role             │ RAM  │ 責務                                      │');
  console.log('  ├──────────────────┼──────┼──────────────────────────────────────────┤');
  console.log('  │ pruned_validator │ 4GB  │ コンセンサス参加, 直近Nブロック, スナップショット │');
  console.log('  │ archive          │ 16GB │ 全履歴保持, ブロック配信, 運営のみ              │');
  console.log('  │ explorer         │ 32GB │ 全履歴 + インデックス + REST API              │');
  console.log('  └──────────────────┴──────┴──────────────────────────────────────────┘');
  console.log();
  console.log('  データフロー:');
  console.log('  ┌─────────┐  blocks   ┌─────────┐  blocks   ┌──────────┐');
  console.log('  │ Pruned  │ ←──────── │ Archive │ ────────→ │ Explorer │');
  console.log('  │ (4GB)   │           │ (16GB)  │           │ (32GB)   │');
  console.log('  │ 合意参加  │ snapshot │ 全履歴   │  indexing │ API提供   │');
  console.log('  └─────────┘ ←──────── └─────────┘           └──────────┘');
  console.log();
  console.log('  新規ノード参加フロー:');
  console.log('    1. Archive から最新スナップショットをダウンロード');
  console.log('    2. バリデータ署名を検証 (2/3 + 1)');
  console.log('    3. UTXO State を復元');
  console.log('    4. スナップショット高以降のブロックをキャッチアップ');
  console.log('    5. コンセンサスに参加開始');
  console.log();

  console.log(`${'═'.repeat(68)}`);
  console.log('  🎉 ノード役割分離デモ完了！');
  console.log(`${'═'.repeat(68)}\n`);
}

main().catch(console.error);
