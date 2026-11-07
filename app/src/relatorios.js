// Relatórios mensais: quanto entrou, quantos atendimentos e o resultado de cada profissional
const { q } = require('./db');
const U = require('./util');

const TZ = 'America/Sao_Paulo';

function erro(status, msg) { const e = new Error(msg); e.status = status; return e; }

function mesesAte(fim, n) {
  const [y, m] = fim.split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

async function mensal(n, ate) {
  const meses = mesesAte(ate, n);
  const de = meses[0] + '-01';
  const fimEx = (() => { const [y, m] = ate.split('-').map(Number); const d = new Date(Date.UTC(y, m, 1)); return d.toISOString().slice(0, 10); })();
  const porMes = (rows) => Object.fromEntries(rows.map((r) => [r.mes, r]));
  const [cob, ags, vds, ent, sai, conc] = await Promise.all([
    q(`SELECT to_char(pago_em, 'YYYY-MM') mes, COALESCE(SUM(COALESCE(pago_valor, valor)), 0) v, COUNT(*)::int n
         FROM cobrancas WHERE status = 'pago' AND pago_em >= $1 AND pago_em < $2 GROUP BY 1`, [de, fimEx]),
    q(`SELECT to_char(COALESCE(pago_em, inicio) AT TIME ZONE '${TZ}', 'YYYY-MM') mes, COALESCE(SUM(valor), 0) v
         FROM agendamentos WHERE pago AND COALESCE(forma_pagamento, '') NOT IN ('fiado', 'pacote') AND status <> 'cancelado'
          AND (COALESCE(pago_em, inicio) AT TIME ZONE '${TZ}')::date >= $1 AND (COALESCE(pago_em, inicio) AT TIME ZONE '${TZ}')::date < $2 GROUP BY 1`, [de, fimEx]),
    q(`SELECT to_char(data, 'YYYY-MM') mes, COALESCE(SUM(valor_total), 0) v FROM vendas
         WHERE forma_pagamento <> 'fiado' AND data >= $1 AND data < $2 GROUP BY 1`, [de, fimEx]),
    q(`SELECT to_char(data, 'YYYY-MM') mes, COALESCE(SUM(valor), 0) v FROM caixa_movimentos WHERE tipo = 'entrada' AND data >= $1 AND data < $2 GROUP BY 1`, [de, fimEx]),
    q(`SELECT to_char(data, 'YYYY-MM') mes, COALESCE(SUM(valor), 0) v FROM caixa_movimentos WHERE tipo <> 'entrada' AND data >= $1 AND data < $2 GROUP BY 1`, [de, fimEx]),
    q(`SELECT to_char(inicio AT TIME ZONE '${TZ}', 'YYYY-MM') mes, COUNT(*)::int n, COALESCE(SUM(comissao_valor), 0) com
         FROM agendamentos WHERE status = 'concluido' AND (inicio AT TIME ZONE '${TZ}')::date >= $1 AND (inicio AT TIME ZONE '${TZ}')::date < $2 GROUP BY 1`, [de, fimEx]),
  ]);
  const [C, A, V, E, S, K] = [cob, ags, vds, ent, sai, conc].map((r) => porMes(r.rows));
  return meses.map((mes) => {
    const cobrancas = Number((C[mes] || {}).v || 0);
    const atendimentos = Number((A[mes] || {}).v || 0);
    const produtos = Number((V[mes] || {}).v || 0);
    const outros = Number((E[mes] || {}).v || 0);
    return {
      mes, cobrancas, atendimentos, produtos, outros,
      total: +(cobrancas + atendimentos + produtos + outros).toFixed(2),
      saidas: Number((S[mes] || {}).v || 0),
      qtd_atendimentos: (K[mes] || {}).n || 0,
      comissoes: Number((K[mes] || {}).com || 0),
    };
  });
}

// resultado de cada profissional num mês (atendimentos concluídos + produtos vendidos)
async function porProfissional(mes) {
  const de = mes + '-01';
  const [y, m] = mes.split('-').map(Number);
  const fimEx = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const { rows: a } = await q(
    `SELECT p.id, p.nome, p.cor, COUNT(a.id)::int atendimentos, COALESCE(SUM(a.valor), 0) servicos, COALESCE(SUM(a.comissao_valor), 0) com,
            COUNT(DISTINCT COALESCE(a.cliente_id::text, a.telefone, a.cliente_nome))::int clientes
       FROM profissionais p LEFT JOIN agendamentos a ON a.profissional_id = p.id AND a.status = 'concluido'
        AND (a.inicio AT TIME ZONE '${TZ}')::date >= $1 AND (a.inicio AT TIME ZONE '${TZ}')::date < $2
      GROUP BY p.id ORDER BY p.ordem, p.nome`, [de, fimEx]);
  const { rows: v } = await q(
    `SELECT profissional_id id, COALESCE(SUM(valor_total), 0) produtos, COALESCE(SUM(comissao_valor), 0) com
       FROM vendas WHERE data >= $1 AND data < $2 AND profissional_id IS NOT NULL GROUP BY 1`, [de, fimEx]);
  const { rows: f } = await q(
    `SELECT profissional_id id, COUNT(*)::int n FROM agendamentos WHERE status = 'faltou'
        AND (inicio AT TIME ZONE '${TZ}')::date >= $1 AND (inicio AT TIME ZONE '${TZ}')::date < $2 GROUP BY 1`, [de, fimEx]);
  const V = Object.fromEntries(v.map((r) => [r.id, r]));
  const F = Object.fromEntries(f.map((r) => [r.id, r.n]));
  return a.map((r) => {
    const prod = Number((V[r.id] || {}).produtos || 0);
    const com = Number(r.com) + Number((V[r.id] || {}).com || 0);
    const fat = Number(r.servicos) + prod;
    return { id: r.id, nome: r.nome, cor: r.cor, atendimentos: r.atendimentos, clientes: r.clientes, servicos: Number(r.servicos), produtos: prod,
      faturamento: +fat.toFixed(2), comissao: +com.toFixed(2), ticket: r.atendimentos ? +(Number(r.servicos) / r.atendimentos).toFixed(2) : 0, faltas: F[r.id] || 0 };
  }).filter((r) => r.atendimentos || r.produtos || r.faltas);
}

function rotas(app, { rota, pode }) {
  app.get('/api/relatorios/mensal', pode('financeiro'), rota(async (req, res) => {
    const n = Math.min(24, Math.max(3, parseInt(req.query.meses, 10) || 12));
    const ate = /^\d{4}-\d{2}$/.test(req.query.ate || '') ? req.query.ate : U.hoje().slice(0, 7);
    res.json({ meses: await mensal(n, ate), ate });
  }));
  app.get('/api/relatorios/profissionais', pode('financeiro'), rota(async (req, res) => {
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : U.hoje().slice(0, 7);
    if (!mes) throw erro(400, 'Mês inválido');
    res.json({ mes, profissionais: await porProfissional(mes) });
  }));
}

module.exports = { rotas, mensal, porProfissional };
