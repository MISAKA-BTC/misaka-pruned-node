# Misaka Network - アーキテクチャ設計書

## 概要

Misaka Networkは「送金専用・プライバシー強化」のL1ブロックチェーンです。スマートコントラクトを持たず、シンプルなUTXOモデルで高速・軽量な送金を実現します。

**設計原則:**
- シンプルさ: 送金のみ、スマコンなし
- 軽量性: さくらインターネット 4GB VPS で運用可能
- プライバシー: 合法的な個人情報保護（監査可能な選択的開示）
- 安全性: Solanaアドレスとの混同防止

---

## 1. システムアーキテクチャ

```
┌────────────────────────────────────────────────────────────┐
│                    Misaka Node                              │
│                                                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ CLI/RPC  │  │    P2P   │  │Consensus │  │  Wallet   │  │
│  │ Server   │  │ Network  │  │  Engine  │  │   SDK     │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
│       │              │             │              │         │
│  ┌────┴──────────────┴─────────────┴──────────────┴─────┐  │
│  │              Core Layer                               │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐           │  │
│  │  │Blockchain│  │  UTXO    │  │ Mempool  │           │  │
│  │  │  Chain   │  │  Store   │  │          │           │  │
│  │  └──────────┘  └──────────┘  └──────────┘           │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Utilities                                │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐           │  │
│  │  │  Crypto  │  │ Address  │  │   Fee    │           │  │
│  │  │ Ed25519  │  │ bech32m  │  │  Tiers   │           │  │
│  │  └──────────┘  └──────────┘  └──────────┘           │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

---

## 2. アドレス仕様

### 2.1 Misakaアドレス形式 (bech32m / BIP-350)

| 項目 | 仕様 |
|------|------|
| エンコーディング | bech32m (BIP-350) |
| メインネットHRP | `misaka` → `misaka1...` |
| テストネットHRP | `tmisaka` → `tmisaka1...` |
| Payload | version(1B) ‖ ed25519_pubkey(32B) = 33B |
| Version | `0x00` (現行) |

### 2.2 Solanaアドレス誤送金防止

- Base58 + 32-44文字のパターンをSolanaアドレスとして検出
- Misaka送金画面にSolanaアドレスを入力 → 即エラー
- アドレス型の自動判定: `detectAddressType()` API

---

## 3. 台帳モデル (UTXOモデル)

### 3.1 トランザクション構造

```typescript
Transaction {
  id: string           // SHA-256(serialized content)
  version: number      // 1
  inputs: [{
    prevTxId: string   // 前のTXハッシュ
    outputIndex: number
    signature: string  // Ed25519署名
    publicKey: string  // 署名者の公開鍵
  }]
  outputs: [{
    amount: number
    recipientPubKeyHash: string  // SHA-256(pubkey)
  }]
  fee: number          // 段階制固定手数料（必須）
  memo?: {             // E2E暗号化メモ（オプション）
    ciphertext: string
    nonce: string
    ephemeralPubKey: string
  }
  timestamp: number
}
```

### 3.2 UTXO管理

- インメモリ `Map<string, UTXOEntry>` （MVP）
- キー: `${txId}:${outputIndex}`
- 将来: LevelDB/RocksDB への移行
- Pruning: 直近Nブロック + UTXO setのみ保持

### 3.3 トランザクション検証フロー

1. TX IDの再計算・検証
2. 入力数・出力数の確認
3. 各入力のUTXO存在確認
4. 各入力の公開鍵→UTXO所有者一致確認
5. 各入力のEd25519署名検証
6. 二重使用チェック
7. UTXO残高検証: `Σinputs = Σoutputs + fee`
8. **段階制fee検証: `fee == calculateFee(outputs[0].amount)`**

---

## 4. 段階制（ティア）固定手数料

| 送金額レンジ | 固定手数料 |
|-------------|-----------|
| 0 < amount ≤ 100,000 (0.1M) | 0.5 |
| 100,000 < amount ≤ 500,000 (0.5M) | 5 |
| 500,000 < amount ≤ 1,000,000 (1M) | 20 |
| 1,000,000 < amount ≤ 5,000,000 (5M) | 100 |
| 5,000,000 < amount | 300 |

**重要な設計決定:**
- 手数料は送金額の「割合」ではなく「固定枚数」
- チェーンパラメータとして固定（将来ガバナンスで変更可能に予約）
- 不正なfee指定のTXはバリデーション時に拒否
- fee収益: 初期MVPでは「validator報酬100%」

---

## 5. プライバシー強化

### 5.1 取引メモのE2E暗号化

```
暗号化フロー:
1. 送信者がエフェメラルX25519鍵ペアを生成
2. nacl.box(message, nonce, recipient_x25519_pub, ephemeral_x25519_secret)
3. チェーン上には(ciphertext, nonce, ephemeral_pubkey)のみ保存

