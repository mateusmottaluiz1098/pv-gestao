// Integração com o Asaas: Pix com baixa automática.
// - Cada negócio usa a própria conta Asaas (chave de API em Configurações).
// - A cobrança no Asaas é criada na hora de mandar o Pix (preguiçosa) e acompanha valor/vencimento.
// - A baixa vem pelo webhook do Asaas e, se ele não chegar, pela conferência a cada 5 minutos.
// - Cobrança paga por fora, cancelada ou apagada aqui é cancelada no Asaas (gatilho no banco + fila).
const crypto = require('crypto');
const { q } = require('./db');
const cfg = require('./config');
const U = require('./util');

const SCHEMA = `
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS cpf_cnpj TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS pix_asaas BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS asaas_cliente_id TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS asaas_dados TEXT;
ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS asaas_id TEXT;
ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS asaas_valor NUMERIC(12,2);
ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS asaas_venc DATE;
ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS asaas_status TEXT;
ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS asaas_link TEXT;
ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS asaas_pix TEXT;
ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS asaas_erro TEXT;
ALTER TABLE cobrancas ADD COLUMN IF NOT EXISTS asaas_conferido_em TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS cobrancas_asaas_idx ON cobrancas (asaas_id) WHERE asaas_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS asaas_eventos (
  id TEXT PRIMARY KEY,
  evento TEXT,
  pagamento TEXT,
  recebido_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS asaas_cancelar (
  asaas_id TEXT PRIMARY KEY,
  tentativas INT NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- cobrança que sai de "aberto" sem ter sido paga pelo Asaas (paga em dinheiro, cancelada) ou é apagada:
-- o Pix do Asaas é cancelado para o cliente não pagar duas vezes
CREATE OR REPLACE FUNCTION pv_asaas_cobranca() RETURNS trigger AS $f$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.asaas_id IS NOT NULL AND OLD.status = 'aberto' THEN
      INSERT INTO asaas_cancelar (asaas_id) VALUES (OLD.asaas_id) ON CONFLICT DO NOTHING;
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.asaas_id IS NOT NULL AND OLD.status = 'aberto' AND NEW.status <> 'aberto' AND NEW.asaas_status IS DISTINCT FROM 'pago' THEN
    INSERT INTO asaas_cancelar (asaas_id) VALUES (OLD.asaas_id) ON CONFLICT DO NOTHING;
    NEW.asaas_id := NULL; NEW.asaas_valor := NULL; NEW.asaas_venc := NULL; NEW.asaas_link := NULL; NEW.asaas_pix := NULL; NEW.asaas_status := NULL;
  END IF;
  RETURN NEW;
END
$f$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pv_asaas_cobranca ON cobrancas;
CREATE TRIGGER pv_asaas_cobranca BEFORE UPDATE OR DELETE ON cobrancas FOR EACH ROW EXECUTE FUNCTION pv_asaas_cobranca();
`;

async function iniciar() {
  await q(SCHEMA);
}

// ---------- Conta / chamadas à API ----------
const URLS = { producao: 'https://api.asaas.com/v3', sandbox: 'https://api-sandbox.asaas.com/v3' };
// a chave diz o ambiente: $aact_hmlg_ = teste (sandbox), $aact_prod_ = produção
const ambienteDaChave = (chave) => (/^\$?aact_hmlg_/.test(String(chave || '')) ? 'sandbox' : 'producao');

async function conta() {
  const c = await cfg.obter();
  const chave = String(c.asaas_chave || '').trim();
  return { c, chave, ligado: !!(c.asaas_ativo && chave), ambiente: ambienteDaChave(chave) };
}

class ErroAsaas extends Error {
  constructor(msg, status, codigo) { super(msg); this.status = status; this.codigo = codigo; }
}

