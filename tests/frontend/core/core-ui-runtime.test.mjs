import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// Exercise the deployed IIFEs with actual DOM/MutationObserver behavior. Only time is controlled.
function setup(t, options = {}) {
    const h = createHarness(options);
    t.after(() => h.close());
    let next = 0;
    const timers = new Map(), frames = new Map();
    h.window.setTimeout = (callback, delay) => { const id = ++next; timers.set(id, { callback, delay }); return id; };
    h.window.clearTimeout = id => timers.delete(id);
    h.window.requestAnimationFrame = callback => { const id = ++next; frames.set(id, callback); return id; };
    h.window.cancelAnimationFrame = id => frames.delete(id);
    for (const name of ['dom-observer', 'ui-kit']) h.load(`core/${name}.js`);
    const timer = delay => {
        for (const [id, task] of [...timers]) if (task.delay === delay && timers.delete(id)) task.callback();
    };
    const frame = () => { for (const [id, callback] of [...frames]) if (frames.delete(id)) callback(); };
    return { ...h, dom: h.JE.core.dom, ui: h.JE.core.ui, timers, frames, timer, frame,
        paint() { frame(); timer(0); },
        async mutate() { h.document.body.append(h.document.createElement('div')); await Promise.resolve(); }
    };
}

test('body observer multiplexes, runs priorities synchronously and batches normal subscribers after paint', async t => {
    const h = setup(t), seen = [], batches = [];
    h.dom.onBodyMutation('normal', records => batches.push(records.length));
    h.dom.onBodyMutation('low', () => seen.push('low'), { priority: 2 });
    h.dom.onBodyMutation('high', () => seen.push('high'), { priority: 5 });
    await h.mutate(); await h.mutate();
    assert.deepEqual(seen, ['high', 'low', 'high', 'low']); assert.deepEqual(batches, []);
    assert.equal(h.frames.size, 1); assert.equal(h.timers.size, 1);
    h.frame(); assert.deepEqual(batches, []); h.timer(0);
    assert.deepEqual(batches, [2]); assert.equal(h.timers.size, 0);
});

test('paint fallback runs once in hidden tabs and cancels its stale frame', t => {
    const h = setup(t), seen = [];
    h.dom.afterNextPaint(() => seen.push(1)); h.dom.afterNextPaint(() => seen.push(2));
    h.timer(250); assert.deepEqual(seen, [1, 2]); assert.equal(h.frames.size, 0);
    h.paint(); assert.deepEqual(seen, [1, 2]);
});

test('paint callbacks isolate exceptions and callbacks queued during delivery wait for another paint', t => {
    const h = setup(t), seen = [];
    h.expectConsoleError('Error in afterNextPaint callback');
    h.dom.afterNextPaint(() => { h.dom.afterNextPaint(() => seen.push('later')); throw Error('failed'); });
    h.dom.afterNextPaint(() => seen.push('current'));
    h.paint(); assert.deepEqual(seen, ['current']); h.paint(); assert.deepEqual(seen, ['current', 'later']);
});

test('player clock/cue noise is ignored but mixed batches retain all original records', async t => {
    const h = setup(t, { html: '<div class="osdPositionText"><span></span></div><div class="videoSubtitlesInner"></div>' });
    const batches = []; h.dom.onBodyMutation('watch', records => batches.push(records), { priority: 1 });
    h.document.querySelector('.osdPositionText span').textContent = '10';
    h.document.querySelector('.videoSubtitlesInner').innerHTML = '<i>cue</i>';
    await Promise.resolve(); assert.equal(batches.length, 0);
    h.document.querySelector('.osdPositionText span').textContent = '11';
    await h.mutate(); assert.equal(batches.length, 1); assert.equal(batches[0].length, 2);
});

test('replaced and newly registered subscribers never receive previously queued mutations', async t => {
    const h = setup(t), seen = [];
    h.dom.onBodyMutation('keep', () => seen.push('keep'));
    const old = h.dom.onBodyMutation('same', () => seen.push('old'));
    await h.mutate();
    h.dom.onBodyMutation('same', () => seen.push('replacement'));
    h.dom.onBodyMutation('new', () => seen.push('new')); old.disconnect();
    h.paint(); assert.deepEqual(seen, ['keep']);
    await h.mutate(); h.paint(); assert.deepEqual(seen, ['keep', 'keep', 'replacement', 'new']);
});

