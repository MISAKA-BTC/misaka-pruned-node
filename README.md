# 🌐 Misaka Network

**送金専用・プライバシー強化 L1 ブロックチェーン**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-20%2B-green)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow)](./LICENSE)

Misaka Network は「送金のみ」に特化した軽量 L1 チェーンです。スマートコントラクトを持たず、UTXO モデルとフラット 3% 手数料でシンプルかつ予測可能な送金を実現します。

## 特徴

| 機能 | 説明 |
|------|------|
| **送金専用** | スマコンなし。UTXO モデルで高速・軽量 |
| **現金レベルプライバシー** | ステルスアドレス、リング署名、Pedersen commitment |
| **プライバシー** | E2E メモ暗号化、View Key による選択的開示 |
| **安全アドレス** | bech32m 形式（`misaka1...`）、Solana アドレス誤送信防止 |
| **ネットワーク手数料** | 送金額の 3%（シンプル・予測可能） |
| **軽量運用** | 4GB VPS で動作可能 |
| **BFT 合意** | ラウンドロビン提案 + 2/3+1 署名で即時ファイナリティ |
| **テストネット** | アンカー不要でバリデーター作成 + Faucet |
| **ZK ブリッジ** | Solana ↔ Misaka の ZK証明ブリッジ（lock/mint/burn/unlock） |
| **ノード役割分離** | pruned(4GB) / archive(16GB) / explorer(32GB) の3層アーキテクチャ |

---

## クイックスタート

### 前提条件

- Node.js 20+
- npm

### インストール

```bash
git clone <repository>
cd misaka-network
npm install
```

### ビルド

```bash
npm run build
```

### テスト実行

```bash
npm test                    # 全テスト（194 tests）
npm run test:unit           # ユニットテストのみ
npm run test:integration    # 統合テストのみ
```

### 4 ノードデモ

```bash
npx ts-node scripts/demo.ts
```

### 🔐 プライバシーデモ（現金レベル）

```bash
npx ts-node scripts/privacy-demo.ts
```

### 🌉 ZK ブリッジデモ（Solana ↔ Misaka）

```bash
npx ts-node scripts/bridge-demo.ts
```

以下を実演します：

1. **Solana → Misaka (Deposit)**:
   - Solana上でトークンをロック
   - Relayerが ZK Proof（Schnorr-Pedersen）を生成
   - MisakaバリデータがZK Proofを検証（11チェック全合格）
   - Misaka上でトークンをミント
2. **プライバシー変換**: ブリッジ後のトークンをプライベートUTXOに変換
3. **Misaka → Solana (Withdraw)**:
   - Misaka上でトークンをバーン
   - Relayerが ZK Proof を生成
   - Solana上でトークンをアンロック
4. **セキュリティ**: Nonceリプレイ攻撃防止、二重アンロック防止
5. **ブリッジ > プライバシー**: ブリッジ中は金額公開、ブリッジ後は完全匿名

### 🖥️ ノード役割分離デモ（4GB / 16GB / 32GB）

```bash
npx ts-node scripts/node-role-demo.ts
```

以下を実演します：

1. **3つのノード役割**: pruned(4GB), archive(16GB), explorer(32GB)
2. **30ブロック生成・配布**: 全ノードに同時配信
3. **状態比較**: 全ノードでState Root一致を検証
4. **スナップショットBootstrap**: 新ノードがスナップショットから参加
5. **キャッチアップ**: 残りブロックを適用してState Root一致
6. **メモリ比較**: 各ノードのメモリ使用量テーブル
7. **Explorer API**: 10個のRESTエンドポイント一覧

以下を実演します：

1. **テストネット起動**（アンカー/ステーキング不要でバリデーター作成）
2. **Faucet** からテストトークン受取
3. **プライベート送金**（Alice → Bob → Carol）
4. **現金プライバシー4性質の検証**:
   - ❌ 誰が誰に渡したか記録されない（リング署名 + ステルスアドレス）
   - ❌ 残高は台帳に存在しない（Pedersen commitment + 暗号化金額）
   - ✅ 当事者だけが知っている（スキャン + 復号）
   - ❌ 追跡しにくい（ワンタイムアドレス、毎回異なる）
