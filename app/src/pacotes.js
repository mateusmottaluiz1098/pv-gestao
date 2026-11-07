// Pacotes e assinaturas: o cliente compra N atendimentos (ex.: 4 cortes) e vai usando o saldo.
// Assinatura = pacote que renova sozinho a cada período e gera a cobrança do novo período.
const { q } = require('./db');
const cfg = require('./config');
const C = require('./cobrancas');
const U = require('./util');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pacotes (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  servico_id INT,
  quantidade INT NOT NULL,
  valor NUMERIC(12,2) NOT NULL,
  validade_dias INT NOT NULL DEFAULT 30,
  recorrente BOOLEAN NOT NULL DEFAULT FALSE,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pacotes_clientes (
  id SERIAL PRIMARY KEY,
  cliente_id INT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  pacote_id INT,
  nome TEXT NOT NULL,
  servico_id INT,
  quantidade INT NOT NULL,
  usados INT NOT NULL DEFAULT 0,
  valor NUMERIC(12,2) NOT NULL,
  inicio DATE NOT NULL,
  validade DATE NOT NULL,
  validade_dias INT NOT NULL DEFAULT 30,
  recorrente BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'ativo',
  forma_pagamento TEXT,
  cobranca_id INT REFERENCES cobrancas(id) ON DELETE SET NULL,
  criado_por TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pacotes_cli_idx ON pacotes_clientes (cliente_id, status);
CREATE TABLE IF NOT EXISTS pacote_usos (
  id SERIAL PRIMARY KEY,
  pacote_cliente_id INT NOT NULL REFERENCES pacotes_clientes(id) ON DELETE CASCADE,
  agendamento_id INT,
  data DATE NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const FORMAS_PAGTO = ['pix', 'dinheiro', 'debito', 'cartao', 'transferencia', 'cobrar'];

async function iniciar() {
  await q(SCHEMA);
}

function erro(status, msg) { const e = new Error(msg); e.status = status; return e; }
const num = (v) => Number(String(v ?? '').replace(',', '.'));

function validarPacote(b) {
  const nome = String(b.nome || '').trim();
  if (!nome) throw erro(400, 'Informe o nome do pacote');
  const qtd = parseInt(b.quantidade, 10);
  if (!(qtd >= 1 && qtd <= 500)) throw erro(400, 'Quantidade de usos entre 1 e 500');
  const valor = Math.round(num(b.valor) * 100) / 100;
  if (!(valor > 0)) throw erro(400, 'Informe o valor do pacote');
  const dias = parseInt(b.validade_dias, 10);
  if (!(dias >= 1 && dias <= 730)) throw erro(400, 'Validade entre 1 e 730 dias');
  return { nome, servico_id: parseInt(b.servico_id, 10) || null, quantidade: qtd, valor, validade_dias: dias, recorrente: !!b.recorrente, ativo: b.ativo !== false };
}

// pacotes do cliente com saldo (por cadastro ou pelo telefone)
async function doCliente({ cliente_id, telefone, todos }) {
  let ids = [];
  if (cliente_id) ids.push(Number(cliente_id));
  if (telefone) {
    const chave = U.chaveTelefone(telefone);
    const { rows } = await q('SELECT id, telefone FROM clientes');
    ids.push(...rows.filter((r) => U.chaveTelefone(r.telefone) === chave).map((r) => r.id));
  }
  ids = [...new Set(ids.filter(Boolean))];
  if (!ids.length) return [];
  const { rows } = await q(
    `SELECT pc.*, s.nome AS servico_nome, cb.status AS cobranca_status, (pc.quantidade - pc.usados) AS saldo
       FROM pacotes_clientes pc LEFT JOIN servicos s ON s.id = pc.servico_id LEFT JOIN cobrancas cb ON cb.id = pc.cobranca_id
      WHERE pc.cliente_id = ANY($1::int[]) ${todos ? '' : "AND pc.status = 'ativo' AND pc.usados < pc.quantidade AND pc.validade >= $2"}
      ORDER BY (pc.status = 'ativo') DESC, pc.validade DESC, pc.id DESC`, todos ? [ids] : [ids, U.hoje()]);
  return rows.map((r) => ({ ...r, saldo: Number(r.saldo), pago: !r.cobranca_id || r.cobranca_status === 'pago' }));
}

// vende um pacote para o cliente: recebe na hora (entra no caixa) ou gera cobrança
async function vender(clienteId, { pacote_id, forma_pagamento, enviar }, por) {
  const { rows: pk } = await q('SELECT * FROM pacotes WHERE id = $1 AND ativo', [pacote_id]);
  if (!pk[0]) throw erro(400, 'Escolha o pacote');
  const { rows: cl } = await q('SELECT * FROM clientes WHERE id = $1', [clienteId]);
  if (!cl[0]) throw erro(404, 'Cliente não encontrado');
  const forma = FORMAS_PAGTO.includes(forma_pagamento) ? forma_pagamento : 'pix';
  const p = pk[0];
  const ini = U.hoje();
  const val = U.somarDias(ini, p.validade_dias - 1);
  let cobId = null;
  let aviso = null;
  if (forma === 'cobrar') {
    const cb = await C.criarAvulsa(clienteId, { valor: Number(p.valor), descricao: `${p.nome}`, vencimento: ini });
    cobId = cb.id;
    if (enviar) {
      const r = await require('./financeiro').enviarAvulsa(cb, clienteId);
      if (!r.ok) aviso = 'Pacote registrado, mas a cobrança não foi enviada: ' + r.erro;
    }
  } else {
    await q(`INSERT INTO caixa_movimentos (data, tipo, descricao, valor, forma, criado_por) VALUES ($1,'entrada',$2,$3,$4,$5)`,
      [ini, `Pacote: ${p.nome} — ${cl[0].nome}`, p.valor, forma, por || null]);
  }
  const { rows } = await q(
    `INSERT INTO pacotes_clientes (cliente_id, pacote_id, nome, servico_id, quantidade, valor, inicio, validade, validade_dias, recorrente, forma_pagamento, cobranca_id, criado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [clienteId, p.id, p.nome, p.servico_id, p.quantidade, p.valor, ini, val, p.validade_dias, p.recorrente, forma, cobId, por || null]);
  return { pacote: rows[0], aviso };
}

// usa 1 do saldo num atendimento da agenda: marca como pago com "pacote" (o dinheiro entrou na venda do pacote)
async function usar(agendamentoId, pacoteClienteId) {
  const { rows } = await q("SELECT * FROM pacotes_clientes WHERE id = $1 AND status = 'ativo'", [pacoteClienteId]);
  const pc = rows[0];
  if (!pc) throw erro(400, 'Pacote não encontrado ou encerrado');
  if (pc.usados >= pc.quantidade) throw erro(400, 'Este pacote não tem mais saldo');
  if (pc.validade < U.hoje()) throw erro(400, 'Este pacote venceu');
  const { rows: ja } = await q('SELECT id FROM pacote_usos WHERE agendamento_id = $1', [agendamentoId]);
  if (ja[0]) throw erro(400, 'Este atendimento já foi descontado de um pacote');
  const valorUso = Math.round((Number(pc.valor) / pc.quantidade) * 100) / 100;
  await q('INSERT INTO pacote_usos (pacote_cliente_id, agendamento_id, data) VALUES ($1,$2,$3)', [pc.id, agendamentoId, U.hoje()]);
  await q('UPDATE pacotes_clientes SET usados = usados + 1 WHERE id = $1', [pc.id]);
  if (!pc.recorrente && pc.usados + 1 >= pc.quantidade) await q("UPDATE pacotes_clientes SET status = 'encerrado' WHERE id = $1", [pc.id]);
  await q("UPDATE agendamentos SET pago = TRUE, forma_pagamento = 'pacote', pago_em = now(), valor = $2, cliente_id = COALESCE(cliente_id, $3) WHERE id = $1",
    [agendamentoId, valorUso, pc.cliente_id]);
  return { saldo: pc.quantidade - pc.usados - 1, valor_uso: valorUso };
}

// devolve o uso quando o atendimento volta a ficar em aberto
async function estornarUso(agendamentoId) {
  const { rows } = await q('DELETE FROM pacote_usos WHERE agendamento_id = $1 RETURNING pacote_cliente_id', [agendamentoId]);
  for (const r of rows) {
    await q("UPDATE pacotes_clientes SET usados = GREATEST(usados - 1, 0), status = CASE WHEN status = 'encerrado' AND validade >= $2 THEN 'ativo' ELSE status END WHERE id = $1", [r.pacote_cliente_id, U.hoje()]);
  }
  return rows.length;
}

// assinaturas: no fim do período encerra e abre o próximo, com a cobrança do novo período
async function renovarAssinaturas() {
  const hoje = U.hoje();
  const { rows } = await q("SELECT * FROM pacotes_clientes WHERE recorrente AND status = 'ativo' AND validade < $1", [hoje]);
  for (const pc of rows) {
    await q("UPDATE pacotes_clientes SET status = 'encerrado' WHERE id = $1", [pc.id]);
    const { rows: cl } = await q('SELECT ativo FROM clientes WHERE id = $1', [pc.cliente_id]);
    if (!cl[0] || !cl[0].ativo) continue;
    const ini = U.somarDias(pc.validade, 1);
    const val = U.somarDias(ini, pc.validade_dias - 1);
    const cb = await C.criarAvulsa(pc.cliente_id, { valor: Number(pc.valor), descricao: `${pc.nome} (${U.brData(ini)} a ${U.brData(val)})`, vencimento: ini < hoje ? hoje : ini });
    await q(
      `INSERT INTO pacotes_clientes (cliente_id, pacote_id, nome, servico_id, quantidade, valor, inicio, validade, validade_dias, recorrente, forma_pagamento, cobranca_id, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,'cobrar',$10,'renovação automática')`,
      [pc.cliente_id, pc.pacote_id, pc.nome, pc.servico_id, pc.quantidade, pc.valor, ini, val, pc.validade_dias, cb.id]);
  }
  // pacotes comuns vencidos saem da lista de ativos
  await q("UPDATE pacotes_clientes SET status = 'encerrado' WHERE NOT recorrente AND status = 'ativo' AND validade < $1", [hoje]);
  return rows.length;
}

let ultimoDia = null;
async function tick() {
  const c = await cfg.obter();
  if (c.modulos && c.modulos.pacotes === false) return;
  const h = U.hoje();
  if (ultimoDia === h) return;
  ultimoDia = h;
  try { await renovarAssinaturas(); } catch (e) { console.warn('[pacotes] renovar:', e.message); ultimoDia = null; }
}

function rotas(app, { rota, pode }) {
  app.get('/api/pacotes', rota(async (req, res) => {
    res.json((await q('SELECT p.*, s.nome AS servico_nome FROM pacotes p LEFT JOIN servicos s ON s.id = p.servico_id ORDER BY p.ativo DESC, p.nome')).rows);
  }));
  app.post('/api/pacotes', pode('agenda_config'), rota(async (req, res) => {
    const p = validarPacote(req.body || {});
    const { rows } = await q('INSERT INTO pacotes (nome, servico_id, quantidade, valor, validade_dias, recorrente, ativo) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [p.nome, p.servico_id, p.quantidade, p.valor, p.validade_dias, p.recorrente, p.ativo]);
    res.json(rows[0]);
  }));
  app.put('/api/pacotes/:id', pode('agenda_config'), rota(async (req, res) => {
    const p = validarPacote(req.body || {});
    const { rows } = await q('UPDATE pacotes SET nome=$1, servico_id=$2, quantidade=$3, valor=$4, validade_dias=$5, recorrente=$6, ativo=$7 WHERE id=$8 RETURNING *',
      [p.nome, p.servico_id, p.quantidade, p.valor, p.validade_dias, p.recorrente, p.ativo, req.params.id]);
    if (!rows[0]) throw erro(404, 'Pacote não encontrado');
    res.json(rows[0]);
  }));
  app.delete('/api/pacotes/:id', pode('agenda_config'), rota(async (req, res) => {
    await q('DELETE FROM pacotes WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  }));
  // pacotes com saldo de um cliente (usado ao concluir o atendimento)
  app.get('/api/pacotes/cliente', rota(async (req, res) => {
    res.json(await doCliente({ cliente_id: parseInt(req.query.cliente_id, 10) || null, telefone: req.query.telefone || null }));
  }));
  app.get('/api/clientes/:id/pacotes', rota(async (req, res) => res.json(await doCliente({ cliente_id: Number(req.params.id), todos: true }))));
  app.post('/api/clientes/:id/pacotes', pode('pagamentos'), rota(async (req, res) => res.json(await vender(Number(req.params.id), req.body || {}, req.usuario.nome))));
  app.post('/api/pacotes-clientes/:id/cancelar', pode('pagamentos'), rota(async (req, res) => {
    await q("UPDATE pacotes_clientes SET status = 'cancelado' WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  }));
}

module.exports = { iniciar, rotas, tick, usar, estornarUso, vender, doCliente, renovarAssinaturas };
