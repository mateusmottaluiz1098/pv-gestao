// Relacionamento com o cliente: mensagem de retorno ("faz tempo que não te vejo") e agendamento online
const { q } = require('./db');
const cfg = require('./config');
const wa = require('./whatsapp');
const AG = require('./agenda');
const U = require('./util');

const TZ = 'America/Sao_Paulo';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS retornos_enviados (
  id SERIAL PRIMARY KEY,
  chave_telefone TEXT NOT NULL,
  ultima_visita DATE NOT NULL,
  telefone TEXT,
  nome TEXT,
  status TEXT NOT NULL DEFAULT 'enviado',
  enviado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chave_telefone, ultima_visita)
);
`;

async function iniciar() { await q(SCHEMA); }

function erro(status, msg) { const e = new Error(msg); e.status = status; return e; }

function linkAgendamento(c) {
  const base = process.env.URL_PUBLICA || c._url_publica || '';
  return c.online_ativo && base ? `${base.replace(/\/$/, '')}/agendar` : '';
}

// ---------- Retorno: clientes que não aparecem há X dias ----------
// candidatos: telefone com atendimento concluído, sem visita há X dias, sem horário marcado e ainda não chamado desde a última visita
async function candidatosRetorno(c) {
  const dias = Math.max(7, Number(c.retorno_dias) || 30);
  const { rows } = await q(
    `SELECT a.telefone, a.cliente_nome, s.nome AS servico, p.nome AS profissional,
            (a.inicio AT TIME ZONE '${TZ}')::date AS dia
       FROM agendamentos a JOIN profissionais p ON p.id = a.profissional_id LEFT JOIN servicos s ON s.id = a.servico_id
      WHERE a.status = 'concluido' AND a.telefone IS NOT NULL
      ORDER BY a.inicio DESC`);
  const { rows: futuros } = await q(
    "SELECT telefone FROM agendamentos WHERE status IN ('agendado','confirmado') AND inicio > now() AND telefone IS NOT NULL");
  const temHorario = new Set(futuros.map((f) => U.chaveTelefone(f.telefone)));
  const { rows: env } = await q('SELECT chave_telefone, ultima_visita FROM retornos_enviados');
  const jaChamado = new Set(env.map((e) => `${e.chave_telefone}|${e.ultima_visita}`));
  const ultima = new Map();
  for (const r of rows) {
    const k = U.chaveTelefone(r.telefone);
    if (!ultima.has(k)) ultima.set(k, r); // o primeiro é o mais recente
  }
  const hoje = U.hoje();
  const out = [];
  for (const [k, r] of ultima) {
    const passou = U.diffDias(hoje, r.dia);
    if (passou < dias || passou > dias + 60) continue; // não chama quem sumiu há muito tempo
    if (temHorario.has(k) || jaChamado.has(`${k}|${r.dia}`)) continue;
    out.push({ chave: k, telefone: r.telefone, nome: r.cliente_nome, servico: r.servico, profissional: r.profissional, ultima_visita: r.dia, dias: passou });
  }
  return out.sort((a, b) => a.dias - b.dias);
}

function renderRetorno(modelo, cand, c) {
  const vars = {
    nome: cand.nome || '', primeiro_nome: String(cand.nome || '').trim().split(/\s+/)[0] || '',
    dias: String(cand.dias), servico: cand.servico || 'atendimento', profissional: cand.profissional || '',
    ultima_visita: U.brData(cand.ultima_visita), empresa: c.empresa || '', link_agendamento: linkAgendamento(c),
  };
  return String(modelo || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)).replace(/[ \t]+$/gm, '').trim();
}

let rodandoRetorno = false;
async function tickRetorno() {
  if (rodandoRetorno) return;
  rodandoRetorno = true;
  try {
    const c = await cfg.obter();
    if (!c.retorno_ativo) return;
    const h = U.horaAgora();
    if (h < (c.retorno_hora || '10:00') || h < (c.janela_inicio || '08:00') || h > (c.janela_fim || '20:00')) return;
    const { rows: u } = await q("SELECT valor FROM config WHERE chave = '_retorno_ultima'");
    if (u[0] && u[0].valor === U.hoje()) return;
    const st = await wa.estado();
    if (!st.conectado) return;
    await q("INSERT INTO config (chave, valor) VALUES ('_retorno_ultima', $1) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor", [JSON.stringify(U.hoje())]);
    const lista = (await candidatosRetorno(c)).slice(0, Math.max(1, Number(c.retorno_limite) || 20));
    for (let i = 0; i < lista.length; i++) {
      const cand = lista[i];
      const texto = renderRetorno(c.retorno_msg, cand, c);
      let status = 'enviado';
      let erroMsg = null;
      try { await wa.enviarTexto(U.normalizarTelefone(cand.telefone), texto); } catch (e) { status = 'erro'; erroMsg = e.message; }
      await q(`INSERT INTO retornos_enviados (chave_telefone, ultima_visita, telefone, nome, status) VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (chave_telefone, ultima_visita) DO NOTHING`, [cand.chave, cand.ultima_visita, cand.telefone, cand.nome, status]);
      await q("INSERT INTO mensagens (direcao, etapa, telefone, texto, status, erro) VALUES ('saida','retorno',$1,$2,$3,$4)", [cand.telefone, texto, status, erroMsg]);
      if (i < lista.length - 1) await new Promise((ok) => setTimeout(ok, U.aleatorio(Number(c.intervalo_min) || 25, Number(c.intervalo_max) || 70) * 1000));
    }
    if (lista.length) console.log(`[retorno] ${lista.length} mensagem(ns) de retorno`);
  } catch (e) {
    console.error('[retorno]', e.message);
  } finally {
    rodandoRetorno = false;
  }
}

// ---------- Agendamento online (público, sem login) ----------
const tentativasOnline = new Map(); // ip -> [timestamps]
function limitar(ip) {
  const agora = Date.now();
  const lista = (tentativasOnline.get(ip) || []).filter((t) => agora - t < 3600 * 1000);
  if (lista.length >= 6) return false;
  lista.push(agora);
  tentativasOnline.set(ip, lista);
  if (tentativasOnline.size > 5000) tentativasOnline.clear();
  return true;
}

async function dadosPublicos() {
  const c = await cfg.obter();
  const logo = await cfg.obterLogo();
  const base = { ativo: !!c.online_ativo, empresa: c.empresa, sistema_nome: c.sistema_nome, tema: c.tema, tem_logo: !!logo, logo_versao: logo ? logo.versao : null };
  if (!c.online_ativo) return base;
  const { rows: servicos } = await q('SELECT id, nome, duracao_min, preco FROM servicos WHERE ativo ORDER BY nome');
  const { rows: profs } = await q('SELECT id, nome, cor, expediente FROM profissionais WHERE ativo ORDER BY ordem, nome');
  return {
    ...base, aviso: c.online_aviso || '', dias: Math.min(90, Math.max(1, Number(c.online_dias) || 30)),
    servicos, profissionais: profs.map((p) => ({ id: p.id, nome: p.nome, cor: p.cor, dias: (p.expediente && p.expediente.dias) || [] })),
  };
}

function dataValida(c, data) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data || ''))) return false;
  const d = U.diffDias(data, U.hoje());
  return d >= 0 && d <= Math.min(90, Math.max(1, Number(c.online_dias) || 30));
}

// horários livres para o cliente: de um profissional ou de qualquer um (primeiro livre)
async function horariosPublicos(data, servicoId, profId) {
  const c = await cfg.obter();
  if (!c.online_ativo) throw erro(403, 'Agendamento online desativado');
  if (!dataValida(c, data)) return [];
  const { rows } = await q('SELECT * FROM servicos WHERE id = $1 AND ativo', [servicoId]);
  if (!rows[0]) throw erro(400, 'Escolha o serviço');
  const lista = await AG.horariosLivres(data, rows[0].duracao_min, profId || null, Math.max(0, Number(c.online_antecedencia_min) || 0));
  const porHora = new Map();
  for (const p of lista) for (const h of p.horarios) if (!porHora.has(h)) porHora.set(h, p.profissional_id);
  return [...porHora.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([hora, profissional_id]) => ({ hora, profissional_id }));
}

async function agendarPublico(b, ip) {
  const c = await cfg.obter();
  if (!c.online_ativo) throw erro(403, 'Agendamento online desativado');
  if (b.site) throw erro(400, 'Requisição inválida'); // campo escondido anti-robô
  if (!limitar(ip)) throw erro(429, 'Muitas tentativas. Tente de novo mais tarde ou chame no WhatsApp.');
  const nome = String(b.nome || '').trim().slice(0, 80);
  if (nome.length < 2) throw erro(400, 'Informe seu nome');
  const tel = U.normalizarTelefone(b.telefone);
  if (!U.telefoneValido(tel)) throw erro(400, 'Informe seu WhatsApp com DDD');
  if (!dataValida(c, b.data) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.hora || ''))) throw erro(400, 'Escolha o dia e o horário');
  const { rows: sv } = await q('SELECT * FROM servicos WHERE id = $1 AND ativo', [b.servico_id]);
  if (!sv[0]) throw erro(400, 'Escolha o serviço');
  // no máximo 2 horários futuros por telefone marcados pelo site
  const { rows: fut } = await q("SELECT telefone FROM agendamentos WHERE status IN ('agendado','confirmado') AND inicio > now() AND origem = 'online'");
  if (fut.filter((f) => U.chaveTelefone(f.telefone) === U.chaveTelefone(tel)).length >= 2) {
    throw erro(400, 'Você já tem horários marcados. Para mudar, responda a mensagem de confirmação no WhatsApp.');
  }
  // confere se o horário continua livre (e escolhe o profissional, se for "sem preferência")
  const livres = await horariosPublicos(b.data, sv[0].id, b.profissional_id ? parseInt(b.profissional_id, 10) : null);
  const slot = livres.find((l) => l.hora === b.hora);
  if (!slot) throw erro(409, 'Esse horário acabou de ser ocupado. Escolha outro.');
  const profId = b.profissional_id ? parseInt(b.profissional_id, 10) : slot.profissional_id;
  const { rows: cli } = await q('SELECT id, telefone FROM clientes');
  const cliente = cli.find((x) => U.chaveTelefone(x.telefone) === U.chaveTelefone(tel));
  const inicio = `${b.data} ${b.hora}`;
  const { rows } = await q(
    `INSERT INTO agendamentos (profissional_id, servico_id, cliente_id, cliente_nome, telefone, inicio, fim, status, valor, obs, criado_por, origem)
     VALUES ($1,$2,$3,$4,$5, $6::timestamp AT TIME ZONE '${TZ}', ($6::timestamp AT TIME ZONE '${TZ}') + ($7 || ' minutes')::interval,
             'agendado', $8, 'Marcado pelo cliente no link de agendamento', 'Agendamento online', 'online') RETURNING id`,
    [profId, sv[0].id, cliente ? cliente.id : null, nome, tel, inicio, String(sv[0].duracao_min), sv[0].preco]);
  const ag = await AG.buscar(rows[0].id);
  let whatsapp = false;
  try {
    const st = await wa.estado();
    if (st.conectado) {
      const r = await AG.enviarMsg(ag, c.agenda_msg_confirmacao, 'agenda_confirmacao');
      if (r.ok) { whatsapp = true; await q('UPDATE agendamentos SET confirmacao_enviada = TRUE WHERE id = $1', [ag.id]); }
    }
  } catch (e) { console.warn('[online] confirmação:', e.message); }
  return { ok: true, data: b.data, hora: b.hora, profissional: ag.profissional_nome, servico: ag.servico_nome, whatsapp };
}

// rotas públicas (registradas ANTES da exigência de login)
function rotasPublicas(app) {
  const rota = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    if (!e.status) console.error('[online]', e);
    res.status(e.status && e.status < 500 ? e.status : 500).json({ erro: e.status ? e.message : 'Erro ao processar. Tente novamente.' });
  });
  app.get('/api/publico/agenda', rota(async (req, res) => res.json(await dadosPublicos())));
  app.get('/api/publico/agenda/horarios', rota(async (req, res) => {
    res.json(await horariosPublicos(String(req.query.data || ''), parseInt(req.query.servico_id, 10), req.query.profissional_id ? parseInt(req.query.profissional_id, 10) : null));
  }));
  app.post('/api/publico/agenda', rota(async (req, res) => res.json(await agendarPublico(req.body || {}, req.ip || 'x'))));
}

// rotas internas (com login)
function rotas(app, { rota, pode }) {
  app.get('/api/retorno/previa', pode('configuracoes'), rota(async (req, res) => {
    const c = await cfg.obter();
    const lista = await candidatosRetorno(c);
    const exemplo = lista[0] || { nome: 'João da Silva', dias: Number(c.retorno_dias) || 30, servico: 'Corte', profissional: 'Carlos', ultima_visita: U.hoje() };
    const { rows: env } = await q("SELECT COUNT(*)::int n FROM retornos_enviados WHERE enviado_em > now() - interval '30 days' AND status = 'enviado'");
    res.json({ candidatos: lista.length, proximos: lista.slice(0, 10), enviados_30d: env[0].n, exemplo: renderRetorno(req.query.modelo || c.retorno_msg, exemplo, c) });
  }));
}

module.exports = { iniciar, tickRetorno, rotasPublicas, rotas, candidatosRetorno };
