#!/usr/bin/env bash
# Chamado pelo cron a cada 5 minutos: se houver versão nova no GitHub, atualiza todos os clientes.
# Para desligar a atualização automática: touch /opt/cobrancas/.sem-auto
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$RAIZ/.sem-auto" ] && exit 0
cd "$RAIZ" || exit 1
git fetch -q origin main 2>/dev/null || exit 0
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0
exec flock -n /tmp/pv-atualizar.lock "$RAIZ/scripts/atualizar.sh" >> /var/log/pv-atualizar.log 2>&1
