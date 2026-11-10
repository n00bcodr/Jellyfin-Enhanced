import test from 'node:test';
import assert from 'node:assert/strict';

import { plain } from '../../../helpers/harness.mjs';
import { LIBRARY, OTHER_LIBRARY, serverPatch, setup } from '../../../helpers/admin-tags-page.mjs';

// The admin Rules form is the same builder as each user's own Rules & locks: one to five conditions, an Edit per
// rule that keeps the rule's id, On/Off state and the fields the form does not set, and choices for libraries,
// genres and age ratings. A JSON draft being typed survives saves and other administrators' changes.

/** The library list and the library's genres and age ratings, as Jellyfin answers them. */
const lists = {
  getJSON: async (url) => {
    if (url.includes('/Items/Filters')) return { Genres: ['Drama', 'Anime', 'Comedy'], OfficialRatings: ['TV-Y', 'PG-13', 'TV-Y'] };
    return [{ ItemId: LIBRARY, Name: 'Movies' }, { ItemId: OTHER_LIBRARY, Name: 'Shows' }];
  },
};

/** Set condition row `i` (0-based) to field/value through its controls. */
function condition(h, i, field, value) {
  const row = h.$$('[data-cond]')[i];
  h.change(row.querySelector('[data-cond-field]'), field);
  h.change(row.querySelector('[data-cond-value]'), value);
}

test('Rules form: several conditions in one rule, with the condition count and its limit', async t => {
  const h = setup(t, { apiClient: lists });
  await h.settle(); await h.settle();
  assert.equal(h.$('[data-rule-title]').textContent, 'Add a rule');
  assert.equal(h.$('[data-rule="layout"]').value, 'caption', 'a new rule starts at Caption');
  assert.equal(h.$('[data-rule="density"]').value, 'compact', 'and Compact, as in the hub');
  condition(h, 0, 'library', OTHER_LIBRARY);
  h.$('[data-rule="add-cond"]').click();
  condition(h, 1, 'type', 'Series');
  h.$('[data-rule="add-cond"]').click();
  condition(h, 2, 'genre', 'Anime');
  assert.equal(h.$$('[data-cond]').length, 3);
  assert.equal(h.$('[data-cond-count]').textContent, '3 of 5');
  assert.deepEqual(h.$$('[data-cond-n]').map((n) => n.textContent), ['Condition 1', 'Condition 2', 'Condition 3']);
  h.$('[data-rule="layout"]').value = 'minimal';
  h.$('[data-rule="density"]').value = 'full';
  h.$('[data-rule="add"]').click();
  await h.save();
  const [rule] = plain(h.server.TagLookRules);
  assert.match(rule.Id, /^r[a-z0-9]+$/, 'a new rule gets its id at once');
  assert.deepEqual([rule.Enabled, rule.When, rule.Layout, rule.Density, rule.Slots], [true, [{ Field: 'library', Value: OTHER_LIBRARY }, { Field: 'type', Value: 'Series' }, { Field: 'genre', Value: 'Anime' }], 'minimal', 'full', null]);
  assert.equal(h.$$('[data-cond]').length, 1, 'the form starts over with one condition');
  assert.match(h.$('.je-ta-rule[data-index="0"]').textContent, /Shows.* and .*Series.* and .*Anime/s, 'the row reads every condition');
  // At most five conditions; the last one cannot be removed.
  for (let i = 0; i < 6; i++) h.$('[data-rule="add-cond"]').click();
  assert.equal(h.$$('[data-cond]').length, 5);
  assert.equal(h.$('[data-rule="add-cond"]').disabled, true);
  h.$$('[data-cond-remove]')[1].click();
  assert.equal(h.$$('[data-cond]').length, 4);
  assert.equal(h.document.activeElement, h.$$('[data-cond-field]')[1], 'focus moves to the row that took its place');
  for (let i = 0; i < 3; i++) h.$$('[data-cond-remove]')[0].click();
  assert.equal(h.$$('[data-cond]').length, 1);
  assert.equal(h.$('[data-cond-remove]').disabled, true, 'the only condition stays');
});

