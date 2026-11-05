/* PV Gestão — interface */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const brData = (s) => { if (!s) return ''; const [y, m, d] = String(s).slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
const brDataHora = (s) => s ? new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
const fone = (t) => { const d = String(t || '').replace(/\D/g, '').replace(/^55/, ''); return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : t; };
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

let HOJE = new Date().toISOString().slice(0, 10);
let CONFIG = null;

async function api(caminho, opcoes = {}) {
  const r = await fetch('/api' + caminho, {
    method: opcoes.method || 'GET',
    headers: opcoes.body ? { 'Content-Type': 'application/json' } : {},
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
  });
  if (r.status === 401 && caminho !== '/login') { mostrarLogin(); throw new Error('Faça login'); }
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.erro || 'Erro ' + r.status);
  return dados;
}

function toast(msg, erro = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (erro ? ' erro' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), erro ? 5000 : 2800);
}

function abrirModal(html, largo = false) {
  const m = $('#modal');
  $('#modal-caixa').className = 'modal-caixa' + (largo ? ' largo' : '');
  $('#modal-caixa').innerHTML = html;
  m.classList.remove('hidden');
  $$('[data-fechar]', m).forEach((b) => b.onclick = fecharModal);
}
function fecharModal() { $('#modal').classList.add('hidden'); $('#modal-caixa').innerHTML = ''; }
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') fecharModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharModal(); });

function confirmar(titulo, texto, botao = 'Confirmar', perigo = false) {
  return new Promise((ok) => {
    abrirModal(`<div class="modal-topo"><h2>${esc(titulo)}</h2><button class="fechar" data-fechar>×</button></div>
      <div class="modal-corpo"><p>${texto}</p></div>
      <div class="modal-rodape"><button class="btn" data-fechar>Cancelar</button><button class="btn ${perigo ? 'perigo' : 'primario'}" id="conf-ok">${esc(botao)}</button></div>`);
    $('#conf-ok').onclick = () => { fecharModal(); ok(true); };
    $$('[data-fechar]').forEach((b) => b.addEventListener('click', () => ok(false)));
  });
}

const DIAS_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const NOME_FORMA_CLI = { mensal: 'Mensal', semanal: 'Semanal', quinzenal: 'Quinzenal', carne: 'Carnê', avulso: 'Só avulso' };
const NOME_PAGTO = { pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Crédito', debito: 'Débito', transferencia: 'Transferência', boleto: 'Boleto', fiado: 'Fiado' };
// "Forma" do cliente em texto curto (lista e ficha)
function formaCliente(c) {
  if (c.forma === 'carne') return `Carnê (${c.parcelas_total}x) · dia ${c.dia_vencimento}`;
  if (c.forma === 'semanal' || c.forma === 'quinzenal') return `${NOME_FORMA_CLI[c.forma]} · ${DIAS_SEMANA[c.dia_semana ?? new Date(c.primeiro_vencimento + 'T12:00').getDay()]}`;
  if (c.forma === 'avulso') return 'Só avulso / fiado';
  return `Mensal · dia ${c.dia_vencimento}`;
}
// "referente a" de uma cobrança
function refCobranca(cb, forma) {
  if (cb.descricao) return cb.descricao;
  if (cb.tipo === 'avulsa') return 'Consumo avulso';
  if (forma === 'semanal') return `Semana de ${brData(cb.vencimento).slice(0, 5)}`;
  if (forma === 'quinzenal') return `Quinzena de ${brData(cb.vencimento).slice(0, 5)}`;
  return `${MESES[Number(cb.competencia.slice(5, 7)) - 1].slice(0, 3)}/${cb.competencia.slice(0, 4)}`;
}

function statusCobranca(cb) {
  if (cb.status === 'pago') return '<span class="tag pago">Pago</span>';
  if (cb.status === 'cancelado') return '<span class="tag">Cancelado</span>';
  if (cb.vencimento < HOJE) {
    const dias = Math.round((new Date(HOJE) - new Date(cb.vencimento)) / 86400000);
    return `<span class="tag atrasado">Atrasado ${dias}d</span>`;
  }
  if (cb.vencimento === HOJE) return '<span class="tag hoje">Vence hoje</span>';
  return '<span class="tag aberto">Em aberto</span>';
}

// ---------- Marca (nome, logo, cor) ----------
let MARCA = { sistema_nome: 'PV Gestão', tema: 'azul', tem_logo: false };
const ICONE_PADRAO = '✓';
function aplicarMarca(m) {
  MARCA = { ...MARCA, ...m };
  document.documentElement.dataset.tema = MARCA.tema || 'azul';
  $$('.nome-sistema').forEach((e) => e.textContent = MARCA.sistema_nome);
  const urlLogo = MARCA.tem_logo ? `/marca/logo?v=${MARCA.logo_versao || ''}` : null;
  $$('.logo-marca').forEach((e) => {
    e.classList.toggle('com-logo', !!urlLogo);
    e.innerHTML = urlLogo ? `<img src="${urlLogo}" alt="">` : ICONE_PADRAO;
  });
  document.title = MARCA.sistema_nome;
  const cor = getComputedStyle(document.documentElement).getPropertyValue('--azul-3').trim() || '#31b2e8';
  $('#favicon').href = urlLogo || `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='${cor}'/><path d='M9 16.5l4.5 4.5L23 11.5' stroke='white' stroke-width='3' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>`)}`;
}
async function carregarMarca() {
  try { aplicarMarca(await (await fetch('/api/marca')).json()); } catch { aplicarMarca({}); }
}

// ---------- Login / navegação ----------
let EU = null;
const pode = (p) => !!EU && (EU.admin || (EU.permissoes || []).includes(p));

function mostrarLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
$('#form-login').onsubmit = async (e) => {
  e.preventDefault();
  $('#login-erro').textContent = '';
  try {
    await api('/login', { method: 'POST', body: { login: e.target.login.value, senha: e.target.senha.value } });
    e.target.senha.value = '';
    $('#login').classList.add('hidden');
    iniciar();
  } catch (err) { $('#login-erro').textContent = err.message; }
};
$('#btn-sair').onclick = async () => { await api('/logout', { method: 'POST' }); EU = null; mostrarLogin(); };
$('#btn-menu').onclick = () => $('.sidebar').classList.toggle('aberta');
$('#btn-senha').onclick = () => modalMinhaSenha();

const PAGINAS = {
  painel: ['Visão geral', pgPainel],
  agenda: ['Agenda', pgAgenda],
  comissoes: ['Comissões', pgComissoes, 'financeiro'],
  caixa: ['Caixa do dia', pgCaixa, 'financeiro'],
  clientes: ['Clientes', pgClientes],
  cobrancas: ['Cobranças', pgCobrancas],
  comprovantes: ['Comprovantes', pgComprovantes],
  whatsapp: ['WhatsApp', pgWhatsapp],
  config: ['Configurações', pgConfig, 'configuracoes'],
  personalizacao: ['Personalização', pgPersonalizacao, 'personalizacao'],
  usuarios: ['Usuários', pgUsuarios, 'usuarios'],
};
let timers = [];
function limparTimers() { timers.forEach(clearInterval); timers = []; }

async function rotear() {
  if (!EU || !CONFIG) return;
  limparTimers();
  let pg = (location.hash.replace('#/', '') || 'painel').split('?')[0];
  if (!PAGINAS[pg] || (PAGINAS[pg][2] && !pode(PAGINAS[pg][2]))) pg = 'painel';
  const [titulo, fn] = PAGINAS[pg];
  $$('#menu a').forEach((a) => a.classList.toggle('ativo', a.dataset.pg === pg || (pg === 'comissoes' && a.dataset.pg === 'agenda')));
  $('#trilha-pg').textContent = titulo;
  document.body.dataset.pg = pg;
  $('.sidebar').classList.remove('aberta');
  $('#conteudo').innerHTML = '<p class="muted">Carregando…</p>';
  try { await fn($('#conteudo')); aplicarPermissoes($('#conteudo')); } catch (e) { $('#conteudo').innerHTML = `<div class="aviso">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', rotear);

// Esconde botões que o usuário não pode usar (o servidor também bloqueia)
const ACOES_PERM = {
  '#novo-cli': 'clientes', '[data-editar]': 'clientes', '#editar-ficha': 'clientes', '#excluir-cli': 'clientes',
  '[data-pagar]': 'pagamentos', '[data-desfazer]': 'pagamentos', '[data-cancelar]': 'pagamentos', '[data-aceitar]': 'pagamentos', '[data-recusar]': 'pagamentos',
  '#rodar-fila': 'envios', '#parar-fila': 'envios', '#enviar-agora': 'envios',
  '#ag-novo': 'agenda', '#ag-com': 'financeiro', '#ag-prof': 'agenda_config', '#ag-serv': 'agenda_config', '.ag-acao': 'agenda',
  '#wa-conectar': 'whatsapp', '#wa-sair': 'whatsapp', '#wa-teste': 'whatsapp',
  '#lancar-consumo': 'pagamentos', '#cobrar-fiado': 'pagamentos', '[data-del-consumo]': 'pagamentos',
  '#cx-venda': 'pagamentos', '[data-del-venda]': 'pagamentos', '#cx-mov': 'financeiro', '[data-del-mov]': 'financeiro', '#cx-prod': 'agenda_config',
};
function aplicarPermissoes(raiz) {
  for (const [sel, perm] of Object.entries(ACOES_PERM)) {
    if (!pode(perm)) $$(sel, raiz).forEach((e) => e.classList.add('hidden'));
  }
}
new MutationObserver(() => { if (EU) { aplicarPermissoes($('#conteudo')); aplicarPermissoes($('#modal-caixa')); } })
  .observe(document.body, { childList: true, subtree: true });

async function atualizarIndicadores() {
  try {
    const st = await api('/whatsapp/estado');
    $('#badge-wa').className = 'ponto ' + (st.conectado ? 'on' : 'off');
    const comp = await api('/comprovantes');
    const b = $('#badge-comp');
    b.textContent = comp.length; b.classList.toggle('hidden', !comp.length);
  } catch { /* ignora */ }
}

