// X2 (CSS-injection guard), adapted from Jellyfin Canopy's src/test/css-injection-guard.test.ts (GPL-3.0).
//
// escapeHtml does not neutralise a CSS payload: `red;background:url(https://x/beacon)` in a style attribute or a
// stylesheet rule adds a declaration. Every value interpolated into CSS text must be recognisably safe
// (taint.mjs: numbers, literals, constants, local values that resolve to those), validated in a
// `isCssColor(v) ? v : …` ternary, or pass through CSS.escape / encodeURIComponent. CSS text is reached through:
//   - `JE.helpers.addCSS(id, css)` / `injectCss(id, css)` (core/ui/runtime.ts: a <style> element's textContent);
//   - `x.style.cssText =` / `+=`, `x.setAttribute('style', v)`, `sheet.insertRule(rule)`, `sheet.replaceSync(css)`;
//   - `textContent` / `innerHTML` / `innerText` of a <style> element created in the same function or file;
//   - a `style="…"` attribute inside an HTML template literal or `+` chain.
// CSSOM per-property setters (`el.style.color = v`, `style.setProperty(n, v)`) parse one value and cannot add
// a declaration, so they are not sinks.
import { createChecker } from './taint.mjs';
import { plusOperands } from './escape.mjs';
import {
  calleeName, lastName, lineOf, receiverOf, resolve, scopeName, snippet, ts, unwrap, walk,
} from './lib.mjs';

export const CSS_SAFE_CALLS = new Set(['encodeURIComponent', 'cssColorOr']);
export const CSS_VALIDATORS = name => name === 'isCssColor' || /^isSafe[A-Z]/.test(name) || /^isValid\w*Colou?r$/.test(name);

const STYLE_ATTRIBUTE_OPEN = /\bstyle\s*=\s*(["'])(?:(?!\1)[^])*$/i;

function createsStyleElement(node) {
  let found = false;
  walk(node, n => {
    if (found) return false;
    if (ts.isCallExpression(n) && calleeName(n) === 'createElement' && n.arguments[0]
      && ts.isStringLiteralLike(n.arguments[0]) && n.arguments[0].text.toLowerCase() === 'style') found = true;
    return undefined;
  });
  return found;
}

/** Is `target` (the object of `x.textContent = …`) a <style> element made by createElement('style')? */
function isStyleElement(target) {
  const e = unwrap(target);
  if (createsStyleElement(e) && ts.isCallExpression(e)) return true;
  const id = ts.isIdentifier(e) ? e : null;
  if (!id) return false;
  const binding = resolve(id);
  return Boolean(binding && ts.isVariableDeclaration(binding.decl) && binding.decl.initializer && createsStyleElement(binding.decl.initializer));
}

/** The CSS-valued expressions a node feeds into a CSS sink, or []. */
export function cssSinkArguments(node) {
  if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)) {
    const name = lastName(node.left);
    if (name === 'cssText') return [node.right];
    if ((name === 'textContent' || name === 'innerHTML' || name === 'innerText') && ts.isPropertyAccessExpression(unwrap(node.left))
      && isStyleElement(unwrap(node.left).expression)) return [node.right];
    return [];
  }
  if (!ts.isCallExpression(node)) return [];
  const name = calleeName(node);
  const args = node.arguments;
  if ((name === 'addCSS' || name === 'injectCss') && args.length >= 2) return [args[1]];
  if (name === 'setAttribute' && args[0] && ts.isStringLiteralLike(args[0]) && args[0].text.toLowerCase() === 'style') return args.slice(1, 2);
  if (name === 'insertRule' || name === 'replaceSync') return args.slice(0, 1);
  if (name === 'assign' && receiverOf(node)?.getText() === 'Object' && args[0] && createsStyleElement(args[0])) {
    const props = args.slice(1).flatMap(a => ts.isObjectLiteralExpression(unwrap(a)) ? unwrap(a).properties : []);
    return props.filter(p => ts.isPropertyAssignment(p) && ['textContent', 'innerHTML', 'innerText'].includes(p.name.getText())).map(p => p.initializer);
  }
  return [];
}

/** Interpolations that sit inside a `style="…"` attribute of an HTML template or `+` chain. */
export function styleAttributeValues(node) {
  const out = [];
  if (ts.isTemplateExpression(node)) {
    let before = node.head.text;
    for (const span of node.templateSpans) {
      if (STYLE_ATTRIBUTE_OPEN.test(before)) out.push(span.expression);
      before += `0${span.literal.text}`;
    }
  } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
    && !(ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
    let before = '';
    for (const operand of plusOperands(node)) {
      if (ts.isStringLiteralLike(operand)) { before += operand.text; continue; }
      if (ts.isTemplateExpression(operand)) { before += operand.head.text; continue; }   // its own spans are checked as a template
      if (STYLE_ATTRIBUTE_OPEN.test(before)) out.push(operand);
      before += '0';
    }
  }
  return out;
}

export function createCssChecker(project) {
  return createChecker(project, {
    safeCalls: (call, name) => CSS_SAFE_CALLS.has(name) || (name === 'escape' && receiverOf(call)?.getText() === 'CSS'),
    validators: CSS_VALIDATORS,
    translations: new Set(),
    producers: new Set(['getThemeVariables']),
    tables: new Set(),
  });
}

export function scanCss(project) {
  const checker = createCssChecker(project);
  const seen = new Set();
  const out = [];
  for (const sf of project.files) {
    const expressions = [];
    walk(sf, node => { expressions.push(...cssSinkArguments(node), ...styleAttributeValues(node)); });
    for (const expression of expressions) {
      for (const leaf of checker.leaves(expression)) {
        if (seen.has(leaf)) continue;
        seen.add(leaf);
        out.push({ rule: 'X2', file: leaf.getSourceFile().fileName, key: `X2 ${scopeName(leaf)}`, line: lineOf(leaf), text: snippet(leaf) });
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
