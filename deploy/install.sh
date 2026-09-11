#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="${1:-/opt/stonk-monitor}"
SERVICE_USER="${SERVICE_USER:-ubuntu}"
if [[ $EUID -ne 0 ]]; then echo 'Run with sudo.'; exit 1; fi
if [[ ! "$INSTALL_DIR" =~ ^/[a-zA-Z0-9_/-]+$ || "$INSTALL_DIR" == / || "$INSTALL_DIR" == *..* || "$INSTALL_DIR" == /opt/dump-sniper ]]; then
  echo 'Use a dedicated Stonk installation directory.'; exit 1
fi
if [[ ! "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]; then echo 'Invalid service user'; exit 1; fi
id "$SERVICE_USER" >/dev/null
for cmd in node npm rsync systemctl; do command -v "$cmd" >/dev/null; done
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 16)) process.exit(1)'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
mkdir -p "$INSTALL_DIR/helius" "$INSTALL_DIR/observation-models" "$INSTALL_DIR/helius/data/stonk"
if [[ "$(readlink -f "$PROJECT_DIR")" != "$(readlink -f "$INSTALL_DIR")" ]]; then
  rsync -a --exclude=node_modules --exclude=.env --exclude=.cos.env --exclude=data --exclude='*.jsonl' "$PROJECT_DIR/helius/" "$INSTALL_DIR/helius/"
  rsync -a "$PROJECT_DIR/observation-models/" "$INSTALL_DIR/observation-models/"
  cp "$PROJECT_DIR/README.md" "$PROJECT_DIR/package.json" "$PROJECT_DIR/package-lock.json" "$INSTALL_DIR/"
fi
if [[ ! -f "$INSTALL_DIR/helius/.env" ]]; then cp "$INSTALL_DIR/helius/.env.example" "$INSTALL_DIR/helius/.env"; fi
if [[ ! -f "$INSTALL_DIR/helius/.cos.env" ]]; then cp "$INSTALL_DIR/helius/.cos.env.example" "$INSTALL_DIR/helius/.cos.env"; fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/helius"
chmod 600 "$INSTALL_DIR/helius/.env" "$INSTALL_DIR/helius/.cos.env"
sudo -u "$SERVICE_USER" npm ci --prefix "$INSTALL_DIR/helius" --omit=dev --ignore-scripts
NODE_BIN="$(command -v node)"
for service in stonk-monitor stonk-dashboard stonk-upload; do
  sed -e "s|/opt/stonk-monitor|$INSTALL_DIR|g" \
    -e "s|^User=ubuntu|User=$SERVICE_USER|" -e "s|^Group=ubuntu|Group=$SERVICE_USER|" \
    -e "s|^ExecStart=/usr/bin/node |ExecStart=$NODE_BIN |" \
    "$SCRIPT_DIR/$service.service" > "/etc/systemd/system/$service.service"
done
cp "$SCRIPT_DIR/stonk-upload.timer" /etc/systemd/system/stonk-upload.timer
systemctl daemon-reload
echo "Installed Stonk paper + Shadow. Configure $INSTALL_DIR/helius/.env. Live trading is disabled in code."
echo 'Start: sudo systemctl enable --now stonk-monitor'
echo 'Dashboard: sudo systemctl enable --now stonk-dashboard (127.0.0.1:8788)'
echo 'COS: configure helius/.cos.env, then sudo systemctl enable --now stonk-upload.timer'
echo 'Logs: journalctl -u stonk-monitor -f'
