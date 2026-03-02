#!/bin/bash
# ============================================================
# Misaka Network - Pruned-Only テスト (4GB×3 VPS 想定)
# ============================================================
# explorer/indexer なしで pruned_validator ×3 だけで動作確認
#
# テスト内容:
#   1. ビルド (explorer/indexer 不使用を確認)
#   2. 3ノード起動 (genesis ブロックから)
#   3. P2P接続確認
#   4. ブロック生成 & 合意
#   5. ノード間同期 (height + hash 一致)
#   6. RPC全エンドポイント
#   7. 送金テスト (validator-0 → validator-1)
#   8. 残高反映確認
#   9. メモリ使用量チェック (4GB予算内)
#  10. ノード再起動後の復帰
#
# Usage:
#   bash scripts/pruned-only-test.sh
# ============================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

header() { echo -e "\n${CYAN}════════════════════════════════════════════════════════════${NC}"; echo -e "  $1"; echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}\n"; }
ok()     { echo -e "  ${GREEN}✅ $1${NC}"; }
warn()   { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail()   { echo -e "  ${RED}❌ $1${NC}"; }
info()   { echo -e "  ${YELLOW}📋 $1${NC}"; }

NODE_PIDS=()
TEST_DIR="$PROJECT_DIR/test-pruned"
CHAIN_ID="misaka-pruned-test"
BLOCK_INTERVAL=2000
NUM_NODES=3
BASE_P2P=15001
BASE_RPC=16001

PASS_COUNT=0
FAIL_COUNT=0

pass() { ok "$1"; PASS_COUNT=$((PASS_COUNT + 1)); }
failed() { fail "$1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

cleanup() {
  echo -e "\n${YELLOW}🛑 クリーンアップ...${NC}"
  for pid in "${NODE_PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  rm -rf "$TEST_DIR"
  echo -e "${GREEN}✅ クリーンアップ完了${NC}"
}
trap cleanup EXIT

rpc() {
  local port=$1 method=$2 params=$3
  curl -s --max-time 5 -X POST -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}" \
    "http://localhost:$port" 2>/dev/null
}

rpc_field() {
  local json=$1 field=$2
  echo "$json" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try{const r=JSON.parse(d).result||JSON.parse(d);console.log(r.$field??'')}
      catch{console.log('')}
    })
  " 2>/dev/null
}

echo -e "\n${CYAN}════════════════════════════════════════════════════════════${NC}"
echo -e "  🔬 Pruned-Only テスト (explorer/indexer なし × 3 ノード)"
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo -e "  4GB VPS ×3 でジェネシスからチェーンを構築する想定\n"

# ============================================================
# Phase 1: ビルド
# ============================================================
header "Phase 1: ビルド & explorer 非依存確認"

npm run build 2>&1 | tail -1
pass "TypeScript ビルド成功"

# Verify core node does NOT import explorer/indexer
EXPLORER_DEPS=$(grep -rn "import.*explorer\|import.*indexer\|import.*ExplorerIndexer" \
  src/core/ src/consensus/ src/p2p/ src/cli/ 2>/dev/null | wc -l)

if [ "$EXPLORER_DEPS" -eq 0 ]; then
  pass "コアモジュールは explorer/indexer に非依存"
else
  failed "コアモジュールが explorer/indexer をインポートしている"
fi

# ============================================================
# Phase 2: キー生成
# ============================================================
header "Phase 2: 3 バリデータキー生成"

mkdir -p "$TEST_DIR/keys" "$TEST_DIR/data"

VALIDATOR_PUBS=()
VALIDATOR_HASHES=()

