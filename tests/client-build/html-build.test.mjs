import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { SourceMap } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { createContext, Script } from 'node:vm';
import { JSDOM } from 'jsdom';
import { buildClient, checkSourcePolicy, discoverEntries, discoverHtmlEntries, repositoryRoot } from '../../scripts/client-build.mjs';
import { renderPage } from '../../scripts/client/html-entries.mjs';

const plugin = 'Jellyfin.Plugin.JellyfinEnhanced';
const outputPath = 'PluginPages/Page.html';
const defaultTemplate = '<div id="host"></div>\n<!-- JE_TYPED_SCRIPT:main -->\n<p>after</p>\n';

/**
 * jellyfin-web's translateHtml and parseHtml, copied from the 12.4 bundle's source. These are
 * the only steps between the fetched page and the DOM. Missing keys return the key itself.
 */
function translateHtml(html) {
  let startIndex = html.indexOf('${');
  if (startIndex === -1) return html;
  startIndex += 2;
  const endIndex = html.indexOf('}', startIndex);
  if (endIndex === -1) return html;
  const key = html.substring(startIndex, endIndex);
  return translateHtml(html.replace('${' + key + '}', key));
}
function parseHtml(html, window) {
  const unwrapped = html.replaceAll('<!--<script', '<script').replaceAll('</script>-->', '</script>');
  const wrapper = window.document.createElement('div');
  wrapper.innerHTML = unwrapped;
  return wrapper;
}

/** Tiny isolated projects run the real TypeScript, esbuild and jsdom paths. */
function fixture(t, { template = defaultTemplate, source = 'document.title = "typed page";\n', scripts = { main: 'client/src/page.ts' } } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'je-html-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  mkdirSync(join(root, 'client/entries'), { recursive: true });
  put('client/tsconfig.json', readFileSync(join(repositoryRoot, 'client/tsconfig.json')));
  put(`${plugin}/JellyfinEnhanced.csproj`, `<Project><ItemGroup>
    <None Remove="PluginPages\\Page.html"/><EmbeddedResource Include="PluginPages\\Page.html"/>
    <EmbeddedResource Include="PluginPages\\Other.html"/>
  </ItemGroup></Project>`);
  put('client/src/page.ts', source);
  put('client/html/pages/page.html', template);
  const manifest = value => put('client/html-entries/pages.json', typeof value === 'string' ? value : JSON.stringify(value));
  manifest({ [outputPath]: { template: 'client/html/pages/page.html', scripts } });
  return {
    root,
    put,
    manifest,
    template: path => put('client/html/pages/page.html', path),
    output: join(root, plugin, outputPath),
    read: () => readFileSync(join(root, plugin, outputPath), 'utf8'),
    ledger: () => JSON.parse(readFileSync(join(root, 'client/generated-manifest.json'), 'utf8')),
  };
}

/** Parses a generated page the way Jellyfin does and returns each script element's text. */
function scriptTexts(html) {
  const dom = new JSDOM('');
  const texts = [...parseHtml(translateHtml(html), dom.window).querySelectorAll('script')].map(script => script.textContent);
  dom.window.close();
  return texts;
}

/** Runs script text like jQuery's DOMEval does: a new script holding only that text. */
function runScript(text, sandbox = {}) {
  const context = createContext({ console, ...sandbox });
  new Script(text, { filename: 'inline.js' }).runInContext(context);
  return context;
}

/** Decodes the composed map from a generated script's trailing data: URL. */
function inlineMap(text) {
  const lines = text.split('\n');
  assert.equal(lines.at(-1), '', 'script text ends with a newline');
  const last = lines.at(-2);
  const prefix = '//# sourceMappingURL=data:application/json;charset=utf-8;base64,';
  assert.ok(last.startsWith(prefix), 'the source map comment is the last line');
  return JSON.parse(Buffer.from(last.slice(prefix.length), 'base64').toString('utf8'));
}

/** Finds the generated position of a token and resolves it to its TypeScript position. */
function resolve(text, token) {
  const index = text.indexOf(token);
  assert.notEqual(index, -1, token);
  const before = text.slice(0, index).split('\n');
  const entry = new SourceMap(inlineMap(text)).findEntry(before.length - 1, before.at(-1).length);
  return { line: entry.originalLine, column: entry.originalColumn, source: entry.originalSource, generatedColumn: entry.generatedColumn, textColumn: before.at(-1).length };
}

/** Hashes every file in a tree, for proving that a mode changed nothing at all. */
function snapshot(root) {
  const files = {};
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  visit(root);
  return files;
}

test('replaces the marker with a classic IIFE and keeps every surrounding template byte', async t => {
  const template = '<!DOCTYPE html>\r\n<div data-role="page"  class=\'x\'>\n  <p title="&amp;">caf\u00e9 \u2717 \u{1F3AC}</p>\n    <!-- JE_TYPED_SCRIPT:main -->\n  <!-- ordinary comment -->\n</div>\n';
  const f = fixture(t, { template });
  await buildClient({ root: f.root });
  const html = f.read();
  const marker = '<!-- JE_TYPED_SCRIPT:main -->';
  const [before, after] = template.split(marker);
  assert.ok(html.startsWith(`${before}<script>\n`));
  assert.ok(html.endsWith(`\n</script>${after}`));
  const [text] = scriptTexts(html);
  const sandbox = { document: { title: '' } };
  const context = runScript(text, sandbox);
  assert.equal(context.document.title, 'typed page');
  assert.equal(Object.keys(context).includes('page'), false, 'no module global');
  const leaked = runScript(`${text}\nglobalThis.sloppy = (function () { return this !== undefined; })();`, sandbox);
  assert.equal(leaked.sloppy, true, 'strict mode must not leak into a later script body');
});

test('several markers keep template order regardless of manifest order, with distinct sources', async t => {
  const f = fixture(t, {
    template: '<!-- JE_TYPED_SCRIPT:second --><i>1</i><!-- JE_TYPED_SCRIPT:first -->',
    scripts: { first: 'client/src/first.ts', second: 'client/src/second.ts' },
  });
  f.put('client/src/first.ts', '(globalThis as unknown as { order: string[] }).order.push("first");\n');
  f.put('client/src/second.ts', '(globalThis as unknown as { order: string[] }).order.push("second");\n');
  await buildClient({ root: f.root });
  const order = [];
  for (const text of scriptTexts(f.read())) runScript(text, { order });
  assert.deepEqual(order, ['second', 'first']);
  assert.deepEqual(f.ledger().html[0].scripts.map(script => [script.name, script.scriptIndex]), [['second', 0], ['first', 1]]);
});

