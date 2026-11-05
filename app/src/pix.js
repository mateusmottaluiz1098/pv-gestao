// Geração de Pix "copia e cola" (BR Code estático) com valor
const QRCode = require('qrcode');

function campo(id, valor) {
  const v = String(valor);
  return id + String(v.length).padStart(2, '0') + v;
}

function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function limpar(s, max) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .trim()
    .toUpperCase()
    .slice(0, max);
}

function formatarChave(tipo, chave) {
  const c = String(chave || '').trim();
  switch (tipo) {
    case 'cpf':
    case 'cnpj':
      return c.replace(/\D/g, '');
    case 'telefone': {
      let d = c.replace(/\D/g, '');
      if (d.length === 10 || d.length === 11) d = '55' + d;
      return '+' + d;
    }
    case 'email':
      return c.toLowerCase();
    default:
      return c; // chave aleatória
  }
}

function gerarPix({ tipoChave, chave, nome, cidade, valor, txid }) {
  if (!chave) return null;
  const conta = campo('00', 'br.gov.bcb.pix') + campo('01', formatarChave(tipoChave, chave));
  let p = '';
  p += campo('00', '01');
  p += campo('26', conta);
  p += campo('52', '0000');
  p += campo('53', '986');
  if (valor && Number(valor) > 0) p += campo('54', Number(valor).toFixed(2));
  p += campo('58', 'BR');
  p += campo('59', limpar(nome, 25) || 'RECEBEDOR');
  p += campo('60', limpar(cidade, 15) || 'BRASIL');
  const tx = String(txid || '***').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  p += campo('62', campo('05', tx));
  p += '6304';
  return p + crc16(p);
}

async function qrDataUrl(codigo) {
  return QRCode.toDataURL(codigo, { margin: 1, width: 360 });
}

module.exports = { gerarPix, qrDataUrl, crc16 };
