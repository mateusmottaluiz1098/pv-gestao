/* Página pública de agendamento (sem login) */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
function hojeLocal() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function addDias(iso, n) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function dataLonga(iso) { return new Date(iso + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }); }

const S = { info: null, servico: null, prof: 0, data: null, hora: null, horarios: [] };

async function getJSON(url, opt) {
  const r = await fetch(url, opt);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.erro || 'Não foi possível carregar. Tente de novo.');
  return d;
}

function aplicarMarca(i) {
  document.documentElement.dataset.tema = i.tema || 'azul';
  document.title = `Agendar · ${i.empresa || i.sistema_nome || ''}`;
  if (i.tem_logo) $('#favicon').href = `/marca/logo?v=${i.logo_versao || ''}`;
}

async function iniciar() {
  try { S.info = await getJSON('/api/publico/agenda'); } catch (e) { $('#raiz').innerHTML = `<div class="aviso">${esc(e.message)}</div>`; return; }
  const i = S.info;
  aplicarMarca(i);
  const topo = `<div class="ag-pub-topo"><span class="logo-marca">${i.tem_logo ? `<img src="/marca/logo?v=${i.logo_versao || ''}" alt="">` : '✂'}</span><div><h1>${esc(i.empresa || i.sistema_nome)}</h1><div class="muted pequeno">Agende seu horário</div></div></div>`;
  if (!i.ativo) {
    $('#raiz').innerHTML = topo + '<div class="passo"><b>Agendamento online indisponível no momento.</b><p class="muted">Chame a gente no WhatsApp para marcar seu horário.</p></div>';
    return;
  }
  if (!i.servicos.length || !i.profissionais.length) {
    $('#raiz').innerHTML = topo + '<div class="passo"><b>Ainda não há horários disponíveis para agendar por aqui.</b></div>';
    return;
  }
  if (i.profissionais.length === 1) S.prof = i.profissionais[0].id;
  $('#raiz').innerHTML = `${topo}
    ${i.aviso ? `<div class="aviso info">${esc(i.aviso)}</div>` : ''}
    <div class="passo" id="p1"><h2><span class="n">1</span>Serviço</h2><div class="opcoes">${i.servicos.map((s) => `<button class="op" data-s="${s.id}"><span><b>${esc(s.nome)}</b><br><small>${s.duracao_min} min</small></span><b>${Number(s.preco) ? brl(s.preco) : ''}</b></button>`).join('')}</div></div>
    ${i.profissionais.length > 1 ? `<div class="passo inativo" id="p2"><h2><span class="n">2</span>Profissional</h2><div class="opcoes"><button class="op sel" data-p="0"><b>Sem preferência</b><small>primeiro horário livre</small></button>${i.profissionais.map((p) => `<button class="op" data-p="${p.id}"><b>${esc(p.nome)}</b></button>`).join('')}</div></div>` : ''}
    <div class="passo inativo" id="p3"><h2><span class="n">${i.profissionais.length > 1 ? 3 : 2}</span>Dia e horário</h2><div class="dias" id="dias"></div><div id="horas"></div></div>
    <div class="passo inativo" id="p4"><h2><span class="n">${i.profissionais.length > 1 ? 4 : 3}</span>Seus dados</h2>
      <form id="f-ag">
        <div class="resumo-ag" id="resumo"></div>
        <label>Seu nome<input name="nome" required autocomplete="name" maxlength="80"></label>
        <label>WhatsApp com DDD<input name="telefone" required inputmode="tel" autocomplete="tel" placeholder="51 99999-9999"></label>
        <input class="escondido" name="site" tabindex="-1" autocomplete="off">
        <p class="erro-txt" id="erro"></p>
        <button class="btn primario largo" id="confirmar">Confirmar agendamento</button>
        <p class="muted pequeno" style="text-align:center;margin-top:10px">Você vai receber a confirmação no WhatsApp.</p>
      </form></div>`;

  $$('[data-s]').forEach((b) => b.onclick = () => {
    S.servico = i.servicos.find((s) => s.id == b.dataset.s);
    $$('[data-s]').forEach((x) => x.classList.toggle('sel', x === b));
    const p2 = $('#p2');
    if (p2) p2.classList.remove('inativo');
    $('#p3').classList.remove('inativo');
    desenharDias();
  });
  $$('[data-p]').forEach((b) => b.onclick = () => {
    S.prof = Number(b.dataset.p);
    $$('[data-p]').forEach((x) => x.classList.toggle('sel', x === b));
    desenharDias();
  });
  $('#f-ag').onsubmit = enviar;
}

