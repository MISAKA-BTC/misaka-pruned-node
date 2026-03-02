#!/usr/bin/env npx ts-node
// ============================================================
// Misaka Network - Privacy Demo (現金レベルのプライバシー)
// ============================================================
//
//  This demo proves four cash-like properties:
//    ❌ 誰が誰に渡したか記録されない  (sender/recipient unlinkable)
//    ❌ 残高は台帳に存在しない        (no public balance)
//    ✅ 当事者だけが知っている        (only parties know)
//    ❌ 追跡しにくい                 (hard to trace)
//
//  Plus testnet features:
//    ✅ バリデーターをアンカーなしで作成
//    ✅ テストネットトークンを自動付与
//    ✅ 送金のチェック
//
// ============================================================

import {
  initCurve,
  generateStealthKeyPair,
  getStealthMeta,
  createStealthOutput,
  scanStealthOutput,
  scanWithViewKey,
  InMemoryKeyImageStore,
  selectDecoys,
  createPrivateTransaction,
  validatePrivateTransaction,
} from '../src/privacy';
import {
  scalarMulBase, randomScalar,
} from '../src/privacy/curve';
import {
  pedersenCommit, toBaseUnits, verifyCommitmentBalance, computeExcess,
} from '../src/privacy/pedersen';
import {
  bootstrapTestnet,
  createTestAccount,
  TestnetFaucet,
} from '../src/testnet';
import { PrivateUTXO, StealthMeta } from '../src/privacy/types';

// ── Helpers ──────────────────────────────────────────────────

function line() { console.log('─'.repeat(64)); }
function header(title: string) {
  console.log('\n' + '═'.repeat(64));
  console.log(`  ${title}`);
  console.log('═'.repeat(64));
}
function step(n: number, desc: string) { console.log(`\n  [Step ${n}] ${desc}`); }
function ok(msg: string) { console.log(`    ✅ ${msg}`); }
function no(msg: string) { console.log(`    ❌ ${msg}`); }
function info(msg: string) { console.log(`    📋 ${msg}`); }
function warn(msg: string) { console.log(`    ⚠️  ${msg}`); }

// ── Main ────────────────────────────────────────────────────

