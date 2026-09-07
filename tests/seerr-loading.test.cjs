// Run with: node --test tests/seerr-loading.test.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = process.env.JE_SOURCE_ROOT || path.resolve(__dirname, '..');
const source = file => readFileSync(path.join(root, 'Jellyfin.Plugin.JellyfinEnhanced/js', file), 'utf8');
const quiet = { log() {}, debug() {}, warn() {}, error(...args) { if (process.env.JE_TEST_DEBUG) console.error(...args); } };
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

// A small DOM fixture for the actual discovery controller. Geometry and network
// are supplied by its existing shared helpers, as they are in the browser.
class Element {
    constructor(tag = 'div') {
        this.tag = tag;
        this.children = [];
        this.style = {};
        this.listeners = new Map();
        this.className = '';
    }
    get childNodes() { return this.children; }
    setAttribute() {}
    appendChild(child) {
        if (child.tag === 'fragment') {
            for (const item of [...child.children]) this.appendChild(item);
        } else {
            child.remove();
            child.parent = this;
            this.children.push(child);
        }
        return child;
    }
    remove() {
        if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
        this.parent = null;
    }
    querySelectorAll(selector) {
        const matches = element => selector.startsWith('.')
            ? element.className.split(' ').includes(selector.slice(1))
            : element.tag === selector;
        return this.children.flatMap(child => [
            ...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)
        ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, callback, options = {}) {
        this.listeners.set(type, callback);
        options.signal?.addEventListener('abort', () => this.listeners.delete(type), { once: true });
    }
    async click() { if (!this.disabled) await this.listeners.get('click')?.(); }
}

function categoryFixture() {
    const request = deferred();
    const P = { state: { categoryState: {} }, fetchWithManagedRequest: () => request.promise };
    const JE = { internals: { recommendationsPage: P } };
    // Expose the private initial loader in the test context only.
    const code = source('jellyseerr/recommendations/recommendations-category.js')
        .replace('P.createCategoryPageContainer =', 'P.loadInitial = loadInitialCategoryPage; P.createCategoryPageContainer =');
    vm.runInNewContext(code, { window: { JellyfinEnhanced: JE }, console: quiet });
    return { request, P };
}

test('failed stale category request leaves the successor pagination intact', async () => {
    const { request, P } = categoryFixture();
    let stale = false;
    const loading = P.loadInitial({ path: '/old' }, new Element(), () => stale);
    stale = true;
    const successor = { page: 5, totalPages: 5, hasMore: false };
    P.state.categoryState = successor;
    request.reject(new Error('HTTP 504'));
    await loading;
    assert.deepEqual(successor, { page: 5, totalPages: 5, hasMore: false });
});

test('failed current category request still leaves page one available for retry', async () => {
    const { request, P } = categoryFixture();
    const loading = P.loadInitial({ path: '/current' }, new Element(), () => false);
    request.reject(new Error('HTTP 504'));
    await loading;
    assert.equal(P.state.categoryState.page, 0);
    assert.equal(P.state.categoryState.hasMore, true);
});

function personFixture(fetchCredits) {
    const detail = new Element();
    let calls = 0;
    const JE = {
        core: { navigation: { onNavigate() {} } },
        helpers: { getItemCached: async () => ({ Type: 'Person' }) },
        jellyseerrAPI: { checkUserStatus: async () => ({ active: true }) },
        t: () => 'More from Test Actor',
        discoveryFilter: {
            waitForPageReady: async () => detail,
            getFilterMode: () => 'mixed',
            getSortMode: () => '',
            resultHasBothTypes: items => new Set(items.map(item => item.mediaType)).size > 1,
            MODES: { MIXED: 'mixed', MOVIES: 'movies', TV: 'tv' },
            interleaveArrays: (tv, movies) => [...tv, ...movies],
            cleanupScrollObserver() {},
            createCardsFragment(items) {
                const fragment = new Element('fragment');
                for (const item of items) {
                    const card = new Element();
                    card.className = 'card';
                    card.itemId = item.id;
                    fragment.appendChild(card);
                }
                return fragment;
            },
            async fetchWithManagedRequest(route, prefix, options) {
                if (!route.includes('combined_credits')) return { name: 'Test Actor', tmdbId: 123 };
                const response = await JE.core.api.manager.fetchWithRetry(route, options);
                return response.json();
            }
        }
    };
    const context = vm.createContext({
        window: { JellyfinEnhanced: JE, location: { hash: '#!/details?id=person' } },
        document: {
            readyState: 'loading', addEventListener() {},
            createElement: tag => new Element(tag),
            querySelector: selector => detail.querySelector(selector),
            querySelectorAll: selector => detail.querySelectorAll(selector)
        },
        console: quiet, AbortController, DOMException, URLSearchParams, performance,
        setTimeout: fn => { fn(); return 0; },
        fetch: (...args) => { calls++; return fetchCredits(calls, ...args); }
    });
    vm.runInContext(source('core/api-client.js'), context);
    vm.runInContext(source('jellyseerr/discovery/discovery-base.js'), context);
    let discovery;
    const create = JE.discoveryBase.createDiscovery;
    JE.discoveryBase.createDiscovery = spec => (discovery = create(spec));
    vm.runInContext(source('jellyseerr/discovery/person-discovery.js'), context);
    return { discovery, detail, calls: () => calls };
}

const pending = () => new Response(JSON.stringify({ code: 'parental_pending' }), { status: 504 });
const credits = () => new Response(JSON.stringify({ cast: [{ id: 42, mediaType: 'movie' }], crew: [] }));

test('pending person credits offer a retry which subsequently renders the filmography', async () => {
    const { discovery, detail, calls } = personFixture(async attempt => attempt <= 2 ? pending() : credits());
    await discovery.render();
    assert.equal(calls(), 2, 'existing automatic retry policy is preserved');
    const button = detail.querySelector('button');
    assert.ok(button, 'exhausted automatic retries must leave a retry action');
    await button.click();
    assert.equal(calls(), 3);
    assert.equal(detail.querySelectorAll('.je-retry-row').length, 0);
    assert.equal(detail.querySelector('.card').itemId, 42);
});

test('another failed person retry leaves a new usable retry action', async () => {
    const { discovery, detail, calls } = personFixture(async () => pending());
    await discovery.render();
    const first = detail.querySelector('button');
    assert.ok(first);
    await first.click();
    const next = detail.querySelector('button');
    assert.ok(next);
    assert.notEqual(next, first);
    assert.ok(!next.disabled);
    assert.equal(calls(), 4);
});

test('navigation during a credits fetch does not add a retry to the next page', async () => {
    const request = deferred();
    const started = deferred();
    const { discovery, detail } = personFixture(() => { started.resolve(); return request.promise; });
    const loading = discovery.render();
    await started.promise;
    discovery.cleanup();
    request.reject(new DOMException('Aborted', 'AbortError'));
    await loading;
    assert.equal(detail.children.length, 0);
});

test('navigation removes an existing retry action and retires its click handler', async () => {
    const { discovery, detail, calls } = personFixture(async () => pending());
    await discovery.render();
    const button = detail.querySelector('button');
    assert.ok(button);
    discovery.cleanup();
    await button.click();
    assert.equal(detail.children.length, 0);
    assert.equal(calls(), 2);
});

test('a genuinely empty filmography does not show an error action', async () => {
    const { discovery, detail, calls } = personFixture(async () => new Response(JSON.stringify({ cast: [], crew: [] })));
    await discovery.render();
    assert.equal(calls(), 1);
    assert.equal(detail.children.length, 0);
});