async function chamar(metodo, caminho, corpo, contaInfo) {
  const { chave, ambiente } = contaInfo || (await conta());
  if (!chave) throw new ErroAsaas('Chave do Asaas não cadastrada', 400);
  let r;
  try {
    r = await fetch(URLS[ambiente] + caminho, {
      method: metodo,
      headers: { access_token: chave, 'Content-Type': 'application/json', 'User-Agent': 'PV-Gestao/1.0' },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new ErroAsaas('Asaas não respondeu (' + (e.name === 'TimeoutError' ? 'tempo esgotado' : e.message) + ')', 0);
  }
  const txt = await r.text();
  let dados = {};
  try { dados = txt ? JSON.parse(txt) : {}; } catch (e) { dados = { bruto: txt }; }
  if (!r.ok) {
    const er = (dados.errors && dados.errors[0]) || {};
    let msg = er.description || dados.message || `Erro ${r.status} no Asaas`;
    if (r.status === 401) msg = er.code === 'invalid_environment' ? 'Chave do Asaas é de outro ambiente (teste x produção)' : 'Chave do Asaas inválida';
    throw new ErroAsaas(msg, r.status, er.code);
  }
  return dados;
}

const soDigitos = (s) => String(s || '').replace(/\D/g, '');
function docValido(d) {
  d = soDigitos(d);
  if (d.length !== 11 && d.length !== 14) return false;
  if (/^(\d)\1+$/.test(d)) return false;
  if (d.length === 11) {
    for (const n of [9, 10]) {
      let s = 0;
      for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i);
      if (((s * 10) % 11) % 10 !== Number(d[n])) return false;
    }
    return true;
  }
  const calc = (n) => {
    const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const s = pesos.reduce((t, p, i) => t + Number(d[i]) * p, 0);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

// ---------- Cliente no Asaas ----------
async function garantirCliente(cliente, ci) {
  const doc = soDigitos(cliente.cpf_cnpj);
  let fone = U.normalizarTelefone(cliente.telefone);
  if (fone.startsWith('55')) fone = fone.slice(2);
  const dados = { name: cliente.nome, cpfCnpj: doc, mobilePhone: fone, externalReference: `pv-cli:${cliente.id}`, notificationDisabled: true };
  const assinatura = [dados.name, dados.cpfCnpj, dados.mobilePhone].join('|');
  if (cliente.asaas_cliente_id) {
    if (cliente.asaas_dados !== assinatura) {
      try {
        await chamar('PUT', `/customers/${cliente.asaas_cliente_id}`, dados, ci);
        await q('UPDATE clientes SET asaas_dados=$1 WHERE id=$2', [assinatura, cliente.id]);
      } catch (e) {
        if (e.status !== 404) throw e;
        cliente.asaas_cliente_id = null; // apagado no painel do Asaas: cria de novo
      }
    }
    if (cliente.asaas_cliente_id) return cliente.asaas_cliente_id;
  }
  // já existe com o mesmo documento? reaproveita
  const busca = await chamar('GET', `/customers?cpfCnpj=${doc}&limit=1`, null, ci).catch(() => ({ data: [] }));
  let id = busca.data && busca.data[0] && !busca.data[0].deleted ? busca.data[0].id : null;
  if (id) await chamar('PUT', `/customers/${id}`, dados, ci).catch(() => {});
  else id = (await chamar('POST', '/customers', dados, ci)).id;
  await q('UPDATE clientes SET asaas_cliente_id=$1, asaas_dados=$2 WHERE id=$3', [id, assinatura, cliente.id]);
  cliente.asaas_cliente_id = id;
  return id;
}

// ---------- Cobrança (Pix) no Asaas ----------
// usa Asaas para este cliente? (devolve o motivo quando não)
async function usaAsaas(cliente) {
  const ci = await conta();
  if (!ci.ligado) return { usa: false, ci };
  if (cliente.pix_asaas === false) return { usa: false, ci };
  if (!docValido(cliente.cpf_cnpj)) return { usa: false, ci, motivo: 'Sem CPF/CNPJ: foi o Pix direto' };
  return { usa: true, ci };
}

// Devolve { codigo, link, asaas: true } ou lança erro
async function pixDaCobranca(cb, cliente, ci) {
  const c = ci.c;
  const hoje = U.hoje();
  const valor = Number(cb.valor);
  let id = cb.asaas_status === 'pago' ? null : cb.asaas_id; // pago e depois desfeito: precisa de um Pix novo
  const vencDesejado = cb.vencimento >= hoje ? cb.vencimento : (id && cb.asaas_venc ? cb.asaas_venc : hoje);
  const descricao = `${require('./cobrancas').descricaoCobranca(cb, cliente)} · ${c.empresa || ''}`.slice(0, 480);

  if (id && (Number(cb.asaas_valor) !== valor || (cb.vencimento >= hoje && cb.asaas_venc !== vencDesejado))) {
    try {
      await chamar('PUT', `/payments/${id}`, { billingType: 'PIX', value: valor, dueDate: vencDesejado, description: descricao }, ci);
      await q('UPDATE cobrancas SET asaas_valor=$1, asaas_venc=$2, asaas_pix=NULL WHERE id=$3', [valor, vencDesejado, cb.id]);
      cb.asaas_pix = null;
    } catch (e) {
      // não deu para alterar (ex.: apagada no painel): cancela e cria outra
      await q('INSERT INTO asaas_cancelar (asaas_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
      id = null;
    }
  }
  if (!id) {
    const clienteId = await garantirCliente(cliente, ci);
    const p = await chamar('POST', '/payments', {
      customer: clienteId, billingType: 'PIX', value: valor, dueDate: vencDesejado, description: descricao, externalReference: `pv:${cb.id}`,
    }, ci);
    id = p.id;
    await q(`UPDATE cobrancas SET asaas_id=$1, asaas_valor=$2, asaas_venc=$3, asaas_link=$4, asaas_status='pendente', asaas_pix=NULL, asaas_erro=NULL WHERE id=$5`,
      [id, valor, vencDesejado, p.invoiceUrl || null, cb.id]);
    Object.assign(cb, { asaas_id: id, asaas_link: p.invoiceUrl, asaas_pix: null, asaas_status: 'pendente' });
  }
  let codigo = cb.asaas_pix;
  if (!codigo) {
    let qr;
    try {
      qr = await chamar('GET', `/payments/${id}/pixQrCode`, null, ci);
    } catch (e) {
      if (e.status !== 404 || cb._tentouDeNovo) throw e;
      // cobrança sumiu do Asaas: recria uma vez
      await q('UPDATE cobrancas SET asaas_id=NULL, asaas_pix=NULL WHERE id=$1', [cb.id]);
      return pixDaCobranca({ ...cb, asaas_id: null, asaas_status: null, _tentouDeNovo: true }, cliente, ci);
    }
    codigo = qr.payload;
    if (!codigo) throw new ErroAsaas('O Asaas não devolveu o Pix. Confira se a conta tem uma chave Pix cadastrada.', 400);
    await q('UPDATE cobrancas SET asaas_pix=$1, asaas_erro=NULL WHERE id=$2', [codigo, cb.id]);
  }
  return { codigo, link: cb.asaas_link || null, asaas: true };
}

async function registrarErro(cobrancaId, msg) {
  await q('UPDATE cobrancas SET asaas_erro=$1 WHERE id=$2', [String(msg || '').slice(0, 300) || null, cobrancaId]).catch(() => {});
}

// ---------- Baixa automática ----------
const PAGO = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];

async function confirmarPagamento(pg) {
  if (!pg || !pg.id || !PAGO.includes(pg.status)) return false;
  let { rows } = await q('SELECT * FROM cobrancas WHERE asaas_id=$1', [pg.id]);
  if (!rows[0] && /^pv:\d+$/.test(pg.externalReference || '')) {
    ({ rows } = await q('SELECT * FROM cobrancas WHERE id=$1 AND (asaas_id IS NULL OR asaas_id=$2)', [pg.externalReference.slice(3), pg.id]));
  }
  const cb = rows[0];
  if (!cb || cb.status !== 'aberto') return false;
  if (cb.asaas_status === 'pago' && cb.asaas_id === pg.id) return false; // já deu baixa uma vez (e alguém desfez)
  await q("UPDATE cobrancas SET asaas_status='pago', asaas_erro=NULL WHERE id=$1", [cb.id]);
  const data = String(pg.clientPaymentDate || pg.paymentDate || pg.confirmedDate || U.hoje()).slice(0, 10);
  await require('./cobrancas').marcarPago(cb.id, { data, valor: pg.value ?? cb.valor, forma: 'pix', obs: 'Pix pago pelo Asaas', por: 'Asaas (automático)' });
  console.log(`[asaas] baixa automática da cobrança ${cb.id} (${pg.id})`);
  return true;
}

// tokens do webhook: 32+ caracteres, sem sequências repetidas
function gerarToken() {
  let t;
  do t = crypto.randomBytes(36).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
  while (t.length < 40 || /(.)\1\1/.test(t));
  return t;
}

async function receberWebhook(req, res) {
  const c = await cfg.obter();
  const esperado = String(c.asaas_webhook_token || '');
  const veio = String(req.get('asaas-access-token') || '');
  if (!esperado || veio.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(veio), Buffer.from(esperado))) {
    return res.status(401).json({ erro: 'token inválido' });
  }
  const ev = req.body || {};
  if (!ev.id) return res.json({ ok: true });
  const novo = await q('INSERT INTO asaas_eventos (id, evento, pagamento) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
    [String(ev.id), String(ev.event || ''), ev.payment && ev.payment.id ? String(ev.payment.id) : null]);
  res.json({ ok: true });
  if (!novo.rowCount) return; // evento repetido
  if (['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(ev.event)) {
    confirmarPagamento(ev.payment).catch((e) => console.error('[asaas] webhook:', e.message));
  }
}

// ---------- Rotina (a cada 5 min): cancela o que precisa e confere pagamentos ----------
let rodando = false;
async function tick() {
  if (rodando) return;
  rodando = true;
  try {
    const ci = await conta();
    if (!ci.chave) return;
    // 1) cancelar no Asaas o que saiu do sistema
    const { rows: fila } = await q('SELECT asaas_id FROM asaas_cancelar ORDER BY criado_em LIMIT 20');
    for (const { asaas_id: id } of fila) {
      try {
        await chamar('DELETE', `/payments/${id}`, null, ci);
        await q('DELETE FROM asaas_cancelar WHERE asaas_id=$1', [id]);
      } catch (e) {
        // já paga, já apagada ou não existe: não tem o que cancelar
        if ([400, 404].includes(e.status)) await q('DELETE FROM asaas_cancelar WHERE asaas_id=$1', [id]);
        else await q('UPDATE asaas_cancelar SET tentativas=tentativas+1 WHERE asaas_id=$1', [id]);
      }
    }
    await q('DELETE FROM asaas_cancelar WHERE tentativas >= 50');
    if (!ci.ligado) return;
    // 2) conferir se alguém pagou (caso o webhook não tenha chegado)
    const { rows } = await q(`SELECT id, asaas_id FROM cobrancas
      WHERE status='aberto' AND asaas_id IS NOT NULL AND asaas_status IS DISTINCT FROM 'pago'
      ORDER BY asaas_conferido_em NULLS FIRST LIMIT 40`);
    for (const r of rows) {
      try {
        const pg = await chamar('GET', `/payments/${r.asaas_id}`, null, ci);
        await q('UPDATE cobrancas SET asaas_conferido_em=now() WHERE id=$1', [r.id]);
        if (pg.deleted) await q('UPDATE cobrancas SET asaas_id=NULL, asaas_pix=NULL, asaas_status=NULL WHERE id=$1 AND asaas_id=$2', [r.id, r.asaas_id]);
        else await confirmarPagamento(pg);
      } catch (e) {
        await q('UPDATE cobrancas SET asaas_conferido_em=now() WHERE id=$1', [r.id]);
        if (e.status === 404) await q('UPDATE cobrancas SET asaas_id=NULL, asaas_pix=NULL, asaas_status=NULL WHERE id=$1 AND asaas_id=$2', [r.id, r.asaas_id]);
        else if (e.status === 401) break;
      }
    }
    await q("DELETE FROM asaas_eventos WHERE recebido_em < now() - interval '60 days'");
  } catch (e) {
    console.warn('[asaas] rotina:', e.message);
  } finally {
    rodando = false;
  }
}

// ---------- Testes e configuração (tela de Configurações) ----------
async function testar() {
  const ci = await conta();
  if (!ci.chave) throw new ErroAsaas('Cole a chave de API do Asaas e salve antes de testar.', 400);
  const saldo = await chamar('GET', '/finance/balance', null, ci);
  let chavesPix = null;
  try {
    const k = await chamar('GET', '/pix/addressKeys?status=ACTIVE&limit=10', null, ci);
    chavesPix = (k.data || []).length;
  } catch (e) { chavesPix = null; }
  return { ok: true, ambiente: ci.ambiente, saldo: saldo.balance, chaves_pix: chavesPix };
}

async function configurarWebhook(urlBase) {
  const ci = await conta();
  if (!ci.chave) throw new ErroAsaas('Cole a chave de API do Asaas e salve antes.', 400);
  const email = String(ci.c.asaas_email || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new ErroAsaas('Informe o e-mail para avisos do Asaas (ele avisa por lá se o webhook falhar).', 400);
  if (!/^https:\/\//.test(urlBase || '')) throw new ErroAsaas('O sistema precisa estar em HTTPS para o Asaas avisar os pagamentos. Enquanto isso, a conferência automática a cada 5 minutos dá conta.', 400);
  let token = ci.c.asaas_webhook_token;
  if (!token || token.length < 32) { token = gerarToken(); await cfg.salvar({ asaas_webhook_token: token }); }
  const url = urlBase.replace(/\/+$/, '') + '/webhook/asaas';
  const corpo = {
    name: 'PV Gestão', url, email, enabled: true, interrupted: false, authToken: token, sendType: 'SEQUENTIALLY',
    events: ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'],
  };
  const lista = await chamar('GET', '/webhooks?limit=50', null, ci).catch(() => ({ data: [] }));
  const existente = (lista.data || []).find((w) => w.url === url);
  if (existente) await chamar('PUT', `/webhooks/${existente.id}`, corpo, ci);
  else await chamar('POST', '/webhooks', corpo, ci);
  return { ok: true, url };
}

module.exports = {
  iniciar, tick, conta, chamar, usaAsaas, pixDaCobranca, registrarErro, receberWebhook, confirmarPagamento,
  testar, configurarWebhook, docValido, soDigitos, ambienteDaChave, gerarToken, ErroAsaas,
};
