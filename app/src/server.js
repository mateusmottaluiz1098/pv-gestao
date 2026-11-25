const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { q, migrar } = require('./db');
const cfg = require('./config');
const wa = require('./whatsapp');
const C = require('./cobrancas');
const USR = require('./usuarios');
const AG = require('./agenda');
const FIN = require('./financeiro');
const REL = require('./relacionamento');
const ESP = require('./espera');
const PAC = require('./pacotes');
const RELAT = require('./relatorios');
const ASAAS = require('./asaas');
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

// ---------- Webhook do Asaas (pagamento recebido) ----------
app.post('/webhook/asaas', (req, res) => {
  ASAAS.receberWebhook(req, res).catch((e) => { console.error('[asaas] webhook:', e.message); if (!res.headersSent) res.status(500).json({ erro: 'falha' }); });
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

    // só guarda comprovantes em PDF; imagens e conversas comuns não são salvas
    const ehPdf = doc && (/pdf/i.test(doc.mimetype || '') || /\.pdf$/i.test(doc.fileName || ''));
    if (!ehPdf) continue;
    let base64 = msg.base64 || d.base64 || null;
    if (!base64) {
      try { base64 = await wa.baixarMidia(d); } catch (e) { console.warn('[webhook] mídia:', e.message); }
    }
    const mimetype = 'application/pdf';
    const nomeArquivo = doc.fileName || 'comprovante.pdf';

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

// ---------- Agendamento online (público) ----------
REL.rotasPublicas(app);

// ---------- Proteção das rotas da API ----------
const ROTAS_PROF = [
  ['GET', /^\/api\/me$/], ['POST', /^\/api\/me\/senha$/], ['GET', /^\/api\/config$/], ['GET', /^\/api\/whatsapp\/estado$/],
  ['GET', /^\/api\/agenda(\/.*)?$/], ['POST', /^\/api\/agenda$/], ['PUT', /^\/api\/agenda\/\d+$/], ['DELETE', /^\/api\/agenda\/\d+$/],
  ['POST', /^\/api\/agenda\/\d+\/(status|whatsapp)$/], ['*', /^\/api\/espera(\/.*)?$/], ['GET', /^\/api\/pacotes\/cliente$/],
];
app.use('/api', (req, res, next) => {
  usuarioDaSessao(req).then((u) => {
    if (!u) return res.status(401).json({ erro: 'Faça login' });
    req.usuario = u;
    // usuário de profissional: só a própria agenda, comissões e lista de espera
    // caminho completo (dentro do app.use('/api') o req.path vem sem o /api)
    const caminho = String(req.originalUrl || req.url || '').split('?')[0];
    if (USR.ehProf(u) && !ROTAS_PROF.some(([m, re]) => (m === '*' || m === req.method) && re.test(caminho))) {
      return res.status(403).json({ erro: 'Seu usuário só tem acesso à sua agenda.' });
    }
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

app.get('/api/me', rota(async (req, res) => {
  // guarda o endereço público do sistema (usado no link de agendamento das mensagens)
  const host = req.get('host');
  if (host && !/^(localhost|127\.|\[::1\])/.test(host)) {
    const url = `${req.protocol}://${host}`;
    const c = await cfg.obter();
    if (c._url_publica !== url) await cfg.salvarInterno('url_publica', url);
  }
  res.json({ ...USR.publico(req.usuario), lista_permissoes: USR.PERMISSOES });
}));

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
FIN.rotas(app, { rota, pode });
REL.rotas(app, { rota, pode });
ESP.rotas(app, { rota, pode });
PAC.rotas(app, { rota, pode });
RELAT.rotas(app, { rota, pode });

// ---------- Painel ----------
app.get('/api/painel', rota(async (req, res) => {
  await C.gerarCobrancas();
  const hoje = U.hoje();
  const mes = hoje.slice(0, 7) + '-01';
  const [ativos, vencemHoje, atraso, recebido, comprov, enviadosHoje] = await Promise.all([
    q('SELECT COUNT(*)::int n FROM clientes WHERE ativo'),
    q("SELECT COUNT(*)::int n, COALESCE(SUM(valor),0) v FROM cobrancas WHERE status='aberto' AND vencimento=$1", [hoje]),
    q("SELECT COUNT(*)::int n, COALESCE(SUM(valor),0) v FROM cobrancas WHERE status='aberto' AND vencimento<$1", [hoje]),
    q("SELECT COUNT(*)::int n, COALESCE(SUM(COALESCE(pago_valor, valor)),0) v FROM cobrancas WHERE status='pago' AND pago_em >= $1", [mes]),
    q("SELECT COUNT(*)::int n FROM comprovantes cp WHERE status='pendente' AND (cp.mimetype ILIKE '%pdf%' OR cp.nome_arquivo ILIKE '%.pdf')"),
    q("SELECT COUNT(*)::int n FROM mensagens WHERE direcao='saida' AND status='enviado' AND (criado_em AT TIME ZONE 'America/Sao_Paulo')::date=$1", [hoje]),
  ]);
  const previstoMes = await q("SELECT COALESCE(SUM(valor),0) v FROM cobrancas WHERE competencia >= $1 AND competencia < ($1::date + interval '1 month') AND status<>'cancelado'", [mes]);
  const semCarne = await clientesSemCobranca();
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
    recebido_mes: { ...recebido.rows[0], ...(await FIN.recebidoNoPeriodo(mes, hoje)) },
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
    sem_carne: semCarne,
  });
}));

// Clientes ativos que ficaram sem cobrança: carnê acabou (ou vai acabar em 60 dias) e,
// nos negócios sem agenda, clientes "só avulso" sem nenhuma cobrança em aberto
async function clientesSemCobranca() {
  const hoje = U.hoje();
  const c = await cfg.obter();
  const usaAvulso = !(c.modulos && c.modulos.agenda);
  const { rows } = await q(`
    SELECT cl.id, cl.nome, cl.telefone, cl.forma, cl.valor, cl.parcelas_total, cl.dia_vencimento,
      (date_trunc('month', cl.primeiro_vencimento) + (GREATEST(cl.parcelas_total, 1) - 1) * interval '1 month')::date AS fim_mes,
      (SELECT MAX(vencimento) FROM cobrancas WHERE cliente_id=cl.id AND status <> 'cancelado') AS ultimo_venc,
      (SELECT COUNT(*)::int FROM cobrancas WHERE cliente_id=cl.id AND status='aberto') AS abertas,
      (SELECT COUNT(*)::int FROM cobrancas WHERE cliente_id=cl.id AND status <> 'cancelado') AS total
    FROM clientes cl
    WHERE cl.ativo AND (cl.forma='carne' OR (cl.forma='avulso' AND $1))`, [usaAvulso]);
  const limite = U.somarDias(hoje, 60);
  const acabou = []; const acabando = [];
  for (const r of rows) {
    if (r.forma === 'carne') {
      const fim = U.vencimentoNoMes(Number(r.fim_mes.slice(0, 4)), Number(r.fim_mes.slice(5, 7)), r.dia_vencimento);
      const item = { id: r.id, nome: r.nome, telefone: r.telefone, forma: r.forma, valor: Number(r.valor), parcelas_total: r.parcelas_total, dia_vencimento: r.dia_vencimento, fim, ultimo_venc: r.ultimo_venc };
      if (!r.abertas && fim <= U.somarDias(hoje, 31)) acabou.push({ ...item, motivo: 'carne_acabou' });
      else if (fim <= limite) acabando.push({ ...item, motivo: 'carne_acabando', abertas: r.abertas });
    } else if (!r.abertas && r.total) {
      acabou.push({ id: r.id, nome: r.nome, telefone: r.telefone, forma: r.forma, valor: Number(r.valor), ultimo_venc: r.ultimo_venc, motivo: 'sem_cobranca' });
    }
  }
  acabou.sort((a, b) => String(a.ultimo_venc || '').localeCompare(String(b.ultimo_venc || '')));
  acabando.sort((a, b) => a.fim.localeCompare(b.fim));
  return { acabou: acabou.slice(0, 30), acabando: acabando.slice(0, 30), total_acabou: acabou.length, total_acabando: acabando.length };
}

// Renova o carnê: se acabou, começa um novo no próximo vencimento; se ainda está rodando, acrescenta parcelas
app.post('/api/clientes/:id/renovar-carne', pode('clientes'), rota(async (req, res) => {
  const { rows } = await q('SELECT * FROM clientes WHERE id=$1', [req.params.id]);
  const cl = rows[0];
  if (!cl) throw erro(404, 'Cliente não encontrado');
  const n = Math.min(Math.max(parseInt(req.body.parcelas, 10) || 12, 1), 60);
  const vTxt = String(req.body.valor ?? '').trim();
  const valor = Number(vTxt.includes(',') ? vTxt.replace(/\./g, '').replace(',', '.') : vTxt) || Number(cl.valor);
  if (!(valor > 0)) throw erro(400, 'Informe o valor da parcela');
  const dia = Math.min(Math.max(parseInt(req.body.dia, 10) || cl.dia_vencimento || 10, 1), 31);
  const hoje = U.hoje();
  const { rows: ab } = await q("SELECT COUNT(*)::int n FROM cobrancas WHERE cliente_id=$1 AND status='aberto'", [cl.id]);
  let fimAtual = null;
  if (cl.forma === 'carne' && cl.primeiro_vencimento && cl.parcelas_total) {
    const [py, pm] = cl.primeiro_vencimento.split('-').map(Number);
    const idx = py * 12 + (pm - 1) + cl.parcelas_total - 1;
    fimAtual = U.vencimentoNoMes(Math.floor(idx / 12), (idx % 12) + 1, cl.dia_vencimento);
  }
  const continua = cl.forma === 'carne' && fimAtual && (ab[0].n > 0 || fimAtual >= hoje);
  if (continua) {
    // carnê ainda rodando: só aumenta as parcelas (e o valor das próximas, se mudou)
    const antes = { ...cl };
    const { rows: up } = await q('UPDATE clientes SET parcelas_total=parcelas_total+$1, valor=$2, dia_vencimento=$3 WHERE id=$4 RETURNING *', [n, valor, dia, cl.id]);
    await C.ajustarCobrancasFuturas(up[0], antes);
  } else {
    // carnê novo: primeira parcela no próximo dia de vencimento (este mês se ainda não passou)
    let inicio = /^\d{4}-\d{2}-\d{2}$/.test(req.body.inicio || '') ? req.body.inicio : null;
    if (!inicio) {
      const [y, m] = hoje.split('-').map(Number);
      inicio = U.vencimentoNoMes(y, m, dia);
      if (inicio < hoje) inicio = m === 12 ? U.vencimentoNoMes(y + 1, 1, dia) : U.vencimentoNoMes(y, m + 1, dia);
    }
    if (inicio < hoje) throw erro(400, 'A primeira parcela não pode ser antes de hoje');
    // se já existe parcela do carnê antigo nesse mês, o novo começa no mês seguinte
    for (let i = 0; i < 24; i++) {
      const { rows: ocup } = await q("SELECT 1 FROM cobrancas WHERE cliente_id=$1 AND tipo='recorrente' AND competencia=$2", [cl.id, inicio.slice(0, 7) + '-01']);
      if (!ocup[0]) break;
      const [y, m] = inicio.split('-').map(Number);
      inicio = m === 12 ? U.vencimentoNoMes(y + 1, 1, dia) : U.vencimentoNoMes(y, m + 1, dia);
    }
    await q("UPDATE clientes SET forma='carne', valor=$1, dia_vencimento=$2, primeiro_vencimento=$3, parcelas_total=$4, ativo=TRUE WHERE id=$5", [valor, dia, inicio, n, cl.id]);
  }
  await C.gerarCobrancas(cl.id);
  const { rows: depois } = await q('SELECT * FROM clientes WHERE id=$1', [cl.id]);
  res.json({ ok: true, novo: !continua, cliente: depois[0] });
}));

// ---------- Clientes ----------
const FORMAS_CLIENTE = ['mensal', 'semanal', 'quinzenal', 'carne', 'avulso'];
function validarCliente(b) {
  const nome = String(b.nome || '').trim();
  if (!nome) throw erro(400, 'Informe o nome');
  const cpfCnpj = ASAAS.soDigitos(b.cpf_cnpj) || null;
  if (cpfCnpj && !ASAAS.docValido(cpfCnpj)) throw erro(400, 'CPF/CNPJ inválido. Confira os números (ou deixe em branco).');
  const telefone = U.normalizarTelefone(b.telefone);
  if (!U.telefoneValido(telefone)) throw erro(400, 'Telefone inválido. Use DDD + número, ex.: 51 99999-9999');
  const forma = FORMAS_CLIENTE.includes(b.forma) ? b.forma : 'mensal';
  let valor = Number(String(b.valor ?? '').replace(',', '.')) || 0;
  if (forma === 'avulso') valor = Math.max(0, valor);
  else if (!(valor > 0)) throw erro(400, 'Informe o valor');
  const parcelas = forma === 'carne' ? parseInt(b.parcelas_total, 10) : null;
  if (forma === 'carne' && !(parcelas > 0)) throw erro(400, 'Informe a quantidade de parcelas do carnê');
  const h = U.hoje();
  let primeiro = /^\d{4}-\d{2}-\d{2}$/.test(b.primeiro_vencimento || '') ? b.primeiro_vencimento : null;
  let dia = parseInt(b.dia_vencimento, 10);
  let diaSemana = null;
  if (forma === 'semanal' || forma === 'quinzenal') {
    diaSemana = parseInt(b.dia_semana, 10);
    if (primeiro) diaSemana = U.parseData(primeiro).getUTCDay();
    if (!(diaSemana >= 0 && diaSemana <= 6)) throw erro(400, 'Escolha o dia da semana do vencimento');
    if (!primeiro) primeiro = U.somarDias(h, (diaSemana - U.parseData(h).getUTCDay() + 7) % 7); // próximo dia da semana (pode ser hoje)
    dia = Number(primeiro.slice(8, 10));
  } else if (forma === 'avulso') {
    dia = 1;
    primeiro = primeiro || h;
  } else {
    if (!(dia >= 1 && dia <= 31)) throw erro(400, 'Dia de vencimento inválido');
    if (!primeiro) {
      const [y, m, d] = h.split('-').map(Number);
      primeiro = d <= dia ? U.vencimentoNoMes(y, m, dia) : (m === 12 ? U.vencimentoNoMes(y + 1, 1, dia) : U.vencimentoNoMes(y, m + 1, dia));
    }
  }
  return {
    nome, telefone, valor, forma, dia_vencimento: dia, dia_semana: diaSemana, primeiro_vencimento: primeiro, parcelas_total: parcelas,
    identificacao: b.identificacao || null, endereco: b.endereco || null, observacoes: b.observacoes || null,
    ativo: b.ativo !== false, pausado: !!b.pausado,
    cpf_cnpj: cpfCnpj, pix_asaas: b.pix_asaas !== false,
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
      (SELECT CASE WHEN bool_or(status='aberto') THEN 'aberto' WHEN bool_or(status='pago') THEN 'pago' END FROM cobrancas
         WHERE cliente_id=cl.id AND competencia >= $2 AND competencia < ($2::date + interval '1 month')) AS status_mes,
      (SELECT COALESCE(SUM(valor),0) FROM consumos WHERE cliente_id=cl.id AND cobranca_id IS NULL AND status='pendente') AS fiado_pendente,
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
    `INSERT INTO clientes (nome, telefone, valor, forma, dia_vencimento, primeiro_vencimento, parcelas_total, identificacao, endereco, observacoes, ativo, pausado, dia_semana, cpf_cnpj, pix_asaas)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [c.nome, c.telefone, c.valor, c.forma, c.dia_vencimento, c.primeiro_vencimento, c.parcelas_total, c.identificacao, c.endereco, c.observacoes, c.ativo, c.pausado, c.dia_semana, c.cpf_cnpj, c.pix_asaas]
  );
  await C.gerarCobrancas(rows[0].id);
  res.json(rows[0]);
}));

app.put('/api/clientes/:id', pode('clientes'), rota(async (req, res) => {
  const c = validarCliente(req.body);
  const { rows: antes } = await q('SELECT * FROM clientes WHERE id=$1', [req.params.id]);
  if (!antes[0]) throw erro(404, 'Cliente não encontrado');
  const { rows } = await q(
    `UPDATE clientes SET nome=$1, telefone=$2, valor=$3, forma=$4, dia_vencimento=$5, primeiro_vencimento=$6, parcelas_total=$7,
       identificacao=$8, endereco=$9, observacoes=$10, ativo=$11, pausado=$12, dia_semana=$14, cpf_cnpj=$15, pix_asaas=$16 WHERE id=$13 RETURNING *`,
    [c.nome, c.telefone, c.valor, c.forma, c.dia_vencimento, c.primeiro_vencimento, c.parcelas_total, c.identificacao, c.endereco, c.observacoes, c.ativo, c.pausado, req.params.id, c.dia_semana, c.cpf_cnpj, c.pix_asaas]
  );
  await C.ajustarCobrancasFuturas(rows[0], antes[0]);
  await C.gerarCobrancas(rows[0].id);
  if (antes[0].pix_asaas !== rows[0].pix_asaas) await ASAAS.definirCliente(rows[0].id, rows[0].pix_asaas);
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
    SELECT cb.*, cl.nome, cl.telefone, cl.parcelas_total, cl.identificacao, cl.forma, cl.pix_asaas AS cliente_pix_asaas, cl.cpf_cnpj AS cliente_doc,
      (SELECT MAX(criado_em) FROM mensagens WHERE cobranca_id=cb.id AND direcao='saida' AND status='enviado') AS ultima_msg,
      (SELECT COUNT(*)::int FROM mensagens WHERE cobranca_id=cb.id AND direcao='saida' AND status='enviado') AS qtd_msgs
    FROM cobrancas cb JOIN clientes cl ON cl.id=cb.cliente_id
    WHERE cb.competencia >= $1 AND cb.competencia < ($1::date + interval '1 month') ORDER BY cb.vencimento, cl.nome`, [mes + '-01']);
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
    SELECT cb.*, cl.nome, cl.telefone, cl.parcelas_total, cl.identificacao, cl.forma, cl.pix_asaas AS cliente_pix_asaas, cl.cpf_cnpj AS cliente_doc,
      (SELECT MAX(criado_em) FROM mensagens WHERE cobranca_id=cb.id AND direcao='saida' AND status='enviado') AS ultima_msg,
      (SELECT COUNT(*)::int FROM mensagens WHERE cobranca_id=cb.id AND direcao='saida' AND status='enviado') AS qtd_msgs
    FROM cobrancas cb JOIN clientes cl ON cl.id=cb.cliente_id
    WHERE cb.status='aberto' AND cb.vencimento < $1 ORDER BY cb.vencimento, cl.nome`, [U.hoje()]);
  res.json(rows);
}));

app.post('/api/cobrancas/:id/pagar', pode('pagamentos'), rota(async (req, res) => {
  await C.marcarPago(req.params.id, { ...(req.body || {}), por: req.usuario.nome });
  res.json({ ok: true });
}));

app.post('/api/cobrancas/:id/desfazer', pode('pagamentos'), rota(async (req, res) => {
  await C.desfazerPagamento(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/cobrancas/:id/cancelar', pode('pagamentos'), rota(async (req, res) => {
  await q("UPDATE cobrancas SET status='cancelado' WHERE id=$1 AND status='aberto'", [req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/cobrancas/:id/pix', rota(async (req, res) => {
  const { rows } = await q('SELECT * FROM cobrancas WHERE id=$1', [req.params.id]);
  if (!rows[0]) throw erro(404, 'Cobrança não encontrada');
  const { rows: cl } = await q('SELECT * FROM clientes WHERE id=$1', [rows[0].cliente_id]);
  const pix = await C.pixDaCobranca(rows[0], cl[0]);
  if (!pix) throw erro(400, 'Cadastre a chave Pix em Configurações');
  res.json({ ...pix, ...(await infoModo(rows[0].id, cl[0])) });
}));

// forma do Pix da cobrança (para a escolha Asaas x Pix normal nas telas)
async function infoModo(cobrancaId, cliente) {
  const { rows } = await q('SELECT pix_modo, asaas_erro FROM cobrancas WHERE id=$1', [cobrancaId]);
  const cb = rows[0] || {};
  return { pix_modo: cb.pix_modo || null, modo: ASAAS.modoEfetivo(cliente, cb), cliente_asaas: cliente.pix_asaas !== false, aviso_asaas: cb.asaas_erro || null };
}
app.post('/api/cobrancas/:id/pix-modo', pode('pagamentos'), rota(async (req, res) => {
  const m = await ASAAS.definirModoCobranca(req.params.id, req.body.modo);
  if (m === null && !(await q('SELECT 1 FROM cobrancas WHERE id=$1', [req.params.id])).rows[0]) throw erro(404, 'Cobrança não encontrada');
  res.json({ ok: true, pix_modo: m });
}));
app.post('/api/clientes/:id/pix-asaas', pode('clientes'), rota(async (req, res) => {
  await ASAAS.definirCliente(req.params.id, !!req.body.ligado);
  res.json({ ok: true, pix_asaas: !!req.body.ligado });
}));

app.get('/api/cobrancas/:id/previa', rota(async (req, res) => {
  const { rows } = await q('SELECT * FROM cobrancas WHERE id=$1', [req.params.id]);
  if (!rows[0]) throw erro(404, 'Cobrança não encontrada');
  const { rows: cl } = await q('SELECT * FROM clientes WHERE id=$1', [rows[0].cliente_id]);
  const etapa = await etapaPara(rows[0]);
  const pix = await C.pixDaCobranca(rows[0], cl[0]);
  const texto = await C.renderizar(etapa.modelo, cl[0], rows[0], { link: pix && pix.link });
  res.json({ texto, pix: pix && pix.codigo, asaas: !!(pix && pix.asaas), etapa: etapa.id, etapa_nome: etapa.nome || C.nomeEtapa(etapa.dias), ...(await infoModo(rows[0].id, cl[0])) });
}));

async function etapaPara(cb) {
  const c = await cfg.obter();
  const etapas = (c.regua || []).filter((e) => e.ativo).sort((a, b) => a.dias - b.dias);
  if (!etapas.length) throw erro(400, 'Nenhuma etapa da régua está ativa');
  const diff = U.diffDias(U.hoje(), cb.vencimento);
  // envio manual de parcela em atraso: mensagem própria, se estiver ligada
  if (c.msg_manual_ativo && String(c.msg_manual || '').trim() && diff > 0) return { id: 'manual', dias: diff, modelo: c.msg_manual, nome: 'Cobrança manual (em atraso)' };
  const eleg = etapas.filter((e) => e.dias <= diff);
  return eleg.length ? eleg[eleg.length - 1] : etapas[0];
}

// ---------- Nova cobrança (avulsa ou parcelada), com cliente existente ou cadastro rápido ----------
function somarMeses(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = (m - 1) + n;
  return U.vencimentoNoMes(y + Math.floor(t / 12), (t % 12) + 1, d);
}
app.post('/api/cobrancas', pode('pagamentos'), rota(async (req, res) => {
  const b = req.body || {};
  const vTxt = String(b.valor ?? '').trim();
  const valor = Number(vTxt.includes(',') ? vTxt.replace(/\./g, '').replace(',', '.') : vTxt) || 0;
  if (!(valor > 0)) throw erro(400, 'Informe o valor da cobrança');
  const descricao = String(b.descricao || '').trim().slice(0, 120);
  if (!descricao) throw erro(400, 'Informe a que se refere a cobrança (ex.: Instalação do painel)');
  const venc = /^\d{4}-\d{2}-\d{2}$/.test(b.vencimento || '') ? b.vencimento : U.hoje();
  const parcelas = Math.min(Math.max(parseInt(b.parcelas, 10) || 1, 1), 36);
  const valorTotal = !!b.valor_total; // o valor informado é o total (divide nas parcelas) ou o de cada parcela
  const modo = b.pix_modo === 'asaas' || b.pix_modo === 'direto' ? b.pix_modo : null;

  let clienteId = parseInt(b.cliente_id, 10) || null;
  if (!clienteId) {
    if (!USR.tem(req.usuario, 'clientes')) throw erro(403, 'Seu usuário não pode cadastrar clientes. Escolha um cliente já cadastrado.');
    const n = b.novo_cliente || {};
    const c = validarCliente({ nome: n.nome, telefone: n.telefone, cpf_cnpj: n.cpf_cnpj, forma: 'avulso', valor: 0, pix_asaas: true });
    const { rows } = await q(
      `INSERT INTO clientes (nome, telefone, valor, forma, dia_vencimento, primeiro_vencimento, cpf_cnpj, pix_asaas)
       VALUES ($1,$2,0,'avulso',1,$3,$4,TRUE) RETURNING id`, [c.nome, c.telefone, c.primeiro_vencimento, c.cpf_cnpj]);
    clienteId = rows[0].id;
  } else if (!(await q('SELECT 1 FROM clientes WHERE id=$1', [clienteId])).rows[0]) throw erro(404, 'Cliente não encontrado');

  // centavos: a sobra da divisão vai na 1ª parcela
  const cent = Math.round(valor * 100);
  const base = valorTotal ? Math.floor(cent / parcelas) : cent;
  const criadas = [];
  for (let i = 0; i < parcelas; i++) {
    const v = (valorTotal && i === 0 ? base + (cent - base * parcelas) : base) / 100;
    const cb = await C.criarAvulsa(clienteId, {
      valor: v, vencimento: somarMeses(venc, i), descricao: parcelas > 1 ? `${descricao} (${i + 1}/${parcelas})` : descricao,
    });
    if (modo) await q('UPDATE cobrancas SET pix_modo=$1 WHERE id=$2', [modo, cb.id]);
    criadas.push(cb);
  }
  res.json({ ok: true, cliente_id: clienteId, cobrancas: criadas.map((c) => ({ id: c.id, vencimento: c.vencimento, valor: c.valor })) });
}));

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
     WHERE cp.status=$1 AND (cp.mimetype ILIKE '%pdf%' OR cp.nome_arquivo ILIKE '%.pdf') ORDER BY cp.recebido_em DESC LIMIT 100`, [status]);
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
// a chave do Asaas e o token do webhook nunca vão para o navegador
function configPublica(c, usuario) {
  const { asaas_chave, asaas_webhook_token, _logo, ...resto } = c;
  const chave = String(asaas_chave || '');
  resto.asaas_chave_salva = !!chave;
  resto.asaas_chave_fim = chave ? chave.slice(-4) : '';
  resto.asaas_ambiente = chave ? ASAAS.ambienteDaChave(chave) : null;
  const base = process.env.URL_PUBLICA || c._url_publica;
  resto.asaas_webhook_url = base ? `${base}/webhook/asaas` : null;
  if (!USR.ehProf(usuario)) return resto;
  // profissional não precisa ver Pix nem textos de cobrança
  const { pix_chave, pix_nome, pix_tipo, regua, asaas_email, ...prof } = resto;
  return prof;
}
app.get('/api/config', rota(async (req, res) => {
  res.json(configPublica(await cfg.obter(), req.usuario));
}));
app.put('/api/config', rota(async (req, res) => {
  const b = { ...(req.body || {}) };
  const MARCA = ['sistema_nome', 'tema'];
  const podeCfg = USR.tem(req.usuario, 'configuracoes');
  const podeMarca = USR.tem(req.usuario, 'personalizacao');
  for (const k of Object.keys(b)) {
    if (MARCA.includes(k) ? !podeMarca : !podeCfg) delete b[k];
  }
  if (!Object.keys(b).length) throw erro(403, 'Seu usuário não tem permissão para alterar isso.');
  // Asaas: chave em branco = manter a salva; o token do webhook é só do servidor
  delete b.asaas_webhook_token;
  for (const k of ['asaas_chave_salva', 'asaas_chave_fim', 'asaas_ambiente', 'asaas_webhook_url']) delete b[k];
  if ('asaas_chave' in b) {
    b.asaas_chave = String(b.asaas_chave || '').trim();
    if (!b.asaas_chave) delete b.asaas_chave;
    else if (b.asaas_chave === '-') b.asaas_chave = '';
    else if (!/^\$?aact_(prod|hmlg)_/.test(b.asaas_chave)) throw erro(400, 'Essa não parece uma chave de API do Asaas (começa com $aact_prod_ ou $aact_hmlg_).');
    else if (!b.asaas_chave.startsWith('$')) b.asaas_chave = '$' + b.asaas_chave;
  }
  if ('asaas_ativo' in b) b.asaas_ativo = !!b.asaas_ativo;
  if ('asaas_email' in b) b.asaas_email = String(b.asaas_email || '').trim();
  // ramo do negócio e módulos (o formulário manda mod_agenda, mod_caixa...)
  const modForm = Object.keys(b).filter((k) => k.startsWith('mod_'));
  if (modForm.length) {
    b.modulos = Object.fromEntries(cfg.MODULOS.map((m) => [m, !!b['mod_' + m]]));
    modForm.forEach((k) => delete b[k]);
  }
  if ('ramo' in b) {
    if (!cfg.RAMOS[b.ramo]) throw erro(400, 'Ramo de negócio inválido');
    const atual = await cfg.obter();
    if (b.ramo !== atual.ramo && !modForm.length) b.modulos = null; // trocou de ramo: módulos do ramo novo
  }
  if ('modulos' in b && b.modulos !== null) {
    if (typeof b.modulos !== 'object') throw erro(400, 'Módulos inválidos');
    b.modulos = Object.fromEntries(cfg.MODULOS.map((m) => [m, !!b.modulos[m]]));
  }
  if (b.regua) {
    if (!Array.isArray(b.regua)) throw erro(400, 'Régua inválida');
    b.regua = b.regua.map((e, i) => ({
      id: String(e.id || `etapa${Date.now()}${i}`), dias: parseInt(e.dias, 10) || 0, ativo: !!e.ativo, modelo: String(e.modelo || ''),
    }));
    const dias = b.regua.map((e) => e.dias);
    if (new Set(dias).size !== dias.length) throw erro(400, 'Duas etapas da régua não podem ter o mesmo dia');
  }
  for (const k of ['intervalo_min', 'intervalo_max', 'limite_diario', 'tolerancia_dias', 'agenda_intervalo', 'agenda_lembrete_horas', 'retorno_dias', 'retorno_limite', 'online_antecedencia_min', 'online_dias', 'espera_qtd_aviso']) if (k in b) b[k] = Math.max(0, parseInt(b[k], 10) || 0);
  if ('retorno_dias' in b && b.retorno_dias < 7) throw erro(400, 'O retorno precisa ser de pelo menos 7 dias');
  if ('online_dias' in b) b.online_dias = Math.min(90, Math.max(1, b.online_dias));
  if (b.intervalo_min > b.intervalo_max) throw erro(400, 'Intervalo mínimo maior que o máximo');
  if ('tema' in b && !cfg.TEMAS.includes(b.tema)) throw erro(400, 'Tema inválido');
  if ('sistema_nome' in b) {
    b.sistema_nome = String(b.sistema_nome || '').trim().slice(0, 40);
    if (!b.sistema_nome) throw erro(400, 'Informe o nome do sistema');
  }
  let salvo = await cfg.salvar(b);
  if (salvo.asaas_ativo && !salvo.asaas_webhook_token) salvo = await cfg.salvar({ asaas_webhook_token: ASAAS.gerarToken() });
  res.json(configPublica(salvo, req.usuario));
}));

// ---------- Asaas ----------
app.post('/api/asaas/testar', pode('configuracoes'), rota(async (req, res) => {
  try { res.json(await ASAAS.testar()); } catch (e) { throw erro(400, e.message); }
}));
app.post('/api/asaas/webhook', pode('configuracoes'), rota(async (req, res) => {
  const c = await cfg.obter();
  const base = process.env.URL_PUBLICA || c._url_publica || `${req.protocol}://${req.get('host')}`;
  try { res.json(await ASAAS.configurarWebhook(base)); } catch (e) { throw erro(400, e.message); }
}));
// importar clientes e cobranças que já estão no Asaas
const IMP = require('./asaas-importar');
const opcoesImport = (b) => ({
  ateMes: /^\d{4}-\d{2}$/.test(b.ate_mes || '') ? b.ate_mes : '2027-12',
  mesesHistorico: b.historico === 'tudo' ? null : b.historico === 'nenhum' ? 0 : 12,
});
app.post('/api/asaas/importar/analisar', pode('configuracoes'), rota(async (req, res) => {
  try { res.json(IMP.resumoParaTela(await IMP.analisar(opcoesImport(req.body || {})))); } catch (e) { throw erro(400, e.message); }
}));
app.post('/api/asaas/importar', pode('configuracoes'), rota(async (req, res) => {
  const b = req.body || {};
  try {
    res.json(await IMP.importar({ ...opcoesImport(b), desligarAvisos: b.desligar_avisos !== false, somente: Array.isArray(b.somente) ? b.somente.map(String) : null }));
  } catch (e) { throw erro(400, e.message); }
}));
app.post('/api/asaas/desligar-avisos', pode('configuracoes'), rota(async (req, res) => {
  try { res.json(await ASAAS.desligarAvisosTodos()); } catch (e) { throw erro(400, e.message); }
}));
app.get('/api/asaas/saldo', pode('financeiro'), rota(async (req, res) => {
  res.json(await ASAAS.saldo(req.query.forcar === '1'));
}));
app.post('/api/asaas/conferir', pode('pagamentos'), rota(async (req, res) => {
  await ASAAS.tick();
  res.json({ ok: true });
}));

app.post('/api/config/mensagens-ramo', pode('configuracoes'), rota(async (req, res) => res.json(await cfg.usarMensagensDoRamo())));

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
  const fake = { id: 0, nome: 'Maria da Silva', telefone: '51999999999', parcelas_total: 10, forma: 'mensal' };
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
  const { rows } = await q(`SELECT cb.*, cl.nome, cl.telefone, cl.forma, cl.parcelas_total FROM cobrancas cb JOIN clientes cl ON cl.id=cb.cliente_id
    WHERE competencia >= $1 AND competencia < ($1::date + interval '1 month') ORDER BY vencimento`, [mes + '-01']);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cobrancas-${mes}.csv"`);
  res.send(csv([['Cliente', 'Telefone', 'Referente a', 'Vencimento', 'Valor', 'Status', 'Pago em', 'Valor pago', 'Forma'],
    ...rows.map((r) => [r.nome, r.telefone, C.descricaoCobranca(r, r), U.brData(r.vencimento), String(r.valor).replace('.', ','), r.status, U.brData(r.pago_em), r.pago_valor != null ? String(r.pago_valor).replace('.', ',') : '', r.forma_pagamento || ''])]));
}));
app.get('/api/exportar/backup.json', pode('configuracoes'), rota(async (req, res) => {
  const tabelas = {};
  for (const t of ['config', 'clientes', 'cobrancas', 'mensagens', 'consumos', 'produtos', 'vendas', 'caixa_movimentos',
    'profissionais', 'servicos', 'agendamentos', 'retornos_enviados', 'lista_espera', 'pacotes', 'pacotes_clientes', 'pacote_usos', 'asaas_eventos']) {
    tabelas[t] = (await q(`SELECT * FROM ${t}`).catch(() => ({ rows: [] }))).rows;
  }
  // a chave do Asaas e o token do webhook não vão para o backup (ele pode ir para a nuvem)
  tabelas.config = tabelas.config.filter((r) => !['asaas_chave', 'asaas_webhook_token'].includes(r.chave));
  // comprovantes sem o arquivo (imagem), para o backup não ficar enorme
  tabelas.comprovantes = (await q('SELECT id, cliente_id, cobranca_id, telefone, nome_contato, mimetype, nome_arquivo, legenda, status, recebido_em, resolvido_em FROM comprovantes')).rows;
  res.setHeader('Content-Disposition', `attachment; filename="backup-cobrancas-${U.hoje()}.json"`);
  res.json({ versao: 1, gerado_em: new Date().toISOString(), ...tabelas });
}));

// ---------- Arquivos da interface ----------
app.get('/agendar', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'agendar.html')));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const PORTA = Number(process.env.PORT || 3000);
migrar().then(async () => {
  await USR.iniciar(SENHA_INICIAL);
  await AG.iniciar();
  await FIN.iniciar();
  await REL.iniciar();
  await ESP.iniciar();
  await PAC.iniciar();
  await ASAAS.iniciar();
  setInterval(() => ASAAS.tick(), 5 * 60000);
  setTimeout(() => ASAAS.tick(), 30000);
  setInterval(() => PAC.tick(), 60000);
  PAC.tick();
  setInterval(() => AG.tickLembretes(), 60000);
  setInterval(() => REL.tickRetorno(), 60000);
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
