/* Caixa do dia, produtos/vendas e consumo avulso (fiado) */
/* Usa as funções globais do app.js: $, $$, esc, brl, brData, fone, api, toast, abrirModal, fecharModal, confirmar, pode, rotear, NOME_PAGTO */

const CX = { data: null };
const FORMAS_CX = [['dinheiro', 'Dinheiro'], ['pix', 'Pix'], ['debito', 'Cartão de débito'], ['cartao', 'Cartão de crédito'], ['transferencia', 'Transferência']];
const NOME_ORIGEM = { atendimento: 'Atendimento', cobranca: 'Cobrança', venda: 'Produto', manual: 'Lançamento' };
function hojeCx() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function diaCx(iso, n) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

// ---------- Caixa do dia ----------
async function pgCaixa(el) {
  CX.data = CX.data || hojeCx();
  const r = await api(`/caixa?data=${CX.data}`);
  const t = r.totais;
  const ehHoje = CX.data === hojeCx();
  const dataExt = new Date(CX.data + 'T12:00').toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  const formas = Object.entries(r.por_forma).sort((a, b) => b[1] - a[1]);
  el.innerHTML = `
    <div class="cabecalho">
      <div><h1>Caixa do dia</h1><div class="muted">${esc(dataExt)}${ehHoje ? ' · hoje' : ''}</div></div>
      <div class="acoes">
        <button class="btn" id="cx-ant" aria-label="Dia anterior">${ic('esquerda')}</button><input type="date" id="cx-data" value="${CX.data}" style="width:auto;margin:0"><button class="btn" id="cx-prox" aria-label="Próximo dia">${ic('direita')}</button>
        <button class="btn ${MOD('produtos') ? '' : 'hidden'}" id="cx-prod">${ic('produtos')} Produtos</button>
        <button class="btn" id="cx-mov">${ic('mais')} Despesa / retirada</button>
        <button class="btn primario ${MOD('produtos') ? '' : 'hidden'}" id="cx-venda">${ic('mais')} Vender produto</button>
      </div>
    </div>
    <div class="grade g4">
      <div class="cartao kpi ok"><div class="rotulo">Entrou no caixa</div><div class="valor">${brl(t.entradas)}</div><div class="det">${r.entradas.length} lançamento(s)</div></div>
      <div class="cartao kpi"><div class="rotulo">Dinheiro na gaveta</div><div class="valor">${brl(t.dinheiro_em_caixa)}</div><div class="det">dinheiro que entrou − saídas em dinheiro</div></div>
      <div class="cartao kpi alerta"><div class="rotulo">Comissões do dia</div><div class="valor">${brl(t.comissoes)}</div><div class="det">despesas/retiradas: ${brl(t.saidas)}</div></div>
      <div class="cartao kpi"><div class="rotulo">Fica para a casa</div><div class="valor">${brl(t.resultado)}</div><div class="det">entradas − saídas − comissões</div></div>
    </div>
    ${r.fiado.qtd ? `<div class="aviso" style="margin-top:14px">${ic('cobrancas')} ${r.fiado.qtd} consumo(s) pendurado(s) no fiado hoje, total <b>${brl(r.fiado.valor)}</b>. Entra no caixa quando o cliente pagar a cobrança.</div>` : ''}
    <div class="grade g2" style="margin-top:14px">
      <div class="cartao">
        <div class="cartao-topo"><h2>Por forma de pagamento</h2></div>
        ${formas.length ? formas.map(([f, v]) => `<div class="lista-item"><div class="cresce"><b>${esc(NOME_PAGTO[f] || f)}</b></div><div class="num"><b>${brl(v)}</b></div></div>`).join('') : '<div class="vazio" style="padding:18px">Nada recebido neste dia.</div>'}
      </div>
      <div class="cartao ${MOD('comissoes') ? '' : 'hidden'}">
        <div class="cartao-topo"><h2>Comissões por profissional</h2><a class="btn mini" href="#/comissoes">${ic('grafico')} Relatório</a></div>
        ${r.comissoes.length ? r.comissoes.map((c) => `<div class="lista-item"><span class="ag-ponto" style="background:${esc(c.cor)}"></span><div class="cresce"><b>${esc(c.nome)}</b><div class="muted pequeno">${c.atendimentos} atendimento(s)${c.produtos ? ` · produtos ${brl(c.produtos)}` : ''}</div></div><div class="num"><b>${brl(c.total)}</b></div></div>`).join('') : '<div class="vazio" style="padding:18px">Nenhum atendimento concluído neste dia.</div>'}
      </div>
    </div>
    <div class="cartao" style="margin-top:14px">
      <div class="cartao-topo"><h2>Entradas</h2><button class="btn mini" id="cx-imprimir">${ic('imprimir')} Imprimir fechamento</button></div>
      <div class="tabela-wrap"><table><thead><tr><th>Hora</th><th>Origem</th><th>Descrição</th><th>Cliente</th><th>Forma</th><th class="num">Valor</th><th></th></tr></thead><tbody>
      ${r.entradas.length ? r.entradas.map((e) => `<tr><td>${esc(e.hora || '—')}</td><td><span class="tag">${NOME_ORIGEM[e.origem] || e.origem}</span></td>
        <td>${esc(e.descricao)}${e.profissional ? `<div class="sub2">${esc(e.profissional)}</div>` : ''}</td><td>${esc(e.cliente || '')}</td>
        <td>${esc(NOME_PAGTO[e.forma] || e.forma)}</td><td class="num"><b>${brl(e.valor)}</b></td>
        <td class="num">${e.origem === 'venda' ? `<button class="btn mini" data-del-venda="${e.id}" title="Estornar venda" aria-label="Estornar venda">${ic('lixo')}</button>` : e.origem === 'manual' ? `<button class="btn mini" data-del-mov="${e.id}" title="Excluir lançamento" aria-label="Excluir lançamento">${ic('lixo')}</button>` : ''}</td></tr>`).join('')
        : '<tr><td colspan="7" class="vazio"><b>Nenhuma entrada</b>Atendimentos pagos na agenda, cobranças pagas e produtos vendidos aparecem aqui.</td></tr>'}
      </tbody></table></div>
    </div>
    ${r.saidas.length ? `<div class="cartao" style="margin-top:14px"><div class="cartao-topo"><h2>Saídas (despesas e retiradas)</h2></div>
      <div class="tabela-wrap"><table><thead><tr><th>Hora</th><th>Descrição</th><th>Forma</th><th>Lançado por</th><th class="num">Valor</th><th></th></tr></thead><tbody>
      ${r.saidas.map((e) => `<tr><td>${esc(e.hora)}</td><td>${esc(e.descricao)}</td><td>${esc(NOME_PAGTO[e.forma] || e.forma)}</td><td class="pequeno muted">${esc(e.por || '')}</td><td class="num"><b>${brl(e.valor)}</b></td>
        <td class="num"><button class="btn mini" data-del-mov="${e.id}" title="Excluir lançamento" aria-label="Excluir lançamento">${ic('lixo')}</button></td></tr>`).join('')}
      </tbody></table></div></div>` : ''}
    <p class="muted pequeno" style="margin-top:10px">Atendimento entra no caixa quando é marcado como pago na agenda. Fiado entra só quando a cobrança é paga. Comissões contam os atendimentos concluídos e os produtos vendidos no dia.</p>`;

  $('#cx-ant').onclick = () => { CX.data = diaCx(CX.data, -1); rotear(); };
  $('#cx-prox').onclick = () => { CX.data = diaCx(CX.data, 1); rotear(); };
  $('#cx-data').onchange = (e) => { if (e.target.value) { CX.data = e.target.value; rotear(); } };
  $('#cx-prod').onclick = () => modalProdutos();
  $('#cx-venda').onclick = () => modalVenda(() => rotear());
  $('#cx-mov').onclick = () => modalMovimento(() => rotear());
  $('#cx-imprimir').onclick = () => window.print();
  $$('[data-del-venda]').forEach((b) => b.onclick = async () => {
    if (!(await confirmar('Estornar venda?', 'A venda sai do caixa e o produto volta para o estoque.', 'Estornar', true))) return;
    try { await api(`/vendas/${b.dataset.delVenda}`, { method: 'DELETE' }); toast('Venda estornada'); } catch (e) { toast(e.message, true); }
    rotear();
  });
  $$('[data-del-mov]').forEach((b) => b.onclick = async () => {
    if (!(await confirmar('Excluir lançamento?', 'Ele sai do caixa deste dia.', 'Excluir', true))) return;
    await api(`/caixa/movimentos/${b.dataset.delMov}`, { method: 'DELETE' }); toast('Excluído'); rotear();
  });
}

