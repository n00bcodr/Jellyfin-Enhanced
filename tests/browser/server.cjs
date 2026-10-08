// Local static fixture server. No Jellyfin host or external service is impersonated.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = pathname === '/' ? path.join(__dirname, 'fixture.html') : path.resolve(root, '.' + pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.ttf') ? 'font/ttf' : file.endsWith('.woff2') ? 'font/woff2' : 'text/html');
    res.end(data);
  });
}).listen(Number(process.env.JE_BROWSER_PORT || 4179), '127.0.0.1');
