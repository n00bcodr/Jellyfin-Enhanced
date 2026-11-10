// R9 (error-as-empty guard), adapted from Jellyfin Canopy's src/test/error-as-empty-guard.test.ts and rule R9
// "Fail open, late beats never" (GPL-3.0). Canopy keeps a registry of fetchers; this is an automatic scan with a
// baseline instead, because JE has no registry yet.
//
// A failure branch is a `catch (e) { … }` around asynchronous work (an `await`, a fetch/request/ajax call or a
// `.then`), a `.catch(cb)` callback, or the `if (!res.ok)` branch of a fetch. One without an error channel
// (a `throw`, a call or assignment whose name says error/fail/toast/retry/reject, an `{ ok: false }` / `error`
// property, or an error/failed/unavailable translation key) that:
//   R9-fail-empty           returns, resolves or assigns an empty answer: [], {}, new Map/Set, or an object
//                           literal whose list properties are [];
//   R9-fail-cached          stores an empty answer or null/false in a cache (`m.set(k, …)`, `cache[k] = …`,
//                           `cache.x = …`, `localStorage.setItem`), so the failure is remembered as an answer;
//   R9-fail-renders-empty   renders an empty state: assigns markup/text holding a "no results"/"empty" literal or
//                           key, or calls a render function with [].
// `console.*` logging is not an error channel: the user still sees the empty state.
import { calleeName, lastName, lineOf, propertyName, receiverOf, scopeName, snippet, ts, unwrap, walk } from './lib.mjs';

const ERROR_NAME = /error|fail|toast|retry|reject|unavailable|offline|stale/i;
const ERROR_TEXT = /error|fail|unavailable|offline|could ?n.?t|could_not|unable|retry|try again/i;
const EMPTY_TEXT = /\bno[ _-]?(results?|items?|data|requests?|matches|reviews?|content|entries|downloads|issues|events|media|users?|sessions?|streams?)\b|^no_|_no_|nothing (here|to|found)|empty|not[ _]found|none found|_none\b/i;
const ASYNC_CALL = /fetch|request|ajax|getjson|^get$|^post$|api/i;

/** [], {}, new Map(), new Set(), or { items: [], total: 0 } (an object whose list properties are all []). */
export function isEmptyAnswer(expression) {
  const e = unwrap(expression);
  if (!e) return false;
  if (ts.isArrayLiteralExpression(e)) return e.elements.length === 0;
  if (ts.isNewExpression(e)) return ['Map', 'Set'].includes(lastName(e.expression) ?? '') && !(e.arguments?.length);
  if (ts.isObjectLiteralExpression(e)) {
    if (!e.properties.length) return true;
    const values = e.properties.map(p => ts.isPropertyAssignment(p) ? unwrap(p.initializer) : null);
    if (e.properties.some(p => ERROR_NAME.test(propertyName(p) ?? '') || propertyName(p) === 'ok')) return false;
    return values.some(v => v && ts.isArrayLiteralExpression(v) && !v.elements.length)
      && values.every(v => v && ((ts.isArrayLiteralExpression(v) && !v.elements.length) || ts.isNumericLiteral(v)
        || ts.isStringLiteralLike(v) || v.kind === ts.SyntaxKind.NullKeyword || v.kind === ts.SyntaxKind.FalseKeyword
        || v.kind === ts.SyntaxKind.TrueKeyword));
  }
  return false;
}

const isNullish = e => e && (e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.FalseKeyword
  || (ts.isIdentifier(e) && e.text === 'undefined'));

/** Does the failure branch route the failure into an error channel? */
export function hasErrorChannel(region) {
  let found = false;
  walk(region, node => {
    if (found) return false;
    if (ts.isThrowStatement(node)) found = true;
    else if (ts.isCallExpression(node)) {
      const receiver = receiverOf(node);
      if (!(receiver && ts.isIdentifier(receiver) && receiver.text === 'console') && ERROR_NAME.test(calleeName(node) ?? '')) found = true;
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ERROR_NAME.test(lastName(node.left) ?? '')) found = true;
    else if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))) {
      const name = propertyName(node) ?? '';
      if (ERROR_NAME.test(name) || (name === 'ok' && ts.isPropertyAssignment(node) && node.initializer.kind === ts.SyntaxKind.FalseKeyword)) found = true;
    } else if (ts.isStringLiteralLike(node) && ERROR_TEXT.test(node.text)
      && !(ts.isCallExpression(node.parent) && lastName(receiverOf(node.parent) ?? node.parent) === 'console')) found = true;
    return undefined;
  }, { ownOnly: true });
  return found;
}