// ---------- Despesa / retirada / entrada manual ----------
function modalMovimento(aoSalvar) {
  abrirModal(`<form id="f-mov">
    <div class="modal-topo"><h2>Lançamento no caixa</h2><button type="button" class="fechar" data-fechar>×</button></div>
    <div class="modal-corpo">
      <div class="seg" id="mov-tipo" style="margin-bottom:12px"><button type="button" data-t="saida" class="sel">Despesa / retirada</button><button type="button" data-t="entrada">Entrada avulsa</button></div>
      <label>Descrição<input name="descricao" required placeholder="ex.: Compra de lâminas, troco inicial, retirada do dono"></label>
      <div class="linha"><label>Valor (R$)<input name="valor" inputmode="decimal" required></label>
        <label>Forma<select name="forma">${FORMAS_CX.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}</select></label></div>
      <p class="erro-txt" id="mov-erro"></p>
    </div>
    <div class="modal-rodape"><button type="button" class="btn" data-fechar>Cancelar</button><button class="btn primario">Lançar</button></div></form>`);
  let tipo = 'saida';
  $$('#mov-tipo button').forEach((b) => b.onclick = () => { tipo = b.dataset.t; $$('#mov-tipo button').forEach((x) => x.classList.toggle('sel', x === b)); });
  $('#f-mov').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/caixa/movimentos', { method: 'POST', body: { tipo, descricao: f.descricao.value, valor: f.valor.value, forma: f.forma.value, data: CX.data || hojeCx() } });
      fecharModal(); toast('Lançado ✓'); aoSalvar && aoSalvar();
    } catch (err) { $('#mov-erro').textContent = err.message; }
  };
}

