const { q } = require('./db');
const cfg = require('./config');
const wa = require('./whatsapp');
const { gerarPix, qrDataUrl } = require('./pix');
const U = require('./util');

// ---------- Geração das cobranças mensais ----------

async function gerarCobrancas(clienteId = null) {
  const params = [];
  let filtro = 'WHERE ativo';
  if (clienteId) { params.push(clienteId); filtro += ' AND id = $1'; }
  const { rows: clientes } = await q(`SELECT * FROM clientes ${filtro}`, params);
  const hoje = U.hoje();
  const [hy, hm] = hoje.split('-').map(Number);
  // gera até o mês seguinte ao atual
  const limiteIdx = hy * 12 + hm; // (mês seguinte, base 0) = hy*12 + (hm-1) + 1
  let criadas = 0;
  for (const c of clientes) {
    const [py, pm] = c.primeiro_vencimento.split('-').map(Number);
    let idx = py * 12 + (pm - 1);
    let n = 1;
    while (idx <= limiteIdx) {
      if (c.forma === 'carne' && c.parcelas_total && n > c.parcelas_total) break;
      const y = Math.floor(idx / 12);
      const m = (idx % 12) + 1;
      const competencia = `${y}-${String(m).padStart(2, '0')}-01`;
      const venc = n === 1 ? c.primeiro_vencimento : U.vencimentoNoMes(y, m, c.dia_vencimento);
      const r = await q(
        `INSERT INTO cobrancas (cliente_id, competencia, numero_parcela, vencimento, valor)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (cliente_id, competencia) DO NOTHING`,
        [c.id, competencia, c.forma === 'carne' ? n : null, venc, c.valor]
      );
      criadas += r.rowCount;
      idx++; n++;
    }
  }
  return criadas;
}

// Ao editar cliente, atualiza cobranças futuras em aberto
async function ajustarCobrancasFuturas(cliente) {
  const hoje = U.hoje();
  const { rows } = await q(
    "SELECT id, competencia, numero_parcela FROM cobrancas WHERE cliente_id = $1 AND status = 'aberto' AND vencimento >= $2",
    [cliente.id, hoje]
  );
  for (const r of rows) {
    const [y, m] = r.competencia.split('-').map(Number);
    const venc = U.vencimentoNoMes(y, m, cliente.dia_vencimento);
    await q('UPDATE cobrancas SET valor = $1, vencimento = $2 WHERE id = $3', [cliente.valor, venc, r.id]);
  }
  if (cliente.forma === 'carne' && cliente.parcelas_total) {
    await q(
      "DELETE FROM cobrancas WHERE cliente_id = $1 AND status = 'aberto' AND numero_parcela > $2",
      [cliente.id, cliente.parcelas_total]
    );
  }
}

// ---------- Mensagens ----------

function primeiroNome(nome) {
  return String(nome || '').trim().split(/\s+/)[0] || '';
}

async function totalEmAberto(clienteId) {
  const { rows } = await q(
    "SELECT COALESCE(SUM(valor),0) AS total, COUNT(*)::int AS qtd FROM cobrancas WHERE cliente_id = $1 AND status = 'aberto' AND vencimento <= $2",
    [clienteId, U.somarDias(U.hoje(), 5)]
  );
  return rows[0];
}

