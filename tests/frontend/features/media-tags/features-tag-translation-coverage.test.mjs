import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { coverage, TAG_KEY } from '../../../../scripts/tag-translation-coverage.mjs';

// Untranslated Media Tags strings fall back to English (Weblate fills them); a translated one must keep
// every {placeholder} of the English string, or the chip would show a raw brace or lose its number.
test('every shipped locale is reported and its translated Media Tags strings keep their placeholders', () => {
  const rows = coverage();
  assert.ok(rows.length >= 30);
  for (const row of rows) {
    assert.ok(row.total > 300, `${row.locale} total`);
    assert.ok(row.translated <= row.total);
    assert.deepEqual(row.placeholderErrors, [], `${row.locale} placeholders`);
  }
});

// Every string the users' Media Tags code asks for is counted (the administrator's configuration page is plain English), so the coverage report cannot understate the gap.
// Shared plugin strings (common buttons, other features' dialogs) are translated with those features.
const SHARED = /^(common_|hidden_content_|remove_button_text$|track_off$|awards_label$|panel_settings_subtitles_position$|reviews_|jellyseerr_)/;
test('the coverage report counts every string the Media Tags code uses', () => {
  const js = new URL('../../../../Jellyfin.Plugin.JellyfinEnhanced/js/', import.meta.url).pathname;
  const english = JSON.parse(readFileSync(join(js, 'locales/en.json'), 'utf8'));
  const files = [];
  const walk = dir => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (path.endsWith('.js')) files.push(path); } };
  walk(join(js, 'tags'));
  for (const name of readdirSync(join(js, 'core'))) if (/^tag-|^media-language/.test(name)) files.push(join(js, 'core', name));
  for (const name of readdirSync(join(js, 'enhanced/settingspanel'))) if (/^ui-panel-(media-tags|tag-)/.test(name)) files.push(join(js, 'enhanced/settingspanel', name));
  const used = new Set(files.flatMap(file => [...readFileSync(file, 'utf8').matchAll(/\bt\(\s*['"]([a-z0-9_]+)['"]/g)].map(m => m[1])));
  const uncounted = [...used].filter(key => Object.hasOwn(english, key) && !TAG_KEY.test(key) && !SHARED.test(key));
  assert.deepEqual(uncounted, []);
});
