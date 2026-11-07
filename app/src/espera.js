// Lista de espera: quem queria um horário que estava cheio é avisado no WhatsApp quando alguém desmarca
const { q } = require('./db');
const cfg = require('./config');
const wa = require('./whatsapp');
const U = require('./util');

const TZ = 'America/Sao_Paulo';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lista_espera (
  id SERIAL PRIMARY KEY,
  cliente_id INT REFERENCES clientes(id) ON DELETE SET NULL,
  cliente_nome TEXT NOT NULL,
  telefone TEXT,
  servico_id INT,
  profissional_id INT,
  data DATE NOT NULL,
  hora_de TEXT,
  hora_ate TEXT,
  obs TEXT,
  status TEXT NOT NULL DEFAULT 'aguardando',
  avisado_em TIMESTAMPTZ,
  avisos INT NOT NULL DEFAULT 0,
  criado_por TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lista_espera_data_idx ON lista_espera (data, status);
`;

const STATUS = ['aguardando', 'avisado', 'marcado', 'cancelado'];

async function iniciar() {
  await q(SCHEMA);
}

function erro(status, msg) { const e = new Error(msg); e.status = status; return e; }
const okHora = (h) => /^\d{2}:\d{2}$/.test(String(h || ''));
const meuProf = (req) => (req.usuario && !req.usuario.admin && req.usuario.profissional_id) || null;

async function listar(data, prof) {
  const { rows } = await q(
    `SELECT e.*, s.nome AS servico_nome, p.nome AS profissional_nome, p.cor
       FROM lista_espera e LEFT JOIN servicos s ON s.id = e.servico_id LEFT JOIN profissionais p ON p.id = e.profissional_id
      WHERE e.data = $1 AND ($2::int IS NULL OR e.profissional_id IS NULL OR e.profissional_id = $2)
      ORDER BY (e.status IN ('aguardando','avisado')) DESC, e.criado_em`, [data, prof]);
  return rows;
}

async function contarPorDia(de, ate, prof) {
  const { rows } = await q(
    `SELECT data::text AS data, COUNT(*)::int n FROM lista_espera
      WHERE data BETWEEN $1 AND $2 AND status IN ('aguardando','avisado')
        AND ($3::int IS NULL OR profissional_id IS NULL OR profissional_id = $3)
      GROUP BY data`, [de, ate, prof]);
  return Object.fromEntries(rows.map((r) => [r.data, r.n]));
}

async function criar(b, quem, profFixo) {
  const nome = String(b.cliente_nome || '').trim();
  if (!nome) throw erro(400, 'Informe o nome do cliente');
  let tel = null;
  if (b.telefone) {
    tel = U.normalizarTelefone(b.telefone);
    if (!U.telefoneValido(tel)) throw erro(400, 'Telefone inválido. Use DDD + número.');
  }
  if (!tel) throw erro(400, 'Informe o WhatsApp para a pessoa ser avisada');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.data || '')) throw erro(400, 'Informe o dia');
  const de = okHora(b.hora_de) ? b.hora_de : null;
  const ate = okHora(b.hora_ate) ? b.hora_ate : null;
  if (de && ate && de > ate) throw erro(400, 'O horário inicial é depois do final');
  const prof = profFixo || (parseInt(b.profissional_id, 10) || null);
  const { rows } = await q(
    `INSERT INTO lista_espera (cliente_id, cliente_nome, telefone, servico_id, profissional_id, data, hora_de, hora_ate, obs, criado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [parseInt(b.cliente_id, 10) || null, nome, tel, parseInt(b.servico_id, 10) || null, prof, b.data, de, ate, String(b.obs || '').trim() || null, quem || null]);
  return rows[0];
}

// Chamado quando um horário é desmarcado: avisa quem está esperando aquele dia/horário
async function avisarVaga(ag) {
  try {
    const c = await cfg.obter();
    if (!c.modulos || c.modulos.espera === false || !c.espera_auto) return [];
    if (!ag || !ag.inicio_local || ag.status === 'bloqueio') return [];
    const [data, hora] = ag.inicio_local.split('T');
    // só vale para horários que ainda não passaram
    const { rows: fut } = await q('SELECT ($1::timestamp AT TIME ZONE $2) > now() AS ok', [`${data} ${hora}`, TZ]);
    if (!fut[0] || !fut[0].ok) return [];
    const { rows } = await q(
      `SELECT * FROM lista_espera
        WHERE data = $1 AND status = 'aguardando' AND telefone IS NOT NULL
          AND (profissional_id IS NULL OR profissional_id = $2)
          AND (hora_de IS NULL OR hora_de <= $3) AND (hora_ate IS NULL OR hora_ate >= $3)
        ORDER BY criado_em LIMIT $4`, [data, ag.profissional_id, hora, Math.max(1, Number(c.espera_qtd_aviso) || 3)]);
    if (!rows.length) return [];
    const st = await wa.estado().catch(() => ({}));
    if (!st.conectado) return [];
    const AG = require('./agenda');
    const avisados = [];
    for (const e of rows) {
      const r = await AG.enviarMsg({ ...ag, cliente_id: e.cliente_id, cliente_nome: e.cliente_nome, telefone: e.telefone }, c.espera_msg, 'espera_vaga');
      if (r.ok) {
        await q("UPDATE lista_espera SET status='avisado', avisado_em=now(), avisos = avisos + 1 WHERE id=$1", [e.id]);
        avisados.push(e.cliente_nome);
      }
    }
    return avisados;
  } catch (e) {
    console.warn('[espera] aviso:', e.message);
    return [];
  }
}

function rotas(app, { rota, pode }) {
  app.get('/api/espera', rota(async (req, res) => {
    const data = /^\d{4}-\d{2}-\d{2}$/.test(req.query.data || '') ? req.query.data : U.hoje();
    res.json(await listar(data, meuProf(req)));
  }));
  app.get('/api/espera/contagem', rota(async (req, res) => {
    const de = /^\d{4}-\d{2}-\d{2}$/.test(req.query.de || '') ? req.query.de : U.hoje();
    const ate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.ate || '') ? req.query.ate : de;
    res.json(await contarPorDia(de, ate, meuProf(req)));
  }));
  app.post('/api/espera', pode('agenda'), rota(async (req, res) => res.json(await criar(req.body || {}, req.usuario.nome, meuProf(req)))));
  app.put('/api/espera/:id', pode('agenda'), rota(async (req, res) => {
    const st = (req.body || {}).status;
    if (!STATUS.includes(st)) throw erro(400, 'Situação inválida');
    const p = meuProf(req);
    const { rows } = await q('UPDATE lista_espera SET status=$1 WHERE id=$2 AND ($3::int IS NULL OR profissional_id IS NULL OR profissional_id = $3) RETURNING *', [st, req.params.id, p]);
    if (!rows[0]) throw erro(404, 'Não encontrado');
    res.json(rows[0]);
  }));
  app.delete('/api/espera/:id', pode('agenda'), rota(async (req, res) => {
    const p = meuProf(req);
    await q('DELETE FROM lista_espera WHERE id=$1 AND ($2::int IS NULL OR profissional_id IS NULL OR profissional_id = $2)', [req.params.id, p]);
    res.json({ ok: true });
  }));
}

module.exports = { iniciar, rotas, avisarVaga, listar };
