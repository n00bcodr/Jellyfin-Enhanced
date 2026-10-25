// The vendored jellyfin-web input excerpts (tests/fixtures/host-input/<host>, made by
// tests/host/web-bundle/extract-input.mjs) are what the manifest says they are: each module excerpt and the gamepad
// chunk hash to the recorded SHA-256 of the shipped bundle's text, and every licence sidecar they carry is present.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { repositoryRoot } from '../helpers/discovery.mjs';

const sha256 = text => createHash('sha256').update(text).digest('hex');

for (const host of ['12.2', '10.11.11']) {
  test(`the ${host} input excerpts match their manifest (module sources, gamepad chunk, licence sidecars)`, () => {
    const dir = `${repositoryRoot}tests/fixtures/host-input/${host}/`;
    const manifest = JSON.parse(readFileSync(dir + 'manifest.json', 'utf8'));
    assert.equal(manifest.image, `jellyfin/jellyfin:${host}`);
    for (const [name, source] of Object.entries(manifest.sources)) {
      const text = readFileSync(dir + name, 'utf8');
      if (name.endsWith('.module.js')) {
        const body = text.slice(text.indexOf('module: ') + 'module: '.length, text.lastIndexOf(' };'));
        assert.equal(sha256(body), source.sha256, name);
        assert.match(text, new RegExp(`^// Module ${source.module} of main\\.jellyfin\\.bundle\\.js`), name);
        assert.match(text, /For license information please see main\.jellyfin\.bundle\.js\.LICENSE\.txt/, name);
      } else assert.equal(sha256(text), source.sha256, name);
    }
    for (const [sidecar, { sha256: expected }] of Object.entries(manifest.licenses)) assert.equal(sha256(readFileSync(dir + sidecar, 'utf8')), expected, sidecar);
    assert.deepEqual(readdirSync(dir).sort(), [...Object.keys(manifest.sources), ...Object.keys(manifest.licenses), 'manifest.json'].sort());
  });
}