let intervaloIndicadores = null;
async function iniciar() {
  try { EU = await api('/me'); } catch { return; }
  CONFIG = await api('/config');
  await carregarMarca();
  $$('#menu a').forEach((a) => {
    const p = PAGINAS[a.dataset.pg];
    a.classList.toggle('hidden', !!(p && p[2] && !pode(p[2])));
  });
  $('#eu-nome').textContent = EU.nome;
  $('#topo-data').textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });
  $('#app').classList.remove('hidden');
  atualizarIndicadores();
  clearInterval(intervaloIndicadores);
  intervaloIndicadores = setInterval(atualizarIndicadores, 30000);
  rotear();
}

function modalMinhaSenha() {
  abrirModal(`<form id="f-senha">
    <div class="modal-topo"><h2>Trocar minha senha</h2><button type="button" class="fechar" data-fechar>×</button></div>
    <div class="modal-corpo">
      <label>Senha atual<input type="password" name="atual" required autocomplete="current-password"></label>
      <label>Nova senha<input type="password" name="nova" required minlength="6" autocomplete="new-password"></label>
      <label>Repita a nova senha<input type="password" name="nova2" required minlength="6" autocomplete="new-password"></label>
      <p class="erro-txt" id="senha-erro"></p>
    </div>
    <div class="modal-rodape"><button type="button" class="btn" data-fechar>Cancelar</button><button class="btn primario">Salvar</button></div></form>`);
  $('#f-senha').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.nova.value !== f.nova2.value) return $('#senha-erro').textContent = 'As senhas não conferem';
    try { await api('/me/senha', { method: 'POST', body: { atual: f.atual.value, nova: f.nova.value } }); fecharModal(); toast('Senha alterada ✓'); }
    catch (err) { $('#senha-erro').textContent = err.message; }
  };
}

// ---------- Painel ----------
async function pgPainel(el) {
  const d = await api('/painel');
  HOJE = d.hoje;
  const hora = new Date().getHours();
  const saud = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';
  const dataExt = new Date(d.hoje + 'T12:00').toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  const ex = d.execucao;
  el.innerHTML = `
    <div class="cabecalho">
      <div><div class="sobretitulo">PAINEL DE COBRANÇAS</div><h1>${saud} 👋</h1><div class="muted">Resumo de ${dataExt}.</div></div>
      <div class="acoes"><button class="btn primario" id="novo-cli">＋ Novo cliente</button></div>
    </div>
    ${d.agenda && d.agenda.usa_agenda ? `<div class="cartao" style="margin-bottom:14px"><div class="cartao-topo"><div><h2>Agenda de hoje</h2><div class="muted pequeno">${d.agenda.total} atendimento(s) · ${d.agenda.concluidos} concluído(s) · previsto ${brl(d.agenda.previsto)} · recebido ${brl(d.agenda.recebido)}</div></div><a class="btn" href="#/agenda">Abrir agenda →</a></div>
      ${d.agenda.proximos.length ? d.agenda.proximos.map((a) => `<div class="lista-item"><span class="ag-ponto" style="background:${esc(a.cor)}"></span><div class="cresce"><b>${a.inicio_local.slice(11)}</b> · ${esc(a.cliente_nome)} <span class="muted pequeno">${esc(a.servico_nome || '')} · ${esc(a.profissional_nome)}</span></div>${a.status === 'confirmado' ? '<span class="tag pago">Confirmado</span>' : '<span class="tag aberto">Agendado</span>'}</div>`).join('') : '<div class="vazio" style="padding:18px">Nenhum horário pendente para hoje.</div>'}</div>` : ''}
    ${d.comprovantes_pendentes ? `<div class="aviso">📎 ${d.comprovantes_pendentes} comprovante(s) aguardando sua conferência. <a href="#/comprovantes">Conferir agora →</a></div>` : ''}
    <div class="grade g4">
      <div class="cartao kpi"><div class="rotulo">Clientes ativos <span class="icone">♙</span></div><div class="valor">${d.ativos}</div><div class="det">Previsto no mês: ${brl(d.previsto_mes)}</div></div>
      <div class="cartao kpi"><div class="rotulo">Vencem hoje <span class="icone">◷</span></div><div class="valor">${d.vencem_hoje.n}</div><div class="det">${brl(d.vencem_hoje.v)} em cobranças</div></div>
      <div class="cartao kpi ${d.atraso.n ? 'alerta' : ''}"><div class="rotulo">Em atraso <span class="icone">!</span></div><div class="valor">${d.atraso.n}</div><div class="det">${brl(d.atraso.v)} pendentes</div></div>
      <div class="cartao kpi ok"><div class="rotulo">Recebido no mês <span class="icone">✓</span></div><div class="valor">${brl(d.recebido_mes.v)}</div><div class="det">${d.recebido_mes.n} pagamento(s) confirmado(s)</div></div>
    </div>
    <div class="grade g2" style="margin-top:14px">
      <div class="cartao">
        <div class="cartao-topo">
          <div><h2>Fila de hoje</h2><div class="muted pequeno">${d.fila.length} mensagem(ns) pela régua · ${d.enviados_hoje} enviada(s) hoje</div></div>
          <div class="acoes" id="acoes-fila"></div>
        </div>
        <div id="exec-box"></div>
        <div id="fila-lista">
          ${d.fila.length ? d.fila.map((f) => `
            <div class="lista-item">
              <div class="cresce"><div class="titulo">${esc(f.nome)}</div><div class="muted pequeno">${fone(f.telefone)} · venc. ${brData(f.vencimento)} · ${esc(f.etapa_nome)}</div></div>
              <div class="num"><b>${brl(f.valor)}</b></div>
              <button class="btn mini" data-previa="${f.cobranca_id}">Ver mensagem</button>
            </div>`).join('') : '<div class="vazio"><b>Nada para enviar hoje</b>A fila é montada conforme os vencimentos e a régua de cobrança.</div>'}
        </div>
      </div>
      <div class="cartao">
        <div class="cartao-topo"><div><h2>Envio automático</h2><div class="muted pequeno">${d.automatico ? `Ligado · todos os dias às ${esc(d.hora_envio)}` : 'Desligado'}</div></div>
          <span class="tag ${d.automatico ? 'enviado' : ''}">${d.automatico ? 'Ativo' : 'Inativo'}</span></div>
        <div class="cartao pad" style="border:0;box-shadow:none">
          ${d.automatico ? `<p class="muted pequeno">Última execução automática: ${d.ultima_execucao ? brData(d.ultima_execucao) : 'ainda não rodou'}.</p>` : '<p class="muted pequeno">Ligue em Configurações para o sistema enviar a régua sozinho todos os dias.</p>'}
        </div>
      </div>
    </div>`;
  $('#novo-cli').onclick = () => modalCliente(null, () => rotear());
  $$('[data-previa]').forEach((b) => b.onclick = () => modalPrevia(b.dataset.previa));
  desenharExecucao(ex, d.fila.length);
  timers.push(setInterval(async () => {
    const e = await api('/fila/estado').catch(() => null);
    if (e) desenharExecucao(e, d.fila.length);
  }, 3000));
}

function desenharExecucao(ex, tamFila) {
  const box = $('#exec-box'), ac = $('#acoes-fila');
  if (!box || !ac) return;
  if (ex.rodando) {
    const pct = ex.total ? Math.round((ex.feitos / ex.total) * 100) : 0;
    box.innerHTML = `<div style="padding:12px 18px;border-bottom:1px solid var(--borda)"><b>Enviando…</b> ${ex.feitos}/${ex.total} · ${ex.enviados} ok, ${ex.erros} erro(s)${ex.atual ? ` · agora: ${esc(ex.atual)}` : ''}
      <div class="barra"><div style="width:${pct}%"></div></div><div class="muted pequeno">Intervalo aleatório entre mensagens para proteger seu número.</div></div>`;
    ac.innerHTML = '<button class="btn perigo" id="parar-fila">Parar</button>';
    $('#parar-fila').onclick = async () => { await api('/fila/parar', { method: 'POST' }); toast('Parando após a mensagem atual…'); };
    box.dataset.rodou = '1';
  } else {
    if (box.dataset.rodou === '1') { box.dataset.rodou = ''; rotear(); return; }
    box.innerHTML = ex.fim ? `<div style="padding:10px 18px;border-bottom:1px solid var(--borda)" class="muted pequeno">Última execução: ${ex.enviados} enviada(s), ${ex.erros} erro(s)${ex.ultimoErro ? ` — ${esc(ex.ultimoErro)}` : ''}</div>` : '';
    ac.innerHTML = tamFila ? '<button class="btn primario" id="rodar-fila">▶ Enviar fila agora</button>' : '';
    const b = $('#rodar-fila');
    if (b) b.onclick = async () => {
      if (!(await confirmar('Enviar fila agora?', `Serão enviadas até ${tamFila} mensagem(ns) pelo WhatsApp, com intervalo entre elas.`, 'Enviar'))) return;
      try { const r = await api('/fila/executar', { method: 'POST' }); toast(`Enviando ${r.total} mensagem(ns)…`); }
      catch (e) { toast(e.message, true); }
    };
  }
}

async function modalPrevia(cobId) {
  const p = await api(`/cobrancas/${cobId}/previa`);
  abrirModal(`<div class="modal-topo"><h2>Mensagem · ${esc(p.etapa_nome)}</h2><button class="fechar" data-fechar>×</button></div>
    <div class="modal-corpo"><div class="previa">${esc(p.texto)}</div>
    ${p.pix ? `<div class="previa" style="margin-top:6px;font-family:ui-monospace,Menlo,monospace;font-size:11px;word-break:break-all">${esc(p.pix)}</div>` : '<div class="aviso" style="margin-top:10px">Cadastre a chave Pix em Configurações para enviar o Pix junto.</div>'}</div>
    <div class="modal-rodape"><button class="btn" data-fechar>Fechar</button><button class="btn primario" id="enviar-agora">Enviar agora</button></div>`);
  $('#enviar-agora').onclick = async () => {
    $('#enviar-agora').disabled = true;
    try { await api(`/cobrancas/${cobId}/enviar`, { method: 'POST' }); toast('Mensagem enviada ✓'); fecharModal(); rotear(); }
    catch (e) { toast(e.message, true); $('#enviar-agora').disabled = false; }
  };
}