function containsAsyncWork(block) {
  let found = false;
  walk(block, node => {
    if (found) return false;
    if (ts.isAwaitExpression(node)) found = true;
    else if (ts.isCallExpression(node) && (ASYNC_CALL.test(calleeName(node) ?? '') || calleeName(node) === 'then')) found = true;
    return undefined;
  }, { ownOnly: true });
  return found;
}

/** `!res.ok`, `res.ok === false`, `!response.ok || …`. */
function isNotOk(condition) {
  const c = unwrap(condition);
  if (ts.isPrefixUnaryExpression(c) && c.operator === ts.SyntaxKind.ExclamationToken) return lastName(c.operand) === 'ok';
  if (ts.isBinaryExpression(c)) {
    if (c.operatorToken.kind === ts.SyntaxKind.BarBarToken) return isNotOk(c.left) || isNotOk(c.right);
    if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(c.operatorToken.kind)) {
      return lastName(c.left) === 'ok' && c.right.kind === ts.SyntaxKind.FalseKeyword;
    }
  }
  return false;
}

/** Failure branches in a file: { node (for the scope name), region (the code that runs on failure) }. */
export function failureBranches(sf) {
  const out = [];
  walk(sf, node => {
    if (ts.isTryStatement(node) && node.catchClause && containsAsyncWork(node.tryBlock)) {
      out.push({ node: node.catchClause, region: node.catchClause.block });
    } else if (ts.isCallExpression(node) && calleeName(node) === 'catch' && receiverOf(node) && node.arguments[0]) {
      const cb = unwrap(node.arguments[0]);
      if (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) out.push({ node, region: cb.body, callback: cb });
    } else if (ts.isIfStatement(node) && isNotOk(node.expression)) {
      out.push({ node, region: node.thenStatement });
    }
  });
  return out;
}

const CACHE_NAME = /cache|memo|store|seen|loaded|fetched|known|results?$/i;

/** The R9 findings of one failure branch (each rule at most once per branch). */
export function classifyBranch({ region, callback }) {
  if (hasErrorChannel(region)) return [];
  const rules = new Set();
  const returnsEmpty = e => e && isEmptyAnswer(e);
  if (callback && !ts.isBlock(region) && returnsEmpty(region)) rules.add('R9-fail-empty');
  walk(region, node => {
    if (ts.isReturnStatement(node) && returnsEmpty(node.expression)) rules.add('R9-fail-empty');
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const args = node.arguments;
      if (name === 'resolve' && returnsEmpty(args[0])) rules.add('R9-fail-empty');
      if (name === 'set' && args.length >= 2 && (returnsEmpty(args[1]) || isNullish(unwrap(args[1])))) rules.add('R9-fail-cached');
      if (name === 'setItem' && ['localStorage', 'sessionStorage'].includes(lastName(receiverOf(node) ?? node) ?? '')) rules.add('R9-fail-cached');
      if (/render|show|display|update|fill|populate|paint|draw/i.test(name ?? '') && args.some(a => returnsEmpty(a))) rules.add('R9-fail-renders-empty');
      if (/empty|nothing|noresults/i.test(name ?? '')) rules.add('R9-fail-renders-empty');
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = unwrap(node.left);
      const name = lastName(target) ?? '';
      const right = unwrap(node.right);
      const cacheTarget = (ts.isElementAccessExpression(target) || ts.isPropertyAccessExpression(target))
        && CACHE_NAME.test(lastName(target.expression) ?? '');
      if (cacheTarget && (returnsEmpty(right) || isNullish(right))) rules.add('R9-fail-cached');
      else if (returnsEmpty(right)) rules.add('R9-fail-empty');
      if (['innerHTML', 'textContent', 'innerText'].includes(name)) {
        let empty = false;
        walk(right, n => { if ((ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && EMPTY_TEXT.test(n.text)) empty = true; });
        if (empty) rules.add('R9-fail-renders-empty');
      }
    }
    return undefined;
  }, { ownOnly: !callback || ts.isBlock(region) ? true : false });
  return [...rules];
}

export function scanErrorEmpty(project) {
  const out = [];
  for (const sf of project.files) {
    for (const branch of failureBranches(sf)) {
      for (const rule of classifyBranch(branch)) {
        out.push({ rule, file: sf.fileName, key: `${rule} ${scopeName(branch.node)}`, line: lineOf(branch.node), text: snippet(branch.node, 90) });
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
