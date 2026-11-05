/* Agenda — visão por dia (colunas por profissional) e por semana (um profissional) */
/* Usa as funções globais do app.js: $, $$, esc, brl, brData, api, toast, abrirModal, fecharModal, confirmar, pode, CONFIG, HOJE */

const AG = {
  data: null,          // 'YYYY-MM-DD'
  vista: 'dia',        // 'dia' | 'semana'
  profSemana: null,    // id do profissional na visão semana
  profs: [],
  servs: [],
  itens: [],
};
const PX_MIN = 1.6;    // altura em px de cada minuto
const DIAS_CURTO = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const CORES_PROF = ['#31b2e8', '#14a97c', '#7b5cf0', '#e0488f', '#f07a21', '#e2b007', '#4a6380', '#d6453d'];
const NOME_STATUS = { agendado: 'Agendado', confirmado: 'Confirmado', concluido: 'Concluído', faltou: 'Faltou', cancelado: 'Cancelado', bloqueio: 'Bloqueado' };

const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const minDe = (h) => { const [a, b] = String(h).split(':').map(Number); return a * 60 + (b || 0); };
function addDias(iso, n) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function dow(iso) { return new Date(iso + 'T12:00:00').getDay(); }
function inicioSemana(iso) { return addDias(iso, -((dow(iso) + 6) % 7)); } // segunda
function dataLonga(iso) { return new Date(iso + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }); }
function hojeLocal() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

async function pgAgenda(el) {
  AG.data = AG.data || hojeLocal();
  [AG.profs, AG.servs] = await Promise.all([api('/agenda/profissionais'), api('/agenda/servicos')]);
  const ativos = AG.profs.filter((p) => p.ativo);
  if (!AG.profSemana || !ativos.some((p) => p.id === AG.profSemana)) AG.profSemana = ativos[0] ? ativos[0].id : null;

  el.innerHTML = `
    <div class="cabecalho">
      <div><h1>Agenda</h1><div class="muted" id="ag-titulo"></div></div>
      <div class="acoes">
        <a class="btn" id="ag-com" href="#/comissoes">Comissões</a>
        <button class="btn" id="ag-prof">Profissionais</button>
        <button class="btn" id="ag-serv">Serviços</button>
        <button class="btn primario" id="ag-novo">＋ Agendar</button>
      </div>
    </div>
    ${!ativos.length ? `<div class="cartao vazio"><b>Cadastre os profissionais para começar</b>Cada profissional vira uma coluna na agenda, com o próprio horário de trabalho.<br><br>
      ${pode('agenda_config') ? '<button class="btn primario" id="ag-prof2">Cadastrar profissionais</button>' : 'Peça ao administrador para cadastrar.'}</div>` : `
    <div class="cartao">
      <div class="cartao-topo">
        <div class="filtros">
          <button class="btn" id="ag-ant" aria-label="Anterior">←</button>
          <button class="btn" id="ag-hoje">Hoje</button>
          <button class="btn" id="ag-prox" aria-label="Próximo">→</button>
          <input type="date" id="ag-data" value="${AG.data}">
        </div>
        <div class="filtros">
          <div class="seg" id="ag-vista"><button data-v="dia">Dia</button><button data-v="semana">Semana</button></div>
          <select id="ag-psem" class="${AG.vista === 'semana' ? '' : 'hidden'}">${ativos.map((p) => `<option value="${p.id}" ${p.id === AG.profSemana ? 'selected' : ''}>${esc(p.nome)}</option>`).join('')}</select>
        </div>
      </div>
      <div id="ag-resumo" class="ag-resumo"></div>
      <div class="ag-wrap" id="ag-wrap"></div>
    </div>`}`;

  $('#ag-prof').onclick = () => modalProfissionais();
  $('#ag-serv').onclick = () => modalServicos();
  const p2 = $('#ag-prof2'); if (p2) p2.onclick = () => modalProfissionais();
  $('#ag-novo').onclick = () => modalAgendamento(null, { data: AG.data, hora: null, profissional_id: AG.vista === 'semana' ? AG.profSemana : (ativos[0] && ativos[0].id) });
  if (!ativos.length) { $('#ag-titulo').textContent = ''; return; }

  const passo = AG.vista === 'semana' ? 7 : 1;
  $('#ag-ant').onclick = () => { AG.data = addDias(AG.data, -passo); desenharAgenda(); };
  $('#ag-prox').onclick = () => { AG.data = addDias(AG.data, passo); desenharAgenda(); };
  $('#ag-hoje').onclick = () => { AG.data = hojeLocal(); desenharAgenda(); };
  $('#ag-data').onchange = (e) => { if (e.target.value) { AG.data = e.target.value; desenharAgenda(); } };
  $$('#ag-vista button').forEach((b) => {
    b.classList.toggle('sel', b.dataset.v === AG.vista);
    b.onclick = () => { AG.vista = b.dataset.v; rotear(); };
  });
  $('#ag-psem').onchange = (e) => { AG.profSemana = Number(e.target.value); desenharAgenda(); };

  await desenharAgenda(true);
  timers.push(setInterval(() => { if (!$('#modal').classList.contains('hidden')) return; desenharAgenda(); }, 60000));
}

