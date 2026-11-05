#!/usr/bin/env bash
# Testa uma branch (padrão: dev) num container separado, com banco próprio, sem mexer nos clientes.
# Uso (na VM): bash /opt/cobrancas/tests/rodar-na-vm.sh [branch]
set -uo pipefail
BRANCH="${1:-dev}"
DIR=/root/pv-teste
cd /opt/cobrancas && . scripts/comum.sh && carregar_env
set +e
rm -rf "$DIR" && git clone -q -b "$BRANCH" "$(git -C /opt/cobrancas remote get-url origin)" "$DIR" || { echo "falhou o clone"; exit 1; }
echo "== construindo imagem de teste ($BRANCH) =="
docker build -q -t gestao-cobrancas:teste "$DIR/app" >/dev/null || { echo "falhou o build"; exit 1; }
SENHA_DB=$(gerar_senha 20); SENHA_ADM=$(gerar_senha 12)
docker rm -f cli-autoteste >/dev/null 2>&1
psql_admin -q -c "DROP DATABASE IF EXISTS cli_autoteste" -c "DROP ROLE IF EXISTS cli_autoteste" >/dev/null 2>&1
psql_admin -q -c "CREATE ROLE cli_autoteste LOGIN PASSWORD '$SENHA_DB'" -c "CREATE DATABASE cli_autoteste OWNER cli_autoteste" >/dev/null
docker run -d --name cli-autoteste --network "$REDE" \
  -e DATABASE_URL="postgresql://cli_autoteste:$SENHA_DB@db:5432/cli_autoteste" \
  -e EVOLUTION_URL=http://evolution:8080 -e EVOLUTION_API_KEY="$EVOLUTION_API_KEY" -e EVOLUTION_INSTANCE=autoteste \
  -e ADMIN_SENHA="$SENHA_ADM" -e SESSAO_SEGREDO="$(gerar_senha 40)" -e TZ=America/Sao_Paulo -e PORT=3000 \
  gestao-cobrancas:teste >/dev/null
for i in $(seq 1 40); do docker exec cli-autoteste wget -qO- http://127.0.0.1:3000/api/marca >/dev/null 2>&1 && break; sleep 1; done
docker cp "$DIR/tests/e2e.js" cli-autoteste:/tmp/e2e.js
echo "== rodando testes =="
docker exec -e SENHA_TESTE="$SENHA_ADM" cli-autoteste node /tmp/e2e.js
R=$?
echo "== log do app (erros) =="; docker logs cli-autoteste 2>&1 | grep -iE "erro|error|exception" | grep -v "Evolution\|whatsapp\|webhook" | tail -15
docker rm -f cli-autoteste >/dev/null 2>&1
psql_admin -q -c "DROP DATABASE IF EXISTS cli_autoteste" -c "DROP ROLE IF EXISTS cli_autoteste" >/dev/null 2>&1
docker image rm gestao-cobrancas:teste >/dev/null 2>&1
echo "== fim (código $R) =="
exit $R
