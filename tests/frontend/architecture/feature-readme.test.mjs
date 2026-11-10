// frontend.md §5.4: every client/src/features/<f>/ folder has a README.md whose "Entry points → shipped files"
// table lists exactly the client/entries outputs whose source lies in that folder (cross-checked against
// client/generated-manifest.json `entries`, with the load position in js/component-scripts.json), and names the
// generated sources it holds. Its public-api.ts holds types only (frontend.md §2.3), so another feature can
// `import type` from it without copying runtime code or module state into its own bundle (§2.2).
// The feature list and each README's "Backend counterpart" come from docs/feature-map.json (PLAN.md step 12);
// feature-map.test.mjs holds that list equal to the folders under client/src/features.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { featureMapPath, generatedSourceFiles, mappedFeatures, parse, repoRoot, srcRoot, ts } from './scan.mjs';

const featuresRoot = `${srcRoot}/features`;
const rows = new Map(mappedFeatures().map(row => [row.name, row]));
const features = [...rows.keys()].sort();
const manifest = JSON.parse(readFileSync(join(repoRoot, 'client/generated-manifest.json'), 'utf8'));
const scripts = JSON.parse(readFileSync(join(repoRoot, 'Jellyfin.Plugin.JellyfinEnhanced/js/component-scripts.json'), 'utf8'))
  .filter(path => typeof path === 'string' && !path.startsWith('//'));
const generated = generatedSourceFiles().flatMap(g => g.files);
const read = path => readFileSync(join(repoRoot, path), 'utf8');

/** The body of a `## <heading…>` section (up to the next `## `), or null. */
function section(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex(line => line.startsWith(`## ${heading}`));
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

test('there are feature folders to check', () => {
  assert.ok(features.length >= 15, `expected the 15 canonical features, found ${features.join(', ')}`);
});

for (const feature of features) {
  const folder = `${featuresRoot}/${feature}`;
  const readmePath = `${folder}/README.md`;

  test(`${feature}: README.md lists its entry outputs and generated files`, () => {
    assert.ok(existsSync(join(repoRoot, readmePath)), `${readmePath} is missing (frontend.md §5 template)`);
    const readme = read(readmePath);
    assert.match(readme, new RegExp(`^# ${feature}\\n`), `${readmePath} must start with "# ${feature}"`);

    const { backend, backendServedBy } = rows.get(feature);
    const counterpart = /^.*Backend counterpart: (.*)$/m.exec(readme)?.[1];
    assert.ok(counterpart, `${readmePath} has no "Backend counterpart:" line (frontend.md §5 template)`);
    if (backend) {
      assert.ok(counterpart.startsWith(`\`Features/${backend}/\``),
        `${readmePath}: the backend counterpart is \`Features/${backend}/\` (${featureMapPath}), not: ${counterpart}`);
    } else {
      assert.ok(counterpart.startsWith('none'), `${readmePath}: ${feature} has no backend folder (${featureMapPath}), so the counterpart is "none …"`);
      if (backendServedBy) assert.ok(counterpart.includes(backendServedBy), `${readmePath}: name ${backendServedBy}, which serves ${feature} (${featureMapPath})`);
    }

    const entries = section(readme, 'Entry points');
    assert.notEqual(entries, null, `${readmePath} has no "## Entry points → shipped files" section`);
    const listed = [...entries.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|\s*$/gm)]
      .map(([, source, output, position]) => `${source} → ${output} @ ${position}`).sort();
    const expected = manifest.entries.filter(entry => entry.source.startsWith(`${folder}/`)).map(entry => {
      const at = scripts.indexOf(entry.output.replace(/^js\//, ''));
      return `${entry.source.slice(folder.length + 1)} → ${entry.output} @ ${at < 0 ? '–' : at + 1}`;
    }).sort();
    assert.deepEqual(listed, expected,
      `${readmePath}: the entry table must list exactly this folder's outputs from client/generated-manifest.json `
      + '(source relative to the folder, output, 1-based load position in js/component-scripts.json or –)');

    const gen = section(readme, 'Generated files');
    assert.notEqual(gen, null, `${readmePath} has no "## Generated files here" section`);
    const listedGenerated = [...gen.matchAll(/^- `([^`]+)`/gm)].map(([, path]) => path).sort();
    const expectedGenerated = generated.filter(path => path.startsWith(`${folder}/`))
      .map(path => path.slice(folder.length + 1)).sort();
    assert.deepEqual(listedGenerated, expectedGenerated, `${readmePath}: list each generated source in this folder (scan.mjs GENERATED_SOURCES)`);
  });

  test(`${feature}: public-api.ts exists and holds types only`, () => {
    const file = `${folder}/public-api.ts`;
    assert.ok(existsSync(join(repoRoot, file)), `${file} is missing (frontend.md §2.3)`);
    const runtime = parse(file).statements.filter(statement => {
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return false;
      if (ts.isImportDeclaration(statement)) return !statement.importClause?.isTypeOnly;
      if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) return false;
        // `export {};` marks a module and emits nothing.
        return Boolean(statement.moduleSpecifier) || !statement.exportClause
          || !ts.isNamedExports(statement.exportClause) || statement.exportClause.elements.length > 0;
      }
      return true;
    }).map(statement => statement.getText().split('\n')[0]);
    assert.deepEqual(runtime, [], `${file} may hold only \`export type\` / \`import type\`, interfaces and type aliases`);
  });
}