// ---------- Clientes ----------
let filtroClientes = { busca: '', status: '' };
async function pgClientes(el) {
  const lista = await api('/clientes');
  el.innerHTML = `
    <div class="cabecalho"><div><h1>Clientes</h1><div class="muted">Cadastro e acompanhamento das mensalidades.</div></div>
      <div class="acoes"><a class="btn" href="/api/exportar/clientes.csv">↓ Exportar CSV</a><button class="btn primario" id="novo-cli">＋ Novo cliente</button></div></div>
    <div class="cartao">
      <div class="cartao-topo"><div class="filtros">
        <input id="busca" placeholder="Buscar por nome, telefone ou identificação" style="min-width:260px" value="${esc(filtroClientes.busca)}">
        <select id="f-status">
          <option value="">Todos</option><option value="atraso">Em atraso</option><option value="aberto">Em aberto no mês</option>
          <option value="pago">Pago no mês</option><option value="pausado">Pausados</option><option value="inativo">Inativos</option>
        </select></div><div class="muted pequeno" id="contagem"></div></div>
      <div class="tabela-wrap"><table>
        <thead><tr><th>Cliente</th><th>Telefone</th><th class="num">Valor</th><th>Forma</th><th>Próx. vencimento</th><th>Situação</th><th></th></tr></thead>
        <tbody id="tb"></tbody></table></div>
    </div>`;
  $('#f-status').value = filtroClientes.status;
  const desenhar = () => {
    const b = filtroClientes.busca.toLowerCase();
    const fil = lista.filter((c) => {
      if (b && !(`${c.nome} ${c.telefone} ${c.identificacao || ''}`.toLowerCase().includes(b))) return false;
      switch (filtroClientes.status) {
        case 'atraso': return c.atrasadas > 0;
        case 'aberto': return c.status_mes === 'aberto';
        case 'pago': return c.status_mes === 'pago';
        case 'pausado': return c.pausado;
        case 'inativo': return !c.ativo;
        default: return true;
      }
    });
    $('#contagem').textContent = `${fil.length} de ${lista.length}`;
    $('#tb').innerHTML = fil.length ? fil.map((c) => {
      let sit;
      if (!c.ativo) sit = '<span class="tag">Inativo</span>';
      else if (c.atrasadas) sit = `<span class="tag atrasado">${c.atrasadas} em atraso · ${brl(c.valor_atrasado)}</span>`;
      else if (c.proxima) sit = statusCobranca(c.proxima);
      else sit = '<span class="tag pago">Em dia</span>';
      if (c.pausado) sit += ' <span class="tag pausado">Régua pausada</span>';
      const prox = c.proxima ? `${brData(c.proxima.vencimento)}${c.proxima.numero_parcela ? ` · ${c.proxima.numero_parcela}/${c.parcelas_total}` : ''}${Number(c.proxima.valor) !== Number(c.valor) ? `<div class="sub2">${brl(c.proxima.valor)}</div>` : ''}` : '—';
      return `<tr>
        <td><a href="#" data-ver="${c.id}"><b>${esc(c.nome)}</b></a><div class="sub2">${esc(c.identificacao || '')}</div></td>
        <td>${fone(c.telefone)}</td>
        <td class="num">${c.forma === 'avulso' ? '—' : brl(c.valor)}</td>
        <td>${esc(formaCliente(c))}${Number(c.fiado_pendente) ? `<div class="sub2"><span class="tag hoje">fiado ${brl(c.fiado_pendente)}</span></div>` : ''}</td>
        <td>${prox}</td>
        <td>${sit}</td>
        <td class="num"><button class="btn mini" data-ver="${c.id}">Abrir</button> <button class="btn mini" data-editar="${c.id}">Editar</button></td>
      </tr>`;
    }).join('') : `<tr><td colspan="7" class="vazio"><b>${lista.length ? 'Nenhum cliente encontrado' : 'Nenhum cliente cadastrado'}</b>${lista.length ? 'Ajuste a busca ou o filtro.' : 'Clique em “Novo cliente” para começar.'}</td></tr>`;
    $$('[data-ver]').forEach((a) => a.onclick = (e) => { e.preventDefault(); modalFichaCliente(a.dataset.ver); });
    $$('[data-editar]').forEach((a) => a.onclick = () => modalCliente(lista.find((c) => c.id == a.dataset.editar), () => rotear()));
  };
  $('#busca').oninput = (e) => { filtroClientes.busca = e.target.value; desenhar(); };
  $('#f-status').onchange = (e) => { filtroClientes.status = e.target.value; desenhar(); };
  $('#novo-cli').onclick = () => modalCliente(null, () => rotear());
  desenhar();
}