5. **二重使用防止**（Key Image）
6. **View Key による選択的開示**（監査対応）
7. **Pedersen commitment バランス証明**

### Docker Compose

```bash
docker-compose up
```

4 ノード（node0〜3）がブリッジネットワーク上で起動します。

---

## アーキテクチャ

```
┌──────────────────────────────────────────────────────────────┐
│                    Misaka Node                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ CLI/RPC  │  │   P2P    │  │Consensus │  │  Wallet   │    │
│  │ Server   │  │ Network  │  │  Engine  │  │   SDK     │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘    │
│  ┌────┴──────────────┴─────────────┴──────────────┴─────┐    │
│  │              Core Layer                               │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐           │    │
│  │  │Blockchain│  │  UTXO    │  │ Mempool  │           │    │
│  └──┴──────────┴──┴──────────┴──┴──────────┴───────────┘    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              Utilities                                │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐           │    │
│  │  │  Crypto  │  │ Address  │  │   Fee    │           │    │
│  │  │ Ed25519  │  │ bech32m  │  │  Tiers   │           │    │
│  └──┴──────────┴──┴──────────┴──┴──────────┴───────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### ディレクトリ構成

```
misaka-network/
├── src/
│   ├── types/index.ts          # 型定義・チェーンパラメータ
│   ├── utils/crypto.ts         # Ed25519, X25519, SHA-256
│   ├── core/
│   │   ├── address.ts          # bech32m アドレス
│   │   ├── fee.ts              # 段階制手数料
│   │   ├── transaction.ts      # TX 作成・検証
│   │   ├── blockchain.ts       # ブロック・チェーン
│   │   ├── utxo-store.ts       # UTXO 管理
│   │   ├── mempool.ts          # メモプール
│   │   └── node.ts             # ノード統合
│   ├── privacy/                # 🔐 現金レベルプライバシー
│   │   ├── curve.ts            # Ed25519 楕円曲線演算
│   │   ├── stealth.ts          # ステルスアドレス (DKSAP)
│   │   ├── ring.ts             # SAG リング署名
│   │   ├── pedersen.ts         # Pedersen commitment
│   │   ├── transaction.ts      # プライベートTX作成・検証
│   │   ├── types.ts            # プライバシー型定義
│   │   └── index.ts            # エクスポート
│   ├── testnet/                # テストネットユーティリティ
│   │   └── index.ts            # バリデーター作成・Faucet
│   ├── bridge/                 # 🌉 ZK ブリッジ (Solana ↔ Misaka)
│   │   ├── types.ts            # ブリッジ型定義
│   │   ├── zk/
│   │   │   ├── circuit.ts      # ZK 算術回路 (Sigma protocol)
│   │   │   ├── prover.ts       # ZK 証明生成 (Schnorr-Pedersen)
│   │   │   └── verifier.ts     # ZK 証明検証
│   │   ├── solana/
│   │   │   └── program.ts      # Solana ブリッジプログラム + Anchor IDL
│   │   ├── misaka/
│   │   │   └── handler.ts      # Misaka 側 deposit/withdraw ハンドラ
│   │   ├── relayer/
│   │   │   └── service.ts      # オフチェーンリレーサービス
│   │   └── index.ts            # エクスポート
│   ├── storage/                # 💾 ストレージ階層
│   │   ├── types.ts            # NodeRole, メモリ予算, Snapshot型
│   │   ├── block-store.ts      # PrunedBlockStore / ArchiveBlockStore
│   │   ├── snapshot.ts         # スナップショット管理 (作成/署名/検証)
│   │   ├── role-node.ts        # RoleAwareNode (3役割統合)
│   │   └── index.ts            # エクスポート
│   ├── explorer/               # 🔍 Block Explorer (32GB)
│   │   ├── indexer.ts          # アドレス/TX/RichList/バリデータ インデックス
│   │   ├── api.ts              # REST API (10エンドポイント)
│   │   └── index.ts            # エクスポート
│   ├── consensus/engine.ts     # BFT 合意エンジン
│   ├── storage/                # 💾 ストレージ階層 (4GB / 16GB / 32GB)
│   │   ├── types.ts            # NodeRole, メモリバジェット, IBlockStore
│   │   ├── block-store.ts      # PrunedBlockStore / ArchiveBlockStore
│   │   ├── snapshot.ts         # スナップショットマネージャ
│   │   ├── role-node.ts        # 役割別ノード (pruned/archive/explorer)
│   │   └── index.ts            # エクスポート
│   ├── explorer/               # 🔍 ブロックエクスプローラ (32GB)
│   │   ├── indexer.ts          # TX/アドレス/Rich list インデクサ
│   │   ├── api.ts              # REST API サーバー
│   │   └── index.ts            # エクスポート
│   ├── p2p/network.ts          # TCP P2P ネットワーク
│   ├── wallet/sdk.ts           # ウォレット SDK
│   ├── cli/index.ts            # CLI ツール
│   └── index.ts                # パブリック API
├── tests/
│   ├── unit/
│   │   ├── core.test.ts        # コアユニットテスト (61 tests)
│   │   ├── privacy.test.ts     # プライバシーテスト (34 tests)
│   │   ├── bridge.test.ts      # ZK ブリッジテスト (40 tests)
│   │   └── storage.test.ts     # ストレージ階層テスト (59 tests)
│   └── integration/
│       └── network.test.ts     # 統合テスト (8 tests → 計 194 tests)
├── scripts/
│   ├── demo.ts                 # 4 ノードデモ
│   ├── privacy-demo.ts         # プライバシーデモ
│   ├── bridge-demo.ts          # ZK ブリッジデモ
│   └── node-role-demo.ts       # ノード役割分離デモ
├── config/node0.json           # ノード設定例
├── docs/ARCHITECTURE.md        # アーキテクチャ設計書（日本語）
├── docker-compose.yml          # Docker 構成
└── Dockerfile
```

---

## 現金レベルプライバシー 🔐

Misaka Network は「現金」と同等のプライバシーをブロックチェーン上で実現します。

```
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
```

### プライバシー技術スタック

| 技術 | 目的 | 実装 |
|------|------|------|
| **ステルスアドレス (DKSAP)** | 受信者の匿名性 | Ed25519 上の Diffie-Hellman + ワンタイム鍵導出 |
| **リング署名 (SAG)** | 送信者の匿名性 | リングサイズ 2〜8、Key Image でリンク可能性 |
| **Pedersen Commitment** | 金額の秘匿 | `C = v·G + r·H` 準同型コミットメント |
| **暗号化金額** | 当事者のみ閲覧 | XOR ストリーム暗号 (ECDH shared secret) |
| **Key Image** | 二重使用防止 | `I = x·Hp(P)` — 同一 UTXO は同一イメージ |
| **View Key** | 選択的開示 | scan_secret の共有で閲覧権限付与（送金権限なし）|

### プライベートトランザクションの仕組み

```
送信者 (Alice)                        受信者 (Bob)
    │                                     │
    │ 1. ステルスアドレス生成               │
    │    R = r·G (エフェメラル鍵)           │
    │    P = Hs(r·A)·G + B (ワンタイムAddr)│
    │                                     │
    │ 2. リング署名                        │
    │    [Alice, Decoy1, Decoy2, Decoy3]  │
    │    → 4人の中で誰が本物か不明          │
    │                                     │
    │ 3. Pedersen commitment              │
    │    C = amount·G + blinding·H        │
    │    → 金額は秘匿、バランスのみ検証    │
    │                                     │
    │ 4. チェーンに記録                    │
    │    → 平文の金額/送信者/受信者なし     │
    │                                     │
    │                    5. Bob がスキャン  │
    │                    s = Hs(a·R)       │
    │                    P == s·G + B ?    │
    │                    → 自分宛と検出    │
    │                    → 金額を復号      │
