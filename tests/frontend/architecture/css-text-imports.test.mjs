// frontend.md §3 D1/D2: static stylesheets live in client/src/**/*.css and are imported as text (esbuild's
// `text` loader, scripts/client-build.mjs). Every .css file must reach a shipped output, and that output must
// carry the file's text byte for byte as one string literal, so the stylesheet a page injects is exactly the file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { listSources, repoRoot, ts } from './scan.mjs';

const plugin = 'Jellyfin.Plugin.JellyfinEnhanced';

/** {css file: [output js]} from each built output's source map. */
function cssOutputs() {
  const ledger = JSON.parse(readFileSync(join(repoRoot, 'client/generated-manifest.json'), 'utf8'));
  const found = {};
  for (const { output } of ledger.entries) {
    const map = JSON.parse(readFileSync(join(repoRoot, plugin, `${output}.map`), 'utf8'));
    for (const source of map.sources) {
      const file = posix.normalize(posix.join(posix.dirname(`${plugin}/${output}`), source));
      if (file.endsWith('.css')) (found[file] ??= []).push(output);
    }
  }
  return found;
}

/** Every string and no-substitution template literal value in a built output. */
function literals(output) {
  const text = readFileSync(join(repoRoot, plugin, output), 'utf8');
  const sf = ts.createSourceFile(output, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const values = new Set();
  (function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) values.add(node.text);
    ts.forEachChild(node, visit);
  })(sf);
  return values;
}

test('every client/src .css file is shipped as its exact text', () => {
  const css = listSources(['.css']);
  assert.ok(css.length > 0, 'no .css sources found');
  const outputs = cssOutputs();
  assert.deepEqual(Object.keys(outputs).sort(), css, 'every .css source is bundled by some output, and only existing files are');
  for (const file of css) {
    const text = readFileSync(join(repoRoot, file), 'utf8');
    const selector = text.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^\s{}][^{}]*?(?=\s*\{)/)?.[0];
    assert.ok(selector, `${file}: no selector`);
    for (const output of outputs[file]) {
      const built = readFileSync(join(repoRoot, plugin, output), 'utf8');
      assert.ok(literals(output).has(text), `${output} carries ${file} byte for byte`);
      assert.ok(built.includes(selector) || built.includes(JSON.stringify(selector).slice(1, -1)), `${output} contains ${file}'s first selector ${selector}`);
    }
  }
});
