#!/usr/bin/env bash
# Backup de todos os bancos (cada cliente + WhatsApp). Guarda os últimos 14 dias.
# Roda sozinho todo dia às 3h (instalado pelo instalar.sh)
. "$(dirname "$0")/comum.sh"
carregar_env

DIA=$(date +%Y%m%d)
DEST="$RAIZ/backups/$DIA"
mkdir -p "$DEST"

for banco in $(psql_admin -tA -c "SELECT datname FROM pg_database WHERE datname LIKE 'cli\_%' OR datname = 'evolution'"); do
  compose_infra exec -T db pg_dump -U admin -Fc -d "$banco" > "$DEST/$banco.dump"
done
cp "$RAIZ/.env" "$DEST/plataforma.env"
cp -r "$RAIZ/clientes" "$DEST/clientes"
chmod -R go-rwx "$DEST"

find "$RAIZ/backups" -maxdepth 1 -type d -name '20*' -mtime +14 -exec rm -rf {} +
echo "$(date '+%F %T') backup ok: $(ls "$DEST" | wc -l) arquivo(s) em $DEST"
