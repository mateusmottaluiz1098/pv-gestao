#!/usr/bin/env bash
# Remove um cliente (faz backup do banco antes)
# Uso: ./scripts/remover-cliente.sh <nome-curto>
. "$(dirname "$0")/comum.sh"
carregar_env

SLUG="${1:-}"
validar_slug "$SLUG"
[ -f "clientes/$SLUG.env" ] || morrer "Cliente '$SLUG' não existe."
BANCO=$(banco_do "$SLUG")

read -r -p "Remover o cliente '$SLUG'? O banco será salvo em backups/ antes. Digite o nome para confirmar: " CONF
[ "$CONF" = "$SLUG" ] || morrer "Cancelado."

mkdir -p backups
ARQ="backups/REMOVIDO-$SLUG-$(date +%Y%m%d-%H%M).sql.gz"
compose_infra exec -T db pg_dump -U admin -d "$BANCO" | gzip > "$ARQ"
verde "Backup salvo em $ARQ"

docker rm -f "cli-$SLUG" >/dev/null 2>&1 || true
# desconecta o WhatsApp do cliente na Evolution
compose_infra exec -T porteiro node -e "fetch('http://evolution:8080/instance/delete/$SLUG',{method:'DELETE',headers:{apikey:'$EVOLUTION_API_KEY'}}).catch(()=>{})" >/dev/null 2>&1 || true
psql_admin -q -c "DROP DATABASE IF EXISTS $BANCO WITH (FORCE);" -c "DROP ROLE IF EXISTS $BANCO;"
mv "clientes/$SLUG.env" "backups/REMOVIDO-$SLUG.env"
verde "Cliente '$SLUG' removido."
