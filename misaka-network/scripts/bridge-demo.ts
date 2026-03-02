#!/usr/bin/env npx ts-node
// ============================================================
// Misaka Network - ZK Bridge Demo (Solana ↔ Misaka)
// ============================================================
//
//  Full bridge flow:
//    DEPOSIT:  Solana Lock → ZK Proof → Misaka Mint
//    WITHDRAW: Misaka Burn → ZK Proof → Solana Unlock
//
//  Components demonstrated:
//    1. Solana Bridge Program (simulator)
//    2. ZK Proof Generation (Schnorr-Pedersen)
//    3. Misaka Verifier (proof validation)
//    4. Relayer Service (off-chain relay)
//    5. Reverse flow (Misaka → Solana)
//
//  Priority: Bridge correctness > Privacy
//    - Amounts are public during bridge operations
//    - Stealth addresses protect recipient identity on Misaka
//    - After deposit, user can do private transfers
//
// ============================================================

import { initCurve } from '../src/privacy/curve';
import { SolanaBridgeProgram } from '../src/bridge/solana/program';
import { MisakaBridgeHandler } from '../src/bridge/misaka/handler';
import { BridgeRelayer, RelayerEvent } from '../src/bridge/relayer/service';
import { generateVerificationKey, proveDeposit, proveWithdraw } from '../src/bridge/zk/prover';
import { verifyBridgeProof } from '../src/bridge/zk/verifier';
import { pedersenCommit, toBaseUnits } from '../src/privacy/pedersen';
import {
  computeLockEventHash, hashProgramId, hashRecipient,
} from '../src/bridge/zk/circuit';
import {
  BridgeToken, BridgeDirection, BridgeStatus,
  DepositTxData, WithdrawTxData,
  defaultBridgeConfig,
} from '../src/bridge/types';
import {
  generateStealthKeyPair, getStealthMeta, createStealthOutput, scanStealthOutput,
} from '../src/privacy/stealth';
import { createPrivateTransaction, InMemoryKeyImageStore, selectDecoys } from '../src/privacy/transaction';
import { scalarMulBase, randomScalar } from '../src/privacy/curve';
import { hashPubKey, toHex } from '../src/utils/crypto';
import { bootstrapTestnet } from '../src/testnet';
import nacl from 'tweetnacl';

// ── Helpers ──────────────────────────────────────────────

function header(title: string) {
  console.log('\n' + '═'.repeat(68));
  console.log(`  ${title}`);
  console.log('═'.repeat(68));
}
function step(n: number, desc: string) { console.log(`\n  [Step ${n}] ${desc}`); }
function ok(msg: string) { console.log(`    ✅ ${msg}`); }
function no(msg: string) { console.log(`    ❌ ${msg}`); }
function info(msg: string) { console.log(`    📋 ${msg}`); }
function warn(msg: string) { console.log(`    ⚠️  ${msg}`); }
function money(msg: string) { console.log(`    💰 ${msg}`); }

// ── Main ────────────────────────────────────────────────