```

---

## テストネット（アンカー不要）

テストネットでは **ステーキングやアンカーなし** でバリデーターを作成できます。

```typescript
import { bootstrapTestnet, createTestnetValidator, TestnetFaucet } from 'misaka-network';

// バリデーターを即座に作成（ステーキング不要）
const validator = createTestnetValidator('my-validator');
console.log(validator.address);  // tmisaka1...

// テストネットを丸ごとブートストラップ
const { validators, faucet } = bootstrapTestnet({ numValidators: 4 });

// Faucet からテストトークンを受取
const result = faucet.drip(validator.pubKeyHash);
// → { tx: Transaction, amount: 10_000_000 }
```

### Faucet 設定

| パラメータ | デフォルト | 説明 |
|-----------|-----------|------|
| `dripAmount` | 10,000,000 | 1回の配布量 |
| `cooldownMs` | 60,000 | レート制限 (ms) |
| `maxDripsPerAddress` | 10 | アドレスあたり最大配布回数 |
| `totalSupply` | 1,000,000,000 | Faucet 総供給量 |

---

## アドレス仕様

### Misaka アドレス（bech32m / BIP-350）

| 項目 | 仕様 |
|------|------|
| エンコーディング | bech32m (BIP-350) |
| メインネット HRP | `misaka` → `misaka1...` |
| テストネット HRP | `tmisaka` → `tmisaka1...` |
| Payload | version(1B) ‖ ed25519_pubkey(32B) = 33B |
| Version | `0x00`（現行） |

### Solana アドレス誤送信防止

SDK/CLI が自動で Solana アドレス（Base58, 32-44 文字）を検出し、Misaka 送金を拒否します。

```typescript
import { detectAddressType } from 'misaka-network';