// ---------- Venda de produto ----------
async function modalVenda(aoSalvar) {
  const [prods, profs] = await Promise.all([api('/produtos'), api('/agenda/profissionais')]);
  const ativos = prods.filter((p) => p.ativo);
  if (!ativos.length) {
    if (pode('agenda_config')) return modalProdutos(true);
    return toast('Nenhum produto cadastrado. Peça ao administrador para cadastrar.', true);
  }
  abrirModal(`<form id="f-vd">
    <div class="modal-topo"><h2>Vender produto</h2><button type="button" class="fechar" data-fechar>×</button></div>
    <div class="modal-corpo">
      <div class="linha3"><label>Produto<select name="produto_id">${ativos.map((p) => `<option value="${p.id}" data-preco="${p.preco}" data-estoque="${p.estoque ?? ''}">${esc(p.nome)} · ${brl(p.preco)}</option>`).join('')}</select></label>
        <label>Quantidade<input name="quantidade" type="number" min="1" value="1"></label>
        <label>Valor unitário (R$)<input name="valor_unit" inputmode="decimal"></label></div>
      <div id="vd-estoque" class="muted pequeno" style="margin:-4px 0 10px"></div>
      <div class="linha"><label>Vendido por (comissão)<select name="profissional_id"><option value="">— sem comissão —</option>${profs.filter((p) => p.ativo).map((p) => `<option value="${p.id}">${esc(p.nome)}</option>`).join('')}</select></label>
        <label>Forma de pagamento<select name="forma_pagamento">${FORMAS_CX.map(([k, n]) => `<option value="${k}">${n}</option>`).join('')}<option value="fiado">Pendurar na conta (fiado)</option></select></label></div>
      <div class="linha" id="vd-cli"><label>Cliente<input name="cliente_nome" placeholder="Nome"></label><label>WhatsApp<input name="telefone" placeholder="51 99999-9999"></label></div>
      <div class="total-venda" style="font-size:18px;margin:6px 0"><span class="muted">Total:</span> <b id="vd-total"></b></div>
      <p class="erro-txt" id="vd-erro"></p>
    </div>
    <div class="modal-rodape"><button type="button" class="btn" data-fechar>Cancelar</button><button class="btn verde">Registrar venda</button></div></form>`);
  const f = $('#f-vd');
  const atualizar = () => {
    const o = f.produto_id.selectedOptions[0];
    const unit = Number(String(f.valor_unit.value || o.dataset.preco).replace(',', '.')) || 0;
    $('#vd-total').textContent = brl(unit * (Number(f.quantidade.value) || 1));
    $('#vd-estoque').textContent = o.dataset.estoque !== '' ? `Em estoque: ${o.dataset.estoque}` : '';
    $('#vd-cli').classList.toggle('hidden', f.forma_pagamento.value !== 'fiado');
  };
  f.produto_id.onchange = () => { f.valor_unit.value = String(f.produto_id.selectedOptions[0].dataset.preco).replace('.', ','); atualizar(); };
  f.quantidade.oninput = atualizar; f.valor_unit.oninput = atualizar; f.forma_pagamento.onchange = atualizar;
  f.valor_unit.value = String(f.produto_id.selectedOptions[0].dataset.preco).replace('.', ',');
  atualizar();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(f));
    body.valor_unit = String(body.valor_unit).replace(',', '.');
    body.data = CX.data || hojeCx();
    try {
      const r = await api('/vendas', { method: 'POST', body });
      fecharModal();
      toast(r.fiado ? `Venda pendurada na conta de ${body.cliente_nome || 'cliente'} ✓` : 'Venda registrada ✓');
      aoSalvar && aoSalvar();
    } catch (err) { $('#vd-erro').textContent = err.message; }
  };
}

