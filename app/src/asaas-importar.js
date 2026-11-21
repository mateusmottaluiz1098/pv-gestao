// Importa clientes e cobranças que já existem no Asaas para o PV Gestão.
// - Carnê ativo (parcelamento) vira carnê no PV, com as parcelas até o mês final escolhido (padrão: dez/2027).
//   As parcelas que já existem no Asaas entram ligadas aos boletos de lá (baixa automática continua).
// - Outras cobranças: abertas entram como avulsas; pagas entram como histórico (últimos N meses).
// - Nada é cancelado no Asaas. Quem já foi importado é pulado (pode rodar de novo sem duplicar).
const { q } = require('./db');
const U = require('./util');
const A = require('./asaas');

const PAGO = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];
const ABERTO = ['PENDING', 'OVERDUE'];
const FORMA_PG = { PIX: 'pix', BOLETO: 'boleto', CREDIT_CARD: 'cartao', DEBIT_CARD: 'cartao', UNDEFINED: 'pix' };

async function todos(caminho, ci) {
  const itens = [];
  for (let offset = 0; offset < 20000; offset += 100) {
    const sep = caminho.includes('?') ? '&' : '?';
    const r = await A.chamar('GET', `${caminho}${sep}limit=100&offset=${offset}`, null, ci);
    itens.push(...(r.data || []));
    if (!r.hasMore) break;
  }
  return itens;
}

const idxMes = (iso) => { const [y, m] = iso.split('-').map(Number); return y * 12 + (m - 1); };
const competenciaDe = (idx) => `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}-01`;
const moda = (arr) => {
  const c = new Map(); let melhor = null; let n = 0;
  for (const v of arr) { const k = c.get(v) + 1 || 1; c.set(v, k); if (k > n || (k === n && v > melhor)) { n = k; melhor = v; } }
  return melhor;
};

// Lê tudo do Asaas e monta o plano (não grava nada)
async function analisar({ ateMes = '2027-12', mesesHistorico = 12 } = {}) {
  const ci = await A.conta();
  if (!ci.chave) throw new A.ErroAsaas('Cadastre a chave do Asaas em Configurações antes de importar.', 400);
  const [clientes, pagamentos] = await Promise.all([todos('/customers', ci), todos('/payments', ci)]);
  const { rows: ja } = await q('SELECT asaas_cliente_id FROM clientes WHERE asaas_cliente_id IS NOT NULL');
  const jaImportados = new Set(ja.map((r) => r.asaas_cliente_id));
  const { rows: jaCob } = await q('SELECT asaas_id FROM cobrancas WHERE asaas_id IS NOT NULL');
  const jaCobs = new Set(jaCob.map((r) => r.asaas_id));
  const hoje = U.hoje();
  const corteHist = mesesHistorico == null ? '0000-00-00' : U.somarDias(hoje, -Math.round(mesesHistorico * 30.5));
  const limiteIdx = idxMes(`${ateMes}-01`);

  const porCliente = new Map();
  for (const p of pagamentos) {
    if (p.deleted) continue;
    if (!porCliente.has(p.customer)) porCliente.set(p.customer, []);
    porCliente.get(p.customer).push(p);
  }

  const plano = [];
  for (const c of clientes) {
    if (c.deleted) continue;
    const pgs = (porCliente.get(c.id) || []).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    let fone = U.normalizarTelefone(c.mobilePhone || c.phone || '');
    if (fone && !fone.startsWith('55')) fone = '55' + fone;
    const item = {
      asaas_id: c.id, nome: c.name, cpf_cnpj: A.soDigitos(c.cpfCnpj) || null, telefone: U.telefoneValido(fone) ? fone : '',
      endereco: [c.address, c.addressNumber, c.complement, c.province, c.cityName || c.city].filter((x) => x && typeof x === 'string').join(', ') || null,
      ja_importado: jaImportados.has(c.id), avisos: [], carne: null, avulsas: [],
    };
    if (!item.telefone) item.avisos.push('sem WhatsApp válido');
    if (item.cpf_cnpj && !A.docValido(item.cpf_cnpj)) { item.avisos.push('CPF/CNPJ inválido'); item.cpf_cnpj = null; }

    // carnês = pagamentos agrupados pelo parcelamento; o ativo é o que tem parcela em aberto (ou o mais recente)
    const grupos = new Map();
    for (const p of pgs) if (p.installment) {
      if (!grupos.has(p.installment)) grupos.set(p.installment, []);
      grupos.get(p.installment).push(p);
    }
    const lista = [...grupos.values()].map((g) => ({ g, aberto: g.some((p) => ABERTO.includes(p.status)), ultimo: g[g.length - 1].dueDate }));
    lista.sort((a, b) => (b.aberto - a.aberto) || b.ultimo.localeCompare(a.ultimo));
    const ativo = lista.length && lista[0].aberto ? lista[0].g : null;
    if (lista.filter((x) => x.aberto).length > 1) item.avisos.push('mais de um carnê em aberto: o mais recente vira carnê, o outro entra como avulso');

    if (ativo) {
      const num = (p) => Number(p.installmentNumber) || (ativo.indexOf(p) + 1);
      ativo.sort((a, b) => num(a) - num(b) || a.dueDate.localeCompare(b.dueDate));
      const primeiro = ativo[0].dueDate;
      const baseIdx = idxMes(primeiro) - (num(ativo[0]) - 1);
      const qtdAsaas = Math.max(...ativo.map(num));
      const valor = moda(ativo.map((p) => Number(p.value)));
      const dia = moda(ativo.filter((p) => ABERTO.includes(p.status)).map((p) => Number(p.dueDate.slice(8, 10)))) || Number(primeiro.slice(8, 10));
      const total = Math.max(qtdAsaas, limiteIdx - baseIdx + 1);
      item.carne = {
        valor, dia, primeiro_vencimento: num(ativo[0]) === 1 ? primeiro : U.vencimentoNoMes(Math.floor(baseIdx / 12), (baseIdx % 12) + 1, dia),
        base_idx: baseIdx, parcelas_asaas: qtdAsaas, parcelas_total: total,
        pagas: ativo.filter((p) => PAGO.includes(p.status)).length, abertas: ativo.filter((p) => ABERTO.includes(p.status)).length,
        ultima_asaas: ativo[ativo.length - 1].dueDate, ate: competenciaDe(baseIdx + total - 1).slice(0, 7),
        descricao: ativo[0].description || null,
        parcelas: ativo.filter((p) => !jaCobs.has(p.id)).map((p) => ({ n: num(p), p })),
      };
    }
    // o resto: abertas sempre; pagas só dentro do histórico
    for (const p of pgs) {
      if (ativo && p.installment === ativo[0].installment) continue;
      if (jaCobs.has(p.id)) continue;
      if (ABERTO.includes(p.status) || (PAGO.includes(p.status) && (p.paymentDate || p.clientPaymentDate || p.dueDate) >= corteHist)) item.avulsas.push(p);
    }
    plano.push(item);
  }
  const novos = plano.filter((x) => !x.ja_importado);
  return {
    ambiente: ci.ambiente, ate_mes: ateMes,
    resumo: {
      clientes: plano.length, novos: novos.length, ja_importados: plano.length - novos.length,
      com_carne: novos.filter((x) => x.carne).length,
      parcelas_asaas: novos.reduce((t, x) => t + (x.carne ? x.carne.parcelas.length : 0), 0),
      avulsas_abertas: novos.reduce((t, x) => t + x.avulsas.filter((p) => ABERTO.includes(p.status)).length, 0),
      historico_pagas: novos.reduce((t, x) => t + x.avulsas.filter((p) => PAGO.includes(p.status)).length, 0),
      com_aviso: novos.filter((x) => x.avisos.length).length,
    },
    plano,
  };
}

