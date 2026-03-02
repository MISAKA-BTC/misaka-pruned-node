#!/bin/bash
# ============================================================
# Misaka Network - 3台 VPS デプロイ (4GB × 3 Pruned Validator)
# ============================================================
# Usage:
#   ./scripts/vps-3node-deploy.sh <VPS1_IP> <VPS2_IP> <VPS3_IP> [SSH_USER] [SSH_PORT]
#
# Example:
#   ./scripts/vps-3node-deploy.sh 1.2.3.4 5.6.7.8 9.10.11.12 root 22
#
# Prerequisites:
#   - 3台すべてにSSH鍵認証でログイン可能
#   - OS: Ubuntu 22.04+ / Debian 12+
#   - RAM: 4GB以上 (各VPS)
#   - explorer/indexer 不要 — pruned_validator のみ
# ============================================================
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

header() { echo -e "\n${CYAN}════════════════════════════════════════════════════════════${NC}"; echo -e "  $1"; echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}\n"; }
ok()     { echo -e "  ${GREEN}✅ $1${NC}"; }
warn()   { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail()   { echo -e "  ${RED}❌ $1${NC}"; exit 1; }
info()   { echo -e "  ${YELLOW}📋 $1${NC}"; }

# ── Args ──
VPS1="${1:?Usage: $0 <VPS1_IP> <VPS2_IP> <VPS3_IP> [SSH_USER] [SSH_PORT]}"
VPS2="${2:?Usage: $0 <VPS1_IP> <VPS2_IP> <VPS3_IP> [SSH_USER] [SSH_PORT]}"
VPS3="${3:?Usage: $0 <VPS1_IP> <VPS2_IP> <VPS3_IP> [SSH_USER] [SSH_PORT]}"
SSH_USER="${4:-root}"
SSH_PORT="${5:-22}"

VPS_IPS=("$VPS1" "$VPS2" "$VPS3")
SSH_OPT="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -p $SSH_PORT"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

REMOTE_DIR="/opt/misaka-network"
SERVICE_NAME="misaka-node"
P2P_PORT=4001
RPC_PORT=3001
CHAIN_ID="misaka-testnet-1"
BLOCK_INTERVAL=5000

ssh_run() {
  local ip=$1; shift
  ssh $SSH_OPT "$SSH_USER@$ip" "$@"
}

scp_to() {
  local ip=$1 src=$2 dst=$3
  scp $SSH_OPT "$src" "$SSH_USER@$ip:$dst"
}

echo -e "\n${CYAN}════════════════════════════════════════════════════════════${NC}"
echo -e "  🚀 Misaka Network - 3台 VPS デプロイ"
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo -e "  VPS1: $VPS1"
echo -e "  VPS2: $VPS2"
echo -e "  VPS3: $VPS3"
echo -e "  Role: pruned_validator × 3 (explorer/indexer 不使用)\n"

# ============================================================
# Phase 1: 全VPS接続テスト
# ============================================================
header "Phase 1: SSH 接続テスト"

for i in 0 1 2; do
  IP="${VPS_IPS[$i]}"
  info "VPS-$i ($IP) 接続中..."
  if ssh_run "$IP" "echo OK" >/dev/null 2>&1; then
    RAM_MB=$(ssh_run "$IP" "grep MemTotal /proc/meminfo | awk '{print int(\$2/1024)}'" 2>/dev/null || echo "?")
    DISK=$(ssh_run "$IP" "df -h / | awk 'NR==2{print \$4}'" 2>/dev/null || echo "?")
    ok "VPS-$i ($IP) OK — RAM: ${RAM_MB}MB, Disk空き: $DISK"
  else
    fail "VPS-$i ($IP) SSH接続失敗"
  fi
done

# ============================================================
# Phase 2: アーカイブ作成 & アップロード
# ============================================================
header "Phase 2: プロジェクトアーカイブ & アップロード"

cd "$PROJECT_DIR"

info "ビルド確認..."
npm run build 2>&1 | tail -1

info "アーカイブ作成..."
tar czf /tmp/misaka-network.tar.gz \
  --exclude='node_modules' --exclude='dist' \
  --exclude='test-local' --exclude='test-pruned' \
  --exclude='.git' \
  -C "$(dirname "$PROJECT_DIR")" "$(basename "$PROJECT_DIR")"

SIZE=$(du -h /tmp/misaka-network.tar.gz | cut -f1)
info "サイズ: $SIZE"

for i in 0 1 2; do
  IP="${VPS_IPS[$i]}"
  info "VPS-$i ($IP) へ転送中..."
  scp_to "$IP" "/tmp/misaka-network.tar.gz" "/tmp/misaka-network.tar.gz"
  ok "VPS-$i 転送完了"
done

# ============================================================
# Phase 3: 全VPSにNode.jsインストール & 展開
# ============================================================
header "Phase 3: Node.js セットアップ & 展開"

for i in 0 1 2; do
  IP="${VPS_IPS[$i]}"
  info "VPS-$i ($IP) セットアップ中..."

  ssh_run "$IP" "
    # Node.js チェック & インストール
    if ! node --version 2>/dev/null | grep -qE 'v(1[89]|2[0-9])'; then
      apt-get update -qq
      apt-get install -y -qq curl ca-certificates gnupg
      mkdir -p /etc/apt/keyrings
      curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null
      echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main' > /etc/apt/sources.list.d/nodesource.list
      apt-get update -qq && apt-get install -y -qq nodejs
    fi

    # 展開
    rm -rf $REMOTE_DIR
    mkdir -p $REMOTE_DIR
    tar xzf /tmp/misaka-network.tar.gz -C /opt/ --strip-components=0
    [ ! -d $REMOTE_DIR ] && mv /opt/misaka-network* $REMOTE_DIR 2>/dev/null || true
    rm -f /tmp/misaka-network.tar.gz

    # npm install & build
    cd $REMOTE_DIR
    npm install --production=false 2>&1 | tail -1
    npx tsc 2>&1 | tail -1

    echo \"NODE=\$(node --version) BUILD=OK\"
  " 2>&1 | tail -3

  ok "VPS-$i セットアップ完了"
done

# ============================================================
# Phase 4: バリデータキー生成 & 公開鍵収集
# ============================================================
header "Phase 4: バリデータキー生成"

VALIDATOR_PUBS=()
for i in 0 1 2; do
  IP="${VPS_IPS[$i]}"
  PUB=$(ssh_run "$IP" "
    cd $REMOTE_DIR
    mkdir -p keys data
    if [ ! -f keys/validator.json ]; then
      node -e \"
        const { generateKeyPair, toHex } = require('./dist/utils/crypto');
        const kp = generateKeyPair();
        const data = { publicKey: toHex(kp.publicKey), secretKey: toHex(kp.secretKey) };
        require('fs').writeFileSync('keys/validator.json', JSON.stringify(data, null, 2));
        console.log(data.publicKey);
      \"
    else
      node -e \"console.log(JSON.parse(require('fs').readFileSync('keys/validator.json','utf8')).publicKey)\"
    fi
  " 2>/dev/null)

  VALIDATOR_PUBS+=("$PUB")
  info "VPS-$i ($IP): ${PUB:0:32}..."
done

ok "3 バリデータ公開鍵収集完了"

# JSON array of validators
VALIDATORS_JSON=$(printf '"%s",' "${VALIDATOR_PUBS[@]}" | sed 's/,$//')

# ============================================================
# Phase 5: ノード設定 & systemd
# ============================================================
header "Phase 5: ノード設定 & systemd 登録"

for i in 0 1 2; do
  IP="${VPS_IPS[$i]}"

  # Build peers list (the other 2 VPS IPs)
  PEERS=""
  for j in 0 1 2; do
    if [ "$j" != "$i" ]; then
      [ -n "$PEERS" ] && PEERS="$PEERS,"
      PEERS="${PEERS}\"${VPS_IPS[$j]}:$P2P_PORT\""
    fi
  done

  info "VPS-$i ($IP) 設定生成..."

  ssh_run "$IP" "
    # Config
    cat > $REMOTE_DIR/node-config.json << CFGEOF
{
  \"chainId\": \"$CHAIN_ID\",
  \"network\": \"testnet\",
  \"listenHost\": \"0.0.0.0\",
  \"listenPort\": $P2P_PORT,
  \"rpcPort\": $RPC_PORT,
  \"peers\": [$PEERS],
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
  \"validators\": [$VALIDATORS_JSON],
  \"blockInterval\": $BLOCK_INTERVAL,
  \"checkpointInterval\": 100
}
CFGEOF

    # systemd
    cat > /etc/systemd/system/${SERVICE_NAME}.service << SVCEOF
[Unit]
Description=Misaka Network Pruned Validator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$REMOTE_DIR
ExecStart=/usr/bin/node $REMOTE_DIR/dist/cli/index.js node start --config $REMOTE_DIR/node-config.json
Restart=always
RestartSec=5
LimitNOFILE=65535
MemoryMax=3G
MemoryHigh=2560M
StandardOutput=journal
StandardError=journal
SyslogIdentifier=misaka-node

[Install]
WantedBy=multi-user.target
SVCEOF

    systemctl daemon-reload
    systemctl enable ${SERVICE_NAME} 2>/dev/null

    # Firewall
    if command -v ufw >/dev/null 2>&1; then
      ufw allow $P2P_PORT/tcp 2>/dev/null || true
      ufw allow $RPC_PORT/tcp 2>/dev/null || true
    fi
  " 2>&1 | tail -2

  ok "VPS-$i 設定完了"
done

# ============================================================
# Phase 6: 全ノード起動
# ============================================================
header "Phase 6: 全ノード起動"

for i in 0 1 2; do
  IP="${VPS_IPS[$i]}"
  info "VPS-$i ($IP) 起動..."
  ssh_run "$IP" "systemctl restart ${SERVICE_NAME}" 2>/dev/null
  ok "VPS-$i 起動"
done

info "ジェネシス生成 & P2P接続待機 (15秒)..."
sleep 15

# ============================================================
# Phase 7: ヘルスチェック
# ============================================================
header "Phase 7: ヘルスチェック"

HEIGHTS=()
for i in 0 1 2; do
  IP="${VPS_IPS[$i]}"
  RESP=$(ssh_run "$IP" "curl -s --max-time 5 -X POST -H 'Content-Type: application/json' \
    -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getInfo\",\"params\":{}}' \
    http://localhost:$RPC_PORT" 2>/dev/null || echo "{}")

  HEIGHT=$(echo "$RESP" | node -e "
    let d='';process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{try{console.log(JSON.parse(d).result.height)}catch{console.log(-1)}})
  " 2>/dev/null || echo "-1")

  HEIGHTS+=("$HEIGHT")

  if [ "$HEIGHT" -gt -1 ] 2>/dev/null; then
    ok "VPS-$i ($IP) height=$HEIGHT RPC ✅"
  else
    warn "VPS-$i ($IP) RPC応答なし — ログ確認:"
    ssh_run "$IP" "journalctl -u ${SERVICE_NAME} -n 10 --no-pager" 2>&1 | tail -5
  fi
done

# ============================================================
# Phase 8: 追加待機 & 同期確認
# ============================================================
header "Phase 8: ブロック生成 & 同期確認"

info "追加待機 (30秒)..."
sleep 30

for i in 0 1 2; do
  IP="${VPS_IPS[$i]}"
  RESP=$(ssh_run "$IP" "curl -s --max-time 5 -X POST -H 'Content-Type: application/json' \
    -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getInfo\",\"params\":{}}' \
    http://localhost:$RPC_PORT" 2>/dev/null || echo "{}")

  HEIGHT=$(echo "$RESP" | node -e "
    let d='';process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{try{console.log(JSON.parse(d).result.height)}catch{console.log('?')}})
  " 2>/dev/null || echo "?")

  HASH=$(echo "$RESP" | node -e "
    let d='';process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{try{console.log(JSON.parse(d).result.latestHash.substring(0,16))}catch{console.log('?')}})
  " 2>/dev/null || echo "?")

  info "VPS-$i ($IP): height=$HEIGHT hash=${HASH}..."
done

# ============================================================
# Phase 9: メモリ使用量
# ============================================================
header "Phase 9: メモリ使用量"

for i in 0 1 2; do
  IP="${VPS_IPS[$i]}"
  MEM=$(ssh_run "$IP" "
    FREE=\$(free -m | awk '/Mem:/{print \$3\"/\"\$2\"MB\"}'  )
    PID=\$(pgrep -f 'misaka.*cli' | head -1)
    RSS='?'
    if [ -n \"\$PID\" ]; then
      RSS=\$(ps -o rss= -p \$PID 2>/dev/null | awk '{print int(\$1/1024)}')
    fi
    echo \"system=\$FREE node_rss=\${RSS}MB\"
  " 2>/dev/null)
  info "VPS-$i ($IP): $MEM"
done

# ============================================================
# Summary
# ============================================================
header "📊 3台 VPS デプロイ完了"

echo ""
echo -e "  ┌────────┬─────────────────┬────────┬─────────────────┐"
echo -e "  │ Node   │ IP              │ Height │ Status          │"
echo -e "  ├────────┼─────────────────┼────────┼─────────────────┤"
for i in 0 1 2; do
  IP="${VPS_IPS[$i]}"
  H="${HEIGHTS[$i]:--}"
  STATUS="✅ 稼働中"
  [ "$H" = "-1" ] && STATUS="⚠️  確認中"
  printf "  │ VPS-%-2d │ %-15s │ %6s │ %-15s │\n" "$i" "$IP" "$H" "$STATUS"
done
echo -e "  └────────┴─────────────────┴────────┴─────────────────┘"

echo ""
echo -e "  ${CYAN}運用コマンド (各VPSで実行):${NC}"
echo -e "    systemctl status  $SERVICE_NAME     # ステータス"
echo -e "    systemctl restart $SERVICE_NAME     # 再起動"
echo -e "    journalctl -u $SERVICE_NAME -f      # ログ監視"
echo ""
echo -e "  ${CYAN}RPC テスト:${NC}"
for i in 0 1 2; do
  echo -e "    curl -s -X POST -H 'Content-Type: application/json' \\"
  echo -e "      -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getInfo\",\"params\":{}}' \\"
  echo -e "      http://${VPS_IPS[$i]}:$RPC_PORT"
done

echo -e "\n  ${CYAN}バリデータ公開鍵:${NC}"
for i in 0 1 2; do
  echo -e "    VPS-$i: ${VALIDATOR_PUBS[$i]:0:40}..."
done

echo -e "\n${GREEN}════════════════════════════════════════════════════════════${NC}"
echo -e "  🎉 3台 VPS デプロイ完了！ジェネシスから自動起動します"
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}\n"
