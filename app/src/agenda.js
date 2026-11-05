// Agenda: profissionais, serviços, agendamentos, confirmação e lembretes pelo WhatsApp
const { q } = require('./db');
const cfg = require('./config');
const wa = require('./whatsapp');
const U = require('./util');

const TZ = 'America/Sao_Paulo';
const STATUS = ['agendado', 'confirmado', 'concluido', 'faltou', 'cancelado', 'bloqueio'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profissionais (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  cor TEXT NOT NULL DEFAULT '#31b2e8',
  telefone TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  ordem INT NOT NULL DEFAULT 0,
  expediente JSONB NOT NULL DEFAULT '{"dias":[1,2,3,4,5,6],"inicio":"09:00","fim":"19:00","almoco_inicio":"12:00","almoco_fim":"13:00"}',
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS servicos (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  duracao_min INT NOT NULL DEFAULT 30,
  preco NUMERIC(12,2) NOT NULL DEFAULT 0,
  ativo BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS agendamentos (
  id SERIAL PRIMARY KEY,
  profissional_id INT NOT NULL REFERENCES profissionais(id) ON DELETE CASCADE,
  servico_id INT REFERENCES servicos(id) ON DELETE SET NULL,
  cliente_id INT REFERENCES clientes(id) ON DELETE SET NULL,
  cliente_nome TEXT,
  telefone TEXT,
  inicio TIMESTAMPTZ NOT NULL,
  fim TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'agendado',
  valor NUMERIC(12,2),
  pago BOOLEAN NOT NULL DEFAULT FALSE,
  forma_pagamento TEXT,
  obs TEXT,
  confirmacao_enviada BOOLEAN NOT NULL DEFAULT FALSE,
  lembrete_enviado BOOLEAN NOT NULL DEFAULT FALSE,
  criado_por TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agendamentos_inicio_idx ON agendamentos (inicio);
ALTER TABLE profissionais ADD COLUMN IF NOT EXISTS comissao_pct NUMERIC(5,2) NOT NULL DEFAULT 0;
ALTER TABLE servicos ADD COLUMN IF NOT EXISTS comissao_pct NUMERIC(5,2);
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS comissao_pct NUMERIC(5,2);
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS comissao_valor NUMERIC(12,2);
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS concluido_em TIMESTAMPTZ;
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS pago_em TIMESTAMPTZ;
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS origem TEXT;
CREATE INDEX IF NOT EXISTS agendamentos_prof_idx ON agendamentos (profissional_id, inicio);
`;

async function iniciar() { await q(SCHEMA); }

function erro(status, msg) { const e = new Error(msg); e.status = status; return e; }

// colunas de data/hora sempre devolvidas no horário de Brasília, 'YYYY-MM-DDTHH:MM'
const COLS = `a.*, to_char(a.inicio AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI') AS inicio_local,
  to_char(a.fim AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI') AS fim_local`;

const okHora = (h) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(h || ''));
const okDataHora = (s) => /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));

// ---------- Profissionais ----------
function validarProf(b) {
  const nome = String(b.nome || '').trim();
  if (!nome) throw erro(400, 'Informe o nome do profissional');
  const cor = /^#[0-9a-f]{6}$/i.test(b.cor || '') ? b.cor : '#31b2e8';
  const e = b.expediente || {};
  const exp = {
    dias: Array.isArray(e.dias) ? e.dias.map(Number).filter((d) => d >= 0 && d <= 6) : [1, 2, 3, 4, 5, 6],
    inicio: okHora(e.inicio) ? e.inicio : '09:00',
    fim: okHora(e.fim) ? e.fim : '19:00',
    almoco_inicio: okHora(e.almoco_inicio) ? e.almoco_inicio : '',
    almoco_fim: okHora(e.almoco_fim) ? e.almoco_fim : '',
  };
  if (exp.inicio >= exp.fim) throw erro(400, 'O horário de saída precisa ser depois da entrada');
  const comissao = Number(String(b.comissao_pct ?? 0).replace(',', '.')) || 0;
  if (comissao < 0 || comissao > 100) throw erro(400, 'Comissão deve ficar entre 0 e 100%');
  return { nome, cor, telefone: b.telefone ? U.normalizarTelefone(b.telefone) : null, ativo: b.ativo !== false, ordem: parseInt(b.ordem, 10) || 0, expediente: exp, comissao };
}

// ---------- Mensagens ----------
async function renderizar(modelo, ag) {
  const c = await cfg.obter();
  const [data, hora] = ag.inicio_local.split('T');
  const dt = U.parseData(data);
  const dias = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  const vars = {
    nome: ag.cliente_nome || '',
    primeiro_nome: String(ag.cliente_nome || '').trim().split(/\s+/)[0] || '',
    data: U.brData(data),
    dia_semana: dias[dt.getUTCDay()],
    hora,
    profissional: ag.profissional_nome || '',
    servico: ag.servico_nome || 'atendimento',
    valor: ag.valor != null ? U.brl(ag.valor) : '',
    empresa: c.empresa || '',
  };
  return String(modelo || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

async function registrarMsg(ag, etapa, texto, status, erroMsg) {
  await q(
    `INSERT INTO mensagens (cliente_id, direcao, etapa, telefone, texto, status, erro) VALUES ($1,'saida',$2,$3,$4,$5,$6)`,
    [ag.cliente_id || null, etapa, ag.telefone, texto, status, erroMsg || null]
  );
}

async function enviarMsg(ag, modelo, etapa) {
  if (!ag.telefone || !U.telefoneValido(ag.telefone)) return { ok: false, erro: 'Agendamento sem telefone válido' };
  const texto = await renderizar(modelo, ag);
  try {
    await wa.enviarTexto(U.normalizarTelefone(ag.telefone), texto);
    await registrarMsg(ag, etapa, texto, 'enviado');
    return { ok: true };
  } catch (e) {
    await registrarMsg(ag, etapa, texto, 'erro', e.message);
    return { ok: false, erro: e.message };
  }
}

async function buscar(id) {
  const { rows } = await q(
    `SELECT ${COLS}, p.nome AS profissional_nome, p.cor, s.nome AS servico_nome
       FROM agendamentos a JOIN profissionais p ON p.id = a.profissional_id LEFT JOIN servicos s ON s.id = a.servico_id
      WHERE a.id = $1`, [id]);
  return rows[0] || null;
}

// ---------- Lembretes (chamado pelo agendador a cada minuto) ----------
let rodandoLembretes = false;
async function tickLembretes() {
  if (rodandoLembretes) return;
  rodandoLembretes = true;
  try {
    const c = await cfg.obter();
    if (!c.agenda_lembrete) return;
    const h = U.horaAgora();
    if (h < (c.janela_inicio || '08:00') || h > (c.janela_fim || '20:00')) return;
    const horas = Math.max(1, Number(c.agenda_lembrete_horas) || 24);
    const { rows } = await q(
      `SELECT a.id FROM agendamentos a
        WHERE a.status IN ('agendado','confirmado') AND NOT a.lembrete_enviado AND a.telefone IS NOT NULL
          AND a.inicio > now() + interval '20 minutes' AND a.inicio <= now() + ($1 || ' hours')::interval
        ORDER BY a.inicio LIMIT 10`, [String(horas)]);
    if (!rows.length) return;
    const st = await wa.estado();
    if (!st.conectado) return;
    for (const r of rows) {
      const ag = await buscar(r.id);
      await q('UPDATE agendamentos SET lembrete_enviado = TRUE WHERE id = $1', [r.id]);
      await enviarMsg(ag, c.agenda_msg_lembrete, 'agenda_lembrete');
      await new Promise((ok) => setTimeout(ok, U.aleatorio(8, 20) * 1000));
    }
  } catch (e) {
    console.error('[agenda lembretes]', e.message);
  } finally {
    rodandoLembretes = false;
  }
}

// ---------- Respostas do cliente (SIM / CANCELAR) ----------
async function tratarResposta(numero, texto) {
  const t = String(texto || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!t) return false;
  const sim = /^(sim|s|1|confirmo|confirmado|confirmar|ok|certo|combinado)\b/.test(t);
  const nao = /^(nao|n|2|cancelar|cancela|cancelo|desmarcar|desmarca)\b/.test(t);
  if (!sim && !nao) return false;
  const chave = U.chaveTelefone(numero);
  const { rows } = await q(
    `SELECT a.id, a.telefone FROM agendamentos a
      WHERE a.status IN ('agendado','confirmado') AND a.inicio > now() AND a.inicio < now() + interval '3 days'
      ORDER BY a.inicio`);
  const alvo = rows.find((r) => r.telefone && U.chaveTelefone(r.telefone) === chave);
  if (!alvo) return false;
  const ag = await buscar(alvo.id);
  const c = await cfg.obter();
  if (sim) {
    await q("UPDATE agendamentos SET status='confirmado' WHERE id=$1", [ag.id]);
    await enviarMsg(ag, c.agenda_msg_confirmado, 'agenda_confirmado');
  } else {
    await q("UPDATE agendamentos SET status='cancelado', obs = TRIM(COALESCE(obs,'') || ' [cancelado pelo cliente no WhatsApp]') WHERE id=$1", [ag.id]);
    await enviarMsg(ag, c.agenda_msg_cancelado, 'agenda_cancelado');
  }
  return true;
}

// ---------- Comissão ----------
// Grava o percentual e o valor da comissão no momento da conclusão (histórico não muda se o % mudar depois)
async function aplicarComissao(id) {
  await q(
    `UPDATE agendamentos a SET
        comissao_pct = COALESCE((SELECT s.comissao_pct FROM servicos s WHERE s.id = a.servico_id), p.comissao_pct, 0),
        comissao_valor = ROUND(COALESCE(a.valor, 0) * COALESCE((SELECT s.comissao_pct FROM servicos s WHERE s.id = a.servico_id), p.comissao_pct, 0) / 100, 2),
        concluido_em = COALESCE(a.concluido_em, now())
       FROM profissionais p
      WHERE p.id = a.profissional_id AND a.id = $1 AND a.status = 'concluido'`, [id]);
  await q("UPDATE agendamentos SET comissao_pct = NULL, comissao_valor = NULL, concluido_em = NULL WHERE id = $1 AND status <> 'concluido'", [id]);
  // guarda quando foi pago (usado no caixa do dia)
  await q('UPDATE agendamentos SET pago_em = CASE WHEN pago THEN COALESCE(pago_em, now()) ELSE NULL END WHERE id = $1', [id]);
}

// horários livres de cada profissional num dia (dur = duração em minutos; profId opcional)
async function horariosLivres(data, dur, profId, antecedenciaMin = 0) {
  const { rows: ps } = await q('SELECT * FROM profissionais WHERE ativo AND ($1::int IS NULL OR id = $1) ORDER BY ordem, nome', [profId || null]);
  const { rows: ags } = await q(
    `SELECT profissional_id, to_char(inicio AT TIME ZONE '${TZ}','HH24:MI') i, to_char(fim AT TIME ZONE '${TZ}','HH24:MI') f
       FROM agendamentos WHERE status NOT IN ('cancelado','faltou')
        AND inicio >= ($1::date)::timestamp AT TIME ZONE '${TZ}' AND inicio < (($1::date + 1)::timestamp) AT TIME ZONE '${TZ}'`, [data]);
  const c = await cfg.obter();
  const passo = Number(c.agenda_intervalo) || 30;
  const dow = U.parseData(data).getUTCDay();
  const toMin = (h) => { const [a, b] = h.split(':').map(Number); return a * 60 + b; };
  const toH = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const hoje = U.hoje();
  if (data < hoje) return ps.map((p) => ({ profissional_id: p.id, nome: p.nome, horarios: [] }));
  const minimo = data === hoje ? toMin(U.horaAgora()) + antecedenciaMin : 0;
  return ps.map((p) => {
    const e = p.expediente || {};
    if (!(e.dias || []).includes(dow)) return { profissional_id: p.id, nome: p.nome, horarios: [] };
    const ocup = ags.filter((a) => a.profissional_id === p.id).map((a) => [toMin(a.i), toMin(a.f)]);
    if (e.almoco_inicio && e.almoco_fim) ocup.push([toMin(e.almoco_inicio), toMin(e.almoco_fim)]);
    const livres = [];
    for (let m = toMin(e.inicio); m + dur <= toMin(e.fim); m += passo) {
      if (m < minimo) continue;
      if (ocup.some(([a, b]) => m < b && m + dur > a)) continue;
      livres.push(toH(m));
    }
    return { profissional_id: p.id, nome: p.nome, horarios: livres };
  });
}

// ---------- Rotas ----------
function rotas(app, { rota, pode }) {
  // profissionais
  app.get('/api/agenda/profissionais', rota(async (req, res) => {
    const { rows } = await q('SELECT * FROM profissionais ORDER BY ativo DESC, ordem, nome');
    res.json(rows);
  }));
  app.post('/api/agenda/profissionais', pode('agenda_config'), rota(async (req, res) => {
    const p = validarProf(req.body || {});
    const { rows } = await q('INSERT INTO profissionais (nome, cor, telefone, ativo, ordem, expediente, comissao_pct) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [p.nome, p.cor, p.telefone, p.ativo, p.ordem, JSON.stringify(p.expediente), p.comissao]);
    res.json(rows[0]);
  }));
  app.put('/api/agenda/profissionais/:id', pode('agenda_config'), rota(async (req, res) => {
    const p = validarProf(req.body || {});
    const { rows } = await q('UPDATE profissionais SET nome=$1, cor=$2, telefone=$3, ativo=$4, ordem=$5, expediente=$6, comissao_pct=$7 WHERE id=$8 RETURNING *',
      [p.nome, p.cor, p.telefone, p.ativo, p.ordem, JSON.stringify(p.expediente), p.comissao, req.params.id]);
    if (!rows[0]) throw erro(404, 'Profissional não encontrado');
    res.json(rows[0]);
  }));
  app.delete('/api/agenda/profissionais/:id', pode('agenda_config'), rota(async (req, res) => {
    const { rows } = await q("SELECT COUNT(*)::int n FROM agendamentos WHERE profissional_id=$1 AND status <> 'bloqueio'", [req.params.id]);
    if (rows[0].n) throw erro(400, 'Este profissional tem atendimentos no histórico. Desative em vez de excluir.');
    await q('DELETE FROM profissionais WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  }));

  // serviços
  app.get('/api/agenda/servicos', rota(async (req, res) => {
    const { rows } = await q('SELECT * FROM servicos ORDER BY ativo DESC, nome');
    res.json(rows);
  }));
  const validarServ = (b) => {
    const nome = String(b.nome || '').trim();
    if (!nome) throw erro(400, 'Informe o nome do serviço');
    const dur = parseInt(b.duracao_min, 10);
    if (!(dur >= 5 && dur <= 600)) throw erro(400, 'Duração entre 5 e 600 minutos');
    const preco = Number(String(b.preco ?? 0).replace(',', '.')) || 0;
    let com = b.comissao_pct === '' || b.comissao_pct == null ? null : Number(String(b.comissao_pct).replace(',', '.'));
    if (com != null && (isNaN(com) || com < 0 || com > 100)) throw erro(400, 'Comissão do serviço deve ficar entre 0 e 100%');
    return { nome, dur, preco, ativo: b.ativo !== false, com };
  };
  app.post('/api/agenda/servicos', pode('agenda_config'), rota(async (req, res) => {
    const s = validarServ(req.body || {});
    const { rows } = await q('INSERT INTO servicos (nome, duracao_min, preco, ativo, comissao_pct) VALUES ($1,$2,$3,$4,$5) RETURNING *', [s.nome, s.dur, s.preco, s.ativo, s.com]);
    res.json(rows[0]);
  }));
  app.put('/api/agenda/servicos/:id', pode('agenda_config'), rota(async (req, res) => {
    const s = validarServ(req.body || {});
    const { rows } = await q('UPDATE servicos SET nome=$1, duracao_min=$2, preco=$3, ativo=$4, comissao_pct=$5 WHERE id=$6 RETURNING *', [s.nome, s.dur, s.preco, s.ativo, s.com, req.params.id]);
    res.json(rows[0]);
  }));
  app.delete('/api/agenda/servicos/:id', pode('agenda_config'), rota(async (req, res) => {
    await q('DELETE FROM servicos WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  }));

  // agendamentos de um período (de/ate: YYYY-MM-DD, inclusive)
  app.get('/api/agenda', rota(async (req, res) => {
    const de = /^\d{4}-\d{2}-\d{2}$/.test(req.query.de || '') ? req.query.de : U.hoje();
    const ate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.ate || '') ? req.query.ate : de;
    const { rows } = await q(
      `SELECT ${COLS}, p.nome AS profissional_nome, p.cor, s.nome AS servico_nome
         FROM agendamentos a JOIN profissionais p ON p.id = a.profissional_id LEFT JOIN servicos s ON s.id = a.servico_id
        WHERE a.inicio >= ($1::date)::timestamp AT TIME ZONE '${TZ}'
          AND a.inicio < (($2::date + 1)::timestamp) AT TIME ZONE '${TZ}'
        ORDER BY a.inicio`, [de, ate]);
    res.json(rows);
  }));

  // sugestões de clientes (nome/telefone) para o campo de busca
  app.get('/api/agenda/clientes', rota(async (req, res) => {
    const termo = `%${String(req.query.q || '').trim()}%`;
    const { rows } = await q(
      `SELECT nome, telefone, id AS cliente_id FROM clientes WHERE nome ILIKE $1 OR telefone ILIKE $1
       UNION
       SELECT DISTINCT ON (telefone) cliente_nome, telefone, cliente_id FROM agendamentos
        WHERE telefone IS NOT NULL AND (cliente_nome ILIKE $1 OR telefone ILIKE $1)
       LIMIT 15`, [termo]);
    const vistos = new Set();
    res.json(rows.filter((r) => { const k = U.chaveTelefone(r.telefone); if (vistos.has(k)) return false; vistos.add(k); return true; }));
  }));

  async function salvarAgendamento(req, id) {
    const b = req.body || {};
    const bloqueio = b.status === 'bloqueio';
    if (!okDataHora(b.inicio)) throw erro(400, 'Data/hora inválida');
    const dur = parseInt(b.duracao_min, 10);
    if (!(dur >= 5 && dur <= 720)) throw erro(400, 'Duração inválida');
    const prof = parseInt(b.profissional_id, 10);
    if (!prof) throw erro(400, 'Escolha o profissional');
    const status = STATUS.includes(b.status) ? b.status : 'agendado';
    let tel = null;
    const nome = String(b.cliente_nome || '').trim() || null;
    if (!bloqueio) {
      if (!nome) throw erro(400, 'Informe o nome do cliente');
      if (b.telefone) {
        tel = U.normalizarTelefone(b.telefone);
        if (!U.telefoneValido(tel)) throw erro(400, 'Telefone inválido. Use DDD + número.');
      }
    }
    // conflito de horário com o mesmo profissional
    const { rows: conf } = await q(
      `SELECT a.id, a.cliente_nome, a.status, to_char(a.inicio AT TIME ZONE '${TZ}','HH24:MI') h
         FROM agendamentos a
        WHERE a.profissional_id = $1 AND a.status NOT IN ('cancelado','faltou') AND a.id <> $4
          AND a.inicio < ($2::timestamp AT TIME ZONE '${TZ}') + ($3 || ' minutes')::interval
          AND a.fim > ($2::timestamp AT TIME ZONE '${TZ}')`,
      [prof, b.inicio.replace('T', ' '), String(dur), id || 0]);
    if (conf.length && !b.forcar) {
      const c = conf[0];
      throw erro(409, c.status === 'bloqueio' ? `Horário bloqueado às ${c.h} para este profissional.` : `Conflito: ${c.cliente_nome || 'outro atendimento'} às ${c.h} com o mesmo profissional.`);
    }
    const valor = b.valor === '' || b.valor == null ? null : Number(String(b.valor).replace(',', '.'));
    const params = [prof, b.servico_id || null, b.cliente_id || null, bloqueio ? (nome || 'Bloqueado') : nome, tel,
      b.inicio.replace('T', ' '), String(dur), status, bloqueio ? null : valor, !!b.pago, b.forma_pagamento || null, b.obs || null];
    let r;
    if (id) {
      r = await q(
        `UPDATE agendamentos SET profissional_id=$1, servico_id=$2, cliente_id=$3, cliente_nome=$4, telefone=$5,
           inicio = $6::timestamp AT TIME ZONE '${TZ}', fim = ($6::timestamp AT TIME ZONE '${TZ}') + ($7 || ' minutes')::interval,
           status=$8, valor=$9, pago=$10, forma_pagamento=$11, obs=$12,
           lembrete_enviado = CASE WHEN inicio <> ($6::timestamp AT TIME ZONE '${TZ}') THEN FALSE ELSE lembrete_enviado END
         WHERE id=$13 RETURNING id`, [...params, id]);
      if (!r.rows[0]) throw erro(404, 'Agendamento não encontrado');
    } else {
      r = await q(
        `INSERT INTO agendamentos (profissional_id, servico_id, cliente_id, cliente_nome, telefone, inicio, fim, status, valor, pago, forma_pagamento, obs, criado_por)
         VALUES ($1,$2,$3,$4,$5, $6::timestamp AT TIME ZONE '${TZ}', ($6::timestamp AT TIME ZONE '${TZ}') + ($7 || ' minutes')::interval,
                 $8,$9,$10,$11,$12,$13) RETURNING id`, [...params, req.usuario ? req.usuario.nome : null]);
    }
    await aplicarComissao(r.rows[0].id);
    return buscar(r.rows[0].id);
  }

  app.post('/api/agenda', pode('agenda'), rota(async (req, res) => {
    const ag = await salvarAgendamento(req, null);
    let aviso = null;
    const c = await cfg.obter();
    const enviar = req.body.enviar_confirmacao ?? c.agenda_confirmacao;
    if (enviar && ag.telefone && ag.status !== 'bloqueio') {
      const st = await wa.estado();
      if (st.conectado) {
        const r = await enviarMsg(ag, c.agenda_msg_confirmacao, 'agenda_confirmacao');
        if (r.ok) await q('UPDATE agendamentos SET confirmacao_enviada=TRUE WHERE id=$1', [ag.id]);
        else aviso = 'Agendado, mas a mensagem não foi enviada: ' + r.erro;
      } else aviso = 'Agendado. O WhatsApp está desconectado, então a confirmação não foi enviada.';
    }
    res.json({ ...ag, aviso });
  }));
  app.put('/api/agenda/:id', pode('agenda'), rota(async (req, res) => res.json(await salvarAgendamento(req, req.params.id))));
  app.post('/api/agenda/:id/status', pode('agenda'), rota(async (req, res) => {
    const b = req.body || {};
    const sets = [];
    const p = [];
    if (b.status) { if (!STATUS.includes(b.status)) throw erro(400, 'Status inválido'); p.push(b.status); sets.push(`status=$${p.length}`); }
    if ('pago' in b) { p.push(!!b.pago); sets.push(`pago=$${p.length}`); }
    if (b.forma_pagamento) { p.push(b.forma_pagamento); sets.push(`forma_pagamento=$${p.length}`); }
    if (!sets.length) throw erro(400, 'Nada para alterar');
    p.push(req.params.id);
    await q(`UPDATE agendamentos SET ${sets.join(',')} WHERE id=$${p.length}`, p);
    await aplicarComissao(req.params.id);
    let fiado = null;
    if (b.pendurar) {
      const FIN = require('./financeiro');
      const r = await FIN.pendurarAgendamento(req.params.id, req.usuario.nome);
      fiado = { cliente: r.cliente.nome, anexado_em: r.anexado_em };
    }
    res.json({ ...(await buscar(req.params.id)), fiado });
  }));
  app.post('/api/agenda/:id/whatsapp', pode('agenda'), rota(async (req, res) => {
    const ag = await buscar(req.params.id);
    if (!ag) throw erro(404, 'Agendamento não encontrado');
    const c = await cfg.obter();
    const st = await wa.estado();
    if (!st.conectado) throw erro(400, 'WhatsApp não está conectado');
    const modelo = req.body && req.body.tipo === 'lembrete' ? c.agenda_msg_lembrete : c.agenda_msg_confirmacao;
    const r = await enviarMsg(ag, modelo, req.body && req.body.tipo === 'lembrete' ? 'agenda_lembrete' : 'agenda_confirmacao');
    if (!r.ok) throw erro(400, r.erro);
    res.json({ ok: true });
  }));
  app.delete('/api/agenda/:id', pode('agenda'), rota(async (req, res) => {
    await q('DELETE FROM agendamentos WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  }));

  // relatório de comissões por período (datas do atendimento, 'YYYY-MM-DD')
  app.get('/api/agenda/comissoes', pode('financeiro'), rota(async (req, res) => {
    const de = /^\d{4}-\d{2}-\d{2}$/.test(req.query.de || '') ? req.query.de : U.hoje();
    const ate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.ate || '') ? req.query.ate : de;
    const { rows } = await q(
      `SELECT ${COLS}, p.nome AS profissional_nome, p.cor, s.nome AS servico_nome
         FROM agendamentos a JOIN profissionais p ON p.id = a.profissional_id LEFT JOIN servicos s ON s.id = a.servico_id
        WHERE a.status IN ('concluido','faltou','cancelado','agendado','confirmado')
          AND a.inicio >= ($1::date)::timestamp AT TIME ZONE '${TZ}'
          AND a.inicio < (($2::date + 1)::timestamp) AT TIME ZONE '${TZ}'
        ORDER BY p.ordem, p.nome, a.inicio`, [de, ate]);
    const porProf = {};
    for (const a of rows) {
      const k = a.profissional_id;
      const r = porProf[k] || (porProf[k] = { profissional_id: k, nome: a.profissional_nome, cor: a.cor, atendimentos: 0, faturamento: 0, comissao: 0, recebido: 0, faltas: 0, pendentes: 0, itens: [] });
      if (a.status === 'concluido') {
        r.atendimentos++;
        r.faturamento += Number(a.valor || 0);
        r.comissao += Number(a.comissao_valor || 0);
        if (a.pago) r.recebido += Number(a.valor || 0);
        r.itens.push({ id: a.id, inicio: a.inicio_local, cliente: a.cliente_nome, servico: a.servico_nome, valor: Number(a.valor || 0), pct: Number(a.comissao_pct || 0), comissao: Number(a.comissao_valor || 0), pago: a.pago, forma: a.forma_pagamento });
      } else if (a.status === 'faltou') r.faltas++;
      else if (a.status === 'agendado' || a.status === 'confirmado') r.pendentes++;
    }
    // produtos vendidos (entram no faturamento e na comissão do profissional)
    const { rows: vds } = await q(
      `SELECT v.*, p.nome AS profissional_nome, p.cor FROM vendas v JOIN profissionais p ON p.id = v.profissional_id
        WHERE v.data BETWEEN $1 AND $2 ORDER BY v.data, v.criado_em`, [de, ate]);
    for (const v of vds) {
      const k = v.profissional_id;
      const r = porProf[k] || (porProf[k] = { profissional_id: k, nome: v.profissional_nome, cor: v.cor, atendimentos: 0, faturamento: 0, comissao: 0, recebido: 0, faltas: 0, pendentes: 0, itens: [] });
      r.produtos = (r.produtos || 0) + Number(v.valor_total);
      r.faturamento += Number(v.valor_total);
      r.comissao += Number(v.comissao_valor);
      if (v.forma_pagamento !== 'fiado') r.recebido += Number(v.valor_total);
      r.itens.push({ id: 'v' + v.id, produto: true, inicio: v.data + 'T--:--', cliente: v.cliente_nome, servico: `${v.quantidade > 1 ? v.quantidade + 'x ' : ''}${v.descricao}`, valor: Number(v.valor_total), pct: Number(v.comissao_pct), comissao: Number(v.comissao_valor), pago: v.forma_pagamento !== 'fiado', forma: v.forma_pagamento });
    }
    const lista = Object.values(porProf).map((r) => ({ ...r, produtos: +(r.produtos || 0).toFixed(2), servicos: +(r.faturamento - (r.produtos || 0)).toFixed(2), faturamento: +r.faturamento.toFixed(2), comissao: +r.comissao.toFixed(2), casa: +(r.faturamento - r.comissao).toFixed(2), recebido: +r.recebido.toFixed(2) }));
    const tot = lista.reduce((t, r) => ({ atendimentos: t.atendimentos + r.atendimentos, faturamento: t.faturamento + r.faturamento, produtos: t.produtos + r.produtos, comissao: t.comissao + r.comissao, casa: t.casa + r.casa, recebido: t.recebido + r.recebido, pendentes: t.pendentes + r.pendentes }), { atendimentos: 0, faturamento: 0, produtos: 0, comissao: 0, casa: 0, recebido: 0, pendentes: 0 });
    res.json({ de, ate, totais: tot, profissionais: lista });
  }));

  // próximos horários livres de um profissional num dia
  app.get('/api/agenda/livres', rota(async (req, res) => {
    const data = /^\d{4}-\d{2}-\d{2}$/.test(req.query.data || '') ? req.query.data : U.hoje();
    const dur = parseInt(req.query.duracao, 10) || 30;
    res.json(await horariosLivres(data, dur, req.query.profissional_id ? parseInt(req.query.profissional_id, 10) : null));
  }));
}

// resumo para o painel
async function resumoHoje() {
  const hoje = U.hoje();
  const { rows } = await q(
    `SELECT COUNT(*) FILTER (WHERE status NOT IN ('cancelado','bloqueio'))::int AS total,
            COUNT(*) FILTER (WHERE status = 'concluido')::int AS concluidos,
            COALESCE(SUM(valor) FILTER (WHERE status NOT IN ('cancelado','faltou','bloqueio')),0) AS previsto,
            COALESCE(SUM(valor) FILTER (WHERE pago),0) AS recebido
       FROM agendamentos
      WHERE inicio >= ($1::date)::timestamp AT TIME ZONE '${TZ}' AND inicio < (($1::date + 1)::timestamp) AT TIME ZONE '${TZ}'`, [hoje]);
  const { rows: prox } = await q(
    `SELECT ${COLS}, p.nome AS profissional_nome, p.cor, s.nome AS servico_nome
       FROM agendamentos a JOIN profissionais p ON p.id=a.profissional_id LEFT JOIN servicos s ON s.id=a.servico_id
      WHERE a.status IN ('agendado','confirmado') AND a.inicio >= now() - interval '15 minutes'
        AND a.inicio < (($1::date + 1)::timestamp) AT TIME ZONE '${TZ}'
      ORDER BY a.inicio LIMIT 6`, [hoje]);
  const { rows: tem } = await q('SELECT COUNT(*)::int n FROM profissionais WHERE ativo');
  return { ...rows[0], proximos: prox, usa_agenda: tem[0].n > 0 };
}

module.exports = { iniciar, rotas, tickLembretes, tratarResposta, resumoHoje, STATUS, horariosLivres, buscar, enviarMsg };