async function desenharAgenda(rolar) {
  const wrap = $('#ag-wrap');
  if (!wrap) return;
  $('#ag-data').value = AG.data;
  const ativos = AG.profs.filter((p) => p.ativo);
  let colunas;
  let de, ate;
  if (AG.vista === 'semana') {
    de = inicioSemana(AG.data); ate = addDias(de, 6);
    const prof = AG.profs.find((p) => p.id === AG.profSemana) || ativos[0];
    colunas = Array.from({ length: 7 }, (_, i) => {
      const d = addDias(de, i);
      return { chave: d, data: d, prof, titulo: `${DIAS_CURTO[dow(d)]} ${d.slice(8)}/${d.slice(5, 7)}`, hoje: d === hojeLocal() };
    });
    $('#ag-titulo').textContent = `${prof.nome} · semana de ${brData(de)} a ${brData(ate)}`;
  } else {
    de = ate = AG.data;
    colunas = ativos.map((p) => ({ chave: p.id, data: AG.data, prof: p, titulo: p.nome, hoje: AG.data === hojeLocal() }));
    $('#ag-titulo').textContent = dataLonga(AG.data) + (AG.data === hojeLocal() ? ' · hoje' : '');
  }
  AG.itens = await api(`/agenda?de=${de}&ate=${ate}`);

  const intervalo = Number(CONFIG.agenda_intervalo) || 30;
  let ini = minDe(CONFIG.agenda_inicio || '08:00');
  let fim = minDe(CONFIG.agenda_fim || '20:00');
  // amplia a grade se houver atendimento fora do horário mostrado
  for (const a of AG.itens) {
    ini = Math.min(ini, Math.floor(minDe(a.inicio_local.slice(11)) / 60) * 60);
    fim = Math.max(fim, Math.ceil(minDe(a.fim_local.slice(11)) / 60) * 60);
  }
  if (fim <= ini) fim = ini + 60;
  const altura = (fim - ini) * PX_MIN;

  const regua = [];
  for (let m = ini; m < fim; m += intervalo) regua.push(m);

  const colHtml = colunas.map((c) => {
    const exp = c.prof.expediente || {};
    const trabalha = (exp.dias || []).includes(dow(c.data));
    const sombras = [];
    if (!trabalha) sombras.push([ini, fim]);
    else {
      if (minDe(exp.inicio) > ini) sombras.push([ini, minDe(exp.inicio)]);
      if (minDe(exp.fim) < fim) sombras.push([minDe(exp.fim), fim]);
      if (exp.almoco_inicio && exp.almoco_fim) sombras.push([minDe(exp.almoco_inicio), minDe(exp.almoco_fim)]);
    }
    const itens = AG.itens.filter((a) => a.profissional_id === c.prof.id && a.inicio_local.slice(0, 10) === c.data);
    const eventos = layoutSobrepostos(itens).map(({ a, col, cols }) => {
      const t = minDe(a.inicio_local.slice(11)), f = minDe(a.fim_local.slice(11));
      const h = Math.max(18, (f - t) * PX_MIN - 2);
      const curto = h < 40;
      return `<div class="ag-ev st-${a.status} ${a.pago ? 'pago' : ''}" data-ag="${a.id}"
        style="top:${(t - ini) * PX_MIN}px;height:${h}px;left:calc(${(col / cols) * 100}% + 2px);width:calc(${100 / cols}% - 4px);--cor:${esc(a.cor)}">
        <div class="ag-ev-l1"><b>${a.inicio_local.slice(11)}</b> ${esc(a.status === 'bloqueio' ? '🔒 ' + (a.cliente_nome || 'Bloqueado') : a.cliente_nome || '')}${a.status === 'confirmado' ? ' ✓' : ''}${a.pago ? ' 💲' : ''}</div>
        ${curto ? '' : `<div class="ag-ev-l2">${esc(a.servico_nome || '')}${a.status !== 'agendado' && a.status !== 'confirmado' && a.status !== 'bloqueio' ? ` · ${NOME_STATUS[a.status]}` : ''}</div>`}
      </div>`;
    }).join('');
    let agora = '';
    if (c.hoje) {
      const d = new Date(); const m = d.getHours() * 60 + d.getMinutes();
      if (m >= ini && m <= fim) agora = `<div class="ag-agora" style="top:${(m - ini) * PX_MIN}px"></div>`;
    }
    return `<div class="ag-col" data-col="${c.chave}" data-data="${c.data}" data-prof="${c.prof.id}" style="height:${altura}px">
      ${sombras.map(([a, b]) => `<div class="ag-fora" style="top:${(Math.max(a, ini) - ini) * PX_MIN}px;height:${(Math.min(b, fim) - Math.max(a, ini)) * PX_MIN}px"></div>`).join('')}
      ${regua.map((m) => `<div class="ag-slot ${m % 60 === 0 ? 'hora' : ''}" data-hora="${hm(m)}" style="top:${(m - ini) * PX_MIN}px;height:${intervalo * PX_MIN}px"></div>`).join('')}
      ${eventos}${agora}
    </div>`;
  }).join('');

  wrap.style.setProperty('--ncol', colunas.length);
  wrap.innerHTML = `
    <div class="ag-grade">
      <div class="ag-cab"><div class="ag-canto"></div>${colunas.map((c) => `<div class="ag-cab-col ${c.hoje && AG.vista === 'semana' ? 'hoje' : ''}">${AG.vista === 'dia' ? `<span class="ag-ponto" style="background:${esc(c.prof.cor)}"></span>` : ''}${esc(c.titulo)}</div>`).join('')}</div>
      <div class="ag-corpo">
        <div class="ag-regua" style="height:${altura}px">${regua.filter((m) => m % 60 === 0).map((m) => `<span style="top:${(m - ini) * PX_MIN}px">${hm(m)}</span>`).join('')}</div>
        ${colHtml}
      </div>
    </div>`;

  // resumo
  const validos = AG.itens.filter((a) => !['cancelado', 'bloqueio'].includes(a.status));
  const porProf = {};
  for (const a of validos) {
    const k = a.profissional_nome;
    porProf[k] = porProf[k] || { n: 0, v: 0 };
    porProf[k].n++; if (a.status !== 'faltou') porProf[k].v += Number(a.valor || 0);
  }
  const recebido = AG.itens.filter((a) => a.pago).reduce((s, a) => s + Number(a.valor || 0), 0);
  const previsto = validos.filter((a) => a.status !== 'faltou').reduce((s, a) => s + Number(a.valor || 0), 0);
  $('#ag-resumo').innerHTML = `<span><b>${validos.length}</b> atendimento(s)</span><span>Previsto <b>${brl(previsto)}</b></span><span>Recebido <b>${brl(recebido)}</b></span>
    ${AG.vista === 'dia' ? Object.entries(porProf).map(([n, x]) => `<span class="muted">${esc(n)}: ${x.n} · ${brl(x.v)}</span>`).join('') : ''}`;

  // cliques
  $$('.ag-slot', wrap).forEach((s) => s.onclick = () => {
    if (!pode('agenda')) return;
    const col = s.closest('.ag-col');
    modalAgendamento(null, { data: col.dataset.data, hora: s.dataset.hora, profissional_id: Number(col.dataset.prof) });
  });
  $$('.ag-ev', wrap).forEach((e) => e.onclick = (ev) => { ev.stopPropagation(); modalAgendamento(AG.itens.find((a) => a.id == e.dataset.ag)); });

  if (rolar) {
    const alvo = AG.data === hojeLocal() ? new Date().getHours() * 60 - 60 : minDe('08:00');
    wrap.scrollTop = Math.max(0, (alvo - ini) * PX_MIN);
  }
}

