#!/usr/bin/env bash
# Atualiza o sistema de todos os clientes (baixa do GitHub, se a pasta for um clone)
# Uso: ./scripts/atualizar.sh            (todos)
#      ./scripts/atualizar.sh barbearia  (só um, bom para testar antes)
. "$(dirname "$0")/comum.sh"
carregar_env

# Se a pasta veio do GitHub, baixa a versão nova primeiro (e reinicia este script já atualizado)
if [ -d "$RAIZ/.git" ] && [ -z "${PV_JA_PUXOU:-}" ]; then
  amarelo "Baixando a versão nova do GitHub..."
  git -C "$RAIZ" pull --ff-only || morrer "Não consegui baixar do GitHub (git pull)."
  PV_JA_PUXOU=1 exec "$RAIZ/scripts/atualizar.sh" "$@"
fi

amarelo "Fazendo backup antes de atualizar..."
"$RAIZ/scripts/backup.sh" >/dev/null

amarelo "Construindo a imagem nova..."
docker build -q -t "$IMAGEM" "$RAIZ/app" >/dev/null

gerar_caddyfile
compose_infra up -d >/dev/null
compose_infra restart caddy >/dev/null

shopt -s nullglob
ALVOS=()
if [ -n "${1:-}" ]; then ALVOS=("clientes/$1.env"); else ALVOS=(clientes/*.env); fi
for f in "${ALVOS[@]}"; do
  [ -f "$f" ] || morrer "Cliente não encontrado: $f"
  slug=$(basename "$f" .env)
  subir_cliente "$slug"
  echo "  ✓ $slug"
  sleep 2   # escalona para não pesar a VM
done
docker image prune -f >/dev/null
verde "Atualização concluída."
