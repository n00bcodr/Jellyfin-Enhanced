import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildClient, repositoryRoot } from '../../scripts/client-build.mjs';
import { synchronizeTagData, tagDataArtifacts } from '../../scripts/tag-data.mjs';

const plugin = 'Jellyfin.Plugin.JellyfinEnhanced';
const status = 'client/src/features/media-tags/types/status';
const quality = 'client/src/features/media-tags/types/quality';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'je-tag-data-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  for (const script of ['tag-data.mjs', 'generate_status_vocabulary.py', 'generate_quality_compact.py']) put(`scripts/${script}`, readFileSync(join(repositoryRoot, 'scripts', script)));
  put('client/tsconfig.json', readFileSync(join(repositoryRoot, 'client/tsconfig.json')));
  put(`${plugin}/js/tags/status-vocabulary.json`, '{"thresholds":{"dayMs":86400000}}');
  put(`${plugin}/js/tags/quality-compact.json`, '{"Dolby Digital":["DD",true]}');
  put('client/entries/tags.json', JSON.stringify({'js/tags/status-vocabulary.js': `${status}/entry.ts`, 'js/core/tag-layout.js': `${quality}/quality-entry.ts`}));
  put(`${status}/entry.ts`, "import { statusVocabulary } from './status-vocabulary'; document.title = String(statusVocabulary.thresholds.dayMs);");
  put(`${quality}/quality-entry.ts`, "import { COMPACT_QUALITY } from './compact-quality'; document.title = JSON.stringify(COMPACT_QUALITY);");
  synchronizeTagData({root, kind:'status'}); synchronizeTagData({root, kind:'quality'});
  return {root, put};
}

test('compatibility generators write only deterministic TS/native projections, never JS/maps', t => {
  const f = fixture(t);
  const paths = [`${plugin}/js/tags/status-vocabulary.js`, `${plugin}/js/core/tag-layout.js`];
  for (const path of paths) { f.put(path, 'builder owns this'); f.put(`${path}.map`, 'builder owns map'); }
  for (const args of [['scripts/generate_status_vocabulary.py', '--table-only'], ['scripts/generate_quality_compact.py']]) {
    for (const suffix of [[], ['--check']]) {
      const result = spawnSync('python3', [...args, ...suffix], {cwd:f.root, encoding:'utf8'});
      assert.equal(result.status, 0, result.stderr);
    }
  }
  for (const path of paths) { assert.equal(readFileSync(join(f.root,path),'utf8'), 'builder owns this'); assert.equal(readFileSync(join(f.root,`${path}.map`),'utf8'), 'builder owns map'); }
  assert.equal(synchronizeTagData({root:f.root,kind:'status'}).changed, 0);
  assert.equal(synchronizeTagData({root:f.root,kind:'quality'}).changed, 0);
});

for (const mode of [{}, {check:true}, {typecheckOnly:true}]) {
  test(`JSON drift rejects build mode ${JSON.stringify(mode)} without mutating files`, async t => {
    const f = fixture(t); await buildClient({root:f.root});
    const path = join(f.root, `${plugin}/js/tags/status-vocabulary.js`);
    const before = readFileSync(path, 'utf8');
    f.put(`${plugin}/js/tags/status-vocabulary.json`, '{"thresholds":{"dayMs":123}}');
    await assert.rejects(buildClient({root:f.root,...mode}), /Stale status vocabulary/);
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.match(readFileSync(join(f.root, `${status}/status-vocabulary.ts`),'utf8'), /86400000/);
    synchronizeTagData({root:f.root,kind:'status'});
    await buildClient({root:f.root});
    const document = {title:''}; runInNewContext(readFileSync(path,'utf8'), {document});
    assert.equal(document.title, '123');
  });
}

test('native compact drift fails checks even when TS and JS are fresh', async t => {
  const f = fixture(t); await buildClient({root:f.root});
  const native = `${plugin}/Shared/MediaTags/PosterTags/Resolution/QualityCompactLabels.g.cs`;
  f.put(native, 'stale native projection');
  await assert.rejects(buildClient({root:f.root,check:true}), /Stale quality vocabulary/);
  assert.equal(readFileSync(join(f.root,native),'utf8'), 'stale native projection');
  synchronizeTagData({root:f.root,kind:'quality'});
  await buildClient({root:f.root,check:true});
});

test('compact projection validates values and escapes text for both target languages', t => {
  const f=fixture(t);
  f.put(`${plugin}/js/tags/quality-compact.json`, JSON.stringify({'quote"é':['line\n"é',true]}));
  const outputs=[...tagDataArtifacts(f.root,'quality').values()];
  assert.match(outputs[0], /quote\\"é/);
  assert.match(outputs[1], /quote\\"\\u00e9/);
  f.put(`${plugin}/js/tags/quality-compact.json`, '{"bad":["text","not boolean"]}');
  assert.throws(()=>synchronizeTagData({root:f.root,kind:'quality'}), /Invalid compact quality entry/);
});
