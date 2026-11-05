#!/usr/bin/env bash
# Lista os clientes, situação do container e uso de memória
. "$(dirname "$0")/comum.sh"
carregar_env

printf '%-22s %-10s %-10s %s\n' "CLIENTE" "SITUAÇÃO" "MEMÓRIA" "ENDEREÇO"
shopt -s nullglob
total=0
for f in clientes/*.env; do
  slug=$(basename "$f" .env)
  estado=$(docker inspect -f '{{.State.Status}}' "cli-$slug" 2>/dev/null || echo "parado")
  mem=$(docker stats --no-stream --format '{{.MemUsage}}' "cli-$slug" 2>/dev/null | cut -d/ -f1 || true)
  printf '%-22s %-10s %-10s %s\n' "$slug" "$estado" "${mem:--}" "https://$slug.$BASE_DOMINIO"
  total=$((total+1))
done
echo
echo "$total cliente(s)."
echo
echo "Infraestrutura:"
docker stats --no-stream --format '  {{.Name}}: {{.MemUsage}}' $(compose_infra ps -q) 2>/dev/null || true
free -h | awk 'NR==1||/Mem/'
