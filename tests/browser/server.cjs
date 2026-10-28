// Local static fixture server. No Jellyfin host or external service is impersonated.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const jsRoot = path.join(root, 'Jellyfin.Plugin.JellyfinEnhanced/js') + path.sep;
// Scripts as the plugin serves them: the translations script carries the display-language policy the server writes in
// (the same transform the frontend suite uses, tests/frontend/helpers/served-scripts.mjs).
const servedScripts = import('../frontend/helpers/served-scripts.mjs');
http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = pathname === '/' ? path.join(__dirname, 'fixture.html') : pathname === '/arr' ? path.join(__dirname, 'arr-fixture.html') : path.resolve(root, '.' + pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, async (error, data) => {
    if (error) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : file.endsWith('.ttf') ? 'font/ttf' : file.endsWith('.woff2') ? 'font/woff2' : 'text/html');
    if (file.startsWith(jsRoot) && file.endsWith('.js')) {
      const { served } = await servedScripts;
      data = served(file.slice(jsRoot.length).split(path.sep).join('/'), data.toString('utf8'));
    }
    res.end(data);
  });
}).listen(Number(process.env.JE_BROWSER_PORT || 4179), '127.0.0.1');
