const TZ = 'America/Sao_Paulo';

// Data de hoje no fuso de Brasília, 'YYYY-MM-DD'
function hoje() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function horaAgora() {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  return p; // 'HH:MM'
}

function parseData(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fmtISO(dt) {
  return dt.toISOString().slice(0, 10);
}

function somarDias(s, n) {
  const dt = parseData(s);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fmtISO(dt);
}

function diffDias(a, b) {
  // a - b em dias
  return Math.round((parseData(a) - parseData(b)) / 86400000);
}

function ultimoDiaMes(y, m) {
  // m 1-12
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function vencimentoNoMes(y, m, dia) {
  const d = Math.min(dia, ultimoDiaMes(y, m));
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function brData(s) {
  if (!s) return '';
  const [y, m, d] = s.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function brl(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function nomeMes(s) {
  const [y, m] = s.split('-').map(Number);
  return `${MESES[m - 1]}/${y}`;
}

// Normaliza telefone brasileiro para 55DDNNNNNNNNN
function normalizarTelefone(t) {
  let d = String(t || '').replace(/\D/g, '');
  d = d.replace(/^0+/, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d;
}

// Chave para comparar números (DDD + 8 últimos dígitos) — ignora o 9º dígito
function chaveTelefone(t) {
  const d = normalizarTelefone(t);
  if (d.length < 10) return d;
  const semPais = d.startsWith('55') ? d.slice(2) : d;
  return semPais.slice(0, 2) + semPais.slice(-8);
}

function telefoneValido(t) {
  const d = normalizarTelefone(t);
  return /^55\d{10,11}$/.test(d);
}

function aleatorio(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = {
  hoje, horaAgora, somarDias, diffDias, vencimentoNoMes, brData, brl, nomeMes,
  normalizarTelefone, chaveTelefone, telefoneValido, aleatorio, parseData, fmtISO, ultimoDiaMes,
};
