import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

export const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const config = join(repo, 'Jellyfin.Plugin.JellyfinEnhanced', 'Configuration');
export const pageHtml = () => readFileSync(join(config, 'configPage.html'), 'utf8');

/** What GET Configuration/jeAdmin.js serves: the engine, then every admin script in order. */
export function servedEngine() {
    const files = readdirSync(join(config, 'admin')).filter(f => f.endsWith('.js')).sort();
    return [readFileSync(join(config, 'jeAdmin.js'), 'utf8'), ...files.map(f => readFileSync(join(config, 'admin', f), 'utf8'))].join('\n');
}

export const clone = value => JSON.parse(JSON.stringify(value));
export const settle = async (window, rounds = 40) => { for (let i = 0; i < rounds; i++) await new Promise(r => window.setTimeout(r, 0)); };

/**
 * The generated page in a real parse: its startup and page scripts run as the host runs them, and
 * the page's jeAdmin.js script element is answered by the harness, so a test decides when and whether it loads.
 * @param {object} options
 * @param {'ok'|'missing'|'empty'|'partial'|'hold'} [options.engine]
 * @param {object} [options.saved] The stored configuration.
 * @param {(() => Promise<object>)} [options.getConfig] Replaces the configuration read.
 * @param {(request: object) => unknown} [options.ajax] Answers ApiClient.ajax first.
 * @param {(body: object) => void} [options.onPut] Runs once a configuration write has landed.
 * @param {object} [options.globals] Further browser globals, such as JellyfinEnhanced.
 */
export function bootGenerated({ engine = 'ok', saved = {}, getConfig, ajax, onPut, globals = {} } = {}) {
    const logged = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', e => logged.push(String(e?.detail?.stack || e?.stack || e)));
    virtualConsole.on('error', (...a) => logged.push(a.map(String).join(' ')));
    const server = { config: clone(saved) };
    const calls = { puts: [], gets: 0, ajax: [], xhr: 0, engineRequests: 0, loading: 0, hidden: 0 };
    const held = {};
    /** Who the client reads as; a test changes it the way an account switch changes the same ApiClient. */
    const identity = { token: 'token-a', userId: 'user-a', serverId: 'server-a', serverAddress: 'http://jf.test' };
    const state = { engine };
    /** Answer the page's request for jeAdmin.js the way a browser answers a script element. */
    const deliver = (window, script) => {
        calls.engineRequests++;
        const run = () => { window.eval(servedEngine()); script.onload(); };
        if (state.engine === 'hold') held.release = run;
        else if (state.engine === 'missing') window.setTimeout(() => script.onerror(new window.Event('error')), 0);
        else if (state.engine === 'empty') window.setTimeout(() => script.onload(), 0);
        else if (state.engine === 'partial') window.setTimeout(() => { window.eval(readFileSync(join(config, 'jeAdmin.js'), 'utf8')); script.onload(); }, 0);
        else window.setTimeout(run, 0);
    };
    const dom = new JSDOM(pageHtml(), {
        url: 'http://jf.test/web/#/configurationpage?name=Jellyfin%20Enhanced',
        runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
        beforeParse(window) {
            const append = window.Node.prototype.appendChild;
            window.Node.prototype.appendChild = function (node) {
                if (node.tagName === 'SCRIPT' && /Configuration\/jeAdmin\.js/.test(node.src)) { deliver(window, node); return node; }
                return append.call(this, node);
            };
            Object.assign(window, globals);
            window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
            window.scrollTo = () => {};
            window.HTMLElement.prototype.scrollIntoView = function () {};
            window.XMLHttpRequest = class { constructor() { calls.xhr++; } open() {} send() {} };
            window.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
            window.Dashboard = {
                showLoadingMsg() { calls.loading++; }, hideLoadingMsg() { calls.hidden++; },
                processPluginConfigurationUpdateResult() {}, alert() {}, confirm() {},
            };
            window.ApiClient = {
                getUrl: (path, query) => 'http://jf.test/' + path.replace(/^\//, '') + (query ? '?' + new URLSearchParams(query) : ''),
                getPluginConfiguration: async () => { calls.gets++; return getConfig ? getConfig(calls.gets) : clone(server.config); },
                updatePluginConfiguration: async (id, body) => { calls.puts.push(clone(body)); server.config = clone(body); onPut?.(body); return {}; },
                ajax: async request => {
                    calls.ajax.push(request);
                    if (ajax) { const r = await ajax(request); if (r !== undefined) return r; }
                    return request.type === 'GET' || !request.type ? [] : {};
                },
                getJSON: async () => [], fetch: async () => ({}), getUsers: async () => [],
                accessToken: () => identity.token, getCurrentUserId: () => identity.userId, serverId: () => identity.serverId,
                serverAddress: () => identity.serverAddress, serverVersion: () => '12.0.0',
            };
        },
    });
    const { window } = dom;
    const page = () => window.document.getElementById('JellyfinEnhancedPage');
    const ready = async () => { for (let i = 0; i < 400 && !window.document.querySelector('.jea-layout') && !window.document.querySelector('.je-admin-load-error'); i++) await new Promise(r => setTimeout(r, 5)); await settle(window); };
    const show = () => page().dispatchEvent(new window.Event('pageshow'));
    return { dom, window, document: window.document, page, ready, show, calls, server, held, state, logged, identity, close: () => dom.window.close() };
}
