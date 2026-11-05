// Responde ao Caddy se um subdomínio pertence a um cliente cadastrado.
// GET /ok?domain=barbearia.app.exemplo.com.br -> 200 se existir clientes/barbearia.env
const http = require('http');
const fs = require('fs');

const BASE = String(process.env.BASE_DOMINIO || '').toLowerCase();

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const dom = String(url.searchParams.get('domain') || '').toLowerCase();
  let ok = false;
  if (dom.endsWith('.' + BASE)) {
    const slug = dom.slice(0, -(BASE.length + 1));
    ok = /^[a-z0-9][a-z0-9-]{1,30}$/.test(slug) && fs.existsSync(`/clientes/${slug}.env`);
  }
  res.writeHead(ok ? 200 : 404);
  res.end(ok ? 'ok' : 'nao');
}).listen(8080, () => console.log('porteiro ouvindo em 8080, base', BASE));
