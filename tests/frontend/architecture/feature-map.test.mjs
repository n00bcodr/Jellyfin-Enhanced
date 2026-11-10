// Feature-map parity, frontend side (PLAN.md "Canonical feature list", step 12; backend.md §7.4).
// docs/feature-map.json is the one map of each feature's client folder, backend Features/ folder and test folders.
// This test holds the map's shape and the client side to the tree: client/src/features/* is exactly the map's
// features, and every client and frontend test folder it names exists. The backend parity test (backend S3) checks
// the backend folders against the same file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { featureMapPath, mappedFeatures, readFeatureMap, repoRoot, srcRoot, whereThingsLiveRows } from './scan.mjs';

const map = readFeatureMap();
const rows = map.features;
const isDir = path => existsSync(join(repoRoot, path)) && statSync(join(repoRoot, path)).isDirectory();
const subfolders = path => (isDir(path) ? readdirSync(join(repoRoot, path), { withFileTypes: true }) : [])
  .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
const repoPath = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_.\-/]+(?<!\/)$/;


test(`${featureMapPath} rows are well-formed`, () => {
  assert.ok(Array.isArray(rows) && rows.length > 0, 'features must be a non-empty array');
  assert.equal(map.backendRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Features');
  const problems = [];
  for (const row of rows) {
    const at = row?.name ?? JSON.stringify(row);
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(row.name ?? '')) problems.push(`${at}: name must be kebab-case`);
    if (!['feature', 'area'].includes(row.kind)) problems.push(`${at}: kind must be "feature" or "area"`);
    if (!Array.isArray(row.client) || !row.client.length) problems.push(`${at}: client must be a non-empty array`);
    if (row.backend !== null && !/^[A-Z][A-Za-z0-9]*$/.test(row.backend ?? '')) problems.push(`${at}: backend must be a PascalCase folder name or null`);
    if (row.controller !== null && !/^Je[A-Z][A-Za-z0-9]*Controller$/.test(row.controller ?? '')) problems.push(`${at}: controller must be Je<Feature>Controller or null`);
    if (row.backend === null && row.controller !== null) problems.push(`${at}: a row without a backend folder has no controller`);
    if ('backendServedBy' in row && row.backend !== null) problems.push(`${at}: backendServedBy is only for rows without a backend folder`);
    if (!Array.isArray(row.tests?.frontend) || !Array.isArray(row.tests?.backend)) problems.push(`${at}: tests.frontend and tests.backend must be arrays`);
    const paths = [...(row.client ?? []), ...(row.tests?.frontend ?? []), ...(row.tests?.backend ?? [])];
    for (const path of paths) if (typeof path !== 'string' || !repoPath.test(path)) problems.push(`${at}: ${JSON.stringify(path)} is not a repo-relative folder`);
    for (const path of row.client ?? []) if (!String(path).startsWith(`${srcRoot}/`)) problems.push(`${at}: client folder ${path} is outside ${srcRoot}`);
    for (const path of row.tests?.frontend ?? []) if (!String(path).startsWith('tests/frontend/')) problems.push(`${at}: ${path} is not under tests/frontend`);
    for (const path of row.tests?.backend ?? []) if (!String(path).startsWith('tests/backend/')) problems.push(`${at}: ${path} is not under tests/backend`);
  }
  assert.deepEqual(problems, []);
});

test('feature names, backend folders and controllers are unique; admin-tags is folded into media-tags', () => {
  const duplicates = values => values.filter((value, i) => value !== null && values.indexOf(value) !== i);
  assert.deepEqual(duplicates(rows.map(row => row.name)), [], 'duplicate feature name');
  assert.deepEqual(duplicates(rows.map(row => row.backend)), [], 'two rows name the same backend folder');
  assert.deepEqual(duplicates(rows.map(row => row.controller)), [], 'two rows name the same controller');
  assert.ok(!rows.some(row => row.name === 'admin-tags' || row.backend === 'AdminTags'), 'admin-tags / AdminTags is folded into media-tags');
  const backends = new Set(rows.map(row => row.backend).filter(Boolean));
  const unserved = rows.filter(row => 'backendServedBy' in row && !backends.has(row.backendServedBy))
    .map(row => `${row.name}: backendServedBy ${row.backendServedBy} is no row's backend folder`);
  assert.deepEqual(unserved, []);
});

test('client/src/features/* is exactly the map\'s features, each at client/src/features/<name>', () => {
  const folders = subfolders(`${srcRoot}/features`);
  const features = mappedFeatures(map);
  assert.deepEqual(features.map(row => row.name).sort(), folders,
    `${featureMapPath} (kind "feature") and the folders under ${srcRoot}/features must match`);
  const misplaced = features.filter(row => row.client[0] !== `${srcRoot}/features/${row.name}`)
    .map(row => `${row.name}: first client folder is ${row.client[0]}`);
  assert.deepEqual(misplaced, [], 'a feature\'s first client folder is its own folder');
  const outside = rows.filter(row => row.kind === 'area' && row.client[0].startsWith(`${srcRoot}/features/`))
    .map(row => `${row.name}: ${row.client[0]}`);
  assert.deepEqual(outside, [], 'an area (admin, platform) is not a feature folder');
});

test('every client folder in the map exists', () => {
  const missing = rows.flatMap(row => row.client.filter(path => !isDir(path)).map(path => `${row.name}: ${path}`));
  assert.deepEqual(missing, []);
});

test('every frontend test folder in the map exists', () => {
  const missing = rows.flatMap(row => row.tests.frontend.filter(path => !isDir(path)).map(path => `${row.name}: ${path}`));
  assert.deepEqual(missing, []);
});

// Step F1 mirrored the feature tests into tests/frontend/features/<feature>/ (frontend.md §3 F1); each such folder
// belongs to a row.
test('tests/frontend/features/* has no unmapped folder', () => {
  const mapped = new Set(rows.flatMap(row => row.tests.frontend));
  const unmapped = subfolders('tests/frontend/features').map(name => `tests/frontend/features/${name}`).filter(path => !mapped.has(path));
  assert.deepEqual(unmapped, [], `add each tests/frontend/features/<folder> to its row in ${featureMapPath}`);
});

test('CONTRIBUTING.md "Where things live" lists exactly the map\'s rows', () => {
  const text = readFileSync(join(repoRoot, 'CONTRIBUTING.md'), 'utf8');
  const start = text.indexOf('\n### Where things live\n');
  assert.ok(start >= 0, 'CONTRIBUTING.md has no "### Where things live" section (backend.md §7.6)');
  const rest = text.slice(start + 1);
  const end = rest.search(/\n#{2,3} /);
  const rows = (end < 0 ? rest : rest.slice(0, end)).split('\n').filter(line => line.startsWith('| `'));
  const expected = whereThingsLiveRows(map);
  assert.deepEqual(rows, expected, `the table rows must be, in ${featureMapPath} order:\n${expected.join('\n')}`);
});
