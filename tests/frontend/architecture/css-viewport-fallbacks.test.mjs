// Browsers before the small/large/dynamic viewport units (Chrome 108, Firefox 101, Safari 15.4) drop a declaration
// that uses `dvh`. Every such declaration in a shipped stylesheet follows one of the same property in `vh`, which
// those browsers keep and newer ones override, so a layout sized by the viewport keeps a size everywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, ts } from './scan.mjs';

const plugin = 'Jellyfin.Plugin.JellyfinEnhanced';

/** The text of every string and template literal in a built output; a substitution reads as `0`. */
function stylesheetTexts(output) {
  const text = readFileSync(join(repoRoot, output), 'utf8');
  const sf = ts.createSourceFile(output, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const values = [];
  (function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) values.push(node.text);
    else if (ts.isTemplateExpression(node)) values.push(node.head.text + node.templateSpans.map(span => '0' + span.literal.text).join(''));
    ts.forEachChild(node, visit);
  })(sf);
  return values;
}

/** Each `dvh` declaration whose previous declaration in its rule does not set the same property. */
function missingFallbacks(css) {
  const missing = [];
  for (const block of css.split(/[{}]/)) {
    const declarations = block.split(';').map(d => d.replace(/\/\*[\s\S]*?\*\//g, '').trim()).filter(Boolean);
    declarations.forEach((declaration, i) => {
      if (!/\d(?:\.\d+)?dvh\b/.test(declaration)) return;
      const property = declaration.split(':')[0].trim();
      const before = declarations[i - 1] ?? '';
      const fallback = before.split(':')[0].trim() === property && !/dvh\b/.test(before) && /\dvh\b/.test(before);
      if (!fallback) missing.push(declaration.replace(/\s+/g, ' '));
    });
  }
  return missing;
}

test('every dvh declaration in a shipped stylesheet follows a vh one for the same property', () => {
  const ledger = JSON.parse(readFileSync(join(repoRoot, 'client/generated-manifest.json'), 'utf8'));
  const outputs = Object.keys(ledger.outputs).filter(o => o.startsWith(`${plugin}/js/`) && o.endsWith('.js'));
  assert.ok(outputs.length > 0, 'no built outputs found');
  const missing = [];
  let checked = 0;
  for (const output of outputs) {
    for (const css of stylesheetTexts(output)) {
      if (!/\d(?:\.\d+)?dvh\b/.test(css)) continue;
      checked++;
      for (const declaration of missingFallbacks(css)) missing.push(`${output.slice(plugin.length + 1)}: ${declaration}`);
    }
  }
  assert.ok(checked > 0, 'no stylesheet uses dvh: the scan found nothing to check');
  assert.deepEqual(missing, []);
});
