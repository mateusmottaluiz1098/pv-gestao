// Usuários, senhas e permissões
const crypto = require('crypto');
const { q } = require('./db');

const PERMISSOES = {
  clientes: 'Cadastrar e editar clientes',
  pagamentos: 'Dar baixa em pagamentos e conferir comprovantes',
  envios: 'Enviar mensagens de cobrança',
  agenda: 'Marcar, alterar e cancelar horários na agenda',
  agenda_config: 'Cadastrar profissionais e serviços da agenda',
  financeiro: 'Ver comissões e faturamento dos profissionais',
  whatsapp: 'Conectar e desconectar o WhatsApp',
  configuracoes: 'Alterar configurações, régua e Pix',
  personalizacao: 'Alterar nome, logo e cores',
  usuarios: 'Gerenciar usuários',
};
const TODAS = Object.keys(PERMISSOES);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  login TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  admin BOOLEAN NOT NULL DEFAULT FALSE,
  permissoes JSONB NOT NULL DEFAULT '[]',
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  versao_sessao INT NOT NULL DEFAULT 1,
  ultimo_acesso TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- usuário vinculado a um profissional: vê só a própria agenda e comissões
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS profissional_id INT;`;

function hashSenha(senha) {
  const sal = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(senha), sal, 64).toString('hex');
  return `${sal}:${h}`;
}

function confereSenha(senha, guardado) {
  const [sal, h] = String(guardado || '').split(':');
  if (!sal || !h) return false;
  const calc = crypto.scryptSync(String(senha), sal, 64);
  const esp = Buffer.from(h, 'hex');
  return esp.length === calc.length && crypto.timingSafeEqual(esp, calc);
}

function normLogin(l) {
  return String(l || '').trim().toLowerCase();
}

// Cria a tabela e, se não houver usuários, o administrador inicial (login "admin", senha do .env)
async function iniciar(senhaInicial) {
  await q(SCHEMA);
  const { rows } = await q('SELECT COUNT(*)::int n FROM usuarios');
  if (rows[0].n === 0) {
    await q(
      'INSERT INTO usuarios (nome, login, senha_hash, admin, permissoes) VALUES ($1,$2,$3,TRUE,$4)',
      ['Administrador', 'admin', hashSenha(senhaInicial || 'admin'), JSON.stringify(TODAS)]
    );
    console.log('Usuário inicial criado: login "admin" com a senha do arquivo .env');
  }
}

// usuário "profissional": não é admin e está ligado a um profissional da agenda
const ehProf = (u) => !!u && !u.admin && !!u.profissional_id;
const PERM_PROF = ['agenda', 'financeiro'];

function publico(u) {
  if (!u) return null;
  return {
    id: u.id, nome: u.nome, login: u.login, admin: u.admin, ativo: u.ativo, profissional_id: u.profissional_id || null,
    permissoes: u.admin ? TODAS : ehProf(u) ? PERM_PROF : (u.permissoes || []).filter((p) => TODAS.includes(p)),
    ultimo_acesso: u.ultimo_acesso, criado_em: u.criado_em,
  };
}

async function porId(id) {
  const { rows } = await q('SELECT * FROM usuarios WHERE id = $1', [id]);
  return rows[0] || null;
}

async function autenticar(login, senha) {
  const { rows } = await q('SELECT * FROM usuarios WHERE login = $1', [normLogin(login)]);
  const u = rows[0];
  if (!u || !u.ativo || !confereSenha(senha, u.senha_hash)) return null;
  await q('UPDATE usuarios SET ultimo_acesso = now() WHERE id = $1', [u.id]);
  return u;
}

function tem(u, perm) {
  if (ehProf(u)) return PERM_PROF.includes(perm);
  return !!u && (u.admin || (u.permissoes || []).includes(perm));
}

async function listar() {
  const { rows } = await q('SELECT * FROM usuarios ORDER BY admin DESC, nome');
  return rows.map(publico);
}

function validar(b, novo) {
  const nome = String(b.nome || '').trim();
  const login = normLogin(b.login);
  if (!nome) throw Object.assign(new Error('Informe o nome'), { status: 400 });
  if (!/^[a-z0-9._-]{3,30}$/.test(login)) throw Object.assign(new Error('Login deve ter de 3 a 30 letras/números, sem espaço'), { status: 400 });
  if ((novo || b.senha) && String(b.senha || '').length < 6) throw Object.assign(new Error('A senha precisa ter pelo menos 6 caracteres'), { status: 400 });
  const permissoes = Array.isArray(b.permissoes) ? b.permissoes.filter((p) => TODAS.includes(p)) : [];
  const profissional_id = !b.admin && parseInt(b.profissional_id, 10) > 0 ? parseInt(b.profissional_id, 10) : null;
  return { nome, login, senha: b.senha, admin: !!b.admin, ativo: b.ativo !== false, permissoes, profissional_id };
}

async function admins(excetoId) {
  const { rows } = await q('SELECT COUNT(*)::int n FROM usuarios WHERE admin AND ativo AND id <> $1', [excetoId || 0]);
  return rows[0].n;
}

async function criar(b) {
  const d = validar(b, true);
  try {
    const { rows } = await q(
      'INSERT INTO usuarios (nome, login, senha_hash, admin, permissoes, ativo, profissional_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [d.nome, d.login, hashSenha(d.senha), d.admin, JSON.stringify(d.permissoes), d.ativo, d.profissional_id]
    );
    return publico(rows[0]);
  } catch (e) {
    if (e.code === '23505') throw Object.assign(new Error('Já existe um usuário com esse login'), { status: 400 });
    throw e;
  }
}

async function atualizar(id, b, quem) {
  const atual = await porId(id);
  if (!atual) throw Object.assign(new Error('Usuário não encontrado'), { status: 404 });
  const d = validar(b, false);
  if (atual.admin && (!d.admin || !d.ativo) && (await admins(id)) === 0) {
    throw Object.assign(new Error('Precisa existir pelo menos um administrador ativo'), { status: 400 });
  }
  if (quem && Number(quem.id) === Number(id) && !d.ativo) {
    throw Object.assign(new Error('Você não pode desativar o seu próprio usuário'), { status: 400 });
  }
  const trocaSenha = d.senha && String(d.senha).length >= 6;
  // ao trocar senha, permissões ou desativar, derruba as sessões abertas desse usuário
  const derruba = trocaSenha || !d.ativo || d.admin !== atual.admin || (d.profissional_id || null) !== (atual.profissional_id || null);
  try {
    const { rows } = await q(
      `UPDATE usuarios SET nome=$1, login=$2, admin=$3, permissoes=$4, ativo=$5, profissional_id=${d.profissional_id ? Number(d.profissional_id) : 'NULL'}
         ${trocaSenha ? ', senha_hash=$7' : ''} ${derruba ? ', versao_sessao = versao_sessao + 1' : ''}
       WHERE id=$6 RETURNING *`,
      trocaSenha
        ? [d.nome, d.login, d.admin, JSON.stringify(d.permissoes), d.ativo, id, hashSenha(d.senha)]
        : [d.nome, d.login, d.admin, JSON.stringify(d.permissoes), d.ativo, id]
    );
    return publico(rows[0]);
  } catch (e) {
    if (e.code === '23505') throw Object.assign(new Error('Já existe um usuário com esse login'), { status: 400 });
    throw e;
  }
}

async function excluir(id, quem) {
  if (quem && Number(quem.id) === Number(id)) throw Object.assign(new Error('Você não pode excluir o seu próprio usuário'), { status: 400 });
  const atual = await porId(id);
  if (!atual) return;
  if (atual.admin && (await admins(id)) === 0) throw Object.assign(new Error('Precisa existir pelo menos um administrador'), { status: 400 });
  await q('DELETE FROM usuarios WHERE id = $1', [id]);
}

async function trocarPropriaSenha(id, atualSenha, nova) {
  const u = await porId(id);
  if (!u || !confereSenha(atualSenha, u.senha_hash)) throw Object.assign(new Error('Senha atual incorreta'), { status: 400 });
  if (String(nova || '').length < 6) throw Object.assign(new Error('A nova senha precisa ter pelo menos 6 caracteres'), { status: 400 });
  await q('UPDATE usuarios SET senha_hash=$1, versao_sessao = versao_sessao + 1 WHERE id=$2', [hashSenha(nova), id]);
  return porId(id);
}

module.exports = { PERMISSOES, TODAS, ehProf, iniciar, porId, autenticar, tem, listar, criar, atualizar, excluir, trocarPropriaSenha, publico };
