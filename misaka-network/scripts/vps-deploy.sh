#!/bin/bash
# ============================================================
# Misaka Network - 4GB VPS デプロイ (Pruned Validator)
# ============================================================
# Usage:
#   ./scripts/vps-deploy.sh <VPS_IP> [SSH_USER] [SSH_PORT]
#
# Example:
#   ./scripts/vps-deploy.sh 203.0.113.50 root 22
#   ./scripts/vps-deploy.sh my-vps.example.com ubuntu
#
# Prerequisites:
#   - SSH鍵認証でVPSにログインできること
#   - VPSのOS: Ubuntu 22.04+ / Debian 12+
#   - 最低RAM: 4GB (推奨)
#   - 最低Disk: 20GB
# ============================================================
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

header() { echo -e "\n${CYAN}════════════════════════════════════════════════════${NC}"; echo -e "${CYAN}  $1${NC}"; echo -e "${CYAN}════════════════════════════════════════════════════${NC}"; }
ok()     { echo -e "  ${GREEN}✅ $1${NC}"; }
warn()   { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail()   { echo -e "  ${RED}❌ $1${NC}"; exit 1; }
info()   { echo -e "  📋 $1"; }

# ── Args ──
VPS_IP="${1:?Usage: $0 <VPS_IP> [SSH_USER] [SSH_PORT]}"
SSH_USER="${2:-deploy}"
SSH_PORT="${3:-22}"
SSH_CMD="ssh -o StrictHostKeyChecking=accept-new -p $SSH_PORT $SSH_USER@$VPS_IP"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

REMOTE_DIR="/opt/misaka-network"
SERVICE_NAME="misaka-node"
P2P_PORT=4001
RPC_PORT=3001
CHAIN_ID="misaka-testnet-1"

header "🚀 Misaka Network — VPS デプロイ"
info "VPS:      $SSH_USER@$VPS_IP:$SSH_PORT"
info "Remote:   $REMOTE_DIR"
info "Role:     pruned_validator (4GB)"
info "P2P:      $P2P_PORT"
info "RPC:      $RPC_PORT"

# ============================================================
# Phase 1: VPS接続テスト + 環境チェック
# ============================================================
header "Phase 1: VPS 接続 & 環境チェック"

info "SSH接続テスト..."
$SSH_CMD "echo OK" >/dev/null 2>&1 || fail "SSH接続失敗: $SSH_USER@$VPS_IP:$SSH_PORT"
ok "SSH接続成功"

info "システム情報取得..."
VPS_INFO=$($SSH_CMD "
  echo \"OS:     \$(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"')\"
  echo \"RAM:    \$(free -h 2>/dev/null | awk '/Mem:/{print \$2}' || echo 'unknown')\"
  echo \"Disk:   \$(df -h / 2>/dev/null | awk 'NR==2{print \$4}' || echo 'unknown') available\"
  echo \"CPU:    \$(nproc 2>/dev/null || echo '?') cores\"
")
echo "$VPS_INFO" | while read line; do info "$line"; done

# Check RAM >= 3GB
RAM_KB=$($SSH_CMD "grep MemTotal /proc/meminfo | awk '{print \$2}'" 2>/dev/null || echo "0")
if [ "$RAM_KB" -lt 3000000 ]; then
  fail "RAM不足: ${RAM_KB}KB (最低3GB必要)"
fi
ok "RAM OK: $((RAM_KB / 1024))MB"

# ============================================================
# Phase 2: Node.js インストール
# ============================================================
header "Phase 2: Node.js セットアップ"

info "Node.js チェック..."
NODE_VER=$($SSH_CMD "node --version 2>/dev/null" || echo "none")

if [[ "$NODE_VER" == v2* ]] || [[ "$NODE_VER" == v1[89]* ]]; then
  ok "Node.js $NODE_VER 検出済み"
else
  info "Node.js 20.x をインストール中..."
  $SSH_CMD "
    apt-get update -qq && apt-get install -y -qq curl ca-certificates gnupg
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main' | tee /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq && apt-get install -y -qq nodejs
  " 2>&1 | tail -3
  NODE_VER=$($SSH_CMD "node --version")
  ok "Node.js $NODE_VER インストール完了"
fi

# ============================================================
# Phase 3: プロジェクトをアップロード
# ============================================================
header "Phase 3: プロジェクトアップロード"

info "アーカイブ作成中..."
cd "$PROJECT_DIR"
tar czf /tmp/misaka-network.tar.gz \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='test-local' \
  --exclude='.git' \
  -C "$(dirname "$PROJECT_DIR")" "$(basename "$PROJECT_DIR")"

SIZE=$(du -h /tmp/misaka-network.tar.gz | cut -f1)
info "アーカイブサイズ: $SIZE"

info "VPSへ転送中..."
scp -o StrictHostKeyChecking=accept-new -P "$SSH_PORT" \
  /tmp/misaka-network.tar.gz \
  "$SSH_USER@$VPS_IP:/tmp/misaka-network.tar.gz"

info "展開中..."
$SSH_CMD "
  # Safety guard: only remove if path matches expected pattern
  if [ '$REMOTE_DIR' != '/opt/misaka-network' ]; then
    echo 'ERROR: REMOTE_DIR mismatch, aborting' && exit 1
  fi
  rm -rf $REMOTE_DIR
  mkdir -p $REMOTE_DIR
  tar xzf /tmp/misaka-network.tar.gz -C /opt/ --strip-components=0
  # Rename if needed
  if [ ! -d $REMOTE_DIR ]; then
    mv /opt/misaka-network* $REMOTE_DIR 2>/dev/null || true
  fi
  rm -f /tmp/misaka-network.tar.gz
"
ok "アップロード完了"

# ============================================================
# Phase 4: 依存関係インストール & ビルド
# ============================================================
header "Phase 4: npm install & build"

info "npm install... (少し時間がかかります)"
$SSH_CMD "cd $REMOTE_DIR && npm install --production=false 2>&1" | tail -3
ok "npm install 完了"

info "TypeScript ビルド..."
$SSH_CMD "cd $REMOTE_DIR && npx tsc 2>&1" | tail -3
ok "ビルド完了"

# ============================================================
# Phase 5: バリデータキー生成
# ============================================================
header "Phase 5: バリデータキー生成"

$SSH_CMD "
  mkdir -p $REMOTE_DIR/keys $REMOTE_DIR/data
  cd $REMOTE_DIR

  # Generate key if not exists
  if [ ! -f keys/validator.json ]; then
    node -e \"
      const { generateKeyPair, toHex } = require('./dist/utils/crypto');
      const kp = generateKeyPair();
      const data = { publicKey: toHex(kp.publicKey), secretKey: toHex(kp.secretKey) };
      require('fs').writeFileSync('keys/validator.json', JSON.stringify(data, null, 2));
      console.log('PUBLIC_KEY=' + data.publicKey);
    \"
  else
    echo 'PUBLIC_KEY=' + \$(node -e \"console.log(JSON.parse(require('fs').readFileSync('keys/validator.json','utf8')).publicKey)\")
  fi
"

VALIDATOR_PUB=$($SSH_CMD "cd $REMOTE_DIR && node -e \"console.log(JSON.parse(require('fs').readFileSync('keys/validator.json','utf8')).publicKey)\"")
info "Validator Public Key: ${VALIDATOR_PUB:0:32}..."
ok "キー生成完了"

# ============================================================
# Phase 6: ノード設定ファイル生成
# ============================================================
header "Phase 6: ノード設定"

$SSH_CMD "cat > $REMOTE_DIR/node-config.json << 'NODEEOF'
{
  \"chainId\": \"$CHAIN_ID\",
  \"network\": \"testnet\",
  \"listenHost\": \"0.0.0.0\",
  \"listenPort\": $P2P_PORT,
  \"rpcPort\": $RPC_PORT,
  \"peers\": [],
  \"validatorKeyPath\": \"$REMOTE_DIR/keys/validator.json\",
  \"dataDir\": \"$REMOTE_DIR/data\",
  \"pruningWindow\": 1000,
  \"feeTiers\": [
    {\"maxAmount\": 100000,  \"fee\": 0.5, \"label\": \"micro\"},
    {\"maxAmount\": 500000,  \"fee\": 5,   \"label\": \"small\"},
    {\"maxAmount\": 1000000, \"fee\": 20,  \"label\": \"medium\"},
    {\"maxAmount\": 5000000, \"fee\": 100, \"label\": \"large\"},
    {\"maxAmount\": 1e308,   \"fee\": 300, \"label\": \"whale\"}
  ],
  \"validators\": [\"$VALIDATOR_PUB\"],
  \"blockInterval\": 5000,
  \"checkpointInterval\": 100
}
NODEEOF"

info "設定ファイル: $REMOTE_DIR/node-config.json"
ok "設定完了"

# ============================================================
# Phase 7: systemd サービス登録
# ============================================================
header "Phase 7: systemd サービス"

$SSH_CMD "cat > /etc/systemd/system/${SERVICE_NAME}.service << 'SVCEOF'
[Unit]
Description=Misaka Network Pruned Validator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=misaka
WorkingDirectory=$REMOTE_DIR
ExecStart=/usr/bin/node $REMOTE_DIR/dist/cli/index.js node start --config $REMOTE_DIR/node-config.json
Restart=always
RestartSec=5
LimitNOFILE=65535

# Memory limit for 4GB VPS
MemoryMax=3G
MemoryHigh=2560M

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=misaka-node

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}
"
ok "systemd サービス登録完了"

# ============================================================
# Phase 8: ファイアウォール設定
# ============================================================
header "Phase 8: ファイアウォール"

$SSH_CMD "
  if command -v ufw >/dev/null 2>&1; then
    ufw allow $P2P_PORT/tcp comment 'Misaka P2P' 2>/dev/null || true
    ufw allow $RPC_PORT/tcp comment 'Misaka RPC' 2>/dev/null || true
    echo 'ufw: ports $P2P_PORT, $RPC_PORT opened'
  elif command -v firewall-cmd >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port=$P2P_PORT/tcp 2>/dev/null || true
    firewall-cmd --permanent --add-port=$RPC_PORT/tcp 2>/dev/null || true
    firewall-cmd --reload 2>/dev/null || true
    echo 'firewalld: ports opened'
  else
    echo 'No firewall detected (iptables only) — ensure ports $P2P_PORT, $RPC_PORT are open'
  fi
" 2>&1 | while read line; do info "$line"; done
ok "ファイアウォール設定完了"

# ============================================================
# Phase 9: ノード起動 & テスト
# ============================================================
header "Phase 9: ノード起動"

info "misaka-node サービス開始..."
$SSH_CMD "systemctl restart ${SERVICE_NAME}"
ok "サービス起動"

info "起動待機 (5秒)..."
sleep 5

info "ヘルスチェック..."
HEALTH=$($SSH_CMD "curl -s --max-time 5 -X POST -H 'Content-Type: application/json' \
  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getInfo\",\"params\":{}}' \
  http://localhost:${RPC_PORT} 2>/dev/null" || echo "FAIL")

if echo "$HEALTH" | grep -q "height"; then
  ok "RPC応答 ✅"
  info "Response: $(echo "$HEALTH" | head -c 200)"
else
  warn "RPC未応答 — ログを確認: journalctl -u $SERVICE_NAME -n 50"
  $SSH_CMD "journalctl -u ${SERVICE_NAME} -n 20 --no-pager" 2>&1 | tail -10
fi

# ============================================================
# Phase 10: ユニットテスト on VPS
# ============================================================
header "Phase 10: VPS上でユニットテスト"

info "テスト実行中... (メモリ制限のため時間がかかる場合があります)"
VPS_TEST=$($SSH_CMD "cd $REMOTE_DIR && NODE_OPTIONS='--max-old-space-size=2048' npx jest --forceExit --detectOpenHandles 2>&1" || echo "FAIL")
VPS_TEST_COUNT=$(echo "$VPS_TEST" | grep "Tests:" | head -1)
VPS_PASS=$(echo "$VPS_TEST" | grep -c "PASS" || true)
VPS_FAIL=$(echo "$VPS_TEST" | grep -c "FAIL" || true)

if [ "$VPS_FAIL" -gt 0 ]; then
  warn "テスト失敗あり"
  echo "$VPS_TEST" | grep -E "FAIL|Tests:" | head -10
else
  ok "VPSテスト合格: $VPS_TEST_COUNT"
fi

# ============================================================
# Phase 11: メモリ使用量チェック
# ============================================================
header "Phase 11: メモリ使用量"

MEM_INFO=$($SSH_CMD "
  echo '--- System ---'
  free -h | head -2
  echo '--- Node Process ---'
  ps aux | grep 'misaka\|node.*cli' | grep -v grep | awk '{printf \"PID=%-6s RSS=%-8s VSZ=%-8s CMD=%s\n\", \$2, \$6, \$5, \$11}' || echo 'Process not found'
  echo '--- Top Memory ---'
  ps aux --sort=-%mem | head -6
")
echo "$MEM_INFO" | while read line; do info "$line"; done

# ============================================================
# Summary
# ============================================================
header "📊 VPS デプロイ結果"

echo -e "  ${GREEN}VPS:             $VPS_IP${NC}"
echo -e "  ${GREEN}Node.js:         $NODE_VER${NC}"
echo -e "  ${GREEN}Role:            pruned_validator (4GB)${NC}"
echo -e "  ${GREEN}Validator:       ${VALIDATOR_PUB:0:32}...${NC}"
echo -e "  ${GREEN}P2P:             $VPS_IP:$P2P_PORT${NC}"
echo -e "  ${GREEN}RPC:             http://$VPS_IP:$RPC_PORT${NC}"
echo -e "  ${GREEN}Service:         systemctl status $SERVICE_NAME${NC}"
echo -e "  ${GREEN}Logs:            journalctl -u $SERVICE_NAME -f${NC}"
echo ""
echo -e "  ${CYAN}運用コマンド:${NC}"
echo -e "    systemctl status  $SERVICE_NAME    # ステータス確認"
echo -e "    systemctl restart $SERVICE_NAME    # 再起動"
echo -e "    systemctl stop    $SERVICE_NAME    # 停止"
echo -e "    journalctl -u $SERVICE_NAME -f     # ログ監視"
echo ""
echo -e "  ${CYAN}RPC テスト:${NC}"
echo -e "    curl -X POST -H 'Content-Type: application/json' \\"
echo -e "      -d '{\"method\":\"getInfo\",\"params\":{}}' \\"
echo -e "      http://$VPS_IP:$RPC_PORT"
echo ""
echo -e "  ${CYAN}ピア追加 (他ノードと接続する場合):${NC}"
echo -e "    node-config.json の peers に追加:"
echo -e "    \"peers\": [\"<OTHER_VPS_IP>:4001\"]"
echo -e "    systemctl restart $SERVICE_NAME"

echo -e "\n${GREEN}════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  🎉 VPS デプロイ完了！${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════${NC}\n"
