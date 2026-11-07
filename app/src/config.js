const { q } = require('./db');

const TEMAS = ['azul', 'verde', 'roxo', 'rosa', 'preto', 'branco'];

// ---------- Ramos de negócio ----------
// Cada ramo liga os módulos que fazem sentido, troca alguns nomes da tela e traz mensagens prontas.
const MODULOS = ['agenda', 'caixa', 'produtos', 'comissoes', 'online', 'retorno', 'pacotes', 'espera', 'relatorios'];
const TODOS = Object.fromEntries(MODULOS.map((m) => [m, true]));
const NENHUM = Object.fromEntries(MODULOS.map((m) => [m, false]));
const RAMOS = {
  servicos: {
    nome: 'Piscinas e serviços recorrentes', exemplo: 'limpeza de piscina, jardinagem, limpeza, manutenção',
    // o essencial: mensalidade, Pix, comprovantes e avisos no WhatsApp
    modulos: { ...NENHUM, relatorios: true },
    termos: { profissional: 'técnico', profissionais: 'técnicos', cliente: 'cliente', clientes: 'clientes' },
    exemplos: { servico: 'Limpeza da piscina', produto: 'Cloro granulado', consumo: 'Troca de areia do filtro', pacote: '4 limpezas no mês' },
    mensagens: {
      agenda_msg_confirmacao: 'Olá, {primeiro_nome}! 📅 Sua visita da {empresa} está marcada:\n\n🗓️ {dia_semana}, {data} às {hora}\n👤 Técnico: {profissional}\n📋 {servico}\n\nPara confirmar responda *SIM*. Se precisar remarcar, responda *CANCELAR*.',
      agenda_msg_lembrete: 'Oi, {primeiro_nome}! ⏰ Lembrete: {dia_semana}, {data} às {hora} o técnico {profissional} da {empresa} passa aí para {servico}.\n\nResponda *SIM* para confirmar ou *CANCELAR* se precisar remarcar.',
    },
  },
  barbearia: {
    nome: 'Barbearia', exemplo: 'barbearia, barber shop',
    modulos: { ...TODOS },
    termos: { profissional: 'profissional', profissionais: 'profissionais', cliente: 'cliente', clientes: 'clientes' },
    exemplos: { servico: 'Corte', produto: 'Pomada modeladora', consumo: 'Corte + barba', pacote: 'Clube: 4 cortes por mês' },
    mensagens: {
      agenda_msg_confirmacao: 'Olá, {primeiro_nome}! ✂️ Seu horário na {empresa} está marcado:\n\n📅 {dia_semana}, {data} às {hora}\n👤 {profissional}\n💈 {servico}\n\nPara confirmar responda *SIM*. Se precisar desmarcar, responda *CANCELAR*.',
      retorno_msg: 'Fala, {primeiro_nome}! 💈 Já faz {dias} dias desde o seu último {servico} aqui na {empresa}.\n\nBora dar um tapa no visual? {link_agendamento}',
    },
  },
  salao: {
    nome: 'Salão de beleza ou estética', exemplo: 'salão, manicure, estética, sobrancelha, depilação',
    modulos: { ...TODOS },
    termos: { profissional: 'profissional', profissionais: 'profissionais', cliente: 'cliente', clientes: 'clientes' },
    exemplos: { servico: 'Escova', produto: 'Máscara de hidratação', consumo: 'Manicure', pacote: '5 sessões de limpeza de pele' },
    mensagens: {
      agenda_msg_confirmacao: 'Olá, {primeiro_nome}! 💅 Seu horário na {empresa} está marcado:\n\n📅 {dia_semana}, {data} às {hora}\n👤 {profissional}\n✨ {servico}\n\nPara confirmar responda *SIM*. Se precisar desmarcar, responda *CANCELAR*.',
      retorno_msg: 'Oi, {primeiro_nome}! ✨ Já faz {dias} dias desde o seu último {servico} aqui na {empresa}.\n\nQue tal cuidar de você de novo? {link_agendamento}',
    },
  },
  escola: {
    nome: 'Academia, escola ou cursos', exemplo: 'academia, crossfit, escola, curso, aulas particulares',
    modulos: { ...NENHUM, caixa: true, produtos: true, pacotes: true, relatorios: true },
    termos: { profissional: 'professor', profissionais: 'professores', cliente: 'aluno', clientes: 'alunos' },
    exemplos: { servico: 'Aula experimental', produto: 'Garrafa de água', consumo: 'Aula avulsa', pacote: '10 aulas avulsas' },
    mensagens: {
      agenda_msg_confirmacao: 'Olá, {primeiro_nome}! 📅 Sua aula na {empresa} está marcada:\n\n🗓️ {dia_semana}, {data} às {hora}\n👤 {profissional}\n📋 {servico}\n\nPara confirmar responda *SIM*. Se não puder vir, responda *CANCELAR*.',
    },
  },
  comercio: {
    nome: 'Comércio ou loja', exemplo: 'loja, mercado, oficina, assistência técnica',
    modulos: { ...NENHUM, caixa: true, produtos: true, comissoes: true, relatorios: true },
    termos: { profissional: 'vendedor', profissionais: 'vendedores', cliente: 'cliente', clientes: 'clientes' },
    exemplos: { servico: 'Instalação', produto: 'Produto', consumo: 'Compra no balcão', pacote: 'Pacote de manutenções' },
    mensagens: {},
  },
};
const RAMO_PADRAO = RAMOS[process.env.RAMO] ? process.env.RAMO : 'barbearia';
const CHAVES_MSG_RAMO = [...new Set(Object.values(RAMOS).flatMap((r) => Object.keys(r.mensagens)))];

