#!/usr/bin/env bash
# Cria um cliente novo: banco próprio, container próprio e subdomínio
# Uso: ./scripts/novo-cliente.sh <nome-curto> ["Nome da Empresa"] ["Nome do Sistema"] [ramo]
# Ramos: servicos (piscinas e serviços recorrentes), barbearia, salao, escola (academia/cursos), comercio
# Ex.: ./scripts/novo-cliente.sh barbearia-ze "Barbearia do Zé" "PV Gestão" barbearia
#      ./scripts/novo-cliente.sh piscinas-ana "Ana Piscinas" "PV Gestão" servicos
. "$(dirname "$0")/comum.sh"
carregar_env

SLUG="${1:-}"; EMPRESA="${2:-}"; SISTEMA="${3:-PV Gestão}"; RAMO="${4:-barbearia}"
case "$RAMO" in servicos|barbearia|salao|escola|comercio) ;; *) morrer "Ramo inválido: $RAMO (use servicos, barbearia, salao, escola ou comercio)";; esac
[ -n "$SLUG" ] || morrer "Informe o nome curto. Ex.: ./scripts/novo-cliente.sh barbearia-ze \"Barbearia do Zé\""
validar_slug "$SLUG"
[ -f "clientes/$SLUG.env" ] && morrer "O cliente '$SLUG' já existe."
EMPRESA="${EMPRESA:-$SLUG}"

BANCO=$(banco_do "$SLUG")
SENHA_DB=$(gerar_senha 24)
SENHA_ADMIN=$(gerar_senha 10)

amarelo "Criando banco $BANCO..."
psql_admin -q <<SQL
CREATE ROLE $BANCO LOGIN PASSWORD '$SENHA_DB' CONNECTION LIMIT 10;
CREATE DATABASE $BANCO OWNER $BANCO;
REVOKE ALL ON DATABASE $BANCO FROM PUBLIC;
SQL

cat > "clientes/$SLUG.env" <<EOF
# Cliente: $EMPRESA  —  https://$SLUG.$BASE_DOMINIO
EMPRESA_NOME=$EMPRESA
SISTEMA_NOME=$SISTEMA
RAMO=$RAMO
DATABASE_URL=postgresql://$BANCO:$SENHA_DB@db:5432/$BANCO
EVOLUTION_URL=http://evolution:8080
EVOLUTION_API_KEY=$EVOLUTION_API_KEY
EVOLUTION_INSTANCE=$SLUG
WEBHOOK_URL=http://cli-$SLUG:3000/webhook/whatsapp
WEBHOOK_TOKEN=$(gerar_senha 24)
ADMIN_SENHA=$SENHA_ADMIN
SESSAO_SEGREDO=$(gerar_senha 40)
TZ=America/Sao_Paulo
PORT=3000
DB_POOL_MAX=5
TRUST_PROXY=1
URL_PUBLICA=https://$SLUG.$BASE_DOMINIO
EOF
chmod 600 "clientes/$SLUG.env"

amarelo "Subindo o sistema do cliente..."
subir_cliente "$SLUG"

for i in $(seq 1 30); do
  docker exec "cli-$SLUG" wget -qO- http://127.0.0.1:3000/api/marca >/dev/null 2>&1 && break
  sleep 1
done

echo
verde "Cliente criado!"
echo "  Endereço:  https://$SLUG.$BASE_DOMINIO"
echo "  Usuário:   admin"
echo "  Senha:     $SENHA_ADMIN   (peça para o cliente trocar no primeiro acesso)"
echo
echo "Próximos passos do cliente: Personalização (logo/cor), WhatsApp (QR code), Configurações (Pix)."