// Every value is produced and read back at runtime, so this is a behavior comparison with the
// TypeScript semantics and not only a search for the absence of a string.
const hazardSource = String.raw`
type Sink = { out: Record<string, unknown> };
const { out } = globalThis as unknown as Sink;
const value = 7;
const tag = (strings: TemplateStringsArray, ...values: unknown[]) => strings.raw.join("|") + values.join(",");
class Both { toString() { return "text"; } valueOf() { return 1; } }
out.endTag = "</script>";
out.upperTag = "</SCRIPT >";
out.mixedTag = "</ScRiPt\t>";
out.comment = "<!--";
out.doubleEscape = "<!-- <script>";
out.placeholder = "\${notAKey}";
out.template = ${'`'}a${'$'}{value}b</script>${'$'}{value}<!-- c \${literal}${'`'};
out.noSubstitution = ${'`'}</script><!--\${x}${'`'};
out.tagged = tag${'`'}x</script>\n${'$'}{value}<!--${'`'};
out.raw = String.raw${'`'}\n</script>${'$'}{value}${'`'};
out.stringify = ${'`'}${'$'}{new Both()}${'`'};
out.nested = ${'`'}${'$'}{[1, 2].map(n => ${'`'}<${'$'}{n}>${'`'}).join("")}${'`'};
out.regexClass = /[</script]+/.test("/");
out.regexClassUpper = /[</SCRIPT]+/.test("S") && /[</ScRiPt]/.test("/");
out.regexComment = /<!--/.test("<!--");
out.regexPlaceholder = /[$]\{/.test("\${");
out.regexUnicode = /<!--[</script]/u.test("<!--s");
out.regexClassPlaceholder = /[${'$'}{]+/.test("{");
out.unicode = "\u2717 caf\u00e9 \u{1F3AC} \u2028";
out.controls = "\x01\x02\x7f";
out.regexRawClass = "a\u2013b\u2014c".split(/[RAWDASHES]+/).join("");
out.regexEscapedRaw = /[ESCAPEDDASH]/.test("\u2013") && !/[ESCAPEDDASH]/.test("\\");
out.regexAstral = /RAWAPPLE+/u.test("\u{1F34E}");
out.regexEscapedBackslash = /\\RAWDASH/.test("\\\u2013");
out.nulAndCr = "\0\r";
// </script> <!-- <script> \${comment} \u2717
/* a block </script> comment */
/*! legal </script> <!-- <script> \${legal} \u2717 */
out.afterComments = true;
const caf\u00e9 = "identifier";
out.identifier = caf\u00e9;
`.replaceAll('\\u2717 */', '\u2717 */').replaceAll('\\u2717\n', '\u2717\n')
  .replaceAll('RAWDASHES', '\u2013\u2014').replaceAll('ESCAPEDDASH', '\\\u2013').replaceAll('RAWAPPLE', '\u{1F34E}').replaceAll('RAWDASH', '\u2013');
const hazardExpected = {
  endTag: '</script>',
  upperTag: '</SCRIPT >',
  mixedTag: '</ScRiPt\t>',
  comment: '<!--',
  doubleEscape: '<!-- <script>',
  placeholder: '${notAKey}',
  template: 'a7b</script>7<!-- c ${literal}',
  noSubstitution: '</script><!--${x}',
  tagged: 'x</script>\\n|<!--7',
  raw: '\\n</script>7',
  stringify: 'text',
  nested: '<1><2>',
  regexClass: true,
  regexClassUpper: true,
  regexComment: true,
  regexPlaceholder: true,
  regexUnicode: true,
  regexClassPlaceholder: true,
  unicode: '\u2717 caf\u00e9 \u{1F3AC} \u2028',
  controls: '\x01\x02\x7f',
  regexRawClass: 'abc',
  regexEscapedRaw: true,
  regexAstral: true,
  regexEscapedBackslash: true,
  nulAndCr: '\0\r',
  afterComments: true,
  identifier: 'identifier',
};