const PADRAO = {
  ramo: RAMO_PADRAO,
  modulos: null, // null = os do ramo
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
      modelo: 'Olá, {primeiro_nome}! 😊\nPassando para lembrar que o pagamento de {valor} ({descricao}) da {empresa} vence em {vencimento}.\n\nVocê pode pagar pelo Pix abaixo. Depois é só mandar o comprovante aqui mesmo. Obrigado!',
    },
    {
      id: 'dia0', dias: 0, ativo: true,
      modelo: 'Olá, {primeiro_nome}! 📌 Hoje ({vencimento}) vence o pagamento de {valor} ({descricao}) da {empresa}.\n\nSegue o Pix abaixo. Se já pagou, pode desconsiderar e mandar o comprovante por aqui.',
    },
    {
      id: 'depois1', dias: 1, ativo: true,
      modelo: 'Oi, {primeiro_nome}, tudo bem? Não identificamos ainda o pagamento de {valor} ({descricao}) que venceu ontem ({vencimento}).\n\nSegue o Pix para facilitar. Se já pagou, é só mandar o comprovante aqui.',
    },
    {
      id: 'depois5', dias: 5, ativo: true,
      modelo: 'Olá, {primeiro_nome}. O pagamento de {valor} ({descricao}) da {empresa} está em aberto há {dias_atraso} dias (venc. {vencimento}).\n\nPodemos contar com o pagamento? Pix abaixo. Qualquer dificuldade, me chama por aqui.',
    },
    {
      id: 'depois10', dias: 10, ativo: true,
      modelo: '{primeiro_nome}, seguimos com o pagamento de {valor} ({descricao}) em aberto desde {vencimento} ({dias_atraso} dias).\n\nPor favor, regularize pelo Pix abaixo ou me avise se precisar combinar outra data.',
    },
  ],

  agenda_intervalo: 30,
  agenda_inicio: '08:00',
  agenda_fim: '20:00',
  agenda_confirmacao: true,
  agenda_lembrete: true,
  agenda_lembrete_horas: 3,
  agenda_msg_confirmacao: 'Olá, {primeiro_nome}! 📅 Seu horário na {empresa} está marcado:\n\n🗓️ {dia_semana}, {data} às {hora}\n👤 {profissional}\n📋 {servico}\n\nPara confirmar responda *SIM*. Se precisar desmarcar, responda *CANCELAR*.',
  agenda_msg_lembrete: 'Oi, {primeiro_nome}! ⏰ Lembrete: hoje/amanhã você tem horário na {empresa} — {dia_semana}, {data} às {hora} com {profissional}.\n\nResponda *SIM* para confirmar ou *CANCELAR* se não puder vir.',
  agenda_msg_confirmado: 'Confirmado, {primeiro_nome}! Te esperamos {dia_semana} às {hora}. ✅',
  agenda_msg_cancelado: 'Tudo bem, {primeiro_nome}. Seu horário de {data} às {hora} foi cancelado. Quando quiser remarcar, é só chamar aqui.',

  agradecer_pagamento: true,
  modelo_agradecimento: '✅ Pagamento de {valor} recebido, {primeiro_nome}! Muito obrigado.\n— {empresa}',

  modelo_avulso: 'Olá, {primeiro_nome}! 🧾 Segue o valor de {valor} referente a {descricao} na {empresa}.\n\nPode pagar pelo Pix abaixo e mandar o comprovante aqui. Obrigado!',

  // retorno: chama de volta quem não aparece há um tempo
  retorno_ativo: false,
  retorno_dias: 30,
  retorno_hora: '10:00',
  retorno_limite: 20,
  retorno_msg: 'Olá, {primeiro_nome}! 👋 Já faz {dias} dias desde o seu último {servico} aqui na {empresa}.\n\nQue tal marcar o próximo? {link_agendamento}',

  // lista de espera: avisa no WhatsApp quando abre um horário
  espera_auto: true,
  espera_qtd_aviso: 3,
  espera_msg: 'Olá, {primeiro_nome}! 🔔 Abriu um horário na {empresa}: {dia_semana}, {data} às {hora} com {profissional}.\n\nQuer ficar com ele? Responda aqui que a gente marca para você.',

  // agendamento online pelo próprio cliente
  online_ativo: false,
  online_antecedencia_min: 60,
  online_dias: 30,
  online_aviso: '',

  responder_comprovante: true,
  modelo_resposta_comprovante: '📩 Recebemos seu comprovante, {primeiro_nome}! Vamos conferir e já damos baixa. Obrigado!',
};

