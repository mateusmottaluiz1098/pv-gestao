// Cliente da Evolution API (WhatsApp)
const URL_BASE = (process.env.EVOLUTION_URL || 'http://localhost:8080').replace(/\/$/, '');
const API_KEY = process.env.EVOLUTION_API_KEY || '';
const INSTANCIA = process.env.EVOLUTION_INSTANCE || 'piscina';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://app:3000/webhook/whatsapp';
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || '';

const EVENTOS = ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'];

async function chamar(metodo, caminho, corpo) {
  let resp;
  try {
    resp = await fetch(URL_BASE + caminho, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', apikey: API_KEY },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    const err = new Error('Não foi possível falar com o serviço do WhatsApp (Evolution API). Ele está ligado?');
    err.offline = true;
    throw err;
  }
  const texto = await resp.text();
  let dados;
  try { dados = JSON.parse(texto); } catch { dados = texto; }
  if (!resp.ok) {
    const msg = (dados && dados.response && JSON.stringify(dados.response.message)) || (dados && dados.message) || texto;
    const err = new Error(`WhatsApp respondeu ${resp.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    err.evoStatus = resp.status;
    err.dados = dados;
    throw err;
  }
  return dados;
}

function urlWebhook() {
  return WEBHOOK_URL + (WEBHOOK_TOKEN ? `?token=${encodeURIComponent(WEBHOOK_TOKEN)}` : '');
}

async function estado() {
  try {
    const r = await chamar('GET', `/instance/connectionState/${INSTANCIA}`);
    const st = (r && r.instance && r.instance.state) || r.state || 'close';
    let numero = null;
    let nome = null;
    if (st === 'open') {
      try {
        const lista = await chamar('GET', `/instance/fetchInstances?instanceName=${INSTANCIA}`);
        const inst = Array.isArray(lista) ? lista[0] : lista;
        const owner = inst && (inst.ownerJid || (inst.instance && inst.instance.owner));
        if (owner) numero = String(owner).split('@')[0];
        nome = inst && (inst.profileName || (inst.instance && inst.instance.profileName));
      } catch { /* opcional */ }
    }
    return { existe: true, estado: st, conectado: st === 'open', numero, nome };
  } catch (e) {
    if (e.evoStatus === 404) return { existe: false, estado: 'inexistente', conectado: false };
    if (e.offline) return { existe: false, estado: 'offline', conectado: false, erro: e.message };
    return { existe: false, estado: 'erro', conectado: false, erro: e.message };
  }
}

async function configurarWebhook() {
  await chamar('POST', `/webhook/set/${INSTANCIA}`, {
    webhook: { enabled: true, url: urlWebhook(), byEvents: false, base64: true, events: EVENTOS },
  });
}

async function conectar() {
  const st = await estado();
  if (st.estado === 'offline') throw new Error(st.erro);
  if (!st.existe) {
    const r = await chamar('POST', '/instance/create', {
      instanceName: INSTANCIA,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
      webhook: { url: urlWebhook(), byEvents: false, base64: true, events: EVENTOS },
    });
    if (r && r.qrcode && r.qrcode.base64) return { qr: r.qrcode.base64, codigo: r.qrcode.pairingCode || null };
  } else {
    await configurarWebhook().catch((e) => console.warn('webhook:', e.message));
    if (st.conectado) return { conectado: true };
  }
  const c = await chamar('GET', `/instance/connect/${INSTANCIA}`);
  return { qr: c.base64 || null, codigo: c.pairingCode || null, conectado: !c.base64 && c.instance && c.instance.state === 'open' };
}

async function desconectar() {
  try { await chamar('DELETE', `/instance/logout/${INSTANCIA}`); } catch (e) { if (e.evoStatus !== 404 && e.evoStatus !== 400) throw e; }
}

async function enviarTexto(numero, texto) {
  return chamar('POST', `/message/sendText/${INSTANCIA}`, { number: numero, text: texto, delay: 1200 });
}

async function enviarImagem(numero, base64, legenda, nomeArquivo = 'pix.png') {
  const puro = String(base64).replace(/^data:[^;]+;base64,/, '');
  return chamar('POST', `/message/sendMedia/${INSTANCIA}`, {
    number: numero, mediatype: 'image', mimetype: 'image/png', caption: legenda || '', media: puro, fileName: nomeArquivo,
  });
}

async function baixarMidia(dadosMensagem) {
  const r = await chamar('POST', `/chat/getBase64FromMediaMessage/${INSTANCIA}`, {
    message: { key: dadosMensagem.key }, convertToMp4: false,
  });
  return r && (r.base64 || (r.data && r.data.base64));
}

module.exports = { estado, conectar, desconectar, enviarTexto, enviarImagem, baixarMidia, configurarWebhook, INSTANCIA };
