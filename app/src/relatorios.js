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

// ---------- Previsão de recebimentos do mês ----------
// Junta as cobranças que já existem com vencimento no mês e projeta as que o sistema ainda vai gerar
// (parcelas de carnê e mensalidades: o gerador só cria até o mês seguinte).
const PASSO = { semanal: 7, quinzenal: 14 };
const idxMes = (iso) => { const [y, m] = iso.split('-').map(Number); return y * 12 + (m - 1); };

async function previsao(mes) {
  const cfg = require('./config');
  const c = await cfg.obter();
  const hoje = U.hoje();
  const ini = `${mes}-01`;
  const [y, m] = mes.split('-').map(Number);
  const fim = U.vencimentoNoMes(y, m, 31);
  const asaasLigado = !!(c.asaas_ativo && c.asaas_chave);
  const { rows: reais } = await q(`
    SELECT cb.id, cb.cliente_id, cb.vencimento, cb.valor, cb.status, cb.pago_em, cb.pago_valor, cb.tipo, cb.numero_parcela, cb.descricao,
           cb.competencia, cb.pix_modo, cb.asaas_id, cb.pago_por, cl.nome, cl.forma, cl.parcelas_total, cl.pix_asaas
      FROM cobrancas cb JOIN clientes cl ON cl.id = cb.cliente_id
     WHERE cb.vencimento BETWEEN $1 AND $2 AND cb.status <> 'cancelado'
     ORDER BY cb.vencimento, cl.nome`, [ini, fim]);
  // competências que já têm cobrança recorrente (de qualquer situação) para não projetar de novo
  const { rows: ocup } = await q(`SELECT cliente_id, competencia FROM cobrancas WHERE tipo = 'recorrente' AND competencia BETWEEN $1 AND $2`,
    [U.somarDias(ini, -1), fim]);
  const tem = new Set(ocup.map((r) => `${r.cliente_id}:${r.competencia}`));
  const { rows: clientes } = await q(`SELECT * FROM clientes WHERE ativo AND forma IN ('mensal','carne','semanal','quinzenal')`);

  const categoria = (forma, tipo) => (tipo === 'avulsa' ? 'avulsa' : forma === 'carne' ? 'carne' : 'mensalidade');
  const pixDe = (pixModo, clientePix) => (!asaasLigado ? null : (pixModo || (clientePix === false ? 'direto' : 'asaas')));
  const itens = reais.map((r) => {
    const sit = r.status === 'pago' ? 'pago' : r.vencimento < hoje ? 'atrasado' : 'a_receber';
    let ref = r.descricao || (r.numero_parcela ? `Parcela ${r.numero_parcela}${r.parcelas_total ? '/' + r.parcelas_total : ''}` : r.tipo === 'avulsa' ? 'Avulsa' : `Mensalidade ${U.nomeMes(r.competencia)}`);
    if (r.tipo !== 'avulsa' && r.forma === 'carne' && r.numero_parcela && !r.descricao) ref = `Carnê · parcela ${r.numero_parcela}${r.parcelas_total ? '/' + r.parcelas_total : ''}`;
    return {
      id: r.id, cliente_id: r.cliente_id, nome: r.nome, vencimento: r.vencimento, valor: Number(r.valor), referente: ref,
      categoria: categoria(r.forma, r.tipo), situacao: sit, pago_em: r.pago_em, pago_valor: r.pago_valor != null ? Number(r.pago_valor) : null,
      pix: pixDe(r.pix_modo, r.pix_asaas), asaas: !!r.asaas_id, projetado: false,
    };
  });
  // projeção do que ainda não foi gerado
  const mIdx = y * 12 + (m - 1);
  for (const cl of clientes) {
    if (!cl.primeiro_vencimento) continue;
    const passo = PASSO[cl.forma];
    const add = (venc, n) => itens.push({
      id: null, cliente_id: cl.id, nome: cl.nome, vencimento: venc, valor: Number(cl.valor),
      referente: cl.forma === 'carne' ? `Carnê · parcela ${n}${cl.parcelas_total ? '/' + cl.parcelas_total : ''}` : `Mensalidade ${U.nomeMes(`${mes}-01`)}`,
      categoria: cl.forma === 'carne' ? 'carne' : 'mensalidade', situacao: venc < hoje ? 'atrasado' : 'previsto', pago_em: null, pago_valor: null,
      pix: pixDe(null, cl.pix_asaas), asaas: false, projetado: true,
    });
    if (passo) {
      let v = cl.primeiro_vencimento;
      if (v < ini) v = U.somarDias(v, Math.ceil(U.diffDias(ini, v) / passo) * passo);
      for (; v <= fim; v = U.somarDias(v, passo)) if (v >= hoje && !tem.has(`${cl.id}:${v}`)) add(v, null);
      continue;
    }
    const pIdx = idxMes(cl.primeiro_vencimento);
    if (mIdx < pIdx) continue;
    const n = mIdx - pIdx + 1;
    if (cl.forma === 'carne' && (!cl.parcelas_total || n > cl.parcelas_total)) continue;
    if (tem.has(`${cl.id}:${ini}`)) continue;
    const venc = n === 1 ? cl.primeiro_vencimento : U.vencimentoNoMes(y, m, cl.dia_vencimento);
    if (venc < hoje) continue; // mês passado que nunca foi gerado: não é previsão
    add(venc, n);
  }
  itens.sort((a, b) => a.vencimento.localeCompare(b.vencimento) || a.nome.localeCompare(b.nome));

  const soma = (f) => Math.round(itens.filter(f).reduce((t, i) => t + (i.situacao === 'pago' ? (i.pago_valor ?? i.valor) : i.valor), 0) * 100) / 100;
  const conta = (f) => itens.filter(f).length;
  const resumo = {
    previsto: soma(() => true), qtd: itens.length,
    recebido: soma((i) => i.situacao === 'pago'), qtd_recebido: conta((i) => i.situacao === 'pago'),
    a_receber: soma((i) => i.situacao === 'a_receber' || i.situacao === 'previsto'), qtd_a_receber: conta((i) => i.situacao === 'a_receber' || i.situacao === 'previsto'),
    atrasado: soma((i) => i.situacao === 'atrasado'), qtd_atrasado: conta((i) => i.situacao === 'atrasado'),
    projetado: soma((i) => i.projetado), qtd_projetado: conta((i) => i.projetado),
  };
  const porCategoria = ['carne', 'mensalidade', 'avulsa'].map((k) => ({
    categoria: k, total: soma((i) => i.categoria === k), qtd: conta((i) => i.categoria === k),
    recebido: soma((i) => i.categoria === k && i.situacao === 'pago'),
  })).filter((x) => x.qtd);
  const porPix = asaasLigado ? ['asaas', 'direto'].map((k) => ({ pix: k, total: soma((i) => i.pix === k), qtd: conta((i) => i.pix === k) })).filter((x) => x.qtd) : [];
  return { mes, hoje, resumo, por_categoria: porCategoria, por_pix: porPix, itens };
}

// previsto de cada um dos próximos meses (para o gráfico)
async function previsaoMeses(de, n) {
  const out = [];
  const [y, m] = de.split('-').map(Number);
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    const mes = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const p = await previsao(mes);
    out.push({ mes, total: p.resumo.previsto, recebido: p.resumo.recebido, qtd: p.resumo.qtd });
  }
  return out;
}

function rotas(app, { rota, pode }) {
  app.get('/api/relatorios/previsao', pode('financeiro'), rota(async (req, res) => {
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : U.hoje().slice(0, 7);
    res.json(await previsao(mes));
  }));
  app.get('/api/relatorios/previsao-meses', pode('financeiro'), rota(async (req, res) => {
    const de = /^\d{4}-\d{2}$/.test(req.query.de || '') ? req.query.de : U.hoje().slice(0, 7);
    const n = Math.min(18, Math.max(3, parseInt(req.query.meses, 10) || 12));
    res.json({ meses: await previsaoMeses(de, n) });
  }));
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

module.exports = { rotas, mensal, porProfissional, previsao, previsaoMeses };
