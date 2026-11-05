const { q } = require('./db');

const TEMAS = ['azul', 'verde', 'roxo', 'rosa', 'preto', 'branco'];

const PADRAO = {
  sistema_nome: process.env.SISTEMA_NOME || 'PV Gestão',
  tema: 'azul',
  empresa: process.env.EMPRESA_NOME || 'Minha Empresa',
  pix_tipo: 'cpf',
  pix_chave: '',
  pix_nome: '',
  pix_cidade: 'Torres',
  enviar_pix_copia_cola: true,
  enviar_qr_code: false,

  envio_automatico: false,
  hora_envio: '09:00',
  janela_inicio: '08:00',
  janela_fim: '20:00',
  intervalo_min: 25,
  intervalo_max: 70,
  limite_diario: 60,
  tolerancia_dias: 3,

  regua: [
    {
      id: 'antes2', dias: -2, ativo: true,
      modelo: 'Olá, {primeiro_nome}! 😊\nPassando para lembrar que a mensalidade da {empresa} de {valor} vence em {vencimento}.\n\nVocê pode pagar pelo Pix abaixo. Depois é só mandar o comprovante aqui mesmo. Obrigado!',
    },
    {
      id: 'dia0', dias: 0, ativo: true,
      modelo: 'Olá, {primeiro_nome}! Hoje ({vencimento}) vence a mensalidade da {empresa} no valor de {valor}.\n\nSegue o Pix abaixo. Se já pagou, pode desconsiderar e mandar o comprovante por aqui. 🙏',
    },
    {
      id: 'depois1', dias: 1, ativo: true,
      modelo: 'Oi, {primeiro_nome}, tudo bem? Não identificamos ainda o pagamento da mensalidade de {valor} que venceu ontem ({vencimento}).\n\nSegue o Pix para facilitar. Se já pagou, é só mandar o comprovante aqui.',
    },
    {
      id: 'depois5', dias: 5, ativo: true,
      modelo: 'Olá, {primeiro_nome}. A mensalidade da {empresa} de {valor} está em aberto há {dias_atraso} dias (venc. {vencimento}).\n\nPodemos contar com o pagamento? Pix abaixo. Qualquer dificuldade, me chama por aqui.',
    },
    {
      id: 'depois10', dias: 10, ativo: true,
      modelo: '{primeiro_nome}, seguimos com a mensalidade de {valor} em aberto desde {vencimento} ({dias_atraso} dias).\n\nPor favor, regularize pelo Pix abaixo ou me avise se precisar combinar outra data.',
    },
  ],

  agenda_intervalo: 30,
  agenda_inicio: '08:00',
  agenda_fim: '20:00',
  agenda_confirmacao: true,
  agenda_lembrete: true,
  agenda_lembrete_horas: 3,
  agenda_msg_confirmacao: 'Olá, {primeiro_nome}! ✂️ Seu horário na {empresa} está marcado:\n\n📅 {dia_semana}, {data} às {hora}\n👤 {profissional}\n💈 {servico}\n\nPara confirmar responda *SIM*. Se precisar desmarcar, responda *CANCELAR*.',
  agenda_msg_lembrete: 'Oi, {primeiro_nome}! Lembrete: hoje/amanhã você tem horário na {empresa} — {dia_semana}, {data} às {hora} com {profissional}.\n\nResponda *SIM* para confirmar ou *CANCELAR* se não puder vir.',
  agenda_msg_confirmado: 'Confirmado, {primeiro_nome}! Te esperamos {dia_semana} às {hora}. 👍',
  agenda_msg_cancelado: 'Tudo bem, {primeiro_nome}. Seu horário de {data} às {hora} foi cancelado. Quando quiser remarcar, é só chamar aqui.',

  agradecer_pagamento: true,
  modelo_agradecimento: 'Pagamento de {valor} recebido, {primeiro_nome}! Muito obrigado. 💙\n— {empresa}',

  responder_comprovante: true,
  modelo_resposta_comprovante: 'Recebemos seu comprovante, {primeiro_nome}! Vamos conferir e já damos baixa. Obrigado! 🙏',
};

let cache = null;

async function obter() {
  if (cache) return cache;
  const { rows } = await q('SELECT chave, valor FROM config');
  const salvo = Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
  cache = { ...PADRAO, ...salvo };
  return cache;
}

async function salvar(novo) {
  const permitido = Object.keys(PADRAO);
  for (const [k, v] of Object.entries(novo)) {
    if (!permitido.includes(k)) continue;
    await q(
      'INSERT INTO config (chave, valor) VALUES ($1, $2) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor',
      [k, JSON.stringify(v)]
    );
  }
  cache = null;
  return obter();
}

async function marcarExecucao(data) {
  await q(
    "INSERT INTO config (chave, valor) VALUES ('_ultima_execucao', $1) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor",
    [JSON.stringify(data)]
  );
}

async function ultimaExecucao() {
  const { rows } = await q("SELECT valor FROM config WHERE chave = '_ultima_execucao'");
  return rows[0] ? rows[0].valor : null;
}

// Logo fica separada da config (pode ser grande)
async function obterLogo() {
  const { rows } = await q("SELECT valor FROM config WHERE chave = '_logo'");
  return rows[0] ? rows[0].valor : null; // { mime, base64 }
}

async function salvarLogo(logo) {
  if (!logo) {
    await q("DELETE FROM config WHERE chave = '_logo'");
  } else {
    await q(
      "INSERT INTO config (chave, valor) VALUES ('_logo', $1) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor",
      [JSON.stringify(logo)]
    );
  }
}

module.exports = { obter, salvar, PADRAO, TEMAS, marcarExecucao, ultimaExecucao, obterLogo, salvarLogo };