test('priority teardown and resubscription cannot queue old records into the new generation', async t => {
    const h = setup(t), seen = [];
    h.dom.onBodyMutation('teardown', () => {
        h.dom.disconnectAllObservers();
        h.dom.onBodyMutation('next', () => seen.push('next'));
    }, { priority: 1 });
    await h.mutate(); h.paint(); assert.deepEqual(seen, []);
    await h.mutate(); h.paint(); assert.deepEqual(seen, ['next']);
});

test('priority removal/replacement uses subscription identity and isolates errors', async t => {
    const h = setup(t), seen = [];
    h.expectConsoleError('subscriber "first"');
    h.dom.onBodyMutation('first', () => {
        h.dom.removeBodySubscriber('removed');
        h.dom.onBodyMutation('replaced', () => seen.push('new'), { priority: 1 });
        throw Error('failure');
    }, { priority: 5 });
    h.dom.onBodyMutation('removed', () => seen.push('removed'), { priority: 2 });
    h.dom.onBodyMutation('replaced', () => seen.push('old'), { priority: 1 });
    h.dom.onBodyMutation('normal', () => seen.push('normal'));
    await h.mutate(); h.paint(); assert.deepEqual(seen, ['normal']);
});

for (const mode of ['body', 'dedicated']) test(`direct ${mode} handle teardown releases named registry and stale handles preserve replacement`, async t => {
    const h = setup(t), seen = [];
    const target = mode === 'body' ? h.document.body : h.document.createElement('section');
    h.document.body.append(target === h.document.body ? h.document.createElement('div') : target);
    const config = mode === 'body' ? { childList: true, subtree: true } : { attributes: true };
    const old = h.dom.createObserver('same', () => seen.push('old'), target, config);
    old.disconnect(); assert.equal(h.dom.getObserverCount(), 0);
    const current = h.dom.createObserver('same', () => seen.push('current'), target, config);
    old.disconnect(); assert.equal(h.dom.getObserverCount(), 1);
    target.setAttribute('data-change', 'yes'); await h.mutate(); h.paint();
    assert.deepEqual(seen, ['current']);
    current.disconnect(); assert.equal(h.dom.getObserverCount(), 0); assert.equal(h.dom.getBodySubscriberCount(), 0);
});

test('direct body subscription replaces a dedicated observer with the same name without leaking it', async t => {
    const h = setup(t), seen = [];
    h.dom.createObserver('same', () => seen.push('dedicated'), h.document.body, { attributes: true });
    h.dom.onBodyMutation('same', () => seen.push('body'));
    assert.equal(h.dom.getObserverCount(), 0);
    h.dom.disconnectObserver('same'); h.document.body.setAttribute('data-change', 'yes');
    await h.mutate(); h.paint(); assert.deepEqual(seen, []);
    assert.equal(h.dom.disconnectObserver('same'), false);
});

test('body subscription can become a dedicated observer and implicit old-value configs stay dedicated', async t => {
    const h = setup(t), seen = [];
    h.dom.onBodyMutation('same', () => seen.push('body'));
    h.dom.createObserver('same', records => seen.push(records[0].type), h.document.body,
        { childList: true, subtree: true, attributeOldValue: true });
    assert.equal(h.dom.getBodySubscriberCount(), 0);
    h.document.body.setAttribute('data-change', 'yes'); await Promise.resolve();
    assert.deepEqual(seen, ['attributes']);
    h.dom.disconnectAllObservers(); assert.equal(h.dom.getObserverCount(), 0);
});

test('wait teardown settles immediately and clears its timeout rather than waiting ten seconds', async t => {
    const h = setup(t); let settled = false;
    const pending = h.dom.waitForElement('.absent').then(value => { settled = true; return value; });
    h.dom.disconnectAllObservers(); await Promise.resolve();
    assert.equal(settled, true); assert.equal(await pending, null); assert.equal(h.timers.size, 0);
});

test('wait cancellation handles already-aborted and pending signals without late DOM effects', async t => {
    const h = setup(t), controller = new h.window.AbortController();
    let settled = false;
    const pending = h.dom.waitForElement('.absent', { signal: controller.signal }).then(value => { settled = true; return value; });
    controller.abort(); await Promise.resolve();
    assert.equal(settled, true); assert.equal(await pending, null); assert.equal(h.dom.getBodySubscriberCount(), 0);
    assert.equal(await h.dom.waitForElement('body', { signal: controller.signal }), null);
    assert.equal(h.timers.size, 0);
});

