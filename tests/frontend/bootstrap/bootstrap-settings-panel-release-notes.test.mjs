import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// Design item A10 (review round 2): the release notes the panel opens are a labelled, focusable
// dialog that joins the panel's focus trap, holds open while focused and gives focus back on close.

const release = { tag_name: 'v1.2.3', published_at: '2026-10-01T00:00:00Z', html_url: 'https://github.com/owner/repo/releases/v1.2.3', body: 'Notes' };

function setup(t) {
  const timers = [];
  let nextId = 0;
  const h = createHarness({
    html: '<button id="releaseNotesBtn" type="button">Release notes</button>',
    fetch: async () => ({ ok: true, json: async () => release }),
    globals: {
      setTimeout: (fn, ms) => { const id = ++nextId; timers.push({ id, fn, ms, cleared: false }); return id; },
      clearTimeout: id => { const timer = timers.find(entry => entry.id === id); if (timer) timer.cleared = true; }
    },
    JE: { escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
      icon: () => '', IconName: new Proxy({}, { get: (target, name) => String(name) }), toast() {} }
  });
  t.after(() => h.close());
  h.load('enhanced/settingspanel/ui-release-notes.js');
  const show = h.JE.internals.enhancedUi.showReleaseNotesNotification;
  const notification = () => h.document.getElementById('jellyfin-release-notes-notification');
  const autoClose = () => timers.filter(timer => !timer.cleared && timer.ms === 20000);
  return { ...h, show, notification, autoClose };
}

test('the release notes open as a labelled dialog in the panel\'s focus cycle, with focus on them', async t => {
  const h = setup(t);
  h.document.getElementById('releaseNotesBtn').focus();
  await h.show();
  const notification = h.notification();
  assert.equal(notification.getAttribute('role'), 'dialog');
  assert.equal(notification.getAttribute('aria-label'), 'Latest Release Notes');
  assert.ok(notification.hasAttribute('data-je-panel-companion'), 'ui-panel.js keeps it in the Tab cycle');
  assert.ok(notification.classList.contains('focuscontainer'), 'jellyfin-web keeps D-pad navigation (layout=tv) inside it');
  assert.equal(h.document.activeElement, notification);
  const dismiss = notification.querySelectorAll('button.je-release-notes-dismiss');
  assert.equal(dismiss.length, 2);
  assert.equal(dismiss[0].getAttribute('aria-label'), 'Close');
  assert.equal(notification.querySelector('[onclick]'), null);
});

test('focus inside holds the notification open; leaving it restarts the auto-close', async t => {
  const h = setup(t);
  await h.show();
  assert.equal(h.autoClose().length, 1);
  const link = h.notification().querySelector('a[href]');
  link.focus();
  assert.equal(h.autoClose().length, 0, 'no auto-close while a keyboard user is reading');
  h.notification().querySelector('button').focus();
  assert.equal(h.autoClose().length, 0, 'moving inside keeps it open');
  h.document.getElementById('releaseNotesBtn').focus();
  assert.equal(h.autoClose().length, 1);
});

test('Escape and the Close buttons close only the notification and give focus back to the opener', async t => {
  for (const close of ['escape', 'close', 'x']) {
    await t.test(close, async st => {
      const h = setup(st);
      const opener = h.document.getElementById('releaseNotesBtn');
      opener.focus();
      await h.show();
      const notification = h.notification();
      const buttons = notification.querySelectorAll('button.je-release-notes-dismiss');
      let reachedDocument = false;
      h.document.addEventListener('keydown', () => { reachedDocument = true; });
      if (close === 'escape') {
        notification.querySelector('a[href]').focus();
        notification.querySelector('a[href]').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        assert.equal(reachedDocument, false, 'the panel underneath does not see the Escape');
      } else {
        const button = buttons[close === 'x' ? 0 : 1];
        button.focus();
        button.click();
      }
      assert.equal(h.notification(), null);
      assert.equal(h.document.activeElement, opener);
      assert.equal(h.autoClose().length, 0);
    });
  }
});

test('the mouse passing over does not end the focus hold; the timer never closes it under a focused control', async t => {
  for (const control of ['x', 'link', 'close']) {
    await t.test(control, async st => {
      const h = setup(st);
      await h.show();
      const notification = h.notification();
      const [opening] = h.autoClose();
      const target = control === 'link' ? notification.querySelector('a[href]')
        : notification.querySelectorAll('button.je-release-notes-dismiss')[control === 'x' ? 0 : 1];
      target.focus();
      notification.dispatchEvent(new h.window.MouseEvent('mouseenter'));
      notification.dispatchEvent(new h.window.MouseEvent('mouseleave'));
      assert.equal(h.autoClose().length, 0, 'mouseleave does not re-arm while a control inside has focus');
      // Even a timer that still fires (the one from opening) does not close it under the control.
      opening.fn();
      assert.ok(h.notification(), 'still open');
      assert.equal(h.document.activeElement, target);
      h.document.getElementById('releaseNotesBtn').focus();
      assert.equal(h.autoClose().length, 1, 'leaving the notification starts the auto-close again');
    });
  }
});

test('focus on the notification itself (as on opening) does not hold it open', async t => {
  const h = setup(t);
  await h.show();
  const notification = h.notification();
  assert.equal(h.document.activeElement, notification);
  notification.dispatchEvent(new h.window.MouseEvent('mouseenter'));
  notification.dispatchEvent(new h.window.MouseEvent('mouseleave'));
  const armed = h.autoClose();
  assert.equal(armed.length, 1);
  armed[0].fn();
  assert.equal(notification.style.transform, 'translateY(-50%) translateX(100%)', 'it slides out after 20 s');
});

test('layout=tv: an arrow key on the notification itself moves to its first control; elsewhere it does nothing', async t => {
  for (const tv of [true, false]) {
    await t.test(tv ? 'tv' : 'desktop', async st => {
      const h = setup(st);
      if (tv) h.document.documentElement.classList.add('layout-tv');
      await h.show();
      const notification = h.notification();
      const event = new h.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
      notification.dispatchEvent(event);
      if (tv) {
        assert.equal(h.document.activeElement, notification.querySelector('button.je-release-notes-dismiss'));
        assert.equal(event.defaultPrevented, true, 'jellyfin-web skips a prevented key, so focus is not moved twice');
      } else {
        assert.equal(h.document.activeElement, notification);
        assert.equal(event.defaultPrevented, false);
      }
    });
  }
});
