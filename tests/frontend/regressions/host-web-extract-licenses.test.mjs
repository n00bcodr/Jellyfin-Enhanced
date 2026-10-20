// The vendored jellyfin-web excerpts carry their licence notices (D46 review round 19): tests/host/web-bundle/extract.mjs
// copies every "For license information please see X.LICENSE.txt" sidecar a copied file refers to, records it in the
// manifest, and fails when a referenced sidecar is missing. Run on a web directory rebuilt from the checked-in fixtures
// (the original file names come from each manifest), so the extractor must reproduce the fixtures exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositoryRoot } from '../helpers/discovery.mjs';

const extractor = repositoryRoot + 'tests/host/web-bundle/extract.mjs';

/** A jellyfin-web directory with the excerpts under their original names, the main bundle rebuilt around the names module. */
function webFrom(host) {
  const fixture = repositoryRoot + 'tests/fixtures/host-web/' + host + '/';
  const manifest = JSON.parse(readFileSync(fixture + 'manifest.json', 'utf8'));
  const web = mkdtempSync(join(tmpdir(), 'je-host-web-'));
  // The main bundle's modules (the names helper, the playback manager) are rebuilt into one bundle below.
  const modules = Object.entries(manifest.sources).filter(([, source]) => source.module != null);
  for (const [name, source] of Object.entries(manifest.sources)) {
    if (source.module != null) continue;
    writeFileSync(join(web, source.file), readFileSync(fixture + name, 'utf8'));
  }
  const names = manifest.sources['now-playing-names.module.js'];
  const body = modules.map(([name, source]) => source.module + ':' + readFileSync(fixture + name, 'utf8').split('\nmodule.exports = ')[1].replace(/;\n$/, '')).join(',');
  writeFileSync(join(web, names.file), `/*! For license information please see ${names.file}.LICENSE.txt */\n(self.webpackChunk=self.webpackChunk||[]).push([[1],{${body}}]);\n`);
  for (const sidecar of Object.keys(manifest.licenses)) writeFileSync(join(web, sidecar), readFileSync(fixture + sidecar, 'utf8'));
  return { fixture, manifest, web };
}

for (const host of ['12.2', '10.11.11']) {
  test(`the extractor reproduces the ${host} excerpts with their licence sidecars`, () => {
    const { fixture, manifest, web } = webFrom(host);
    const out = mkdtempSync(join(tmpdir(), 'je-host-web-out-'));
    try {
      assert.ok(Object.keys(manifest.licenses).some(f => f.startsWith('sessionPlayer-plugin.')), 'the session player chunk refers to its notice');
      assert.ok(Object.keys(manifest.licenses).includes('main.jellyfin.bundle.js.LICENSE.txt'));
      const run = spawnSync(process.execPath, [extractor, web, out, manifest.image], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr.slice(0, 2000));
      for (const file of readdirSync(out)) assert.equal(readFileSync(join(out, file), 'utf8'), readFileSync(fixture + file, 'utf8'), file);
      assert.deepEqual(readdirSync(out).sort(), readdirSync(fixture).sort());
    } finally {
      rmSync(web, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  test(`the extractor fails when a ${host} licence sidecar is missing`, () => {
    const { manifest, web } = webFrom(host);
    const out = mkdtempSync(join(tmpdir(), 'je-host-web-out-'));
    try {
      const sidecar = Object.keys(manifest.licenses).find(f => f.startsWith('sessionPlayer-plugin.'));
      rmSync(join(web, sidecar));
      const run = spawnSync(process.execPath, [extractor, web, out, manifest.image], { encoding: 'utf8' });
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, new RegExp('referenced licence file ' + sidecar.replace(/\./g, '\\.') + ' is missing'));
    } finally {
      rmSync(web, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });
}