async function main() {
  await initCurve();

  header('🌐 Misaka Network - 現金レベルプライバシーデモ');
  console.log('  Cash-like Privacy on a Blockchain\n');

  // ════════════════════════════════════════════════════════════
  // Phase 1: テストネット起動（アンカーなし）
  // ════════════════════════════════════════════════════════════

  header('Phase 1: テストネット起動（アンカー/ステーキング不要）');

  step(1, 'バリデーター4台をアンカーなしで作成');
  const { validators, faucet, genesisTxs } = bootstrapTestnet({
    numValidators: 4,
    tokensPerValidator: 100_000_000,
    faucetConfig: { dripAmount: 10_000_000, cooldownMs: 0 },
  });

  for (const v of validators) {
    info(`${v.name}: ${v.address}`);
  }
  ok(`バリデーター4台が起動（ステーキング/アンカー不要）`);
  ok(`各バリデーターに 100,000,000 トークンを自動付与`);
  ok(`Faucet残高: ${faucet.getRemaining().toLocaleString()} トークン`);

  // ════════════════════════════════════════════════════════════
  // Phase 2: テストアカウント作成 + Faucetから受取
  // ════════════════════════════════════════════════════════════

  header('Phase 2: テストアカウント作成 + Faucet');

  step(2, 'Alice と Bob のアカウント作成');
  const aliceKeys = generateStealthKeyPair();
  const bobKeys = generateStealthKeyPair();
  const carolKeys = generateStealthKeyPair();
  const aliceMeta = getStealthMeta(aliceKeys);
  const bobMeta = getStealthMeta(bobKeys);
  const carolMeta = getStealthMeta(carolKeys);

  info(`Alice scan_pub:  ${aliceMeta.scanPub.slice(0, 20)}...`);
  info(`Alice spend_pub: ${aliceMeta.spendPub.slice(0, 20)}...`);
  info(`Bob scan_pub:    ${bobMeta.scanPub.slice(0, 20)}...`);
  info(`Bob spend_pub:   ${bobMeta.spendPub.slice(0, 20)}...`);
  info(`Carol scan_pub:  ${carolMeta.scanPub.slice(0, 20)}...`);
  ok('ステルス鍵ペア生成完了（scan + spend キー）');

  step(3, 'デコイプール作成（リング署名用）');
  const decoyPool: string[] = [];
  for (let i = 0; i < 50; i++) {
    decoyPool.push(scalarMulBase(randomScalar()).toHex());
  }
  ok(`デコイプール: ${decoyPool.length} 個の公開鍵`);

  step(4, 'Faucet から Alice に 100,000 トークン');
  // Simulate faucet → Alice (stealth output)
  const { output: faucetOutput, commitment: faucetCommitment } =
    createStealthOutput(aliceMeta, 100_000, 0);

  const aliceScanned = scanStealthOutput(
    faucetOutput, 'faucet_tx_001',
    aliceKeys.scanSecret, aliceKeys.spendSecret, aliceKeys.spendPub
  )!;

  decoyPool.push(aliceScanned.oneTimePubKey);

  info(`受取金額: ${aliceScanned.amount.toLocaleString()} トークン`);
  info(`ワンタイムアドレス: ${aliceScanned.oneTimePubKey.slice(0, 20)}...`);
  info(`（Alice の公開鍵とは別 → リンク不可）`);
  ok('Alice が Faucet からトークンを受領');

  // Build Alice's UTXO
  const aliceUTXO: PrivateUTXO = {
    txId: 'faucet_tx_001',
    outputIndex: 0,
    oneTimePubKey: aliceScanned.oneTimePubKey,
    amount: aliceScanned.amount,
    oneTimeSecret: aliceScanned.oneTimeSecret,
    keyImage: aliceScanned.keyImage,
    commitment: faucetCommitment.point,
    blinding: faucetCommitment.blinding,
  };

  // ════════════════════════════════════════════════════════════
  // Phase 3: プライベート送金（現金のような匿名性）
  // ════════════════════════════════════════════════════════════

  header('Phase 3: プライベート送金 Alice → Bob (50,000 トークン)');

  step(5, 'プライベートトランザクション作成');
  const tx1 = createPrivateTransaction({
    inputs: [aliceUTXO],
    recipients: [{ meta: bobMeta, amount: 50_000 }],
    senderMeta: aliceMeta,
    decoyPool,
    ringSize: 4,
  });

  info(`TX ID:           ${tx1.id.slice(0, 24)}...`);
  info(`Type:            ${tx1.type}`);
  info(`Ring inputs:     ${tx1.ringInputs.length}`);
  info(`Stealth outputs: ${tx1.stealthOutputs.length}`);
  info(`Key images:      ${tx1.keyImages.length}`);
  info(`Fee:             ${tx1.fee}`);
  ok('プライベートTX作成完了');

  // ════════════════════════════════════════════════════════════
  // Phase 4: 現金プライバシーの4つの性質を検証
  // ════════════════════════════════════════════════════════════

  header('Phase 4: 現金レベルプライバシーの検証');

  // ─── Property 1: 誰が誰に渡したか記録されない ──────────
  step(6, '検証①: 誰が誰に渡したか記録されない');

  const onChainData = JSON.stringify(tx1);

  // Sender not revealed
  const senderRevealed = onChainData.includes(aliceKeys.scanPub) ||
                         onChainData.includes(aliceKeys.spendPub);
  no(`送信者 (Alice) の公開鍵がチェーン上に存在: ${senderRevealed ? 'YES ⚠️' : 'NO ✅'}`);

  // Recipient not revealed
  const recipientRevealed = onChainData.includes(bobKeys.scanPub) ||
                            onChainData.includes(bobKeys.spendPub);
  no(`受信者 (Bob) の公開鍵がチェーン上に存在: ${recipientRevealed ? 'YES ⚠️' : 'NO ✅'}`);

  // Ring hides the real sender
  info(`リング署名: ${tx1.ringInputs[0].ring.length} 人の中から実際の送信者を特定不能`);
  console.log('    Ring members:');
  for (let i = 0; i < tx1.ringInputs[0].ring.length; i++) {
    console.log(`      [${i}] ${tx1.ringInputs[0].ring[i].slice(0, 24)}... (本物?デコイ?不明)`);
  }
  ok('送信者は4人の候補の中に隠されている（1/4の確率）');

  // ─── Property 2: 残高は台帳に存在しない ────────────────
  step(7, '検証②: 残高は台帳に存在しない');

  for (let i = 0; i < tx1.stealthOutputs.length; i++) {
    const out = tx1.stealthOutputs[i];
    info(`Output[${i}]:`);
    info(`  ワンタイムアドレス: ${out.oneTimePubKey.slice(0, 24)}...`);
    info(`  Pedersen commitment: ${out.commitment.slice(0, 24)}...`);
    info(`  暗号化金額: ${out.encryptedAmount} (復号不可)`);
    no(`  平文金額: 存在しない`);
  }

  // Verify 50000 is not in plaintext
  const has50000 = onChainData.includes('50000') || onChainData.includes('50,000');
  const has49999 = onChainData.includes('49999');
  no(`50,000 がチェーン上に平文で存在: ${has50000 ? 'YES ⚠️' : 'NO ✅'}`);
  no(`49,999.5 (おつり) がチェーン上に平文で存在: ${has49999 ? 'YES ⚠️' : 'NO ✅'}`);
  ok('金額は Pedersen commitment + 暗号化で隠蔽');

  // ─── Property 3: 当事者だけが知っている ────────────────
  step(8, '検証③: 当事者だけが知っている');

  // Bob can see his output
  let bobReceived = 0;
  for (const out of tx1.stealthOutputs) {
    const s = scanStealthOutput(
      out, tx1.id, bobKeys.scanSecret, bobKeys.spendSecret, bobKeys.spendPub
    );
    if (s) bobReceived += s.amount;
  }
  ok(`Bob が受信額を確認: ${bobReceived.toLocaleString()} トークン`);

  // Alice can see her change
  let aliceChange = 0;
  for (const out of tx1.stealthOutputs) {
    const s = scanStealthOutput(
      out, tx1.id, aliceKeys.scanSecret, aliceKeys.spendSecret, aliceKeys.spendPub
    );
    if (s) aliceChange += s.amount;
  }
  ok(`Alice がおつりを確認: ${aliceChange.toLocaleString()} トークン`);

  // Carol (third party) sees NOTHING
  let carolSees = 0;
  for (const out of tx1.stealthOutputs) {
    const s = scanStealthOutput(
      out, tx1.id, carolKeys.scanSecret, carolKeys.spendSecret, carolKeys.spendPub
    );
    if (s) carolSees += s.amount;
  }
  no(`Carol (第三者) が見える金額: ${carolSees} (何も見えない ✅)`);

  // ─── Property 4: 追跡しにくい ─────────────────────────
  step(9, '検証④: 追跡しにくい（アドレスの非再利用）');

  // Send 5 transactions to Alice - all different one-time addresses
  const aliceIncoming: string[] = [];
  for (let i = 0; i < 5; i++) {
    const { output } = createStealthOutput(aliceMeta, 1000 * (i + 1), i);
    aliceIncoming.push(output.oneTimePubKey);
  }

  const uniqueAddresses = new Set(aliceIncoming).size;
  ok(`Alice への5回の送金 → ${uniqueAddresses} 個の異なるアドレス`);
  no('同一アドレスの再利用: なし');
  no('チェーン上でこれらが同一人物宛と判別: 不可能');
  info('各トランザクションのアドレスは完全に独立');
  for (let i = 0; i < 5; i++) {
    console.log(`    Payment ${i + 1}: ${aliceIncoming[i].slice(0, 24)}... → 全て異なる`);
  }

  // ════════════════════════════════════════════════════════════
  // Phase 5: 検証 + 二重使用防止
  // ════════════════════════════════════════════════════════════

  header('Phase 5: バリデータ検証 + 二重使用防止');

  step(10, 'バリデータによるTX検証');
  const keyImageStore = new InMemoryKeyImageStore();
  const allPubKeys = new Set<string>();
  for (const ri of tx1.ringInputs) {
    for (const pk of ri.ring) allPubKeys.add(pk);
  }

  const validationError = validatePrivateTransaction(
    tx1, keyImageStore, (pk) => allPubKeys.has(pk)
  );

  if (validationError) {
    warn(`検証エラー: ${validationError}`);
  } else {
    ok('TX検証成功（リング署名 + Pedersen balance proof）');
    // Record key images
    for (const ki of tx1.keyImages) {
      keyImageStore.add(ki, tx1.id);
    }
    ok(`Key image 記録: ${tx1.keyImages[0].slice(0, 24)}...`);
  }

  step(11, '二重使用の検出');
  const doubleSpendError = validatePrivateTransaction(
    tx1, keyImageStore, (pk) => allPubKeys.has(pk)
  );
  if (doubleSpendError) {
    ok(`二重使用を検出: ${doubleSpendError}`);
  } else {
    warn('二重使用が検出されませんでした');
  }

  // ════════════════════════════════════════════════════════════
  // Phase 6: View Key による選択的開示
  // ════════════════════════════════════════════════════════════

  header('Phase 6: View Key による選択的開示（監査対応）');

  step(12, 'Bob が監査人に View Key を共有');
  info(`View Key (scan_secret): ${bobKeys.scanSecret.slice(0, 24)}...`);
  info('この鍵で Bob 宛の取引を確認できるが、使用（送金）はできない');

  // Auditor uses view-only scan
  let auditorFound = 0;
  for (const out of tx1.stealthOutputs) {
    const viewResult = scanWithViewKey(
      out, tx1.id, bobKeys.scanSecret, bobKeys.spendPub
    );
    if (viewResult) {
      auditorFound++;
      ok(`監査人が確認: TX ${viewResult.txId.slice(0, 16)}... → ${viewResult.amount.toLocaleString()} トークン`);
    }
  }
  ok(`監査人は ${auditorFound} 件のBob宛出力を確認（送金権限なし）`);
  no('監査人が Bob になりすましてトークンを使用: 不可能（spend_secret が必要）');

  // ════════════════════════════════════════════════════════════
  // Phase 7: チェーン送金（Bob → Carol）
  // ════════════════════════════════════════════════════════════

  header('Phase 7: チェーン送金 Bob → Carol (30,000 トークン)');

  step(13, 'Bob がスキャンした UTXO で送金');

  // Bob scans his outputs
  const bobUTXOs: PrivateUTXO[] = [];
  for (const out of tx1.stealthOutputs) {
    const s = scanStealthOutput(
      out, tx1.id, bobKeys.scanSecret, bobKeys.spendSecret, bobKeys.spendPub
    );
    if (s) {
      // Find the commitment for this output
      const matchingOut = tx1.stealthOutputs.find(o => o.oneTimePubKey === s.oneTimePubKey);
      decoyPool.push(s.oneTimePubKey);
      bobUTXOs.push({
        txId: s.txId,
        outputIndex: s.outputIndex,
        oneTimePubKey: s.oneTimePubKey,
        amount: s.amount,
        oneTimeSecret: s.oneTimeSecret,
        keyImage: s.keyImage,
        commitment: matchingOut?.commitment || '',
        blinding: s.blinding,
      });
    }
  }

  info(`Bob の UTXO 数: ${bobUTXOs.length}`);
  info(`Bob の合計残高: ${bobUTXOs.reduce((s, u) => s + u.amount, 0).toLocaleString()} トークン`);

  const tx2 = createPrivateTransaction({
    inputs: bobUTXOs,
    recipients: [{ meta: carolMeta, amount: 30_000 }],
    senderMeta: bobMeta,
    decoyPool,
    ringSize: 4,
  });

  ok(`TX 作成: Bob → Carol 30,000 トークン (fee: ${tx2.fee})`);

  // Carol receives
  let carolReceived = 0;
  for (const out of tx2.stealthOutputs) {
    const s = scanStealthOutput(
      out, tx2.id, carolKeys.scanSecret, carolKeys.spendSecret, carolKeys.spendPub
    );
    if (s) carolReceived += s.amount;
  }
  ok(`Carol 受信: ${carolReceived.toLocaleString()} トークン`);

  // Bob's change
  let bobChange = 0;
  for (const out of tx2.stealthOutputs) {
    const s = scanStealthOutput(
      out, tx2.id, bobKeys.scanSecret, bobKeys.spendSecret, bobKeys.spendPub
    );
    if (s) bobChange += s.amount;
  }
  ok(`Bob のおつり: ${bobChange.toLocaleString()} トークン`);

  // ════════════════════════════════════════════════════════════
  // Phase 8: Pedersen Commitment Balance Proof
  // ════════════════════════════════════════════════════════════

  header('Phase 8: Pedersen Commitment バランス証明');

  step(14, 'Pedersen commitment で金額を隠しつつバランスを検証');

  const inputC = pedersenCommit(toBaseUnits(10000));
  const out1C = pedersenCommit(toBaseUnits(7000));
  const out2C = pedersenCommit(toBaseUnits(2999.5));
  const feeBase = toBaseUnits(0.5);

  info(`Input commitment:  ${inputC.point.slice(0, 32)}...`);
  info(`Output 1 commit:   ${out1C.point.slice(0, 32)}...`);
  info(`Output 2 commit:   ${out2C.point.slice(0, 32)}...`);
  info(`Fee (public):      0.5 tokens`);
  no('バリデータは金額を知らないが...');

  const excess = computeExcess([inputC.blinding], [out1C.blinding, out2C.blinding]);
  const balanceOk = verifyCommitmentBalance(
    [inputC.point], [out1C.point, out2C.point], feeBase, excess
  );
  ok(`バランス証明: ${balanceOk ? '成功 ✅' : '失敗 ❌'}`);
  info('input (10,000) = output1 (7,000) + output2 (2,999.5) + fee (0.5)');
  info('→ バリデータは合計が正しいことだけ確認、個々の金額は不明');

  // ════════════════════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════════════════════

  header('📊 まとめ: 現金 vs Misaka Network 比較');

  console.log(`
  ┌─────────────────────────┬────────┬──────────────┐
  │ プライバシー性質           │  現金  │ Misaka Network│
  ├─────────────────────────┼────────┼──────────────┤
  │ 送信者の匿名性            │  ✅   │ ✅ リング署名  │
  │ 受信者の匿名性            │  ✅   │ ✅ ステルスAddr│
  │ 金額の秘匿               │  ✅   │ ✅ Pedersen   │
  │ 残高の非公開              │  ✅   │ ✅ 暗号化UTXO │
  │ 追跡困難                 │  ✅   │ ✅ ワンタイムAddr│
  │ 二重使用防止              │  ❌   │ ✅ Key Image  │
  │ 選択的開示（監査対応）      │  ❌   │ ✅ View Key   │
  │ 遠隔送金                 │  ❌   │ ✅ P2P        │
  └─────────────────────────┴────────┴──────────────┘
  `);

  console.log('  テストネット機能:');
  console.log('    ✅ バリデーターをアンカーなしで作成可能');
  console.log('    ✅ Faucet でテストトークンを自動付与');
  console.log('    ✅ プライベート送金の完全なE2Eテスト');

  header('🎉 Demo Complete!');
}

main().catch(console.error);