async function renderizar(modelo, cliente, cobranca, extra = {}) {
  const c = await cfg.obter();
  const hoje = U.hoje();
  const atraso = cobranca ? Math.max(0, U.diffDias(hoje, cobranca.vencimento)) : 0;
  const ab = await totalEmAberto(cliente.id);
  let parcela = '';
  if (cobranca && cobranca.numero_parcela) {
    parcela = cliente.parcelas_total ? `${cobranca.numero_parcela}/${cliente.parcelas_total}` : String(cobranca.numero_parcela);
  }
  const vars = {
    nome: cliente.nome,
    primeiro_nome: primeiroNome(cliente.nome),
    valor: cobranca ? U.brl(extra.valor ?? cobranca.valor) : '',
    vencimento: cobranca ? U.brData(cobranca.vencimento) : '',
    dias_atraso: String(atraso),
    pix: c.pix_chave || '',
    empresa: c.empresa || '',
    parcela,
    mes: cobranca ? U.nomeMes(cobranca.competencia) : '',
    total_aberto: U.brl(ab.total),
    qtd_aberto: String(ab.qtd),
  };
  return String(modelo || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

async function pixDaCobranca(cobranca, cliente) {
  const c = await cfg.obter();
  if (!c.pix_chave) return null;
  const codigo = gerarPix({
    tipoChave: c.pix_tipo,
    chave: c.pix_chave,
    nome: c.pix_nome || c.empresa,
    cidade: c.pix_cidade,
    valor: cobranca.valor,
    txid: `C${cobranca.id}`,
  });
  return { codigo, qr: await qrDataUrl(codigo), cliente: cliente && cliente.nome };
}

async function registrar(msg) {
  const { rows } = await q(
    `INSERT INTO mensagens (cliente_id, cobranca_id, direcao, etapa, telefone, texto, status, erro)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [msg.cliente_id || null, msg.cobranca_id || null, msg.direcao, msg.etapa || null, msg.telefone || null, msg.texto || null, msg.status, msg.erro || null]
  );
  return rows[0].id;
}

// Envia a mensagem de cobrança (texto + Pix)
async function enviarCobranca(cobranca, cliente, etapa) {
  const c = await cfg.obter();
  const numero = U.normalizarTelefone(cliente.telefone);
  const texto = await renderizar(etapa.modelo, cliente, cobranca);
  try {
    if (!U.telefoneValido(numero)) throw new Error('Telefone inválido');
    await wa.enviarTexto(numero, texto);
    const pix = await pixDaCobranca(cobranca, cliente);
    if (pix) {
      if (c.enviar_qr_code) {
        await wa.enviarImagem(numero, pix.qr, 'QR Code Pix');
      }
      if (c.enviar_pix_copia_cola) {
        await wa.enviarTexto(numero, pix.codigo);
      }
    }
    await registrar({ cliente_id: cliente.id, cobranca_id: cobranca.id, direcao: 'saida', etapa: etapa.id, telefone: numero, texto, status: 'enviado' });
    return { ok: true };
  } catch (e) {
    await registrar({ cliente_id: cliente.id, cobranca_id: cobranca.id, direcao: 'saida', etapa: etapa.id, telefone: numero, texto, status: 'erro', erro: e.message });
    return { ok: false, erro: e.message };
  }
}

// ---------- Régua / fila do dia ----------

async function montarFila(dataRef = U.hoje()) {
  const c = await cfg.obter();
  const etapas = (c.regua || []).filter((e) => e.ativo).sort((a, b) => a.dias - b.dias);
  if (!etapas.length) return [];
  const menorDias = etapas[0].dias; // ex.: -2
  const limiteVenc = U.somarDias(dataRef, -menorDias);
  const { rows } = await q(
    `SELECT cb.*, cl.nome, cl.telefone, cl.parcelas_total, cl.forma
       FROM cobrancas cb JOIN clientes cl ON cl.id = cb.cliente_id
      WHERE cb.status = 'aberto' AND cl.ativo AND NOT cl.pausado AND cb.vencimento <= $1
      ORDER BY cb.vencimento, cb.id`,
    [limiteVenc]
  );
  const { rows: enviados } = await q(
    "SELECT cobranca_id, etapa FROM mensagens WHERE direcao = 'saida' AND status = 'enviado' AND cobranca_id = ANY($1)",
    [rows.map((r) => r.id)]
  );
  const jaFoi = new Set(enviados.map((e) => `${e.cobranca_id}:${e.etapa}`));
  const { rows: hojeRows } = await q(
    "SELECT DISTINCT cliente_id FROM mensagens WHERE direcao = 'saida' AND status = 'enviado' AND etapa NOT IN ('agradecimento','resposta_comprovante','teste') AND (criado_em AT TIME ZONE 'America/Sao_Paulo')::date = $1",
    [dataRef]
  );
  const clienteHoje = new Set(hojeRows.map((r) => r.cliente_id));

  const fila = [];
  const clientesNaFila = new Set();
  for (const cb of rows) {
    if (clientesNaFila.has(cb.cliente_id) || clienteHoje.has(cb.cliente_id)) continue;
    const diff = U.diffDias(dataRef, cb.vencimento); // >0 = atrasado
    const elegiveis = etapas.filter((e) => e.dias <= diff);
    if (!elegiveis.length) continue;
    const etapa = elegiveis[elegiveis.length - 1];
    if (diff - etapa.dias > Number(c.tolerancia_dias ?? 3)) continue; // janela da etapa passou
    if (jaFoi.has(`${cb.id}:${etapa.id}`)) continue;
    fila.push({
      cobranca_id: cb.id, cliente_id: cb.cliente_id, nome: cb.nome, telefone: cb.telefone,
      valor: cb.valor, vencimento: cb.vencimento, dias: diff, etapa: etapa.id, etapa_dias: etapa.dias,
    });
    clientesNaFila.add(cb.cliente_id);
  }
  return fila;
}

function nomeEtapa(dias) {
  if (dias < 0) return `${-dias} dia(s) antes`;
  if (dias === 0) return 'No vencimento';
  return `${dias} dia(s) após`;
}

// Execução em segundo plano
const execucao = { rodando: false, parar: false, total: 0, feitos: 0, enviados: 0, erros: 0, atual: null, inicio: null, fim: null, ultimoErro: null, origem: null };

function dentroDaJanela(c) {
  const h = U.horaAgora();
  return h >= (c.janela_inicio || '08:00') && h <= (c.janela_fim || '20:00');
}

async function executarFila(origem = 'manual') {
  if (execucao.rodando) return { ok: false, erro: 'A fila já está em andamento.' };
  const c = await cfg.obter();
  const st = await wa.estado();
  if (!st.conectado) return { ok: false, erro: 'WhatsApp não está conectado.' };
  await gerarCobrancas();
  const fila = await montarFila();
  const { rows } = await q(
    "SELECT COUNT(*)::int AS n FROM mensagens WHERE direcao='saida' AND status='enviado' AND (criado_em AT TIME ZONE 'America/Sao_Paulo')::date = $1",
    [U.hoje()]
  );
  const restante = Math.max(0, Number(c.limite_diario || 60) - rows[0].n);
  const lote = fila.slice(0, restante);
  Object.assign(execucao, { rodando: true, parar: false, total: lote.length, feitos: 0, enviados: 0, erros: 0, atual: null, inicio: new Date().toISOString(), fim: null, ultimoErro: null, origem });
  rodarLote(lote, c).catch((e) => { execucao.ultimoErro = e.message; }).finally(() => {
    execucao.rodando = false; execucao.atual = null; execucao.fim = new Date().toISOString();
  });
  return { ok: true, total: lote.length, foraDoLimite: fila.length - lote.length };
}

async function rodarLote(lote, c) {
  const etapas = Object.fromEntries((c.regua || []).map((e) => [e.id, e]));
  for (let i = 0; i < lote.length; i++) {
    if (execucao.parar) break;
    const item = lote[i];
    execucao.atual = item.nome;
    const { rows: cb } = await q('SELECT * FROM cobrancas WHERE id = $1', [item.cobranca_id]);
    const { rows: cl } = await q('SELECT * FROM clientes WHERE id = $1', [item.cliente_id]);
    if (cb[0] && cl[0] && cb[0].status === 'aberto') {
      const r = await enviarCobranca(cb[0], cl[0], etapas[item.etapa]);
      if (r.ok) execucao.enviados++; else { execucao.erros++; execucao.ultimoErro = `${item.nome}: ${r.erro}`; }
    }
    execucao.feitos++;
    if (i < lote.length - 1 && !execucao.parar) {
      const espera = U.aleatorio(Number(c.intervalo_min || 25), Number(c.intervalo_max || 70)) * 1000;
      const fimEspera = Date.now() + espera;
      while (Date.now() < fimEspera && !execucao.parar) await new Promise((r) => setTimeout(r, 500));
    }
  }
}

function pararFila() {
  if (execucao.rodando) execucao.parar = true;
}

// Agendador: verifica a cada minuto se é hora de rodar
async function tick() {
  try {
    const c = await cfg.obter();
    await gerarCobrancas();
    if (!c.envio_automatico || execucao.rodando) return;
    const hoje = U.hoje();
    const ultima = await cfg.ultimaExecucao();
    if (ultima === hoje) return;
    if (U.horaAgora() < (c.hora_envio || '09:00')) return;
    if (!dentroDaJanela(c)) return;
    const r = await executarFila('automatico');
    if (r.ok) {
      await cfg.marcarExecucao(hoje);
      console.log(`[régua] ${hoje}: ${r.total} mensagem(ns) na fila`);
    } else {
      console.log('[régua] não executou:', r.erro);
    }
  } catch (e) {
    console.error('[agendador]', e.message);
  }
}

function iniciarAgendador() {
  setTimeout(tick, 15000);
  setInterval(tick, 60000);
}

// ---------- Pagamentos ----------

async function marcarPago(id, { data, valor, forma, obs, agradecer, por }) {
  const { rows } = await q('SELECT * FROM cobrancas WHERE id = $1', [id]);
  const cb = rows[0];
  if (!cb) throw new Error('Cobrança não encontrada');
  const dataPg = data || U.hoje();
  const valorPg = valor != null && valor !== '' ? Number(valor) : cb.valor;
  await q(
    "UPDATE cobrancas SET status='pago', pago_em=$1, pago_valor=$2, forma_pagamento=$3, obs=COALESCE($4, obs), pago_por=$6 WHERE id=$5",
    [dataPg, valorPg, forma || 'pix', obs || null, id, por || null]
  );
  const c = await cfg.obter();
  const deveAgradecer = agradecer === undefined ? c.agradecer_pagamento : agradecer;
  if (deveAgradecer) {
    const { rows: cl } = await q('SELECT * FROM clientes WHERE id = $1', [cb.cliente_id]);
    const st = await wa.estado();
    if (st.conectado && cl[0]) {
      const numero = U.normalizarTelefone(cl[0].telefone);
      const texto = await renderizar(c.modelo_agradecimento, cl[0], { ...cb, status: 'pago' }, { valor: valorPg });
      try {
        await wa.enviarTexto(numero, texto);
        await registrar({ cliente_id: cb.cliente_id, cobranca_id: cb.id, direcao: 'saida', etapa: 'agradecimento', telefone: numero, texto, status: 'enviado' });
      } catch (e) {
        await registrar({ cliente_id: cb.cliente_id, cobranca_id: cb.id, direcao: 'saida', etapa: 'agradecimento', telefone: numero, texto, status: 'erro', erro: e.message });
      }
    }
  }
}

module.exports = {
  gerarCobrancas, ajustarCobrancasFuturas, renderizar, pixDaCobranca, enviarCobranca, registrar,
  montarFila, executarFila, pararFila, execucao, iniciarAgendador, marcarPago, nomeEtapa, primeiroNome,
};