test('Rules form: genre choices and age rating suggestions come from the library', async t => {
  const h = setup(t, { apiClient: lists });
  await h.settle(); await h.settle();
  const row = h.$('[data-cond]');
  h.change(row.querySelector('[data-cond-field]'), 'genre');
  const genre = row.querySelector('[data-cond-value]');
  assert.equal(genre.tagName, 'SELECT');
  assert.deepEqual([...genre.options].map((o) => o.value), ['', 'Anime', 'Comedy', 'Drama'], 'sorted, after Choose…');
  h.change(row.querySelector('[data-cond-field]'), 'ageRating');
  const age = row.querySelector('[data-cond-value]');
  assert.equal(age.tagName, 'INPUT');
  assert.deepEqual([...h.document.getElementById(age.getAttribute('list')).options].map((o) => o.value), ['PG-13', 'TV-Y'], 'each rating once');
  h.change(row.querySelector('[data-cond-field]'), 'library');
  assert.deepEqual([...row.querySelector('[data-cond-value]').options].map((o) => o.textContent), ['Choose…', 'Movies', 'Shows'], 'libraries by name, never ids');
});

test('Rules form: a condition without a value is refused in place', async t => {
  const h = setup(t, { apiClient: lists });
  await h.settle(); await h.settle();
  h.$('[data-rule="add-cond"]').click();
  condition(h, 0, 'library', LIBRARY);
  h.change(h.$$('[data-cond-field]')[1], 'genre');
  h.$('[data-rule="add"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.TagLookRules), [], 'nothing saved');
  const empty = h.$$('[data-cond-value]')[1];
  assert.equal(h.$('#jeTaRuleError').textContent, 'Choose or enter a value for every condition.');
  assert.equal(empty.getAttribute('aria-invalid'), 'true');
  assert.equal(empty.getAttribute('aria-describedby'), 'jeTaRuleError');
  assert.equal(h.document.activeElement, empty);
  h.change(empty, 'Drama');
  assert.equal(empty.hasAttribute('aria-invalid'), false, 'a new value clears the mark');
});

test('Rules form: Edit loads a rule, Save keeps its id, place, On/Off state and positions; Cancel goes back to adding', async t => {
  const stored = [
    { Id: 'rule-1', Enabled: true, When: [{ Field: 'type', Value: 'Episode' }], Layout: 'bands', Density: 'compact', ColourPreset: null, Slots: null },
    { Id: 'kids', Enabled: false, When: [{ Field: 'library', Value: LIBRARY }, { Field: 'ageRating', Value: 'TV-Y' }], Layout: 'caption', Density: 'full', ColourPreset: null, Slots: [{ Group: 'quality', Slot: 'caption' }], Shapes: { landscape: { layout: 'minimal' } } },
  ];
  const h = setup(t, { config: { TagLookRules: stored }, apiClient: lists });
  await h.settle(); await h.settle();
  const edit = (i) => h.$(`.je-ta-rule[data-index="${i}"] [data-act="edit"]`);
  assert.equal(edit(1).getAttribute('aria-label'), 'Edit rule: Rule 2');
  edit(1).click();
  assert.equal(h.$('[data-rule-title]').textContent, 'Edit rule 2');
  assert.equal(h.$('[data-rule-save-label]').textContent, 'Save rule');
  assert.equal(h.$('[data-rule="cancel"]').hidden, false);
  assert.equal(h.$('[data-rule-extras]').hidden, false, 'a rule with its own positions says the form keeps them');
  assert.equal(h.$('.je-ta-rule[data-index="1"]').dataset.editing, 'true');
  assert.equal(h.document.activeElement, h.$('[data-cond-field]'), 'focus goes to the first condition');
  assert.deepEqual(h.$$('[data-cond]').map((r) => [r.querySelector('[data-cond-field]').value, r.querySelector('[data-cond-value]').value]), [['library', LIBRARY], ['ageRating', 'TV-Y']]);
  assert.deepEqual([h.$('[data-rule="layout"]').value, h.$('[data-rule="density"]').value], ['caption', 'full']);
  // Another administrator moved it meanwhile: the edit still lands on it (found by id).
  h.server.TagLookRules = structuredClone([stored[1], stored[0]]);
  h.ctx.reload(structuredClone(h.server));
  assert.equal(h.$('[data-rule-title]').textContent, 'Edit rule 1');
  condition(h, 1, 'ageRating', 'PG-13');
  h.$('[data-rule="layout"]').value = 'summary';
  h.$('[data-rule="add"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.TagLookRules), [
    { ...stored[1], When: [{ Field: 'library', Value: LIBRARY }, { Field: 'ageRating', Value: 'PG-13' }], Layout: 'summary' },
    stored[0],
  ], 'same id, still off, positions and shape looks kept, nothing added');
  assert.equal(h.$('[data-rule-title]').textContent, 'Add a rule', 'back to adding');
  assert.equal(h.document.activeElement, edit(0), 'focus returns to the rule');
  // Cancel drops the edit and returns to the rule's Edit.
  edit(1).click();
  condition(h, 0, 'type', 'Movie');
  h.$('[data-rule="cancel"]').click();
  assert.equal(h.$('[data-rule-title]').textContent, 'Add a rule');
  assert.equal(h.$$('[data-cond]').length, 1);
  assert.equal(h.document.activeElement, edit(1));
  await h.save();
  assert.equal(h.server.TagLookRules[1].When[0].Value, 'Episode', 'Cancel saved nothing');
  // The rule being edited is deleted: the form goes back to adding.
  edit(0).click();
  h.$('.je-ta-rule[data-index="0"] [data-act="delete"]').click();
  assert.equal(h.$('[data-rule-title]').textContent, 'Add a rule');
  assert.equal(h.$('[data-rule="cancel"]').hidden, true);
});