test('waits preserve root/predicate, timeout shorthand, quiet diagnostics and simultaneous resolution', async t => {
    const h = setup(t, { html: '<section><i class="match">old</i><i class="match">new</i></section>' });
    const warnings = []; h.window.console.warn = (...args) => warnings.push(args);
    const found = await h.dom.waitForElement('.match', { root: h.document.querySelector('section'), predicate: el => {
        if (el.textContent === 'old') throw Error('predicate'); return true;
    } });
    assert.equal(found.textContent, 'new'); assert.equal(warnings.length, 1);
    const one = h.dom.waitForElement('.future', 42), two = h.dom.waitForElement('.future', { timeout: 42, quiet: true });
    h.timer(42); assert.equal(await one, null); assert.equal(await two, null); assert.equal(warnings.length, 2);
    const a = h.dom.waitForElement('.appeared'), b = h.dom.waitForElement('.appeared');
    const element = h.document.createElement('div'); element.className = 'appeared'; h.document.body.append(element);
    await Promise.resolve(); h.paint(); assert.equal(await a, element); assert.equal(await b, element);
    assert.equal(h.dom.getBodySubscriberCount(), 0); assert.equal(h.timers.size, 0);
});

test('unload cancels waits and all observation; reloading entries preserves facade and hooks', async t => {
    const h = setup(t), original = h.dom; let calls = 0;
    h.dom.onBodyMutation('retained', () => calls++, { priority: 1 });
    h.load('core/dom-observer.js'); h.load('core/ui-kit.js');
    assert.equal(h.JE.core.dom, original); assert.equal(h.JE.core.ui, h.ui);
    await h.mutate(); assert.equal(calls, 1);
    let settled = false; h.dom.waitForElement('.absent').then(() => { settled = true; });
    h.window.dispatchEvent(new h.window.Event('beforeunload')); await Promise.resolve();
    assert.equal(settled, true); assert.equal(h.dom.getBodySubscriberCount(), 0);
});

