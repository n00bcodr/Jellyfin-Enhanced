// The admin page's default shortcut grid and the server's default configuration are two hand-kept lists.
// They must name the same shortcuts with the same keys, or a fresh install and the admin page disagree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const field = (text, name) => new RegExp(`\\b${name}\\s*[:=]\\s*"([^"]*)"`).exec(text)?.[1];
const entries = (text, pattern) => [...text.matchAll(pattern)].map(match => ['Name', 'Key', 'Label', 'Category'].map(name => field(match[0], name)).join(' | '));

test('the admin shortcut grid and the server defaults list the same shortcuts, keys and labels', () => {
  const server = entries(read('Jellyfin.Plugin.JellyfinEnhanced/Configuration/PluginConfiguration.cs'), /new Shortcut \{[^}]*\}/g);
  const source = read('client/src/admin/config/domain/shortcuts.ts');
  const admin = entries(source.slice(source.indexOf('DEFAULT_SHORTCUTS'), source.indexOf('];', source.indexOf('DEFAULT_SHORTCUTS'))), /\{ Name:[^}]*\}/g);
  assert.ok(server.length >= 20, 'server defaults were found');
  assert.deepEqual(admin, server);
});

// Upstream 533614b8.
test('the subtitle offset shortcuts default to [ and ] in the Player category', () => {
  const server = entries(read('Jellyfin.Plugin.JellyfinEnhanced/Configuration/PluginConfiguration.cs'), /new Shortcut \{[^}]*\}/g);
  const at = server.indexOf('FrameStepForward | . | Step Forward One Frame | Player');
  assert.deepEqual(server.slice(at + 1, at + 4), ['DecreaseSubtitleOffset | [ | Decrease Subtitle Offset | Player',
    'IncreaseSubtitleOffset | ] | Increase Subtitle Offset | Player', 'JumpToLastPosition | Z | Jump to Last Position | Player']);
  const keys = server.map(row => row.split(' | ')[1]);
  for (const key of ['[', ']']) assert.equal(keys.filter(k => k === key).length, 1, `no other default uses ${key}`);
});
