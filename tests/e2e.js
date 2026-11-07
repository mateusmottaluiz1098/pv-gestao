// Teste de ponta a ponta do PV Gestão (roda dentro do container, contra http://127.0.0.1:3000)
const BASE = 'http://127.0.0.1:3000';
let cookie = '';
let falhas = 0;
async function api(m, url, body, semLogin) {
  const r = await fetch(BASE + url, { method: m, headers: { 'Content-Type': 'application/json', ...(semLogin ? {} : { cookie }) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  if (!r.ok) throw new Error(`${m} ${url} -> ${r.status} ${JSON.stringify(d)}`);
  return d;
}
function ok(cond, msg, extra) { if (cond) console.log('  ✓', msg); else { falhas++; console.log('  ✗', msg, extra !== undefined ? JSON.stringify(extra) : ''); } }
const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const add = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dow = (d) => new Date(d + 'T12:00:00Z').getUTCDay();

(async () => {
  console.log('LOGIN'); await api('POST', '/api/login', { login: 'admin', senha: process.env.SENHA_TESTE });
  console.log('CADASTROS');
  const sv = await api('POST', '/api/agenda/servicos', { nome: 'Corte', duracao_min: 30, preco: '40', ativo: true });
  const pr = await api('POST', '/api/agenda/profissionais', { nome: 'Carlos', cor: '#31b2e8', comissao_pct: '50', ativo: true, expediente: { dias: [0, 1, 2, 3, 4, 5, 6], inicio: '00:00', fim: '23:30' } });
  ok(sv.id && pr.id, 'serviço e profissional');

  console.log('1) SEMANAL');
  const ds = (dow(hoje) + 1) % 7;
  const sem = await api('POST', '/api/clientes', { nome: 'Joao Semanal', telefone: '51 99111-1111', forma: 'semanal', dia_semana: ds, valor: '50', ativo: true });
  let ficha = await api('GET', `/api/clientes/${sem.id}`);
  ok(ficha.dia_semana === ds && ficha.primeiro_vencimento === add(hoje, 1), 'primeiro vencimento = amanhã', [ficha.dia_semana, ficha.primeiro_vencimento]);
  ok(ficha.cobrancas.length === 2 && ficha.cobrancas.every((c) => c.valor === 50), 'gera 2 cobranças semanais (horizonte 10 dias)', ficha.cobrancas.map((c) => [c.vencimento, c.valor]));
  const qz = await api('POST', '/api/clientes', { nome: 'Ana Quinzenal', telefone: '51 99222-2222', forma: 'quinzenal', primeiro_vencimento: add(hoje, -14), valor: '80', ativo: true });
  ficha = await api('GET', `/api/clientes/${qz.id}`);
  ok(ficha.cobrancas.length === 2, 'quinzenal com início no passado: gera a vencida e a de hoje', ficha.cobrancas.map((c) => c.vencimento));
  // editar valor da semanal -> futuras recalculadas
  await api('PUT', `/api/clientes/${sem.id}`, { ...sem, telefone: sem.telefone, valor: '55', dia_semana: ds, primeiro_vencimento: sem.primeiro_vencimento, ativo: true });
  ficha = await api('GET', `/api/clientes/${sem.id}`);
  ok(ficha.cobrancas.length === 2 && ficha.cobrancas.every((c) => c.valor === 55), 'editar valor recalcula as semanais futuras', ficha.cobrancas.map((c) => [c.vencimento, c.valor]));
  const prev = await api('GET', `/api/cobrancas/${ficha.cobrancas[0].id}/previa`);
  ok(/semana de/.test(prev.texto), 'mensagem usa {descricao} = semana de dd/mm', prev.texto.slice(0, 120));

  console.log('2) FIADO / AVULSO');
  const men = await api('POST', '/api/clientes', { nome: 'Pedro Mensal', telefone: '51 99333-3333', forma: 'mensal', dia_vencimento: 28, valor: '100', ativo: true });
  let r = await api('POST', `/api/clientes/${men.id}/consumos`, { descricao: 'Corte', valor: '40', modo: 'pendurar' });
  ok(r.anexado_em, 'pendurar no mensal entra na próxima cobrança', r);
  ficha = await api('GET', `/api/clientes/${men.id}`);
  const prox = ficha.cobrancas.filter((c) => c.status === 'aberto' && c.vencimento >= hoje).sort((a, b) => a.vencimento.localeCompare(b.vencimento))[0];
  ok(prox && prox.valor === 140, 'cobrança do mês passou de 100 para 140', prox);
  await api('PUT', `/api/clientes/${men.id}`, { ...men, valor: '110', ativo: true });
  ficha = await api('GET', `/api/clientes/${men.id}`);
  const prox2 = ficha.cobrancas.find((c) => c.id === prox.id);
  ok(prox2.valor === 150, 'editar mensalidade mantém o fiado somado (110+40)', prox2);
  r = await api('POST', `/api/clientes/${men.id}/consumos`, { descricao: 'Barba', valor: '25', modo: 'agora', enviar: false });
  ok(r.cobranca && r.cobranca.tipo === 'avulsa' && r.cobranca.valor === 25 && r.cobranca.vencimento === hoje, 'cobrar agora gera avulsa vencendo hoje', r.cobranca);
  const cons = await api('GET', `/api/clientes/${men.id}/consumos`);
  ok(cons.length === 2, 'lista de consumos', cons.length);
  // excluir o pendurado -> volta 110
  await api('DELETE', `/api/consumos/${cons.find((c) => c.descricao === 'Corte').id}`);
  ficha = await api('GET', `/api/clientes/${men.id}`);
  ok(ficha.cobrancas.find((c) => c.id === prox.id).valor === 110, 'excluir lançamento tira o valor da cobrança');

  const av = await api('POST', '/api/clientes', { nome: 'Lucas Avulso', telefone: '51 99444-4444', forma: 'avulso', ativo: true });
  ficha = await api('GET', `/api/clientes/${av.id}`);
  ok(ficha.cobrancas.length === 0, 'cliente só avulso não gera cobrança fixa');
  await api('POST', `/api/clientes/${av.id}/consumos`, { descricao: 'Corte', valor: '40', modo: 'pendurar' });
  await api('POST', `/api/clientes/${av.id}/consumos`, { descricao: 'Sobrancelha', valor: '15', modo: 'pendurar' });
  const lista = await api('GET', '/api/clientes');
  ok(lista.find((c) => c.id === av.id).fiado_pendente === 55, 'lista mostra fiado pendente 55');
  r = await api('POST', `/api/clientes/${av.id}/fiado/cobrar`, { enviar: false });
  ok(r.cobranca.valor === 55 && /2 consumos/.test(r.cobranca.descricao), 'cobrar fiado junta tudo numa cobrança', r.cobranca);

  console.log('3) AGENDA: concluir pago e pendurar');
  const h1 = `${hoje}T07:00`, h2 = `${hoje}T07:30`;
  const a1 = await api('POST', '/api/agenda', { profissional_id: pr.id, servico_id: sv.id, inicio: h1, duracao_min: 30, cliente_nome: 'Rafael', telefone: '51 99555-5555', valor: '40', enviar_confirmacao: false });
  const a2 = await api('POST', '/api/agenda', { profissional_id: pr.id, servico_id: sv.id, inicio: h2, duracao_min: 30, cliente_nome: 'Bruno Novo', telefone: '51 99666-6666', valor: '40', enviar_confirmacao: false });
  r = await api('POST', `/api/agenda/${a1.id}/status`, { status: 'concluido', pago: true, forma_pagamento: 'pix' });
  ok(r.pago && r.comissao_valor === 20 && r.pago_em, 'concluído pago: comissão 20 e data de pagamento', [r.pago, r.comissao_valor, r.pago_em]);
  r = await api('POST', `/api/agenda/${a2.id}/status`, { status: 'concluido', pendurar: true });
  ok(r.fiado && r.fiado.cliente === 'Bruno Novo' && r.forma_pagamento === 'fiado' && !r.pago, 'pendurar cria cliente "só avulso" e lança o fiado', r.fiado);
  try { await api('POST', `/api/agenda/${a2.id}/status`, { status: 'concluido', pendurar: true }); ok(false, 'não deixa pendurar 2x'); } catch { ok(true, 'não deixa pendurar o mesmo atendimento 2x'); }
  const cli2 = (await api('GET', '/api/clientes')).find((c) => c.nome === 'Bruno Novo');
  ok(cli2 && cli2.forma === 'avulso' && cli2.fiado_pendente === 40, 'cliente criado com fiado 40', cli2 && [cli2.forma, cli2.fiado_pendente]);
  const cbB = await api('POST', `/api/clientes/${cli2.id}/fiado/cobrar`, { enviar: false });
  await api('POST', `/api/cobrancas/${cbB.cobranca.id}/pagar`, { valor: '40', forma: 'dinheiro', agradecer: false });
  const agB = (await api('GET', `/api/agenda?de=${hoje}&ate=${hoje}`)).find((a) => a.id === a2.id);
  ok(agB.pago === true, 'pagar a cobrança do fiado marca o atendimento como pago');

  console.log('4) PRODUTOS');
  const pd = await api('POST', '/api/produtos', { nome: 'Pomada', preco: '30', comissao_pct: '10', estoque: '5', ativo: true });
  r = await api('POST', '/api/vendas', { produto_id: pd.id, quantidade: 2, profissional_id: pr.id, forma_pagamento: 'debito' });
  ok(r.venda.valor_total === 60 && r.venda.comissao_valor === 6, 'venda 2x30 com 10% = comissão 6', r.venda);
  r = await api('POST', '/api/vendas', { produto_id: pd.id, quantidade: 1, forma_pagamento: 'fiado', cliente_nome: 'Lucas Avulso', telefone: '51 99444-4444' });
  ok(r.fiado && r.venda.cliente_id === av.id, 'venda fiado vai para a conta do cliente existente');
  const prods = await api('GET', '/api/produtos');
  ok(prods[0].estoque === 2, 'estoque baixou 5 -> 2', prods[0].estoque);

  console.log('5) CAIXA');
  await api('POST', '/api/caixa/movimentos', { tipo: 'saida', descricao: 'Lâminas', valor: '12', forma: 'dinheiro' });
  const cx = await api('GET', `/api/caixa?data=${hoje}`);
  console.log('    por forma:', JSON.stringify(cx.por_forma), 'totais:', JSON.stringify(cx.totais));
  ok(cx.por_forma.pix === 40 && cx.por_forma.debito === 60 && cx.por_forma.dinheiro === 40, 'entradas: pix 40 (agenda), débito 60 (produto), dinheiro 40 (fiado pago)');
  ok(cx.totais.entradas === 140 && cx.totais.saidas === 12, 'total entradas 140, saídas 12');
  ok(cx.totais.comissoes === 46, 'comissões do dia: 20+20 (serviços) + 6 (produto) = 46', cx.totais.comissoes);
  ok(cx.totais.dinheiro_em_caixa === 28, 'dinheiro na gaveta 40-12 = 28', cx.totais.dinheiro_em_caixa);
  ok(cx.fiado.qtd >= 3, 'fiado do dia aparece', cx.fiado);

  console.log('6) COMISSÕES');
  const com = await api('GET', `/api/agenda/comissoes?de=${hoje}&ate=${hoje}`);
  const pc = com.profissionais[0];
  ok(pc.servicos === 80 && pc.produtos === 60 && pc.comissao === 46 && pc.casa === 94, 'relatório: serviços 80 + produtos 60, comissão 46, casa 94', [pc.servicos, pc.produtos, pc.comissao, pc.casa]);

  console.log('7) LISTAS / PAINEL / COBRANÇAS DO MÊS');
  const cobs = await api('GET', `/api/cobrancas?mes=${hoje.slice(0, 7)}`);
  ok(cobs.itens.some((c) => c.tipo === 'avulsa') && cobs.itens.some((c) => c.forma === 'semanal'), 'cobranças do mês incluem avulsas e semanais', cobs.itens.length);
  const pn = await api('GET', '/api/painel');
  ok(pn.previsto_mes > 0, 'painel ok', pn.previsto_mes);
  const csv = await fetch(BASE + `/api/exportar/cobrancas.csv?mes=${hoje.slice(0, 7)}`, { headers: { cookie } }).then((x) => x.text());
  ok(/Referente a/.test(csv), 'CSV de cobranças com "Referente a"');

  console.log('8) AGENDAMENTO ONLINE');
  const cfgAntes = await api('GET', '/api/config');
  await api('PUT', '/api/config', { online_ativo: true, online_antecedencia_min: '60', online_dias: '14' });
  const pub = await api('GET', '/api/publico/agenda', null, true);
  ok(pub.ativo && pub.servicos.length === 1 && pub.profissionais.length === 1, 'página pública lista serviços e profissionais');
  const amanha = add(hoje, 1);
  const hrs = await api('GET', `/api/publico/agenda/horarios?data=${amanha}&servico_id=${sv.id}`, null, true);
  ok(hrs.length > 10, 'horários livres de amanhã', hrs.length);
  r = await api('POST', '/api/publico/agenda', { servico_id: sv.id, data: amanha, hora: hrs[0].hora, nome: 'Cliente Online', telefone: '51 99777-7777' }, true);
  ok(r.ok && r.profissional === 'Carlos', 'agendou pelo link (sem preferência → Carlos)', r);
  try { await api('POST', '/api/publico/agenda', { servico_id: sv.id, data: amanha, hora: hrs[0].hora, nome: 'Outro', telefone: '51 99888-8888' }, true); ok(false, 'bloqueia horário ocupado'); }
  catch (e) { ok(/409/.test(e.message), 'horário ocupado é recusado (409)'); }
  const hrs2 = await api('GET', `/api/publico/agenda/horarios?data=${amanha}&servico_id=${sv.id}`, null, true);
  ok(!hrs2.some((x) => x.hora === hrs[0].hora), 'horário some da lista depois de marcado');
  try { await api('POST', '/api/publico/agenda', { servico_id: sv.id, data: add(hoje, 40), hora: '10:00', nome: 'X', telefone: '51 99888-8888' }, true); ok(false, 'limite de dias'); }
  catch { ok(true, 'não deixa marcar além do limite de dias'); }
  try { await api('POST', '/api/publico/agenda', { servico_id: sv.id, data: amanha, hora: hrs[3].hora, nome: 'Robo', telefone: '51 99888-8888', site: 'http://spam' }, true); ok(false, 'anti-robô'); }
  catch { ok(true, 'campo anti-robô barra envio automático'); }
  const agOn = (await api('GET', `/api/agenda?de=${amanha}&ate=${amanha}`)).find((a) => a.cliente_nome === 'Cliente Online');
  ok(agOn && agOn.origem === 'online' && agOn.valor === 40, 'aparece na agenda marcado como online, com preço do serviço');
  await api('PUT', '/api/config', { online_ativo: cfgAntes.online_ativo });
  const pub2 = await api('GET', '/api/publico/agenda', null, true);
  ok(pub2.ativo === false && !pub2.servicos, 'desligado: página não mostra nada');

  console.log('9) RETORNO');
  const rp = await api('GET', '/api/retorno/previa');
  ok(typeof rp.candidatos === 'number' && /dias/.test(rp.exemplo), 'prévia do retorno', rp.exemplo.slice(0, 80));

  console.log('10) DESFAZER PAGAMENTO DO FIADO');
  await api('POST', `/api/cobrancas/${cbB.cobranca.id}/desfazer`);
  const agB2 = (await api('GET', `/api/agenda?de=${hoje}&ate=${hoje}`)).find((a) => a.id === a2.id);
  ok(agB2.pago === false, 'desfazer volta o atendimento para não pago');

  console.log('11) REVISÃO: FIADO NO CAIXA, PAINEL E BACKUP');
  const cxAntes = await api('GET', `/api/caixa?data=${hoje}`);
  await api('POST', `/api/clientes/${av.id}/consumos`, { descricao: 'Barba', valor: '25', modo: 'agora' });
  const cxDepois = await api('GET', `/api/caixa?data=${hoje}`);
  ok(cxDepois.fiado.qtd === cxAntes.fiado.qtd && cxDepois.fiado.valor === cxAntes.fiado.valor, 'consumo cobrado na hora não conta como fiado no caixa', [cxAntes.fiado, cxDepois.fiado]);
  const pn2 = await api('GET', '/api/painel');
  ok(pn2.recebido_mes.atendimentos && pn2.recebido_mes.atendimentos.v > 0 && pn2.recebido_mes.vendas, 'painel: recebido no mês inclui atendimentos e produtos', pn2.recebido_mes);
  const bk = await api('GET', '/api/exportar/backup.json');
  ok(Array.isArray(bk.agendamentos) && bk.agendamentos.length > 0 && Array.isArray(bk.profissionais) && Array.isArray(bk.servicos) && Array.isArray(bk.comprovantes), 'backup inclui agenda, profissionais, serviços e comprovantes', Object.keys(bk));

  console.log('12) RAMOS E MÓDULOS');
  let cf = await api('PUT', '/api/config', { ramo: 'servicos' });
  ok(cf.ramo === 'servicos' && cf.modulos.agenda === false && cf.modulos.caixa === false && cf.termos.profissional === 'técnico', 'piscinas: só cobrança, técnico', [cf.modulos, cf.termos]);
  ok(/visita/.test(cf.agenda_msg_confirmacao), 'piscinas: mensagem de visita');
  cf = await api('PUT', '/api/config', { mod_agenda: true, mod_caixa: false, mod_produtos: false, mod_comissoes: false, mod_online: false, mod_retorno: false, mod_pacotes: false, mod_espera: false, mod_relatorios: true });
  ok(cf.modulos.agenda === true && cf.modulos.caixa === false, 'liga um módulo isolado', cf.modulos);
  cf = await api('PUT', '/api/config', { ramo: 'escola' });
  ok(cf.termos.cliente === 'aluno' && cf.modulos.pacotes === true && cf.modulos.agenda === false, 'academia: aluno, pacotes, sem agenda', [cf.termos, cf.modulos]);
  cf = await api('PUT', '/api/config', { ramo: 'barbearia' });
  ok(Object.values(cf.modulos).every(Boolean) && /💈/.test(cf.agenda_msg_confirmacao), 'barbearia: tudo ligado e mensagem de barbearia', cf.modulos);

  console.log('13) PACOTES E ASSINATURA');
  const pk = await api('POST', '/api/pacotes', { nome: 'Clube 4 cortes', quantidade: 4, valor: '120', validade_dias: 30, servico_id: sv.id, recorrente: true });
  const cxP0 = await api('GET', `/api/caixa?data=${hoje}`);
  const venda = await api('POST', `/api/clientes/${sem.id}/pacotes`, { pacote_id: pk.id, forma_pagamento: 'pix' });
  const cxP1 = await api('GET', `/api/caixa?data=${hoje}`);
  ok(venda.pacote.quantidade === 4 && cxP1.totais.entradas === +(cxP0.totais.entradas + 120).toFixed(2), 'venda do pacote entra no caixa (120)', [cxP0.totais.entradas, cxP1.totais.entradas]);
  let saldoP = await api('GET', `/api/pacotes/cliente?cliente_id=${sem.id}`);
  ok(saldoP.length === 1 && saldoP[0].saldo === 4, 'cliente com 4 usos', saldoP.map((x) => x.saldo));
  const hAg = add(hoje, 2) + 'T10:00';
  const agP = await api('POST', '/api/agenda', { profissional_id: pr.id, servico_id: sv.id, cliente_id: sem.id, cliente_nome: 'Joao Semanal', telefone: '51 99111-1111', inicio: hAg, duracao_min: 30, valor: '40', enviar_confirmacao: false });
  const usado = await api('POST', `/api/agenda/${agP.id}/status`, { status: 'concluido', usar_pacote: saldoP[0].id });
  ok(usado.pago && usado.forma_pagamento === 'pacote' && Number(usado.valor) === 30, 'atendimento sai do pacote (valor 120/4 = 30)', [usado.pago, usado.forma_pagamento, usado.valor]);
  saldoP = await api('GET', `/api/pacotes/cliente?cliente_id=${sem.id}`);
  ok(saldoP[0].saldo === 3, 'saldo cai para 3', saldoP[0].saldo);
  let dup = null; try { await api('POST', `/api/agenda/${agP.id}/status`, { status: 'concluido', usar_pacote: saldoP[0].id }); } catch (e) { dup = e.message; }
  ok(dup && /já foi descontado/.test(dup), 'não desconta duas vezes o mesmo atendimento', dup);
  await api('POST', `/api/agenda/${agP.id}/status`, { status: 'agendado', pago: false });
  saldoP = await api('GET', `/api/pacotes/cliente?cliente_id=${sem.id}`);
  ok(saldoP[0].saldo === 4, 'reabrir o atendimento devolve o uso', saldoP[0].saldo);
  const vendaC = await api('POST', `/api/clientes/${av.id}/pacotes`, { pacote_id: pk.id, forma_pagamento: 'cobrar' });
  const fichaAv = await api('GET', `/api/clientes/${av.id}`);
  ok(vendaC.pacote.cobranca_id && fichaAv.cobrancas.some((x) => x.id === vendaC.pacote.cobranca_id && x.valor === 120), 'pacote "gerar cobrança" cria cobrança de 120');

  console.log('14) LISTA DE ESPERA');
  // amanhã (já definido acima)
  const es = await api('POST', '/api/espera', { data: amanha, cliente_nome: 'Paulo Espera', telefone: '51 99777-7777', servico_id: sv.id, hora_de: '08:00', hora_ate: '18:00' });
  const lst = await api('GET', `/api/espera?data=${amanha}`);
  const cnt = await api('GET', `/api/espera/contagem?de=${hoje}&ate=${add(hoje, 6)}`);
  ok(lst.some((x) => x.id === es.id && x.servico_nome === 'Corte') && cnt[amanha] >= 1, 'entra na lista e aparece na contagem', cnt);
  let semTel = null; try { await api('POST', '/api/espera', { data: amanha, cliente_nome: 'Sem Fone' }); } catch (e) { semTel = e.message; }
  ok(semTel && /WhatsApp/.test(semTel), 'exige WhatsApp para avisar', semTel);
  const agE = await api('POST', '/api/agenda', { profissional_id: pr.id, cliente_nome: 'Vai Cancelar', telefone: '51 99888-1111', inicio: amanha + 'T11:00', duracao_min: 30, enviar_confirmacao: false });
  const canc = await api('POST', `/api/agenda/${agE.id}/status`, { status: 'cancelado' });
  ok(Array.isArray(canc.espera_avisados), 'cancelar responde quem foi avisado (WhatsApp desligado: ninguém)', canc.espera_avisados);
  await api('PUT', `/api/espera/${es.id}`, { status: 'marcado' });
  ok((await api('GET', `/api/espera/contagem?de=${amanha}&ate=${amanha}`))[amanha] === undefined, 'marcado sai da contagem');

  console.log('15) RELATÓRIOS');
  const rm = await api('GET', '/api/relatorios/mensal?meses=12');
  const ult = rm.meses[rm.meses.length - 1];
  ok(rm.meses.length === 12 && ult.total > 0 && ult.qtd_atendimentos > 0, '12 meses, mês atual com entradas e atendimentos', ult);
  const rpf = await api('GET', `/api/relatorios/profissionais?mes=${hoje.slice(0, 7)}`);
  ok(rpf.profissionais.some((x) => x.nome === 'Carlos' && x.atendimentos > 0 && x.comissao > 0), 'resultado por profissional', rpf.profissionais.map((x) => [x.nome, x.atendimentos, x.comissao]));

  console.log('16) LOGIN DO PROFISSIONAL');
  const pr2 = await api('POST', '/api/agenda/profissionais', { nome: 'Outro', cor: '#e0488f', ativo: true, expediente: { dias: [0, 1, 2, 3, 4, 5, 6], inicio: '00:00', fim: '23:30' } });
  const agOutro = await api('POST', '/api/agenda', { profissional_id: pr2.id, cliente_nome: 'Cliente do Outro', inicio: amanha + 'T15:00', duracao_min: 30, enviar_confirmacao: false });
  await api('POST', '/api/usuarios', { nome: 'Carlos', login: 'carlos', senha: 'carlos123', profissional_id: pr.id, ativo: true });
  const cookieAdmin = cookie; cookie = '';
  await api('POST', '/api/login', { login: 'carlos', senha: 'carlos123' });
  const eu = await api('GET', '/api/me');
  ok(eu.profissional_id === pr.id && eu.permissoes.includes('agenda'), 'login do profissional', eu);
  const agVista = await api('GET', `/api/agenda?de=${hoje}&ate=${add(hoje, 6)}`);
  ok(agVista.length > 0 && agVista.every((x) => x.profissional_id === pr.id), 'vê só a própria agenda', agVista.map((x) => x.profissional_id));
  ok((await api('GET', '/api/agenda/profissionais')).length === 1, 'lista de profissionais só com ele');
  let bloq = null; try { await api('GET', '/api/clientes'); } catch (e) { bloq = e.message; }
  ok(bloq && /403/.test(bloq), 'não vê clientes nem cobranças', bloq);
  let bloq2 = null; try { await api('POST', `/api/agenda/${agOutro.id}/status`, { status: 'cancelado' }); } catch (e) { bloq2 = e.message; }
  ok(bloq2 && /403/.test(bloq2), 'não mexe no horário de outro profissional', bloq2);
  const meu = await api('POST', '/api/agenda', { profissional_id: pr2.id, cliente_nome: 'Encaixe', inicio: amanha + 'T07:00', duracao_min: 30, enviar_confirmacao: false });
  ok(meu.profissional_id === pr.id, 'o que ele marca fica na agenda dele', meu.profissional_id);
  const cfgProf = await api('GET', '/api/config');
  ok(!('pix_chave' in cfgProf) && !('regua' in cfgProf), 'não vê a chave Pix nem a régua');
  const comProf = await api('GET', `/api/agenda/comissoes?de=${hoje}&ate=${hoje}`);
  ok(comProf.profissionais.every((x) => x.profissional_id === pr.id), 'comissões só dele', comProf.profissionais.map((x) => x.profissional_id));
  cookie = cookieAdmin;

  console.log(falhas ? `\nFALHAS: ${falhas}` : '\nTUDO OK');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(2); });