function modalCliente(c, aoSalvar) {
  const novo = !c;
  c = c || { forma: 'mensal', dia_vencimento: 10, ativo: true };
  const diaSem = c.dia_semana ?? (c.primeiro_vencimento ? new Date(c.primeiro_vencimento + 'T12:00').getDay() : 5);
  abrirModal(`
    <form id="f-cli">
      <div class="modal-topo"><h2>${novo ? 'Novo cliente' : 'Editar cliente'}</h2><button type="button" class="fechar" data-fechar>×</button></div>
      <div class="modal-corpo">
        <label>Nome do cliente *<input name="nome" required value="${esc(c.nome || '')}"></label>
        <div class="linha">
          <label>WhatsApp com DDD *<input name="telefone" required placeholder="51 99999-9999" value="${esc(c.telefone ? fone(c.telefone) : '')}"></label>
          <label>Forma de cobrança<select name="forma">
            <option value="mensal">Mensalidade (todo mês)</option>
            <option value="semanal">Semanal (toda semana)</option>
            <option value="quinzenal">Quinzenal (a cada 15 dias)</option>
            <option value="carne">Carnê (parcelas mensais)</option>
            <option value="avulso">Só avulso / fiado (sem valor fixo)</option>
          </select></label>
        </div>
        <div class="linha3">
          <label class="f-valor">Valor (R$) *<input name="valor" inputmode="decimal" value="${c.valor != null && c.forma !== 'avulso' ? String(c.valor).replace('.', ',') : ''}"></label>
          <label class="f-mes">Dia do vencimento *<input name="dia_vencimento" type="number" min="1" max="31" value="${c.dia_vencimento || ''}"></label>
          <label class="f-sem">Dia da semana *<select name="dia_semana">${DIAS_SEMANA.map((d, i) => `<option value="${i}" ${i === Number(diaSem) ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
          <label class="f-parc">Nº de parcelas<input name="parcelas_total" type="number" min="1" value="${c.parcelas_total || ''}"></label>
        </div>
        <label class="f-prim">Primeiro vencimento<input name="primeiro_vencimento" type="date" value="${c.primeiro_vencimento || ''}">
          <div class="ajuda" id="ajuda-prim"></div></label>
        <div class="aviso info pequeno f-avulso">Cliente sem cobrança fixa: use <b>Lançar consumo</b> na ficha dele para cobrar um corte avulso ou pendurar no fiado.</div>
        <div class="linha">
          <label>Identificação (opcional)<input name="identificacao" placeholder="ex.: apelido, empresa" value="${esc(c.identificacao || '')}"></label>
          <label>Endereço (opcional)<input name="endereco" value="${esc(c.endereco || '')}"></label>
        </div>
        <label>Observações<textarea name="observacoes" style="min-height:60px">${esc(c.observacoes || '')}</textarea></label>
        <label class="check"><input type="checkbox" name="ativo" ${c.ativo !== false ? 'checked' : ''}> Cliente ativo (gera cobranças)</label>
        <label class="check"><input type="checkbox" name="pausado" ${c.pausado ? 'checked' : ''}> Pausar lembretes automáticos para este cliente</label>
        <p class="erro-txt" id="cli-erro"></p>
      </div>
      <div class="modal-rodape">
        ${novo ? '' : '<button type="button" class="btn perigo" id="excluir-cli" style="margin-right:auto">Excluir</button>'}
        <button type="button" class="btn" data-fechar>Cancelar</button><button class="btn primario">Salvar cliente</button>
      </div>
    </form>`);
  const f = $('#f-cli');
  f.forma.value = c.forma || 'mensal';
  const tg = () => {
    const fm = f.forma.value;
    const per = fm === 'semanal' || fm === 'quinzenal';
    $('.f-valor', f).classList.toggle('hidden', fm === 'avulso');
    $('.f-mes', f).classList.toggle('hidden', per || fm === 'avulso');
    $('.f-sem', f).classList.toggle('hidden', !per);
    $('.f-parc', f).classList.toggle('hidden', fm !== 'carne');
    $('.f-prim', f).classList.toggle('hidden', fm === 'avulso');
    $('.f-avulso', f).classList.toggle('hidden', fm !== 'avulso');
    $('#ajuda-prim').textContent = per
      ? 'Em branco = no próximo dia da semana escolhido. Se informar a data, o dia da semana segue ela.'
      : (novo ? 'Deixe em branco para usar o próximo dia de vencimento.' : 'Alterar não apaga cobranças já geradas.');
  };
  f.forma.onchange = tg; tg();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(f));
    body.ativo = f.ativo.checked; body.pausado = f.pausado.checked;
    if (!novo && (body.forma === 'semanal' || body.forma === 'quinzenal') && Number(body.dia_semana) !== Number(c.dia_semana) && body.primeiro_vencimento === c.primeiro_vencimento) body.primeiro_vencimento = '';
    try {
      await api(novo ? '/clientes' : `/clientes/${c.id}`, { method: novo ? 'POST' : 'PUT', body });
      fecharModal(); toast('Cliente salvo ✓'); aoSalvar && aoSalvar();
    } catch (err) { $('#cli-erro').textContent = err.message; }
  };
  const ex = $('#excluir-cli');
  if (ex) ex.onclick = async () => {
    if (!(await confirmar('Excluir cliente?', `Isso apaga <b>${esc(c.nome)}</b> e todo o histórico de cobranças e mensagens. Para só parar de cobrar, desmarque “Cliente ativo”.`, 'Excluir', true))) return;
    await api(`/clientes/${c.id}`, { method: 'DELETE' }); toast('Cliente excluído'); rotear();
  };
}

async function modalFichaCliente(id) {
  const [c, consumos] = await Promise.all([api(`/clientes/${id}`), api(`/clientes/${id}/consumos`)]);
  const pend = consumos.filter((x) => !x.cobranca_id);
  const totPend = pend.reduce((t, x) => t + Number(x.valor), 0);
  const sitConsumo = (x) => {
    if (!x.cobranca_id) return '<span class="tag hoje">Pendurado</span>';
    if (x.cob_status === 'pago') return '<span class="tag pago">Pago</span>';
    if (x.cob_status === 'cancelado') return '<span class="tag">Cancelado</span>';
    return `<span class="tag aberto">Na cobrança de ${brData(x.cob_vencimento)}</span>`;
  };
  abrirModal(`
    <div class="modal-topo"><div><h2>${esc(c.nome)}</h2><div class="muted pequeno">${fone(c.telefone)} · ${c.forma === 'avulso' ? '' : brl(c.valor) + ' · '}${esc(formaCliente(c))}</div></div><button class="fechar" data-fechar>×</button></div>
    <div class="modal-corpo">
      ${c.observacoes ? `<div class="aviso info">${esc(c.observacoes)}</div>` : ''}
      <div class="cartao-topo" style="padding:0;margin-bottom:8px;border:0"><h3 style="margin:0">Consumo avulso / fiado</h3>
        <div class="acoes"><button class="btn mini primario" id="lancar-consumo">＋ Lançar consumo</button>${totPend ? `<button class="btn mini" id="cobrar-fiado">Cobrar fiado agora (${brl(totPend)})</button>` : ''}</div></div>
      ${totPend ? `<div class="aviso pequeno">Fiado pendurado: <b>${brl(totPend)}</b>. ${c.forma === 'avulso' ? 'Clique em “Cobrar fiado agora” para mandar a cobrança.' : 'Entra sozinho na próxima cobrança do cliente.'}</div>` : ''}
      ${consumos.length ? `<div class="tabela-wrap cartao" style="margin-bottom:16px"><table><thead><tr><th>Data</th><th>Descrição</th><th class="num">Valor</th><th>Situação</th><th></th></tr></thead><tbody>
        ${consumos.slice(0, 30).map((x) => `<tr><td>${brData(x.data)}</td><td>${esc(x.descricao)}${x.origem === 'agenda' ? ' <span class="sub2">agenda</span>' : x.origem === 'produto' ? ' <span class="sub2">produto</span>' : ''}</td><td class="num">${brl(x.valor)}</td><td>${sitConsumo(x)}</td>
          <td class="num">${x.cob_status === 'pago' ? '' : `<button class="btn mini" data-del-consumo="${x.id}" title="Excluir lançamento">✕</button>`}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted pequeno" style="margin-bottom:16px">Nenhum consumo lançado.</p>'}
      <h3>Cobranças</h3>
      <div class="tabela-wrap cartao" style="margin-bottom:16px"><table><thead><tr><th>Referente a</th><th>Vencimento</th><th class="num">Valor</th><th>Situação</th><th></th></tr></thead><tbody>
      ${c.cobrancas.map((cb) => `<tr><td>${esc(refCobranca(cb, c.forma))}${cb.numero_parcela ? ` <span class="sub2">(${cb.numero_parcela}/${c.parcelas_total})</span>` : ''}${cb.tipo === 'avulsa' ? ' <span class="tag">avulsa</span>' : ''}</td>
        <td>${brData(cb.vencimento)}</td><td class="num">${brl(cb.valor)}</td>
        <td>${statusCobranca(cb)}${cb.pago_em ? `<div class="sub2">pago ${brData(cb.pago_em)}</div>` : ''}</td>
        <td class="num">${acoesCobranca(cb)}</td></tr>`).join('') || '<tr><td colspan="5" class="vazio">Sem cobranças</td></tr>'}
      </tbody></table></div>
      <h3>Cobranças enviadas pelo WhatsApp</h3>
      ${c.mensagens.filter((m) => m.direcao === 'saida').map((m) => `<div class="pequeno" style="padding:7px 0;border-bottom:1px solid var(--borda)"><span class="tag ${m.status}">${m.direcao === 'entrada' ? 'Recebida' : m.status === 'enviado' ? 'Enviada' : 'Erro'}</span> <span class="muted">${brDataHora(m.criado_em)}</span>
        <div style="white-space:pre-wrap;margin-top:4px">${esc(m.erro ? 'Erro: ' + m.erro : m.texto)}</div></div>`).join('') || '<p class="muted pequeno">Nenhuma cobrança enviada ainda.</p>'}
    </div>
    <div class="modal-rodape"><button class="btn" id="editar-ficha">Editar cliente</button><button class="btn primario" data-fechar>Fechar</button></div>`, true);
  ligarAcoesCobranca($('#modal-caixa'), () => modalFichaCliente(id));
  $('#editar-ficha').onclick = () => modalCliente(c, () => rotear());
  $('#lancar-consumo').onclick = () => modalConsumo(c, () => modalFichaCliente(id));
  const cf = $('#cobrar-fiado');
  if (cf) cf.onclick = async () => {
    const enviar = await confirmar('Cobrar o fiado agora?', `Gera uma cobrança de <b>${brl(totPend)}</b> com vencimento hoje e manda no WhatsApp com o Pix.`, 'Cobrar e enviar');
    if (!enviar) return modalFichaCliente(id);
    try { const r = await api(`/clientes/${id}/fiado/cobrar`, { method: 'POST', body: { enviar: true } }); toast(r.aviso || 'Cobrança enviada ✓', !!r.aviso); }
    catch (e) { toast(e.message, true); }
    modalFichaCliente(id);
  };
  $$('[data-del-consumo]').forEach((b) => b.onclick = async () => {
    if (!(await confirmar('Excluir lançamento?', 'O valor sai da cobrança em que ele entrou (se ainda não foi paga).', 'Excluir', true))) return modalFichaCliente(id);
    try { await api(`/consumos/${b.dataset.delConsumo}`, { method: 'DELETE' }); toast('Lançamento excluído'); } catch (e) { toast(e.message, true); }
    modalFichaCliente(id);
  });
}

function acoesCobranca(cb) {
  if (cb.status === 'pago') return `<button class="btn mini" data-desfazer="${cb.id}">Desfazer</button>`;
  if (cb.status === 'cancelado') return '';
  return `<button class="btn mini btn-wa" data-previa-cob="${cb.id}">WhatsApp</button> <button class="btn mini" data-pix="${cb.id}">Pix</button> <button class="btn mini verde" data-pagar="${cb.id}" data-valor="${cb.valor}">Pago</button> <button class="btn mini" data-cancelar="${cb.id}" title="Cancelar esta cobrança">✕</button>`;
}

function ligarAcoesCobranca(raiz, recarregar) {
  $$('[data-pagar]', raiz).forEach((b) => b.onclick = () => modalPagar(b.dataset.pagar, b.dataset.valor, recarregar));
  $$('[data-desfazer]', raiz).forEach((b) => b.onclick = async () => {
    await api(`/cobrancas/${b.dataset.desfazer}/desfazer`, { method: 'POST' }); toast('Pagamento desfeito'); recarregar();
  });
  $$('[data-cancelar]', raiz).forEach((b) => b.onclick = async () => {
    if (!(await confirmar('Cancelar cobrança?', 'Esta cobrança não será mais enviada nem contada como pendente.', 'Cancelar cobrança', true))) return;
    await api(`/cobrancas/${b.dataset.cancelar}/cancelar`, { method: 'POST' }); toast('Cobrança cancelada'); recarregar();
  });
  $$('[data-previa-cob]', raiz).forEach((b) => b.onclick = () => modalPrevia(b.dataset.previaCob));
  $$('[data-pix]', raiz).forEach((b) => b.onclick = async () => {
    try {
      const p = await api(`/cobrancas/${b.dataset.pix}/pix`);
      abrirModal(`<div class="modal-topo"><h2>Pix · ${esc(p.cliente)}</h2><button class="fechar" data-fechar>×</button></div>
        <div class="modal-corpo" style="text-align:center"><img src="${p.qr}" style="width:240px;height:240px"><div class="codigo" style="text-align:left">${esc(p.codigo)}</div></div>
        <div class="modal-rodape"><button class="btn" data-fechar>Fechar</button><button class="btn primario" id="copiar-pix">Copiar código</button></div>`);
      $('#copiar-pix').onclick = () => { navigator.clipboard.writeText(p.codigo); toast('Código copiado ✓'); };
    } catch (e) { toast(e.message, true); }
  });
}

function modalPagar(id, valor, aoSalvar) {
  abrirModal(`<form id="f-pg">
    <div class="modal-topo"><h2>Confirmar pagamento</h2><button type="button" class="fechar" data-fechar>×</button></div>
    <div class="modal-corpo">
      <div class="linha"><label>Data do pagamento<input type="date" name="data" value="${HOJE}"></label>
      <label>Valor recebido (R$)<input name="valor" inputmode="decimal" value="${String(valor).replace('.', ',')}"></label></div>
      <label>Forma<select name="forma"><option value="pix">Pix</option><option value="dinheiro">Dinheiro</option><option value="debito">Cartão de débito</option><option value="cartao">Cartão de crédito</option><option value="transferencia">Transferência</option><option value="boleto">Boleto</option></select></label>
      <label>Observação<input name="obs"></label>
      <label class="check"><input type="checkbox" name="agradecer" ${CONFIG.agradecer_pagamento ? 'checked' : ''}> Enviar mensagem de agradecimento no WhatsApp</label>
    </div>
    <div class="modal-rodape"><button type="button" class="btn" data-fechar>Cancelar</button><button class="btn verde">Confirmar pagamento</button></div></form>`);
  $('#f-pg').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api(`/cobrancas/${id}/pagar`, { method: 'POST', body: { data: f.data.value, valor: f.valor.value.replace(',', '.'), forma: f.forma.value, obs: f.obs.value, agradecer: f.agradecer.checked } });
      fecharModal(); toast('Pagamento registrado ✓'); aoSalvar && aoSalvar();
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- Cobranças ----------
let mesCob = null;
let filtroCob = '';
async function pgCobrancas(el) {
  mesCob = mesCob || new Date().toISOString().slice(0, 7);
  const d = await api(`/cobrancas?mes=${mesCob}`);
  HOJE = d.hoje;
  const [y, m] = d.mes.split('-').map(Number);
  const r = d.resumo;
  const pct = r.previsto ? Math.round((r.recebido / r.previsto) * 100) : 0;
  el.innerHTML = `
    <div class="cabecalho"><div><h1>Cobranças</h1><div class="muted">Mensalidades, semanais, parcelas e avulsas do mês.</div></div>
      <div class="acoes"><button class="btn" id="mes-ant">←</button><b style="min-width:140px;text-align:center">${MESES[m - 1]} ${y}</b><button class="btn" id="mes-prox">→</button>
      <a class="btn" href="/api/exportar/cobrancas.csv?mes=${d.mes}">↓ CSV</a></div></div>
    ${d.anteriores.n ? `<div class="aviso">Há ${d.anteriores.n} cobrança(s) de meses anteriores ainda em aberto (${brl(d.anteriores.v)}). <a href="#" id="ver-atrasadas">Ver lista →</a></div>` : ''}
    <div class="grade g4">
      <div class="cartao kpi"><div class="rotulo">Previsto</div><div class="valor">${brl(r.previsto)}</div><div class="det">${r.qtd} cobrança(s)</div></div>
      <div class="cartao kpi ok"><div class="rotulo">Recebido</div><div class="valor">${brl(r.recebido)}</div><div class="det">${r.pagos} pago(s) · ${pct}%</div></div>
      <div class="cartao kpi"><div class="rotulo">Em aberto</div><div class="valor">${brl(r.aberto)}</div><div class="det">a receber no mês</div></div>
      <div class="cartao kpi ${r.atrasado ? 'alerta' : ''}"><div class="rotulo">Atrasado</div><div class="valor">${brl(r.atrasado)}</div><div class="det">vencido e não pago</div></div>
    </div>
    <div class="cartao" style="margin-top:14px">
      <div class="cartao-topo"><h2>Lista do mês</h2><div class="filtros"><select id="f-cob"><option value="">Todos</option><option value="aberto">Em aberto</option><option value="atrasado">Atrasados</option><option value="pago">Pagos</option></select></div></div>
      <div class="tabela-wrap"><table><thead><tr><th>Cliente</th><th>Vencimento</th><th class="num">Valor</th><th>Situação</th><th>Lembretes</th><th></th></tr></thead><tbody id="tb-cob"></tbody></table></div>
    </div>`;
  $('#f-cob').value = filtroCob;
  const desenhar = () => {
    const itens = d.itens.filter((cb) => {
      if (filtroCob === 'aberto') return cb.status === 'aberto';
      if (filtroCob === 'atrasado') return cb.status === 'aberto' && cb.vencimento < HOJE;
      if (filtroCob === 'pago') return cb.status === 'pago';
      return true;
    });
    $('#tb-cob').innerHTML = itens.length ? itens.map((cb) => `<tr>
      <td><b>${esc(cb.nome)}</b> ${cb.tipo === 'avulsa' ? '<span class="tag">avulsa</span>' : ''}<div class="sub2">${fone(cb.telefone)} · ${esc(refCobranca(cb, cb.forma))}${cb.numero_parcela ? ` · parcela ${cb.numero_parcela}/${cb.parcelas_total}` : ''}</div></td>
      <td>${brData(cb.vencimento)}</td>
      <td class="num">${brl(cb.valor)}${cb.pago_valor && cb.pago_valor !== cb.valor ? `<div class="sub2">pago ${brl(cb.pago_valor)}</div>` : ''}</td>
      <td>${statusCobranca(cb)}${cb.pago_em ? `<div class="sub2">em ${brData(cb.pago_em)}</div>` : ''}</td>
      <td class="pequeno muted">${cb.qtd_msgs ? `${cb.qtd_msgs} enviado(s)<br>último ${brDataHora(cb.ultima_msg)}` : '—'}</td>
      <td class="num">${acoesCobranca(cb)}</td></tr>`).join('') : '<tr><td colspan="6" class="vazio"><b>Nenhuma cobrança</b>Cadastre clientes para gerar as cobranças do mês.</td></tr>';
    ligarAcoesCobranca($('#tb-cob'), rotear);
  };
  $('#f-cob').onchange = (e) => { filtroCob = e.target.value; desenhar(); };
  const mudar = (n) => { const dt = new Date(y, m - 1 + n, 1); mesCob = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`; rotear(); };
  $('#mes-ant').onclick = () => mudar(-1);
  $('#mes-prox').onclick = () => mudar(1);
  const va = $('#ver-atrasadas');
  if (va) va.onclick = async (e) => {
    e.preventDefault();
    const lista = await api('/cobrancas/atrasadas');
    abrirModal(`<div class="modal-topo"><h2>Cobranças em atraso</h2><button class="fechar" data-fechar>×</button></div>
      <div class="modal-corpo"><div class="tabela-wrap cartao"><table><thead><tr><th>Cliente</th><th>Vencimento</th><th class="num">Valor</th><th></th></tr></thead><tbody>
      ${lista.map((cb) => `<tr><td><b>${esc(cb.nome)}</b></td><td>${brData(cb.vencimento)} ${statusCobranca(cb)}</td><td class="num">${brl(cb.valor)}</td><td class="num">${acoesCobranca(cb)}</td></tr>`).join('')}
      </tbody></table></div></div>`, true);
    ligarAcoesCobranca($('#modal-caixa'), rotear);
  };
  desenhar();
}

// ---------- Comprovantes ----------
let statusComp = 'pendente';
async function pgComprovantes(el) {
  const lista = await api(`/comprovantes?status=${statusComp}`);
  el.innerHTML = `
    <div class="cabecalho"><div><h1>Comprovantes</h1><div class="muted">Imagens e PDFs que os clientes mandam pelo WhatsApp. Confira no app do banco e confirme.</div></div>
      <div class="acoes"><select id="f-comp" style="width:auto;margin:0"><option value="pendente">Para conferir</option><option value="aceito">Confirmados</option><option value="recusado">Recusados</option></select></div></div>
    ${lista.length ? `<div class="comp-grade">${lista.map((cp) => `
      <div class="cartao">
        <div class="comp-img" data-abrir="${cp.id}">${!cp.tem_arquivo ? '<span class="muted">Arquivo indisponível</span>' : cp.mimetype && cp.mimetype.startsWith('image/') ? `<img src="/api/comprovantes/${cp.id}/arquivo" loading="lazy">` : `<span style="font-size:40px">📄</span>`}</div>
        <div class="comp-corpo">
          <div style="display:flex;justify-content:space-between;gap:8px"><b>${esc(cp.nome || cp.nome_contato || fone(cp.telefone))}</b><span class="muted pequeno">${brDataHora(cp.recebido_em)}</span></div>
          ${cp.legenda ? `<div class="muted pequeno" style="margin-top:4px">“${esc(cp.legenda)}”</div>` : ''}
          ${cp.status === 'pendente' ? `
            <label style="margin-top:10px">Referente a
              <select data-cob="${cp.id}">${cp.abertas.length ? cp.abertas.map((a) => `<option value="${a.id}" ${a.id === cp.cobranca_id ? 'selected' : ''}>Venc. ${brData(a.vencimento)} · ${brl(a.valor)}</option>`).join('') : '<option value="">Nenhuma cobrança em aberto</option>'}</select></label>
            <div class="acoes"><button class="btn verde" data-aceitar="${cp.id}" ${cp.abertas.length ? '' : 'disabled'}>✓ Confirmar pagamento</button><button class="btn perigo" data-recusar="${cp.id}">Recusar</button></div>`
            : `<div style="margin-top:8px"><span class="tag ${cp.status}">${cp.status === 'aceito' ? 'Confirmado' : 'Recusado'}</span> ${cp.vencimento ? `<span class="muted pequeno">venc. ${brData(cp.vencimento)} · ${brl(cp.valor)}</span>` : ''}</div>`}
        </div>
      </div>`).join('')}</div>`
      : `<div class="cartao vazio"><b>${statusComp === 'pendente' ? 'Nenhum comprovante para conferir' : 'Nada por aqui'}</b>Quando um cliente mandar foto ou PDF do comprovante no WhatsApp, ele aparece aqui.</div>`}`;
  $('#f-comp').value = statusComp;
  $('#f-comp').onchange = (e) => { statusComp = e.target.value; rotear(); };
  $$('[data-abrir]').forEach((d) => d.onclick = () => window.open(`/api/comprovantes/${d.dataset.abrir}/arquivo`, '_blank'));
  $$('[data-aceitar]').forEach((b) => b.onclick = async () => {
    const cob = $(`[data-cob="${b.dataset.aceitar}"]`).value;
    b.disabled = true;
    try { await api(`/comprovantes/${b.dataset.aceitar}/aceitar`, { method: 'POST', body: { cobranca_id: cob } }); toast('Pagamento confirmado ✓'); atualizarIndicadores(); rotear(); }
    catch (e) { toast(e.message, true); b.disabled = false; }
  });
  $$('[data-recusar]').forEach((b) => b.onclick = async () => {
    await api(`/comprovantes/${b.dataset.recusar}/recusar`, { method: 'POST' }); toast('Comprovante recusado'); atualizarIndicadores(); rotear();
  });
}

// ---------- WhatsApp ----------
async function pgWhatsapp(el) {
  const st = await api('/whatsapp/estado');
  el.innerHTML = `
    <div class="cabecalho"><div><h1>WhatsApp</h1><div class="muted">Conexão do número que envia as cobranças.</div></div></div>
    <div class="grade g2">
      <div class="cartao pad" id="wa-box"></div>
      <div class="cartao pad">
        <h3>Recomendações para não ter o número bloqueado</h3>
        <ul class="passos">
          <li>Use um <b>número separado</b> (chip só para cobranças), de preferência com WhatsApp Business.</li>
          <li>Antes de começar, converse normalmente com o número por alguns dias.</li>
          <li>Mande só para clientes que já conhecem o número; peça para salvarem o contato.</li>
          <li>Mantenha o intervalo entre mensagens (padrão 25–70 s) e o limite diário.</li>
          <li>Evite textos idênticos em massa: os modelos usam o nome e o valor de cada um.</li>
        </ul>
      </div>
    </div>`;
  desenharWa(st);
}

function desenharWa(st) {
  const box = $('#wa-box');
  if (!box) return;
  if (st.estado === 'offline' || st.estado === 'erro') {
    box.innerHTML = `<h3>Serviço do WhatsApp indisponível</h3><div class="aviso">${esc(st.erro || 'A Evolution API não respondeu.')}</div>
      <p class="muted pequeno">No Mac, confira se o Docker está aberto e rode novamente o <b>iniciar.command</b>.</p><button class="btn" id="wa-tentar">Tentar de novo</button>`;
    $('#wa-tentar').onclick = rotear;
    return;
  }
  if (st.conectado) {
    box.innerHTML = `<div class="aviso ok">✓ Conectado${st.numero ? ` ao número <b>${fone(st.numero)}</b>` : ''}${st.nome ? ` (${esc(st.nome)})` : ''}</div>
      <h3>Enviar mensagem de teste</h3>
      <div class="filtros"><input id="wa-num" placeholder="51 99999-9999" style="min-width:200px"><button class="btn primario" id="wa-teste">Enviar teste</button></div>
      <p class="muted pequeno" style="margin-top:20px">Para trocar de número, desconecte e escaneie o QR code com o outro aparelho.</p>
      <button class="btn perigo" id="wa-sair">Desconectar</button>`;
    $('#wa-teste').onclick = async () => {
      try { await api('/whatsapp/teste', { method: 'POST', body: { numero: $('#wa-num').value } }); toast('Mensagem de teste enviada ✓'); }
      catch (e) { toast(e.message, true); }
    };
    $('#wa-sair').onclick = async () => {
      if (!(await confirmar('Desconectar WhatsApp?', 'O envio automático para até você conectar de novo.', 'Desconectar', true))) return;
      await api('/whatsapp/desconectar', { method: 'POST' }); toast('Desconectado'); rotear(); atualizarIndicadores();
    };
    atualizarIndicadores();
    return;
  }
  box.innerHTML = `<h3>Conectar seu WhatsApp</h3>
    <ol class="passos"><li>Clique em <b>Gerar QR code</b>.</li><li>No celular, abra o WhatsApp → <b>Configurações → Aparelhos conectados → Conectar um aparelho</b>.</li><li>Aponte a câmera para o QR code abaixo.</li></ol>
    <div class="qr" id="wa-qr"><span class="muted">QR code aparece aqui</span></div>
    <div id="wa-cod" class="muted pequeno"></div>
    <button class="btn primario" id="wa-conectar">Gerar QR code</button>`;
  $('#wa-conectar').onclick = conectarWa;
}

async function conectarWa() {
  const b = $('#wa-conectar');
  b.disabled = true; b.textContent = 'Gerando…';
  try {
    const r = await api('/whatsapp/conectar', { method: 'POST' });
    if (r.conectado) { toast('WhatsApp conectado ✓'); return rotear(); }
    if (r.qr) $('#wa-qr').innerHTML = `<img src="${r.qr}">`;
    else $('#wa-qr').innerHTML = '<span class="muted">Aguardando QR… clique de novo em alguns segundos</span>';
    $('#wa-cod').textContent = r.codigo ? `Ou use o código de pareamento: ${r.codigo}` : '';
    b.disabled = false; b.textContent = 'Gerar novo QR code';
    limparTimers();
    let n = 0;
    timers.push(setInterval(async () => {
      n++;
      const st = await api('/whatsapp/estado').catch(() => null);
      if (st && st.conectado) { limparTimers(); toast('WhatsApp conectado ✓'); rotear(); atualizarIndicadores(); }
      else if (n % 12 === 0) conectarWa(); // QR expira ~40s
    }, 3500));
  } catch (e) { toast(e.message, true); b.disabled = false; b.textContent = 'Gerar QR code'; }
}

// ---------- Configurações ----------
async function pgConfig(el) {
  const c = await api('/config');
  CONFIG = c;
  const opcoesDias = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30];
  const nomeDia = (d) => d < 0 ? `${-d} dia(s) antes` : d === 0 ? 'No dia do vencimento' : `${d} dia(s) depois`;
  el.innerHTML = `
    <div class="cabecalho"><div><h1>Configurações</h1><div class="muted">Pix, régua de cobrança e envio automático.</div></div>
      <div class="acoes"><a class="btn" href="/api/exportar/backup.json">↓ Backup</a><button class="btn primario" id="salvar-cfg">Salvar configurações</button></div></div>
    <form id="f-cfg">
    <div class="grade g2">
      <div>
        <div class="cartao pad" style="margin-bottom:14px">
          <h3>Empresa e Pix</h3>
          <label>Nome que aparece para o cliente<input name="empresa" value="${esc(c.empresa)}"></label>
          <div class="linha">
            <label>Tipo da chave Pix<select name="pix_tipo"><option value="cpf">CPF</option><option value="cnpj">CNPJ</option><option value="telefone">Telefone</option><option value="email">E-mail</option><option value="aleatoria">Chave aleatória</option></select></label>
            <label>Chave Pix<input name="pix_chave" value="${esc(c.pix_chave)}"></label>
          </div>
          <div class="linha">
            <label>Nome do recebedor (como no banco)<input name="pix_nome" value="${esc(c.pix_nome)}" placeholder="ex.: MATEUS MOTTA"></label>
            <label>Cidade<input name="pix_cidade" value="${esc(c.pix_cidade)}"></label>
          </div>
          <label class="check"><input type="checkbox" name="enviar_pix_copia_cola" ${c.enviar_pix_copia_cola ? 'checked' : ''}> Enviar o “Pix copia e cola” já com o valor (mensagem separada, fácil de copiar)</label>
          <label class="check"><input type="checkbox" name="enviar_qr_code" ${c.enviar_qr_code ? 'checked' : ''}> Enviar também a imagem do QR code</label>
        </div>
        <div class="cartao pad">
          <h3>Régua de cobrança</h3>
          <p class="muted pequeno">Cada cliente recebe no máximo uma mensagem por dia. Se o sistema ficar desligado, ele manda só a etapa mais recente (até ${c.tolerancia_dias} dia(s) de atraso da etapa).</p>
          <div class="vars">Campos: ${['primeiro_nome', 'nome', 'valor', 'vencimento', 'descricao', 'dias_atraso', 'empresa', 'parcela', 'mes', 'total_aberto', 'pix'].map((v) => `<code data-var="{${v}}">{${v}}</code>`).join(' ')}</div>
          <p class="muted pequeno">{descricao} vira “mensalidade de novembro/2026”, “semana de 07/11”, “parcela 3/10” ou o que foi consumido (ex.: Corte).</p>
          <div id="regua"></div>
          <button type="button" class="btn" id="add-etapa">＋ Adicionar etapa</button>
        </div>
      </div>
      <div>
        <div class="cartao pad" style="margin-bottom:14px">
          <h3>Envio automático</h3>
          <label class="check"><input type="checkbox" name="envio_automatico" ${c.envio_automatico ? 'checked' : ''}> <b>Enviar a régua automaticamente todo dia</b></label>
          <div class="linha"><label>Horário do envio<input type="time" name="hora_envio" value="${esc(c.hora_envio)}"></label>
            <label>Limite por dia<input type="number" name="limite_diario" min="1" value="${c.limite_diario}"></label></div>
          <div class="linha"><label>Intervalo mínimo (seg)<input type="number" name="intervalo_min" min="5" value="${c.intervalo_min}"></label>
            <label>Intervalo máximo (seg)<input type="number" name="intervalo_max" min="5" value="${c.intervalo_max}"></label></div>
          <div class="linha"><label>Não enviar antes de<input type="time" name="janela_inicio" value="${esc(c.janela_inicio)}"></label>
            <label>Não enviar depois de<input type="time" name="janela_fim" value="${esc(c.janela_fim)}"></label></div>
          <label>Tolerância de etapa (dias)<input type="number" name="tolerancia_dias" min="0" value="${c.tolerancia_dias}"><div class="ajuda">Quantos dias depois do dia da etapa ela ainda pode ser enviada.</div></label>
          <div class="aviso info pequeno">O Mac precisa estar ligado e com o Docker aberto no horário. Num servidor, isso roda sozinho 24h.</div>
        </div>
        <div class="cartao pad" style="margin-bottom:14px">
          <h3>Após o pagamento</h3>
          <label class="check"><input type="checkbox" name="agradecer_pagamento" ${c.agradecer_pagamento ? 'checked' : ''}> Mandar agradecimento ao confirmar pagamento</label>
          <label>Mensagem<textarea name="modelo_agradecimento" style="min-height:80px">${esc(c.modelo_agradecimento)}</textarea></label>
        </div>
        <div class="cartao pad">
          <h3>Quando o cliente mandar comprovante</h3>
          <label class="check"><input type="checkbox" name="responder_comprovante" ${c.responder_comprovante ? 'checked' : ''}> Responder automaticamente</label>
          <label>Mensagem<textarea name="modelo_resposta_comprovante" style="min-height:80px">${esc(c.modelo_resposta_comprovante)}</textarea></label>
        </div>
        <div class="cartao pad" style="margin-top:14px">
          <h3>Agenda</h3>
          <div class="linha3"><label>Intervalo (min)<select name="agenda_intervalo">${[10, 15, 20, 30, 45, 60].map((m) => `<option value="${m}" ${Number(c.agenda_intervalo) === m ? 'selected' : ''}>${m} min</option>`).join('')}</select></label>
            <label>Mostrar a partir de<input type="time" name="agenda_inicio" value="${esc(c.agenda_inicio)}"></label>
            <label>Até<input type="time" name="agenda_fim" value="${esc(c.agenda_fim)}"></label></div>
          <label class="check"><input type="checkbox" name="agenda_confirmacao" ${c.agenda_confirmacao ? 'checked' : ''}> Mandar confirmação no WhatsApp ao agendar</label>
          <label class="check"><input type="checkbox" name="agenda_lembrete" ${c.agenda_lembrete ? 'checked' : ''}> Mandar lembrete antes do horário</label>
          <label>Lembrete quantas horas antes<input type="number" name="agenda_lembrete_horas" min="1" max="72" value="${c.agenda_lembrete_horas}"></label>
          <div class="vars">Campos: ${['primeiro_nome', 'nome', 'data', 'dia_semana', 'hora', 'profissional', 'servico', 'valor', 'empresa'].map((v) => `<code data-var="{${v}}">{${v}}</code>`).join(' ')}</div>
          <label>Confirmação ao agendar<textarea name="agenda_msg_confirmacao">${esc(c.agenda_msg_confirmacao)}</textarea></label>
          <label>Lembrete<textarea name="agenda_msg_lembrete">${esc(c.agenda_msg_lembrete)}</textarea></label>
          <label>Quando o cliente responde SIM<textarea name="agenda_msg_confirmado" style="min-height:60px">${esc(c.agenda_msg_confirmado)}</textarea></label>
          <label>Quando o cliente responde CANCELAR<textarea name="agenda_msg_cancelado" style="min-height:60px">${esc(c.agenda_msg_cancelado)}</textarea></label>
        </div>
        <div class="cartao pad" style="margin-top:14px">
          <h3>Agendamento online (link para o cliente)</h3>
          <label class="check"><input type="checkbox" name="online_ativo" ${c.online_ativo ? 'checked' : ''}> <span><b>Deixar os clientes marcarem horário sozinhos pelo link</b></span></label>
          <div class="aviso info pequeno">Link para mandar aos clientes e colocar no Instagram: <b><a href="${location.origin}/agendar" target="_blank">${location.origin}/agendar</a></b> <button type="button" class="btn mini" id="copiar-link">Copiar</button></div>
          <div class="linha"><label>Antecedência mínima (min)<input type="number" name="online_antecedencia_min" min="0" step="15" value="${c.online_antecedencia_min}"><div class="ajuda">Ex.: 60 = não deixa marcar para daqui a menos de 1 hora.</div></label>
            <label>Até quantos dias à frente<input type="number" name="online_dias" min="1" max="90" value="${c.online_dias}"></label></div>
          <label>Recado na página (opcional)<textarea name="online_aviso" style="min-height:50px" placeholder="ex.: Chegue 5 minutos antes. Atrasos de 15 min podem perder o horário.">${esc(c.online_aviso)}</textarea></label>
          <p class="muted pequeno">O cliente escolhe serviço, profissional (ou “sem preferência”), dia e horário livre. O horário entra na agenda e ele recebe a confirmação no WhatsApp (SIM / CANCELAR).</p>
        </div>
        <div class="cartao pad" style="margin-top:14px">
          <h3>Retorno: “faz tempo que não te vejo”</h3>
          <label class="check"><input type="checkbox" name="retorno_ativo" ${c.retorno_ativo ? 'checked' : ''}> <b>Chamar no WhatsApp quem não aparece há um tempo</b></label>
          <div class="linha3"><label>Depois de quantos dias<input type="number" name="retorno_dias" min="7" value="${c.retorno_dias}"></label>
            <label>Horário do envio<input type="time" name="retorno_hora" value="${esc(c.retorno_hora)}"></label>
            <label>Máximo por dia<input type="number" name="retorno_limite" min="1" value="${c.retorno_limite}"></label></div>
          <div class="vars">Campos: ${['primeiro_nome', 'nome', 'dias', 'servico', 'profissional', 'ultima_visita', 'empresa', 'link_agendamento'].map((v) => `<code data-var="{${v}}">{${v}}</code>`).join(' ')}</div>
          <label>Mensagem<textarea name="retorno_msg">${esc(c.retorno_msg)}</textarea></label>
          <div id="retorno-info" class="muted pequeno"></div>
          <p class="muted pequeno">Só chama quem teve atendimento concluído na agenda, não tem horário marcado e ainda não foi chamado desde a última visita. Cada pessoa recebe no máximo uma vez por visita.</p>
        </div>
        <div class="cartao pad" style="margin-top:14px">
          <h3>Cobrança avulsa (consumo / fiado)</h3>
          <label>Mensagem enviada ao cobrar um consumo na hora<textarea name="modelo_avulso" style="min-height:80px">${esc(c.modelo_avulso)}</textarea></label>
          <p class="muted pequeno">Usa os mesmos campos da régua ({primeiro_nome}, {valor}, {descricao}, {empresa}…). O Pix vai junto.</p>
        </div>
      </div>
    </div></form>`;
  const f = $('#f-cfg');
  f.pix_tipo.value = c.pix_tipo;
  let regua = JSON.parse(JSON.stringify(c.regua || []));
  let ultimoTexto = null;
  const desenharRegua = () => {
    regua.sort((a, b) => a.dias - b.dias);
    $('#regua').innerHTML = regua.map((e, i) => `
      <div class="etapa">
        <div class="etapa-topo">
          <label class="check" style="margin:0"><input type="checkbox" data-i="${i}" data-k="ativo" ${e.ativo ? 'checked' : ''}> Ativa</label>
          <select data-i="${i}" data-k="dias">${[...new Set([...opcoesDias, e.dias])].sort((a, b) => a - b).map((d) => `<option value="${d}" ${d === e.dias ? 'selected' : ''}>${nomeDia(d)}</option>`).join('')}</select>
          <button type="button" class="btn mini" data-prev="${i}">Pré-visualizar</button>
          <button type="button" class="btn mini perigo" data-del="${i}" style="margin-left:auto">Remover</button>
        </div>
        <textarea data-i="${i}" data-k="modelo">${esc(e.modelo)}</textarea>
        <div id="prev-${i}"></div>
      </div>`).join('') || '<p class="muted">Nenhuma etapa. Adicione pelo menos uma.</p>';
    $$('#regua [data-k]').forEach((inp) => {
      const atualizar = () => {
        const e = regua[inp.dataset.i];
        if (inp.dataset.k === 'ativo') e.ativo = inp.checked;
        else if (inp.dataset.k === 'dias') { e.dias = Number(inp.value); desenharRegua(); }
        else e.modelo = inp.value;
      };
      inp.addEventListener(inp.tagName === 'TEXTAREA' ? 'input' : 'change', atualizar);
      if (inp.tagName === 'TEXTAREA') inp.addEventListener('focus', () => ultimoTexto = inp);
    });
    $$('#regua [data-del]').forEach((b) => b.onclick = () => { regua.splice(b.dataset.del, 1); desenharRegua(); });
    $$('#regua [data-prev]').forEach((b) => b.onclick = async () => {
      const e = regua[b.dataset.prev];
      const r = await api('/config/previa', { method: 'POST', body: { modelo: e.modelo, dias: e.dias } });
      $(`#prev-${b.dataset.prev}`).innerHTML = `<div class="previa">${esc(r.texto)}</div>`;
    });
  };
  desenharRegua();
  $$('textarea', f).forEach((t) => t.addEventListener('focus', () => ultimoTexto = t));
  $$('[data-var]').forEach((v) => v.onclick = () => {
    if (!ultimoTexto) return toast('Clique primeiro dentro de uma mensagem');
    const t = ultimoTexto, p = t.selectionStart ?? t.value.length;
    t.value = t.value.slice(0, p) + v.dataset.var + t.value.slice(t.selectionEnd ?? p);
    t.dispatchEvent(new Event('input')); t.focus();
  });
  $('#add-etapa').onclick = () => {
    const usados = new Set(regua.map((e) => e.dias));
    const d = opcoesDias.find((x) => x > 0 && !usados.has(x)) ?? 30;
    regua.push({ id: 'e' + Date.now(), dias: d, ativo: true, modelo: 'Olá, {primeiro_nome}! A mensalidade de {valor} (venc. {vencimento}) segue em aberto. Pix abaixo.' });
    desenharRegua();
  };
  const salvarCfg = async (silencioso) => {
    const body = {};
    for (const inp of $$('input[name], select[name], textarea[name]', f)) body[inp.name] = inp.type === 'checkbox' ? inp.checked : inp.value;
    body.regua = regua;
    try {
      CONFIG = await api('/config', { method: 'PUT', body });
      aplicarMarca({ empresa: CONFIG.empresa });
      if (!silencioso) toast('Configurações salvas ✓');
    } catch (e) { toast(e.message, true); throw e; }
  };
  $('#salvar-cfg').onclick = () => salvarCfg(false);
  $('#copiar-link').onclick = () => { navigator.clipboard.writeText(location.origin + '/agendar'); toast('Link copiado ✓'); };
  api('/retorno/previa').then((r) => {
    const box = $('#retorno-info');
    if (box) box.innerHTML = `Hoje ${r.candidatos} cliente(s) se encaixam · ${r.enviados_30d} chamado(s) nos últimos 30 dias.<div class="previa" style="margin-top:6px">${esc(r.exemplo)}</div>`;
  }).catch(() => {});
}

// ---------- Personalização ----------
const TEMAS = [
  ['azul', 'Azul', 'linear-gradient(135deg,#0b5f8c,#31b2e8)'],
  ['verde', 'Verde', 'linear-gradient(135deg,#075e47,#14a97c)'],
  ['roxo', 'Roxo', 'linear-gradient(135deg,#3f2a8c,#7b5cf0)'],
  ['rosa', 'Rosa', 'linear-gradient(135deg,#8c1d52,#e0488f)'],
  ['preto', 'Preto', 'linear-gradient(135deg,#0d0f12,#2b313b)'],
  ['branco', 'Branco', 'linear-gradient(135deg,#ffffff,#e9edf2)'],
];
async function pgPersonalizacao(el) {
  const c = await api('/config');
  const original = { sistema_nome: c.sistema_nome, tema: c.tema };
  let tema = c.tema;
  el.innerHTML = `
    <div class="cabecalho"><div><h1>Personalização</h1><div class="muted">Nome, logo e cores do sistema.</div></div>
      <div class="acoes"><button class="btn primario" id="salvar-marca">Salvar</button></div></div>
    <div class="grade g2">
      <div class="cartao pad">
        <h3>Nome do sistema</h3>
        <label>Aparece no login, no menu e na aba do navegador<input id="m-nome" maxlength="40" value="${esc(c.sistema_nome)}"></label>
        <h3 style="margin-top:8px">Cor</h3>
        <div class="temas">${TEMAS.map(([id, nome, bg]) => `<button type="button" class="tema-op ${id === tema ? 'sel' : ''}" data-tema="${id}"><div class="amostra" style="background:${bg};${id === 'branco' ? 'border:1px solid #dfe5eb' : ''}"></div>${nome}</button>`).join('')}</div>
        <p class="muted pequeno">A cor muda na hora para você ver como fica. Clique em Salvar para aplicar para todos.</p>
      </div>
      <div class="cartao pad">
        <h3>Logo</h3>
        <div style="display:flex;gap:16px;align-items:center;margin:8px 0 14px">
          <div class="logo-preview" id="logo-prev">${MARCA.tem_logo ? `<img src="/marca/logo?v=${MARCA.logo_versao}">` : 'Sem logo'}</div>
          <div class="acoes" style="flex-direction:column;align-items:flex-start">
            <label class="btn" style="margin:0;font-weight:600">Enviar imagem<input type="file" id="logo-arq" accept="image/png,image/jpeg,image/webp,image/svg+xml" class="hidden"></label>
            <button class="btn perigo ${MARCA.tem_logo ? '' : 'hidden'}" id="logo-remover">Remover logo</button>
          </div>
        </div>
        <p class="muted pequeno">PNG, JPG, WEBP ou SVG, até 1 MB. De preferência quadrada e com fundo transparente. A logo é salva assim que você envia.</p>
      </div>
    </div>`;
  const nome = $('#m-nome');
  nome.oninput = () => $$('.nome-sistema').forEach((e) => e.textContent = nome.value || '…');
  $$('.tema-op').forEach((b) => b.onclick = () => {
    tema = b.dataset.tema;
    $$('.tema-op').forEach((x) => x.classList.toggle('sel', x === b));
    document.documentElement.dataset.tema = tema;
  });
  $('#salvar-marca').onclick = async () => {
    try {
      CONFIG = await api('/config', { method: 'PUT', body: { sistema_nome: nome.value, tema } });
      original.sistema_nome = CONFIG.sistema_nome; original.tema = CONFIG.tema;
      aplicarMarca({ sistema_nome: CONFIG.sistema_nome, tema: CONFIG.tema });
      toast('Personalização salva ✓');
    } catch (e) { toast(e.message, true); }
  };
  // se sair sem salvar, volta ao que estava
  const restaurar = () => { if (!location.hash.includes('personalizacao')) { aplicarMarca(original); window.removeEventListener('hashchange', restaurar); } };
  window.addEventListener('hashchange', restaurar);

  $('#logo-arq').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 1024 * 1024) return toast('Imagem muito grande (máximo 1 MB)', true);
    const r = new FileReader();
    r.onload = async () => {
      try {
        await api('/marca/logo', { method: 'PUT', body: { imagem: r.result } });
        await carregarMarca();
        $('#logo-prev').innerHTML = `<img src="/marca/logo?v=${MARCA.logo_versao}">`;
        $('#logo-remover').classList.remove('hidden');
        toast('Logo atualizada ✓');
      } catch (err) { toast(err.message, true); }
    };
    r.readAsDataURL(f);
  };
  $('#logo-remover').onclick = async () => {
    await api('/marca/logo', { method: 'DELETE' });
    await carregarMarca();
    $('#logo-prev').textContent = 'Sem logo';
    $('#logo-remover').classList.add('hidden');
    toast('Logo removida');
  };
}

