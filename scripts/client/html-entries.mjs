// Typed inline scripts for production HTML. See docs/rewrite/html-build.md.
//
// scripts/client-build.mjs loads this module lazily, only when client/html or
// client/html-entries exists, and passes it the helpers it shares with JavaScript
// entries. Nothing here writes files: every function returns data so check mode and
// build mode share one code path.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix } from 'node:path';

const require = createRequire(import.meta.url);
const manifestDirectory = 'client/html-entries';
const templateDirectory = 'client/html';
const markerNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const outputPattern = /^(?:[A-Za-z_][A-Za-z0-9_]*\/)*[A-Za-z0-9_][A-Za-z0-9_-]*\.html$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

// Sequences a browser or the Jellyfin 12 page loader would act on inside inline script
// text. `</script` ends the element, `<!--` lets `<script` swallow the real end tag, and
// `${` is rewritten by globalize.translateHtml, which ServerContentPage runs over the
// entire fetched page before the script exists.
const inlineHazards = /<\/script|<!--|\$\{/gi;
const nonInlineSafe = /[^\t\n\x20-\x7e]/g;

// Everything that can run, navigate or re-base a page without one of our typed scripts.
// None of these appear in the baseline pages' markup.
const bannedElements = new Set(['script', 'noscript', 'object', 'embed', 'applet', 'frame', 'frameset', 'base', 'portal', 'svg', 'math']);
const urlAttributes = new Set(['href', 'src', 'action', 'formaction', 'data', 'poster', 'background', 'cite', 'ping', 'manifest', 'xlink:href']);

/** jsdom is already the repository's HTML parser; no other parser is introduced. */
function loadJsdom() {
  try {
    return require('jsdom').JSDOM;
  } catch (error) {
    throw new Error(`Frontend prerequisites unavailable. Install Node >=22.12 and run npm ci at the repository root, then npm run client:build. ${error.message}`);
  }
}

/** Reports whether a path exists without following it, so dangling symlinks still count. */
const present = path => Boolean(lstatSync(path, { throwIfNoEntry: false }));

/** JSON.parse keeps the last duplicate, so read the keys from the TS JSON AST at every depth. */
function rejectDuplicateKeys(ts, path, raw) {
  const visit = node => {
    if (ts.isObjectLiteralExpression(node)) {
      const seen = new Set();
      for (const property of node.properties) {
        const key = property.name.text;
        if (seen.has(key)) throw new Error(`Duplicate key ${key} in ${path}`);
        seen.add(key);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.parseJsonText(path, raw));
}

/** Validates one manifest's shape; paths are validated by the caller. */
function parseHtmlManifest(ts, path, raw) {
  let value;
  try { value = JSON.parse(raw); }
  catch (error) { throw new Error(`Invalid HTML manifest ${path}: ${error.message}`); }
  if (!value || Array.isArray(value) || typeof value !== 'object' || !Object.keys(value).length) {
    throw new Error(`Invalid HTML manifest ${path}: expected a non-empty output-to-page object`);
  }
  rejectDuplicateKeys(ts, path, raw);
  for (const [output, page] of Object.entries(value)) {
    if (!page || Array.isArray(page) || typeof page !== 'object') {
      throw new Error(`Invalid HTML manifest ${path}: ${output} must be { template, scripts }`);
    }
    const keys = Object.keys(page).sort();
    if (keys.length !== 2 || keys[0] !== 'scripts' || keys[1] !== 'template') {
      throw new Error(`Invalid HTML manifest ${path}: ${output} must contain exactly template and scripts`);
    }
    if (!page.scripts || Array.isArray(page.scripts) || typeof page.scripts !== 'object' || !Object.keys(page.scripts).length) {
      throw new Error(`Invalid HTML manifest ${path}: ${output} scripts must be a non-empty marker-to-source object`);
    }
  }
  return value;
}

/** Templates are read as bytes so output can preserve them exactly. */
function readTemplate(root, path, safePath, label) {
  const file = safePath(root, path);
  if (!present(file) || !lstatSync(file).isFile()) throw new Error(`${label}: missing HTML template ${path}`);
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${path}: template is not valid UTF-8`);
  if (text.charCodeAt(0) === 0xfeff) throw new Error(`${path}: template must not start with a byte order mark`);
  if (text.includes('\0')) throw new Error(`${path}: template contains a NUL character`);
  return { bytes, text };
}

/** Finds every marker as raw text; anything resembling one must be exact or the build fails. */
function scanMarkers(path, text) {
  const exact = /<!-- JE_TYPED_SCRIPT:([a-z][a-z0-9]*(?:-[a-z0-9]+)*) -->/y;
  const markers = [];
  for (const match of text.matchAll(/je_typed_script/gi)) {
    exact.lastIndex = match.index - '<!-- '.length;
    const found = exact.lastIndex < 0 ? null : exact.exec(text);
    if (!found) {
      const line = text.slice(0, match.index).split('\n').length;
      throw new Error(`${path}:${line}: malformed typed script marker. Use exactly <!-- JE_TYPED_SCRIPT:name --> with a lowercase name.`);
    }
    markers.push({ name: found[1], start: found.index, end: found.index + found[0].length });
  }
  return markers;
}

/** Depth-first in document order, descending into inert <template> content too. */
function forEachNode(parent, visit, inTemplate = false) {
  for (const node of parent.childNodes) {
    visit(node, inTemplate);
    forEachNode(node, visit, inTemplate);
    if (node.nodeType === 1 && node.localName === 'template' && node.namespaceURI === HTML_NAMESPACE) {
      forEachNode(node.content, visit, true);
    }
  }
}

/** URL parsers strip tabs/newlines and leading C0 characters before reading the scheme. */
function isExecutableUrl(value) {
  const url = value.replace(/[\t\n\r]/g, '').replace(/^[\0-\x20]+/, '').toLowerCase();
  if (/^(?:javascript|vbscript):/.test(url)) return true;
  return url.startsWith('data:') && !/^data:image\/(?:png|jpeg|gif|webp|avif)[;,]/.test(url);
}

/** The one rule set for markup, applied to the template and again to the generated page. */
function rejectActiveMarkup(node, label, allowScripts) {
  if (node.nodeType === 8) {
    // parseHtml in jellyfin-web un-comments <!--<script ...</script>--> on every page load.
    if (/<\/?script/i.test(node.data)) throw new Error(`${label}: comments must not contain script tags. Jellyfin can re-activate them.`);
    return;
  }
  if (node.nodeType !== 1) return;
  const name = node.localName.toLowerCase();
  if (bannedElements.has(name) && !(allowScripts && name === 'script')) {
    throw new Error(`${label}: <${name}> is not allowed in a typed HTML page. Move behaviour to TypeScript and use a JE_TYPED_SCRIPT marker.`);
  }
  if (name === 'meta' && node.hasAttribute('http-equiv')) throw new Error(`${label}: <meta http-equiv> is not allowed in a typed HTML page.`);
  if (name === 'link' && (node.getAttribute('rel') ?? '').trim().toLowerCase() !== 'stylesheet') {
    throw new Error(`${label}: only <link rel="stylesheet"> is allowed in a typed HTML page.`);
  }
  for (const attribute of node.attributes) {
    const attributeName = attribute.name.toLowerCase();
    if (/^on[a-z]/.test(attributeName)) throw new Error(`${label}: inline event handler ${attributeName} on <${name}> is not allowed.`);
    if (attributeName === 'srcdoc') throw new Error(`${label}: srcdoc on <${name}> is not allowed.`);
    if (urlAttributes.has(attributeName) && isExecutableUrl(attribute.value)) {
      throw new Error(`${label}: executable URL in ${attributeName} on <${name}> is not allowed.`);
    }
  }
}

/** Parses the way Jellyfin does (div.innerHTML) and the way a document parser does. */
function parseBothWays(JSDOM, text, inspect) {
  const dom = new JSDOM(text, { includeNodeLocations: true });
  const wrapper = dom.window.document.createElement('div');
  try {
    wrapper.innerHTML = text;
    return inspect(dom, wrapper);
  } finally {
    dom.window.close();
  }
}

/** Finds the element Jellyfin keeps; anything outside it is discarded on the dashboard. */
function pageContainer(wrapper) {
  return wrapper.querySelector('div[data-role="page"]');
}

/** Validates a template against the policy and pairs its markers with manifest scripts. */
function inspectTemplate(JSDOM, page, text, markers) {
  const label = page.template;
  if (text.includes('${')) throw new Error(`${label}: \${ in markup is rewritten by Jellyfin's translateHtml before the page runs and can corrupt generated scripts.`);
  const declared = Object.keys(page.scripts);
  const seen = new Set();
  for (const { name } of markers) {
    if (seen.has(name)) throw new Error(`${label}: duplicate marker ${name}`);
    seen.add(name);
    if (!declared.includes(name)) throw new Error(`${label}: unmapped marker ${name}. Add it to ${page.manifest}.`);
  }
  for (const name of declared) {
    if (!seen.has(name)) throw new Error(`${label}: missing marker for ${page.manifest} script ${name}`);
  }
  parseBothWays(JSDOM, text, (dom, wrapper) => {
    const located = new Set();
    forEachNode(dom.window.document, (node, inTemplate) => {
      rejectActiveMarkup(node, label, false);
      if (node.nodeType !== 8) return;
      const location = dom.nodeLocation(node);
      if (location && !inTemplate) located.add(location.startOffset);
    });
    for (const marker of markers) {
      if (!located.has(marker.start)) {
        throw new Error(`${label}: marker ${marker.name} is not a markup comment. Markers cannot sit in attributes, comments, raw text or <template>.`);
      }
    }
    const comments = [];
    forEachNode(wrapper, (node, inTemplate) => {
      rejectActiveMarkup(node, label, false);
      if (node.nodeType === 8 && !inTemplate) comments.push(node);
    });
    const container = pageContainer(wrapper);
    for (const marker of markers) {
      const comment = comments.find(node => node.data === ` JE_TYPED_SCRIPT:${marker.name} `);
      if (!comment) throw new Error(`${label}: marker ${marker.name} does not survive Jellyfin's fragment parse.`);
      if (container && !container.contains(comment)) {
        throw new Error(`${label}: marker ${marker.name} is outside div[data-role="page"], so Jellyfin would discard its script.`);
      }
    }
  });
}

/** Every path under client/html must be a referenced template, or work is silently unbuilt. */
function rejectUnmappedTemplates(root, referenced, safePath) {
  const visit = directory => {
    for (const entry of readdirSync(safePath(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Symlink paths are not allowed: ${path}`);
      if (entry.isDirectory()) visit(path);
      else if (!referenced.has(path)) throw new Error(`Unmapped file under ${templateDirectory}: ${path}. Reference it from ${manifestDirectory} or keep staged work outside ${templateDirectory}.`);
    }
  };
  if (present(join(root, templateDirectory))) visit(templateDirectory);
}

/**
 * HTML reaches the plugin through explicit EmbeddedResource items, unlike js\**.
 * An unlisted page would build cleanly and then be absent from the assembly.
 */
function rejectUnembeddedOutputs(root, pages, safePath, JSDOM, pluginDirectory) {
  if (!pages.length) return;
  const project = `${pluginDirectory}/JellyfinEnhanced.csproj`;
  const file = safePath(root, project);
  if (!present(file)) throw new Error(`Cannot verify embedded HTML resources: missing ${project}`);
  const dom = new JSDOM(readFileSync(file, 'utf8'), { contentType: 'text/xml' });
  const embedded = new Set();
  const items = [...dom.window.document.getElementsByTagName('EmbeddedResource')];
  const normalize = value => posix.normalize(value.replaceAll('\\', '/'));
  const couldMatch = (spec, output) => spec.split(';').some(value => {
    const raw = value.trim().replaceAll('\\', '/');
    const path = normalize(raw);
    // Dynamic/escaped or parent-relative item specs need evaluated MSBuild evidence.
    if (path.includes('$(') || path.includes('@(') || path.includes('%') || /[*?].*\/\.\.(?:\/|$)/.test(raw)) return true;
    // Conservative matching: * can cross directories. Ambiguous declarations fail.
    const expression = path.replace(/[|\\{}()[\]^$+.]/g, '\\$&')
      .replaceAll('**/', '\u0000').replaceAll('*', '.*').replaceAll('?', '.').replaceAll('\u0000', '(?:.*/)?');
    return new RegExp('^' + expression + '$', 'i').test(output);
  });
  for (const page of pages) {
    let plain = 0;
    let altered = false;
    for (const item of items) {
      const include = item.getAttribute('Include');
      if (include !== null && couldMatch(include, page.output)) {
        const group = item.parentElement;
        const direct = group?.localName === 'ItemGroup' && group.parentElement?.localName === 'Project';
        // Support the explicit, metadata-free declarations used by shipped pages.
        // Conditional/renamed/duplicated declarations require evaluated MSBuild evidence.
        if (normalize(include) === page.output && direct && !group.hasAttribute('Condition')
            && item.attributes.length === 1 && item.children.length === 0) plain++;
        else altered = true;
      }
      for (const operation of ['Remove', 'Update']) {
        if (item.hasAttribute(operation) && couldMatch(item.getAttribute(operation), page.output)) altered = true;
      }
      if (item.parentElement?.localName === 'ItemDefinitionGroup' && item.children.length) altered = true;
    }
    if (plain === 1 && !altered) embedded.add(page.output);
  }
  dom.window.close();
  for (const page of pages) {
    if (!embedded.has(page.output)) throw new Error(`${page.manifest}: ${page.output} is not an unconditional EmbeddedResource in ${project}.`);
  }
}

/**
 * Reads, validates and returns every typed HTML page in output order.
 * @param {{root: string, ts: object, safePath: Function, validatePath: Function, pluginDirectory: string}} context
 */
export function discoverHtmlPages({ root, ts, safePath, validatePath, pluginDirectory }) {
  const JSDOM = loadJsdom();
  const pages = [];
  const outputs = new Map();
  const templates = new Map();
  if (present(join(root, manifestDirectory))) {
    const folder = safePath(root, manifestDirectory);
    for (const file of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (file.isDirectory()) throw new Error(`HTML manifests must be directly under ${manifestDirectory}: ${file.name}`);
      if (!file.name.endsWith('.json')) continue;
      const manifest = `${manifestDirectory}/${file.name}`;
      const value = parseHtmlManifest(ts, manifest, readFileSync(safePath(root, manifest), 'utf8'));
      for (const output of Object.keys(value).sort()) {
        const { template, scripts } = value[output];
        validatePath(output, '.html', manifest);
        if (!outputPattern.test(output)) {
          throw new Error(`${manifest}: output cannot round-trip through embedded-resource lookup: ${output}. Use identifier directory names and a single .html extension.`);
        }
        const resourceName = output.split('/').map((part, i, parts) => i < parts.length - 1 ? part.replaceAll('-', '_') : part).join('.').toLowerCase();
        if (outputs.has(resourceName)) throw new Error(`Duplicate output/resource ${output}: ${manifest} conflicts with ${outputs.get(resourceName)}`);
        outputs.set(resourceName, manifest);
        validatePath(template, '.html', manifest);
        if (!template.startsWith(`${templateDirectory}/`)) throw new Error(`${manifest}: template must be under ${templateDirectory}: ${template}`);
        const templateKey = template.toLowerCase();
        if (templates.has(templateKey)) throw new Error(`Duplicate template ${template}: already used by ${templates.get(templateKey)}`);
        templates.set(templateKey, output);
        for (const [name, source] of Object.entries(scripts)) {
          if (!markerNamePattern.test(name)) throw new Error(`${manifest}: invalid marker name ${JSON.stringify(name)}`);
          validatePath(source, '.ts', manifest);
          if (!source.startsWith('client/src/') || source.endsWith('.d.ts')) {
            throw new Error(`${manifest}: entry must be an executable .ts source under client/src: ${source}`);
          }
          const input = safePath(root, source);
          if (!present(input) || !lstatSync(input).isFile()) throw new Error(`${manifest}: missing TypeScript entry ${source}`);
        }
        safePath(root, `${pluginDirectory}/${output}`);
        const { bytes, text } = readTemplate(root, template, safePath, manifest);
        const markers = scanMarkers(template, text);
        const page = { output, manifest, template, scripts, templateBytes: bytes, text, markers };
        inspectTemplate(JSDOM, page, text, markers);
        pages.push(page);
      }
    }
  }
  rejectUnmappedTemplates(root, new Set(pages.map(page => page.template)), safePath);
  rejectUnembeddedOutputs(root, pages, safePath, JSDOM, pluginDirectory);
  return pages.sort((a, b) => a.output < b.output ? -1 : a.output > b.output ? 1 : 0);
}

/** Literal tokens from the emitted bundle; JSDoc is not parsed so comments stay comments. */
function collectLiterals(ts, code, label) {
  const source = ts.createSourceFile('inline.js', code, { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone }, false, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length) throw new Error(`${label}: generated script does not parse: ${source.parseDiagnostics[0].messageText}`);
  const kinds = new Map([
    [ts.SyntaxKind.StringLiteral, 'string'],
    [ts.SyntaxKind.RegularExpressionLiteral, 'regex'],
    [ts.SyntaxKind.NoSubstitutionTemplateLiteral, 'template'],
    [ts.SyntaxKind.TemplateHead, 'template'],
    [ts.SyntaxKind.TemplateMiddle, 'template'],
    [ts.SyntaxKind.TemplateTail, 'template'],
  ]);
  const literals = [];
  const visit = node => {
    const kind = kinds.get(node.kind);
    if (kind) literals.push({ kind, start: node.getStart(source), end: node.end, text: node.text });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return literals.sort((a, b) => a.start - b.start);
}

/** Comments live in the gaps between literals, which contain no regex or template text. */
function collectComments(ts, code, literals) {
  const comments = [];
  const scanGap = (start, end) => {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, code, undefined, start, end - start);
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
        comments.push({ kind: 'comment', start: scanner.getTokenStart(), end: scanner.getTokenEnd() });
      }
    }
  };
  let cursor = 0;
  for (const literal of literals) {
    scanGap(cursor, literal.start);
    cursor = literal.end;
  }
  scanGap(cursor, code.length);
  return comments;
}

/** \xHH and \uHHHH mean the same character in strings, comments and every RegExp mode and context. */
function hexEscape(character) {
  const unit = character.charCodeAt(0);
  return unit < 0x100 ? `\\x${unit.toString(16).padStart(2, '0')}` : `\\u${unit.toString(16).padStart(4, '0')}`;
}

/** Returns the replacements that remove hazards from one token, or fails where none is proven. */
function tokenEdits(code, token, label) {
  const edits = [];
  const text = code.slice(token.start, token.end);
  for (const match of text.matchAll(inlineHazards)) {
    if (token.kind === 'template') throw new Error(`${label}: a template literal survived lowering and contains ${match[0]}.`);
    if (token.kind === 'regex' && match[0] === '<!--' && text.slice(0, match.index).endsWith('(?')) {
      throw new Error(`${label}: regular expression lookbehind (?<!-- cannot be escaped safely. Write it as (?<!-{2}).`);
    }
    const position = token.start + match.index + 1;
    edits.push({ start: position, end: position + 1, text: hexEscape(code[position]) });
  }
  // charset: 'ascii' leaves raw characters in regular expressions, C0 controls in strings
  // and everything in comments.
  for (const match of text.matchAll(nonInlineSafe)) {
    if (token.kind === 'template') throw new Error(`${label}: a template literal survived lowering and contains a raw U+${match[0].charCodeAt(0).toString(16)}.`);
    const position = token.start + match.index;
    let backslashes = 0;
    while (text[match.index - 1 - backslashes] === '\\') backslashes += 1;
    // /\–/ is an identity escape. A new escape after its backslash would read \\u2013: a
    // literal backslash, in a pattern that still compiles.
    const start = token.kind !== 'comment' && backslashes % 2 ? position - 1 : position;
    edits.push({ start, end: position + 1, text: hexEscape(match[0]) });
  }
  return edits;
}

/** Reduces a regular expression to a form where every spelling of one character is equal. */
function regexNormalForm(text) {
  let normal = '';
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\\') {
      normal += text[index];
      continue;
    }
    const hex = /^(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4}))/.exec(text.slice(index + 1, index + 6));
    if (hex) {
      normal += String.fromCharCode(Number.parseInt(hex[1] ?? hex[2], 16));
      index += hex[0].length;
    } else {
      const next = text[index + 1];
      normal += next.search(nonInlineSafe) === 0 ? next : `\\${next}`;
      index += 1;
    }
  }
  return normal;
}

/**
 * Makes emitted JavaScript safe for an HTML raw-text element and proves it unchanged.
 * Rewrites apply only inside tokens where the value is provably preserved; a hazard
 * anywhere else fails the build rather than guessing.
 */
function sanitizeForInline(ts, code, label) {
  const literals = collectLiterals(ts, code, label);
  const edits = [...literals, ...collectComments(ts, code, literals)].flatMap(token => tokenEdits(code, token, label)).sort((a, b) => a.start - b.start);
  let safe = '';
  let cursor = 0;
  for (const edit of edits) {
    safe += code.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  safe += code.slice(cursor);
  const remaining = safe.search(inlineHazards);
  if (remaining !== -1) {
    throw new Error(`${label}: generated code has ${JSON.stringify(safe.slice(remaining, remaining + 8))} outside a literal, at line ${safe.slice(0, remaining).split('\n').length}. Add whitespace or restructure the source.`);
  }
  const unsafe = safe.search(nonInlineSafe);
  if (unsafe !== -1) throw new Error(`${label}: generated code has a character that is unsafe in HTML raw text: U+${safe.charCodeAt(unsafe).toString(16).padStart(4, '0')}`);
  const after = collectLiterals(ts, safe, label);
  if (after.length !== literals.length) throw new Error(`${label}: inline escaping changed the literal count.`);
  literals.forEach((literal, index) => {
    if (literal.kind === 'string' && literal.text !== after[index].text) throw new Error(`${label}: inline escaping changed a string value.`);
    if (literal.kind === 'regex') {
      if (regexNormalForm(literal.text) !== regexNormalForm(after[index].text)) throw new Error(`${label}: inline escaping changed a regular expression.`);
      const end = after[index].text.lastIndexOf('/');
      new RegExp(after[index].text.slice(1, end), after[index].text.slice(end + 1));
    }
  });
  return { code: safe, edits };
}

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reads the first base64-VLQ value of a segment, returning its value and encoded length. */
function decodeVlq(segment) {
  let result = 0;
  let shift = 0;
  for (let index = 0; index < segment.length; index += 1) {
    const digit = base64Alphabet.indexOf(segment[index]);
    if (digit < 0) throw new Error(`Invalid source map segment ${segment}`);
    result += (digit & 31) * 2 ** shift;
    shift += 5;
    if (!(digit & 32)) return { value: result % 2 ? -(result - 1) / 2 : result / 2, length: index + 1 };
  }
  throw new Error(`Invalid source map segment ${segment}`);
}

/** Encodes one signed integer as base64 VLQ. */
function encodeVlq(value) {
  let rest = value < 0 ? -value * 2 + 1 : value * 2;
  let encoded = '';
  do {
    const digit = rest % 32;
    rest = Math.floor(rest / 32);
    encoded += base64Alphabet[rest > 0 ? digit + 32 : digit];
  } while (rest > 0);
  return encoded;
}

/** Column shifts per generated line caused by inline escaping. */
function columnShifts(code, edits) {
  const shifts = new Map();
  let line = 0;
  let lineStart = 0;
  let cursor = 0;
  for (const edit of edits) {
    for (let index = code.indexOf('\n', cursor); index !== -1 && index < edit.start; index = code.indexOf('\n', index + 1)) {
      line += 1;
      lineStart = index + 1;
    }
    cursor = lineStart;
    if (!shifts.has(line)) shifts.set(line, []);
    shifts.get(line).push({ column: edit.start - lineStart, delta: edit.text.length - (edit.end - edit.start) });
  }
  return shifts;
}

/**
 * Rewrites only the generated columns of esbuild's mappings, which are the first field of
 * each segment and relative within a line. Source fields stay byte-for-byte because they
 * are relative across the whole map and do not move.
 */
function shiftMappings(mappings, shifts, prependedLines) {
  const lines = mappings.split(';').map((line, lineIndex) => {
    const shift = shifts.get(lineIndex);
    if (!shift || !line) return line;
    let column = 0;
    let previous = 0;
    return line.split(',').map(segment => {
      const { value, length } = decodeVlq(segment);
      column += value;
      const moved = column + shift.reduce((sum, edit) => edit.column < column ? sum + edit.delta : sum, 0);
      const encoded = encodeVlq(moved - previous) + segment.slice(length);
      previous = moved;
      return encoded;
    }).join(',');
  });
  return ';'.repeat(prependedLines) + lines.join(';');
}

/**
 * Turns one esbuild bundle into inline script text with a composed data: source map.
 * The map is relative to the script text, because Jellyfin runs these scripts by copying
 * that text into a new element. Starting on a new line keeps columns identical if a
 * document parser ever reports positions offset by the template.
 * @param {{ts: object, code: string, map: string, file: string}} input
 */
export function inlineScript({ ts, code, map, file }) {
  const { code: safe, edits } = sanitizeForInline(ts, code, file);
  const raw = JSON.parse(map);
  for (const source of raw.sources) {
    if (!source.startsWith('client/src/')) throw new Error(`${file}: source map names ${source} outside client/src.`);
  }
  const composed = {
    version: 3,
    file,
    sources: raw.sources,
    sourcesContent: raw.sourcesContent,
    names: raw.names,
    mappings: shiftMappings(raw.mappings, columnShifts(code, edits), 1),
  };
  // base64 has no < $ { or - sequences, so the embedded TypeScript cannot reach the parser.
  const payload = Buffer.from(JSON.stringify(composed), 'utf8').toString('base64');
  return `\n${safe}//# sourceMappingURL=data:application/json;charset=utf-8;base64,${payload}\n`;
}

/** Proves the finished page holds exactly the generated scripts, parsed both ways. */
function validateOutput(JSDOM, page, html, texts) {
  const label = page.output;
  for (const sequence of ['<!--<script', '</script>-->', '${']) {
    if (html.includes(sequence)) throw new Error(`${label}: generated page contains ${sequence}, which Jellyfin's page loader rewrites.`);
  }
  parseBothWays(JSDOM, html, (dom, wrapper) => {
    for (const parsed of [dom.window.document, wrapper]) {
      const found = [];
      forEachNode(parsed, (node, inTemplate) => {
        rejectActiveMarkup(node, label, true);
        if (node.nodeType !== 1 || node.localName !== 'script') return;
        if (inTemplate || node.namespaceURI !== HTML_NAMESPACE || node.attributes.length) {
          throw new Error(`${label}: generated script is not a plain executable HTML script element.`);
        }
        found.push(node.textContent);
      });
      if (found.length !== texts.length || found.some((text, index) => text !== texts[index])) {
        throw new Error(`${label}: parsed scripts do not match the generated scripts (${found.length} of ${texts.length}).`);
      }
    }
  });
}

/**
 * Replaces each marker with its script and returns the page plus its provenance.
 * @param {object} page A page from discoverHtmlPages.
 * @param {{name: string, source: string, text: string, inputs: Record<string, string>}[]} scripts In marker order.
 */
export function renderPage(page, scripts) {
  let html = '';
  let cursor = 0;
  page.markers.forEach((marker, index) => {
    html += `${page.text.slice(cursor, marker.start)}<script>${scripts[index].text}</script>`;
    cursor = marker.end;
  });
  html += page.text.slice(cursor);
  validateOutput(loadJsdom(), page, html, scripts.map(script => script.text));
  const bytes = Buffer.from(html, 'utf8');
  return {
    bytes,
    ledger: {
      output: page.output,
      manifest: page.manifest,
      template: page.template,
      templateSha256: sha256(page.templateBytes),
      outputSha256: sha256(bytes),
      scripts: scripts.map((script, scriptIndex) => ({
        name: script.name,
        scriptIndex,
        source: script.source,
        sha256: sha256(script.text),
        inputs: script.inputs,
      })),
    },
  };
}

export { sha256 as htmlHash };
