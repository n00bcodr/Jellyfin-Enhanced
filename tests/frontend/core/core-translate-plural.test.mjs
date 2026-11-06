import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHarness } from '../helpers/harness.mjs';

// JE.t as plugin.js defines it: the window object's own function, before any bootstrap runs.
function translator(t, { translations, lang = 'en', fromEnglish = null }) {
  const h = createHarness({ html: '' });
  t.after(() => h.close());
  const source = readFileSync(new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/js/plugin.js', import.meta.url), 'utf8');
  const literal = source.slice(source.indexOf('        t: (key, params = {}) => {'), source.indexOf('        loadSettings: () =>'));
  const JE = { translations, translationsLang: lang, translationsFromEnglish: fromEnglish ? new Set(fromEnglish) : null, IconName: {} };
  h.window.JellyfinEnhanced = JE;
  return h.window.eval(`({${literal}})`).t;
}

const en = JSON.parse(readFileSync(new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json', import.meta.url), 'utf8'));

test('a count picks the plural form of its language, else the base string', t => {
  const tr = translator(t, { translations: en });
  assert.equal(tr('panel_media_tags_badge_window_added', { days: 1 }), 'within 1 day of being added');
  assert.equal(tr('panel_media_tags_badge_window_added', { days: 14 }), 'within 14 days of being added');
  assert.equal(tr('panel_media_tags_badge_window_new', { days: 1 }), 'within 1 day of release');
  assert.equal(tr('language_tags_count_tooltip', { count: 1 }), '1 audio language');
  assert.equal(tr('language_tags_count_tooltip', { count: 3 }), '3 audio languages');
  // No count, or a string without forms: unchanged.
  assert.equal(tr('panel_media_tags_badge_window_added'), en.panel_media_tags_badge_window_added);
  assert.equal(tr('quality_versions_count', { count: 2 }), '2 versions');
});

test('a value is inserted as written: replacement patterns in it are not expanded', t => {
  const tr = translator(t, { translations: { named: 'Rule: {rule}', two: '{a} and {a}' } });
  assert.equal(tr('named', { rule: 'Cost $& more $$ and $1' }), 'Rule: Cost $& more $$ and $1');
  assert.equal(tr('two', { a: "$'" }), "$' and $'");
  assert.equal(tr('named', { rule: 5 }), 'Rule: 5');
});

test('every plural form in en.json belongs to a base string and a CLDR category, with the same placeholders', () => {
  const categories = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
  for (const [key, value] of Object.entries(en)) {
    const match = /^(.*)_(zero|one|two|few|many|other)$/.exec(key);
    // Only a string that takes a count has forms (admin_tags_conflict_one is a sentence of its own).
    if (!match || !(match[1] in en) || !/\{(count|days|n|items|hours|minutes|seconds)\}/.test(en[match[1]])) continue;
    assert.ok(categories.has(match[2]), key);
    const holes = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    assert.deepEqual(holes(value), holes(en[match[1]]), key);
  }
});

test('a locale uses its own forms by its own rules, and never an English form for its own sentence', t => {
  const ru = { days_left: 'осталось {days} дней', days_left_one: 'остался {days} день', days_left_few: 'осталось {days} дня', english_only: 'within {days} days', english_only_one: 'within {days} day', own_base: 'dans {days} jours', own_base_one: 'within {days} day' };
  const tr = translator(t, { translations: ru, lang: 'ru', fromEnglish: ['english_only', 'english_only_one', 'own_base_one'] });
  assert.equal(tr('days_left', { days: 21 }), 'остался 21 день');
  assert.equal(tr('days_left', { days: 3 }), 'осталось 3 дня');
  assert.equal(tr('days_left', { days: 5 }), 'осталось 5 дней', 'many: no form, the base string');
  // A key English filled in follows English rules and forms.
  assert.equal(tr('english_only', { days: 1 }), 'within 1 day');
  // The locale's own sentence never switches to the English form.
  assert.equal(tr('own_base', { days: 1 }), 'dans 1 jours');
  // A kind of English takes the English forms for its own sentences.
  const gb = translator(t, { translations: { a: 'within {days} days', a_one: 'within {days} day' }, lang: 'en-GB', fromEnglish: ['a_one'] });
  assert.equal(gb('a', { days: 1 }), 'within 1 day');
});
