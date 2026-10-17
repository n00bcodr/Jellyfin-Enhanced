// /js/jellyseerr/seerr-iframe-mapping.js
(function(JE) {
    'use strict';

    const lifecycle = JE.core.lifecycle.register('seerr-iframe-mapping');
    const frames = new Map();
    let subscription = null;
    let destination = null;
    let sources = [];

    /**
     * Parse a browser-facing URL without accepting executable schemes or credentials.
     * @param {string} value
     * @returns {URL|null}
     */
    function parseUrl(value) {
        try {
            const url = new URL(value);
            return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : null;
        } catch (_) {
            return null;
        }
    }

    /**
     * Map only frames pointing at a configured Seerr origin and base path.
     * Never inspect the cross-origin frame document or replace srcdoc content.
     * @param {HTMLIFrameElement} frame
     */
    function mapFrame(frame) {
        if (!destination || !frame.isConnected || frame.hasAttribute('srcdoc') || !frame.getAttribute('src')) return;
        const current = parseUrl(frame.src);
        if (!current) return;
        for (const source of sources) {
            const basePath = source.basePath;
            if (current.origin !== source.origin
                || (current.pathname !== basePath && !current.pathname.startsWith(basePath + '/'))) continue;

            const mapped = new URL(destination.href);
            mapped.pathname = destination.pathname.replace(/\/+$/, '') + current.pathname.slice(basePath.length);
            mapped.search = current.search;
            mapped.hash = current.hash;
            // An already-correct src must not reload the frame or loop the observer.
            if (mapped.href !== current.href) frame.src = mapped.href;
            return;
        }
    }

    /**
     * Watch src changes as well as newly inserted frames (including lazy-loaded tabs).
     * @param {HTMLIFrameElement} frame
     */
    function watchFrame(frame) {
        if (frames.has(frame)) return;
        const observer = new MutationObserver(() => mapFrame(frame));
        observer.observe(frame, { attributes: true, attributeFilter: ['src', 'srcdoc'] });
        frames.set(frame, observer);
        mapFrame(frame);
    }

    /**
     * Find iframe nodes in a newly mounted subtree without rescanning the whole page.
     * @param {Document|Node} root
     */
    function scan(root) {
        if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
        if (root.nodeName === 'IFRAME') watchFrame(root);
        root.querySelectorAll('iframe').forEach(watchFrame);
    }

    /** Release subscriptions and detached frame references on teardown or identity change. */
    function stop() {
        subscription?.disconnect();
        subscription = null;
        frames.forEach(observer => observer.disconnect());
        frames.clear();
        destination = null;
        sources = [];
    }

    /** Refresh the mapping after configuration is available, including an SPA sign-in. */
    function refresh() {
        stop();
        const config = JE.pluginConfig;
        if (!config?.JellyseerrEnabled || !config.JellyseerrUrlMappings?.trim()) return;
        const resolved = JE.jellyseerrAPI.resolveJellyseerrBaseUrl();
        if (!resolved) return;
        destination = parseUrl(resolved);
        if (!destination || destination.search || destination.hash) {
            destination = null;
            return;
        }

        const configured = [config.JellyseerrBaseUrl, resolved];
        for (const line of config.JellyseerrUrlMappings.split('\n')) {
            const [jellyfinUrl, seerrUrl] = line.split('|').map(value => value.trim());
            if (jellyfinUrl && seerrUrl) configured.push(seerrUrl);
        }
        sources = configured.filter(Boolean).map(parseUrl)
            .filter(url => url && !url.search && !url.hash)
            .map(url => ({ origin: url.origin, basePath: url.pathname.replace(/\/+$/, '') }))
            // A more specific base path must win over another entry at the same origin's root.
            .sort((a, b) => b.basePath.length - a.basePath.length);

        // Priority dispatch avoids waiting for the shared observer's after-paint batch.
        subscription = JE.core.dom.onBodyMutation('seerr-iframe-mapping', records => {
            for (const record of records) record.addedNodes.forEach(scan);
            for (const [frame, observer] of frames) {
                if (!frame.isConnected) {
                    observer.disconnect();
                    frames.delete(frame);
                }
            }
        }, { priority: 1 });
        scan(document);
    }

    lifecycle.onTeardown(stop);
    lifecycle.addListener(document, 'je:user-data-loaded', refresh);
    lifecycle.addListener(window, 'beforeunload', () => lifecycle.teardown());
    if (JE.session) lifecycle.track(JE.session.onUserChange('seerr-iframe-mapping', stop));
    refresh();
})(window.JellyfinEnhanced);