detectAddressType('misaka1...');  // → 'misaka'
detectAddressType('7xKXtg2C...');  // → 'solana'
detectAddressType('other');        // → 'unknown'
```

---

## ネットワーク手数料（3%）

| 項目 | 値 |
|------|----|
| 手数料率 | 送金額の **3%** |
| 適用対象 | 全送金（透明TX / confidential TX） |

```
例: 10,000 MSK 送金 → 手数料 300 MSK
例: 50 MSK 送金 → 手数料 1.5 MSK
```

- 不正な fee を指定した TX はバリデーション時に拒否（±0.01%の許容範囲）
- チェーンパラメータとして固定（将来ガバナンスで変更可能に予約）

---

## トランザクションタイプ

| Type | 説明 | 状態 |
|------|------|------|
| `transfer` | 通常の送金 | ✅ 実装済み |
| `coinbase` | ブロック報酬 | ✅ 実装済み |
| `deposit` | Solana → Misaka ブリッジ入金 | ✅ 実装済み（ZK証明検証 + ミント） |
| `withdraw` | Misaka → Solana ブリッジ出金 | ✅ 実装済み（バーン + ZK証明 → アンロック） |

`deposit` / `withdraw` はブリッジ有効時のみ受理。ブリッジ無効時は拒否されます。

---

## プライバシー機能（詳細）

### 通常の E2E メモ暗号化

送金メモは nacl.box（X25519 + XSalsa20-Poly1305）で暗号化されます。チェーン上には暗号文のみが保存され、受信者だけが復号できます。

### プライベートトランザクション（現金レベル）

`private_transfer` タイプのトランザクションは、以下の暗号技術を組み合わせて現金と同等のプライバシーを実現します：

```typescript
import { privacy } from 'misaka-network';

// 鍵生成
const alice = privacy.generateStealthKeyPair();
const bob = privacy.generateStealthKeyPair();

// ステルス出力の作成（受信者は一度限りのアドレスで受け取る）
const { output } = privacy.createStealthOutput(
  privacy.getStealthMeta(bob), 50000, 0
);

// 受信者のスキャン（自分宛か検出 + 金額復号）
const scanned = privacy.scanStealthOutput(
  output, txId, bob.scanSecret, bob.spendSecret, bob.spendPub
);

// プライベートトランザクション（リング署名 + Pedersen commitment）
const tx = privacy.createPrivateTransaction({
  inputs: [utxo],
  recipients: [{ meta: bobMeta, amount: 50000 }],
  senderMeta: aliceMeta,
  decoyPool: [...],  // リング署名用のデコイ公開鍵
  ringSize: 4,
});
```

### 選択的開示（View Key）

ユーザーは View Key（X25519 秘密鍵）を第三者に共有することで、自分の取引メモを選択的に開示できます。

- 期間制限付き（validFrom / validUntil）
- ラベル付き（"auditor-2025" 等）
- ネットワーク全体の匿名化ではなく「本人の同意による開示」

### アドレス分離

ウォレット SDK はマスターシードから複数アカウントを自動派生し、アドレスの使い回しを防ぎます。同一アドレスの 3 回以上の再利用時に警告を表示します。

---

## CLI コマンド

```bash
# 鍵ペア生成
misaka keygen

