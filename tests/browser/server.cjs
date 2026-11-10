// Local static fixture server. No Jellyfin host or external service is impersonated.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const streams = new Map();
http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(parsed.pathname);
  // Deliberately unfinished HTTP bodies let browser tests exercise cancellation
  // after headers, a boundary that route.fulfill and resolved JSON mocks miss.
  if (pathname === '/tests/browser/stream-status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(streams.get(parsed.searchParams.get('id')) || null));
    return;
  }
  if (pathname === '/tests/browser/stream') {
    const id = parsed.searchParams.get('id');
    const state = { closed: false, completed: false };
    streams.set(id, state);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.write('{"pending":');
    const timer = setTimeout(() => { state.completed = true; res.end('false}'); }, 60000);
    res.once('close', () => { clearTimeout(timer); state.closed = true; });
    return;
  }
  // canopy K1b: what the bundle's earlier scripts publish on JE.core.sharedModules (client/shared-modules.json), for
  // pages that load a script without its provider (fixture.html, specs that build on it). Compiled from source.
  if (pathname === '/tests/browser/shared-modules.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(require('../frontend/helpers/feature-context.cjs').sharedModulesInstaller());
    return;
  }
  const file = pathname === '/' ? path.join(__dirname, 'fixture.html') : path.resolve(root, '.' + pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.ttf') ? 'font/ttf' : file.endsWith('.woff2') ? 'font/woff2' : 'text/html');
    res.end(data);
  });
}).listen(Number(process.env.JE_BROWSER_PORT || 4179), '127.0.0.1');