async function main() {
  await initCurve();

  header('🌉 Misaka Network - ZK Bridge Demo (Solana ↔ Misaka)');
  console.log('  Zero-Knowledge Bridge between Solana and Misaka Network\n');

  // ════════════════════════════════════════════════════════════
  // Phase 1: Setup
  // ════════════════════════════════════════════════════════════

  header('Phase 1: ブリッジインフラ初期化');

  step(1, 'Verification Key 生成（Trusted Setup）');
  const vk = generateVerificationKey();
  info(`VK version:  ${vk.version}`);
  info(`VK alpha:    ${vk.alpha.slice(0, 24)}...`);
  info(`VK gamma:    ${vk.gamma.length} public input generators`);
  ok('Verification Key 生成完了');

  step(2, 'Solana Bridge Program 初期化');
  const PROGRAM_ID = 'BridgeMisakaProgram1111111111111111111111111';
  const solana = new SolanaBridgeProgram(PROGRAM_ID, 'authority_key');
  info(`Program ID: ${PROGRAM_ID}`);
  ok('Solana Bridge Program 初期化完了');

  step(3, 'Misaka Bridge Handler 初期化');
  const bridgeConfig = defaultBridgeConfig(vk);
  const misakaHandler = new MisakaBridgeHandler(bridgeConfig);
  info(`Bridge fee: ${bridgeConfig.bridgeFee} tokens`);
  info(`Supported tokens: ${bridgeConfig.supportedTokens.join(', ')}`);
  ok('Misaka Bridge Handler 初期化完了');

  step(4, 'Relayer Service 起動');
  const relayer = new BridgeRelayer(solana, misakaHandler);
  const events: RelayerEvent[] = [];
  relayer.onEvent(e => events.push(e));
  ok('Relayer Service 起動完了（イベント監視中）');

  step(5, 'テストネット + アカウント準備');
  const { validators } = bootstrapTestnet({ numValidators: 4 });

  // Solana user
  const ALICE_SOLANA = '7xKXtg2CnWR5WGjTFCb1Gp7HbR5DfqshLcT1NYRftNy';
  solana.fundAccount(ALICE_SOLANA, BridgeToken.SOL, 1_000_000_000n); // 1 SOL
  money(`Alice (Solana): ${solana.getBalance(ALICE_SOLANA, BridgeToken.SOL)} lamports`);

  // Misaka user (stealth keys for privacy)
  const aliceMisaka = generateStealthKeyPair();
  const aliceMisakaMeta = getStealthMeta(aliceMisaka);
  const aliceMisakaKp = nacl.sign.keyPair();
  const aliceMisakaPkh = hashPubKey(aliceMisakaKp.publicKey);
  info(`Alice (Misaka): ${aliceMisakaPkh.slice(0, 24)}...`);

  // Bob on Solana (for withdraw test)
  const BOB_SOLANA = '9yB3rtMNJfD6oU2ECyhbVzT8Kp9hZyQYmBFrREE2pVcS';
  solana.getOrCreateAccount(BOB_SOLANA);
  info(`Bob (Solana): ${BOB_SOLANA}`);

  ok('全アカウント準備完了');

  // ════════════════════════════════════════════════════════════
  // Phase 2: DEPOSIT (Solana → Misaka)
  // ════════════════════════════════════════════════════════════

  header('Phase 2: DEPOSIT — Solana → Misaka (500,000,000 lamports)');

  step(6, 'Alice が Solana 上でトークンをロック');
  const lockAmount = 500_000_000n; // 0.5 SOL
  const lockResult = solana.lock(ALICE_SOLANA, lockAmount, BridgeToken.SOL, aliceMisakaPkh);

  if ('error' in lockResult) {
    console.error(`Lock failed: ${lockResult.error}`);
    return;
  }

  info(`TX sig:     ${lockResult.txSignature.slice(0, 24)}...`);
  info(`Slot:       ${lockResult.slot}`);
  info(`Amount:     ${lockResult.amount} lamports`);
  info(`Nonce:      ${lockResult.nonce.slice(0, 16)}...`);
  info(`Recipient:  ${lockResult.misakaRecipient.slice(0, 24)}...`);
  money(`Alice Solana残高: ${solana.getBalance(ALICE_SOLANA, BridgeToken.SOL)} lamports`);
  money(`Bridge Vault: ${solana.getLockedBalance(BridgeToken.SOL)} lamports`);
  ok('Solana ロック完了');

  step(7, 'Relayer が ZK Proof を生成');
  const commitment = pedersenCommit(lockAmount);
  const depositProof = proveDeposit(
    lockResult,
    commitment,
    PROGRAM_ID,
    aliceMisakaPkh,
  );

  info(`Protocol:   ${depositProof.protocol}`);
  info(`Proof A:    ${depositProof.proofA.slice(0, 24)}...`);
  info(`Proof B:    ${depositProof.proofB.slice(0, 24)}...`);
  info(`Proof C:    ${depositProof.proofC.slice(0, 24)}...`);
  info(`Amount:     ${depositProof.publicInputs.amount} (公開 — ブリッジ>プライバシー)`);
  info(`Direction:  ${depositProof.publicInputs.direction}`);
  ok('ZK Proof 生成完了');

  step(8, 'Misaka バリデータが ZK Proof を検証');
  const verifyResult = verifyBridgeProof(
    depositProof, vk, bridgeConfig, new Set()
  );

  info('検証結果:');
  for (const check of verifyResult.checks) {
    const icon = check.passed ? '✅' : '❌';
    console.log(`      ${icon} ${check.name}${check.detail ? ': ' + check.detail : ''}`);
  }
  ok(`検証結果: ${verifyResult.valid ? '成功' : '失敗'}`);

  step(9, 'Relayer が Deposit TX を Misaka に送信');
  const depositResult = relayer.processLockEvent(lockResult);

  if ('error' in depositResult) {
    console.error(`Deposit failed: ${depositResult.error}`);
    return;
  }

  info(`Misaka TX ID: ${depositResult.tx.id.slice(0, 24)}...`);
  info(`TX Type:      ${depositResult.tx.type}`);
  info(`Mint Amount:  ${depositResult.tx.outputs[0].amount} (= ${lockAmount} - ${bridgeConfig.bridgeFee} fee)`);
  info(`Recipient:    ${depositResult.tx.outputs[0].recipientPubKeyHash.slice(0, 24)}...`);
  info(`Operation:    ${depositResult.operation.status}`);
  ok('Misaka Deposit (ミント) 完了！');

  // ════════════════════════════════════════════════════════════
  // Phase 3: Privacy after bridge
  // ════════════════════════════════════════════════════════════

  header('Phase 3: ブリッジ後のプライバシー変換');
  warn('ブリッジ操作中は金額が公開 (ブリッジ > プライバシー)');
  info('しかしMisaka上でプライベート送金に変換可能！');

  step(10, 'ブリッジで受け取ったトークンをプライベートUTXOに変換');

  // Create a stealth output from the bridged tokens
  const bridgedAmount = Number(lockAmount) - bridgeConfig.bridgeFee;
  const { output: stealthOut, commitment: stealthCommitment } =
    createStealthOutput(aliceMisakaMeta, bridgedAmount, 0);

  const scanned = scanStealthOutput(
    stealthOut, 'bridge_convert_tx',
    aliceMisaka.scanSecret, aliceMisaka.spendSecret, aliceMisaka.spendPub
  )!;

  info(`元の金額: ${bridgedAmount} (ブリッジ時は公開だった)`);
  info(`変換後: ステルスアドレス ${scanned.oneTimePubKey.slice(0, 24)}...`);
  info(`暗号化金額: ${stealthOut.encryptedAmount} (第三者には見えない)`);
  no('金額の平文: チェーン上に存在しない');
  ok('プライベートUTXOに変換完了 → 以降の送金は完全匿名');

  // ════════════════════════════════════════════════════════════
  // Phase 4: WITHDRAW (Misaka → Solana)
  // ════════════════════════════════════════════════════════════

  header('Phase 4: WITHDRAW — Misaka → Solana (200,000,000 lamports)');

  step(11, 'Alice が Misaka 上でトークンをバーン');
  const withdrawAmount = 200_000_000;
  const withdrawNonce = require('crypto').randomBytes(16).toString('hex');

  const withdrawData: WithdrawTxData = {
    amount: withdrawAmount,
    solanaRecipient: BOB_SOLANA,
    token: BridgeToken.SOL,
    burnKeyImages: ['dummy_key_image_' + withdrawNonce],
    nonce: withdrawNonce,
  };

  const withdrawTxResult = misakaHandler.processWithdraw(
    withdrawData,
    aliceMisakaPkh,
    [{ prevTxId: depositResult.tx.id, outputIndex: 0, signature: 'burn_sig', publicKey: toHex(aliceMisakaKp.publicKey) }],
  );

  if ('error' in withdrawTxResult) {
    console.error(`Withdraw failed: ${withdrawTxResult.error}`);
    return;
  }

  info(`Burn TX ID:    ${withdrawTxResult.tx.id.slice(0, 24)}...`);
  info(`TX Type:       ${withdrawTxResult.tx.type}`);
  info(`Burn Amount:   ${withdrawAmount} lamports`);
  info(`Burn Address:  ${'0'.repeat(24)}... (全ゼロ = burn)`);
  info(`Solana宛先:    ${BOB_SOLANA}`);
  ok('Misaka バーン完了');

  step(12, 'Relayer が Withdraw ZK Proof を生成 → Solana Unlock');
  const unlockResult = relayer.processWithdrawEvent(
    withdrawTxResult.tx.id,
    withdrawData,
  );

  if ('error' in unlockResult) {
    console.error(`Unlock failed: ${unlockResult.error}`);
    return;
  }

  info(`Solana TX sig: ${unlockResult.solanaTxSig.slice(0, 24)}...`);
  info(`Status:        ${unlockResult.operation.status}`);
  money(`Bob Solana残高: ${solana.getBalance(BOB_SOLANA, BridgeToken.SOL)} lamports`);
  money(`Bridge Vault:  ${solana.getLockedBalance(BridgeToken.SOL)} lamports`);
  ok('Solana Unlock 完了！ Bob がトークンを受取');

  // ════════════════════════════════════════════════════════════
  // Phase 5: Security Checks
  // ════════════════════════════════════════════════════════════

  header('Phase 5: セキュリティ検証');

  step(13, 'Nonce リプレイ攻撃の防止');
  const replayResult = relayer.processLockEvent(lockResult);
  if ('error' in replayResult) {
    ok(`リプレイ拒否: ${replayResult.error}`);
  }

  step(14, 'Solana 二重アンロック防止');
  const doubleUnlock = solana.unlock({
    burnTxId: withdrawTxResult.tx.id,
    recipientAddress: BOB_SOLANA,
    amount: BigInt(withdrawAmount),
    token: BridgeToken.SOL,
    proof: unlockResult.operation.proof!,
    nonce: withdrawNonce,
  });
  if ('error' in doubleUnlock) {
    ok(`二重アンロック拒否: ${doubleUnlock.error}`);
  }

  step(15, '残高不足ロックの拒否');
  const overdraft = solana.lock(ALICE_SOLANA, 999_999_999_999n, BridgeToken.SOL, aliceMisakaPkh);
  if ('error' in overdraft) {
    ok(`残高不足拒否: ${overdraft.error}`);
  }

  // ════════════════════════════════════════════════════════════
  // Phase 6: Statistics
  // ════════════════════════════════════════════════════════════

  header('Phase 6: ブリッジ統計');

  step(16, 'Relayer 統計');
  const relayerStats = relayer.getStats();
  info(`Total operations:  ${relayerStats.totalOperations}`);
  info(`Deposits:          ${relayerStats.deposits}`);
  info(`Withdrawals:       ${relayerStats.withdrawals}`);
  info(`Completed:         ${relayerStats.completed}`);
  info(`Failed:            ${relayerStats.failed}`);

  step(17, 'Solana Program 状態');
  const solanaSummary = solana.getStateSummary();
  info(`Current slot:      ${solanaSummary.currentSlot}`);
  info(`Lock events:       ${solanaSummary.totalLockEvents}`);
  info(`Unlocks processed: ${solanaSummary.totalUnlocks}`);
  info(`SOL locked:        ${solanaSummary.lockedBalances.SOL}`);

  step(18, 'Misaka Bridge 状態');
  const misakaState = misakaHandler.getState();
  info(`Nonces processed:  ${misakaState.processedNonces}`);
  info(`SOL minted:        ${misakaState.totalMinted.SOL}`);
  info(`SOL burned:        ${misakaState.totalBurned.SOL}`);

  step(19, 'Relayer イベントログ');
  for (const e of events) {
    const icon = e.type.includes('error') ? '❌' : '📨';
    console.log(`    ${icon} ${e.type} [${e.operation.status}] op=${e.operation.id.slice(0, 8)}...`);
  }

  // ════════════════════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════════════════════

  header('📊 ZK ブリッジアーキテクチャ');
  console.log(`
  ┌─────────────┐        ┌──────────┐        ┌──────────────┐
  │   Solana     │        │ Relayer  │        │   Misaka     │
  │   Network    │        │ (off-chain)│      │   Network    │
  ├─────────────┤        ├──────────┤        ├──────────────┤
  │             │  lock   │          │ deposit│              │
  │ Bridge Prog ├───────→│ ZK Prove ├───────→│ ZK Verify    │
  │ (lock/unlock)│       │          │        │ Mint tokens  │
  │             │        │          │        │              │
  │             │ unlock │          │  burn  │              │
  │             │←───────┤ ZK Prove │←───────┤ Burn TX      │
  │ Release     │        │          │        │              │
  └─────────────┘        └──────────┘        └──────────────┘

  セキュリティ保証:
    ✅ ZK Proof により Relayer を信頼する必要なし
    ✅ Nonce でリプレイ攻撃を防止
    ✅ Key Image で二重使用を防止
    ✅ Pedersen commitment で金額の整合性を検証
    
  プライバシーとブリッジの関係:
    ⚠️  ブリッジ操作中: 金額は公開（ブリッジ正当性 > プライバシー）
    ✅ ブリッジ後: プライベートUTXOに変換可能
    ✅ Misaka内の送金: 完全な現金レベルプライバシー
  `);

  console.log('  最終残高:');
  money(`Alice (Solana): ${solana.getBalance(ALICE_SOLANA, BridgeToken.SOL)} lamports`);
  money(`Bob   (Solana): ${solana.getBalance(BOB_SOLANA, BridgeToken.SOL)} lamports`);
  money(`Bridge Vault:   ${solana.getLockedBalance(BridgeToken.SOL)} lamports`);

  header('🎉 ZK Bridge Demo Complete!');
}

main().catch(console.error);