test('Rules JSON: a draft being typed survives the save that normalises the rules, and says when they moved on', async t => {
  let h;
  // The server fills in rule ids, as Configuration/TagLookSettings.cs NormalizeRules does for a missing one.
  const patch = async (body) => {
    const answer = serverPatch(h.server, body);
    if (Array.isArray(answer.values.TagLookRules)) {
      answer.values.TagLookRules = answer.values.TagLookRules.map((r, i) => ({ ...r, Id: r.Id || `rule-${i + 1}` }));
      h.server.TagLookRules = structuredClone(answer.values.TagLookRules);
    }
    return answer;
  };
  h = setup(t, { apiClient: lists, patch, config: { TagLookRules: [{ Id: '', Enabled: true, When: [{ Field: 'type', Value: 'Episode' }], Layout: 'corners', Density: 'full', ColourPreset: null, Slots: null }] } });
  await h.settle(); await h.settle();
  const box = h.$('#tagLookRulesJson');
  const stale = h.$('#tagLookRulesJsonStale');
  h.$('details.je-ta-json').open = true;
  // Switch the rule off (a save), then type a draft while it is in flight.
  h.change(h.$('.je-ta-rule[data-index="0"] [data-act="enable"]'), false);
  const draft = JSON.stringify([{ when: [{ field: 'genre', value: 'Anime' }], layout: 'minimal' }]);
  box.focus();
  box.value = draft;
  box.dispatchEvent(new h.window.Event('input'));
  await h.save();
  assert.equal(h.server.TagLookRules[0].Id, 'rule-1', 'the server normalised the rules');
  assert.equal(box.value, draft, 'the draft is kept');
  assert.equal(stale.hidden, false, 'and says the saved rules changed beneath it');
  // Revert loads the saved rules.
  h.$('[data-rule="json-revert"]').click();
  assert.equal(JSON.parse(box.value)[0].Id, 'rule-1');
  assert.equal(stale.hidden, true);
  // An unchanged box follows later saves; a saved draft becomes the rules.
  h.change(h.$('.je-ta-rule[data-index="0"] [data-act="enable"]'), true);
  await h.save();
  assert.equal(JSON.parse(box.value)[0].Enabled, true, 'an untouched box shows the latest rules');
  box.value = draft;
  box.dispatchEvent(new h.window.Event('input'));
  h.$('[data-rule="json-save"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.TagLookRules.map((r) => [r.Id, r.When[0].Value, r.Layout])), [['rule-1', 'Anime', 'minimal']]);
  assert.equal(JSON.parse(box.value)[0].Id, 'rule-1', 'the saved answer loads into the box');
  assert.equal(stale.hidden, true);
});
