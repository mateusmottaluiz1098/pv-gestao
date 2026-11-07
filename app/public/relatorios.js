/* Relatórios: entradas e atendimentos por mês, resultado por profissional */
/* Usa as funções globais do app.js: $, $$, esc, brl, api, ic, MOD, MESES */
const REL = { meses: 12, sel: null };

const mesCurto = (m) => `${MESES[Number(m.slice(5, 7)) - 1].slice(0, 3)}/${m.slice(2, 4)}`;
const mesLongo = (m) => `${MESES[Number(m.slice(5, 7)) - 1]} de ${m.slice(0, 4)}`;
function brlCurto(v) {
  const n = Number(v || 0);
  if (Math.abs(n) >= 1000) return 'R$ ' + (n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mil';
  return 'R$ ' + Math.round(n).toLocaleString('pt-BR');
}

// gráfico de barras simples (uma série), em SVG, com dica ao passar o mouse
function graficoBarras(dados, { valor, fmtEixo, fmtDica, sel, onClick, altura = 220 }) {
  // largura real da área (texto em tamanho normal em qualquer tela)
  const W = Math.max(300, Math.min(1200, (($('#conteudo') || {}).clientWidth || 800) - 70)), H = altura, padE = 58, padD = 8, padT = 12, padB = 26;
  const max = Math.max(1, ...dados.map(valor));
  // escala "redonda": 4 linhas de grade
  const passo = (() => { const bruto = max / 4; const p = 10 ** Math.floor(Math.log10(bruto)); return [1, 2, 2.5, 5, 10].map((k) => k * p).find((k) => k >= bruto); })();
  const topo = passo * 4;
  const y = (v) => padT + (H - padT - padB) * (1 - v / topo);
  const larg = (W - padE - padD) / dados.length;
  const barra = Math.min(38, larg * 0.62);
  const pulo = Math.max(1, Math.ceil(46 / larg)); // tela estreita: rótulo de mês alternado (o último sempre aparece)
  const grade = [0, 1, 2, 3, 4].map((i) => {
    const v = passo * i;
    return `<line x1="${padE}" x2="${W - padD}" y1="${y(v)}" y2="${y(v)}" class="gr-grade"/><text x="${padE - 8}" y="${y(v) + 4}" class="gr-eixo" text-anchor="end">${esc(fmtEixo(v))}</text>`;
  }).join('');
  const barras = dados.map((d, i) => {
    const v = valor(d);
    const x = padE + larg * i + (larg - barra) / 2;
    const yv = y(v), h = Math.max(0, y(0) - yv);
    const r = Math.min(4, h); // ponta arredondada só em cima, apoiada na base
    const path = h > 0 ? `M${x},${y(0)} V${yv + r} Q${x},${yv} ${x + r},${yv} H${x + barra - r} Q${x + barra},${yv} ${x + barra},${yv + r} V${y(0)} Z` : '';
    return `<g class="gr-col ${sel === d.mes ? 'sel' : ''}" data-i="${i}">
      <rect x="${padE + larg * i}" y="${padT}" width="${larg}" height="${H - padT - padB}" class="gr-alvo"/>
      ${path ? `<path d="${path}" class="gr-barra"/>` : ''}
      ${(dados.length - 1 - i) % pulo === 0 ? `<text x="${padE + larg * i + larg / 2}" y="${H - 8}" class="gr-eixo" text-anchor="middle">${esc(mesCurto(d.mes))}</text>` : ''}</g>`;
  }).join('');
  const id = 'gr' + Math.random().toString(36).slice(2, 8);
  setTimeout(() => {
    const box = document.getElementById(id);
    if (!box) return;
    const dica = box.querySelector('.gr-dica');
    box.querySelectorAll('.gr-col').forEach((g) => {
      const d = dados[g.dataset.i];
      g.addEventListener('mouseenter', () => { dica.innerHTML = fmtDica(d); dica.classList.remove('hidden'); });
      g.addEventListener('mousemove', (e) => {
        const r = box.getBoundingClientRect();
        const x = Math.min(e.clientX - r.left + 14, r.width - dica.offsetWidth - 4);
        dica.style.left = Math.max(4, x) + 'px'; dica.style.top = Math.max(0, e.clientY - r.top - dica.offsetHeight - 10) + 'px';
      });
      g.addEventListener('mouseleave', () => dica.classList.add('hidden'));
      if (onClick) g.addEventListener('click', () => onClick(d));
    });
  });
  return `<div class="grafico" id="${id}"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Gráfico de barras por mês">${grade}<line x1="${padE}" x2="${W - padD}" y1="${y(0)}" y2="${y(0)}" class="gr-base"/>${barras}</svg><div class="gr-dica hidden"></div></div>`;
}

async function pgRelatorios(el) {
  const r = await api(`/relatorios/mensal?meses=${REL.meses}`);
  const meses = r.meses;
  if (!REL.sel || !meses.some((m) => m.mes === REL.sel)) REL.sel = meses[meses.length - 1].mes;
  const usaAgenda = MOD('agenda');
  const atual = meses[meses.length - 1], anterior = meses[meses.length - 2] || { total: 0, qtd_atendimentos: 0 };
  const totalPeriodo = meses.reduce((s, m) => s + m.total, 0);
  const comMov = meses.filter((m) => m.total > 0);
  const media = comMov.length ? totalPeriodo / comMov.length : 0;
  const melhor = meses.reduce((a, b) => (b.total > a.total ? b : a), meses[0]);
  const partes = (m) => [['Cobranças', m.cobrancas], ['Atendimentos', m.atendimentos], ['Produtos', m.produtos], ['Pacotes e outros', m.outros]].filter(([, v]) => v > 0);
  el.innerHTML = `
    <div class="cabecalho"><div><h1>Relatórios</h1><div class="muted">Quanto entrou em cada mês${usaAgenda ? ', quantos atendimentos e o resultado de cada profissional' : ''}.</div></div>
      <div class="acoes"><div class="seg" id="rel-per">${[6, 12, 24].map((n) => `<button data-n="${n}" class="${REL.meses === n ? 'sel' : ''}">${n} meses</button>`).join('')}</div></div></div>
    <div class="grade g4">
      <div class="cartao kpi"><div class="rotulo">Entrou neste mês <span class="icone">${ic('caixa')}</span></div><div class="valor">${brl(atual.total)}</div>
        <div class="det">mês em andamento${anterior.total ? ` · ${mesCurto(anterior.mes)} fechou em ${brl(anterior.total)}` : ''}</div></div>
      <div class="cartao kpi"><div class="rotulo">Média por mês <span class="icone">${ic('grafico')}</span></div><div class="valor">${brl(media)}</div><div class="det">nos meses com movimento</div></div>
      <div class="cartao kpi"><div class="rotulo">Melhor mês <span class="icone">${ic('check')}</span></div><div class="valor">${brl(melhor.total)}</div><div class="det">${melhor.total ? mesLongo(melhor.mes) : '—'}</div></div>
      ${usaAgenda ? `<div class="cartao kpi"><div class="rotulo">Atendimentos neste mês <span class="icone">${ic('agenda')}</span></div><div class="valor">${atual.qtd_atendimentos}</div>
        <div class="det">${anterior.qtd_atendimentos ? `${anterior.qtd_atendimentos} em ${mesCurto(anterior.mes)}` : 'concluídos na agenda'}</div></div>`
        : `<div class="cartao kpi"><div class="rotulo">Total no período <span class="icone">${ic('dinheiro')}</span></div><div class="valor">${brl(totalPeriodo)}</div><div class="det">últimos ${REL.meses} meses</div></div>`}
    </div>
    <div class="cartao" style="margin-top:14px">
      <div class="cartao-topo"><div><h2>Entradas por mês</h2><div class="muted pequeno">Tudo o que entrou: cobranças pagas, atendimentos, produtos e pacotes. Clique numa barra para ver o mês.</div></div></div>
      <div style="padding:10px 14px 4px">${graficoBarras(meses, {
        valor: (d) => d.total, fmtEixo: brlCurto, sel: REL.sel,
        fmtDica: (d) => `<b>${mesLongo(d.mes)}</b><div class="gr-dica-v">${brl(d.total)}</div>${partes(d).map(([n, v]) => `<div class="gr-dica-l"><span>${n}</span><b>${brl(v)}</b></div>`).join('')}${d.saidas ? `<div class="gr-dica-l muted"><span>Saídas do caixa</span><b>${brl(d.saidas)}</b></div>` : ''}`,
        onClick: (d) => { REL.sel = d.mes; pgRelatorios(el); },
      })}</div>
    </div>
    ${usaAgenda ? `<div class="cartao" style="margin-top:14px">
      <div class="cartao-topo"><div><h2>Atendimentos concluídos por mês</h2><div class="muted pequeno">Quantos atendimentos foram feitos na agenda.</div></div></div>
      <div style="padding:10px 14px 4px">${graficoBarras(meses, {
        valor: (d) => d.qtd_atendimentos, fmtEixo: (v) => String(Math.round(v)), sel: REL.sel, altura: 170,
        fmtDica: (d) => `<b>${mesLongo(d.mes)}</b><div class="gr-dica-v">${d.qtd_atendimentos} atendimento(s)</div>${d.comissoes ? `<div class="gr-dica-l"><span>Comissões</span><b>${brl(d.comissoes)}</b></div>` : ''}`,
        onClick: (d) => { REL.sel = d.mes; pgRelatorios(el); },
      })}</div>
    </div>` : ''}
    <div class="grade ${usaAgenda ? 'g2' : ''}" style="margin-top:14px">
      ${usaAgenda ? `<div class="cartao"><div class="cartao-topo"><div><h2>Profissionais em ${mesLongo(REL.sel)}</h2><div class="muted pequeno">Atendimentos concluídos e produtos vendidos no mês.</div></div></div>
        <div id="rel-prof"><p class="muted" style="padding:16px">Carregando…</p></div></div>` : ''}
      <div class="cartao"><div class="cartao-topo"><h2>Mês a mês</h2></div>
        <div class="tabela-wrap"><table><thead><tr><th>Mês</th><th class="num">Entrou</th><th class="num">Cobranças</th><th class="num">Atend. + produtos</th>${usaAgenda ? '<th class="num">Atend.</th>' : ''}</tr></thead><tbody>
          ${meses.slice().reverse().map((m) => `<tr class="${m.mes === REL.sel ? 'linha-sel' : ''}"><td><b>${mesCurto(m.mes)}</b></td><td class="num"><b>${brl(m.total)}</b></td><td class="num">${brl(m.cobrancas)}</td><td class="num">${brl(m.atendimentos + m.produtos + m.outros)}</td>${usaAgenda ? `<td class="num">${m.qtd_atendimentos}</td>` : ''}</tr>`).join('')}
        </tbody></table></div></div>
    </div>`;
  $$('#rel-per button').forEach((b) => b.onclick = () => { REL.meses = Number(b.dataset.n); pgRelatorios(el); });
  if (usaAgenda) {
    const d = await api(`/relatorios/profissionais?mes=${REL.sel}`);
    const box = $('#rel-prof');
    if (!box) return;
    box.innerHTML = d.profissionais.length ? `<div class="tabela-wrap"><table><thead><tr><th>Profissional</th><th class="num">Atend.</th><th class="num">Ticket médio</th><th class="num">Faturou</th><th class="num">Comissão</th></tr></thead><tbody>
      ${d.profissionais.map((p) => `<tr><td><span class="ag-ponto" style="background:${esc(p.cor)}"></span><b>${esc(p.nome)}</b><div class="sub2">${p.clientes} cliente(s)${p.produtos ? ` · produtos ${brl(p.produtos)}` : ''}${p.faltas ? ` · ${p.faltas} falta(s)` : ''}</div></td>
        <td class="num">${p.atendimentos}</td><td class="num">${brl(p.ticket)}</td><td class="num"><b>${brl(p.faturamento)}</b></td><td class="num">${brl(p.comissao)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="vazio" style="padding:18px">Nenhum atendimento concluído neste mês.</div>';
  }
}
