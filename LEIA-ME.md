# PV Gestão — Plataforma para vários clientes

Uma VM roda vários clientes. Cada cliente tem **seu próprio sistema, banco de dados, usuários, logo e WhatsApp**, num subdomínio próprio:

```
https://barbearia.app.privatetelecom.com.br
https://piscinas.app.privatetelecom.com.br
```

## Como fica por dentro

```
                 Internet / rede
                       │ 443
                 ┌─────▼─────┐
                 │   Caddy   │  HTTPS automático por subdomínio
                 └─────┬─────┘
        ┌──────────────┼──────────────┐
  ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
  │cli-barbea…│  │cli-piscin…│  │  cli-...  │   1 container por cliente (~70–120 MB)
  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
        └──────┬───────┴──────┬───────┘
         ┌─────▼─────┐  ┌─────▼─────┐
         │ PostgreSQL│  │ Evolution │   compartilhados (1 banco e 1 número por cliente)
         └───────────┘  └───────────┘
```

## 1. Criar a VM no Proxmox

| Item | Valor |
|---|---|
| Sistema | **Debian 13 (trixie)** netinst — sem interface gráfica, só "SSH server" e "utilitários padrão" |
| CPU | 2 vCPU, tipo **host** |
| Memória | **4 GB** (até ~15 clientes) + 1 GB de swap |
| Disco | 40 GB, **VirtIO SCSI**, com *Discard* ligado |
| Rede | VirtIO, IP fixo |

Precisa crescer? Aumente a memória da VM no Proxmox (6–8 GB aguenta ~25–35 clientes).

## 2. Instalar a plataforma

Copie esta pasta para a VM (ex.: `/opt/cobrancas`) e rode como root:

```bash
cd /opt/cobrancas
./scripts/instalar.sh
```

Ele instala o Docker, pergunta o domínio base e o modo do HTTPS, e sobe tudo.

## 3. DNS (no PvNoc)

Crie **um único registro coringa** apontando para o IP da VM:

```
*.app.privatetelecom.com.br    A    <IP da VM>
```

Depois disso, todo cliente novo já funciona sem mexer no DNS.

### Modo do HTTPS (`MODO_TLS` no arquivo `.env`)
- `interno` — enquanto o domínio só resolve na sua rede. Usa certificado próprio: o navegador mostra um aviso na primeira vez ("Avançado → continuar").
- `publico` — quando o domínio estiver delegado no Registro.br e a VM acessível pela internet nas portas **80 e 443**. O certificado (Let's Encrypt) é emitido sozinho para cada cliente.

Para trocar: edite `MODO_TLS` no `.env` e rode `./scripts/atualizar.sh`.

## 4. Dia a dia

| Tarefa | Comando |
|---|---|
| Criar cliente | `./scripts/novo-cliente.sh barbearia "Barbearia do Zé"` |
| Ver clientes e memória | `./scripts/listar-clientes.sh` |
| Ver log | `./scripts/logs.sh barbearia` (ou `evolution`, `caddy`) |
| Atualizar o sistema | troque a pasta `app/` pela versão nova e rode `./scripts/atualizar.sh` |
| Testar atualização em um só | `./scripts/atualizar.sh barbearia` |
| Remover cliente | `./scripts/remover-cliente.sh barbearia` (faz backup antes) |
| Backup manual | `./scripts/backup.sh` |
| Trazer dados do Mac | ver `scripts/importar-do-mac.sh` |

O **nome curto** do cliente vira o subdomínio: só letras minúsculas, números e hífen (`barbearia-ze`).

Ao criar, o script mostra o **usuário `admin` e a senha inicial** — passe para o cliente e peça para trocar em "Trocar senha".

## 5. Backup

- Automático todo dia às 3h em `backups/AAAAMMDD/` (um arquivo por cliente + WhatsApp), guardando 14 dias.
- Recomendo também o backup da VM inteira pelo Proxmox (vzdump) e copiar `backups/` para outro servidor.

Restaurar um cliente:
```bash
docker compose -f infra/docker-compose.yml --env-file .env exec -T db \
  pg_restore -U admin -d cli_barbearia --clean --if-exists < backups/20261105/cli_barbearia.dump
docker restart cli-barbearia
```

## Limites por cliente

Cada container de cliente tem limite de **256 MB de RAM e 1 CPU**, então um cliente não derruba os outros. O banco aceita até 10 conexões por cliente.

## Segurança

- Só as portas 80/443 ficam abertas. Banco e WhatsApp não são acessíveis de fora.
- O Caddy só emite certificado para subdomínios de clientes cadastrados.
- Os arquivos `.env` e `clientes/*.env` têm as senhas: não compartilhe e mantenha no backup.