// ---------- Cadastro de produtos ----------
async function modalProdutos(depoisVender) {
  const prods = await api('/produtos');
  abrirModal(`<div class="modal-topo"><h2>Produtos</h2><button class="fechar" data-fechar>×</button></div>
    <div class="modal-corpo">
      ${depoisVender ? `<div class="aviso info pequeno">Cadastre os produtos que você vende (ex.: ${esc(EX('produto', 'Pomada'))}) para registrar as vendas.</div>` : ''}
      <div class="tabela-wrap cartao" style="margin-bottom:14px"><table><thead><tr><th>Produto</th><th class="num">Preço</th><th class="num">Comissão</th><th class="num">Estoque</th><th></th></tr></thead><tbody>
      ${prods.map((p) => `<tr><td><b>${esc(p.nome)}</b> ${p.ativo ? '' : '<span class="tag">Inativo</span>'}</td><td class="num">${brl(p.preco)}</td><td class="num">${Number(p.comissao_pct)}%</td>
        <td class="num">${p.estoque == null ? '<span class="muted">—</span>' : p.estoque <= 0 ? `<span class="tag atrasado">${p.estoque}</span>` : p.estoque}</td>
        <td class="num"><button class="btn mini" data-pr="${p.id}">Editar</button></td></tr>`).join('') || '<tr><td colspan="5" class="vazio">Nenhum produto ainda.</td></tr>'}
      </tbody></table></div>
      <form id="f-pr" class="cartao pad">
        <h3 id="pr-tit">Novo produto</h3>
        <div class="linha"><label>Nome<input name="nome" required placeholder="ex.: ${esc(EX('produto', 'Pomada modeladora'))}"></label><label>Preço (R$)<input name="preco" inputmode="decimal" placeholder="0,00"></label></div>
        <div class="linha"><label>Comissão de quem vende (%)<input name="comissao_pct" inputmode="decimal" value="0"></label>
          <label>Estoque (opcional)<input name="estoque" type="number" placeholder="em branco = não controlar"></label></div>
        <label class="check"><input type="checkbox" name="ativo" checked> Ativo</label>
        <div class="acoes"><button class="btn primario">Salvar produto</button><button type="button" class="btn hidden" id="pr-cancelar">Cancelar edição</button><button type="button" class="btn perigo hidden" id="pr-excluir">Excluir</button></div>
        <p class="erro-txt" id="pr-erro"></p>
      </form>
    </div>
    <div class="modal-rodape"><button class="btn" data-fechar>Fechar</button>${depoisVender ? `<button class="btn primario" id="pr-vender">Ir para a venda ${ic('direita')}</button>` : ''}</div>`, true);
  $$('[data-fechar]').forEach((b) => b.addEventListener('click', () => { if (location.hash.includes('caixa')) rotear(); }));
  const pv = $('#pr-vender'); if (pv) pv.onclick = () => modalVenda(() => rotear());
  const f = $('#f-pr');
  let editando = null;
  $$('[data-pr]').forEach((b) => b.onclick = () => {
    const p = prods.find((x) => x.id == b.dataset.pr);
    editando = p.id;
    f.nome.value = p.nome; f.preco.value = String(p.preco).replace('.', ','); f.comissao_pct.value = String(Number(p.comissao_pct)).replace('.', ',');
    f.estoque.value = p.estoque ?? ''; f.ativo.checked = p.ativo;
    $('#pr-tit').textContent = 'Editar produto';
    $('#pr-cancelar').classList.remove('hidden'); $('#pr-excluir').classList.remove('hidden');
    f.nome.focus();
  });
  $('#pr-cancelar').onclick = () => modalProdutos(depoisVender);
  $('#pr-excluir').onclick = async () => {
    try { await api(`/produtos/${editando}`, { method: 'DELETE' }); toast('Produto excluído'); modalProdutos(depoisVender); }
    catch (err) { $('#pr-erro').textContent = err.message; }
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = { nome: f.nome.value, preco: f.preco.value.replace(',', '.'), comissao_pct: f.comissao_pct.value.replace(',', '.'), estoque: f.estoque.value, ativo: f.ativo.checked };
    try { await api(editando ? `/produtos/${editando}` : '/produtos', { method: editando ? 'PUT' : 'POST', body }); toast('Produto salvo ✓'); modalProdutos(depoisVender); }
    catch (err) { $('#pr-erro').textContent = err.message; }
  };
}

