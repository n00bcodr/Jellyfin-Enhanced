// Real-browser journey for generated inline scripts. Run by hand; it needs Playwright browsers
// and a jQuery file, which `npm run test:client-build` must not require:
//   node tests/client-build/browser/inline-html.browser.mjs [results.json]
// JE_JQUERY_PATH selects the jQuery build. Jellyfin 12 runs view scripts with $(view).appendTo.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { SourceMap } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium, firefox } from '@playwright/test';
import { buildClient, repositoryRoot } from '../../../scripts/client-build.mjs';

const plugin = 'Jellyfin.Plugin.JellyfinEnhanced';
const output = 'PluginPages/Page.html';
const origin = 'http://je-inline.test';
const jquery = readFileSync(process.env.JE_JQUERY_PATH ?? '/usr/share/javascript/jquery/jquery.min.js', 'utf8');
const results = [];

const source = String.raw`
type Host = { je: { runs: number; values: Record<string, unknown>; error?: string } };
const host = window as unknown as Window & Host;
host.je.runs += 1;
const count = 2;
host.je.values = {
  endTag: "</script>",
  comment: "<!-- <script>",
  placeholder: "\${notAKey}",
  template: ${'`'}a${'$'}{count}b</script>${'$'}{[1].map(n => { return n + 1; })}${'`'},
  regex: /[</script]+/.test("/") && /<!--/.test("<!--"),
  markupAfter: document.getElementById("after") === null,
};

function fail(label: string): never {
  throw new Error(label);
}
try {
  fail("</script><!--${'$'}{x}");
} catch (error) {
  host.je.error = (error as Error).stack ?? "";
}
`;
const expected = { endTag: '</script>', comment: '<!-- <script>', placeholder: '${notAKey}', template: 'a2b</script>2', regex: true };

/** Builds one real page in an isolated project. */
async function buildPage() {
  const root = mkdtempSync(join(tmpdir(), 'je-html-browser-'));
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  mkdirSync(join(root, 'client/entries'), { recursive: true });
  put('client/tsconfig.json', readFileSync(join(repositoryRoot, 'client/tsconfig.json')));
  put(`${plugin}/JellyfinEnhanced.csproj`, `<Project><ItemGroup><EmbeddedResource Include="${output.replace('/', '\\')}"/></ItemGroup></Project>`);
  put('client/src/page.ts', source);
  put('client/html/pages/page.html', '<!DOCTYPE html>\n<html><head><title>t</title></head><body>\n<div data-role="page" id="page">\n  <p id="before">before</p>\n      <!-- JE_TYPED_SCRIPT:main -->\n  <p id="after">after</p>\n</div>\n</body></html>\n');
  put('client/html-entries/pages.json', JSON.stringify({ [output]: { template: 'client/html/pages/page.html', scripts: { main: 'client/src/page.ts' } } }));
  await buildClient({ root });
  const html = readFileSync(join(root, plugin, output), 'utf8');
  rmSync(root, { recursive: true, force: true });
  return html;
}

/** jellyfin-web's translateHtml and parseHtml, then jQuery appending the view. */
const hostLoader = `
  window.translateHtml = function translateHtml(html) {
    let startIndex = html.indexOf('\${');
    if (startIndex === -1) return html;
    startIndex += 2;
    const endIndex = html.indexOf('}', startIndex);
    if (endIndex === -1) return html;
    const key = html.substring(startIndex, endIndex);
    return translateHtml(html.replace('\${' + key + '}', key));
  };
  window.loadView = async function loadView(url) {
    const html = window.translateHtml(await (await fetch(url)).text());
    const unwrapped = html.replaceAll('\\x3c!--<script', '<script').replaceAll('<\\/script>--\\x3e', '<\\/script>');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = unwrapped;
    jQuery(wrapper.querySelector('div[data-role="page"]')).appendTo('#pages');
  };
`;

/** Resolves a stack frame on the given generated line back to TypeScript. */
function resolveFrame(text, stack, frameUrl, lineOffset) {
  const prefix = '//# sourceMappingURL=data:application/json;charset=utf-8;base64,';
  const map = JSON.parse(Buffer.from(text.split('\n').at(-2).slice(prefix.length), 'base64').toString('utf8'));
  const frame = stack.split('\n').map(line => frameUrl.exec(line)).find(Boolean);
  assert.ok(frame, `no frame in ${stack}`);
  const entry = new SourceMap(map).findEntry(Number(frame[1]) - 1 - lineOffset, Number(frame[2]) - 1);
  return { source: entry.originalSource, line: entry.originalLine, frame: frame[0] };
}

