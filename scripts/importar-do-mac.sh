#!/usr/bin/env bash
# Leva os dados do sistema que roda no Mac para um cliente da plataforma
# No Mac (pasta piscina-em-dia):
#   docker compose exec -T db pg_dump -U piscina -d piscina --data-only --exclude-table=usuarios > dados-mac.sql
# Copie dados-mac.sql para a VM e rode:
#   ./scripts/importar-do-mac.sh <cliente> dados-mac.sql
. "$(dirname "$0")/comum.sh"
carregar_env

SLUG="${1:-}"; ARQ="${2:-}"
validar_slug "$SLUG"
[ -f "clientes/$SLUG.env" ] || morrer "Crie o cliente antes: ./scripts/novo-cliente.sh $SLUG"
[ -f "$ARQ" ] || morrer "Arquivo não encontrado: $ARQ"
BANCO=$(banco_do "$SLUG")

read -r -p "Isso APAGA os dados atuais de '$SLUG' (clientes, cobranças, agenda) e coloca os do Mac. Continuar? [s/N] " R
[ "$R" = "s" ] || morrer "Cancelado."

docker stop "cli-$SLUG" >/dev/null
compose_infra exec -T db psql -U admin -d "$BANCO" -v ON_ERROR_STOP=1 -q <<'SQL'
TRUNCATE comprovantes, mensagens, cobrancas, clientes, config RESTART IDENTITY CASCADE;
DO $$ BEGIN
  IF to_regclass('agendamentos') IS NOT NULL THEN TRUNCATE agendamentos, servicos, profissionais RESTART IDENTITY CASCADE; END IF;
END $$;
SQL
{ echo "SET session_replication_role = replica;"; cat "$ARQ"; } | compose_infra exec -T db psql -U admin -d "$BANCO" -q -v ON_ERROR_STOP=1
compose_infra exec -T db psql -U admin -d "$BANCO" -q -c "REASSIGN OWNED BY admin TO $BANCO;" >/dev/null 2>&1 || true
docker start "cli-$SLUG" >/dev/null
verde "Dados importados para '$SLUG'. Reconecte o WhatsApp pelo QR code no sistema."
