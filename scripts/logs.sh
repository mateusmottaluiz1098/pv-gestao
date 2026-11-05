#!/usr/bin/env bash
# Mostra o log de um cliente (ou da infraestrutura)
# Uso: ./scripts/logs.sh barbearia     |  ./scripts/logs.sh evolution  |  ./scripts/logs.sh caddy
. "$(dirname "$0")/comum.sh"
carregar_env
ALVO="${1:-}"
case "$ALVO" in
  evolution|caddy|db|porteiro) compose_infra logs -f --tail 100 "$ALVO" ;;
  "") morrer "Uso: ./scripts/logs.sh <cliente|evolution|caddy|db>" ;;
  *) docker logs -f --tail 100 "cli-$ALVO" ;;
esac