復号フロー:
1. 受信者がEd25519秘密鍵からX25519秘密鍵を導出
2. nacl.box.open(ciphertext, nonce, ephemeral_pubkey, recipient_x25519_secret)
```

### 5.2 選択的開示 (View Key)

```typescript
ViewKey {
  ownerPubKeyHash: string  // 所有者の公開鍵ハッシュ
  viewSecret: string       // X25519秘密鍵（hex）
  label: string            // ラベル（例: "auditor-2025"）
  validFrom?: number       // 有効期間開始
  validUntil?: number      // 有効期間終了
}
```

- ユーザーがview keyを第三者に提供
- 第三者はview keyでメモを復号し、取引内容を検証
- ネットワーク全体の匿名化ではなく「本人の同意による開示」

### 5.3 アドレス分離

- ウォレットSDKで用途別アドレスを自動生成
- マスターシードから派生: `SHA-256(masterSeed || index)`
- 同一アドレス再利用時に警告表示（usageCount > 3）

---

## 6. 合意アルゴリズム (最小BFT)

### 6.1 概要

- バリデータ集合: N=4〜16（初期は4）
- ラウンドロビンリーダー選出
- 2/3+1 署名でブロック確定（finality）
- フォーク無し（確定後の巻き戻し無し）

### 6.2 ラウンド流れ

```
1. リーダー選出: proposer = validators[height % N]
2. リーダーがブロック提案 (mempool TXs + coinbase)
3. 各バリデータがブロック検証 → 署名（vote）
4. 署名数 >= floor(2N/3) + 1 でコミット
5. 全ノードにブロック配信
```

### 6.3 ブロック構造

```typescript
Block {
  header: {
    version, height, previousHash, merkleRoot,
    timestamp, proposer, stateRoot
  }
  hash: string             // SHA-256(header)
  transactions: Transaction[]
  signatures: [{           // 2/3+1 バリデータ署名
    validatorPubKey: string
    signature: string
  }]
}
```

---

## 7. P2Pネットワーク

### 7.1 トランスポート

- TCP接続（JSON-line protocol）
- メッセージ区切り: 改行 (`\n`)
- 最大メッセージサイズ: 10MB

### 7.2 メッセージタイプ

| タイプ | 説明 |
|--------|------|
| `handshake` | 接続時の挨拶（chain_id, node_id, version） |
| `handshake_ack` | 挨拶応答 |
| `gossip_tx` | トランザクション伝搬 |
| `gossip_block` | コミット済みブロック伝搬 |
| `propose_block` | ブロック提案 |
| `vote_block` | ブロック投票 |
| `request_blocks` | ブロック要求 |
| `response_blocks` | ブロック応答 |
| `ping` / `pong` | 生存確認 |

### 7.3 DoS対策

- レートリミット: 100メッセージ/秒/ピア
- ピアスコアリング: 不正行為でスコア減少→0で切断
- 最大ピア数: 50

---

## 8. 同期

### 8.1 チェックポイント同期

```
新規ノード参加:
1. 最新checkpointを取得（バリデータ2/3署名付き）
2. UTXO setスナップショットを取得
3. checkpoint以降のブロックを検証して追いつく
```

### 8.2 Pruning

- 直近Nブロック（設定可能、デフォルト1000）
- UTXO set全体は常に保持
- アーカイブノード: 全ブロック保持（別マシン推奨）

---

## 9. ディレクトリ構成

```
misaka-network/
├── src/
│   ├── types/          # 型定義
│   │   └── index.ts
│   ├── utils/          # 暗号化ユーティリティ
│   │   └── crypto.ts
│   ├── core/           # コアロジック
│   │   ├── address.ts      # bech32mアドレス
│   │   ├── fee.ts          # 段階制手数料
│   │   ├── transaction.ts  # TX作成・検証
│   │   ├── blockchain.ts   # ブロック・チェーン
│   │   ├── utxo-store.ts   # UTXO管理
│   │   ├── mempool.ts      # メモプール
│   │   └── node.ts         # ノード統合
│   ├── consensus/      # BFT合意
│   │   └── engine.ts
│   ├── p2p/            # P2Pネットワーク
│   │   └── network.ts
│   ├── wallet/         # ウォレットSDK
│   │   └── sdk.ts
│   ├── cli/            # CLIツール
│   │   └── index.ts
│   └── index.ts        # パブリックAPI
├── tests/
│   ├── unit/           # ユニットテスト
│   │   └── core.test.ts
│   └── integration/    # 統合テスト
│       └── network.test.ts
├── scripts/
│   └── demo.ts         # 4ノードデモ
├── config/
│   └── node0.json      # ノード設定例
├── docs/
│   └── ARCHITECTURE.md # 本ドキュメント
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
└── README.md
```

---

## 10. 将来の拡張ポイント

| 項目 | 状態 | 説明 |
|------|------|------|
| LevelDB/RocksDB | 🔮 予定 | インメモリ→永続化KVストア |
| 委任PoS | 🔮 フェーズ2 | バリデータへのステーキング委任 |
| BLS集約署名 | 🔮 将来 | 個別署名→集約署名 |
| Solanaブリッジ | ✅ 実装済 | Schnorr-Pedersen ZK証明付きブリッジ |
| ガバナンス | 🔮 将来 | fee tier変更の投票メカニズム |
| fee burn/split | 🔮 将来 | burn / validator / treasury 分配 |
| libp2p移行 | 🔮 将来 | TCP→libp2p (NAT traversal等) |
| WebSocket RPC | 🔮 将来 | ブロック・TX購読 |
| アーカイブノード | ✅ 実装済 | 監査封筒復号による完全履歴確認 |
| リング署名 | ✅ 実装済 | SAGリング署名（送信者匿名化） |
| ステルスアドレス | ✅ 実装済 | DKSAP（受信者匿名化） |
| Pedersen commitment | ✅ 実装済 | 金額秘匿化（準同型暗号） |
| Confidential TX | ✅ 実装済 | pruned node: 検証可能 / 平文不可 |

---

## 11. セキュリティ考慮事項

### プライバシー設計（実装済み）
- **リング署名**: SAGリング署名で送信者を4人のデコイに隠蔽
- **ステルスアドレス**: DKSAPによるワンタイム受信アドレス
- **Pedersen commitment**: `C = v·G + r·H` で金額を秘匿
- **Audit envelope**: NaCl box (X25519) でarchive nodeのみ復号可能
- **Schnorr-Pedersen ZK証明**: ブリッジ操作の正当性検証

### pruned node vs archive node
- **pruned node**: リング署名・Pedersen balance・key image検証が可能。送信者/受信者/金額は不明
- **archive node**: audit envelope復号により送信者/受信者/金額を確認可能

### セキュリティ対策
- Ed25519署名による認証
- bech32mによるアドレス破損検出
- coinbase厳格化（type===COINBASE + prevTxId===0 の両方必須）
- 同一ブロック内二重消費防止（intra-block tracking）
- コンセンサス投票署名検証（validator所属 + 署名妥当性）
- RPC 127.0.0.1バインド + archive API認証トークン
- P2Pバッファサイズ制限（DoS防御）
- DoS防御（レートリミット、ピアスコアリング）
- State revert安全性（spentCache）

---

*Misaka Network v0.3.0 - Architecture Document (Security Audit Applied)*
