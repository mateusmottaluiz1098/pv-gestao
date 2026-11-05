const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { q, migrar } = require('./db');
const cfg = require('./config');
const wa = require('./whatsapp');
const C = require('./cobrancas');
const USR = require('./usuarios');
const AG = require('./agenda');
const U = require('./util');

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));

// ---------- Autenticação por usuário ----------
const SENHA_INICIAL = process.env.ADMIN_SENHA || 'admin';
const SEGREDO = process.env.SESSAO_SEGREDO || crypto.createHash('sha256').update('cobrancas:' + SENHA_INICIAL).digest('hex');
const DURACAO = 30 * 24 * 3600 * 1000;

function assinar(txt) {
  return crypto.createHmac('sha256', SEGREDO).update(String(txt)).digest('hex');
}
function lerCookie(req, nome) {
  const m = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(nome + '='));
  return m ? decodeURIComponent(m.slice(nome.length + 1)) : null;
}
function criarSessao(res, u) {
  const exp = Date.now() + DURACAO;
  const corpo = `${u.id}.${u.versao_sessao}.${exp}`;
  res.setHeader('Set-Cookie', `sessao=${corpo}.${assinar(corpo)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${DURACAO / 1000}`);
}
// Retorna o usuário da sessão (ou null)
async function usuarioDaSessao(req) {
  const v = lerCookie(req, 'sessao');
  if (!v) return null;
  const partes = v.split('.');
  if (partes.length !== 4) return null;
  const [id, versao, exp, sig] = partes;
  if (Number(exp) < Date.now()) return null;
  const esperado = assinar(`${id}.${versao}.${exp}`);
  if (sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return null;
  const u = await USR.porId(id);
  if (!u || !u.ativo || String(u.versao_sessao) !== versao) return null;
  return u;
}

// limite simples de tentativas de login por IP
const tentativas = new Map();
app.post('/api/login', async (req, res) => {
  const ip = req.ip || 'x';
  const t = tentativas.get(ip) || { n: 0, ate: 0 };
  if (t.ate > Date.now()) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde alguns minutos.' });
  const u = await USR.autenticar(req.body && req.body.login, req.body && req.body.senha).catch(() => null);
  if (!u) {
    t.n++;
    if (t.n >= 8) { t.ate = Date.now() + 5 * 60 * 1000; t.n = 0; }
    tentativas.set(ip, t);
    return res.status(401).json({ erro: 'Usuário ou senha incorretos' });
  }
  tentativas.delete(ip);
  criarSessao(res, u);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'sessao=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ---------- Webhook do WhatsApp (antes da proteção por login) ----------
app.post('/webhook/whatsapp', async (req, res) => {
  const token = process.env.WEBHOOK_TOKEN;
  if (token && req.query.token !== token) return res.status(403).end();
  res.json({ ok: true });
  try { await tratarWebhook(req.body); } catch (e) { console.error('[webhook]', e.message); }
});

function extrairNumero(d) {
  const k = d.key || {};
  const candidatos = [k.remoteJid, k.remoteJidAlt, k.senderPn, d.senderPn, d.sender];
  for (const c of candidatos) {
    if (c && /@s\.whatsapp\.net$/.test(c)) return c.split('@')[0];
  }
  for (const c of candidatos) {
    if (c && /^\d{10,15}(@|$)/.test(c) && !/@g\.us$/.test(c) && !/@lid$/.test(c)) return c.split('@')[0];
  }
  return null;
}

async function tratarWebhook(body) {
  if (!body) return;
  const evento = String(body.event || '').toLowerCase().replace('_', '.');
  if (evento !== 'messages.upsert') return;
  const lista = Array.isArray(body.data) ? body.data : [body.data];
  for (const d of lista) {
    if (!d || !d.key || d.key.fromMe) continue;
    if (String(d.key.remoteJid || '').endsWith('@g.us')) continue;
    const numero = extrairNumero(d);
    const msg = d.message || {};
    const img = msg.imageMessage;
    const doc = msg.documentMessage || (msg.documentWithCaptionMessage && msg.documentWithCaptionMessage.message && msg.documentWithCaptionMessage.message.documentMessage);
    const texto = msg.conversation || (msg.extendedTextMessage && msg.extendedTextMessage.text) || (img && img.caption) || (doc && doc.caption) || '';

    // Respostas da agenda (SIM / CANCELAR)
    if (numero && texto && !img && !doc) {
      const tratado = await AG.tratarResposta(numero, texto).catch((e) => { console.warn('[agenda] resposta:', e.message); return false; });
      if (tratado) continue;
    }

    // Identifica o cliente pelo número
    let cliente = null;
    if (numero) {
      const chave = U.chaveTelefone(numero);
      const { rows } = await q('SELECT * FROM clientes');
      cliente = rows.find((c) => U.chaveTelefone(c.telefone) === chave) || null;
    }
    if (!cliente) continue; // ignora quem não é cliente

    // só guarda comprovantes (imagem/PDF); conversas comuns não são salvas
    if (!img && !doc) continue;
    let base64 = msg.base64 || d.base64 || null;
    if (!base64) {
      try { base64 = await wa.baixarMidia(d); } catch (e) { console.warn('[webhook] mídia:', e.message); }
    }
    const mimetype = (img && img.mimetype) || (doc && doc.mimetype) || 'application/octet-stream';
    const nomeArquivo = (doc && doc.fileName) || (img ? 'comprovante.jpg' : 'arquivo');

    // cobrança em aberto mais antiga do cliente
    const { rows: abertas } = await q(
      "SELECT id FROM cobrancas WHERE cliente_id=$1 AND status='aberto' AND vencimento <= $2 ORDER BY vencimento LIMIT 1",
      [cliente.id, U.somarDias(U.hoje(), 15)]
    );
    await q(
      `INSERT INTO comprovantes (cliente_id, cobranca_id, telefone, nome_contato, mimetype, nome_arquivo, legenda, arquivo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [cliente.id, abertas[0] ? abertas[0].id : null, numero, d.pushName || null, mimetype, nomeArquivo, texto || null,
        base64 ? Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64') : null]
    );

    const c = await cfg.obter();
    if (c.responder_comprovante && abertas[0]) {
      const texto2 = await C.renderizar(c.modelo_resposta_comprovante, cliente, null);
      try {
        await wa.enviarTexto(U.normalizarTelefone(cliente.telefone), texto2);
        await C.registrar({ cliente_id: cliente.id, direcao: 'saida', etapa: 'resposta_comprovante', telefone: numero, texto: texto2, status: 'enviado' });
      } catch (e) { console.warn('[webhook] resposta:', e.message); }
    }
  }
}

// ---------- Marca (pública: usada na tela de login) ----------
app.get('/api/marca', async (req, res) => {
  try {
    const c = await cfg.obter();
    const logo = await cfg.obterLogo();
    res.json({ sistema_nome: c.sistema_nome, tema: c.tema, empresa: c.empresa, tem_logo: !!logo, logo_versao: logo ? logo.versao : null });
  } catch (e) {
    res.json({ sistema_nome: 'PV Gestão', tema: 'azul', tem_logo: false });
  }
});

app.get('/marca/logo', async (req, res) => {
  const logo = await cfg.obterLogo().catch(() => null);
  if (!logo) return res.status(404).end();
  res.setHeader('Content-Type', logo.mime);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.end(Buffer.from(logo.base64, 'base64'));
});

// ---------- Proteção das rotas da API ----------
app.use('/api', (req, res, next) => {
  usuarioDaSessao(req).then((u) => {
    if (!u) return res.status(401).json({ erro: 'Faça login' });
    req.usuario = u;
    next();
  }).catch(next);
});

const rota = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  res.status(e.status && e.status < 500 ? e.status : 500).json({ erro: e.message });
});

function erro(status, msg) { const e = new Error(msg); e.status = status; return e; }

function pode(perm) {
  return (req, res, next) => {
    if (USR.tem(req.usuario, perm)) return next();
    res.status(403).json({ erro: 'Seu usuário não tem permissão para isso. Fale com o administrador.' });
  };
}

app.get('/api/me', (req, res) => res.json({ ...USR.publico(req.usuario), lista_permissoes: USR.PERMISSOES }));

app.post('/api/me/senha', rota(async (req, res) => {
  const u = await USR.trocarPropriaSenha(req.usuario.id, req.body.atual, req.body.nova);
  criarSessao(res, u);
  res.json({ ok: true });
}));

// ---------- Usuários ----------
app.get('/api/usuarios', pode('usuarios'), rota(async (req, res) => res.json(await USR.listar())));
app.post('/api/usuarios', pode('usuarios'), rota(async (req, res) => res.json(await USR.criar(req.body || {}))));
app.put('/api/usuarios/:id', pode('usuarios'), rota(async (req, res) => {
  const r = await USR.atualizar(req.params.id, req.body || {}, req.usuario);
  if (Number(req.params.id) === req.usuario.id) criarSessao(res, await USR.porId(req.usuario.id));
  res.json(r);
}));
app.delete('/api/usuarios/:id', pode('usuarios'), rota(async (req, res) => { await USR.excluir(req.params.id, req.usuario); res.json({ ok: true }); }));

AG.rotas(app, { rota, pode });

// ---------- Painel ----------
app.get('/api/painel', rota(async (req, res) => {
  await C.gerarCobrancas();
  const hoje = U.hoje();
  const mes = hoje.slice(0, 7) + '-01';
  const [ativos, vencemHoje, atraso, recebido, comprov, enviadosHoje] = await Promise.all([
    q('SELECT COUNT(*)::int n FROM clientes WHERE ativo'),
    q("SELECT COUNT(*)::int n, COALESCE(SUM(valor),0) v FROM cobrancas WHERE status='aberto' AND vencimento=$1", [hoje]),
    q("SELECT COUNT(*)::int n, COALESCE(SUM(valor),0) v FROM cobrancas WHERE status='aberto' AND vencimento<$1", [hoje]),
    q("SELECT COUNT(*)::int n, COALESCE(SUM(pago_valor),0) v FROM cobrancas WHERE status='pago' AND pago_em >= $1", [mes]),
    q("SELECT COUNT(*)::int n FROM comprovantes WHERE status='pendente'"),
    q("SELECT COUNT(*)::int n FROM mensagens WHERE direcao='saida' AND status='enviado' AND (criado_em AT TIME ZONE 'America/Sao_Paulo')::date=$1", [hoje]),
  ]);
  const previstoMes = await q("SELECT COALESCE(SUM(valor),0) v FROM cobrancas WHERE competencia=$1 AND status<>'cancelado'", [mes]);
  const fila = await C.montarFila();
  const c = await cfg.obter();
  const etapas = Object.fromEntries((c.regua || []).map((e) => [e.id, e]));
  const { rows: ultimas } = await q(
    `SELECT m.*, cl.nome FROM mensagens m LEFT JOIN clientes cl ON cl.id=m.cliente_id ORDER BY m.criado_em DESC LIMIT 8`
  );
  res.json({
    hoje,
    ativos: ativos.rows[0].n,
    vencem_hoje: vencemHoje.rows[0],
    atraso: atraso.rows[0],
    recebido_mes: recebido.rows[0],
    previsto_mes: previstoMes.rows[0].v,
    comprovantes_pendentes: comprov.rows[0].n,
    enviados_hoje: enviadosHoje.rows[0].n,
    fila: fila.map((f) => ({ ...f, etapa_nome: C.nomeEtapa(etapas[f.etapa] ? etapas[f.etapa].dias : f.etapa_dias) })),
    ultimas,
    execucao: C.execucao,
    automatico: c.envio_automatico,
    hora_envio: c.hora_envio,
    ultima_execucao: await cfg.ultimaExecucao(),
    agenda: await AG.resumoHoje(),
  });
}));

// ---------- Clientes ----------
function validarCliente(b) {
  const nome = String(b.nome || '').trim();
  if (!nome) throw erro(400, 'Informe o nome');
  const telefone = U.normalizarTelefone(b.telefone);
  if (!U.telefoneValido(telefone)) throw erro(400, 'Telefone inválido. Use DDD + número, ex.: 51 99999-9999');
  const valor = Number(String(b.valor).replace(',', '.'));
  if (!(valor > 0)) throw erro(400, 'Informe o valor');
  const dia = parseInt(b.dia_vencimento, 10);
  if (!(dia >= 1 && dia <= 31)) throw erro(400, 'Dia de vencimento inválido');
  const forma = b.forma === 'carne' ? 'carne' : 'mensal';
  const parcelas = forma === 'carne' ? parseInt(b.parcelas_total, 10) : null;
  if (forma === 'carne' && !(parcelas > 0)) throw erro(400, 'Informe a quantidade de parcelas do carnê');
  let primeiro = b.primeiro_vencimento;
  if (!primeiro || !/^\d{4}-\d{2}-\d{2}$/.test(primeiro)) {
    const h = U.hoje();
    const [y, m, d] = h.split('-').map(Number);
    primeiro = d <= dia ? U.vencimentoNoMes(y, m, dia) : (m === 12 ? U.vencimentoNoMes(y + 1, 1, dia) : U.vencimentoNoMes(y, m + 1, dia));
  }
  return {
    nome, telefone, valor, forma, dia_vencimento: dia, primeiro_vencimento: primeiro, parcelas_total: parcelas,
    identificacao: b.identificacao || null, endereco: b.endereco || null, observacoes: b.observacoes || null,
    ativo: b.ativo !== false, pausado: !!b.pausado,
  };
}

app.get('/api/clientes', rota(async (req, res) => {
  const hoje = U.hoje();
  const { rows } = await q(`
    SELECT cl.*,
      (SELECT row_to_json(x) FROM (SELECT id, vencimento, valor, status, numero_parcela FROM cobrancas
         WHERE cliente_id=cl.id AND status='aberto' ORDER BY vencimento LIMIT 1) x) AS proxima,
      (SELECT COUNT(*)::int FROM cobrancas WHERE cliente_id=cl.id AND status='aberto' AND vencimento < $1) AS atrasadas,
      (SELECT COALESCE(SUM(valor),0) FROM cobrancas WHERE cliente_id=cl.id AND status='aberto' AND vencimento < $1) AS valor_atrasado,
      (SELECT status FROM cobrancas WHERE cliente_id=cl.id AND competencia=$2) AS status_mes,
      (SELECT MAX(criado_em) FROM mensagens WHERE cliente_id=cl.id AND direcao='saida' AND status='enviado') AS ultima_msg
    FROM clientes cl ORDER BY cl.ativo DESC, cl.nome`, [hoje, hoje.slice(0, 7) + '-01']);
  res.json(rows);
}));

app.get('/api/clientes/:id', rota(async (req, res) => {
  const { rows } = await q('SELECT * FROM clientes WHERE id=$1', [req.params.id]);
  if (!rows[0]) throw erro(404, 'Cliente não encontrado');
  const cob = await q('SELECT * FROM cobrancas WHERE cliente_id=$1 ORDER BY vencimento DESC', [req.params.id]);
  const msgs = await q('SELECT * FROM mensagens WHERE cliente_id=$1 ORDER BY criado_em DESC LIMIT 50', [req.params.id]);
  res.json({ ...rows[0], cobrancas: cob.rows, mensagens: msgs.rows });
}));

app.post('/api/clientes', pode('clientes'), rota(async (req, res) => {
  const c = validarCliente(req.body);
  const { rows } = await q(
    `INSERT INTO clientes (nome, telefone, valor, forma, dia_vencimento, primeiro_vencimento, parcelas_total, identificacao, endereco, observacoes, ativo, pausado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [c.nome, c.telefone, c.valor, c.forma, c.dia_vencimento, c.primeiro_vencimento, c.parcelas_total, c.identificacao, c.endereco, c.observacoes, c.ativo, c.pausado]
  );
  await C.gerarCobrancas(rows[0].id);
  res.json(rows[0]);
}));

app.put('/api/clientes/:id', pode('clientes'), rota(async (req, res) => {
  const c = validarCliente(req.body);
  const { rows } = await q(
    `UPDATE clientes SET nome=$1, telefone=$2, valor=$3, forma=$4, dia_vencimento=$5, primeiro_vencimento=$6, parcelas_total=$7,
       identificacao=$8, endereco=$9, observacoes=$10, ativo=$11, pausado=$12 WHERE id=$13 RETURNING *`,
    [c.nome, c.telefone, c.valor, c.forma, c.dia_vencimento, c.primeiro_vencimento, c.parcelas_total, c.identificacao, c.endereco, c.observacoes, c.ativo, c.pausado, req.params.id]
  );
  if (!rows[0]) throw erro(404, 'Cliente não encontrado');
  await C.ajustarCobrancasFuturas(rows[0]);
  await C.gerarCobrancas(rows[0].id);
  res.json(rows[0]);
}));

app.delete('/api/clientes/:id', pode('clientes'), rota(async (req, res) => {
  await q('DELETE FROM clientes WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Cobranças ----------
app.get('/api/cobrancas', rota(async (req, res) => {
  await C.gerarCobrancas();
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : U.hoje().slice(0, 7);
  const { rows } = await q(`
    SELECT cb.*, cl.nome, cl.telefone, cl.parcelas_total, cl.identificacao,
      (SELECT MAX(criado_em) FROM mensagens WHERE cobranca_id=cb.id AND direcao='saida' AND status='enviado') AS ultima_msg,
      (SELECT COUNT(*)::int FROM mensagens WHERE cobranca_id=cb.id AND direcao='saida' AND status='enviado') AS qtd_msgs
    FROM cobrancas cb JOIN clientes cl ON cl.id=cb.cliente_id
    WHERE cb.competencia = $1 ORDER BY cb.vencimento, cl.nome`, [mes + '-01']);
  const hoje = U.hoje();
  const resumo = { previsto: 0, recebido: 0, aberto: 0, atrasado: 0, qtd: rows.length, pagos: 0 };
  for (const r of rows) {
    if (r.status === 'cancelado') continue;
    resumo.previsto += r.valor;
    if (r.status === 'pago') { resumo.recebido += r.pago_valor || r.valor; resumo.pagos++; }
    else { resumo.aberto += r.valor; if (r.vencimento < hoje) resumo.atrasado += r.valor; }
  }
  // atrasados de meses anteriores
  const ant = await q("SELECT COUNT(*)::int n, COALESCE(SUM(valor),0) v FROM cobrancas WHERE status='aberto' AND competencia < $1", [mes + '-01']);
  res.json({ mes, hoje, resumo, anteriores: ant.rows[0], itens: rows });
}));

app.get('/api/cobrancas/atrasadas', rota(async (req, res) => {
  const { rows } = await q(`
    SELECT cb.*, cl.nome, cl.telefone FROM cobrancas cb JOIN clientes cl ON cl.id=cb.cliente_id
    WHERE cb.status='aberto' AND cb.vencimento < $1 ORDER BY cb.vencimento`, [U.hoje()]);
  res.json(rows);
}));

app.post('/api/cobrancas/:id/pagar', pode('pagamentos'), rota(async (req, res) => {
  await C.marcarPago(req.params.id, { ...(req.body || {}), por: req.usuario.nome });
  res.json({ ok: true });
}));

app.post('/api/cobrancas/:id/desfazer', pode('pagamentos'), rota(async (req, res) => {
  await q("UPDATE cobrancas SET status='aberto', pago_em=NULL, pago_valor=NULL, forma_pagamento=NULL, pago_por=NULL WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/cobrancas/:id/cancelar', pode('pagamentos'), rota(async (req, res) => {
  await q("UPDATE cobrancas SET status='cancelado' WHERE id=$1 AND status='aberto'", [req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/cobrancas/:id/pix', rota(async (req, res) => {
  const { rows } = await q('SELECT cb.*, cl.nome FROM cobrancas cb JOIN clientes cl ON cl.id=cb.cliente_id WHERE cb.id=$1', [req.params.id]);
  if (!rows[0]) throw erro(404, 'Cobrança não encontrada');
  const pix = await C.pixDaCobranca(rows[0], rows[0]);
  if (!pix) throw erro(400, 'Cadastre a chave Pix em Configurações');
  res.json(pix);
}));

app.get('/api/cobrancas/:id/previa', rota(async (req, res) => {
  const { rows } = await q('SELECT * FROM cobrancas WHERE id=$1', [req.params.id]);
  if (!rows[0]) throw erro(404, 'Cobrança não encontrada');
  const { rows: cl } = await q('SELECT * FROM clientes WHERE id=$1', [rows[0].cliente_id]);
  const etapa = await etapaPara(rows[0]);
  const texto = await C.renderizar(etapa.modelo, cl[0], rows[0]);
  const pix = await C.pixDaCobranca(rows[0], cl[0]);
  res.json({ texto, pix: pix && pix.codigo, etapa: etapa.id, etapa_nome: C.nomeEtapa(etapa.dias) });
}));

async function etapaPara(cb) {
  const c = await cfg.obter();
  const etapas = (c.regua || []).filter((e) => e.ativo).sort((a, b) => a.dias - b.dias);
  if (!etapas.length) throw erro(400, 'Nenhuma etapa da régua está ativa');
  const diff = U.diffDias(U.hoje(), cb.vencimento);
  const eleg = etapas.filter((e) => e.dias <= diff);
  return eleg.length ? eleg[eleg.length - 1] : etapas[0];
}

app.post('/api/cobrancas/:id/enviar', pode('envios'), rota(async (req, res) => {
  const { rows } = await q('SELECT * FROM cobrancas WHERE id=$1', [req.params.id]);
  if (!rows[0]) throw erro(404, 'Cobrança não encontrada');
  const { rows: cl } = await q('SELECT * FROM clientes WHERE id=$1', [rows[0].cliente_id]);
  const st = await wa.estado();
  if (!st.conectado) throw erro(400, 'WhatsApp não está conectado');
  const etapa = await etapaPara(rows[0]);
  const r = await C.enviarCobranca(rows[0], cl[0], etapa);
  if (!r.ok) throw erro(400, r.erro);
  res.json({ ok: true });
}));

// ---------- Fila / régua ----------
app.get('/api/fila', rota(async (req, res) => {
  const c = await cfg.obter();
  const etapas = Object.fromEntries((c.regua || []).map((e) => [e.id, e]));
  const fila = await C.montarFila();
  res.json({ fila: fila.map((f) => ({ ...f, etapa_nome: C.nomeEtapa(etapas[f.etapa] ? etapas[f.etapa].dias : 0) })), execucao: C.execucao });
}));
app.post('/api/fila/executar', pode('envios'), rota(async (req, res) => {
  const r = await C.executarFila('manual');
  if (!r.ok) throw erro(400, r.erro);
  res.json(r);
}));
app.post('/api/fila/parar', pode('envios'), rota(async (req, res) => { C.pararFila(); res.json({ ok: true }); }));
app.get('/api/fila/estado', (req, res) => res.json(C.execucao));

// ---------- Comprovantes ----------
app.get('/api/comprovantes', rota(async (req, res) => {
  const status = ['pendente', 'aceito', 'recusado'].includes(req.query.status) ? req.query.status : 'pendente';
  const { rows } = await q(`
    SELECT cp.id, cp.cliente_id, cp.cobranca_id, cp.telefone, cp.nome_contato, cp.mimetype, cp.nome_arquivo, cp.legenda, cp.status,
           cp.recebido_em, cp.resolvido_em, (cp.arquivo IS NOT NULL) AS tem_arquivo, cl.nome,
           cb.vencimento, cb.valor, cb.status AS cobranca_status
      FROM comprovantes cp LEFT JOIN clientes cl ON cl.id=cp.cliente_id LEFT JOIN cobrancas cb ON cb.id=cp.cobranca_id
     WHERE cp.status=$1 ORDER BY cp.recebido_em DESC LIMIT 100`, [status]);
  for (const r of rows) {
    const ab = await q("SELECT id, vencimento, valor FROM cobrancas WHERE cliente_id=$1 AND status='aberto' ORDER BY vencimento", [r.cliente_id]);
    r.abertas = ab.rows;
  }
  res.json(rows);
}));

app.get('/api/comprovantes/:id/arquivo', rota(async (req, res) => {
  const { rows } = await q('SELECT mimetype, nome_arquivo, arquivo FROM comprovantes WHERE id=$1', [req.params.id]);
  if (!rows[0] || !rows[0].arquivo) return res.status(404).end();
  res.setHeader('Content-Type', rows[0].mimetype || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${(rows[0].nome_arquivo || 'comprovante').replace(/"/g, '')}"`);
  res.end(rows[0].arquivo);
}));

app.post('/api/comprovantes/:id/aceitar', pode('pagamentos'), rota(async (req, res) => {
  const { rows } = await q('SELECT * FROM comprovantes WHERE id=$1', [req.params.id]);
  if (!rows[0]) throw erro(404, 'Comprovante não encontrado');
  const cobId = (req.body && req.body.cobranca_id) || rows[0].cobranca_id;
  if (!cobId) throw erro(400, 'Escolha a qual cobrança este comprovante se refere');
  await C.marcarPago(cobId, { data: req.body.data, valor: req.body.valor, forma: 'pix', obs: 'Comprovante pelo WhatsApp', por: req.usuario.nome });
  await q("UPDATE comprovantes SET status='aceito', cobranca_id=$1, resolvido_em=now() WHERE id=$2", [cobId, req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/comprovantes/:id/recusar', pode('pagamentos'), rota(async (req, res) => {
  await q("UPDATE comprovantes SET status='recusado', resolvido_em=now() WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Mensagens ----------
app.get('/api/mensagens', rota(async (req, res) => {
  const { rows } = await q(`SELECT m.*, cl.nome FROM mensagens m LEFT JOIN clientes cl ON cl.id=m.cliente_id
    ORDER BY m.criado_em DESC LIMIT 300`);
  res.json(rows);
}));

// ---------- WhatsApp ----------
app.get('/api/whatsapp/estado', rota(async (req, res) => res.json(await wa.estado())));
app.post('/api/whatsapp/conectar', pode('whatsapp'), rota(async (req, res) => res.json(await wa.conectar())));
app.post('/api/whatsapp/desconectar', pode('whatsapp'), rota(async (req, res) => { await wa.desconectar(); res.json({ ok: true }); }));
app.post('/api/whatsapp/teste', pode('whatsapp'), rota(async (req, res) => {
  const numero = U.normalizarTelefone(req.body && req.body.numero);
  if (!U.telefoneValido(numero)) throw erro(400, 'Número inválido');
  const c = await cfg.obter();
  const texto = (req.body && req.body.texto) || `Teste do sistema de cobranças ${c.empresa} ✅`;
  await wa.enviarTexto(numero, texto);
  await C.registrar({ direcao: 'saida', etapa: 'teste', telefone: numero, texto, status: 'enviado' });
  res.json({ ok: true });
}));

// ---------- Configurações ----------
app.get('/api/config', rota(async (req, res) => res.json(await cfg.obter())));
app.put('/api/config', rota(async (req, res) => {
  const b = { ...(req.body || {}) };
  const MARCA = ['sistema_nome', 'tema'];
  const podeCfg = USR.tem(req.usuario, 'configuracoes');
  const podeMarca = USR.tem(req.usuario, 'personalizacao');
  for (const k of Object.keys(b)) {
    if (MARCA.includes(k) ? !podeMarca : !podeCfg) delete b[k];
  }
  if (!Object.keys(b).length) throw erro(403, 'Seu usuário não tem permissão para alterar isso.');
  if (b.regua) {
    if (!Array.isArray(b.regua)) throw erro(400, 'Régua inválida');
    b.regua = b.regua.map((e, i) => ({
      id: String(e.id || `etapa${Date.now()}${i}`), dias: parseInt(e.dias, 10) || 0, ativo: !!e.ativo, modelo: String(e.modelo || ''),
    }));
    const dias = b.regua.map((e) => e.dias);
    if (new Set(dias).size !== dias.length) throw erro(400, 'Duas etapas da régua não podem ter o mesmo dia');
  }
  for (const k of ['intervalo_min', 'intervalo_max', 'limite_diario', 'tolerancia_dias', 'agenda_intervalo', 'agenda_lembrete_horas']) if (k in b) b[k] = Math.max(0, parseInt(b[k], 10) || 0);
  if (b.intervalo_min > b.intervalo_max) throw erro(400, 'Intervalo mínimo maior que o máximo');
  if ('tema' in b && !cfg.TEMAS.includes(b.tema)) throw erro(400, 'Tema inválido');
  if ('sistema_nome' in b) {
    b.sistema_nome = String(b.sistema_nome || '').trim().slice(0, 40);
    if (!b.sistema_nome) throw erro(400, 'Informe o nome do sistema');
  }
  res.json(await cfg.salvar(b));
}));

app.put('/api/marca/logo', pode('personalizacao'), rota(async (req, res) => {
  const m = /^data:(image\/(png|jpeg|webp|svg\+xml));base64,(.+)$/.exec(String((req.body && req.body.imagem) || ''));
  if (!m) throw erro(400, 'Envie uma imagem PNG, JPG, WEBP ou SVG');
  const tamanho = Buffer.byteLength(m[3], 'base64');
  if (tamanho > 1024 * 1024) throw erro(400, 'Imagem muito grande (máximo 1 MB)');
  await cfg.salvarLogo({ mime: m[1], base64: m[3], versao: Date.now() });
  res.json({ ok: true });
}));

app.delete('/api/marca/logo', pode('personalizacao'), rota(async (req, res) => {
  await cfg.salvarLogo(null);
  res.json({ ok: true });
}));
app.post('/api/config/previa', rota(async (req, res) => {
  const fake = { id: 0, nome: 'Maria da Silva', telefone: '51999999999', parcelas_total: 10 };
  const cb = { id: 0, valor: 180, vencimento: U.somarDias(U.hoje(), -(Number(req.body.dias) || 0)), competencia: U.hoje().slice(0, 7) + '-01', numero_parcela: 3 };
  res.json({ texto: await C.renderizar(req.body.modelo, fake, cb) });
}));

// ---------- Exportação ----------
function csv(linhas) {
  return '﻿' + linhas.map((l) => l.map((v) => {
    const s = v == null ? '' : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(';')).join('\n');
}
app.get('/api/exportar/clientes.csv', rota(async (req, res) => {
  const { rows } = await q('SELECT * FROM clientes ORDER BY nome');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="clientes.csv"');
  res.send(csv([['Nome', 'Telefone', 'Valor', 'Forma', 'Dia venc.', 'Parcelas', 'Identificação', 'Endereço', 'Ativo', 'Pausado'],
    ...rows.map((r) => [r.nome, r.telefone, String(r.valor).replace('.', ','), r.forma, r.dia_vencimento, r.parcelas_total, r.identificacao, r.endereco, r.ativo ? 'sim' : 'não', r.pausado ? 'sim' : 'não'])]));
}));
app.get('/api/exportar/cobrancas.csv', rota(async (req, res) => {
  const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : U.hoje().slice(0, 7);
  const { rows } = await q(`SELECT cb.*, cl.nome, cl.telefone FROM cobrancas cb JOIN clientes cl ON cl.id=cb.cliente_id WHERE competencia=$1 ORDER BY vencimento`, [mes + '-01']);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cobrancas-${mes}.csv"`);
  res.send(csv([['Cliente', 'Telefone', 'Vencimento', 'Valor', 'Parcela', 'Status', 'Pago em', 'Valor pago'],
    ...rows.map((r) => [r.nome, r.telefone, U.brData(r.vencimento), String(r.valor).replace('.', ','), r.numero_parcela, r.status, U.brData(r.pago_em), r.pago_valor != null ? String(r.pago_valor).replace('.', ',') : ''])]));
}));
app.get('/api/exportar/backup.json', pode('configuracoes'), rota(async (req, res) => {
  const tabelas = {};
  for (const t of ['config', 'clientes', 'cobrancas', 'mensagens']) tabelas[t] = (await q(`SELECT * FROM ${t}`)).rows;
  res.setHeader('Content-Disposition', `attachment; filename="backup-cobrancas-${U.hoje()}.json"`);
  res.json({ versao: 1, gerado_em: new Date().toISOString(), ...tabelas });
}));

// ---------- Arquivos da interface ----------
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const PORTA = Number(process.env.PORT || 3000);
migrar().then(async () => {
  await USR.iniciar(SENHA_INICIAL);
  await AG.iniciar();
  setInterval(() => AG.tickLembretes(), 60000);
  await C.gerarCobrancas();
  C.iniciarAgendador();
  app.listen(PORTA, () => console.log(`Sistema de cobranças rodando na porta ${PORTA}`));
  // garante que o webhook aponte para o app
  setTimeout(async () => {
    const st = await wa.estado();
    if (st.existe) wa.configurarWebhook().catch((e) => console.warn('[webhook] configurar:', e.message));
  }, 10000);
}).catch((e) => {
  console.error('Falha ao iniciar:', e);
  process.exit(1);
});

module.exports = { app, tratarWebhook };