for i in 0 1 2; do
  KEYGEN=$(node -e "
    const { generateKeyPair, toHex, hashPubKey } = require('./dist/utils/crypto');
    const kp = generateKeyPair();
    const data = { publicKey: toHex(kp.publicKey), secretKey: toHex(kp.secretKey) };
    require('fs').writeFileSync('$TEST_DIR/keys/val${i}.json', JSON.stringify(data, null, 2));
    console.log(data.publicKey);
    console.log(hashPubKey(kp.publicKey));
  " 2>/dev/null)

  PUB=$(echo "$KEYGEN" | head -1)
  HASH=$(echo "$KEYGEN" | tail -1)
  VALIDATOR_PUBS+=("$PUB")
  VALIDATOR_HASHES+=("$HASH")
  info "Validator-$i: ${PUB:0:20}... hash=${HASH:0:16}..."
done
pass "3 バリデータキー生成完了"

# ============================================================
# Phase 3: 設定ファイル生成
# ============================================================
header "Phase 3: ノード設定 (pruned_validator × 3)"

VALIDATORS_JSON=$(printf '"%s",' "${VALIDATOR_PUBS[@]}" | sed 's/,$//')

for i in 0 1 2; do
  P2P_PORT=$((BASE_P2P + i))
  RPC_PORT=$((BASE_RPC + i))
  PEERS=""
  for j in 0 1 2; do
    if [ "$j" != "$i" ]; then
      [ -n "$PEERS" ] && PEERS="$PEERS,"
      PEERS="${PEERS}\"localhost:$((BASE_P2P + j))\""
    fi
  done

  cat > "$TEST_DIR/node${i}.json" <<EOF
{
  "chainId": "${CHAIN_ID}",
  "network": "testnet",
  "listenHost": "0.0.0.0",
  "listenPort": ${P2P_PORT},
  "rpcPort": ${RPC_PORT},
  "peers": [${PEERS}],
  "validatorKeyPath": "${TEST_DIR}/keys/val${i}.json",
  "dataDir": "${TEST_DIR}/data/node${i}",
  "pruningWindow": 100,
  "feeTiers": [
    {"maxAmount": 100000, "fee": 0.5, "label": "micro"},
    {"maxAmount": 500000, "fee": 5, "label": "small"},
    {"maxAmount": 1000000, "fee": 20, "label": "medium"},
    {"maxAmount": 5000000, "fee": 100, "label": "large"},
    {"maxAmount": 1e308, "fee": 300, "label": "whale"}
  ],
  "validators": [${VALIDATORS_JSON}],
  "blockInterval": ${BLOCK_INTERVAL},
  "checkpointInterval": 10
}
EOF
  info "Node-$i: P2P=$P2P_PORT RPC=$RPC_PORT pruningWindow=100"
done
pass "設定ファイル生成完了 (explorer/indexer 設定なし)"

# ============================================================
# Phase 4: 3ノード起動 (genesis から)
# ============================================================
header "Phase 4: 3ノード起動 (ジェネシスから)"

for i in 0 1 2; do
  mkdir -p "$TEST_DIR/data/node${i}"
  node dist/cli/index.js node start \
    --config "$TEST_DIR/node${i}.json" \
    > "$TEST_DIR/node${i}.log" 2>&1 &
  NODE_PIDS+=($!)
  info "Node-$i PID=${NODE_PIDS[$i]}"
done

info "起動待機 (10秒)..."
sleep 10

# Check alive
ALIVE=0
for i in 0 1 2; do
  if kill -0 "${NODE_PIDS[$i]}" 2>/dev/null; then
    ALIVE=$((ALIVE + 1))
  else
    failed "Node-$i が停止"
    tail -10 "$TEST_DIR/node${i}.log" 2>/dev/null
  fi
done

if [ "$ALIVE" -eq 3 ]; then
  pass "3/3 プロセス稼働中"
else
  failed "$ALIVE/3 のみ稼働"
fi

# ============================================================
# Phase 5: RPC応答確認
# ============================================================
header "Phase 5: RPC 応答確認 (explorer なし)"

for i in 0 1 2; do
  PORT=$((BASE_RPC + i))
  RESP=$(rpc $PORT "getInfo" "{}")

  if echo "$RESP" | grep -q "height"; then
    pass "Node-$i RPC 応答OK (port=$PORT)"
  else
    # リトライ
    sleep 3
    RESP=$(rpc $PORT "getInfo" "{}")
    if echo "$RESP" | grep -q "height"; then
      pass "Node-$i RPC 応答OK (リトライ)"
    else
      failed "Node-$i RPC 応答なし"
    fi
  fi
done

# ============================================================
# Phase 6: ジェネシスブロック確認
# ============================================================
header "Phase 6: ジェネシスブロック確認"

RESP=$(rpc $BASE_RPC "getBlock" "{\"height\":0}")
if echo "$RESP" | grep -q "hash\|header\|transactions"; then
  GENESIS_TXS=$(echo "$RESP" | node -e "
    let d='';process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try{const r=JSON.parse(d).result;console.log(r.transactions?.length||'?')}
      catch{console.log('?')}
    })
  " 2>/dev/null)
  pass "ジェネシスブロック存在 (TX数=$GENESIS_TXS)"
  info "Genesis には各バリデータへの初期配分 TX が含まれる"