// versão para a tela (sem os objetos brutos do Asaas)
function resumoParaTela(a) {
  return {
    ...a,
    plano: a.plano.map((x) => ({
      asaas_id: x.asaas_id, nome: x.nome, cpf_cnpj: x.cpf_cnpj, telefone: x.telefone, ja_importado: x.ja_importado, avisos: x.avisos,
      carne: x.carne && { valor: x.carne.valor, dia: x.carne.dia, pagas: x.carne.pagas, abertas: x.carne.abertas, parcelas_asaas: x.carne.parcelas_asaas,
        parcelas_total: x.carne.parcelas_total, ultima_asaas: x.carne.ultima_asaas, ate: x.carne.ate },
      avulsas_abertas: x.avulsas.filter((p) => ABERTO.includes(p.status)).length,
      avulsas_pagas: x.avulsas.filter((p) => PAGO.includes(p.status)).length,
    })),
  };
}

function camposPagamento(p) {
  if (PAGO.includes(p.status)) {
    return {
      status: 'pago', pago_em: String(p.clientPaymentDate || p.paymentDate || p.confirmedDate || p.dueDate).slice(0, 10),
      pago_valor: Number(p.value), forma_pagamento: p.status === 'RECEIVED_IN_CASH' ? 'dinheiro' : (FORMA_PG[p.billingType] || 'pix'),
      pago_por: 'Asaas (importado)', asaas_status: 'pago',
    };
  }
  return { status: 'aberto', pago_em: null, pago_valor: null, forma_pagamento: null, pago_por: null, asaas_status: 'pendente' };
}

async function gravarCobranca(clienteId, p, { tipo, competencia, numero, descricao }) {
  const f = camposPagamento(p);
  const { rows } = await q(
    `INSERT INTO cobrancas (cliente_id, competencia, numero_parcela, vencimento, valor, tipo, descricao, status, pago_em, pago_valor, forma_pagamento, pago_por,
       asaas_id, asaas_valor, asaas_venc, asaas_link, asaas_status, obs)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (cliente_id, competencia) WHERE tipo = 'recorrente' DO NOTHING RETURNING id`,
    [clienteId, competencia, numero, p.dueDate, Number(p.value), tipo, descricao, f.status, f.pago_em, f.pago_valor, f.forma_pagamento, f.pago_por,
      p.id, Number(p.value), p.dueDate, p.invoiceUrl || null, f.asaas_status, 'Importado do Asaas']);
  return rows.length;
}

