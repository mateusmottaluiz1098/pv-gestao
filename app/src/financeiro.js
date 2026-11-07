// Financeiro do dia a dia: consumo avulso / fiado, produtos e vendas, caixa do dia
const { q } = require('./db');
const cfg = require('./config');
const wa = require('./whatsapp');
const C = require('./cobrancas');
const U = require('./util');

const TZ = 'America/Sao_Paulo';
const FORMAS = ['pix', 'dinheiro', 'cartao', 'debito', 'transferencia', 'boleto', 'fiado'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS consumos (
  id SERIAL PRIMARY KEY,
  cliente_id INT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  data DATE NOT NULL,
  descricao TEXT NOT NULL,
  valor NUMERIC(12,2) NOT NULL,
  origem TEXT NOT NULL DEFAULT 'manual',
  agendamento_id INT REFERENCES agendamentos(id) ON DELETE SET NULL,
  venda_id INT,
  cobranca_id INT REFERENCES cobrancas(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pendente',
  criado_por TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consumos_cli_idx ON consumos (cliente_id, cobranca_id);
ALTER TABLE consumos ADD COLUMN IF NOT EXISTS modo TEXT NOT NULL DEFAULT 'pendurar';
CREATE TABLE IF NOT EXISTS produtos (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  preco NUMERIC(12,2) NOT NULL DEFAULT 0,
  comissao_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  estoque INT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS vendas (
  id SERIAL PRIMARY KEY,
  produto_id INT REFERENCES produtos(id) ON DELETE SET NULL,
  descricao TEXT NOT NULL,
  quantidade INT NOT NULL DEFAULT 1,
  valor_unit NUMERIC(12,2) NOT NULL,
  valor_total NUMERIC(12,2) NOT NULL,
  profissional_id INT REFERENCES profissionais(id) ON DELETE SET NULL,
  comissao_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  comissao_valor NUMERIC(12,2) NOT NULL DEFAULT 0,
  forma_pagamento TEXT NOT NULL,
  cliente_id INT REFERENCES clientes(id) ON DELETE SET NULL,
  cliente_nome TEXT,
  data DATE NOT NULL,
  criado_por TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vendas_data_idx ON vendas (data);
CREATE TABLE IF NOT EXISTS caixa_movimentos (
  id SERIAL PRIMARY KEY,
  data DATE NOT NULL,
  tipo TEXT NOT NULL,
  descricao TEXT NOT NULL,
  valor NUMERIC(12,2) NOT NULL,
  forma TEXT NOT NULL DEFAULT 'dinheiro',
  criado_por TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS caixa_mov_data_idx ON caixa_movimentos (data);
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS pago_em TIMESTAMPTZ;
`;

async function iniciar() { await q(SCHEMA); }

function erro(status, msg) { const e = new Error(msg); e.status = status; return e; }
const num = (v) => Number(String(v ?? '').replace(',', '.'));
const okData = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// ---------- Cliente a partir de nome/telefone (cria um cadastro "só avulso" se não existir) ----------
async function clientePorTelefone(nome, telefone) {
  const tel = U.normalizarTelefone(telefone);
  if (!U.telefoneValido(tel)) throw erro(400, 'Para pendurar na conta, o cliente precisa de um WhatsApp válido.');
  const chave = U.chaveTelefone(tel);
  const { rows } = await q('SELECT * FROM clientes ORDER BY ativo DESC, id');
  const achado = rows.find((c) => U.chaveTelefone(c.telefone) === chave);
  if (achado) return achado;
  const { rows: novo } = await q(
    `INSERT INTO clientes (nome, telefone, valor, forma, dia_vencimento, primeiro_vencimento, observacoes)
     VALUES ($1, $2, 0, 'avulso', 1, $3, 'Cadastrado automaticamente (fiado)') RETURNING *`,
    [String(nome || '').trim() || 'Cliente', tel, U.hoje()]
  );
  return novo[0];
}

// ---------- Consumo avulso / fiado ----------
// modo 'agora': gera uma cobrança avulsa na hora · modo 'pendurar': entra na próxima cobrança do cliente
async function lancarConsumo(clienteId, { descricao, valor, data, modo, origem, agendamento_id, venda_id, por }) {
  const v = Math.round(num(valor) * 100) / 100;
  if (!(v > 0)) throw erro(400, 'Informe o valor');
  const desc = String(descricao || '').trim().slice(0, 120);
  if (!desc) throw erro(400, 'Informe o que foi consumido (ex.: Corte)');
  const dia = okData(data) ? data : U.hoje();
  if (agendamento_id) {
    const { rows: ja } = await q('SELECT id FROM consumos WHERE agendamento_id = $1', [agendamento_id]);
    if (ja[0]) throw erro(400, 'Este atendimento já foi lançado na conta do cliente.');
  }
  const { rows } = await q(
    `INSERT INTO consumos (cliente_id, data, descricao, valor, origem, agendamento_id, venda_id, criado_por, modo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [clienteId, dia, desc, v, origem || 'manual', agendamento_id || null, venda_id || null, por || null, modo === 'agora' ? 'agora' : 'pendurar']
  );
  const consumo = rows[0];
  if (modo === 'agora') {
    const cb = await C.criarAvulsa(clienteId, { valor: v, descricao: desc, vencimento: U.hoje() });
    await q('UPDATE consumos SET cobranca_id = $1 WHERE id = $2', [cb.id, consumo.id]);
    return { consumo, cobranca: cb };
  }
  // pendurar: vai para a próxima cobrança em aberto (que ainda não venceu), se houver
  const { rows: prox } = await q(
    `SELECT id, vencimento FROM cobrancas WHERE cliente_id = $1 AND tipo = 'recorrente' AND status = 'aberto' AND vencimento >= $2
      ORDER BY vencimento LIMIT 1`, [clienteId, U.hoje()]);
  if (prox[0]) {
    await C.anexarConsumosPendentes(clienteId, prox[0].id);
    return { consumo, anexado_em: prox[0].vencimento };
  }
  return { consumo, anexado_em: null };
}

// transforma todo o fiado pendente do cliente numa cobrança avulsa
async function cobrarFiado(clienteId) {
  const { rows } = await q("SELECT * FROM consumos WHERE cliente_id = $1 AND cobranca_id IS NULL AND status = 'pendente' ORDER BY data", [clienteId]);
  if (!rows.length) throw erro(400, 'Este cliente não tem fiado pendente.');
  const total = rows.reduce((s, r) => s + Number(r.valor), 0);
  const desc = rows.length === 1 ? rows[0].descricao : `${rows.length} consumos em aberto`;
  const cb = await C.criarAvulsa(clienteId, { valor: total, descricao: desc, vencimento: U.hoje() });
  await q('UPDATE consumos SET cobranca_id = $1 WHERE id = ANY($2)', [cb.id, rows.map((r) => r.id)]);
  return cb;
}

async function excluirConsumo(id) {
  const { rows } = await q('SELECT c.*, cb.status AS cob_status, cb.tipo AS cob_tipo FROM consumos c LEFT JOIN cobrancas cb ON cb.id = c.cobranca_id WHERE c.id = $1', [id]);
  const c = rows[0];
  if (!c) throw erro(404, 'Lançamento não encontrado');
  if (c.cob_status === 'pago') throw erro(400, 'Este lançamento já foi pago. Desfaça o pagamento da cobrança antes.');
  if (c.cobranca_id && c.cob_status === 'aberto') {
    await q('UPDATE cobrancas SET valor = GREATEST(valor - $1, 0) WHERE id = $2', [c.valor, c.cobranca_id]);
    if (c.cob_tipo === 'avulsa') await q("UPDATE cobrancas SET status = 'cancelado' WHERE id = $1 AND valor <= 0", [c.cobranca_id]);
  }
  await q('DELETE FROM consumos WHERE id = $1', [id]);
  if (c.agendamento_id) await q("UPDATE agendamentos SET forma_pagamento = NULL WHERE id = $1 AND forma_pagamento = 'fiado' AND NOT pago", [c.agendamento_id]);
}

// manda a cobrança avulsa no WhatsApp (texto + Pix)
async function enviarAvulsa(cb, clienteId) {
  const c = await cfg.obter();
  const { rows } = await q('SELECT * FROM clientes WHERE id = $1', [clienteId]);
  const st = await wa.estado();
  if (!st.conectado) return { ok: false, erro: 'WhatsApp desconectado' };
  return C.enviarCobranca(cb, rows[0], { id: 'avulso', modelo: c.modelo_avulso });
}

// pendura um atendimento concluído da agenda na conta do cliente
async function pendurarAgendamento(agId, por) {
  const { rows } = await q(
    `SELECT a.*, s.nome AS servico_nome, to_char(a.inicio AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS dia
       FROM agendamentos a LEFT JOIN servicos s ON s.id = a.servico_id WHERE a.id = $1`, [agId]);
  const a = rows[0];
  if (!a) throw erro(404, 'Agendamento não encontrado');
  if (!(Number(a.valor) > 0)) throw erro(400, 'Informe o valor do atendimento antes de pendurar.');
  let cliente;
  if (a.cliente_id) {
    const { rows: cl } = await q('SELECT * FROM clientes WHERE id = $1', [a.cliente_id]);
    cliente = cl[0];
  }
  if (!cliente) cliente = await clientePorTelefone(a.cliente_nome, a.telefone);
  await q("UPDATE agendamentos SET cliente_id = $1, pago = FALSE, pago_em = NULL, forma_pagamento = 'fiado' WHERE id = $2", [cliente.id, agId]);
  const r = await lancarConsumo(cliente.id, {
    descricao: `${a.servico_nome || 'Atendimento'} ${U.brData(a.dia).slice(0, 5)}`, valor: a.valor, data: a.dia,
    modo: 'pendurar', origem: 'agenda', agendamento_id: agId, por,
  });
  return { ...r, cliente };
}

// ---------- Produtos e vendas ----------
function validarProduto(b) {
  const nome = String(b.nome || '').trim();
  if (!nome) throw erro(400, 'Informe o nome do produto');
  const preco = num(b.preco || 0);
  if (!(preco >= 0)) throw erro(400, 'Preço inválido');
  const com = num(b.comissao_pct || 0);
  if (!(com >= 0 && com <= 100)) throw erro(400, 'Comissão deve ficar entre 0 e 100%');
  const estoque = b.estoque === '' || b.estoque == null ? null : parseInt(b.estoque, 10);
  if (estoque != null && isNaN(estoque)) throw erro(400, 'Estoque inválido');
  return { nome, preco, com, estoque, ativo: b.ativo !== false };
}

async function registrarVenda(b, por) {
  const qtd = Math.max(1, parseInt(b.quantidade, 10) || 1);
  let produto = null;
  if (b.produto_id) {
    const { rows } = await q('SELECT * FROM produtos WHERE id = $1', [b.produto_id]);
    produto = rows[0];
    if (!produto) throw erro(404, 'Produto não encontrado');
  }
  const descricao = String(b.descricao || (produto && produto.nome) || '').trim();
  if (!descricao) throw erro(400, 'Escolha o produto');
  const unit = b.valor_unit !== '' && b.valor_unit != null ? num(b.valor_unit) : Number(produto ? produto.preco : 0);
  if (!(unit > 0)) throw erro(400, 'Informe o valor');
  const total = Math.round(unit * qtd * 100) / 100;
  const forma = FORMAS.includes(b.forma_pagamento) ? b.forma_pagamento : 'dinheiro';
  const prof = b.profissional_id ? parseInt(b.profissional_id, 10) : null;
  const pct = prof ? Number(produto ? produto.comissao_pct : num(b.comissao_pct || 0)) || 0 : 0;
  const comissao = Math.round(total * pct) / 100;
  const data = okData(b.data) ? b.data : U.hoje();
  let cliente = null;
  if (forma === 'fiado') {
    if (b.cliente_id) {
      const { rows } = await q('SELECT * FROM clientes WHERE id = $1', [b.cliente_id]);
      cliente = rows[0];
    }
    if (!cliente) cliente = await clientePorTelefone(b.cliente_nome, b.telefone);
  }
  const { rows } = await q(
    `INSERT INTO vendas (produto_id, descricao, quantidade, valor_unit, valor_total, profissional_id, comissao_pct, comissao_valor, forma_pagamento, cliente_id, cliente_nome, data, criado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [produto ? produto.id : null, descricao, qtd, unit, total, prof, pct, comissao, forma, cliente ? cliente.id : null,
      cliente ? cliente.nome : (String(b.cliente_nome || '').trim() || null), data, por || null]
  );
  const venda = rows[0];
  if (produto && produto.estoque != null) await q('UPDATE produtos SET estoque = estoque - $1 WHERE id = $2', [qtd, produto.id]);
  let fiado = null;
  if (cliente) {
    fiado = await lancarConsumo(cliente.id, { descricao: `${qtd > 1 ? qtd + 'x ' : ''}${descricao}`, valor: total, data, modo: 'pendurar', origem: 'produto', venda_id: venda.id, por });
  }
  return { venda, fiado };
}

async function excluirVenda(id) {
  const { rows } = await q('SELECT * FROM vendas WHERE id = $1', [id]);
  const v = rows[0];
  if (!v) throw erro(404, 'Venda não encontrada');
  const { rows: cons } = await q('SELECT id FROM consumos WHERE venda_id = $1', [id]);
  for (const c of cons) await excluirConsumo(c.id);
  if (v.produto_id) await q('UPDATE produtos SET estoque = estoque + $1 WHERE id = $2 AND estoque IS NOT NULL', [v.quantidade, v.produto_id]);
  await q('DELETE FROM vendas WHERE id = $1', [id]);
}

// ---------- Caixa do dia ----------
async function caixaDoDia(data) {
  const entradas = [];
  const { rows: ags } = await q(
    `SELECT a.id, a.valor, a.forma_pagamento, a.cliente_nome, p.nome AS profissional, s.nome AS servico,
            to_char(COALESCE(a.pago_em, a.inicio) AT TIME ZONE '${TZ}', 'HH24:MI') AS hora
       FROM agendamentos a JOIN profissionais p ON p.id = a.profissional_id LEFT JOIN servicos s ON s.id = a.servico_id
      WHERE a.pago AND COALESCE(a.forma_pagamento, '') <> 'fiado' AND a.status <> 'cancelado'
        AND (COALESCE(a.pago_em, a.inicio) AT TIME ZONE '${TZ}')::date = $1`, [data]);
  for (const a of ags) entradas.push({ origem: 'atendimento', hora: a.hora, descricao: a.servico || 'Atendimento', cliente: a.cliente_nome, profissional: a.profissional, forma: a.forma_pagamento || 'dinheiro', valor: Number(a.valor || 0) });
  const { rows: cobs } = await q(
    `SELECT cb.id, cb.pago_valor, cb.valor, cb.forma_pagamento, cb.tipo, cb.descricao, cb.competencia, cb.vencimento, cb.numero_parcela, cl.nome, cl.forma, cl.parcelas_total
       FROM cobrancas cb JOIN clientes cl ON cl.id = cb.cliente_id
      WHERE cb.status = 'pago' AND cb.pago_em = $1`, [data]);
  for (const c of cobs) entradas.push({ origem: 'cobranca', hora: '', descricao: `Cobrança · ${C.descricaoCobranca(c, c)}`, cliente: c.nome, profissional: null, forma: c.forma_pagamento || 'pix', valor: Number(c.pago_valor ?? c.valor) });
  const { rows: vds } = await q(
    `SELECT v.*, p.nome AS profissional, to_char(v.criado_em AT TIME ZONE '${TZ}', 'HH24:MI') AS hora
       FROM vendas v LEFT JOIN profissionais p ON p.id = v.profissional_id WHERE v.data = $1 ORDER BY v.criado_em`, [data]);
  for (const v of vds) {
    if (v.forma_pagamento === 'fiado') continue;
    entradas.push({ origem: 'venda', id: v.id, hora: v.hora, descricao: `${v.quantidade > 1 ? v.quantidade + 'x ' : ''}${v.descricao}`, cliente: v.cliente_nome, profissional: v.profissional, forma: v.forma_pagamento, valor: Number(v.valor_total) });
  }
  const { rows: movs } = await q(`SELECT *, to_char(criado_em AT TIME ZONE '${TZ}', 'HH24:MI') AS hora FROM caixa_movimentos WHERE data = $1 ORDER BY criado_em`, [data]);
  const saidas = [];
  for (const m of movs) {
    const item = { origem: 'manual', id: m.id, hora: m.hora, descricao: m.descricao, forma: m.forma, valor: Number(m.valor), por: m.criado_por };
    if (m.tipo === 'entrada') entradas.push(item); else saidas.push(item);
  }
  entradas.sort((a, b) => String(a.hora).localeCompare(String(b.hora)));

  // comissões geradas no dia (atendimentos concluídos + produtos vendidos)
  const { rows: com } = await q(
    `SELECT p.id, p.nome, p.cor, COALESCE(SUM(a.comissao_valor), 0) AS servicos, COUNT(a.id)::int AS atendimentos
       FROM profissionais p JOIN agendamentos a ON a.profissional_id = p.id AND a.status = 'concluido'
        AND (a.inicio AT TIME ZONE '${TZ}')::date = $1
      GROUP BY p.id ORDER BY p.nome`, [data]);
  const { rows: comV } = await q(
    `SELECT p.id, p.nome, p.cor, COALESCE(SUM(v.comissao_valor), 0) AS produtos FROM vendas v JOIN profissionais p ON p.id = v.profissional_id
      WHERE v.data = $1 GROUP BY p.id`, [data]);
  const comissoes = {};
  for (const r of com) comissoes[r.id] = { nome: r.nome, cor: r.cor, atendimentos: r.atendimentos, servicos: Number(r.servicos), produtos: 0 };
  for (const r of comV) (comissoes[r.id] = comissoes[r.id] || { nome: r.nome, cor: r.cor, atendimentos: 0, servicos: 0, produtos: 0 }).produtos = Number(r.produtos);
  const listaCom = Object.values(comissoes).map((c) => ({ ...c, total: +(c.servicos + c.produtos).toFixed(2) }));

  const { rows: fiado } = await q("SELECT COALESCE(SUM(valor), 0) AS v, COUNT(*)::int AS n FROM consumos WHERE data = $1 AND modo = 'pendurar'", [data]);

  const porForma = {};
  for (const e of entradas) porForma[e.forma] = +((porForma[e.forma] || 0) + e.valor).toFixed(2);
  const totEntradas = entradas.reduce((s, e) => s + e.valor, 0);
  const totSaidas = saidas.reduce((s, e) => s + e.valor, 0);
  const totCom = listaCom.reduce((s, c) => s + c.total, 0);
  const dinheiroEntrou = entradas.filter((e) => e.forma === 'dinheiro').reduce((s, e) => s + e.valor, 0);
  const dinheiroSaiu = saidas.filter((e) => e.forma === 'dinheiro').reduce((s, e) => s + e.valor, 0);
  return {
    data, entradas, saidas, por_forma: porForma, comissoes: listaCom,
    fiado: { valor: Number(fiado[0].v), qtd: fiado[0].n },
    totais: {
      entradas: +totEntradas.toFixed(2), saidas: +totSaidas.toFixed(2), comissoes: +totCom.toFixed(2),
      resultado: +(totEntradas - totSaidas - totCom).toFixed(2), dinheiro_em_caixa: +(dinheiroEntrou - dinheiroSaiu).toFixed(2),
    },
  };
}

// ---------- Rotas ----------
function rotas(app, { rota, pode }) {
  // consumos / fiado de um cliente
  app.get('/api/clientes/:id/consumos', rota(async (req, res) => {
    const { rows } = await q(
      `SELECT c.*, cb.status AS cob_status, cb.vencimento AS cob_vencimento, cb.tipo AS cob_tipo
         FROM consumos c LEFT JOIN cobrancas cb ON cb.id = c.cobranca_id
        WHERE c.cliente_id = $1 ORDER BY c.data DESC, c.id DESC LIMIT 200`, [req.params.id]);
    res.json(rows);
  }));
  app.post('/api/clientes/:id/consumos', pode('pagamentos'), rota(async (req, res) => {
    const b = req.body || {};
    const r = await lancarConsumo(Number(req.params.id), { ...b, origem: 'manual', por: req.usuario.nome });
    let aviso = null;
    if (r.cobranca && b.enviar) {
      const e = await enviarAvulsa(r.cobranca, Number(req.params.id));
      if (!e.ok) aviso = 'Lançado, mas a mensagem não foi enviada: ' + e.erro;
    }
    res.json({ ...r, aviso });
  }));
  app.post('/api/clientes/:id/fiado/cobrar', pode('pagamentos'), rota(async (req, res) => {
    const cb = await cobrarFiado(Number(req.params.id));
    let aviso = null;
    if (req.body && req.body.enviar) {
      const e = await enviarAvulsa(cb, Number(req.params.id));
      if (!e.ok) aviso = 'Cobrança criada, mas a mensagem não foi enviada: ' + e.erro;
    }
    res.json({ cobranca: cb, aviso });
  }));
  app.delete('/api/consumos/:id', pode('pagamentos'), rota(async (req, res) => { await excluirConsumo(req.params.id); res.json({ ok: true }); }));

  // produtos
  app.get('/api/produtos', rota(async (req, res) => res.json((await q('SELECT * FROM produtos ORDER BY ativo DESC, nome')).rows)));
  app.post('/api/produtos', pode('agenda_config'), rota(async (req, res) => {
    const p = validarProduto(req.body || {});
    const { rows } = await q('INSERT INTO produtos (nome, preco, comissao_pct, estoque, ativo) VALUES ($1,$2,$3,$4,$5) RETURNING *', [p.nome, p.preco, p.com, p.estoque, p.ativo]);
    res.json(rows[0]);
  }));
  app.put('/api/produtos/:id', pode('agenda_config'), rota(async (req, res) => {
    const p = validarProduto(req.body || {});
    const { rows } = await q('UPDATE produtos SET nome=$1, preco=$2, comissao_pct=$3, estoque=$4, ativo=$5 WHERE id=$6 RETURNING *', [p.nome, p.preco, p.com, p.estoque, p.ativo, req.params.id]);
    if (!rows[0]) throw erro(404, 'Produto não encontrado');
    res.json(rows[0]);
  }));
  app.delete('/api/produtos/:id', pode('agenda_config'), rota(async (req, res) => {
    const { rows } = await q('SELECT COUNT(*)::int n FROM vendas WHERE produto_id = $1', [req.params.id]);
    if (rows[0].n) throw erro(400, 'Este produto já tem vendas. Desative em vez de excluir.');
    await q('DELETE FROM produtos WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  }));

  // vendas
  app.post('/api/vendas', pode('pagamentos'), rota(async (req, res) => res.json(await registrarVenda(req.body || {}, req.usuario.nome))));
  app.delete('/api/vendas/:id', pode('pagamentos'), rota(async (req, res) => { await excluirVenda(req.params.id); res.json({ ok: true }); }));

  // caixa
  app.get('/api/caixa', pode('financeiro'), rota(async (req, res) => res.json(await caixaDoDia(okData(req.query.data) ? req.query.data : U.hoje()))));
  app.post('/api/caixa/movimentos', pode('financeiro'), rota(async (req, res) => {
    const b = req.body || {};
    const tipo = b.tipo === 'entrada' ? 'entrada' : 'saida';
    const valor = num(b.valor);
    if (!(valor > 0)) throw erro(400, 'Informe o valor');
    const desc = String(b.descricao || '').trim();
    if (!desc) throw erro(400, 'Informe a descrição');
    const forma = FORMAS.includes(b.forma) && b.forma !== 'fiado' ? b.forma : 'dinheiro';
    const { rows } = await q('INSERT INTO caixa_movimentos (data, tipo, descricao, valor, forma, criado_por) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [okData(b.data) ? b.data : U.hoje(), tipo, desc.slice(0, 120), valor, forma, req.usuario.nome]);
    res.json(rows[0]);
  }));
  app.delete('/api/caixa/movimentos/:id', pode('financeiro'), rota(async (req, res) => { await q('DELETE FROM caixa_movimentos WHERE id = $1', [req.params.id]); res.json({ ok: true }); }));
}

// quanto entrou no período fora das cobranças (atendimentos pagos, produtos e entradas avulsas do caixa)
async function recebidoNoPeriodo(de, ate) {
  const [{ rows: a }, { rows: v }, { rows: m }] = await Promise.all([
    q(`SELECT COUNT(*)::int n, COALESCE(SUM(valor), 0) v FROM agendamentos
        WHERE pago AND COALESCE(forma_pagamento, '') <> 'fiado' AND status <> 'cancelado'
          AND (COALESCE(pago_em, inicio) AT TIME ZONE '${TZ}')::date BETWEEN $1 AND $2`, [de, ate]),
    q("SELECT COUNT(*)::int n, COALESCE(SUM(valor_total), 0) v FROM vendas WHERE forma_pagamento <> 'fiado' AND data BETWEEN $1 AND $2", [de, ate]),
    q("SELECT COALESCE(SUM(valor), 0) v FROM caixa_movimentos WHERE tipo = 'entrada' AND data BETWEEN $1 AND $2", [de, ate]),
  ]);
  return { atendimentos: { n: a[0].n, v: Number(a[0].v) }, vendas: { n: v[0].n, v: Number(v[0].v) }, outros: Number(m[0].v) };
}

module.exports = { iniciar, rotas, lancarConsumo, pendurarAgendamento, registrarVenda, caixaDoDia, recebidoNoPeriodo, clientePorTelefone, FORMAS };