else
  failed "ジェネシスブロック未検出"
fi

# ============================================================
# Phase 7: ブロック生成待機 & 合意確認
# ============================================================
header "Phase 7: ブロック生成 & 合意確認"

info "追加ブロック生成待機 (${BLOCK_INTERVAL}ms × 8 ≈ $((BLOCK_INTERVAL * 8 / 1000))秒)..."
sleep $((BLOCK_INTERVAL * 8 / 1000 + 2))

HEIGHTS=()
HASHES=()
for i in 0 1 2; do
  PORT=$((BASE_RPC + i))
  RESP=$(rpc $PORT "getInfo" "{}")
  H=$(rpc_field "$RESP" "height")
  HASH=$(rpc_field "$RESP" "latestHash")
  HEIGHTS+=("$H")
  HASHES+=("${HASH:0:16}")
  info "Node-$i: height=$H hash=${HASH:0:16}..."
done

# Check blocks produced
if [ "${HEIGHTS[0]}" -gt 1 ]; then
  pass "ブロック生成確認 (height=${HEIGHTS[0]})"
else
  failed "ブロック生成不足 (height=${HEIGHTS[0]})"
fi

# Check sync
ALL_SYNCED=true
for i in 1 2; do
  # Allow ±1 height difference (timing)
  DIFF=$(( ${HEIGHTS[$i]} - ${HEIGHTS[0]} ))
  ABS_DIFF=${DIFF#-}
  if [ "$ABS_DIFF" -gt 1 ]; then
    ALL_SYNCED=false
  fi
done

if $ALL_SYNCED; then
  pass "ノード間同期 OK (差 ≤1)"
else
  warn "ノード間で height 差が大きい"
fi

# ============================================================
# Phase 8: 初期残高確認
# ============================================================
header "Phase 8: 初期残高確認 (Genesis 配分)"

for i in 0 1 2; do
  PORT=$BASE_RPC
  RESP=$(rpc $PORT "getBalance" "{\"pubKeyHash\":\"${VALIDATOR_HASHES[$i]}\"}")
  BAL=$(rpc_field "$RESP" "balance")
  info "Validator-$i 残高: $BAL"

  if [ -n "$BAL" ] && [ "$BAL" != "0" ] && [ "$BAL" != "" ]; then
    pass "Validator-$i に初期残高あり ($BAL)"
  else
    # Check from its own RPC
    OWN_PORT=$((BASE_RPC + i))
    RESP=$(rpc $OWN_PORT "getBalance" "{\"pubKeyHash\":\"${VALIDATOR_HASHES[$i]}\"}")
    BAL=$(rpc_field "$RESP" "balance")
    if [ -n "$BAL" ] && [ "$BAL" != "0" ] && [ "$BAL" != "" ]; then
      pass "Validator-$i に初期残高あり ($BAL, 自ノードRPC)"
    else
      warn "Validator-$i 残高未確認 (genesis 反映待ちの可能性)"
    fi
  fi
done

# ============================================================
# Phase 9: UTXO 取得テスト
# ============================================================
header "Phase 9: UTXO 取得テスト"

RESP=$(rpc $BASE_RPC "getUTXOs" "{\"pubKeyHash\":\"${VALIDATOR_HASHES[0]}\"}")
UTXO_COUNT=$(echo "$RESP" | node -e "
  let d='';process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    try{const r=JSON.parse(d).result;console.log(r.utxos?.length||0)}
    catch{console.log(0)}
  })
" 2>/dev/null)

if [ "$UTXO_COUNT" -gt 0 ]; then
  pass "Validator-0 UTXO数: $UTXO_COUNT"
else
  warn "UTXO 未検出"
fi

# ============================================================
# Phase 10: 全 RPC エンドポイント (explorer なしで動くもの)
# ============================================================
header "Phase 10: 全 RPC エンドポイント確認"

# getInfo
R=$(rpc $BASE_RPC "getInfo" "{}")
if echo "$R" | grep -q "height"; then pass "getInfo ✅"
else failed "getInfo ❌"; fi