test('UI facade escapes values, retains aliases, deduplicates CSS and renders skeletons', t => {
    const h = setup(t);
    assert.equal(h.JE.escapeHtml, h.ui.escapeHtml); assert.equal(h.JE.toast, h.ui.toast);
    assert.equal(h.ui.escapeHtml(null), ''); assert.equal(h.ui.escapeHtml(42), '42');
    assert.equal(h.ui.escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#039;');
    h.ui.injectCss('test', 'first'); h.ui.injectCss('test', 'second');
    assert.equal(h.document.querySelectorAll('#test').length, 1); assert.equal(h.document.getElementById('test').textContent, 'second');
    assert.equal(h.ui.removeCss('test'), true); assert.equal(h.ui.removeCss('test'), false);
    const rows = h.ui.createSkeletonRows(['<img>', null], 2);
    assert.equal(rows.getAttribute('role'), 'status'); assert.equal(rows.querySelectorAll('.card').length, 4);
    assert.equal(rows.querySelector('h2').textContent, '<img>'); assert.equal(rows.querySelectorAll('img').length, 0);
    const grid = h.document.createElement('div'); grid.innerHTML = h.ui.skeletonGridHtml(3, { label: '"<>', minWidth: '12em', height: '4em' });
    assert.equal(grid.querySelectorAll('.je-skeleton-block').length, 3); assert.equal(grid.firstChild.getAttribute('aria-label'), '"<>');
    assert.equal(h.document.querySelectorAll('#je-skeleton-css').length, 1);
    assert.equal(h.ui.isTvLayout(), false); h.document.documentElement.classList.add('layout-tv'); assert.equal(h.ui.isTvLayout(), true);
});

test('toast uses dynamic theme/configuration, accepts escaped markup and preserves focused control', t => {
    const h = setup(t, { html: '<button id="focus">focus</button>', JE: { CONFIG: { TOAST_DURATION: 80 }, themer: { getThemeVariables: () => ({ secondaryBg: 'red', primaryAccent: 'blue', blur: '5px' }) } } });
    h.document.querySelector('button').focus(); const focused = h.document.activeElement;
    h.JE.toast('<b>Localized</b>'); const toast = h.document.querySelector('.jellyfin-enhanced-toast');
    assert.equal(toast.querySelector('b').textContent, 'Localized'); assert.equal(toast.style.background, 'red');
    assert.equal(h.document.activeElement, focused); h.timer(10); assert.equal(toast.style.transform, 'translateX(0)');
    h.timer(80); assert.equal(toast.isConnected, true); h.timer(300); assert.equal(toast.isConnected, false);
    h.JE.toast('zero', 0); h.timer(0); h.timer(300); assert.equal(h.document.querySelector('.jellyfin-enhanced-toast'), null);
});

function touch(h, target, type, { id = 1, x = 0, y = 0, changed, touches, targetTouches } = {}) {
    const point = { identifier: id, clientX: x, clientY: y, target };
    const active = type === 'touchend' || type === 'touchcancel' ? [] : [point];
    const event = new h.window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { changedTouches: changed ?? [point], touches: touches ?? active, targetTouches: targetTouches ?? active });
    target.dispatchEvent(event); return event;
}
for (const delegated of [false, true]) {
    test(`tap classifier preserves taps, swipes, cancellation and independent targets (delegated=${delegated})`, t => {
        const h = setup(t, { html: '<section><button id="a"><span>A</span></button><button id="b">B</button></section>' });
        const root = h.document.querySelector('section'), a = h.document.querySelector('#a'), b = h.document.querySelector('#b'), seen = [];
        if (delegated) h.ui.addDelegatedTouchTapListener(root, target => target.closest('button'), (event, el) => { seen.push(el.id); event.preventDefault(); });
        else for (const el of [a, b]) h.ui.addTouchTapListener(el, event => { seen.push(el.id); event.preventDefault(); });
        touch(h, a, 'touchstart'); assert.equal(touch(h, a, 'touchend').defaultPrevented, true);
        touch(h, a, 'touchstart'); touch(h, a, 'touchmove', { x: 11 });
        assert.equal(touch(h, a, 'touchend').defaultPrevented, true);
        touch(h, a, 'touchstart'); assert.equal(touch(h, a, 'touchend', { y: 11 }).defaultPrevented, true);
        touch(h, a, 'touchstart'); touch(h, a, 'touchcancel'); touch(h, a, 'touchend');
        touch(h, b, 'touchstart', { id: 2 }); touch(h, b, 'touchend', { id: 2 });
        assert.deepEqual(seen, ['a', 'b']);
    });
    test(`tap classifier rejects fling stops only in the scrolled ancestor (delegated=${delegated})`, t => {
        const h = setup(t, { html: '<section id="one"><button>A</button></section><section id="two"><button>B</button></section>' });
        let now = 1000; h.window.Date.now = () => now;
        const buttons = [...h.document.querySelectorAll('button')], seen = [];
        if (delegated) h.ui.addDelegatedTouchTapListener(h.document.body, target => target.closest('button'), (_, el) => seen.push(el.textContent));
        else for (const el of buttons) h.ui.addTouchTapListener(el, () => seen.push(el.textContent));
        h.document.querySelector('#one').dispatchEvent(new h.window.Event('scroll'));
        for (const el of buttons) { touch(h, el, 'touchstart'); touch(h, el, 'touchend'); }
        assert.deepEqual(seen, ['B']); now += 100;
        touch(h, buttons[0], 'touchstart'); touch(h, buttons[0], 'touchend'); assert.deepEqual(seen, ['B', 'A']);
    });
}

test('late subscribers see only the suffix captured after registration while existing subscribers share a batch', async t => {
    const h = setup(t), batches = [];
    h.dom.onBodyMutation('first', records => batches.push(records));
    h.dom.onBodyMutation('second', records => batches.push(records));
    await h.mutate(); h.dom.onBodyMutation('late', records => batches.push(records)); await h.mutate();
    h.paint(); assert.deepEqual(batches.map(batch => batch.length), [2, 2, 1]); assert.equal(batches[0], batches[1]);
});

test('a predicate that aborts its wait cannot leave a timer/subscription or return an aborted match', async t => {
    const h = setup(t), controller = new h.window.AbortController();
    const result = await h.dom.waitForElement('body', { signal: controller.signal, predicate: () => { controller.abort(); return true; } });
    assert.equal(result, null); assert.equal(h.dom.getBodySubscriberCount(), 0); assert.equal(h.timers.size, 0);
});

