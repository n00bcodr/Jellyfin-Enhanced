// X1 (escape guard), adapted from Jellyfin Canopy's src/test/escape-guard.test.ts (GPL-3.0).
//
// Every value that reaches HTML must be recognisably safe (taint.mjs) or pass through one of JE's escapers.
// HTML is reached through:
//   - a template literal whose literal text holds markup (`<tag`), and a `+` chain with a markup literal;
//   - the sinks `x.innerHTML =` / `+=`, `x.outerHTML =`, `insertAdjacentHTML(pos, html)`,
//     `document.write(…)`, `createContextualFragment(html)`, `setHTMLUnsafe(html)`,
//     `parseFromString(html, …)` and `JE.toast(html)` (core/ui/runtime.ts renders it with innerHTML).
// A markup template or chain reached from a sink is checked once, at its own position.
import { createChecker } from './taint.mjs';
import { calleeName, lastName, lineOf, receiverOf, scopeName, snippet, ts, unwrap, walk } from './lib.mjs';

/**
 * JE's HTML escapers, trusted by name: core/ui/runtime.ts escapeHtml (JE.escapeHtml, and the local aliases
 * escapeWith(JE)/escaper(JE) return), admin/config/engine/render.ts esc, media-tags/admin/format.ts escapeText,
 * admin/config/sections/pages.ts escAttr, and the URL encoders (their output holds no `<`, `>` or `"`).
 */
export const HTML_ESCAPERS = new Set(['escapeHtml', 'escHtml', 'esc', 'escAttr', 'escapeText', 'escapeAttr',
  'encodeURIComponent', 'encodeURI']);
/** Translation lookups. Locale text is plugin-owned; the params are NOT escaped, so every argument must be safe. */
export const TRANSLATIONS = new Set(['t', 'tx', 'tt', 'T', 'tWithFallback', 'translate', 'translatedOr']);

/**
 * Trusted producers (Canopy's TRUSTED_PRODUCER_CALLS / TRUSTED_TABLE_NAMES, checked against JE's code):
 *  - icon (JE.icon, features/shared/icons.ts): a lookup into the plugin's frozen EMOJI/LUCIDE/MUI tables;
 *  - getThemeVariables (JE.themer, features/shared/themer.ts): colours and blur from the plugin's theme tables
 *    and the root element's computed style, which a theme's hosted stylesheet sets: themer.ts passes only plain
 *    CSS values (no quote, `<`, `&` or `;`). The logo is a URL and is escaped where it is used. Never item or user text.
 */
export const PRODUCERS = new Set(['icon', 'getThemeVariables']);
/** Plugin-owned markup tables: features/shared/icons.ts `icons` and the seerr `icons()` (internals.icons ?? ICONS). */
export const TABLES = new Set(['icons']);

const MARKUP = /<\/?[a-zA-Z!]/;
export const hasMarkup = text => MARKUP.test(text);

export function templateHasMarkup(node) {
  return ts.isTemplateExpression(node)
    && (hasMarkup(node.head.text) || node.templateSpans.some(s => hasMarkup(s.literal.text)));
}

const isPlus = node => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;

/** The operands of a `+` chain (through parentheses). */
export function plusOperands(node) {
  const e = unwrap(node);
  return isPlus(e) ? [...plusOperands(e.left), ...plusOperands(e.right)] : [e];
}

export function concatHasMarkup(node) {
  return isPlus(node) && plusOperands(node).some(o => (ts.isStringLiteralLike(o) && hasMarkup(o.text))
    || (ts.isTemplateExpression(o) && hasMarkup(o.head.text)));
}

/** The top of a `+` chain: its parent (through parentheses) is not another `+`. */
function isChainRoot(node) {
  let p = node.parent;
  while (p && ts.isParenthesizedExpression(p)) p = p.parent;
  return !isPlus(p);
}

/** Expressions that are checked at their own position (markup builds), hence treated as safe where they flow. */
export const isMarkupBuild = node => templateHasMarkup(node) || (concatHasMarkup(node) && isChainRoot(node));

const SINK_PROPERTIES = new Set(['innerHTML', 'outerHTML']);

/** The HTML-valued expressions a node feeds into a sink, or []. */
export function sinkArguments(node) {
  if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) && SINK_PROPERTIES.has(lastName(node.left) ?? '')) {
    return [node.right];
  }
  if (!ts.isCallExpression(node)) return [];
  const name = calleeName(node);
  const receiver = receiverOf(node);
  if (name === 'insertAdjacentHTML') return node.arguments.slice(1, 2);
  if ((name === 'write' || name === 'writeln') && receiver && lastName(receiver) === 'document') return [...node.arguments];
  if (name === 'createContextualFragment' || name === 'setHTMLUnsafe' || name === 'parseFromString' || name === 'toast') {
    return node.arguments.slice(0, 1);
  }
  return [];
}

/** Everything X1 checks in one file: [expression, …] whose leaves must be safe. */
function checkedExpressions(sf) {
  const out = [];
  walk(sf, node => {
    if (templateHasMarkup(node)) out.push(...node.templateSpans.map(s => s.expression));
    else if (concatHasMarkup(node) && isChainRoot(node)) out.push(...plusOperands(node));
    out.push(...sinkArguments(node));
  });
  return out;
}

export function createEscapeChecker(project) {
  return createChecker(project, {
    safeCalls: (call, name) => HTML_ESCAPERS.has(name) || (name === 'escape' && !receiverOf(call)),
    validators: name => /^isSafe[A-Z]/.test(name),
    translations: TRANSLATIONS,
    producers: PRODUCERS,
    tables: TABLES,
    checkedElsewhere: node => isMarkupBuild(node),
  });
}

/** @returns {{ rule: string, file: string, key: string, line: number, text: string }[]} */
export function scanEscape(project) {
  const checker = createEscapeChecker(project);
  const seen = new Set();
  const out = [];
  for (const sf of project.files) {
    for (const expression of checkedExpressions(sf)) {
      // A markup build at the top of a sink is itself checked at its own position.
      const top = unwrap(expression);
      const found = isMarkupBuild(top) ? [] : checker.leaves(expression);
      for (const leaf of found) {
        if (seen.has(leaf)) continue;
        seen.add(leaf);
        out.push({ rule: 'X1', file: leaf.getSourceFile().fileName, key: `X1 ${scopeName(leaf)}`, line: lineOf(leaf), text: snippet(leaf) });
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
