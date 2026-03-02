#!/bin/bash
# ============================================================
# Misaka Network - ヘルスチェック
# ============================================================
# VPS上で実行: ./scripts/healthcheck.sh [RPC_PORT]
# ============================================================

RPC_PORT="${1:-3001}"
RPC_URL="http://localhost:${RPC_PORT}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

rpc() {
  curl -s -m 3 -X POST -H "Content-Type: application/json" \
    -d "{\"method\":\"$1\",\"params\":$2}" \
    "$RPC_URL" 2>/dev/null
}

echo "════════════════════════════════════════"
echo "  Misaka Network ヘルスチェック"
echo "  RPC: $RPC_URL"
echo "  $(date)"
echo "════════════════════════════════════════"

# 1. RPC alive
INFO=$(rpc "getInfo" "{}")
if echo "$INFO" | grep -q "chainId\|height" 2>/dev/null; then
  echo -e "  ${GREEN}✅ RPC 応答OK${NC}"
  HEIGHT=$(echo "$INFO" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.height||d.result?.height||-1)}catch{console.log(-1)}" 2>/dev/null)
  CHAIN=$(echo "$INFO" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.chainId||d.result?.chainId||'?')}catch{console.log('?')}" 2>/dev/null)
  echo "     Chain:  $CHAIN"
  echo "     Height: $HEIGHT"
else
  echo -e "  ${RED}❌ RPC 未応答${NC}"
fi

# 2. Mempool
MP=$(rpc "getMempoolSize" "{}")
echo "     Mempool: $(echo "$MP" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.size||d.result?.size||d.mempoolSize||0)}catch{console.log('?')}" 2>/dev/null) txs"

# 3. Peers
PEERS=$(rpc "getPeers" "{}")
PEER_COUNT=$(echo "$PEERS" | node -e "try{const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));const p=d.peers||d.result?.peers||[];console.log(p.length)}catch{console.log(0)}" 2>/dev/null)
echo "     Peers:  $PEER_COUNT connected"

# 4. System
echo ""
echo "  System:"
echo "     RAM:    $(free -h | awk '/Mem:/{printf "%s / %s (%s used)", $3, $2, $3}')"
echo "     Disk:   $(df -h / | awk 'NR==2{printf "%s / %s (%s)", $3, $2, $5}')"
echo "     Load:   $(uptime | awk -F'load average:' '{print $2}' | xargs)"

# 5. Process
PID=$(pgrep -f "misaka.*cli\|node.*dist/cli" | head -1)
if [ -n "$PID" ]; then
  RSS=$(ps -o rss= -p "$PID" 2>/dev/null | xargs)
  echo -e "  ${GREEN}✅ Process PID=$PID RSS=${RSS}KB ($((RSS/1024))MB)${NC}"
else
  echo -e "  ${RED}❌ プロセスが見つかりません${NC}"
fi

# 6. Block production rate
if [ "$HEIGHT" -gt 0 ]; then
  echo ""
  echo -e "  ${GREEN}✅ ノード稼働中 (height=$HEIGHT)${NC}"
else
  echo ""
  echo -e "  ${YELLOW}⚠️  ブロック未生成${NC}"
fi

echo "════════════════════════════════════════"