# アドレス生成
misaka address -k key.json -n test

# アドレス検証
misaka validate <address>

# 手数料見積もり
misaka fee -a 50000

# 残高確認
misaka balance -k key.json

# 送金
misaka send -t <misaka1...> -a 50000 -m "payment memo"

# ノード起動
misaka node start --config node.json

# チェーン情報
misaka info
```

---

## 手数料分配（将来パラメータ化）

| モード | 説明 | 状態 |
|--------|------|------|
| `validator_100` | 100% バリデータ報酬 | ✅ MVP デフォルト |
| `burn_50_validator_50` | 50% バーン + 50% バリデータ | 🔮 将来 |
| `burn_100` | 100% バーン（デフレ型） | 🔮 将来 |

---

## 合意アルゴリズム（最小 BFT）

- バリデータ集合: N=4〜16（初期は 4）
- ラウンドロビンリーダー: `proposer = validators[height % N]`
- 2/3+1 署名でブロック確定（即時ファイナリティ）
- フォーク無し（確定後の巻き戻し無し）

---

## ノード役割とストレージ階層 💾

### 3つのノード役割

```
┌─────────────────────────────────────────────────────────────────────┐
│  Pruned Validator (4GB VPS)     ← バリデータはこれで十分             │
│  ├─ 最新UTXO スナップショット                                       │
│  ├─ 直近 N ブロック（default 1000）                                 │
│  ├─ コンセンサス参加 ✅                                             │
│  └─ 古いブロックは自動削除                                          │
├─────────────────────────────────────────────────────────────────────┤
│  Archive Node (16GB VPS)        ← 運営のみ（1台あれば十分）          │
│  ├─ ジェネシスから全ブロック保持                                     │
│  ├─ コンセンサス不参加 ❌                                           │
│  ├─ Pruned ノードにスナップショット提供                              │
│  └─ インデックスなし（軽量）                                        │
├─────────────────────────────────────────────────────────────────────┤
│  Explorer / Indexer (32GB VPS)  ← ブロックエクスプローラ用           │
│  ├─ 全ブロック + 全インデックス                                     │
│  ├─ アドレス→TX履歴、Rich list、バリデータ統計                      │
│  ├─ REST API サーバー内蔵                                          │
│  └─ 一番メモリを食う（インデックス分）                               │
└─────────────────────────────────────────────────────────────────────┘
```

### メモリバジェット

| 役割 | VPS | 使用可能 | ブロック保持 | UTXO Cache | インデックス |
|------|-----|---------|-------------|------------|-------------|
| **Pruned Validator** | 4GB | 3GB | 直近1000 | 1GB | ❌ |
| **Archive** | 16GB | 14GB | 全履歴 | 4GB | ❌ |
| **Explorer** | 32GB | 28GB | 全履歴 | 8GB | ✅ |

### Pruned Validator のブートストラップ

```
新しい4GBノードがネットワークに参加:

  1. Archive ノードから最新スナップショットをダウンロード
     （UTXO状態 + バリデータ署名付き）
  2. 2/3+1 のバリデータ署名を検証
  3. スナップショットからUTXO状態を復元
  4. スナップショット以降のブロックだけ同期
  5. バリデーションを開始
     
  → ジェネシスからリプレイ不要！
```

### コード例

```typescript
import { storage } from 'misaka-network';

// ── 4GB バリデータノード ──
const pruned = new storage.RoleAwareNode(
  storage.createRoleConfig(nodeConfig, storage.NodeRole.PRUNED_VALIDATOR)
);
pruned.setValidatorKey(secretKey, publicKey);
await pruned.start();

// ── 16GB アーカイブノード ──
const archive = new storage.RoleAwareNode(
  storage.createRoleConfig(nodeConfig, storage.NodeRole.ARCHIVE)
);
await archive.start();