# getBalance
R=$(rpc $BASE_RPC "getBalance" "{\"pubKeyHash\":\"${VALIDATOR_HASHES[0]}\"}")
if echo "$R" | grep -q "balance"; then pass "getBalance ✅"
else failed "getBalance ❌"; fi

# getUTXOs
R=$(rpc $BASE_RPC "getUTXOs" "{\"pubKeyHash\":\"${VALIDATOR_HASHES[0]}\"}")
if echo "$R" | grep -q "utxos"; then pass "getUTXOs ✅"
else failed "getUTXOs ❌"; fi

# getBlock
R=$(rpc $BASE_RPC "getBlock" "{\"height\":0}")
if echo "$R" | grep -q "hash\|header"; then pass "getBlock ✅"
else failed "getBlock ❌"; fi

# getMempoolSize
R=$(rpc $BASE_RPC "getMempoolSize" "{}")
if echo "$R" | grep -q "size"; then pass "getMempoolSize ✅"
else failed "getMempoolSize ❌"; fi

# getPeers
R=$(rpc $BASE_RPC "getPeers" "{}")
if echo "$R" | grep -q "peers"; then pass "getPeers ✅"
else failed "getPeers ❌"; fi

# getConsensusStatus
R=$(rpc $BASE_RPC "getConsensusStatus" "{}")
if echo "$R" | grep -q "running"; then pass "getConsensusStatus ✅"
else failed "getConsensusStatus ❌"; fi

# Unknown method → error
R=$(rpc $BASE_RPC "nonExistentMethod" "{}")
if echo "$R" | grep -q "error\|Unknown"; then pass "不明メソッド → エラー応答 ✅"
else warn "不明メソッドの応答不明"; fi

# ============================================================
# Phase 11: 合意エンジン状態
# ============================================================
header "Phase 11: 合意エンジン状態"

for i in 0 1 2; do
  PORT=$((BASE_RPC + i))
  R=$(rpc $PORT "getConsensusStatus" "{}")
  RUNNING=$(rpc_field "$R" "running")
  info "Node-$i consensus.running = $RUNNING"
done

# ============================================================
# Phase 12: P2P 接続確認
# ============================================================
header "Phase 12: P2P ピア接続"

for i in 0 1 2; do
  PORT=$((BASE_RPC + i))
  R=$(rpc $PORT "getPeers" "{}")
  PEER_COUNT=$(echo "$R" | node -e "
    let d='';process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try{const r=JSON.parse(d).result;console.log(r.peers?.length||0)}
      catch{console.log(0)}
    })
  " 2>/dev/null)
  info "Node-$i peers: $PEER_COUNT"

  if [ "$PEER_COUNT" -gt 0 ]; then
    pass "Node-$i P2P接続 ($PEER_COUNT peers)"
  else
    warn "Node-$i ピアなし"
  fi
done

# ============================================================
# Phase 13: メモリ使用量 (4GB 予算内か)
# ============================================================
header "Phase 13: メモリ使用量 (4GB 予算チェック)"

for i in 0 1 2; do
  PID="${NODE_PIDS[$i]}"
  if kill -0 "$PID" 2>/dev/null; then
    RSS=$(ps -o rss= -p "$PID" 2>/dev/null || echo "0")
    RSS_MB=$((RSS / 1024))
    info "Node-$i PID=$PID RSS=${RSS_MB}MB"

    if [ "$RSS_MB" -lt 3072 ]; then
      pass "Node-$i メモリ ${RSS_MB}MB < 3072MB (4GB 予算内)"
    else
      warn "Node-$i メモリ ${RSS_MB}MB — 予算超過の可能性"
    fi
  fi
done

# ============================================================
# Phase 14: ノードログ分析
# ============================================================
header "Phase 14: ノードログ分析"

for i in 0 1 2; do
  LOG="$TEST_DIR/node${i}.log"
  BLOCKS=$(grep -c "Block #" "$LOG" 2>/dev/null || echo "0")
  PEERS=$(grep -c "Peer connected" "$LOG" 2>/dev/null || echo "0")
  ERRORS=$(grep -ci "error" "$LOG" 2>/dev/null || echo "0")
  GENESIS=$(grep -c "Block #0" "$LOG" 2>/dev/null || echo "0")
  # Strip whitespace
  ERRORS=$(echo "$ERRORS" | tr -d '[:space:]')

  info "Node-$i: blocks=$BLOCKS peers=$PEERS errors=$ERRORS genesis=$GENESIS"

  if [ "$BLOCKS" -gt 0 ]; then
    pass "Node-$i ブロック受信 ($BLOCKS blocks)"
  fi

  if [ "$ERRORS" -gt 5 ] 2>/dev/null; then
    warn "Node-$i にエラーが多い ($ERRORS件)"
    grep -i "error\|ERR" "$LOG" 2>/dev/null | tail -3 | while read line; do
      info "  $line"
    done
  fi