async function journey(name, type) {
  const html = await buildPage();
  const browser = await type.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route(`${origin}/**`, route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/page.html') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    if (pathname === '/jquery.js') return route.fulfill({ contentType: 'text/javascript', body: jquery });
    return route.fulfill({ contentType: 'text/html', body: `<!DOCTYPE html><body><div id="pages"></div><script src="/jquery.js"></script><script>window.je = { runs: 0, values: {} };${hostLoader}</script></body>` });
  });

  await page.goto(`${origin}/shell.html`);
  await page.evaluate(() => window.loadView('/page.html'));
  await page.waitForFunction(() => window.je.runs > 0);
  const viaHost = await page.evaluate(() => ({ je: window.je, after: document.getElementById('after')?.textContent, scripts: document.querySelectorAll('#pages script').length }));
  assert.equal(viaHost.je.runs, 1, 'the view script runs once');
  const { markupAfter, ...values } = viaHost.je.values;
  assert.deepEqual(values, expected);
  assert.equal(viaHost.after, 'after', 'markup after the script is intact');
  assert.deepEqual(errors, []);

  // A real document parser must end the element where the template does.
  await page.route(`${origin}/direct.html`, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html.replace('<!DOCTYPE html>\n', '<!DOCTYPE html><script>window.je = { runs: 0, values: {} };</script>\n') }));
  await page.goto(`${origin}/direct.html`);
  const direct = await page.evaluate(() => ({ je: window.je, after: document.getElementById('after')?.textContent, text: document.querySelector('#page script').textContent }));
  assert.equal(direct.je.runs, 1);
  assert.equal(direct.je.values.markupAfter, true, 'the script ran before later markup, like the template says');
  assert.deepEqual((({ markupAfter: _, ...rest }) => rest)(direct.je.values), expected);
  assert.equal(direct.after, 'after');
  assert.deepEqual(errors, []);
  const typescriptLine = source.split('\n').findIndex(line => line.includes('throw new Error'));

  // The host path evaluates the text alone, so stack positions are relative to it.
  const hostFrame = /(\d+):(\d+)\)?$/;
  const hostStack = viaHost.je.error;
  const hostResolved = resolveFrame(direct.text, hostStack, hostFrame, 0);
  assert.deepEqual([hostResolved.source, hostResolved.line], ['client/src/page.ts', typescriptLine]);

  // Only a document parse offsets positions, by whole lines: the leading newline keeps columns.
  const directLine = html.slice(0, html.indexOf('<script>\n(')).split('\n').length - 1;
  const directResolved = resolveFrame(direct.text, direct.je.error, /(\d+):(\d+)\)?$/, directLine);
  assert.deepEqual([directResolved.source, directResolved.line], ['client/src/page.ts', typescriptLine]);

  let sourceMapUrl = 'not checked';
  if (type === chromium) {
    const session = await page.context().newCDPSession(page);
    const parsed = [];
    session.on('Debugger.scriptParsed', event => parsed.push(event));
    await session.send('Debugger.enable');
    await page.goto(`${origin}/shell.html`);
    await page.evaluate(() => window.loadView('/page.html'));
    await page.waitForFunction(() => window.je.runs > 0);
    // Debugger.enable replays the previous document's scripts first, so take the newest.
    const generated = parsed.filter(event => event.sourceMapURL?.startsWith('data:application/json')).at(-1);
    assert.ok(generated, 'Chromium read the inline source map');
    assert.equal(generated.startLine, 0, 'the host path evaluates script text, so map lines are text-relative');
    sourceMapUrl = 'data:application/json read by V8; startLine 0';
  }
  await browser.close();
  results.push({ browser: name, hostRuns: viaHost.je.runs, directRuns: direct.je.runs, values, hostResolved, directResolved, sourceMapUrl, pageErrors: errors });
  console.log(`${name}: ok`);
}

/** The same loader corrupts template literals, which is why the builder lowers them. */
async function control() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('about:blank');
  const loaded = await page.evaluate(`(() => {${hostLoader}
    const script = 'const v = 2; document.title = \`a\${v}b\`;';
    return { untouched: script, loaded: window.translateHtml(script) };
  })()`);
  await browser.close();
  assert.notEqual(loaded.loaded, loaded.untouched);
  results.push({ control: 'unlowered template literal through translateHtml', ...loaded });
  console.log('control: ok');
}

await journey('chromium', chromium);
await journey('firefox', firefox);
await control();
if (process.argv[2]) writeFileSync(process.argv[2], `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
