/* Ícones do sistema (SVG de traço, 24x24, no estilo Lucide). Uso: ic('agenda') */
const ICONES = {
  painel: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  agenda: '<rect x="3" y="4.5" width="18" height="17" rx="2.5"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01"/>',
  caixa: '<path d="M19 7V5.5A1.5 1.5 0 0 0 17.5 4h-12A2.5 2.5 0 0 0 3 6.5v11A2.5 2.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16"/><path d="M3 6.5A2.5 2.5 0 0 0 5.5 9H20a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-4a2.5 2.5 0 0 1 0-5h5"/>',
  clientes: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.2A6.5 6.5 0 0 1 21.5 20"/>',
  cobrancas: '<path d="M5 2.5h14v19l-3-2-2.3 2-2.2-2-2.3 2-2.2-2-2 1.5z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  comprovantes: '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h5.5"/><path d="m9 15 2 2 4-4"/>',
  whatsapp: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2.5 21.5z"/><path d="M9 10.5c.5 2 2 3.6 4.5 4.5l1.2-1.2 2 .8v1.6c-3.8.6-8.6-3.6-8.6-8.4h1.6l.8 2z"/>',
  config: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  personalizacao: '<path d="M12 21.5a9.5 9.5 0 1 1 9.5-9.5c0 2.6-2.1 4-4.2 4h-2.1a1.9 1.9 0 0 0-1.4 3.2 1.4 1.4 0 0 1-1 2.3z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10.5" cy="7" r="1.2"/><circle cx="15.5" cy="7.5" r="1.2"/>',
  usuarios: '<circle cx="10" cy="8" r="4"/><path d="M3 20.5a7 7 0 0 1 10.5-6"/><circle cx="18" cy="17" r="2.3"/><path d="M18 13v1.7M18 19.3V21M21.5 15l-1.5.9M16 18.1l-1.5.9M21.5 19l-1.5-.9M16 15.9l-1.5-.9"/>',
  mais: '<path d="M12 5v14M5 12h14"/>',
  esquerda: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  direita: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  baixar: '<path d="M12 3.5v12M7 10.5l5 5 5-5M4 20.5h16"/>',
  fechar: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  menu: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
  opcoes: '<circle cx="12" cy="5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="19" r="1.3"/>',
  expandir: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  imprimir: '<path d="M6 9V3h12v6M6 18H4.5A1.5 1.5 0 0 1 3 16.5v-6A1.5 1.5 0 0 1 4.5 9h15a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H18"/><rect x="6" y="14" width="12" height="7" rx="1"/>',
  enviar: '<path d="M21.5 2.5 11 13M21.5 2.5 15 21.5l-4-8.5-8.5-4z"/>',
  relogio: '<circle cx="12" cy="12" r="9.5"/><path d="M12 6.5V12l3.5 2"/>',
  alerta: '<circle cx="12" cy="12" r="9.5"/><path d="M12 7.5v5M12 16.5h.01"/>',
  clip: '<path d="m21 11-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6L15 6.6"/>',
  cadeado: '<rect x="4.5" y="10.5" width="15" height="11" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  tesoura: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
  usuario: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  dinheiro: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  pix: '<path d="m12 2.5 4.2 4.2-4.2 4.2-4.2-4.2zM12 13.1l4.2 4.2-4.2 4.2-4.2-4.2zM6.7 7.8l4.2 4.2-4.2 4.2L2.5 12zM17.3 7.8l4.2 4.2-4.2 4.2-4.2-4.2z"/>',
  sair: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  chave: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2 2"/>',
  produtos: '<path d="M9 3h6v3.5a2 2 0 0 0 .6 1.4l.8.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-8.9a2 2 0 0 1 .6-1.4l.8-.8A2 2 0 0 0 9 6.5z"/><path d="M7 13h10"/>',
  lixo: '<path d="M3.5 6h17M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6M18.5 6l-.8 13.1a2 2 0 0 1-2 1.9H8.3a2 2 0 0 1-2-1.9L5.5 6"/>',
  editar: '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  link: '<path d="M10 13.5a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 10.5a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  grafico: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 6-6"/>',
};
function ic(nome, cls = '') {
  const p = ICONES[nome];
  if (!p) return '';
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
// troca <i data-ic="nome"></i> pelo ícone (usado no HTML fixo)
function aplicarIcones(raiz = document) {
  raiz.querySelectorAll('[data-ic]:not([data-ic-ok])').forEach((el) => { el.innerHTML = ic(el.dataset.ic); el.dataset.icOk = '1'; });
}
