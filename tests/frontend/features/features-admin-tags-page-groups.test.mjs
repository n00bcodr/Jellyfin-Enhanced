import test from 'node:test';
import assert from 'node:assert/strict';


import { plain } from '../helpers/harness.mjs';
import { setup } from '../helpers/admin-tags-page.mjs';

test('Groups › Quality: reordering writes every order key, and the saved audio language survives the culture list', async t => {
  const h = setup(t, { config: { QualityTagsPreferredAudioLanguage: 'pt-BR', ShowEditionTag: false } });
  await h.settle(); await h.settle();
  const select = h.$('#qualityTagsPreferredAudioLanguage');
  assert.equal(select.value, 'pt-BR', 'a code the list does not offer stays selected');
  assert.ok([...select.options].some((o) => o.value === 'ja'), 'the named list is in');
  h.$('li[data-ordered="showAudioInfoTag"] [data-move="-1"]').click();
  await h.save();
  assert.equal(h.server.AudioInfoTagOrder, 5);
  assert.equal(h.server.VideoCodecTagOrder, 6);
  assert.equal(h.server.ResolutionTagOrder, 1);
  assert.match(h.$('.je-ta-grow[data-group="quality"] .je-ta-grow-sum').textContent, /admin_tags_quality_summary:6\|10/);
  h.change(h.$('#qualityTagsEnabled'), false);
  await h.save();
  assert.equal(h.server.QualityTagsEnabled, false);
  assert.equal(h.$('.je-ta-grow[data-group="quality"]').dataset.enabled, 'false');
});

test('Groups › Rating: sources keep their order and an empty choice, legacy switches seed the list, MDBList state shows', async t => {
  const h = setup(t, { config: { RatingTagsShowCritic: false, MdblistRatingsEnabled: true } });
  const rows = () => h.$$('#ratingTagsSourceRows [data-source]');
  assert.deepEqual(rows().filter((r) => r.querySelector('input').checked).map((r) => r.dataset.source), ['community']);
  h.change(rows().find((r) => r.dataset.source === 'imdb').querySelector('input'), true);
  rows().find((r) => r.dataset.source === 'imdb').querySelector('[data-step="-1"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.RatingTagsSources), ['community', 'imdb']);
  rows().find((r) => r.dataset.source === 'imdb').querySelector('[data-step="-1"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.RatingTagsSources), ['imdb', 'community']);
  for (const r of rows()) h.change(r.querySelector('input'), false);
  await h.save();
  assert.deepEqual(plain(h.server.RatingTagsSources), [], 'an empty list is a choice');
  h.change(h.$('#ratingTagsMinScore'), '7');
  await h.save();
  assert.equal(h.server.RatingTagsMinScore, 7);
  assert.match(h.$('[data-mdblist]').textContent, /admin_tags_mdblist_no_key/);
  assert.match(h.$('[data-mdblist] a').href, /name=Jellyfin%20Enhanced&jeSection=mdblistRatingsEnabled$/);
});

test('Groups › Language, Genre, Age rating, Status and People write their switches and fields', async t => {
  const h = setup(t);
  for (const [id, key] of [['genreTagsEnabled', 'GenreTagsEnabled'], ['ageRatingTagsEnabled', 'AgeRatingTagsEnabled'], ['peopleTagsEnabled', 'PeopleTagsEnabled'], ['statusTagsEnabled', 'StatusTagsEnabled']]) {
    const before = h.server[key];
    h.change(h.$(`#${id}`));
    await h.save();
    assert.equal(h.server[key], !before, key);
  }
  h.change([...h.$$('#languageTagsStyle input')].find((r) => r.value === 'codes'), true);
  h.change(h.$('#languageTagsCountBadge'), 'both');
  h.change(h.$('#languageTagsPriority'), ' English, ja ');
  await h.save();
  assert.equal(h.server.LanguageTagsStyle, 'codes');
  assert.equal(h.server.LanguageTagsCountBadge, 'both');
  assert.equal(h.server.LanguageTagsPriority, 'English, ja');
  assert.match(h.$('.je-ta-grow[data-group="language"] .je-ta-grow-sum').textContent, /admin_tags_language_priority_summary:English, ja/);
});



test('every declared field reads its configuration field and saves the new value through the plugin configuration', async t => {
  const h = setup(t, { config: { NativePosterTagsEnabled: true } });
  await h.settle();
  const checked = [];
  for (const section of h.A.sections) {
    for (const f of section.fields || []) {
      if (f.type === 'custom') continue;
      const el = h.$(`[data-je-setting-id="${f.id}"]`);
      assert.ok(el, `${f.id} is on the page`);
      assert.equal(el.dataset.jeField, f.key, `${f.id} is bound to ${f.key}`);
      if (f.when && !f.when(h.ctx.config)) continue;
      if (f.type === 'pills') {
        const control = [...el.querySelectorAll('input')].find((r) => !r.checked);
        h.change(control, true);
      } else if (f.type === 'select') {
        h.change(el, [...el.options].find((o) => !o.selected && !o.disabled).value);
      } else if (f.type === 'number') h.change(el, String((f.min || 0) + 2));
      else if (f.type === 'text' || f.type === 'textarea') h.change(el, '  changed  ');
      else h.change(el);
      const expected = f.secret ? 'changed' : h.A.controlValue(f, el, h.ctx.config);
      await h.save();
      assert.deepEqual(plain(h.server[f.key]), plain(expected), `${f.id} saved ${f.key}`);
      checked.push(f.id);
    }
  }
  assert.ok(checked.length >= 50, `${checked.length} fields exercised`);
  assert.equal(h.server.LanguageTagsPriority, 'changed', 'text is trimmed');
  assert.equal(h.server.DevMode, false, 'fields the page does not own keep the server value');
});