function trabalhaNoDia(iso) {
  const d = new Date(iso + 'T12:00:00').getDay();
  const profs = S.prof ? S.info.profissionais.filter((p) => p.id === S.prof) : S.info.profissionais;
  return profs.some((p) => (p.dias || []).includes(d));
}

function desenharDias() {
  const h = hojeLocal();
  const lista = Array.from({ length: S.info.dias + 1 }, (_, k) => addDias(h, k));
  if (!S.data || !trabalhaNoDia(S.data)) S.data = lista.find(trabalhaNoDia) || h;
  $('#dias').innerHTML = lista.map((d) => {
    const dt = new Date(d + 'T12:00:00');
    return `<button class="dia ${d === S.data ? 'sel' : ''}" data-d="${d}" ${trabalhaNoDia(d) ? '' : 'disabled'}><small>${d === h ? 'Hoje' : DIAS[dt.getDay()]}</small><b>${dt.getDate()}</b><small>${dt.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')}</small></button>`;
  }).join('');
  $$('[data-d]').forEach((b) => b.onclick = () => { S.data = b.dataset.d; $$('[data-d]').forEach((x) => x.classList.toggle('sel', x === b)); carregarHoras(); });
  const sel = $('.dia.sel');
  if (sel) sel.scrollIntoView({ inline: 'center', block: 'nearest' });
  carregarHoras();
}

async function carregarHoras() {
  S.hora = null;
  $('#p4').classList.add('inativo');
  const box = $('#horas');
  box.innerHTML = '<p class="muted pequeno" style="margin-top:12px">Buscando horários…</p>';
  try {
    S.horarios = await getJSON(`/api/publico/agenda/horarios?data=${S.data}&servico_id=${S.servico.id}${S.prof ? `&profissional_id=${S.prof}` : ''}`);
  } catch (e) { box.innerHTML = `<div class="aviso" style="margin-top:12px">${esc(e.message)}</div>`; return; }
  if (!S.horarios.length) { box.innerHTML = `<p class="muted" style="margin-top:12px">Sem horários livres em ${esc(dataLonga(S.data))}. Escolha outro dia.</p>`; return; }
  box.innerHTML = `<div class="horas">${S.horarios.map((x) => `<button class="hora" data-h="${x.hora}">${x.hora}</button>`).join('')}</div>`;
  $$('[data-h]').forEach((b) => b.onclick = () => {
    S.hora = b.dataset.h;
    $$('[data-h]').forEach((x) => x.classList.toggle('sel', x === b));
    const slot = S.horarios.find((x) => x.hora === S.hora);
    const prof = S.info.profissionais.find((p) => p.id === (S.prof || slot.profissional_id));
    $('#resumo').innerHTML = `✂ <b>${esc(S.servico.nome)}</b>${Number(S.servico.preco) ? ` · ${brl(S.servico.preco)}` : ''}<br>📅 ${esc(dataLonga(S.data))} às <b>${S.hora}</b><br>👤 ${esc(prof ? prof.nome : '')}`;
    $('#p4').classList.remove('inativo');
    $('#p4').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

async function enviar(e) {
  e.preventDefault();
  const f = e.target;
  $('#erro').textContent = '';
  const btn = $('#confirmar');
  btn.disabled = true; btn.textContent = 'Agendando…';
  try {
    const r = await getJSON('/api/publico/agenda', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ servico_id: S.servico.id, profissional_id: S.prof || null, data: S.data, hora: S.hora, nome: f.nome.value, telefone: f.telefone.value, site: f.site.value }),
    });
    $('#raiz').innerHTML = `<div class="passo ok-final"><div class="grande">✅</div><h2 style="justify-content:center">Horário marcado!</h2>
      <p><b>${esc(r.servico || '')}</b> com <b>${esc(r.profissional || '')}</b><br>${esc(dataLonga(r.data))} às <b>${esc(r.hora)}</b></p>
      <p class="muted">${r.whatsapp ? 'Mandamos a confirmação no seu WhatsApp. Se não puder vir, responda CANCELAR por lá.' : 'Até lá! Se não puder vir, avise a gente pelo WhatsApp.'}</p>
      <button class="btn" onclick="location.reload()">Marcar outro horário</button></div>`;
  } catch (err) {
    $('#erro').textContent = err.message;
    btn.disabled = false; btn.textContent = 'Confirmar agendamento';
    if (/ocupado/.test(err.message)) carregarHoras();
  }
}

iniciar();
