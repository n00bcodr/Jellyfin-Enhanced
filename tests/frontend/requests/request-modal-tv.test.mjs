import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

function setup(t, tv) {
  const h = createHarness({ JE: { t: key => key, escapeHtml: value => String(value) } });
  t.after(() => h.close());
  if (tv) h.document.documentElement.classList.add('layout-tv');
  h.load('core/ui-kit.js');
  h.load('jellyseerr/modal.js');
  const created = h.JE.jellyseerrModal.create({
    title: 'Title', subtitle: 'Sub', bodyHtml: h.JE.jellyseerrModal.createAdvancedOptionsHTML('movie'), onSave() {}
  });
  const select = created.modalElement.querySelector('#movie-quality');
  select.innerHTML = '<option value="1">HD</option><option value="2">4K</option>';
  select.value = '1';
  h.document.body.appendChild(created.modalElement);
  const key = (init, target = h.document.activeElement || h.document.body) => {
    const event = new h.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  return { h, created, select, key };
}

test('TV layout opens an in-dialog list for a select and applies the choice', t => {
  const { h, created, select, key } = setup(t, true);
  let changes = 0;
  select.addEventListener('change', () => changes++);
  assert.equal(key({ key: 'Enter' }, select).defaultPrevented, true);
  const picker = created.modalElement.querySelector('.jellyseerr-tv-picker');
  assert.ok(picker);
  const options = picker.querySelectorAll('button');
  assert.deepEqual([...options].map(o => o.textContent), ['HD', '4K']);
  assert.equal(h.document.activeElement, options[0]);
  options[1].click();
  assert.equal(select.value, '2');
  assert.equal(changes, 1);
  assert.equal(created.modalElement.querySelector('.jellyseerr-tv-picker'), null);
  assert.equal(h.document.activeElement, select);
});

test('Back closes only the list and not the dialog', t => {
  const { h, created, select, key } = setup(t, true);
  let popped = 0;
  h.window.history.back = () => popped++;
  key({ key: 'Enter' }, select);
  assert.ok(created.modalElement.querySelector('.jellyseerr-tv-picker'));
  key({ key: 'Escape' });
  assert.equal(created.modalElement.querySelector('.jellyseerr-tv-picker'), null);
  assert.equal(popped, 0);
  assert.equal(h.document.activeElement, select);
  key({ key: 'Unidentified', keyCode: 10009 }, select);
  assert.equal(popped, 0);
});

test('selects are left to the browser outside the TV layout', t => {
  const { created, select, key } = setup(t, false);
  assert.equal(key({ key: 'Enter' }, select).defaultPrevented, false);
  assert.equal(created.modalElement.querySelector('.jellyseerr-tv-picker'), null);
});
