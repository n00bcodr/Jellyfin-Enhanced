// Performance rules R3, R5 and R6, adapted from Jellyfin Canopy's scripts/check-performance-rules.js and
// CONTRIBUTING.md "Performance rules" (GPL-3.0). Canopy checks R5 in two named files only; this scan covers every
// client/src file and records today's sites in a baseline instead.
//
//   R3-body-observer  `.observe(document.body | document.documentElement | document, { subtree: true, … })`:
//                     a body-wide MutationObserver. Use the shared observer (JE.core.dom.onBodyMutation) or a
//                     page-scoped one. (Canopy also bans attribute observation body-wide: same rule here.)
//   R5-interval-dom   a setInterval whose callback (or a local function it calls) queries the DOM
//                     (querySelector*, getElementById, getElementsBy*, closest, contains, isConnected): detection
//                     by polling instead of navigation events or the shared observer.
//   R6-remote-asset   a runtime load from an absolute http(s) URL: fetch/import()/Worker/EventSource/WebSocket/
//                     sendBeacon/XMLHttpRequest.open with a literal remote URL, a <script>/<link> element whose
//                     src/href is set to one, or CSS/markup text with `@import`/`url(http…)`/`<script src="http…">`/
//                     `<link href="http…">`. Links the user clicks (<a href>) and content images are not loads.
import {
  calleeName, findProperty, functionOf, lastName, lineOf, receiverOf, resolve, scopeName, snippet, ts, unwrap, walk,
} from './lib.mjs';

const violation = (rule, node) => ({
  rule, file: node.getSourceFile().fileName, key: `${rule} ${scopeName(node)}`, line: lineOf(node), text: snippet(node, 90),
});

// ---------------------------------------------------------------------------------------------------------
// R3

function isDocumentWide(target) {
  const e = unwrap(target);
  if (!e) return false;
  if (lastName(e) === 'document') return true;
  return ts.isPropertyAccessExpression(e) && ['body', 'documentElement'].includes(e.name.text) && lastName(e.expression) === 'document';
}

function isTrue(property) {
  return property && ts.isPropertyAssignment(property) && property.initializer.kind === ts.SyntaxKind.TrueKeyword;
}

export function isBodyWideObserve(node) {
  if (!ts.isCallExpression(node) || calleeName(node) !== 'observe' || node.arguments.length < 2) return false;
  const options = unwrap(node.arguments[1]);
  return isDocumentWide(node.arguments[0]) && ts.isObjectLiteralExpression(options) && isTrue(findProperty(options, 'subtree'));
}

// ---------------------------------------------------------------------------------------------------------
// R5

const DOM_QUERIES = new Set(['querySelector', 'querySelectorAll', 'getElementById', 'getElementsByClassName',
  'getElementsByTagName', 'getElementsByName', 'closest', 'contains']);

function queriesDom(fn, depth = 0) {
  if (!fn || depth > 2) return false;
  let found = false;
  walk(fn, node => {
    if (found) return false;
    if (ts.isCallExpression(node)) {
      if (DOM_QUERIES.has(calleeName(node) ?? '')) found = true;
      else if (ts.isIdentifier(unwrap(node.expression))) {
        const inner = functionOf(resolve(unwrap(node.expression)));
        if (inner && inner !== fn && queriesDom(inner, depth + 1)) found = true;
      }
    } else if (ts.isPropertyAccessExpression(node) && node.name.text === 'isConnected') found = true;
    return undefined;
  });
  return found;
}

function intervalCallback(call) {
  const cb = call.arguments[0] && unwrap(call.arguments[0]);
  if (!cb) return null;
  if (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) return cb;
  if (ts.isIdentifier(cb)) return functionOf(resolve(cb));
  return null;
}

export const isDomPollingInterval = node => ts.isCallExpression(node) && calleeName(node) === 'setInterval' && queriesDom(intervalCallback(node));

// ---------------------------------------------------------------------------------------------------------
// R6

const REMOTE = /^\s*(https?:)?\/\/[^/\s]/i;
const REMOTE_TEXT = /@import\s+(url\(\s*)?["']?\s*(https?:)?\/\/|url\(\s*["']?\s*https?:\/\/|<script\b[^>]*\bsrc\s*=\s*["']?\s*(https?:)?\/\/|<link\b[^>]*\bhref\s*=\s*["']?\s*(https?:)?\/\//i;
const LOAD_CALLS = new Set(['fetch', 'sendBeacon', 'importScripts']);
const LOAD_CONSTRUCTORS = new Set(['Worker', 'SharedWorker', 'EventSource', 'WebSocket']);

/** The literal head of a URL expression (a string, a template head, the left of a `+`, or a const's initializer). */
function literalHead(expression, depth = 0) {
  const e = unwrap(expression);
  if (!e || depth > 3) return null;
  if (ts.isStringLiteralLike(e)) return e.text;
  if (ts.isTemplateExpression(e)) return e.head.text;
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return literalHead(e.left, depth + 1);
  if (ts.isIdentifier(e)) {
    const binding = resolve(e);
    if (binding && ts.isVariableDeclaration(binding.decl) && binding.decl.initializer) return literalHead(binding.decl.initializer, depth + 1);
  }
  return null;
}

const isRemote = expression => REMOTE.test(literalHead(expression) ?? '');

function createsLoaderElement(target) {
  const e = unwrap(target);
  const init = ts.isIdentifier(e) ? (() => { const b = resolve(e); return b && ts.isVariableDeclaration(b.decl) ? b.decl.initializer : null; })() : e;
  let found = false;
  if (init) walk(init, n => {
    if (ts.isCallExpression(n) && calleeName(n) === 'createElement' && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])
      && ['script', 'link'].includes(n.arguments[0].text.toLowerCase())) found = true;
  });
  return found;
}

export function isRemoteLoad(node) {
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return isRemote(node.arguments[0]);
    if (name && LOAD_CALLS.has(name)) return isRemote(node.arguments[0]);
    if (name === 'open' && node.arguments.length >= 2 && ts.isStringLiteralLike(unwrap(node.arguments[0]))) return isRemote(node.arguments[1]);
    if (name === 'setAttribute' && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
      && ['src', 'href'].includes(node.arguments[0].text) && receiverOf(node) && createsLoaderElement(receiverOf(node))) return isRemote(node.arguments[1]);
    return false;
  }
  if (ts.isNewExpression(node)) return LOAD_CONSTRUCTORS.has(lastName(node.expression) ?? '') && Boolean(node.arguments?.[0]) && isRemote(node.arguments[0]);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const left = unwrap(node.left);
    return ts.isPropertyAccessExpression(left) && ['src', 'href'].includes(left.name.text) && createsLoaderElement(left.expression) && isRemote(node.right);
  }
  if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return REMOTE_TEXT.test(node.text);
  return false;
}

export function scanPerformance(project) {
  const out = [];
  for (const sf of project.files) {
    walk(sf, node => {
      if (isBodyWideObserve(node)) out.push(violation('R3-body-observer', node));
      if (isDomPollingInterval(node)) out.push(violation('R5-interval-dom', node));
      if (isRemoteLoad(node)) out.push(violation('R6-remote-asset', node));
    });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
