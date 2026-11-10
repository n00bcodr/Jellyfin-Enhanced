import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Run under the validation lock (see docs/rewrite/bootstrap-contracts.md).
// Every mutation is in an artifacts fixture; never alter the shared production tree.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = join(root, 'artifacts/rewrite-contract-build-boundary');
mkdirSync(evidence, { recursive: true });

test('contract generation recovers independently while real client/build/pack guards remain enforced', () => {
  const fixture = mkdtempSync(join(evidence, 'fixture-'));
  const plugin = 'Jellyfin.Plugin.JellyfinEnhanced';
  const copy = (relative) => {
    mkdirSync(dirname(join(fixture, relative)), { recursive: true });
    cpSync(join(root, relative), join(fixture, relative), { recursive: true,
      filter: source => !['bin', 'obj', 'node_modules'].includes(source.split('/').at(-1)) });
  };
  for (const relative of ['tools/ClientContracts', 'scripts/client-build.mjs', 'scripts/client', 'scripts/tag-data.mjs', 'scripts/generate-client-contracts.sh',
    'Directory.Build.targets', 'package.json', 'package-lock.json', 'client', 'contracts',
    `${plugin}/JellyfinEnhanced.csproj`, `${plugin}/Transport`,
    `${plugin}/js/tags/status-vocabulary.json`, `${plugin}/js/tags/quality-compact.json`,
    `${plugin}/Shared/MediaTags/PosterTags/Resolution/QualityCompactLabels.g.cs`]) copy(relative);
  // Copy the actual linked source closure, not a second model definition.
  const project = readFileSync(join(root, 'tools/ClientContracts/ClientContracts.csproj'), 'utf8');
  assert.doesNotMatch(project, /ProjectReference/);
  for (const match of project.matchAll(/Compile Include="\.\.\/\.\.\/([^"]+)"/g)) copy(match[1]);
  const manifest = JSON.parse(readFileSync(join(root, 'client/generated-manifest.json'), 'utf8'));
  // Copy production outputs listed by entry owners (maps too), without unrelated assets.
  for (const entry of readdirSync(join(root, 'client/entries'))) {
    if (!entry.endsWith('.json')) continue;
    const entries = JSON.parse(readFileSync(join(root, 'client/entries', entry), 'utf8'));
    for (const output of Object.keys(entries)) {
      copy(`${plugin}/${output}`);
      copy(`${plugin}/${output}.map`);
    }
  }
  // HTML outputs embed their script maps; there is no adjacent .map file.
  const htmlEntries = join(root, 'client/html-entries');
  if (existsSync(htmlEntries)) for (const entry of readdirSync(htmlEntries)) {
    if (!entry.endsWith('.json')) continue;
    const entries = JSON.parse(readFileSync(join(htmlEntries, entry), 'utf8'));
    for (const output of Object.keys(entries)) copy(plugin + '/' + output);
  }
  assert.ok(manifest);
  symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir');
  let count = 0;
  function run(command, args, expected = 0, extraEnv = {}) {
    const result = spawnSync(command, args, { cwd: fixture, encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, DOTNET_PROCESSOR_COUNT: '2', ...extraEnv } });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    writeFileSync(join(fixture, `${String(++count).padStart(2, '0')}.log`),
      `$ ${command} ${args.join(' ')}\nexit: ${result.status}\n${output}`);
    assert.ifError(result.error);
    if (expected === 'failure') assert.notEqual(result.status, 0, output);
    else assert.equal(result.status, expected, output);
    return output;
  }
  const contracts = ['contracts/bootstrap.schema.json', 'client/src/contracts/generated.ts', 'client/src/contracts/schema.ts'];
  const bytes = () => contracts.map(path => readFileSync(join(fixture, path), 'utf8'));
  const initial = bytes();
  run('npm', ['run', 'contracts:check']);
  run('npm', ['run', 'contracts:generate']);
  assert.deepEqual(bytes(), initial, 'tool-only compilation must preserve existing contract bytes');

  // Actual source drift, including naming, nullable and ignore metadata.
  const dto = join(fixture, plugin, 'Transport/BootstrapResponse.cs');
  writeFileSync(dto, readFileSync(dto, 'utf8').replace('public sealed class BootstrapResponse\n{',
    `public sealed class BootstrapResponse\n{\n` +
    `    [System.Text.Json.Serialization.JsonPropertyName("boundary_probe")]\n` +
    `    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]\n` +
    `    public string? BoundaryProbe { get; init; }\n` +
    `    [System.Text.Json.Serialization.JsonIgnore]\n` +
    `    public string? HiddenBoundaryProbe { get; init; }\n`));
  writeFileSync(join(fixture, contracts[0]), '{ broken schema');
  writeFileSync(join(fixture, contracts[1]), 'this is broken TypeScript !!!');
  writeFileSync(join(fixture, contracts[2]), 'this is also broken TypeScript !!!');
  const broken = bytes();
  assert.match(run('npm', ['run', 'contracts:check'], 'failure'), /Stale contract:/);
  assert.deepEqual(bytes(), broken, 'check must not repair stale files');
  run('node', ['scripts/client-build.mjs', '--check'], 'failure');
  run('npm', ['run', 'contracts:generate']);
  const regenerated = bytes();
  const schema = JSON.parse(regenerated[0]).$defs.BootstrapResponse;
  assert.deepEqual(schema.properties.boundary_probe, { anyOf: [{ type: 'string' }, { type: 'null' }] });
  assert.ok(!schema.required.includes('boundary_probe'));
  assert.ok(!('HiddenBoundaryProbe' in schema.properties));
  assert.match(regenerated[1], /"boundary_probe"\?: string \| null;/);
  run('npm', ['run', 'contracts:generate']);
  assert.deepEqual(bytes(), regenerated, 'generation must be byte deterministic');
  run('npm', ['run', 'contracts:check']);
  run('node', ['scripts/client-build.mjs', '--check'], 'failure');
  run('node', ['scripts/client-build.mjs']);
  run('node', ['scripts/client-build.mjs', '--check']);
  const csproj = `${plugin}/JellyfinEnhanced.csproj`;
  run('dotnet', ['msbuild', csproj, '-t:VerifyJellyfinEnhancedClient', '-v:minimal']);

  // Use the real plugin project and root target. Build and pack both reject stale
  // outputs before any loadable plugin is compiled or packaged in this fixture.
  const output = join(fixture, plugin, 'js/contracts/bootstrap.js');
  writeFileSync(output, readFileSync(output, 'utf8') + '\n// stale boundary fixture\n');
  for (const verb of ['build', 'pack']) {
    assert.match(run('dotnet', [verb, csproj, '--no-restore', '-c', 'Release'], 'failure'), /Frontend verification failed/);
  }
  run('node', ['scripts/client-build.mjs']);
  run('dotnet', ['msbuild', csproj, '-t:VerifyJellyfinEnhancedClient', '-v:minimal']);

  // Wrapper portability: override path and sibling default both work. npm above
  // deliberately does not acquire a nested lock inside the combined verifier.
  const customLock = join(fixture, 'custom-validation.lock');
  run('bash', ['scripts/generate-client-contracts.sh', '--check'], 0, { JE_VALIDATION_LOCK: customLock });
  assert.ok(existsSync(customLock));
  run('bash', ['scripts/generate-client-contracts.sh', '--check'], 0, { JE_VALIDATION_LOCK: '' });
  assert.ok(existsSync(join(fixture, '..', 'je-v12-validation.lock')));
  const files = readdirSync(join(fixture, 'artifacts'), { recursive: true });
  assert.ok(!files.some(file => /(?:^|\/)Jellyfin\.Plugin\.JellyfinEnhanced\.dll$/.test(file)), 'generator must not emit a plugin assembly');
  console.log(`Boundary evidence: ${fixture}`);
});
