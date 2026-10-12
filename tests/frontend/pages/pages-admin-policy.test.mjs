import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, deferred } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';

// Design item C2: the admin page's "User settings policy" add-on (js/admin/user-settings-policy.js,
// loaded by Configuration/configPage.html, not part of the bundle). It runs here against the real
// admin page markup (scripts stripped) and the registry route's real answer for a fresh install.

const pagePath = resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html');
const pageSource = readFileSync(pagePath, 'utf8');
const pageMarkup = pageSource.slice(pageSource.indexOf('<div class="page'), pageSource.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');
const fixture = name => JSON.parse(readFileSync(resolve(repositoryRoot, 'tests/fixtures/settings', name), 'utf8'));
const registryDefault = fixture('admin-registry-default.json');
const lockableKeys = fixture('lockable-keys.json');

/** The page's loader for the policy script (inside its first inline script), as it ships. */
const loaderSource = /\(function \(\) \{\s*function showPolicyLoadFailure\(\)[\s\S]*?\n        \}\)\(\);/.exec(pageSource)?.[0];

/** The page's quality-category arrows (helper + delegated click handler), taken from configPage.html as it ships. */
const categoryArrowsSource = [
  /function refreshQualityCatAdminArrows\(container\) \{[\s\S]*?\n        \}/.exec(pageSource)?.[0],
  /\(function \(\) \{\s*document\.addEventListener\('click', function \(e\) \{\s*var btn = e\.target\.closest && e\.target\.closest\('#qualityCategoriesAdmin[\s\S]*?\n        \}\)\(\);/.exec(pageSource)?.[0]
];

/** The page's own save-side lock decision, taken from configPage.html as it ships. */
const applyLocksSource = /function jeApplyUserSettingsLocks\(config\) \{[\s\S]*?\n        \}/.exec(pageSource)?.[0];

/** The page's delegated jump handler, including its handling of already-prevented clicks. */
const jumpHandlerSource = /form\.addEventListener\('click', \(e\) => \{\s*const link = e\.target\.closest\('\.je-jump-link'\);[\s\S]*?\n            \}\);/.exec(pageSource)?.[0];

/** Visible chip text, excluding the decorative Material icon's ligature. */
function chipText(chip) {
  return [...chip.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('');
}

/** Mimics the label structure emby-checkbox adds when its custom input is upgraded. */
function upgradeCheckbox(input) {
  const label = input.parentElement;
  input.classList.add('emby-checkbox');
  label.classList.add('emby-checkbox-label');
  label.querySelector('span').classList.add('checkboxLabel');
  const outline = input.ownerDocument.createElement('span');
  outline.className = 'checkboxOutline';
  outline.innerHTML = '<span class="material-icons checkboxIcon checkboxIcon-checked" aria-hidden="true"></span>';
  label.appendChild(outline);
}

function setup(t, { registry = registryDefault, ajax, upgraded = true } = {}) {
  const requests = [];
  const h = createHarness({
    html: pageMarkup,
    apiClient: {
      ajax: ajax || (async (request) => { requests.push(request.url); return structuredClone(registry); })
    }
  });
  t.after(() => h.close());
  h.allowConsoleError(/Could not parse CSS stylesheet/);
  const page = h.document.querySelector('#JellyfinEnhancedPage');
  if (upgraded) page.querySelectorAll('input[is="emby-checkbox"]').forEach(upgradeCheckbox);
  h.load('admin/user-settings-policy.js');
  const policy = h.window.JellyfinEnhancedAdminPolicy;
  const row = key => h.document.getElementById(`jePolicyRow-${key}`);
  const tick = (key, checked = true) => {
    const box = row(key).querySelector('input[type="checkbox"]');
    box.checked = checked;
    box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  };
  const applyLocks = h.window.eval(`(${applyLocksSource})`);
  return { ...h, page, policy, row, tick, requests, applyLocks };
}

test('every lockable key gets one policy row and one inline chip per control group, including on revisit', async t => {
  assert.ok(applyLocksSource, 'jeApplyUserSettingsLocks is in configPage.html');
  const h = setup(t);
  assert.equal(h.policy.ready, false);
  assert.equal(await h.policy.decorate(h.page), true);
  assert.equal(h.policy.ready, true);
  // The registry, then (C4) whether the upgrade card was dismissed; no user files are read.
  assert.deepEqual(h.requests, ['http://jellyfin.test/JellyfinEnhanced/admin/user-settings/registry', 'http://jellyfin.test/JellyfinEnhanced/admin/user-settings/upgrade-card']);

  const rows = [...h.document.querySelectorAll('#jeUserSettingsPolicyTable tbody tr[data-setting-key]')];
  assert.deepEqual(rows.map(row => row.dataset.settingKey).sort(), [...lockableKeys].sort());
  const groups = new Set();
  for (const entry of registryDefault.filter(e => e.Lockable)) {
    const matches = entry.RowKey
      ? [...h.page.querySelectorAll('[data-order-key]')].filter(el => el.dataset.orderKey === entry.RowKey)
      : [...h.page.querySelectorAll('[id]')].filter(el => el.id === entry.ControlId);
    assert.equal(matches.length, 1, `${entry.Key}: one admin control or row`);
    const group = matches[0].closest('.je-quality-cat-admin-row, .je-tag-row')
      || matches[0].closest('.checkboxContainer, .inputContainer, .selectContainer');
    groups.add(group);
    assert.equal(group.querySelectorAll('a.je-user-default-chip').length, 1, `${entry.Key}: one chip in its group`);
    const link = h.row(entry.Key).querySelector('th a.je-jump-link');
    assert.ok(link, `${entry.Key}: the row links to its control`);
    assert.ok(link.dataset.jumpTab && h.document.getElementById(link.dataset.jumpTab), `${entry.Key}: jumps to a real tab`);
  }
  // Ambiguous admin labels get their tag as context.
  assert.equal(h.row('QualityTagsPosition').querySelector('th').textContent, 'Quality Tags: Position');
  assert.equal(h.row('RatingTagsOnMovies').querySelector('th').textContent, 'Rating Tags: Show on movies');
  assert.equal(h.row('AutoSkipIntro').querySelector('th').textContent.trim(), 'Auto-skip Intro');

  const chips = [...h.page.querySelectorAll('a.je-user-default-chip')];
  assert.equal(chips.length, groups.size);
  const pipLabel = h.page.querySelector('#autoPipEnabled').closest('label');
  const qualityLabel = h.page.querySelector('#qualityTagsEnabled').closest('label');
  const categoryLabel = h.page.querySelector('#showResolutionTag').closest('label');
  const selectLabel = h.page.querySelector('label.inputLabel[for="watchProgressDefaultMode"]');
  for (const label of [pipLabel, qualityLabel, categoryLabel]) {
    assert.ok(label.querySelector(':scope > span.checkboxLabel > a.je-user-default-chip:last-child'), 'chip follows text inside the checkbox text span');
    assert.ok(label.querySelector(':scope > input + span + .checkboxOutline'), 'checked-state sibling chain is preserved');
  }
  assert.equal(selectLabel.lastElementChild.matches('a.je-user-default-chip'), true);
  assert.equal(chipText(selectLabel.lastElementChild), 'User default');
  assert.equal(qualityLabel.querySelector('a').dataset.jumpTarget, '#jePolicyRow-QualityTagsEnabled');
  for (const chip of chips) {
    assert.equal(chipText(chip), 'User default');
    assert.equal(chip.querySelector('i.material-icons[aria-hidden="true"]').textContent, 'person');
    assert.equal(chip.getAttribute('href'), '#');
    assert.equal(chip.dataset.jumpTab, 'admin');
    assert.equal(chip.getAttribute('aria-label'), chip.title);
  }
  // No decoration is inserted between the control group and its description.
  assert.equal(qualityLabel.closest('.je-tag-row').nextElementSibling.dataset.descFor, 'qualityTagsEnabled');
  assert.equal(pipLabel.closest('.checkboxContainer').nextElementSibling.dataset.descFor, 'autoPipEnabled');
  assert.equal(h.page.querySelectorAll('.je-user-default-chip-sample').length, 2);
  assert.equal(h.page.querySelectorAll('a.je-user-default-chip-sample').length, 0);

  // Decorating again (every pageshow) does not duplicate anything.
  await h.policy.decorate(h.page);
  assert.equal(h.document.querySelectorAll('#jeUserSettingsPolicyTable tbody tr[data-setting-key]').length, lockableKeys.length);
  assert.equal(h.page.querySelectorAll('a.je-user-default-chip').length, chips.length);
  assert.equal(h.page.querySelectorAll('.je-user-default-chip-sample').length, 2);
  for (const group of groups) assert.equal(group.querySelectorAll('a.je-user-default-chip').length, 1);
});

test('checkbox checked-state selectors survive chips, re-rendering and either upgrade order', async t => {
  for (const upgraded of [true, false]) {
    const h = setup(t, { upgraded });
    const checkboxes = ['autoPipEnabled', 'qualityTagsEnabled', 'showResolutionTag'].map(id => h.page.querySelector('#' + id));
    const originalText = checkboxes.map(input => input.parentElement.querySelector('span').textContent);
    checkboxes.forEach(input => { input.checked = true; });
    for (let render = 0; render < 2; render++) {
      await h.policy.decorate(h.page);
      checkboxes.forEach((input, index) => {
        const label = input.parentElement;
        const text = label.querySelector(':scope > span:not(.checkboxOutline)');
        const chip = text.querySelector(':scope > a.je-user-default-chip');
        assert.ok(chip, 'the chip is nested before and after upgrade');
        assert.equal(text.lastChild, chip);
        assert.equal(text.firstChild.textContent, originalText[index]);
        if (!upgraded && render === 0) upgradeCheckbox(input);
        const outline = label.querySelector(':scope > .checkboxOutline');
        assert.equal(label.querySelector(':scope > input + span + .checkboxOutline'), outline);
        assert.ok(label.querySelector(':scope > .emby-checkbox:checked + span + .checkboxOutline > .checkboxIcon-checked'), 'the checked icon selector still matches');
        assert.equal(label.querySelectorAll('a.je-user-default-chip').length, 1);
        input.checked = false;
        assert.equal(label.querySelector(':scope > .emby-checkbox:checked + span + .checkboxOutline'), null);
        input.checked = true;
      });
    }
  }
});

test('control names exclude chips across decoration, revisits and lock changes without altering label text', async t => {
  const h = setup(t);
  const controls = ['autoPipEnabled', 'watchProgressDefaultMode', 'qualityTagsEnabled', 'showResolutionTag'].map(id => {
    const control = h.document.getElementById(id);
    const label = control.labels[0];
    const text = label.querySelector('span.checkboxLabel') || label;
    return { control, label, text, name: text.textContent.trim(), nodes: [...text.childNodes], spans: label.querySelectorAll('span').length };
  });
  await h.policy.decorate(h.page);
  const names = [...h.page.querySelectorAll('tr[data-setting-key] th')].map(cell => cell.textContent);
  const ids = [...h.page.querySelectorAll('[id]')].map(element => element.id);
  /** Checks the explicit naming source and unchanged label structure for every placement. */
  const check = () => {
    for (const { control, label, text, name, nodes, spans } of controls) {
      assert.equal(control.getAttribute('aria-label'), name);
      assert.equal(control.hasAttribute('aria-labelledby'), false);
      assert.doesNotMatch(control.getAttribute('aria-label'), /User default|Locked for users|Applies to/);
      assert.equal(label.querySelectorAll('span').length, spans, 'no text wrappers are added');
      assert.deepEqual([...text.childNodes].filter(node => !node.matches?.('a.je-user-default-chip')), nodes, 'original text nodes stay in place');
      assert.equal(label.querySelectorAll('a.je-user-default-chip').length, 1);
    }
    assert.deepEqual([...h.page.querySelectorAll('tr[data-setting-key] th')].map(cell => cell.textContent), names, 'policy names remain identical');
    assert.deepEqual([...h.page.querySelectorAll('[id]')].map(element => element.id), ids, 'decoration adds no duplicate ids');
  };
  check();
  await h.policy.decorate(h.page);
  check();
  for (const key of ['AutoPipEnabled', 'WatchProgressMode', 'QualityTagsEnabled', 'QualityTagsPosition', 'ShowResolutionTag', 'ResolutionTagOrder']) h.tick(key);
  check();
  for (const { label } of controls) assert.equal(chipText(label.querySelector('a.je-user-default-chip')), 'Locked for users');
  assert.match(h.page.querySelector('#jeUserSettingsPolicyImpact').textContent, /Locking Watch Progress Default to/);
  assert.match(h.page.querySelector('#jeUserSettingsPolicyImpact').textContent, /Locking Quality Tags: Position to/);
});

test('existing explicit control names survive unless aria-labelledby would include the chip', async t => {
  const h = setup(t);
  const pip = h.document.getElementById('autoPipEnabled');
  pip.setAttribute('aria-label', 'Existing checkbox name');
  const select = h.document.getElementById('watchProgressDefaultMode');
  const source = h.document.createElement('span');
  source.id = 'existingSelectName';
  source.textContent = 'Existing select name';
  h.page.appendChild(source);
  select.setAttribute('aria-labelledby', source.id);
  const quality = h.document.getElementById('qualityTagsEnabled');
  quality.labels[0].id = 'existingQualityLabel';
  quality.setAttribute('aria-labelledby', quality.labels[0].id);
  const category = h.document.getElementById('showResolutionTag');
  const categoryText = category.labels[0].querySelector('span.checkboxLabel');
  categoryText.id = 'existingCategoryText';
  category.setAttribute('aria-labelledby', categoryText.id);
  for (let render = 0; render < 2; render++) {
    await h.policy.decorate(h.page);
    h.tick('QualityTagsEnabled');
    assert.equal(pip.getAttribute('aria-label'), 'Existing checkbox name');
    assert.equal(select.getAttribute('aria-labelledby'), source.id);
    assert.equal(select.hasAttribute('aria-label'), false);
    assert.equal(source.textContent, 'Existing select name');
    assert.equal(source.querySelector('a.je-user-default-chip'), null);
    assert.equal(quality.hasAttribute('aria-labelledby'), false);
    assert.equal(quality.getAttribute('aria-label'), 'Enable Quality Tags');
    assert.equal(category.hasAttribute('aria-labelledby'), false);
    assert.equal(category.getAttribute('aria-label'), 'Show resolution (4K, 1080p, ...)');
  }
});

test('input defaults put the chip after the inputLabel text', async t => {
  // The current registry uses checkbox/select defaults; also cover the inputContainer contract.
  const registry = [{ ...registryDefault.find(e => e.Key === 'AutoPipEnabled'), ControlId: 'testInputDefault' }];
  const h = setup(t, { registry });
  const container = h.document.createElement('div');
  container.className = 'inputContainer';
  container.innerHTML = '<label class="inputLabel" for="testInputDefault">Input default</label><input id="testInputDefault" type="text">';
  h.page.appendChild(container);
  await h.policy.decorate(h.page);
  const label = container.querySelector('.inputLabel');
  assert.equal(label.firstChild.textContent, 'Input default');
  assert.equal(label.lastElementChild.matches('a.je-user-default-chip'), true);
  assert.equal(container.querySelectorAll('a.je-user-default-chip').length, 1);
  assert.equal(container.querySelector('input').getAttribute('aria-label'), 'Input default');
  await h.policy.decorate(h.page);
  h.tick('AutoPipEnabled');
  assert.equal(container.querySelector('input').getAttribute('aria-label'), 'Input default');
  assert.equal(label.querySelectorAll('a.je-user-default-chip').length, 1);
});

test('chip tooltips and accessible labels explain each reach and live unlocked, partial and fully locked states', async t => {
  const cases = [
    { Reach: 'Web', EffectiveReach: 'Web', text: 'Web only' },
    { Reach: 'Both', EffectiveReach: 'Both', text: 'web overlays and poster images in native TV and phone apps' },
    { Reach: 'Both', EffectiveReach: 'Web', text: 'Web only (native poster tags are off)' }
  ];
  for (const reach of cases) {
    const registry = registryDefault.map(e => e.Key === 'QualityTagsEnabled' ? { ...e, Reach: reach.Reach, EffectiveReach: reach.EffectiveReach } : e);
    const h = setup(t, { registry });
    await h.policy.decorate(h.page);
    const label = h.page.querySelector('#qualityTagsEnabled').closest('label');
    /** Checks the current replacement chip's visible state and exact tooltip/accessible name. */
    const check = (text, icon, title, locked, partial = false) => {
      const chips = label.querySelectorAll('a.je-user-default-chip');
      assert.equal(chips.length, 1);
      const chip = chips[0];
      assert.equal(chipText(chip), text);
      assert.equal(chip.querySelector('.material-icons').textContent, icon);
      assert.equal(chip.classList.contains('je-user-default-chip-locked'), locked);
      assert.equal(chip.classList.contains('je-user-default-chip-partial'), partial);
      assert.equal(chip.title, title);
      assert.equal(chip.getAttribute('aria-label'), title);
    };
    const unlocked = 'User default: each user starts with this value and can change it in their Jellyfin Enhanced panel. Applies to: ' + reach.text + '. Click to lock it in User settings policy.';
    check('User default', 'person', unlocked, false);
    h.tick('QualityTagsPosition');
    const partiallyLocked = 'User default: 1 of 2 of these settings are locked for every user; the rest each user can change in their Jellyfin Enhanced panel. Applies to: ' + reach.text + '. Click to change them in User settings policy.';
    check('1 of 2 locked', 'lock', partiallyLocked, false, true);
    h.tick('QualityTagsEnabled');
    check('Locked for users', 'lock', "Locked for every user: users get this value and can't change it. Applies to: " + reach.text + '. Click to change it in User settings policy.', true);
    h.tick('QualityTagsPosition', false);
    check('1 of 2 locked', 'lock', partiallyLocked, false, true);
    h.tick('QualityTagsEnabled', false);
    check('User default', 'person', unlocked, false);
  }
});

test('a group of three defaults counts locks and saved locks initialise the chip', async t => {
  const registry = [
    ...registryDefault,
    { ...registryDefault.find(e => e.Key === 'QualityTagsPosition'), Key: 'ExtraGroupedDefault' }
  ].map(e => e.Key === 'QualityTagsEnabled' ? { ...e, Locked: true } : e);
  const h = setup(t, { registry });
  await h.policy.decorate(h.page);
  const label = h.page.querySelector('#qualityTagsEnabled').closest('label');
  assert.equal(chipText(label.querySelector('a')), '1 of 3 locked');
  assert.equal(label.querySelector('a').classList.contains('je-user-default-chip-partial'), true);
  assert.equal(label.querySelector('a').classList.contains('je-user-default-chip-locked'), false);
  h.tick('QualityTagsPosition');
  assert.equal(chipText(label.querySelector('a')), '2 of 3 locked');
  h.tick('ExtraGroupedDefault');
  assert.equal(chipText(label.querySelector('a')), 'Locked for users');
  assert.equal(label.querySelectorAll('a.je-user-default-chip').length, 1);
});

test('chip clicks cancel their own default without a delegated jump handler', async t => {
  const h = setup(t);
  await h.policy.decorate(h.page);
  for (const id of ['autoPipEnabled', 'qualityTagsEnabled', 'showResolutionTag']) {
    const chip = h.document.getElementById(id).closest('label').querySelector('a.je-user-default-chip');
    for (const target of [chip, chip.querySelector('i')]) {
      for (const detail of [1, 0]) {
        const click = new h.window.MouseEvent('click', { bubbles: true, cancelable: true, detail });
        target.dispatchEvent(click);
        assert.equal(click.defaultPrevented, true, 'the chip listener cancels link and nested icon clicks');
      }
    }
  }
});

test('chip clicks still reach the real delegated jump handler and ordinary label clicks toggle', async t => {
  const h = setup(t);
  await h.policy.decorate(h.page);
  assert.ok(jumpHandlerSource, 'the page has its delegated jump handler');
  const jumps = [];
  h.window.jeJumpToTab = (tab, target) => jumps.push({ tab, target });
  h.window.eval('(function (form) {\n' + jumpHandlerSource + '\n})(document.querySelector("#JellyfinEnhancedPage form"));');
  for (const id of ['autoPipEnabled', 'qualityTagsEnabled', 'showResolutionTag']) {
    const checkbox = h.page.querySelector('#' + id);
    const label = checkbox.closest('label');
    const chip = label.querySelector('a.je-user-default-chip');
    for (const checked of [false, true]) {
      checkbox.checked = checked;
      const before = jumps.length;
      chip.querySelector('i').click();
      // jsdom skips checkbox label activation inside a link even without cancellation.
      assert.equal(checkbox.checked, checked);
      assert.equal(jumps.length, before + 1);
      assert.deepEqual(jumps.at(-1), { tab: 'admin', target: chip.dataset.jumpTarget });
      chip.focus();
      assert.equal(h.document.activeElement, chip);
      // jsdom does not synthesise Enter activation; dispatch a keyboard-style click (detail 0).
      const click = new h.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 });
      chip.dispatchEvent(click);
      assert.equal(checkbox.checked, checked);
      assert.equal(jumps.length, before + 2);
    }
    // Ordinary label activation still works.
    checkbox.checked = false;
    label.querySelector('span').click();
    assert.equal(checkbox.checked, true);
  }
});

test('ticking a lock explains its effect before saving and marks the form changed until saved', async t => {
  const native = registryDefault.map(e => e.Key === 'QualityTagsEnabled' ? { ...e, EffectiveReach: 'Both' } : e);
  const h = setup(t, { registry: native });
  await h.policy.decorate(h.page);
  assert.equal(h.policy.pendingState(), '');
  const impact = h.document.querySelector('#jeUserSettingsPolicyImpact');
  assert.equal(impact.hidden, true);

  h.page.querySelector('#autoPipEnabled').checked = true; // an unsaved admin default goes with the lock
  h.tick('AutoPipEnabled');
  h.tick('QualityTagsEnabled');
  assert.equal(h.policy.pendingState(), 'AutoPipEnabled=true,QualityTagsEnabled=true');
  assert.equal(impact.hidden, false);
  assert.match(impact.textContent, /Locking Auto Picture-in-Picture on tab switch to On: users who chose something else will see On\. Their choice is kept and comes back if you unlock\./);
  assert.match(impact.textContent, /Locking Enable Quality Tags to Off: .*Applies to web overlays and to poster images in native TV and phone apps\./);
  const pipChip = h.page.querySelector('#autoPipEnabled').closest('label').querySelector('a.je-user-default-chip');
  assert.equal(chipText(pipChip), 'Locked for users');
  assert.ok(pipChip.classList.contains('je-user-default-chip-locked'));
  assert.match(h.document.querySelector('#jeUserSettingsPolicySummaryCount').textContent, /2 locked$/);

  h.tick('QualityTagsEnabled', false);
  assert.equal(h.policy.pendingState(), 'AutoPipEnabled=true');
  h.policy.markSaved(h.policy.applyLocks([]));
  assert.equal(h.policy.pendingState(), '');
  assert.equal(impact.hidden, true);
});

test('the impact text follows the admin value when the control (or the tag order) changes after the lock is ticked', async t => {
  const h = setup(t);
  await h.policy.decorate(h.page);
  const impact = h.document.querySelector('#jeUserSettingsPolicyImpact');
  const pip = h.page.querySelector('#autoPipEnabled');
  pip.checked = false;
  h.tick('AutoPipEnabled');
  assert.match(impact.textContent, /Locking Auto Picture-in-Picture on tab switch to Off:/);

  pip.checked = true;
  pip.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.match(impact.textContent, /Locking Auto Picture-in-Picture on tab switch to On: users who chose something else will see On\./);
  assert.doesNotMatch(impact.textContent, /to Off/);

  // A select-backed setting.
  const select = h.page.querySelector('#watchProgressDefaultMode');
  h.tick('WatchProgressMode');
  select.value = 'time';
  select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  const option = [...select.options].find(entry => entry.value === 'time').textContent.trim();
  assert.ok(impact.textContent.includes(' to ' + option + ': users who chose something else will see ' + option + '.'));

  // A tag order row moved by its arrows (the page moves the row element).
  h.tick('ResolutionTagOrder');
  assert.match(impact.textContent, /to position 1:/);
  assert.ok(categoryArrowsSource.every(Boolean), 'the page still has its category arrows');
  h.window.eval(categoryArrowsSource.join('\n'));
  const container = h.page.querySelector('#qualityCategoriesAdmin');
  const order = () => [...container.querySelectorAll('[data-order-key]')].map(row => row.dataset.orderKey);
  // Chips sit inside their rows, so the arrows (which swap a row with the next element) still work.
  assert.deepEqual([...container.children].filter(child => !child.matches('.je-quality-cat-admin-row, .fieldDescription')), []);
  container.querySelector('[data-order-key="ResolutionTagOrder"] .je-cat-down').click();
  assert.deepEqual(order().slice(0, 2), ['SourceTagOrder', 'ResolutionTagOrder']);
  const movedChip = container.querySelector('[data-order-key="ResolutionTagOrder"] label > span > a.je-user-default-chip');
  assert.equal(chipText(movedChip), '1 of 2 locked');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(impact.textContent, /to position 2:/);
  assert.doesNotMatch(impact.textContent, /to position 1:/);

  // A control with no lock change leaves the text as it is.
  const before = impact.textContent;
  const other = h.page.querySelector('#showFileSizes');
  other.checked = !other.checked;
  other.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.equal(impact.textContent, before);
});

test('unticking a lock says each user\'s saved value comes back and only followers keep the default', async t => {
  // An unlocked key resolves to the default only for users who follow it; anyone else gets the
  // stored value back, even one who never changed it (a copy of an older default).
  const locked = registryDefault.map(e => e.Key === 'AutoPipEnabled' ? { ...e, Locked: true } : e);
  const h = setup(t, { registry: locked });
  await h.policy.decorate(h.page);
  h.page.querySelector('#autoPipEnabled').checked = false;
  h.tick('AutoPipEnabled', false);
  const impact = h.document.querySelector('#jeUserSettingsPolicyImpact').textContent;
  assert.match(impact, /Unlocking Auto Picture-in-Picture on tab switch: each user's saved value comes back \(for users who never changed it, this can be a value copied from an earlier default\); users who follow your default keep it \(Off\)\./);
  assert.doesNotMatch(impact, /never changed it keep your default/);
});

test('saving locks: fetched minus unticked rendered rows plus ticked ones; unknown keys keep their lock', async t => {
  const locked = registryDefault.map(e => e.Key === 'AutoPipEnabled' || e.Key === 'ShowFileSizes' ? { ...e, Locked: true } : e);
  const h = setup(t, { registry: locked });
  await h.policy.decorate(h.page);
  assert.equal(h.row('AutoPipEnabled').querySelector('input').checked, true);
  h.tick('ShowFileSizes', false);
  h.tick('QualityTagsEnabled');
  // Another admin added a lock since this page loaded, a renamed key lingers, and the case differs.
  const fetched = ['autopipenabled', 'ShowFileSizes', 'NotASetting', 'GenreTagsEnabled'];
  assert.deepEqual(h.policy.applyLocks(fetched).sort(), ['AutoPipEnabled', 'NotASetting', 'QualityTagsEnabled'].sort());
  // GenreTagsEnabled was rendered unticked (it was not locked when the rows were rendered), so it is unlocked.

  const config = { LockedUserSettings: fetched.slice() };
  assert.equal(h.applyLocks(config), true);
  assert.deepEqual(config.LockedUserSettings.sort(), ['AutoPipEnabled', 'NotASetting', 'QualityTagsEnabled'].sort());
});

test('admin save with the policy script blocked, failed or still loading leaves the locks exactly as they were', async t => {
  // Script never loaded (blocked by an extension, 404, no version).
  const blocked = createHarness({ html: pageMarkup });
  t.after(() => blocked.close());
  blocked.allowConsoleError(/Could not parse CSS stylesheet/);
  blocked.allowConsoleError(/user settings policy not ready/);
  const applyBlocked = blocked.window.eval(`(${applyLocksSource})`);
  const warnings = [];
  blocked.window.console.warn = (...args) => warnings.push(args.join(' '));
  const config = { LockedUserSettings: ['AutoPipEnabled', 'NotASetting'], Other: 1 };
  assert.equal(applyBlocked(config), false);
  assert.deepEqual(config, { LockedUserSettings: ['AutoPipEnabled', 'NotASetting'], Other: 1 });
  const status = blocked.document.querySelector('#jeUserSettingsPolicyStatus');
  assert.equal(status.textContent, 'The user settings policy had not loaded, so this save left the user settings locks as they were.');
  assert.ok(status.classList.contains('je-policy-status-error'));
  assert.match(warnings.join('\n'), /LockedUserSettings left unchanged/);

  // Script loaded but the registry request failed.
  const failed = setup(t, { ajax: async () => { throw new Error('offline'); } });
  failed.window.console.warn = () => {};
  assert.equal(await failed.policy.decorate(failed.page), false);
  assert.equal(failed.policy.ready, false);
  assert.equal(failed.policy.applyLocks(['AutoPipEnabled']), null);
  assert.match(failed.document.querySelector('#jeUserSettingsPolicyStatus').textContent, /could not be loaded.*Saving keeps the current locks/);
  const failedConfig = { LockedUserSettings: ['AutoPipEnabled'] };
  assert.equal(failed.applyLocks(failedConfig), false);
  assert.deepEqual(failedConfig.LockedUserSettings, ['AutoPipEnabled']);

  // Still loading: not ready until the rows are rendered.
  const gate = deferred();
  const loading = setup(t, { ajax: () => gate.promise });
  const pending = loading.policy.decorate(loading.page);
  const loadingConfig = { LockedUserSettings: ['ShowFileSizes'] };
  loading.window.console.warn = () => {};
  assert.equal(loading.applyLocks(loadingConfig), false);
  assert.deepEqual(loadingConfig.LockedUserSettings, ['ShowFileSizes']);
  gate.resolve(structuredClone(registryDefault));
  assert.equal(await pending, true);
});

test('a lock edited while the rows reload (pageshow) is kept; older edits are reset to the server state', async t => {
  let gate = null;
  const h = setup(t, { ajax: async () => { if (gate) await gate.promise; return structuredClone(registryDefault); } });
  await h.policy.decorate(h.page);
  h.tick('ShowFileSizes'); // before the reload: discarded like every other unsaved field
  gate = deferred();
  const reload = h.policy.decorate(h.page);
  assert.equal(h.policy.ready, false, 'rows from the last visit are not trusted while they reload');
  h.tick('AutoPipEnabled'); // during the reload: kept
  // A save during the reload leaves the locks as fetched (another admin's lock included), and
  // the edit made during the reload stays pending.
  h.window.console.warn = () => {};
  const config = { LockedUserSettings: ['GenreTagsEnabled'] };
  assert.equal(h.applyLocks(config), false);
  assert.deepEqual(config.LockedUserSettings, ['GenreTagsEnabled']);
  assert.match(h.document.querySelector('#jeUserSettingsPolicyStatus').textContent, /had not loaded, so this save left the user settings locks as they were/);
  h.policy.markSaved(config.LockedUserSettings); // the page calls it after every save; this one took no locks
  gate.resolve();
  assert.equal(await reload, true);
  assert.equal(h.policy.ready, true);
  assert.equal(h.document.querySelector('#jeUserSettingsPolicyStatus').hidden, true);
  assert.equal(h.row('ShowFileSizes').querySelector('input').checked, false);
  assert.equal(h.row('AutoPipEnabled').querySelector('input').checked, true);
  assert.equal(h.policy.pendingState(), 'AutoPipEnabled=true');
});

test('a revisit whose registry request fails leaves the locks alone, whatever the old rows show', async t => {
  let fail = false;
  const h = setup(t, { ajax: async () => { if (fail) throw new Error('offline'); return structuredClone(registryDefault); } });
  await h.policy.decorate(h.page);
  assert.equal(h.policy.ready, true);
  h.tick('ShowFileSizes'); // abandoned on this visit; the next visit's form reload drops it
  // Meanwhile another admin locks AutoPipEnabled; this page comes back and the reload fails.
  fail = true;
  h.window.console.warn = () => {};
  assert.equal(await h.policy.decorate(h.page), false);
  assert.equal(h.policy.ready, false);
  assert.equal(h.policy.applyLocks(['AutoPipEnabled']), null);
  const status = h.document.querySelector('#jeUserSettingsPolicyStatus');
  assert.equal(status.hidden, false);
  assert.match(status.textContent, /could not be loaded.*Saving keeps the current locks/);
  const config = { LockedUserSettings: ['AutoPipEnabled'] };
  assert.equal(h.applyLocks(config), false);
  assert.deepEqual(config.LockedUserSettings, ['AutoPipEnabled']);
  // The next visit that loads makes the rows usable again, from the server's locks.
  fail = false;
  const locked = registryDefault.map(e => e.Key === 'AutoPipEnabled' ? { ...e, Locked: true } : e);
  h.window.ApiClient.ajax = async () => structuredClone(locked);
  assert.equal(await h.policy.decorate(h.page), true);
  assert.equal(h.policy.ready, true);
  assert.equal(status.hidden, true);
  assert.equal(h.row('AutoPipEnabled').querySelector('input').checked, true);
  assert.equal(h.row('ShowFileSizes').querySelector('input').checked, false);
  assert.deepEqual(h.policy.applyLocks(['AutoPipEnabled']), ['AutoPipEnabled']);
});

test('a failed save built from the table is never confirmed by a later save that left the locks alone', async t => {
  const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  let fail = false;
  let gate = null;
  const h = setup(t, { ajax: async (request) => {
    h.requests.push(request.url);
    if (gate) await gate.promise;
    if (fail) throw new Error('offline');
    return structuredClone(registryDefault);
  } });
  h.window.console.warn = () => {};
  await h.policy.decorate(h.page);
  h.tick('AutoPipEnabled');
  const failedSave = { LockedUserSettings: [] };
  assert.equal(h.applyLocks(failedSave), true); // updatePluginConfiguration then rejects: no markSaved
  h.tick('ShowFileSizes'); // abandoned with the visit, like every other unsaved field

  // The revisit's reload fails; a save meanwhile leaves the locks alone and its markSaved is a no-op.
  fail = true;
  assert.equal(await h.policy.decorate(h.page), false);
  fail = false;
  const notReadySave = { LockedUserSettings: ['GenreTagsEnabled'] };
  assert.equal(h.applyLocks(notReadySave), false);
  const requestsBefore = h.requests.length;
  h.policy.markSaved(notReadySave.LockedUserSettings);
  await settle();
  assert.equal(h.requests.length, requestsBefore, 'no reload started from the failed save');
  assert.equal(h.policy.ready, false);
  // The next pageshow resets both abandoned ticks.
  assert.equal(await h.policy.decorate(h.page), true);
  assert.equal(h.policy.pendingState(), '');

  // Same with a pageshow reload still in flight: it is not replaced, and the abandoned tick is dropped.
  h.tick('AutoPipEnabled');
  assert.ok(Array.isArray(h.policy.applyLocks([]))); // a save that fails
  h.tick('ShowFileSizes');
  gate = deferred();
  const reload = h.policy.decorate(h.page);
  const duringReload = { LockedUserSettings: [] };
  assert.equal(h.applyLocks(duringReload), false);
  const registryReads = () => h.requests.filter(url => url.endsWith('/registry')).length;
  const requestsDuring = registryReads();
  h.policy.markSaved(duringReload.LockedUserSettings);
  gate.resolve();
  assert.equal(await reload, true);
  await settle();
  assert.equal(registryReads(), requestsDuring);
  assert.equal(h.policy.ready, true);
  assert.equal(h.row('ShowFileSizes').querySelector('input').checked, false);
  assert.equal(h.policy.pendingState(), '');

  // A copy of a built list does not count either; only the list applyLocks returned for the save does.
  h.tick('AutoPipEnabled');
  const built = h.policy.applyLocks([]);
  h.policy.markSaved(built.slice());
  assert.equal(h.policy.pendingState(), 'AutoPipEnabled=true');
  h.policy.markSaved(built);
  assert.equal(h.policy.pendingState(), '');
});

test('a lock edited while a save is in flight is kept as an unsaved edit after the save', async t => {
  let answer = registryDefault;
  const h = setup(t, { ajax: async () => structuredClone(answer) });
  await h.policy.decorate(h.page);
  h.tick('AutoPipEnabled');
  const saved = h.policy.applyLocks([]); // the save is built from the boxes here
  assert.deepEqual(saved, ['AutoPipEnabled']);
  h.tick('ShowFileSizes'); // ticked while the save is in flight: not part of it
  answer = registryDefault.map(e => e.Key === 'AutoPipEnabled' ? { ...e, Locked: true } : e);
  h.policy.markSaved(saved);
  assert.equal(h.policy.pendingState(), 'ShowFileSizes=true');
  // markSaved reads the registry again and re-renders the rows.
  for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(h.row('AutoPipEnabled').querySelector('input').checked, true);
  assert.equal(h.row('ShowFileSizes').querySelector('input').checked, true, 'the in-flight edit is not reverted');
  assert.equal(h.policy.pendingState(), 'ShowFileSizes=true');
  assert.match(h.document.querySelector('#jeUserSettingsPolicyImpact').textContent, /^Locking .*Locks take effect when you save\.$/);
  // A pageshow reload still resets edits made before it started.
  await h.policy.decorate(h.page);
  assert.equal(h.row('ShowFileSizes').querySelector('input').checked, false);
  assert.equal(h.policy.pendingState(), '');
});

test('registry values and page labels are written as text, never as markup', async t => {
  const hostile = '<img src=x onerror="window.__pwned=1">';
  const registry = registryDefault.map(e => e.Key === 'DisplayLanguage' ? { ...e, AdminValue: hostile } : e);
  const h = setup(t, { registry });
  h.page.querySelector('#autoPipEnabled').closest('label').querySelector('span').textContent = '<b onclick="x()">Auto PiP</b>';
  await h.policy.decorate(h.page);
  h.tick('AutoPipEnabled');
  const fieldset = h.document.querySelector('#jeUserSettingsPolicy');
  assert.equal(fieldset.querySelector('img'), null);
  assert.equal(fieldset.querySelector('b'), null);
  assert.equal(h.row('DisplayLanguage').children[1].textContent, hostile);
  assert.equal(h.row('AutoPipEnabled').querySelector('th').textContent, '<b onclick="x()">Auto PiP</b>');
  assert.match(fieldset.querySelector('#jeUserSettingsPolicyImpact').textContent, /Locking <b onclick="x\(\)">Auto PiP<\/b> to Off/);
  assert.equal(h.window.__pwned, undefined);
});

test('the page says so when the policy script cannot be loaded, and a later visit tries again', async t => {
  assert.ok(loaderSource, 'the policy loader is in configPage.html');
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const status = h => h.document.querySelector('#jeUserSettingsPolicyStatus');
  const failure = /could not be loaded, so locks cannot be changed right now\. Saving keeps the current locks\./;

  // No client tag and /version fails or answers 'unknown': nothing to load, and the fieldset says so.
  for (const answer of [async () => { throw new Error('offline'); }, async () => ({ ok: true, text: async () => 'unknown' })]) {
    const h = createHarness({ html: pageMarkup, fetch: answer });
    t.after(() => h.close());
    h.allowConsoleError(/Could not parse CSS stylesheet/);
    assert.match(status(h).textContent, /^Loading/);
    h.window.eval(`var jeCssVersion = null; ${loaderSource}`);
    await settle(); await settle();
    assert.match(status(h).textContent, failure);
    assert.ok(status(h).classList.contains('je-policy-status-error'));
    assert.equal(h.document.querySelector('script[data-je-admin-policy]'), null);
  }

  // The script fails to load: the status says so and the failed element is removed, so the next
  // visit (the page's inline script runs again with a new view) adds a fresh one.
  const h = createHarness({ html: pageMarkup,
    apiClient: { getUrl: (path, params) => `http://jellyfin.test${path}${params ? '?' + new URLSearchParams(params) : ''}` } });
  t.after(() => h.close());
  h.allowConsoleError(/Could not parse CSS stylesheet/);
  h.window.eval(`var jeCssVersion = '1.2.3'; ${loaderSource}`);
  const first = h.document.querySelector('script[data-je-admin-policy="1.2.3"]');
  assert.match(first.getAttribute('src'), /\/JellyfinEnhanced\/js\/admin\/user-settings-policy\.js\?v=1\.2\.3$/);
  first.onerror();
  assert.equal(first.isConnected, false);
  assert.match(status(h).textContent, failure);
  h.window.eval(`var jeCssVersion = '1.2.3'; ${loaderSource}`);
  const second = h.document.querySelector('script[data-je-admin-policy="1.2.3"]');
  assert.ok(second && second !== first, 'retried');
  // While one is loading (or loaded), another visit does not add a second copy.
  h.window.eval(`var jeCssVersion = '1.2.3'; ${loaderSource}`);
  assert.equal(h.document.querySelectorAll('script[data-je-admin-policy]').length, 1);
});

test('"New users follow my defaults" sits in the policy header, is loaded and saved, and counts as an unsaved edit', async t => {
  // Design item C3: an ordinary admin checkbox (unlike the lock boxes the policy script renders).
  const h = setup(t);
  await h.policy.decorate(h.page);
  const box = h.document.getElementById('newUsersFollowDefaults');
  const fieldset = h.document.getElementById('jeUserSettingsPolicy');
  assert.ok(box && fieldset.contains(box), 'the checkbox is in the policy fieldset');
  assert.ok(box.compareDocumentPosition(h.document.getElementById('jeUserSettingsPolicyDetails')) & h.window.Node.DOCUMENT_POSITION_FOLLOWING,
    'above the lock table');
  assert.equal(box.checked, false);
  assert.match(pageSource, /document\.querySelector\('#newUsersFollowDefaults'\)\.checked = config\.NewUsersFollowDefaults === true;/);
  assert.match(pageSource, /config\.NewUsersFollowDefaults = document\.querySelector\('#newUsersFollowDefaults'\)\.checked;/);

  // The page's dirty walk takes the checkbox, and still leaves the lock boxes to the policy script.
  const trackedSource = /function jeTrackedControls\(\) \{[\s\S]*?\n            \}/.exec(pageSource)?.[0];
  assert.ok(trackedSource, 'jeTrackedControls is in configPage.html');
  const tracked = h.window.eval(`(function (form) { return ${trackedSource}; })`)(h.document.querySelector('#JellyfinEnhancedForm'));
  const keys = tracked().map(control => control.key);
  assert.ok(keys.includes('newUsersFollowDefaults'));
  assert.equal(tracked().filter(control => control.el.closest('#jeUserSettingsPolicyTable')).length, 0);
});

// Round 4 made an edit inside loadConfig's 500 ms settling window stay unsaved: the baseline is taken
// with the edited controls showing their loaded values, then their current values are put back.
test('an early click on the other maintenance-users radio stays the selection and stays unsaved', async t => {
  const captureSource = /function jeCaptureSavedStateAsLoaded\(loaded, edited\) \{[\s\S]*?\n            \}/.exec(pageSource)?.[0];
  assert.ok(captureSource, 'jeCaptureSavedStateAsLoaded is in configPage.html');
  const h = setup(t);
  const form = h.document.querySelector('#JellyfinEnhancedForm');
  const all = h.document.getElementById('mmUsers_all');
  const select = h.document.getElementById('mmUsers_select');
  const snapshot = () => ({ all: all.checked, select: select.checked });
  const capture = h.window.eval(`(function (jeCaptureSavedState) { return ${captureSource}; })`)(snapshot);
  const loadedPair = () => new Map(Array.from(form.querySelectorAll('input[name="maintenanceModeUsers"]')).map(el => [el, el.checked]));

  // Loaded with "All users"; the admin clicks "Select users" before the baseline.
  all.checked = true;
  let loaded = loadedPair();
  select.checked = true;
  assert.deepEqual(capture(loaded, new Set([select])), { all: true, select: false }, 'the baseline is the loaded selection');
  assert.deepEqual(snapshot(), { all: false, select: true }, 'the click is still the selection (saved as "select")');

  // The other way round.
  loaded = loadedPair();
  all.checked = true;
  assert.deepEqual(capture(loaded, new Set([all])), { all: false, select: true });
  assert.deepEqual(snapshot(), { all: true, select: false });
});
