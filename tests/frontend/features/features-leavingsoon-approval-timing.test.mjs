import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

/** The Leaving soon page over the real UI kit, with the plugin's list route mocked. */
function setup(t, data) {
  const calls = [];
  const h = createHarness({
    html: '<div id="host"></div>',
    JE: {
      pluginConfig: { LeavingSoonPageEnabled: true, LeavingSoonProvider: 'reclaimerr', ToastDuration: 1500 },
      t: (key, params) => params ? `${key}:${Object.values(params).join('|')}` : key,
      session: { onUserChange: () => {} },
    },
    apiClient: {
      ajax: async ({ type, url, data: body }) => {
        const path = new URL(url).pathname.replace('/JellyfinEnhanced/', '');
        calls.push({ type, path, body: body ? JSON.parse(body) : null });
        if (path === 'leaving-soon/list') return data;
        return { ok: true };
      },
    },
  });
  t.after(() => h.close());
  for (const file of ['enhanced/config.js', 'core/ui-kit.js', 'extras/leavingsoon-page.js']) h.load(file);
  const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
  const $ = (sel) => h.document.querySelector(sel);
  const $$ = (sel) => Array.from(h.document.querySelectorAll(sel));
  const choose = (select, value) => { select.value = value; select.dispatchEvent(new h.window.Event('change', { bubbles: true })); };
  return { ...h, calls, settle, $, $$, choose };
}

const request = { id: 7, title: '12th Fail', year: 2023, mediaType: 'movie', requestedBy: 'sam', status: 'pending', scope: 'movie' };
const base = (extra = {}) => ({ provider: 'reclaimerr', admin: true, canRequest: true, actions: true, items: [], requests: [request], mine: [], ...extra });
const approveBody = (h) => h.calls.find((c) => c.path === 'reclaimerr/requests/7/approve').body;

test('without scheduling support the approve step is unchanged: no choice of when, the body carries no timing', async t => {
  const h = setup(t, base({ canSchedule: false }));
  h.JE.leavingSoonPage.renderForCustomTab(h.$('#host'));
  await h.settle();
  h.$('.je-ls-icon-btn.approve').click();
  assert.equal(h.$('.je-ls-reqactions select'), null, 'an older Reclaimerr would delete at once whatever day was picked');
  assert.equal(h.$('.je-ls-btn.danger').textContent, 'leavingsoon_delete_now');
  h.$('.je-ls-btn.danger').click();
  await h.settle();
  assert.deepEqual(approveBody(h), {});
});

test('with scheduling support an approval is sent with the grace period, now, or a chosen day', async t => {
  for (const [when, expected, warning] of [
    ['default', { when: 'default' }, 'leavingsoon_confirm_grace'],
    ['now', { when: 'now' }, 'leavingsoon_confirm_delete'],
  ]) {
    const h = setup(t, base({ canSchedule: true }));
    h.JE.leavingSoonPage.renderForCustomTab(h.$('#host'));
    await h.settle();
    h.$('.je-ls-icon-btn.approve').click();
    assert.deepEqual(Array.from(h.$$('.je-ls-reqactions select option')).map((o) => o.value), ['default', 'now', 'date']);
    assert.equal(h.$('.je-ls-reqactions select').value, 'default', 'Reclaimerr\'s own setting is the default');
    assert.equal(h.$('.je-ls-btn.danger').textContent, 'leavingsoon_approve');
    for (const option of h.$$('.je-ls-reqactions select option')) assert.notEqual(option.style.backgroundColor, '', 'the popup options get their own opaque colours, so they read on any theme');
    assert.notEqual(h.$('.je-ls-reqactions select').style.colorScheme, '', 'the popup follows the theme\'s light or dark');
    h.choose(h.$('.je-ls-reqactions select'), when);
    assert.equal(h.$('.je-ls-warn').textContent, warning);
    h.$('.je-ls-btn.danger').click();
    await h.settle();
    assert.deepEqual(approveBody(h), expected);
  }
});

test('a chosen day is sent as that moment in UTC, shown in the warning, and a day that is not in the future cannot be approved', async t => {
  const h = setup(t, base({ canSchedule: true }));
  h.JE.leavingSoonPage.renderForCustomTab(h.$('#host'));
  await h.settle();
  h.$('.je-ls-icon-btn.approve').click();
  const select = h.$('.je-ls-reqactions select');
  const day = h.$('.je-ls-reqactions input[type="datetime-local"]');
  assert.equal(day.hidden, true, 'only shown for "Choose a date"');
  h.choose(select, 'date');
  assert.equal(day.hidden, false);
  assert.match(h.$('.je-ls-warn').textContent, /^leavingsoon_confirm_on:/);

  day.value = '2020-01-01T10:00';
  day.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.equal(h.$('.je-ls-btn.danger').disabled, true, 'the past cannot be scheduled');

  const future = new Date(Date.now() + 10 * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  day.value = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}`;
  day.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.equal(h.$('.je-ls-btn.danger').disabled, false);
  h.$('.je-ls-reqactions input[type="text"]').value = 'next week';
  h.$('.je-ls-btn.danger').click();
  await h.settle();
  assert.deepEqual(approveBody(h), { note: 'next week', when: 'date', date: new Date(day.value).toISOString() });
});

test('an approved request shows the day it is deleted, and a schedule that failed or is blocked shows as failed', async t => {
  const approved = { ...request, status: 'approved', scheduledAt: '2026-12-10T08:00:00' };
  const h = setup(t, base({
    canSchedule: true,
    requests: [
      { ...approved, id: 1 },
      { ...approved, id: 2, scheduleState: 'blocked', executionError: 'a person is watching' },
    ],
  }));
  h.JE.leavingSoonPage.renderForCustomTab(h.$('#host'));
  await h.settle();
  const [ok, blocked] = h.$$('.je-ls-reqcard');
  assert.match(ok.textContent, /leavingsoon_leaves_on:10 Dec 2026/, 'a time without a zone is read as UTC');
  assert.equal(ok.querySelectorAll('.je-ls-icon-btn').length, 0, 'an approved request is not reviewed again');
  assert.equal(blocked.querySelector('.je-ls-chip').textContent, 'leavingsoon_status_failed');
  assert.equal(blocked.querySelector('.je-ls-err').textContent, 'a person is watching');
});

test('the grace period is named in the choice and the warning when Reclaimerr says what it is', async t => {
  for (const [graceDays, label, warning] of [
    [14, 'leavingsoon_when_default_days:14', /^leavingsoon_confirm_on:/],
    [0, 'leavingsoon_when_default', /^leavingsoon_confirm_delete$/],
    [undefined, 'leavingsoon_when_default', /^leavingsoon_confirm_grace$/],
  ]) {
    const h = setup(t, base({ canSchedule: true, graceDays }));
    h.JE.leavingSoonPage.renderForCustomTab(h.$('#host'));
    await h.settle();
    h.$('.je-ls-icon-btn.approve').click();
    assert.equal(h.$('.je-ls-reqactions select option[value="default"]').textContent, label);
    assert.match(h.$('.je-ls-warn').textContent, warning);
  }
});