// ---------- Lançar consumo avulso na ficha do cliente ----------
async function modalConsumo(cliente, aoSalvar) {
  const servs = await api('/agenda/servicos').catch(() => []);
  const ativos = servs.filter((s) => s.ativo);
  abrirModal(`<form id="f-cs">
    <div class="modal-topo"><h2>Lançar consumo · ${esc(cliente.nome)}</h2><button type="button" class="fechar" data-fechar>×</button></div>
    <div class="modal-corpo">
      ${ativos.length ? `<div class="filtros" style="margin-bottom:10px">${ativos.map((s) => `<button type="button" class="btn mini" data-sv="${s.id}">${esc(s.nome)} · ${brl(s.preco)}</button>`).join('')}</div>` : ''}
      <div class="linha3"><label>O que foi<input name="descricao" required placeholder="ex.: ${esc(EX('consumo', 'Corte'))}"></label>
        <label>Valor (R$)<input name="valor" inputmode="decimal" required></label>
        <label>Data<input type="date" name="data" value="${hojeCx()}"></label></div>
      <label class="check"><input type="radio" name="modo" value="agora" checked> <span><b>Cobrar agora</b>: gera uma cobrança com vencimento hoje</span></label>
      <label class="check" id="cs-enviar-l" style="margin-left:24px"><input type="checkbox" name="enviar" checked> Mandar no WhatsApp com o Pix</label>
      <label class="check"><input type="radio" name="modo" value="pendurar"> <span><b>Pendurar na conta (fiado)</b>: ${cliente.forma === 'avulso' ? 'fica anotado até você cobrar o fiado' : 'entra na próxima cobrança do cliente'}</span></label>
      <p class="erro-txt" id="cs-erro"></p>
    </div>
    <div class="modal-rodape"><button type="button" class="btn" data-fechar>Cancelar</button><button class="btn primario">Lançar</button></div></form>`);
  const f = $('#f-cs');
  $$('[data-sv]').forEach((b) => b.onclick = () => {
    const s = ativos.find((x) => x.id == b.dataset.sv);
    f.descricao.value = s.nome; f.valor.value = String(s.preco).replace('.', ',');
  });
  const tg = () => $('#cs-enviar-l').classList.toggle('hidden', f.modo.value !== 'agora');
  $$('input[name=modo]', f).forEach((r) => r.onchange = tg);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = { descricao: f.descricao.value, valor: f.valor.value.replace(',', '.'), data: f.data.value, modo: f.modo.value, enviar: f.enviar.checked };
    try {
      const r = await api(`/clientes/${cliente.id}/consumos`, { method: 'POST', body });
      fecharModal();
      if (r.aviso) toast(r.aviso, true);
      else if (body.modo === 'agora') toast(body.enviar ? 'Cobrança enviada no WhatsApp ✓' : 'Cobrança criada ✓');
      else toast(r.anexado_em ? `Pendurado: entra na cobrança de ${brData(r.anexado_em)} ✓` : 'Pendurado no fiado ✓');
      aoSalvar && aoSalvar();
    } catch (err) { $('#cs-erro').textContent = err.message; }
  };
}