// ---------- Usuários ----------
const NOME_PERM = { clientes: 'Clientes', pagamentos: 'Pagamentos', envios: 'Envios', agenda: 'Agenda', agenda_config: 'Profissionais/serviços', financeiro: 'Financeiro', whatsapp: 'WhatsApp', configuracoes: 'Configurações', personalizacao: 'Personalização', usuarios: 'Usuários' };
async function pgUsuarios(el) {
  const lista = await api('/usuarios');
  const perms = EU.lista_permissoes || {};
  el.innerHTML = `
    <div class="cabecalho"><div><h1>Usuários</h1><div class="muted">Quem pode entrar no sistema e o que cada um pode fazer.</div></div>
      <div class="acoes"><button class="btn primario" id="novo-usu">＋ Novo usuário</button></div></div>
    <div class="cartao"><div class="tabela-wrap"><table>
      <thead><tr><th>Nome</th><th>Login</th><th>Permissões</th><th>Último acesso</th><th>Situação</th><th></th></tr></thead>
      <tbody>${lista.map((u) => `<tr>
        <td><b>${esc(u.nome)}</b>${u.id === EU.id ? ' <span class="tag">você</span>' : ''}</td>
        <td>${esc(u.login)}</td>
        <td class="pequeno">${u.admin ? '<span class="tag aberto">Administrador (tudo)</span>' : (u.permissoes.length ? u.permissoes.map((p) => NOME_PERM[p] || p).join(', ') : '<span class="muted">Só visualizar</span>')}</td>
        <td class="pequeno muted">${u.ultimo_acesso ? brDataHora(u.ultimo_acesso) : 'nunca'}</td>
        <td>${u.ativo ? '<span class="tag pago">Ativo</span>' : '<span class="tag">Desativado</span>'}</td>
        <td class="num"><button class="btn mini" data-usu="${u.id}">Editar</button></td></tr>`).join('')}
      </tbody></table></div></div>
    <p class="muted pequeno" style="margin-top:12px">Todo usuário pode <b>ver</b> clientes, cobranças e relatórios. As permissões liberam as ações. O nome de quem deu baixa fica registrado em cada pagamento.</p>`;
  $('#novo-usu').onclick = () => modalUsuario(null, perms);
  $$('[data-usu]').forEach((b) => b.onclick = () => modalUsuario(lista.find((u) => u.id == b.dataset.usu), perms));
}