// ── 32GB エクスプローラノード ──
const explorer = new storage.RoleAwareNode(
  storage.createRoleConfig(nodeConfig, storage.NodeRole.EXPLORER, {
    explorerAPI: { port: 3000, host: '0.0.0.0' },
  })
);
await explorer.start();
// → GET /api/status, /api/block/:h, /api/tx/:id, /api/richlist ...
```

### Explorer REST API エンドポイント

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/status` | チェーン状態 + 供給量 + 手数料統計 |
| GET | `/api/block/:height` | ブロック詳細 + 統計 |
| GET | `/api/blocks/recent` | 直近ブロック一覧 |
| GET | `/api/tx/:txId` | トランザクション詳細 |
| GET | `/api/address/:hash` | アドレス情報 + 直近アクティビティ |
| GET | `/api/address/:hash/txs` | ページネーション付きTX履歴 |
| GET | `/api/richlist` | 残高ランキング |
| GET | `/api/validators` | バリデータ統計（ブロック生成数、稼働率） |
| GET | `/api/search?q=` | TX ID / アドレス検索 |
| GET | `/api/fees` | 手数料統計 |

---

## ノード役割分離 (4GB / 16GB / 32GB) 🖥️

### 3つの役割

| Role | RAM | ブロック保持 | インデックス | コンセンサス | 用途 |
|------|-----|-----------|-----------|-----------|------|
| `pruned_validator` | 4GB | 直近N blocks | ❌ | ✅ 参加 | バリデータ（VPS最小構成） |
| `archive` | 16GB | 全履歴 | ❌ | ❌ 不参加 | 運営のみ、ブロック配信 |
| `explorer` | 32GB | 全履歴 | ✅ 全インデックス | ❌ 不参加 | Block Explorer UI |

### メモリ予算

| | Max Memory | Max Blocks | UTXO Cache | Index |
|---|-----------|-----------|-----------|-------|
| Pruned (4GB) | 3,072 MB | 1,000 | 1,024 MB | OFF |
| Archive (16GB) | 14,336 MB | ∞ | 4,096 MB | OFF |
| Explorer (32GB) | 28,672 MB | ∞ | 8,192 MB | ON |

### Pruned Node のスナップショット戦略

```
Height 0                    100                   200
  │                          │                     │
  ▼                          ▼                     ▼
  [GENESIS]──────────────────[SNAPSHOT]─────────────[SNAPSHOT]
                              │                     │
                              └── UTXO State        └── UTXO State
                              └── Validator署名       └── Validator署名

  Pruned Node (pruningWindow=100):
    Height 200 時点で保持しているもの:
    ├── Snapshot at height 200 (最新UTXO State)
    ├── Blocks 100-200 (直近100ブロック)
    └── ❌ Blocks 0-99 は削除済み
```

### 新規ノード参加フロー

```typescript
import { RoleAwareNode, createRoleConfig, NodeRole } from 'misaka-network';

// 1. Archive ノードから最新スナップショットを取得
const snapshot = archiveNode.snapshotManager.getLatestSnapshot();

// 2. Pruned ノード作成
const node = new RoleAwareNode(createRoleConfig(config, NodeRole.PRUNED_VALIDATOR));
node.setValidatorKey(secretKey, publicKey);

// 3. スナップショットから復元 (署名検証: 2/3+1)
node.bootstrapFromSnapshot(snapshot, validatorPubKeys);

// 4. 残りブロックをキャッチアップ
const catchUpBlocks = archiveNode.getBlocks(snapshot.height + 1, currentHeight);
node.applyCatchUpBlocks(catchUpBlocks);

// 5. コンセンサス参加開始 → State Root は全ノードと一致
```

### Explorer REST API (32GB ノードのみ)

| Endpoint | Description |
|----------|-------------|
| `GET /api/status` | チェーン状態 + 供給量 |
| `GET /api/block/:height` | ブロック詳細 + 統計 |
| `GET /api/blocks/recent` | 最新ブロック一覧 |
| `GET /api/tx/:txId` | トランザクション詳細 |
| `GET /api/address/:hash` | アドレス情報 + 残高 |
| `GET /api/address/:hash/txs` | TX履歴（ページ付き） |
| `GET /api/richlist` | 高額保有者ランキング |
| `GET /api/validators` | バリデータ統計 |
| `GET /api/search?q=` | TX/アドレス検索 |
| `GET /api/fees` | 手数料統計 |

---

## 将来の拡張ポイント

