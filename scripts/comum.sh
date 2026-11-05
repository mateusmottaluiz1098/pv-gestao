#!/usr/bin/env bash
# Funções compartilhadas pelos scripts
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ"

IMAGEM="gestao-cobrancas:latest"
REDE="plataforma"

verde() { printf '\033[32m%s\033[0m\n' "$*"; }
amarelo() { printf '\033[33m%s\033[0m\n' "$*"; }
vermelho() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
morrer() { vermelho "ERRO: $*"; exit 1; }

gerar_senha() { local s; s=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c "${1:-24}" || true); printf '%s' "$s"; }

carregar_env() {
  [ -f "$RAIZ/.env" ] || morrer "Arquivo .env não encontrado. Rode primeiro: ./scripts/instalar.sh"
  set -a; . "$RAIZ/.env"; set +a
}

compose_infra() {
  docker compose -f "$RAIZ/infra/docker-compose.yml" --env-file "$RAIZ/.env" "$@"
}

psql_admin() {
  compose_infra exec -T db psql -U admin -d postgres -v ON_ERROR_STOP=1 "$@"
}

validar_slug() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]] || morrer "Nome inválido: '$1'. Use só letras minúsculas, números e hífen (ex.: barbearia-ze)."
  case "$1" in www|app|api|admin|mail|evolution|painel) morrer "'$1' é um nome reservado.";; esac
}

banco_do() { echo "cli_${1//-/_}"; }

# Gera o Caddyfile de acordo com o modo (interno/publico) e o domínio base
gerar_caddyfile() {
  local n_labels tls_bloco
  n_labels=$(awk -F. '{print NF}' <<<"$BASE_DOMINIO")
  if [ "${MODO_TLS:-interno}" = "publico" ]; then
    tls_bloco=$'\ttls {\n\t\ton_demand\n\t}'
  else
    tls_bloco=$'\ttls internal {\n\t\ton_demand\n\t}'
  fi
  cat > "$RAIZ/infra/Caddyfile" <<EOF
# Gerado por scripts/comum.sh — não edite à mão (rode ./scripts/instalar.sh de novo)
{
	email {\$ACME_EMAIL}
	on_demand_tls {
		ask http://porteiro:8080/ok
	}
}

https:// {
$tls_bloco
	encode gzip
	header -Server
	reverse_proxy cli-{labels.${n_labels}}:3000
	handle_errors {
		respond "Sistema indisponível no momento. Tente novamente em instantes." 503
	}
}
EOF
}

# Sobe (ou recria) o container de um cliente
subir_cliente() {
  local slug="$1"
  docker rm -f "cli-$slug" >/dev/null 2>&1 || true
  docker run -d --name "cli-$slug" \
    --network "$REDE" \
    --restart unless-stopped \
    --memory 256m --memory-swap 384m --cpus 1 \
    --env-file "$RAIZ/clientes/$slug.env" \
    --log-opt max-size=5m --log-opt max-file=2 \
    "$IMAGEM" >/dev/null
}