let cache = null;

async function obter() {
  if (cache) return cache;
  const { rows } = await q('SELECT chave, valor FROM config');
  const salvo = Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
  const ramo = RAMOS[salvo.ramo] ? salvo.ramo : (salvo.ramo === 'beleza' ? 'barbearia' : RAMO_PADRAO);
  const R = RAMOS[ramo];
  cache = { ...PADRAO, ...R.mensagens, ...salvo, ramo };
  cache.modulos = { ...R.modulos, ...(salvo.modulos && typeof salvo.modulos === 'object' ? salvo.modulos : {}) };
  cache.termos = R.termos;
  cache.exemplos = R.exemplos;
  cache.ramos = Object.fromEntries(Object.entries(RAMOS).map(([k, v]) => [k, { nome: v.nome, exemplo: v.exemplo, modulos: v.modulos }]));
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

// volta as mensagens que mudam por ramo para o texto pronto do ramo atual
async function usarMensagensDoRamo() {
  await q('DELETE FROM config WHERE chave = ANY($1)', [CHAVES_MSG_RAMO]);
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

// valores internos (começam com _), ex.: endereço público do sistema
async function salvarInterno(chave, valor) {
  await q('INSERT INTO config (chave, valor) VALUES ($1, $2) ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor', ['_' + chave, JSON.stringify(valor)]);
  cache = null;
}

module.exports = { obter, salvar, salvarInterno, usarMensagensDoRamo, PADRAO, TEMAS, RAMOS, MODULOS, marcarExecucao, ultimaExecucao, obterLogo, salvarLogo };
