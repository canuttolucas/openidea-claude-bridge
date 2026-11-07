#!/usr/bin/env bash
# Instala o sidecar como serviço systemd de usuário (sobe no login, reinicia se cair). Só Linux.
# Uso: scripts/install-service.sh [--uninstall]
set -euo pipefail

UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/openidea-claude-bridge.service"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl --user disable --now openidea-claude-bridge.service 2>/dev/null || true
  rm -f "$UNIT"; systemctl --user daemon-reload
  echo "serviço removido"; exit 0
fi

command -v node >/dev/null || { echo "node não encontrado no PATH" >&2; exit 1; }
# process.execPath é o binário real, mesmo quando `node` é um shim (mise, nvm, asdf).
NODE="$(node -p process.execPath)"
"$NODE" --version >/dev/null

# O systemd divide ExecStart em espaços e expande %/$: caminhos assim quebrariam a unit sem avisar.
if [[ "$NODE$ROOT" =~ [[:space:]%\$\"\'\\] ]]; then
  echo "caminho com espaço, %, \$, aspas ou barra invertida não é suportado: $NODE $ROOT" >&2; exit 1
fi

# Reprodutível (segue o lock) e sem rodar scripts de instalação de dependências.
(cd "$ROOT" && npm ci --omit=dev --ignore-scripts --silent)

# Variáveis que mudam onde o sidecar grava não passam do shell para o serviço: repassa se estiverem definidas.
ENVS=""
for v in CLAUDE_CONFIG_DIR XDG_CONFIG_HOME BRIDGE_PORT; do
  if [[ -n "${!v:-}" ]]; then
    [[ "${!v}" =~ [[:space:]%\$\"\'\\] ]] && { echo "$v tem caracteres não suportados" >&2; exit 1; }
    ENVS+="Environment=$v=${!v}"$'\n'
  fi
done

mkdir -p "$(dirname "$UNIT")"
cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=openidea-claude-bridge (openIDEA como IDE do Claude Code)
# Para de insistir se algo está errado (porta ocupada, node removido), em vez de reiniciar para sempre.
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
ExecStart=$NODE $ROOT/src/cli.js
Restart=on-failure
RestartSec=3
${ENVS}NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
UNIT_EOF

systemctl --user daemon-reload
systemctl --user enable openidea-claude-bridge.service
systemctl --user restart openidea-claude-bridge.service   # restart (não só start): carrega código novo numa reinstalação
sleep 1
systemctl --user --no-pager status openidea-claude-bridge.service | sed -n 1,5p || true
echo "logs: journalctl --user -u openidea-claude-bridge -f"