| 項目 | 状態 | 説明 |
|------|------|------|
| LevelDB/RocksDB | 🔮 予定 | インメモリ → 永続化 KV ストア |
| 委任 PoS | 🔮 フェーズ 2 | バリデータへのステーキング委任 |
| BLS 集約署名 | 🔮 将来 | 個別署名 → 集約署名 |
| Solana ブリッジ (zk) | ✅ 実装済み | Schnorr-Pedersen ZK証明 + Relayer |
| ガバナンス | 🔮 将来 | fee tier 変更の投票メカニズム |
| fee burn/split | 🔮 将来 | burn / validator / treasury 分配 |
| libp2p 移行 | 🔮 将来 | TCP → libp2p (NAT traversal 等) |
| WebSocket RPC | 🔮 将来 | ブロック・TX 購読 |
| Groth16/PLONK本番 | 🔮 将来 | Sigma protocol → 本番 zk-SNARK |
| Solana Anchor配備 | 🔮 将来 | シミュレータ → 本番Anchor program |

---

## ZK ブリッジ (Solana ↔ Misaka) 🌉

### アーキテクチャ

```
┌─────────────┐        ┌──────────┐        ┌──────────────┐
│   Solana     │        │ Relayer  │        │   Misaka     │
│   Network    │        │(off-chain)│       │   Network    │
├─────────────┤        ├──────────┤        ├──────────────┤
│             │  lock   │          │ deposit│              │
│ Bridge Prog ├───────→│ ZK Prove ├───────→│ ZK Verify    │
│ (lock/unlock)│       │          │        │ Mint tokens  │
│             │        │          │        │              │
│             │ unlock │          │  burn  │              │
│             │←───────┤ ZK Prove │←───────┤ Burn TX      │
│ Release     │        │          │        │              │
└─────────────┘        └──────────┘        └──────────────┘
```

### 5つのコンポーネント

| # | コンポーネント | ファイル | 行数 | 説明 |
|---|-------------|---------|------|------|
| 1 | **Solana Program** | `solana/program.ts` | 342 | ロック/アンロック SPL プログラム + Anchor IDL |
| 2 | **ZK 証明生成** | `zk/circuit.ts` + `zk/prover.ts` | 466 | Schnorr-Pedersen Sigma protocol (Fiat-Shamir) |
| 3 | **ZK 証明検証** | `zk/verifier.ts` | 258 | 11 段階の検証 (曲線、金額、Nonce、暗号) |
| 4 | **Relayer** | `relayer/service.ts` | 322 | Solana↔Misaka の証明中継（トラストレス） |
| 5 | **逆方向** | `misaka/handler.ts` | 289 | Burn/Unlock (Misaka→Solana) |

### ブリッジ > プライバシーのルール

ブリッジ操作中は **金額が公開** されます（ブリッジの正当性検証 > プライバシー）：

```
Deposit (Solana→Misaka):
  金額: 公開 ← ミント量の検証に必要
  受信者: pubkey hash（ステルスアドレス可能）
  送信者: Solana上で公開

Withdraw (Misaka→Solana):
  金額: 公開 ← アンロック量の検証に必要
  受信者: Solanaアドレスで公開
  送信者: Key Image のみ公開（匿名性一部維持）

ブリッジ後:
  ✅ プライベートUTXOに変換 → 以降は完全匿名
```

### ZK 証明の仕組み

```typescript
import { bridge } from 'misaka-network';

// 1. Solana 上でロック
const lockEvent = solanaProgram.lock(alice, 500_000_000n, 'SOL', misakaRecipient);

// 2. ZK証明生成（Schnorr-Pedersen Sigma protocol）
const commitment = pedersenCommit(lockEvent.amount);
const proof = bridge.proveDeposit(lockEvent, commitment, programId, recipient);
// proof.protocol = 'schnorr_bridge'
// proof.proofA, proofB, proofC = Ed25519 曲線点

// 3. Misaka 側で検証（11チェック）
const result = bridge.verifyBridgeProof(proof, vk, config, processedNonces);
// ✅ protocol_version, curve_points, amount_positive, amount_limits,
//    token_supported, direction_valid, program_id_match, nonce_unique,
//    commitment_valid, crypto_verification, vk_version

// 4. ミント
const depositTx = misakaHandler.processDeposit(depositData);
```

---

## ライセンス

MIT
