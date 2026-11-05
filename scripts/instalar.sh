#!/usr/bin/env bash
# Instala a plataforma numa VM Debian 12/13 limpa (rode como root ou com sudo)
# Uso: ./scripts/instalar.sh
. "$(dirname "$0")/comum.sh"

verde "=== PV Gestão — instalação da plataforma ==="

# 1) Docker
if ! command -v docker >/dev/null 2>&1; then
  amarelo "Instalando Docker..."
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl >/dev/null
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi
docker compose version >/dev/null 2>&1 || morrer "Docker Compose não encontrado."

# 2) Configuração inicial
if [ ! -f .env ]; then
  read -r -p "Domínio base dos clientes [app.privatetelecom.com.br]: " BASE
  BASE=${BASE:-app.privatetelecom.com.br}
  read -r -p "E-mail para o certificado HTTPS [suporte@privatetelecom.com.br]: " EMAIL
  EMAIL=${EMAIL:-suporte@privatetelecom.com.br}
  read -r -p "Modo do HTTPS — 'interno' (rede local/testes) ou 'publico' (domínio na internet) [interno]: " MODO
  MODO=${MODO:-interno}
  cat > .env <<EOF
# Domínio: cada cliente fica em <nome>.$BASE  (crie no DNS: *.$BASE -> IP desta VM)
BASE_DOMINIO=$BASE
ACME_EMAIL=$EMAIL
# interno = certificado próprio (aviso no navegador) | publico = Let's Encrypt automático
MODO_TLS=$MODO

# Senhas internas — não compartilhe
DB_SENHA=$(gerar_senha 28)
EVOLUTION_API_KEY=$(gerar_senha 40)
EOF
  chmod 600 .env
  verde "Arquivo .env criado."
fi
carregar_env

# 3) Caddyfile, imagem do sistema e infraestrutura
gerar_caddyfile
amarelo "Construindo a imagem do sistema..."
docker build -q -t "$IMAGEM" "$RAIZ/app" >/dev/null
amarelo "Subindo banco, WhatsApp e proxy HTTPS..."
compose_infra up -d
compose_infra restart caddy >/dev/null 2>&1 || true

# 4) Backup diário às 3h
if [ ! -f /etc/cron.d/gestao-cobrancas ]; then
  echo "0 3 * * * root $RAIZ/scripts/backup.sh >> /var/log/gestao-cobrancas-backup.log 2>&1" > /etc/cron.d/gestao-cobrancas
  verde "Backup diário agendado (3h da manhã)."
fi

echo
verde "Plataforma pronta!"
echo "No DNS (PvNoc), crie:   *.$BASE_DOMINIO   A   <IP desta VM>"
echo "Para criar um cliente:  ./scripts/novo-cliente.sh barbearia \"Barbearia do Zé\""