test('hazardous source survives the HTML parser and Jellyfin page loader with exact runtime values', async t => {
  const f = fixture(t, { source: hazardSource });
  await buildClient({ root: f.root });
  const html = f.read();
  assert.equal(html, translateHtml(html), 'translateHtml has nothing to rewrite');
  const texts = scriptTexts(html);
  assert.equal(texts.length, 1);
  assert.doesNotMatch(texts[0], /<\/script|<!--|\$\{/i);
  assert.match(texts[0], /^[\t\n\x20-\x7e]*$/, 'ASCII only, so decoding cannot change it');
  const out = {};
  runScript(texts[0], { out });
  assert.deepEqual({ ...out }, hazardExpected);
  // The document parser agrees with the fragment parser on the raw-text boundary.
  const dom = new JSDOM(html);
  const after = dom.window.document.querySelector('p');
  assert.equal(after?.textContent, 'after', 'markup after the script stays markup');
  assert.equal(dom.window.document.querySelector('script').textContent, texts[0]);
  dom.window.close();
});

test('control: without template lowering, translateHtml corrupts the same script', async t => {
  const { build } = await import('esbuild');
  const result = await build({ stdin: { contents: 'const v = 2; document.title = `a${v}b${[1].map(n => { return n; })}`;', loader: 'ts' }, write: false, format: 'iife', target: 'es2020' });
  const emitted = result.outputFiles[0].text;
  assert.notEqual(translateHtml(`<script>${emitted}</script>`), `<script>${emitted}</script>`, 'unlowered template literals are rewritten');
  const f = fixture(t, { source: 'const v = 2;\ndocument.title = `a${v}b${[1].map(n => { return n; })}`;\n' });
  await buildClient({ root: f.root });
  const sandbox = { document: { title: '' } };
  runScript(scriptTexts(f.read())[0], sandbox);
  assert.equal(sandbox.document.title, 'a2b1');
});

test('fails closed instead of guessing where no equivalent rewrite exists', async t => {
  const lookbehind = fixture(t, { source: 'document.title = String(/(?<!--)x/.test("x"));\n' });
  await assert.rejects(buildClient({ root: lookbehind.root }), /lookbehind/);
  assert.equal(existsSync(lookbehind.output), false);
  const literalLookbehind = fixture(t, { source: 'document.title = String(/(?<!-{2})x/.test("x"));\n' });
  await buildClient({ root: literalLookbehind.root });
  const sandbox = { document: { title: '' } };
  runScript(scriptTexts(literalLookbehind.read())[0], sandbox);
  assert.equal(sandbox.document.title, 'true');
});

test('source maps resolve through wrapper lines, hazard escapes and template offsets', async t => {
  const source = [
    'import { helper } from "./helper";',
    'const first = "</script>" + "<!-- ${one}"; const target = helper(first);',
    'document.title = "<!--" + "${two}" + target; function reachedAfterEscapes() { return "</script>"; }',
    'reachedAfterEscapes();',
    '',
  ].join('\n');
  const f = fixture(t, { source });
  f.put('client/src/helper.ts', 'export function helper(value: string): string {\n  return value;\n}\n');
  await buildClient({ root: f.root });
  const text = scriptTexts(f.read())[0];
  const entryPosition = resolve(text, 'reachedAfterEscapes() {');
  assert.equal(entryPosition.source, 'client/src/page.ts');
  assert.deepEqual([entryPosition.line, entryPosition.column], [2, source.split('\n')[2].indexOf('reachedAfterEscapes')]);
  const helperPosition = resolve(text, 'helper(value)');
  assert.equal(helperPosition.source, 'client/src/helper.ts');
  assert.equal(helperPosition.line, 0);
  const lastCall = resolve(text, 'reachedAfterEscapes();');
  assert.deepEqual([lastCall.line, lastCall.column], [3, 0]);
  // findEntry returns the nearest earlier segment, which hides a wrong generated column,
  // so a token after escapes on its own generated line must have a segment exactly there.
  const afterEscapes = resolve(text, 'target;');
  assert.equal(afterEscapes.generatedColumn, afterEscapes.textColumn);
  assert.deepEqual([afterEscapes.line, afterEscapes.column], [2, source.split('\n')[2].indexOf('target;')]);
  const map = inlineMap(text);
  assert.deepEqual(map.sources, ['client/src/helper.ts', 'client/src/page.ts']);
  assert.equal(map.file, `${outputPath}#main`);
  assert.equal(map.sourcesContent[1], source);
  assert.ok(map.mappings.startsWith(';'), 'the line after <script> holds no code');
});

test('a thrown error resolves to its TypeScript position, past escapes on the same generated line', async t => {
  const thrower = 'const parts = ["</script><!--${x}", /[\u2013\u2014]/.source, stop()];';
  const f = fixture(t, { source: `function stop(): string {\n  throw new Error("stop");\n}\n${thrower}\ndocument.title = parts.join();\n` });
  await buildClient({ root: f.root });
  const text = scriptTexts(f.read())[0];
  const error = (() => {
    try {
      runScript(text, { Error });
    } catch (caught) {
      return caught;
    }
    throw new Error('expected a throw');
  })();
  const frames = [...error.stack.matchAll(/inline\.js:(\d+):(\d+)/g)];
  assert.equal(frames.length, 4, 'stop, the entry and both wrapper IIFEs');
  const map = new SourceMap(inlineMap(text));
  const at = frame => map.findEntry(Number(frame[1]) - 1, Number(frame[2]) - 1);
  assert.deepEqual([at(frames[0]).originalLine, at(frames[0]).originalColumn], [1, '  throw '.length], 'the throw site, with no escape before it');
  const call = at(frames[1]);
  assert.equal(call.generatedColumn, Number(frames[1][2]) - 1, 'a segment sits exactly at the call, past the escapes');
  assert.equal(call.originalSource, 'client/src/page.ts');
  assert.deepEqual([call.originalLine, call.originalColumn], [3, thrower.indexOf('stop()')]);
});

test('script text and map are identical wherever the template places the marker', async t => {
  const a = fixture(t, { template: '<!-- JE_TYPED_SCRIPT:main -->' });
  const b = fixture(t, { template: '<div>\n\n<pre>\n\n</pre>\n\t\t      <!-- JE_TYPED_SCRIPT:main --></div>\n' });
  await buildClient({ root: a.root });
  await buildClient({ root: b.root });
  const [textA] = scriptTexts(a.read());
  const [textB] = scriptTexts(b.read());
  assert.equal(textA, textB, 'the map is relative to the script text, which is what Jellyfin evaluates');
  // Document-parser positions differ only by whole lines: code columns never include the indent.
  assert.match(textB, /^\n\(\(\) => \{\n/);
  assert.equal(new SourceMap(inlineMap(textB)).findEntry(0, 0).originalSource, undefined);
});

test('the generated source map cannot reach the HTML parser', async t => {
  const f = fixture(t, { source: 'const closing = "</script><!-- ${x}";\ndocument.title = closing;\n// </script>\n' });
  await buildClient({ root: f.root });
  const [text] = scriptTexts(f.read());
  const last = text.split('\n').at(-2);
  assert.match(last.slice('//# sourceMappingURL=data:application/json;charset=utf-8;base64,'.length), /^[A-Za-z0-9+/]+={0,2}$/);
  assert.ok(inlineMap(text).sourcesContent[0].includes('</script><!-- ${x}'), 'embedded TypeScript keeps the original text');
});

test('the finished page is reparsed, so a script that escapes its element cannot be written', () => {
  const text = 'a </script><script>untyped()</script><script>b';
  const page = {
    output: outputPath,
    manifest: 'client/html-entries/pages.json',
    template: 'client/html/pages/page.html',
    templateBytes: Buffer.from(defaultTemplate),
    text: defaultTemplate,
    markers: [{ name: 'main', start: defaultTemplate.indexOf('<!--'), end: defaultTemplate.indexOf('-->') + 3 }],
  };
  assert.throws(() => renderPage(page, [{ name: 'main', source: 'client/src/page.ts', text, inputs: {} }]), /parsed scripts do not match/);
  assert.throws(() => renderPage(page, [{ name: 'main', source: 'client/src/page.ts', text: 'a </SCRIPT>', inputs: {} }]), /parsed scripts do not match/);
  assert.equal(renderPage(page, [{ name: 'main', source: 'client/src/page.ts', text: 'a', inputs: {} }]).ledger.scripts.length, 1);
});

const rejectedMarkup = [
  ['plain script', '<script>alert(1)</script>', /<script> is not allowed/],
  ['empty script', '<script></script>', /<script> is not allowed/],
  ['external script', '<script src="/x.js"></script>', /<script> is not allowed/],
  ['uppercase script', '<SCRIPT>alert(1)</SCRIPT>', /<script> is not allowed/],
  ['slash attribute script', '<script/x>alert(1)</script/x>', /<script> is not allowed/],
  ['module script', '<script type="module">alert(1)</script>', /<script> is not allowed/],
  ['text/javascript', '<script type="text/javascript">alert(1)</script>', /<script> is not allowed/],
  ['data script', '<script type="application/json">{}</script>', /<script> is not allowed/],
  ['marker body script', '<script>// JE</script>', /<script> is not allowed/],
  ['script in template', '<template><script>alert(1)</script></template>', /<script> is not allowed/],
  ['script in nested template', '<template><div><template><script>1</script></template></div></template>', /<script> is not allowed/],
  ['script in table', '<table><script>alert(1)</script></table>', /<script> is not allowed/],
  ['script in select', '<select><script>alert(1)</script></select>', /<script> is not allowed/],
  ['svg script', '<svg><script>alert(1)</script></svg>', /<svg> is not allowed/],
  ['math script', '<math><annotation-xml encoding="text/html"><script>alert(1)</script></annotation-xml></math>', /<math> is not allowed/],
  ['noscript', '<noscript><img src=x onerror=alert(1)></noscript>', /<noscript> is not allowed/],
  ['commented script Jellyfin re-activates', '<!--<script>alert(1)</script>-->', /comments must not contain script/],
  ['spaced commented script', '<!-- <script>alert(1)</script> -->', /comments must not contain script/],
  ['bogus comment script', '<?x <script>alert(1)</script>', /<\/?script|<script> is not allowed|comments must not contain/],
  ['inline event handler', '<div onclick="alert(1)"></div>', /inline event handler onclick/],
  ['uppercase event handler', '<img src=x ONERROR=alert(1)>', /inline event handler onerror/],
  ['slash separated handler', '<img/src="x"/onerror=alert(1)>', /inline event handler onerror/],
  ['handler in template', '<template><img src=x onerror=alert(1)></template>', /inline event handler onerror/],
  ['javascript href', '<a href="javascript:alert(1)">x</a>', /executable URL in href/],
  ['entity javascript href', '<a href="java&#115;cript:alert(1)">x</a>', /executable URL in href/],
  ['tab javascript href', '<a href="java\tscript:alert(1)">x</a>', /executable URL in href/],
  ['leading space javascript href', '<a href=" \x01javascript:alert(1)">x</a>', /executable URL in href/],
  ['uppercase javascript', '<a href="JAVASCRIPT:alert(1)">x</a>', /executable URL in href/],
  ['form action', '<form action="javascript:alert(1)"></form>', /executable URL in action/],
  ['button formaction', '<button formaction="javascript:alert(1)"></button>', /executable URL in formaction/],
  ['iframe javascript src', '<iframe src="javascript:alert(1)"></iframe>', /executable URL in src/],
  ['iframe data src', '<iframe src="data:text/html,<script>alert(1)</script>"></iframe>', /executable URL in src/],
  ['iframe srcdoc', '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>', /srcdoc/],
  ['object', '<object data="/x.html"></object>', /<object> is not allowed/],
  ['embed', '<embed src="/x.svg">', /<embed> is not allowed/],
  ['base', '<base href="https://example.invalid/">', /<base> is not allowed/],
  ['meta refresh', '<meta http-equiv="refresh" content="0;url=/x">', /http-equiv/],
  ['module preload', '<link rel="modulepreload" href="/x.js">', /<link rel="stylesheet">/],
  ['translated placeholder in markup', '<p>${Label}</p>', /translateHtml/],
  ['unbalanced placeholder in style', '<style>a::before { content: "${"; }</style>', /translateHtml/],
];

for (const [name, markup, message] of rejectedMarkup) {
  test(`rejects template markup: ${name}`, async t => {
    const f = fixture(t, { template: `${markup}\n<!-- JE_TYPED_SCRIPT:main -->\n` });
    await assert.rejects(discoverHtmlEntries(f.root), message);
    for (const mode of [{ check: true }, { typecheckOnly: true }, {}]) await assert.rejects(buildClient({ root: f.root, ...mode }), message);
    assert.equal(existsSync(f.output), false);
  });
}

test('the marker checks use the parser: inert script-like text in real markup is accepted', async t => {
  const f = fixture(t, { template: '<pre>&lt;script&gt;alert(1)&lt;/script&gt;</pre><textarea><script>inert</script></textarea>\n<style>a::before { content: "<script>"; }</style>\n<a href="/web/index.html">ok</a><img src="data:image/png;base64,AA==" alt="">\n<!-- JE_TYPED_SCRIPT:main -->' });
  await buildClient({ root: f.root });
  assert.equal(scriptTexts(f.read()).length, 1);
});

const rejectedMarkers = [
  ['missing', '<p>no marker</p>', /missing marker/],
  ['empty template', '', /missing marker/],
  ['duplicate', '<!-- JE_TYPED_SCRIPT:main --><!-- JE_TYPED_SCRIPT:main -->', /duplicate marker main/],
  ['unmapped', '<!-- JE_TYPED_SCRIPT:main --><!-- JE_TYPED_SCRIPT:extra -->', /unmapped marker extra/],
  ['no spaces', '<!--JE_TYPED_SCRIPT:main-->', /malformed typed script marker/],
  ['extra space', '<!--  JE_TYPED_SCRIPT:main -->', /malformed typed script marker/],
  ['lowercase keyword', '<!-- je_typed_script:main -->', /malformed typed script marker/],
  ['uppercase name', '<!-- JE_TYPED_SCRIPT:Main -->', /malformed typed script marker/],
  ['bare mention', '<p>JE_TYPED_SCRIPT</p><!-- JE_TYPED_SCRIPT:main -->', /malformed typed script marker/],
  ['attribute', '<div title="<!-- JE_TYPED_SCRIPT:main -->"></div>', /not a markup comment/],
  ['textarea', '<textarea><!-- JE_TYPED_SCRIPT:main --></textarea>', /not a markup comment/],
  ['style', '<style><!-- JE_TYPED_SCRIPT:main --></style>', /not a markup comment/],
  ['title', '<title><!-- JE_TYPED_SCRIPT:main --></title>', /not a markup comment/],
  ['xmp', '<xmp><!-- JE_TYPED_SCRIPT:main --></xmp>', /not a markup comment/],
  ['iframe body', '<iframe><!-- JE_TYPED_SCRIPT:main --></iframe>', /not a markup comment/],
  ['template', '<template><!-- JE_TYPED_SCRIPT:main --></template>', /not a markup comment/],
  ['nested comment', '<!-- outer <!-- JE_TYPED_SCRIPT:main --> -->', /not a markup comment|rewrites/],
  ['after plaintext', '<plaintext><!-- JE_TYPED_SCRIPT:main -->', /not a markup comment/],
  ['frameset position', '<!DOCTYPE html><html><frameset><!-- JE_TYPED_SCRIPT:main --></frameset></html>', /<frameset> is not allowed|parsed scripts/],
  ['outside the Jellyfin page', '<div data-role="page"></div><!-- JE_TYPED_SCRIPT:main -->', /outside div\[data-role="page"\]/],
  ['before the Jellyfin page', '<!-- JE_TYPED_SCRIPT:main --><div data-role="page"></div>', /outside div\[data-role="page"\]/],
  ['outside the first page', '<div data-role="page"></div><div data-role="page"><!-- JE_TYPED_SCRIPT:main --></div>', /outside div\[data-role="page"\]/],
  ['end tag comment follows', '<!-- JE_TYPED_SCRIPT:main -->-->', /rewrites/],
  ['start comment precedes', '<!--<!-- JE_TYPED_SCRIPT:main -->', /not a markup comment|comments must not/],
];

for (const [name, template, message] of rejectedMarkers) {
  test(`rejects marker placement: ${name}`, async t => {
    const f = fixture(t, { template });
    await assert.rejects(buildClient({ root: f.root }), message);
    assert.equal(existsSync(f.output), false);
  });
}

test('rejects template bytes that cannot round-trip', async t => {
  for (const [bytes, message] of [
    [Buffer.from([0x3c, 0x70, 0x3e, 0xff]), /not valid UTF-8/],
    [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<!-- JE_TYPED_SCRIPT:main -->')]), /byte order mark/],
    [Buffer.from('<!-- JE_TYPED_SCRIPT:main -->\0'), /NUL/],
  ]) {
    const f = fixture(t);
    f.template(bytes);
    await assert.rejects(discoverHtmlEntries(f.root), message);
  }
});

const page = (template = 'client/html/pages/page.html', scripts = { main: 'client/src/page.ts' }) => ({ template, scripts });
const rejectedManifests = [
  ['invalid JSON', '{', /Invalid HTML manifest/],
  ['array', '[]', /Invalid HTML manifest/],
  ['null', 'null', /Invalid HTML manifest/],
  ['empty object', '{}', /Invalid HTML manifest/],
  ['string page', { [outputPath]: 'client/html/pages/page.html' }, /must be \{ template, scripts \}/],
  ['array page', { [outputPath]: [] }, /must be \{ template, scripts \}/],
  ['unknown page key', { [outputPath]: { ...page(), attributes: { nonce: 'x' } } }, /exactly template and scripts/],
  ['missing scripts', { [outputPath]: { template: 'client/html/pages/page.html' } }, /exactly template and scripts/],
  ['empty scripts', { [outputPath]: page(undefined, {}) }, /non-empty marker-to-source/],
  ['array scripts', { [outputPath]: page(undefined, ['client/src/page.ts']) }, /non-empty marker-to-source/],
  ['non-string source', { [outputPath]: page(undefined, { main: 3 }) }, /relative/],
  ['non-string template', { [outputPath]: { template: 3, scripts: { main: 'client/src/page.ts' } } }, /relative/],
  ['bad marker name', { [outputPath]: page(undefined, { 'Main Script': 'client/src/page.ts' }) }, /invalid marker name/],
  ['proto marker name', '{"PluginPages/Page.html":{"template":"client/html/pages/page.html","scripts":{"__proto__":"client/src/page.ts"}}}', /invalid marker name/],
  ['duplicate output key', '{"PluginPages/Page.html":{"template":"client/html/pages/page.html","scripts":{"main":"client/src/page.ts"}},"PluginPages/Page.html":{"template":"client/html/pages/page.html","scripts":{"main":"client/src/page.ts"}}}', /Duplicate key/],
  ['escaped duplicate output key', '{"PluginPages/Page.html":{"template":"client/html/pages/page.html","scripts":{"main":"client/src/page.ts"}},"PluginPages/\\u0050age.html":{"template":"client/html/pages/page.html","scripts":{"main":"client/src/page.ts"}}}', /Duplicate key/],
  ['duplicate script key', '{"PluginPages/Page.html":{"template":"client/html/pages/page.html","scripts":{"main":"client/src/page.ts","main":"client/src/page.ts"}}}', /Duplicate key/],
  ['duplicate page property', '{"PluginPages/Page.html":{"template":"client/html/pages/page.html","template":"client/html/pages/page.html","scripts":{"main":"client/src/page.ts"}}}', /Duplicate key/],
  ['output traversal', { '../escape.html': page() }, /relative/],
  ['output absolute', { '/tmp/escape.html': page() }, /relative/],
  ['output alias', { 'PluginPages/../Page.html': page() }, /relative/],
  ['output double slash', { 'PluginPages//Page.html': page() }, /relative/],
  ['output backslash', { 'PluginPages\\Page.html': page() }, /relative/],
  ['output drive', { 'C:/Page.html': page() }, /relative/],
  ['output suffix', { 'PluginPages/Page.htm': page() }, /relative/],
  ['output hyphen directory', { 'Plugin-Pages/Page.html': page() }, /cannot round-trip/],
  ['output culture suffix', { 'PluginPages/Page.en.html': page() }, /cannot round-trip/],
  ['output culture region suffix', { 'PluginPages/Page.zh-Hans.html': page() }, /cannot round-trip/],
  ['output numeric directory', { '1Pages/Page.html': page() }, /cannot round-trip/],
  ['output uppercase extension', { 'PluginPages/Page.HTML': page() }, /relative/],
  ['template traversal', { [outputPath]: page('client/html/../page.html') }, /relative/],
  ['template absolute', { [outputPath]: page('/tmp/page.html') }, /relative/],
  ['template outside directory', { [outputPath]: page('client/src/page.html') }, /must be under client\/html/],
  ['template prefix lookalike', { [outputPath]: page('client/html-other/page.html') }, /must be under client\/html/],
  ['template missing', { [outputPath]: page('client/html/pages/absent.html') }, /missing HTML template/],
  ['template extension', { [outputPath]: page('client/html/pages/page.txt') }, /relative/],
  ['source traversal', { [outputPath]: page(undefined, { main: 'client/src/../page.ts' }) }, /relative/],
  ['source outside client/src', { [outputPath]: page(undefined, { main: 'scripts/page.ts' }) }, /executable/],
  ['source declaration', { [outputPath]: page(undefined, { main: 'client/src/types.d.ts' }) }, /executable/],
  ['source javascript', { [outputPath]: page(undefined, { main: 'client/src/page.js' }) }, /relative/],
  ['source missing', { [outputPath]: page(undefined, { main: 'client/src/absent.ts' }) }, /missing TypeScript entry/],
  ['not embedded', { 'PluginPages/Unlisted.html': page() }, /not an unconditional EmbeddedResource/],
];

for (const [name, value, message] of rejectedManifests) {
  test(`rejects HTML manifest: ${name}`, async t => {
    const f = fixture(t);
    f.manifest(value);
    await assert.rejects(discoverHtmlEntries(f.root), message);
  });
}

test('schema and builder agree on path and marker shapes', () => {
  const schema = JSON.parse(readFileSync(join(repositoryRoot, 'client/html-entry-manifest.schema.json'), 'utf8'));
  const output = new RegExp(schema.propertyNames.pattern);
  const { template, scripts } = schema.additionalProperties.properties;
  assert.deepEqual(schema.additionalProperties.required.sort(), ['scripts', 'template']);
  assert.equal(schema.additionalProperties.additionalProperties, false);
  for (const value of ['PluginPages/CalendarPage.html', 'Configuration/configPage.html']) assert.ok(output.test(value), value);
  for (const value of ['Plugin-Pages/Page.html', 'PluginPages/Page.en.html', '../Page.html', 'PluginPages/Page.js']) assert.equal(output.test(value), false, value);
  assert.ok(new RegExp(template.pattern).test('client/html/admin-config/configPage.html'));
  assert.equal(new RegExp(template.pattern).test('client/src/page.html'), false);
  assert.ok(new RegExp(scripts.propertyNames.pattern).test('main'));
  assert.equal(new RegExp(scripts.propertyNames.pattern).test('__proto__'), false);
  assert.ok(new RegExp(scripts.additionalProperties.pattern).test('client/src/pages/entry.ts'));
});

test('rejects output and resource collisions across manifests and shared templates', async t => {
  for (const alias of ['PluginPages/PAGE.html', 'PluginPages.Page.html']) {
    const f = fixture(t);
    f.put('client/html/pages/other.html', '<!-- JE_TYPED_SCRIPT:main -->');
    f.put('client/html-entries/other.json', JSON.stringify({ [alias]: page('client/html/pages/other.html') }));
    await assert.rejects(discoverHtmlEntries(f.root), /Duplicate output\/resource|cannot round-trip/);
  }
  const shared = fixture(t);
  shared.put('client/html-entries/other.json', JSON.stringify({ 'PluginPages/Other.html': page() }));
  await assert.rejects(discoverHtmlEntries(shared.root), /Duplicate template/);
  const caseAlias = fixture(t);
  caseAlias.put('client/html/pages/PAGE.html', '<!-- JE_TYPED_SCRIPT:main -->');
  caseAlias.put('client/html-entries/other.json', JSON.stringify({ 'PluginPages/Other.html': page('client/html/pages/PAGE.html') }));
  await assert.rejects(discoverHtmlEntries(caseAlias.root), /Duplicate template/);
});

test('rejects symlinks at every HTML path, including ones no manifest names', async t => {
  const outside = mkdtempSync(join(tmpdir(), 'je-html-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'page.html'), '<!-- JE_TYPED_SCRIPT:main -->');
  mkdirSync(join(outside, 'pages'));
  writeFileSync(join(outside, 'pages/page.html'), '<!-- JE_TYPED_SCRIPT:main -->');

  const leaf = fixture(t);
  rmSync(join(leaf.root, 'client/html/pages/page.html'));
  symlinkSync(join(outside, 'page.html'), join(leaf.root, 'client/html/pages/page.html'));
  await assert.rejects(discoverHtmlEntries(leaf.root), /Symlink/);

  const ancestor = fixture(t);
  rmSync(join(ancestor.root, 'client/html/pages'), { recursive: true });
  symlinkSync(join(outside, 'pages'), join(ancestor.root, 'client/html/pages'), 'dir');
  await assert.rejects(discoverHtmlEntries(ancestor.root), /Symlink/);

  const directory = fixture(t);
  rmSync(join(directory.root, 'client/html'), { recursive: true });
  symlinkSync(outside, join(directory.root, 'client/html'), 'dir');
  await assert.rejects(discoverHtmlEntries(directory.root), /Symlink/);

  const manifest = fixture(t);
  writeFileSync(join(outside, 'pages.json'), '{}');
  rmSync(join(manifest.root, 'client/html-entries/pages.json'));
  symlinkSync(join(outside, 'pages.json'), join(manifest.root, 'client/html-entries/pages.json'));
  await assert.rejects(discoverHtmlEntries(manifest.root), /Symlink/);

  const unreferenced = fixture(t);
  symlinkSync(join(outside, 'page.html'), join(unreferenced.root, 'client/html/pages/extra.html'));
  await assert.rejects(discoverHtmlEntries(unreferenced.root), /Symlink/);

  const dangling = fixture(t);
  rmSync(join(dangling.root, 'client/html'), { recursive: true });
  rmSync(join(dangling.root, 'client/html-entries'), { recursive: true });
  symlinkSync(join(outside, 'absent'), join(dangling.root, 'client/html'), 'dir');
  await assert.rejects(discoverHtmlEntries(dangling.root), /Symlink/);

  const output = fixture(t);
  symlinkSync(outside, join(output.root, plugin, 'PluginPages'), 'dir');
  await assert.rejects(discoverHtmlEntries(output.root), /Symlink/);
  await assert.rejects(buildClient({ root: output.root }), /Symlink/);
  assert.equal(existsSync(join(outside, 'Page.html')), false);
});

test('rejects unmapped templates and nested manifests instead of ignoring them', async t => {
  const orphan = fixture(t);
  orphan.put('client/html/pages/staged.html', '<p>staged</p>');
  await assert.rejects(discoverHtmlEntries(orphan.root), /Unmapped file under client\/html/);
  const stray = fixture(t);
  stray.put('client/html/pages/notes.txt', 'notes');
  await assert.rejects(discoverHtmlEntries(stray.root), /Unmapped file/);
  const withoutManifests = fixture(t);
  rmSync(join(withoutManifests.root, 'client/html-entries'), { recursive: true });
  await assert.rejects(buildClient({ root: withoutManifests.root, check: true }), /Unmapped file/);
  const nested = fixture(t);
  nested.put('client/html-entries/group/pages.json', '{}');
  await assert.rejects(discoverHtmlEntries(nested.root), /directly under/);
});

test('an existing but empty HTML tree needs no fake entry and leaves the ledger JS-only', async t => {
  const f = fixture(t);
  rmSync(join(f.root, 'client/html'), { recursive: true });
  rmSync(join(f.root, 'client/html-entries/pages.json'));
  const result = await buildClient({ root: f.root });
  assert.equal(result.html, 0);
  assert.equal('html' in f.ledger(), false);
});

test('strict policies apply to HTML entries and their dependencies equally', async t => {
  for (const [source, message] of [
    ['const value: any = 1;\ndocument.title = String(value);\n', /Explicit any/],
    ['// @ts-nocheck\nconst value: string = 1;\n', /@ts-nocheck/],
    ['// @ts-ignore\nconst value: string = 1;\ndocument.title = value;\n', /suppression/],
    ['const value: string = 1;\ndocument.title = value;\n', /not assignable/],
    ['await Promise.resolve();\nexport {};\n', /Top-level await/],
  ]) {
    const f = fixture(t, { source });
    f.put(`${plugin}/${outputPath}`, '<p>runnable legacy</p>');
    await assert.rejects(buildClient({ root: f.root }), message);
    assert.equal(f.read(), '<p>runnable legacy</p>');
  }
  const dependency = fixture(t, { source: 'import { value } from "./dependency";\ndocument.title = value;\n' });
  dependency.put('client/src/dependency.ts', 'const bad: number = "x";\nexport const value = String(bad);\n');
  await assert.rejects(buildClient({ root: dependency.root }), /not assignable/);
  const javascript = fixture(t, { source: 'import { value } from "./legacy";\ndocument.title = value;\n' });
  javascript.put('client/src/legacy.d.ts', 'export declare const value: string;\n');
  javascript.put('client/src/legacy.js', 'export const value = "untyped";\n');
  await assert.rejects(buildClient({ root: javascript.root }), /checked TypeScript under client\/src/);
  const excluded = fixture(t);
  excluded.put('client/tsconfig.json', JSON.stringify({ ...JSON.parse(readFileSync(join(repositoryRoot, 'client/tsconfig.json'), 'utf8')), exclude: ['src/page.ts'] }));
  excluded.put('client/src/other.ts', 'export {};\n');
  await assert.rejects(buildClient({ root: excluded.root }), /excluded from type checking/);
});

test('stale templates, dependencies, outputs and provenance fail check without any write, then recover', async t => {
  const f = fixture(t, { source: 'import { value } from "./dependency";\ndocument.title = value;\n' });
  f.put('client/src/dependency.ts', 'export const value: string = "one";\n');
  f.put(`${plugin}/js/legacy.js`, '// legacy\n');
  await assert.rejects(buildClient({ root: f.root, check: true }), /Stale or missing[\s\S]*Page\.html/);
  assert.equal(existsSync(f.output), false, 'a missing page is reported, not generated');
  await buildClient({ root: f.root });
  assert.equal((await buildClient({ root: f.root, check: true })).changed, 0);
  const good = snapshot(f.root);
  const page = f.read();
  const ledger = readFileSync(join(f.root, 'client/generated-manifest.json'), 'utf8');

  const stale = async (mutate, expected) => {
    mutate();
    const changed = snapshot(f.root);
    await assert.rejects(buildClient({ root: f.root, check: true }), expected);
    assert.deepEqual(snapshot(f.root), changed, 'check mode writes nothing');
  };
  await stale(() => f.template(`${defaultTemplate}<p>new</p>\n`), /Page\.html/);
  await buildClient({ root: f.root });
  assert.notEqual(f.read(), page);
  f.template(defaultTemplate);
  await buildClient({ root: f.root });
  assert.deepEqual(snapshot(f.root), good, 'restoring sources restores every byte');

  await stale(() => f.put('client/src/dependency.ts', 'export const value: string = "two";\n'), /Page\.html/);
  await buildClient({ root: f.root });
  assert.match(scriptTexts(f.read())[0], /"two"/);
  f.put('client/src/dependency.ts', 'export const value: string = "one";\n');
  await buildClient({ root: f.root });

  // A comment changes no code, but the embedded TypeScript and provenance must not go stale.
  await stale(() => f.put('client/src/dependency.ts', '// note\nexport const value: string = "one";\n'), /Page\.html/);
  f.put('client/src/dependency.ts', 'export const value: string = "one";\n');

  await stale(() => writeFileSync(f.output, page.replace('</script>', '</script><script>alert(1)</script>')), /Page\.html/);
  await stale(() => rmSync(f.output), /Page\.html/);
  await stale(() => writeFileSync(f.output, ''), /Page\.html/);
  writeFileSync(f.output, page);
  await stale(() => writeFileSync(join(f.root, 'client/generated-manifest.json'), ledger.replace(/"templateSha256": "[0-9a-f]{6}/, '"templateSha256": "000000')), /generated-manifest/);
  await stale(() => rmSync(join(f.root, 'client/generated-manifest.json')), /generated-manifest/);
  await buildClient({ root: f.root });
  assert.deepEqual(snapshot(f.root), good);
  await stale(() => rmSync(join(f.root, 'client/src/dependency.ts')), /dependency|resolve/);
  f.put('client/src/dependency.ts', 'export const value: string = "one";\n');
  await stale(() => rmSync(join(f.root, 'client/html/pages/page.html')), /missing HTML template/);
  f.template(defaultTemplate);
  await buildClient({ root: f.root, check: true });
  assert.equal(readFileSync(join(f.root, plugin, 'js/legacy.js'), 'utf8'), '// legacy\n');
});

test('a retired page fails as an orphan until its output is explicitly removed', async t => {
  const f = fixture(t);
  await buildClient({ root: f.root });
  rmSync(join(f.root, 'client/html'), { recursive: true });
  rmSync(join(f.root, 'client/html-entries'), { recursive: true });
  await assert.rejects(buildClient({ root: f.root, check: true }), /Orphan generated/);
  await assert.rejects(buildClient({ root: f.root }), /Orphan generated/);
  rmSync(f.output);
  await buildClient({ root: f.root });
  assert.equal('html' in f.ledger(), false);
});

test('provenance names and hashes the template, every TypeScript input and the output', async t => {
  const f = fixture(t, { source: 'import { value } from "./dependency";\ndocument.title = value;\n' });
  f.put('client/src/dependency.ts', 'export const value: string = "one";\n');
  await buildClient({ root: f.root });
  const hash = path => createHash('sha256').update(readFileSync(join(f.root, path))).digest('hex');
  const ledger = f.ledger();
  assert.deepEqual(Object.keys(ledger), ['version', 'tools', 'entries', 'html', 'outputs']);
  const [entry] = ledger.html;
  const [text] = scriptTexts(f.read());
  assert.deepEqual(entry, {
    output: outputPath,
    manifest: 'client/html-entries/pages.json',
    template: 'client/html/pages/page.html',
    templateSha256: hash('client/html/pages/page.html'),
    outputSha256: hash(`${plugin}/${outputPath}`),
    scripts: [{
      name: 'main',
      scriptIndex: 0,
      source: 'client/src/page.ts',
      sha256: createHash('sha256').update(text).digest('hex'),
      inputs: { 'client/src/dependency.ts': hash('client/src/dependency.ts'), 'client/src/page.ts': hash('client/src/page.ts') },
    }],
  });
  assert.equal(ledger.outputs[`${plugin}/${outputPath}`], entry.outputSha256);
});

test('page and provenance bytes reproduce across checkouts, with no checkout path in them', async t => {
  const a = fixture(t, { source: hazardSource });
  const b = fixture(t, { source: hazardSource });
  await buildClient({ root: a.root });
  await buildClient({ root: b.root });
  await buildClient({ root: a.root });
  for (const path of [`${plugin}/${outputPath}`, 'client/generated-manifest.json']) {
    assert.deepEqual(readFileSync(join(a.root, path)), readFileSync(join(b.root, path)), path);
  }
  const map = inlineMap(scriptTexts(a.read())[0]);
  assert.ok(map.sources.every(source => source.startsWith('client/src/')));
  assert.equal(JSON.stringify(map).includes(a.root), false);
  assert.equal(a.read().includes(a.root), false);
});

test('adding an HTML page leaves JavaScript entries and their artifacts byte-identical', async t => {
  const f = fixture(t);
  f.put('client/src/entry.ts', 'document.title = `</script> ${"x"}`;\n');
  f.put('client/entries/core.json', JSON.stringify({ 'js/core/entry.js': 'client/src/entry.ts' }));
  const without = fixture(t);
  without.put('client/src/entry.ts', 'document.title = `</script> ${"x"}`;\n');
  without.put('client/src/page.ts', 'document.title = "typed page";\n');
  without.put('client/entries/core.json', JSON.stringify({ 'js/core/entry.js': 'client/src/entry.ts' }));
  rmSync(join(without.root, 'client/html'), { recursive: true });
  rmSync(join(without.root, 'client/html-entries'), { recursive: true });
  await buildClient({ root: f.root });
  await buildClient({ root: without.root });
  for (const path of [`${plugin}/js/core/entry.js`, `${plugin}/js/core/entry.js.map`]) {
    assert.deepEqual(readFileSync(join(f.root, path)), readFileSync(join(without.root, path)), path);
  }
  assert.match(readFileSync(join(f.root, plugin, 'js/core/entry.js'), 'utf8'), /`/, 'JS entries keep their existing template literals');
  assert.deepEqual(discoverEntries(f.root), [{ output: 'js/core/entry.js', source: 'client/src/entry.ts', manifest: 'client/entries/core.json' }]);
  assert.doesNotThrow(() => checkSourcePolicy(f.root));
});

test('the builder takes no validation lock, so it runs inside verify:rewrite', async t => {
  const f = fixture(t);
  await buildClient({ root: f.root });
  const hasFlock = spawnSync('flock', ['--version']).status === 0;
  assert.ok(hasFlock, 'flock is a documented prerequisite');
  cpSync(join(repositoryRoot, 'scripts'), join(f.root, 'scripts'), { recursive: true, filter: source => !source.includes('__pycache__') });
  symlinkSync(join(repositoryRoot, 'node_modules'), join(f.root, 'node_modules'), 'dir');
  const lock = join(f.root, 'validation.lock');
  const clientLock = join(f.root, 'client.lock');
  writeFileSync(lock, '');
  writeFileSync(clientLock, '');
  const held = spawnSync('flock', [lock, 'flock', clientLock, process.execPath, 'scripts/client-build.mjs', '--check'], {
    cwd: f.root,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, JE_VALIDATION_LOCK: lock },
  });
  assert.equal(held.status, 0, held.stdout + held.stderr);
  f.template(`${defaultTemplate}<p>new</p>\n`);
  const stale = spawnSync(process.execPath, ['scripts/client-build.mjs', '--check'], { cwd: f.root, encoding: 'utf8' });
  assert.equal(stale.status, 1, 'the exit code is what stops MSBuild');
  assert.match(stale.stderr, /Stale or missing[\s\S]*Page\.html/);
  for (const file of ['scripts/client-build.mjs', 'scripts/client/html-entries.mjs']) {
    assert.doesNotMatch(readFileSync(join(repositoryRoot, file), 'utf8'), /flock|child_process|je-v12/);
  }
  // The one process the builder starts is the type checker (scripts/typecheck-tool.mjs), which takes no lock either.
  assert.doesNotMatch(readFileSync(join(repositoryRoot, 'scripts/typecheck-tool.mjs'), 'utf8'), /flock|je-v12/);
});

test('every production page embedded today has markup the policy admits', async t => {
  const pages = ['Configuration/configPage.html', 'Configuration/mediaTagsPage.html', ...['Activity', 'Bookmarks', 'Calendar', 'CatchUp', 'Downloads', 'HiddenContent', 'Recommendations'].map(name => `PluginPages/${name}Page.html`)];
  const project = readFileSync(join(repositoryRoot, plugin, 'JellyfinEnhanced.csproj'), 'utf8');
  const f = fixture(t);
  f.put(`${plugin}/JellyfinEnhanced.csproj`, project);
  rmSync(join(f.root, 'client/html'), { recursive: true });
  rmSync(join(f.root, 'client/html-entries'), { recursive: true });
  const manifest = {};
  const expected = new Map();
  for (const [index, output] of pages.entries()) {
    assert.ok(project.includes(`<EmbeddedResource Include="${output.replace('/', '\\')}"/>`), `${output} is an explicit EmbeddedResource`);
    // Convert the shipped page to a template with the same parser the builder uses.
    const raw = readFileSync(join(repositoryRoot, plugin, output), 'utf8');
    const dom = new JSDOM(raw, { includeNodeLocations: true });
    const scripts = [...dom.window.document.querySelectorAll('script')].map(node => dom.nodeLocation(node));
    let template = '';
    let cursor = 0;
    const names = {};
    scripts.forEach((location, scriptIndex) => {
      template += `${raw.slice(cursor, location.startOffset)}<!-- JE_TYPED_SCRIPT:s${scriptIndex} -->`;
      cursor = location.endOffset;
      names[`s${scriptIndex}`] = 'client/src/page.ts';
    });
    template += raw.slice(cursor);
    dom.window.close();
    const path = `client/html/real/page${index}.html`;
    f.put(path, template);
    manifest[output] = { template: path, scripts: names };
    expected.set(output, { template, count: scripts.length });
  }
  f.manifest(manifest);
  await buildClient({ root: f.root });
  for (const [output, { template, count }] of expected) {
    const html = readFileSync(join(f.root, plugin, output), 'utf8');
    assert.equal(new JSDOM(html).window.document.querySelectorAll('script').length, count, output);
    assert.equal(statSync(join(f.root, plugin, output)).isFile(), true);
    const stripped = html.replace(/<script>[\s\S]*?<\/script>/g, () => '<!-- marker -->');
    assert.equal(stripped, template.replace(/<!-- JE_TYPED_SCRIPT:s\d+ -->/g, '<!-- marker -->'), `${output} markup is unchanged`);
  }
});

const resourceCasesR2 = [
  ['child logical name', '<EmbeddedResource Include="PluginPages/Page.html"><LogicalName>Wrong</LogicalName></EmbeddedResource>'],
  ['child manifest name', '<EmbeddedResource Include="PluginPages/Page.html"><ManifestResourceName>Wrong</ManifestResourceName></EmbeddedResource>'],
  ['conditional metadata', '<EmbeddedResource Include="PluginPages/Page.html"><LogicalName Condition="true">Wrong</LogicalName></EmbeddedResource>'],
  ['attribute metadata', '<EmbeddedResource Include="PluginPages/Page.html" LogicalName="Wrong"/>'],
  ['exact remove', '<EmbeddedResource Include="PluginPages/Page.html"/><EmbeddedResource Remove="PluginPages/Page.html"/>'],
  ['glob remove', '<EmbeddedResource Include="PluginPages/Page.html"/><EmbeddedResource Remove="PluginPages/**/*.html"/>'],
  ['question remove', '<EmbeddedResource Include="PluginPages/Page.html"/><EmbeddedResource Remove="PluginPages/Pag?.html"/>'],
  ['relative remove', '<EmbeddedResource Include="PluginPages/Page.html"/><EmbeddedResource Remove="./PluginPages/Page.html"/>'],
  ['parent remove', '<EmbeddedResource Include="PluginPages/Page.html"/><EmbeddedResource Remove="Other/../PluginPages/Page.html"/>'],
  ['escaped remove', '<EmbeddedResource Include="PluginPages/Page.html"/><EmbeddedResource Remove="PluginPages/%50age.html"/>'],
  ['updated metadata', '<EmbeddedResource Include="PluginPages/Page.html"/><EmbeddedResource Update="PluginPages/*.html"><LogicalName>Wrong</LogicalName></EmbeddedResource>'],
  ['duplicate include', '<EmbeddedResource Include="PluginPages/Page.html"/><EmbeddedResource Include="PluginPages/Page.html"/>'],
  ['conditional include', '<EmbeddedResource Include="PluginPages/Page.html" Condition="false"/>'],
];
for (const [name, items] of resourceCasesR2) {
  test('R2 embedding rejects ' + name, async t => {
    const f = fixture(t);
    f.put(plugin + '/JellyfinEnhanced.csproj', '<Project><ItemGroup>' + items + '</ItemGroup></Project>');
    await assert.rejects(discoverHtmlEntries(f.root), /not an unconditional EmbeddedResource/);
  });
}
test('R2 embedding rejects conditional ancestors and default resource metadata', async t => {
  const f = fixture(t);
  for (const xml of [
    '<Project><ItemGroup Condition="false"><EmbeddedResource Include="PluginPages/Page.html"/></ItemGroup></Project>',
    '<Project><Choose><When Condition="false"><ItemGroup><EmbeddedResource Include="PluginPages/Page.html"/></ItemGroup></When></Choose></Project>',
    '<Project><ItemDefinitionGroup><EmbeddedResource><LogicalName>Wrong</LogicalName></EmbeddedResource></ItemDefinitionGroup><ItemGroup><EmbeddedResource Include="PluginPages/Page.html"/></ItemGroup></Project>',
  ]) {
    f.put(plugin + '/JellyfinEnhanced.csproj', xml);
    await assert.rejects(discoverHtmlEntries(f.root), /not an unconditional EmbeddedResource/);
  }
});
test('R2 embedding preserves ordinary pages and unrelated resource operations', async t => {
  const f = fixture(t);
  f.put(plugin + '/JellyfinEnhanced.csproj', '<Project><ItemGroup><EmbeddedResource Include="PluginPages/Page.html"/><EmbeddedResource Include="PluginPages/Other.html"><LogicalName>Other</LogicalName></EmbeddedResource><EmbeddedResource Update="Data/*.json"/><EmbeddedResource Remove="PluginPages/Other.html"/></ItemGroup></Project>');
  await assert.doesNotReject(discoverHtmlEntries(f.root));
});