function modalUsuario(u, perms) {
  const novo = !u;
  u = u || { ativo: true, admin: false, permissoes: ['pagamentos'] };
  abrirModal(`<form id="f-usu">
    <div class="modal-topo"><h2>${novo ? 'Novo usuário' : 'Editar usuário'}</h2><button type="button" class="fechar" data-fechar>×</button></div>
    <div class="modal-corpo">
      <div class="linha"><label>Nome<input name="nome" required value="${esc(u.nome || '')}"></label>
        <label>Login (para entrar)<input name="login" required autocapitalize="none" value="${esc(u.login || '')}" placeholder="ex.: maria"></label></div>
      <label>${novo ? 'Senha' : 'Nova senha (deixe em branco para manter)'}<input type="password" name="senha" ${novo ? 'required' : ''} minlength="6" autocomplete="new-password"></label>
      <label class="check"><input type="checkbox" name="admin" ${u.admin ? 'checked' : ''}> <b>Administrador</b> (pode tudo, inclusive gerenciar usuários)</label>
      <div class="perm-lista" id="perm-lista" style="padding:10px 12px;border:1px solid var(--borda);border-radius:10px;margin-bottom:12px">
        ${Object.entries(perms).map(([k, t]) => `<label class="check"><input type="checkbox" name="perm" value="${k}" ${(u.permissoes || []).includes(k) ? 'checked' : ''}> ${esc(t)}</label>`).join('')}
      </div>
      <label class="check"><input type="checkbox" name="ativo" ${u.ativo ? 'checked' : ''}> Usuário ativo (pode entrar)</label>
      <p class="erro-txt" id="usu-erro"></p>
    </div>
    <div class="modal-rodape">
      ${novo || u.id === EU.id ? '' : '<button type="button" class="btn perigo" id="usu-excluir" style="margin-right:auto">Excluir</button>'}
      <button type="button" class="btn" data-fechar>Cancelar</button><button class="btn primario">Salvar</button></div></form>`);
  const f = $('#f-usu');
  const tg = () => { $('#perm-lista').style.opacity = f.admin.checked ? .45 : 1; $$('#perm-lista input').forEach((i) => i.disabled = f.admin.checked); };
  f.admin.onchange = tg; tg();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = { nome: f.nome.value, login: f.login.value, senha: f.senha.value, admin: f.admin.checked, ativo: f.ativo.checked,
      permissoes: $$('input[name=perm]:checked', f).map((i) => i.value) };
    try {
      await api(novo ? '/usuarios' : `/usuarios/${u.id}`, { method: novo ? 'POST' : 'PUT', body });
      fecharModal(); toast('Usuário salvo ✓');
      if (!novo && u.id === EU.id) { EU = await api('/me'); $('#eu-nome').textContent = EU.nome; }
      rotear();
    } catch (err) { $('#usu-erro').textContent = err.message; }
  };
  const ex = $('#usu-excluir');
  if (ex) ex.onclick = async () => {
    if (!(await confirmar('Excluir usuário?', `<b>${esc(u.nome)}</b> não vai mais conseguir entrar. Para só bloquear temporariamente, desmarque “Usuário ativo”.`, 'Excluir', true))) return;
    try { await api(`/usuarios/${u.id}`, { method: 'DELETE' }); toast('Usuário excluído'); rotear(); } catch (err) { toast(err.message, true); }
  };
}

carregarMarca().then(() => iniciar()).catch(() => mostrarLogin());