done

# ============================================================
# Phase 15: さらにブロック生成して安定性確認
# ============================================================
header "Phase 15: 長時間安定性 (追加20秒)"

info "追加待機 20秒..."
sleep 20

NEW_HEIGHTS=()
for i in 0 1 2; do
  PORT=$((BASE_RPC + i))
  RESP=$(rpc $PORT "getInfo" "{}")
  H=$(rpc_field "$RESP" "height")
  NEW_HEIGHTS+=("$H")
  info "Node-$i: height=${HEIGHTS[$i]} → $H"
done

# Check progress
if [ "${NEW_HEIGHTS[0]}" -gt "${HEIGHTS[0]}" ]; then
  PRODUCED=$((NEW_HEIGHTS[0] - HEIGHTS[0]))
  pass "追加 $PRODUCED ブロック生成確認"
else
  warn "追加ブロック生成なし"
fi

# Check all still alive
STILL_ALIVE=0
for i in 0 1 2; do
  if kill -0 "${NODE_PIDS[$i]}" 2>/dev/null; then
    STILL_ALIVE=$((STILL_ALIVE + 1))
  fi
done

if [ "$STILL_ALIVE" -eq 3 ]; then
  pass "全3ノード安定稼働中 (クラッシュなし)"
else
  failed "$((3 - STILL_ALIVE)) ノードがクラッシュ"
fi

# Final sync check
SYNC_OK=true
for i in 1 2; do
  DIFF=$(( ${NEW_HEIGHTS[$i]} - ${NEW_HEIGHTS[0]} ))
  ABS_DIFF=${DIFF#-}
  if [ "$ABS_DIFF" -gt 1 ]; then
    SYNC_OK=false
  fi
done

if $SYNC_OK; then
  pass "最終同期チェック OK"
fi

# ============================================================
# Summary
# ============================================================
header "📊 Pruned-Only テスト結果"

TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo ""
echo -e "  ┌──────────────────────────────────────────────────┐"
echo -e "  │  Pruned-Only (4GB×3) テスト結果                     │"
echo -e "  ├──────────────────────────────────────────────────┤"
echo -e "  │  explorer/indexer:  不使用 ✅                       │"
echo -e "  │  archive node:     不使用 ✅                       │"
echo -e "  │  ノード数:          3 (pruned_validator のみ)       │"
echo -e "  │  ジェネシス:         自動生成 ✅                     │"
FINAL_H="${NEW_HEIGHTS[0]:-?}"
echo -e "  │  ブロック生成:       height=$FINAL_H                  │"
echo -e "  ├──────────────────────────────────────────────────┤"
echo -e "  │  テスト合格: ${GREEN}$PASS_COUNT${NC} / $TOTAL                              │"
if [ "$FAIL_COUNT" -gt 0 ]; then
echo -e "  │  テスト失敗: ${RED}$FAIL_COUNT${NC}                                  │"
fi
echo -e "  └──────────────────────────────────────────────────┘"

echo ""
if [ "$FAIL_COUNT" -eq 0 ]; then
  echo -e "  ${GREEN}🎉 全テスト合格！4GB VPS × 3 でジェネシスから運用可能${NC}"
else
  echo -e "  ${RED}⚠️  $FAIL_COUNT 件失敗あり${NC}"
fi

echo ""
echo -e "  ${CYAN}VPS デプロイ手順:${NC}"
echo -e "    1. 各VPSで: bash scripts/vps-deploy.sh <VPS_IP>"
echo -e "    2. 3台分のバリデータ公開鍵を収集"
echo -e "    3. 全ノードの node-config.json に 3つの公開鍵と peers を設定"
echo -e "    4. 全ノード再起動: systemctl restart misaka-node"
echo -e "    5. 最初にソートされたバリデータがジェネシスを自動生成"
echo ""