// Grava no PV Gestão o que a análise encontrou
async function importar({ ateMes = '2027-12', mesesHistorico = 12, desligarAvisos = true, somente = null } = {}) {
  const a = await analisar({ ateMes, mesesHistorico });
  const ci = await A.conta();
  const C = require('./cobrancas');
  const hoje = U.hoje();
  const r = { clientes: 0, carnes: 0, parcelas: 0, avulsas: 0, pagas: 0, avisos_desligados: 0, erros: [] };
  for (const x of a.plano) {
    if (x.ja_importado) continue;
    if (somente && !somente.includes(x.asaas_id)) continue;
    try {
      // cliente (se já existir com o mesmo CPF/CNPJ, só liga ao Asaas)
      let cli = null;
      if (x.cpf_cnpj) cli = (await q('SELECT * FROM clientes WHERE cpf_cnpj=$1 AND asaas_cliente_id IS NULL LIMIT 1', [x.cpf_cnpj])).rows[0];
      const k = x.carne;
      if (cli) {
        await q('UPDATE clientes SET asaas_cliente_id=$1 WHERE id=$2', [x.asaas_id, cli.id]);
      } else {
        const obs = ['Importado do Asaas'].concat(x.avisos.length ? [`Conferir: ${x.avisos.join('; ')}`] : []).join('. ');
        cli = (await q(
          `INSERT INTO clientes (nome, telefone, valor, forma, dia_vencimento, primeiro_vencimento, parcelas_total, endereco, observacoes, cpf_cnpj, pix_asaas, asaas_cliente_id, ativo)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,$11,TRUE) RETURNING *`,
          [x.nome, x.telefone || '', k ? k.valor : 0, k ? 'carne' : 'avulso', k ? k.dia : 1, k ? k.primeiro_vencimento : hoje,
            k ? k.parcelas_total : null, x.endereco, obs, x.cpf_cnpj, x.asaas_id])).rows[0];
        r.clientes++;
      }
      // parcelas do carnê que já existem no Asaas (as que faltarem no meio ficam canceladas para o PV não gerar de novo)
      if (k && cli.forma !== 'carne') {
        // cliente já existia no PV com outra forma: as parcelas entram como avulsas
        for (const { n, p } of k.parcelas) {
          const desc = `${k.descricao || 'Carnê'} (${n}/${k.parcelas_asaas})`.slice(0, 120);
          if (await gravarCobranca(cli.id, p, { tipo: 'avulsa', competencia: p.dueDate, numero: null, descricao: desc })) {
            if (PAGO.includes(p.status)) r.pagas++; else r.avulsas++;
          }
        }
      }
      if (k && cli.forma === 'carne') {
        r.carnes++;
        const tem = new Set();
        for (const { n, p } of k.parcelas) {
          tem.add(n);
          const ok = await gravarCobranca(cli.id, p, { tipo: 'recorrente', competencia: competenciaDe(k.base_idx + n - 1), numero: n, descricao: null });
          if (ok) { r.parcelas++; if (PAGO.includes(p.status)) r.pagas++; }
        }
        for (let n = 1; n <= k.parcelas_asaas; n++) {
          if (tem.has(n)) continue;
          const comp = competenciaDe(k.base_idx + n - 1);
          await q(`INSERT INTO cobrancas (cliente_id, competencia, numero_parcela, vencimento, valor, tipo, status, obs)
                   VALUES ($1,$2,$3,$4,$5,'recorrente','cancelado','Parcela que não existe mais no Asaas') ON CONFLICT (cliente_id, competencia) WHERE tipo='recorrente' DO NOTHING`,
          [cli.id, comp, n, U.vencimentoNoMes(Math.floor((k.base_idx + n - 1) / 12), ((k.base_idx + n - 1) % 12) + 1, k.dia), k.valor]);
        }
      }
      for (const p of x.avulsas) {
        const desc = (p.description || (p.installment ? `Parcela ${p.installmentNumber || ''} (carnê anterior)` : 'Cobrança do Asaas')).slice(0, 120);
        if (await gravarCobranca(cli.id, p, { tipo: 'avulsa', competencia: p.dueDate, numero: null, descricao: desc })) {
          if (PAGO.includes(p.status)) r.pagas++; else r.avulsas++;
        }
      }
      // os meses do carnê depois do último boleto do Asaas: o PV gera (até o mês que vem; o resto vai saindo sozinho)
      if (cli.forma === 'carne') await C.gerarCobrancas(cli.id);
      // só a régua do PV avisa
      if (desligarAvisos) {
        try { await A.chamar('PUT', `/customers/${x.asaas_id}`, { notificationDisabled: true }, ci); r.avisos_desligados++; } catch (e) { r.erros.push(`${x.nome}: não desliguei os avisos do Asaas (${e.message})`); }
      }
    } catch (e) {
      r.erros.push(`${x.nome}: ${e.message}`);
    }
  }
  return r;
}

module.exports = { analisar, importar, resumoParaTela };