// divide em colunas os atendimentos que se sobrepõem no mesmo profissional
function layoutSobrepostos(itens) {
  const ord = [...itens].sort((a, b) => a.inicio_local.localeCompare(b.inicio_local));
  const out = [];
  let grupo = [], fimGrupo = '';
  const fechar = () => {
    const colsFim = [];
    for (const a of grupo) {
      let c = colsFim.findIndex((f) => f <= a.inicio_local);
      if (c < 0) { c = colsFim.length; colsFim.push(''); }
      colsFim[c] = a.fim_local;
      out.push({ a, col: c, cols: 0 });
    }
    out.slice(out.length - grupo.length).forEach((o) => o.cols = colsFim.length);
    grupo = []; fimGrupo = '';
  };
  for (const a of ord) {
    if (grupo.length && a.inicio_local >= fimGrupo) fechar();
    grupo.push(a);
    if (a.fim_local > fimGrupo) fimGrupo = a.fim_local;
  }
  if (grupo.length) fechar();
  return out;
}

// ---------- Modal de agendamento ----------
function modalAgendamento(a, padrao = {}) {
  const novo = !a;
  const ativos = AG.profs.filter((p) => p.ativo || (a && p.id === a.profissional_id));
  const intervalo = Number(CONFIG.agenda_intervalo) || 30;
  const dur = a ? Math.round((new Date(a.fim_local) - new Date(a.inicio_local)) / 60000) : intervalo;
  const v = a ? {
    profissional_id: a.profissional_id, servico_id: a.servico_id, data: a.inicio_local.slice(0, 10), hora: a.inicio_local.slice(11),
    duracao: dur, cliente_nome: a.cliente_nome, telefone: a.telefone, valor: a.valor, obs: a.obs, status: a.status, pago: a.pago, forma_pagamento: a.forma_pagamento, cliente_id: a.cliente_id,
  } : { profissional_id: padrao.profissional_id, data: padrao.data, hora: padrao.hora || '09:00', duracao: intervalo, status: 'agendado' };
  const bloq = v.status === 'bloqueio';
  const servAtivos = AG.servs.filter((s) => s.ativo || s.id === v.servico_id);
  const podeEditar = pode('agenda');

  abrirModal(`<form id="f-ag">
    <div class="modal-topo"><h2>${novo ? 'Novo agendamento' : bloq ? 'Horário bloqueado' : 'Agendamento'}</h2><button type="button" class="fechar" data-fechar>×</button></div>
    <div class="modal-corpo">
      ${!novo && !bloq ? `<div style="margin-bottom:12px"><span class="tag st-tag-${v.status}">${NOME_STATUS[v.status]}</span> ${v.pago ? '<span class="tag pago">Pago</span>' : ''} ${a.criado_por ? `<span class="muted pequeno">· marcado por ${esc(a.criado_por)}</span>` : ''}</div>` : ''}
      <label class="check"><input type="checkbox" name="bloqueio" ${bloq ? 'checked' : ''}> Bloquear horário (folga, compromisso…) em vez de atender cliente</label>
      <div class="linha">
        <label>Profissional<select name="profissional_id">${ativos.map((p) => `<option value="${p.id}" ${p.id == v.profissional_id ? 'selected' : ''}>${esc(p.nome)}</option>`).join('')}</select></label>
        <label class="so-cliente">Serviço<select name="servico_id"><option value="">— sem serviço —</option>${servAtivos.map((s) => `<option value="${s.id}" data-dur="${s.duracao_min}" data-preco="${s.preco}" ${s.id == v.servico_id ? 'selected' : ''}>${esc(s.nome)} · ${s.duracao_min} min · ${brl(s.preco)}</option>`).join('')}</select></label>
      </div>
      <div class="linha3">
        <label>Data<input type="date" name="data" required value="${v.data}"></label>
        <label>Hora<input type="time" name="hora" required step="${intervalo * 60}" value="${v.hora}"></label>
        <label>Duração (min)<input type="number" name="duracao" min="5" max="720" step="5" required value="${v.duracao}"></label>
      </div>
      <div id="ag-livres" class="pequeno muted" style="margin:-4px 0 12px"></div>
      <div class="so-cliente">
        <div class="linha">
          <label>Cliente<input name="cliente_nome" list="ag-sug" autocomplete="off" value="${esc(v.cliente_nome || '')}" placeholder="Nome"></label>
          <label>WhatsApp<input name="telefone" value="${esc(v.telefone ? fone(v.telefone) : '')}" placeholder="51 99999-9999"></label>
        </div>
        <datalist id="ag-sug"></datalist>
        <div class="linha">
          <label>Valor (R$)<input name="valor" inputmode="decimal" value="${v.valor != null ? String(v.valor).replace('.', ',') : ''}"></label>
          <label class="${novo ? 'hidden' : ''}">Status<select name="status">${['agendado', 'confirmado', 'concluido', 'faltou', 'cancelado'].map((s) => `<option value="${s}" ${s === v.status ? 'selected' : ''}>${NOME_STATUS[s]}</option>`).join('')}</select></label>
        </div>
        <div class="linha">
          <label class="check" style="margin-top:4px"><input type="checkbox" name="pago" ${v.pago ? 'checked' : ''}> Pago</label>
          <label>Forma de pagamento<select name="forma_pagamento"><option value="">—</option>${['pix', 'dinheiro', 'cartao', 'debito'].map((f) => `<option value="${f}" ${f === v.forma_pagamento ? 'selected' : ''}>${{ pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão de crédito', debito: 'Cartão de débito' }[f]}</option>`).join('')}</select></label>
        </div>
        ${novo ? `<label class="check"><input type="checkbox" name="enviar_confirmacao" ${CONFIG.agenda_confirmacao ? 'checked' : ''}> Mandar confirmação no WhatsApp</label>` : ''}
      </div>
      <label>${bloq ? 'Motivo' : 'Observação'}<input name="obs" value="${esc(v.obs || '')}"></label>
      <p class="erro-txt" id="ag-erro"></p>
    </div>
    <div class="modal-rodape" style="flex-wrap:wrap">
      ${!novo ? `<div class="acoes" style="margin-right:auto">
        ${!bloq && !['concluido', 'cancelado'].includes(v.status) ? '<button type="button" class="btn mini verde ag-acao" data-st="concluido">✓ Concluído</button>' : ''}
        ${!bloq && ['agendado', 'confirmado'].includes(v.status) ? '<button type="button" class="btn mini ag-acao" data-st="faltou">Faltou</button><button type="button" class="btn mini ag-acao" data-st="cancelado">Cancelar horário</button>' : ''}
        ${!bloq && v.telefone ? '<button type="button" class="btn mini btn-wa ag-acao" id="ag-wa">WhatsApp</button>' : ''}
        <button type="button" class="btn mini perigo ag-acao" id="ag-excluir">Excluir</button>
      </div>` : ''}
      <button type="button" class="btn" data-fechar>Fechar</button>
      ${podeEditar ? '<button class="btn primario">Salvar</button>' : ''}
    </div></form>`);

  const f = $('#f-ag');
  if (!podeEditar) $$('input, select', f).forEach((i) => i.disabled = true);
  const tgBloq = () => { $$('.so-cliente', f).forEach((e) => e.classList.toggle('hidden', f.bloqueio.checked)); };
  f.bloqueio.onchange = tgBloq; tgBloq();
  if (!novo && !bloq) f.bloqueio.closest('label').classList.add('hidden');

  f.servico_id.onchange = () => {
    const o = f.servico_id.selectedOptions[0];
    if (o && o.dataset.dur) { f.duracao.value = o.dataset.dur; f.valor.value = String(o.dataset.preco).replace('.', ','); mostrarLivres(); }
  };
  // sugestões de clientes
  let tSug;
  f.cliente_nome.oninput = () => {
    clearTimeout(tSug);
    const termo = f.cliente_nome.value.trim();
    const achado = (f._sug || []).find((s) => s.nome === termo);
    if (achado) { f.telefone.value = fone(achado.telefone); f._cliente_id = achado.cliente_id || null; return; }
    if (termo.length < 2) return;
    tSug = setTimeout(async () => {
      const lista = await api('/agenda/clientes?q=' + encodeURIComponent(termo)).catch(() => []);
      f._sug = lista;
      $('#ag-sug').innerHTML = lista.map((s) => `<option value="${esc(s.nome)}">${fone(s.telefone)}</option>`).join('');
    }, 250);
  };
  f._cliente_id = v.cliente_id || null;

  async function mostrarLivres() {
    const box = $('#ag-livres');
    if (!box || f.bloqueio.checked || !f.data.value) return;
    const r = await api(`/agenda/livres?data=${f.data.value}&duracao=${f.duracao.value || intervalo}&profissional_id=${f.profissional_id.value}`).catch(() => null);
    if (!r || !r[0]) return;
    const hs = r[0].horarios.slice(0, 12);
    box.innerHTML = hs.length ? `Livres: ${hs.map((h) => `<a href="#" data-h="${h}">${h}</a>`).join(' · ')}` : 'Sem horários livres neste dia para este profissional.';
    $$('a[data-h]', box).forEach((l) => l.onclick = (e) => { e.preventDefault(); f.hora.value = l.dataset.h; });
  }
  if (novo) { f.data.onchange = mostrarLivres; f.profissional_id.onchange = mostrarLivres; mostrarLivres(); }

  async function salvar(forcar) {
    const body = {
      profissional_id: f.profissional_id.value, servico_id: f.servico_id.value || null,
      inicio: `${f.data.value}T${f.hora.value}`, duracao_min: f.duracao.value,
      cliente_nome: f.bloqueio.checked ? (f.obs.value || 'Bloqueado') : f.cliente_nome.value, telefone: f.bloqueio.checked ? '' : f.telefone.value,
      cliente_id: f._cliente_id, valor: f.valor.value, obs: f.obs.value,
      status: f.bloqueio.checked ? 'bloqueio' : (novo ? 'agendado' : f.status.value),
      pago: f.pago.checked, forma_pagamento: f.forma_pagamento.value,
      enviar_confirmacao: f.enviar_confirmacao ? f.enviar_confirmacao.checked : false, forcar,
    };
    try {
      const r = await api(novo ? '/agenda' : `/agenda/${a.id}`, { method: novo ? 'POST' : 'PUT', body });
      fecharModal();
      toast(r.aviso || (novo ? (body.enviar_confirmacao && body.telefone ? 'Agendado e confirmação enviada ✓' : 'Agendado ✓') : 'Salvo ✓'), !!r.aviso);
      AG.data = f.data.value; desenharAgenda();
    } catch (err) {
      if (/Conflito|bloqueado/.test(err.message) && !forcar) {
        if (await confirmar('Horário ocupado', esc(err.message) + '<br><br>Quer marcar mesmo assim (encaixe)?', 'Marcar mesmo assim')) {
          // confirmar() fechou o modal: reabre com os dados e salva forçado
          return salvarForcado(body);
        }
        return;
      }
      $('#ag-erro').textContent = err.message;
    }
  }
  async function salvarForcado(body) {
    try {
      const r = await api(novo ? '/agenda' : `/agenda/${a.id}`, { method: novo ? 'POST' : 'PUT', body: { ...body, forcar: true } });
      toast(r.aviso || 'Agendado (encaixe) ✓', !!r.aviso);
      AG.data = body.inicio.slice(0, 10); desenharAgenda();
    } catch (err) { toast(err.message, true); }
  }
  f.onsubmit = (e) => { e.preventDefault(); salvar(false); };

  $$('[data-st]', f).forEach((b) => b.onclick = async () => {
    const st = b.dataset.st;
    const body = { status: st };
    if (st === 'concluido' && !f.pago.checked) {
      body.pago = await confirmar('Atendimento concluído', `Marcar também como <b>pago</b> (${brl(a.valor)})?`, 'Sim, pago');
      if (body.pago) body.forma_pagamento = f.forma_pagamento.value || 'dinheiro';
    }
    try { await api(`/agenda/${a.id}/status`, { method: 'POST', body }); fecharModal(); toast(NOME_STATUS[st] + ' ✓'); desenharAgenda(); }
    catch (err) { toast(err.message, true); }
  });
  const wa = $('#ag-wa');
  if (wa) wa.onclick = async () => {
    const tipo = new Date(a.inicio_local) - new Date() < 36 * 3600 * 1000 ? 'lembrete' : 'confirmacao';
    try { await api(`/agenda/${a.id}/whatsapp`, { method: 'POST', body: { tipo } }); toast(`${tipo === 'lembrete' ? 'Lembrete' : 'Confirmação'} enviado ✓`); }
    catch (err) { toast(err.message, true); }
  };
  const ex = $('#ag-excluir');
  if (ex) ex.onclick = async () => {
    if (!(await confirmar('Excluir agendamento?', 'Ele some da agenda e do histórico. Para manter o registro, use “Cancelar horário”.', 'Excluir', true))) return;
    await api(`/agenda/${a.id}`, { method: 'DELETE' }); toast('Excluído'); desenharAgenda();
  };
}

// ---------- Profissionais ----------
async function modalProfissionais(editarId) {
  AG.profs = await api('/agenda/profissionais');
  const p = editarId === 'novo' ? { cor: CORES_PROF[AG.profs.length % CORES_PROF.length], ativo: true, expediente: { dias: [1, 2, 3, 4, 5, 6], inicio: '09:00', fim: '19:00', almoco_inicio: '12:00', almoco_fim: '13:00' } }
    : AG.profs.find((x) => x.id === editarId);
  if (!p) {
    abrirModal(`<div class="modal-topo"><h2>Profissionais</h2><button class="fechar" data-fechar>×</button></div>
      <div class="modal-corpo">${AG.profs.length ? AG.profs.map((x) => `<div class="lista-item"><span class="ag-ponto" style="background:${esc(x.cor)}"></span>
        <div class="cresce"><b>${esc(x.nome)}</b> <span class="tag">${Number(x.comissao_pct || 0)}%</span> ${x.ativo ? '' : '<span class="tag">Inativo</span>'}<div class="muted pequeno">${(x.expediente.dias || []).map((d) => DIAS_CURTO[d]).join(', ')} · ${x.expediente.inicio}–${x.expediente.fim}${x.expediente.almoco_inicio ? ` · almoço ${x.expediente.almoco_inicio}–${x.expediente.almoco_fim}` : ''}</div></div>
        <button class="btn mini" data-pe="${x.id}">Editar</button></div>`).join('') : '<p class="muted">Nenhum profissional cadastrado.</p>'}</div>
      <div class="modal-rodape"><button class="btn" data-fechar>Fechar</button><button class="btn primario" id="pe-novo">＋ Novo profissional</button></div>`);
    $('#pe-novo').onclick = () => modalProfissionais('novo');
    $$('[data-pe]').forEach((b) => b.onclick = () => modalProfissionais(Number(b.dataset.pe)));
    $$('[data-fechar]').forEach((b) => b.addEventListener('click', () => { if (location.hash.includes('agenda')) rotear(); }));
    return;
  }
  const e = p.expediente || {};
  abrirModal(`<form id="f-pe">
    <div class="modal-topo"><h2>${p.id ? 'Editar profissional' : 'Novo profissional'}</h2><button type="button" class="fechar" data-fechar>×</button></div>
    <div class="modal-corpo">
      <div class="linha3"><label>Nome<input name="nome" required value="${esc(p.nome || '')}"></label>
        <label>WhatsApp (opcional)<input name="telefone" value="${esc(p.telefone ? fone(p.telefone) : '')}"></label>
        <label>Comissão (%)<input name="comissao_pct" inputmode="decimal" value="${p.comissao_pct != null ? String(Number(p.comissao_pct)).replace('.', ',') : '0'}"></label></div>
      <label>Cor na agenda</label>
      <div class="cores-prof">${CORES_PROF.map((c) => `<button type="button" class="cor-op ${c === p.cor ? 'sel' : ''}" data-cor="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}<input type="color" name="cor" value="${esc(p.cor)}"></div>
      <label style="margin-top:12px">Dias de trabalho</label>
      <div class="filtros" style="margin-bottom:12px">${DIAS_CURTO.map((d, i) => `<label class="check chip"><input type="checkbox" name="dia" value="${i}" ${(e.dias || []).includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div>
      <div class="linha"><label>Entrada<input type="time" name="inicio" value="${e.inicio || '09:00'}"></label><label>Saída<input type="time" name="fim" value="${e.fim || '19:00'}"></label></div>
      <div class="linha"><label>Almoço início (opcional)<input type="time" name="almoco_inicio" value="${e.almoco_inicio || ''}"></label><label>Almoço fim<input type="time" name="almoco_fim" value="${e.almoco_fim || ''}"></label></div>
      <label class="check"><input type="checkbox" name="ativo" ${p.ativo ? 'checked' : ''}> Ativo (aparece na agenda)</label>
      <p class="erro-txt" id="pe-erro"></p>
    </div>
    <div class="modal-rodape">${p.id ? '<button type="button" class="btn perigo" id="pe-excluir" style="margin-right:auto">Excluir</button>' : ''}
      <button type="button" class="btn" id="pe-voltar">Voltar</button><button class="btn primario">Salvar</button></div></form>`);
  const f = $('#f-pe');
  $$('.cor-op', f).forEach((b) => b.onclick = () => { f.cor.value = b.dataset.cor; $$('.cor-op', f).forEach((x) => x.classList.toggle('sel', x === b)); });
  $('#pe-voltar').onclick = () => modalProfissionais();
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const body = { nome: f.nome.value, telefone: f.telefone.value, cor: f.cor.value, ativo: f.ativo.checked, comissao_pct: f.comissao_pct.value.replace(',', '.'),
      expediente: { dias: $$('input[name=dia]:checked', f).map((i) => Number(i.value)), inicio: f.inicio.value, fim: f.fim.value, almoco_inicio: f.almoco_inicio.value, almoco_fim: f.almoco_fim.value } };
    try { await api(p.id ? `/agenda/profissionais/${p.id}` : '/agenda/profissionais', { method: p.id ? 'PUT' : 'POST', body }); toast('Profissional salvo ✓'); modalProfissionais(); }
    catch (err) { $('#pe-erro').textContent = err.message; }
  };
  const ex = $('#pe-excluir');
  if (ex) ex.onclick = async () => {
    try { await api(`/agenda/profissionais/${p.id}`, { method: 'DELETE' }); toast('Excluído'); modalProfissionais(); }
    catch (err) { $('#pe-erro').textContent = err.message; }
  };
}

// ---------- Serviços ----------
async function modalServicos() {
  AG.servs = await api('/agenda/servicos');
  abrirModal(`<div class="modal-topo"><h2>Serviços</h2><button class="fechar" data-fechar>×</button></div>
    <div class="modal-corpo">
      <div class="tabela-wrap cartao" style="margin-bottom:14px"><table><thead><tr><th>Serviço</th><th>Duração</th><th class="num">Preço</th><th>Comissão</th><th></th></tr></thead><tbody>
      ${AG.servs.map((s) => `<tr><td><b>${esc(s.nome)}</b> ${s.ativo ? '' : '<span class="tag">Inativo</span>'}</td><td>${s.duracao_min} min</td><td class="num">${brl(s.preco)}</td><td class="pequeno">${s.comissao_pct != null ? Number(s.comissao_pct) + '%' : '<span class="muted">do profissional</span>'}</td>
        <td class="num"><button class="btn mini" data-se="${s.id}">Editar</button></td></tr>`).join('') || '<tr><td colspan="5" class="vazio">Nenhum serviço ainda. Ex.: Corte (30 min), Barba (20 min), Corte + barba (50 min).</td></tr>'}
      </tbody></table></div>
      <form id="f-se" class="cartao pad">
        <h3 id="se-tit">Novo serviço</h3>
        <div class="linha3"><label>Nome<input name="nome" required placeholder="ex.: Corte"></label>
          <label>Duração (min)<input name="duracao_min" type="number" min="5" step="5" value="30" required></label>
          <label>Preço (R$)<input name="preco" inputmode="decimal" placeholder="0,00"></label></div>
        <label>Comissão própria deste serviço (%)<input name="comissao_pct" inputmode="decimal" placeholder="em branco = usa a do profissional"></label>
        <label class="check"><input type="checkbox" name="ativo" checked> Ativo</label>
        <div class="acoes"><button class="btn primario">Salvar serviço</button><button type="button" class="btn hidden" id="se-cancelar">Cancelar edição</button><button type="button" class="btn perigo hidden" id="se-excluir">Excluir</button></div>
        <p class="erro-txt" id="se-erro"></p>
      </form>
    </div>
    <div class="modal-rodape"><button class="btn" data-fechar>Fechar</button></div>`, true);
  $$('[data-fechar]').forEach((b) => b.addEventListener('click', () => { if (location.hash.includes('agenda')) rotear(); }));
  const f = $('#f-se');
  let editando = null;
  $$('[data-se]').forEach((b) => b.onclick = () => {
    const s = AG.servs.find((x) => x.id == b.dataset.se);
    editando = s.id;
    f.nome.value = s.nome; f.duracao_min.value = s.duracao_min; f.preco.value = String(s.preco).replace('.', ','); f.ativo.checked = s.ativo; f.comissao_pct.value = s.comissao_pct != null ? String(Number(s.comissao_pct)).replace('.', ',') : '';
    $('#se-tit').textContent = 'Editar serviço';
    $('#se-cancelar').classList.remove('hidden'); $('#se-excluir').classList.remove('hidden');
    f.nome.focus();
  });
  $('#se-cancelar').onclick = () => modalServicos();
  $('#se-excluir').onclick = async () => { await api(`/agenda/servicos/${editando}`, { method: 'DELETE' }); toast('Serviço excluído'); modalServicos(); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = { nome: f.nome.value, duracao_min: f.duracao_min.value, preco: f.preco.value, ativo: f.ativo.checked, comissao_pct: f.comissao_pct.value.replace(',', '.') };
    try { await api(editando ? `/agenda/servicos/${editando}` : '/agenda/servicos', { method: editando ? 'PUT' : 'POST', body }); toast('Serviço salvo ✓'); modalServicos(); }
    catch (err) { $('#se-erro').textContent = err.message; }
  };
}


// ---------- Comissões / financeiro dos profissionais ----------
const COM = { periodo: 'hoje', de: null, ate: null, aberto: {} };
function intervaloPeriodo(p) {
  const h = hojeLocal();
  if (p === 'hoje') return [h, h];
  if (p === 'ontem') { const o = addDias(h, -1); return [o, o]; }
  if (p === 'semana') { const i = inicioSemana(h); return [i, addDias(i, 6)]; }
  if (p === 'semana_ant') { const i = addDias(inicioSemana(h), -7); return [i, addDias(i, 6)]; }
  if (p === 'mes') { const i = h.slice(0, 8) + '01'; const d = new Date(i + 'T12:00:00'); d.setMonth(d.getMonth() + 1); d.setDate(0); return [i, d.toISOString().slice(0, 10)]; }
  if (p === 'mes_ant') { const d = new Date(h.slice(0, 8) + '01T12:00:00'); d.setDate(0); const f = d.toISOString().slice(0, 10); return [f.slice(0, 8) + '01', f]; }
  return [COM.de || h, COM.ate || h];
}

async function pgComissoes(el) {
  const [de, ate] = intervaloPeriodo(COM.periodo);
  COM.de = de; COM.ate = ate;
  const r = await api(`/agenda/comissoes?de=${de}&ate=${ate}`);
  const t = r.totais;
  const periodos = [['hoje', 'Hoje'], ['ontem', 'Ontem'], ['semana', 'Esta semana'], ['semana_ant', 'Semana passada'], ['mes', 'Este mês'], ['mes_ant', 'Mês passado'], ['outro', 'Outro período']];
  el.innerHTML = `
    <div class="cabecalho"><div><h1>Comissões</h1><div class="muted">Atendimentos concluídos e quanto cada profissional ganha · ${de === ate ? brData(de) : `${brData(de)} a ${brData(ate)}`}</div></div>
      <div class="acoes"><a class="btn" href="#/agenda">← Agenda</a><button class="btn" id="com-csv">↓ Exportar CSV</button><button class="btn" id="com-imprimir">Imprimir</button></div></div>
    <div class="cartao" style="margin-bottom:14px"><div class="cartao-topo">
      <div class="seg" id="com-per">${periodos.map(([k, n]) => `<button data-p="${k}" class="${COM.periodo === k ? 'sel' : ''}">${n}</button>`).join('')}</div>
      <div class="filtros ${COM.periodo === 'outro' ? '' : 'hidden'}" id="com-datas"><input type="date" id="com-de" value="${de}"> até <input type="date" id="com-ate" value="${ate}"><button class="btn primario" id="com-ok">Ver</button></div>
    </div></div>
    <div class="grade g4">
      <div class="cartao kpi"><div class="rotulo">Atendimentos</div><div class="valor">${t.atendimentos}</div><div class="det">${t.pendentes ? `${t.pendentes} ainda não concluído(s)` : 'concluídos no período'}</div></div>
      <div class="cartao kpi"><div class="rotulo">Faturamento</div><div class="valor">${brl(t.faturamento)}</div><div class="det">recebido: ${brl(t.recebido)}</div></div>
      <div class="cartao kpi alerta"><div class="rotulo">Comissões a pagar</div><div class="valor">${brl(t.comissao)}</div><div class="det">soma dos profissionais</div></div>
      <div class="cartao kpi ok"><div class="rotulo">Fica para a casa</div><div class="valor">${brl(t.casa)}</div><div class="det">faturamento − comissões</div></div>
    </div>
    <div class="cartao" style="margin-top:14px"><div class="tabela-wrap"><table>
      <thead><tr><th>Profissional</th><th class="num">Atend.</th><th class="num">Faturamento</th><th class="num">Comissão</th><th class="num">Casa</th><th class="num">Faltas</th><th></th></tr></thead>
      <tbody>${r.profissionais.length ? r.profissionais.map((p) => `
        <tr><td><span class="ag-ponto" style="background:${esc(p.cor)}"></span><b>${esc(p.nome)}</b></td>
          <td class="num">${p.atendimentos}</td><td class="num">${brl(p.faturamento)}</td>
          <td class="num"><b>${brl(p.comissao)}</b></td><td class="num">${brl(p.casa)}</td>
          <td class="num">${p.faltas || '—'}</td>
          <td class="num">${p.itens.length ? `<button class="btn mini" data-det="${p.profissional_id}">${COM.aberto[p.profissional_id] ? 'Ocultar' : 'Detalhes'}</button>` : ''}</td></tr>
        ${COM.aberto[p.profissional_id] ? `<tr><td colspan="7" style="background:#fafcfd;padding:0"><table style="font-size:12.5px">
          <thead><tr><th>Data</th><th>Cliente</th><th>Serviço</th><th class="num">Valor</th><th class="num">%</th><th class="num">Comissão</th><th>Pagamento</th></tr></thead><tbody>
          ${p.itens.map((i) => `<tr><td>${brData(i.inicio.slice(0, 10))} ${i.inicio.slice(11)}</td><td>${esc(i.cliente || '')}</td><td>${esc(i.servico || '—')}</td>
            <td class="num">${brl(i.valor)}</td><td class="num">${i.pct}%</td><td class="num">${brl(i.comissao)}</td>
            <td>${i.pago ? `<span class="tag pago">${esc({ pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Crédito', debito: 'Débito' }[i.forma] || 'Pago')}</span>` : '<span class="tag hoje">Não pago</span>'}</td></tr>`).join('')}
          </tbody></table></td></tr>` : ''}`).join('')
        : '<tr><td colspan="7" class="vazio"><b>Nenhum atendimento concluído no período</b>A comissão entra quando o atendimento é marcado como “Concluído” na agenda.</td></tr>'}
      </tbody></table></div></div>
    <p class="muted pequeno" style="margin-top:10px">A comissão é calculada sobre o valor do atendimento no momento em que ele é concluído: usa o % do serviço, se tiver, ou o % do profissional. Mudar o percentual depois não altera atendimentos já concluídos.</p>`;

  $$('#com-per button').forEach((b) => b.onclick = () => { COM.periodo = b.dataset.p; if (b.dataset.p === 'outro') { $('#com-datas').classList.remove('hidden'); $$('#com-per button').forEach((x) => x.classList.toggle('sel', x === b)); } else rotear(); });
  const ok = $('#com-ok');
  if (ok) ok.onclick = () => { COM.de = $('#com-de').value; COM.ate = $('#com-ate').value; if (COM.de > COM.ate) return toast('A data inicial é depois da final', true); rotear(); };
  $$('[data-det]').forEach((b) => b.onclick = () => { COM.aberto[b.dataset.det] = !COM.aberto[b.dataset.det]; rotear(); });
  $('#com-imprimir').onclick = () => { r.profissionais.forEach((p) => COM.aberto[p.profissional_id] = true); rotear().then(() => setTimeout(() => window.print(), 300)); };
  $('#com-csv').onclick = () => {
    const linhas = [['Profissional', 'Data', 'Hora', 'Cliente', 'Serviço', 'Valor', '% comissão', 'Comissão', 'Pago', 'Forma']];
    for (const p of r.profissionais) for (const i of p.itens) linhas.push([p.nome, brData(i.inicio.slice(0, 10)), i.inicio.slice(11), i.cliente || '', i.servico || '', i.valor.toFixed(2).replace('.', ','), String(i.pct).replace('.', ','), i.comissao.toFixed(2).replace('.', ','), i.pago ? 'sim' : 'não', i.forma || '']);
    linhas.push([]);
    linhas.push(['Resumo', '', '', '', '', 'Faturamento', '', 'Comissão', 'Casa']);
    for (const p of r.profissionais) linhas.push([p.nome, '', '', '', '', p.faturamento.toFixed(2).replace('.', ','), '', p.comissao.toFixed(2).replace('.', ','), p.casa.toFixed(2).replace('.', ',')]);
    const csv = '﻿' + linhas.map((l) => l.map((v) => /[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `comissoes-${de}-a-${ate}.csv`;
    a.click();
  };
}