test('document and documentElement observers use one native body observer, complex observers retain native records', async t => {
    const h = createHarness(); t.after(() => h.close());
    let created = 0; const Native = h.window.MutationObserver;
    h.window.MutationObserver = class extends Native { constructor(callback) { super(callback); created++; } };
    h.load('core/dom-observer.js'); const dom = h.JE.core.dom;
    dom.onBodyMutation('direct', () => {});
    dom.createObserver('document', () => {}, h.document, { childList: true, subtree: true });
    dom.createObserver('root', () => {}, h.document.documentElement, { childList: true, subtree: true });
    assert.equal(created, 1); assert.equal(dom.getObserverCount(), 2); assert.equal(dom.getBodySubscriberCount(), 3);
    const native = dom.createObserver('attributes', () => {}, h.document.body, { attributes: true });
    h.document.body.setAttribute('data-probe', 'one');
    const records = native.takeRecords(); assert.equal(records.length, 1); assert.equal(records[0].type, 'attributes');
    native.disconnect(); dom.disconnectAllObservers();
    assert.equal(created, 2); assert.equal(dom.getObserverCount(), 0); assert.equal(dom.getBodySubscriberCount(), 0);
});

for (const delegated of [false, true]) test(`tap ignores other contacts and cancels a second contact on its own element (delegated=${delegated})`, t => {
    const h = setup(t, { html: '<section><button>A</button><aside>resting contact</aside></section>' });
    const button = h.document.querySelector('button'), other = h.document.querySelector('aside'); let taps = 0;
    if (delegated) h.ui.addDelegatedTouchTapListener(h.document.body, el => el.closest('button'), () => taps++);
    else h.ui.addTouchTapListener(button, () => taps++);
    const unrelated = { identifier: 99, clientX: 30, clientY: 30, target: other };
    const own = { identifier: 1, clientX: 0, clientY: 0, target: button };
    touch(h, button, 'touchstart', { changed: [unrelated, own], touches: [unrelated, own], targetTouches: [own] });
    touch(h, button, 'touchend', { changed: [own], touches: [unrelated], targetTouches: [] }); assert.equal(taps, 1);
    touch(h, button, 'touchstart');
    touch(h, button, 'touchstart', { id: 2, targetTouches: [own, { ...own, identifier: 2 }] });
    touch(h, button, 'touchend'); touch(h, button, 'touchend', { id: 2 }); assert.equal(taps, 1);
    touch(h, button, 'touchstart'); touch(h, button, 'touchend'); assert.equal(taps, 2);
});

for (const shared of [false, true]) test(`callback observer handle disconnects only its own named observer (shared=${shared})`, async t => {
    const h = setup(t); let received, other = 0;
    h.dom.onBodyMutation('other', () => other++);
    const handle = h.dom.createObserver('self', (_records, observer) => { received = observer; observer.disconnect(); },
        h.document.body, shared ? { childList: true, subtree: true } : { attributes: true });
    h.document.body.setAttribute('data-probe', '1'); await h.mutate(); h.paint();
    assert.equal(received, handle); assert.equal(h.dom.getObserverCount(), 0);
    assert.equal(other, 1); await h.mutate(); h.paint(); assert.equal(other, 2);
});

test('dedicated observer supports observe after disconnect and follows the same managed lifetime', async t => {
    const h = setup(t); let calls = 0;
    const handle = h.dom.createObserver('reused', () => calls++, h.document.body, { attributes: true });
    assert.equal(handle instanceof h.window.MutationObserver, true);
    handle.disconnect(); handle.observe(h.document.body, { attributes: true });
    assert.equal(h.dom.getObserverCount(), 1);
    h.document.body.setAttribute('data-probe', '1'); await Promise.resolve(); assert.equal(calls, 1);
    h.dom.disconnectAllObservers(); h.document.body.setAttribute('data-probe', '2');
    await Promise.resolve(); assert.equal(calls, 1); assert.equal(h.dom.getObserverCount(), 0);
});

for (const match of [false, true]) test(`initial wait predicate teardown cancels even when it returns ${match}`, async t => {
    const h = setup(t);
    const result = await h.dom.waitForElement('body', { predicate: () => {
        h.dom.disconnectAllObservers();
        return match;
    } });
    assert.equal(result, null);
    assert.equal(h.dom.getBodySubscriberCount(), 0);
    assert.equal(h.timers.size, 0);
});
