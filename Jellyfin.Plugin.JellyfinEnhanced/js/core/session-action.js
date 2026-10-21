/** Deferred feature actions belong to the viewer and session that started them. */
(function (JE) {
    'use strict';
    const dismissals = new Set();
    // Operation scopes (D46S2-R5): the UI each owner opened (its surfaces), and the owner each such surface belongs to.
    const scopes = new Map();
    const owners = new WeakMap();
    // Presses dispatched for an owner (a title action pressing an owner's control): event → token.
    const presses = new WeakMap();

    /**
     * A dropped or unprovable owner at an effect: a programming error. Throws in tests (JE.strictOwners); else it is
     * logged and refused (null). A test observing the production behaviour sets JE.strictOwners = 'record': refused,
     * and the message kept in JE.refusals.
     */
    function refused(why) {
        const message = `Jellyfin Enhanced: ${why}`;
        if (JE.strictOwners === true) throw new Error(message);
        if (JE.strictOwners === 'record') (JE.refusals = JE.refusals || []).push(message);
        else console.error(message);
        return null;
    }
    /** An owner-taking call (an opener, an owned write) made without one: refused the same way. */
    const missing = site => refused(`${site} was called without an owner`);

    // ------------------------------------------------------------------ lifetimes (D46S2-R10, audit S1)
    // Every owner token carries three lifetimes, captured when it is minted and checked at every effect: the session
    // (user, server, token, epoch), the document (leaving it or coming back from the back/forward cache) and the
    // SEMANTIC route (the view, the shown item, a shared-title link, a search query, a tab, a library). Ended is forever.

    // The route parameters that say what the page shows; anything else (a server id the host adds) is not a new route.
    const SEMANTIC = ['id', 'jeTitle', 'query', 'tab', 'parentId', 'topParentId', 'collectionType', 'type', 'genreId', 'studioId', 'personId'];
    /** The semantic route of `hash`: its path and the parameters that say what the page shows. */
    function routeKey(hash = window.location.hash) {
        const [path, query] = String(hash || '').replace(/^#!?/, '').split('?');
        const params = new URLSearchParams(query || '');
        return [path, ...SEMANTIC.map(name => params.get(name) || '')].join('|');
    }
    let route = 0;
    let shown = routeKey();
    let documentGeneration = 0;
    let sweeping = false;
    /** Closes the UI of owners that just ended (their scopes) once the current step has finished. */
    function sweep() {
        if (sweeping) return;
        sweeping = true;
        queueMicrotask(() => {
            sweeping = false;
            try { JE.endScopes(); } catch (_) { /* the owning document has already gone (disposal) */ }
        });
    }
    /**
     * The route generation: it moves on whenever the semantic route is not the one last seen (checked lazily too, so a
     * host that only queues its events is seen at the next check). A modal's own history entry (the same URL) is not a
     * route change.
     */
    function observe(next = routeKey()) {
        if (next !== shown) { shown = next; route++; sweep(); }
        return route;
    }
    window.addEventListener('popstate', () => observe(), true);
    window.addEventListener('je:navigate', () => observe(), true);
    window.addEventListener('hashchange', event => { observe(routeKey(new URL(event.newURL || window.location.href).hash)); observe(); }, true);
    // The document's own lifecycle (D46S2-R5-1): leaving it (pagehide, whether or not the page goes into the back/forward
    // cache; freeze) and coming back (pageshow from the cache; resume) each start another document generation. Only the
    // document's own events count: jellyfin-web dispatches bubbling pagehide/pageshow CustomEvents from its view
    // elements on every view change (verified on 12.2), and those reach window too.
    const own = event => event.target?.nodeType !== 1;
    const turn = event => { if (!own(event)) return; documentGeneration++; JE.endScopes(); };
    window.addEventListener('pagehide', turn, true);
    document.addEventListener('freeze', turn, true);
    window.addEventListener('pageshow', event => { if (event.persisted) turn(event); }, true);
    document.addEventListener('resume', turn, true);

    /** The signed-in session as a token captures it. */
    function captureSession() {
        const user = ApiClient.getCurrentUserId();
        const epoch = JE.session?.getEpoch?.();
        const serverId = () => typeof ApiClient.serverId === 'function' ? ApiClient.serverId() : ApiClient.serverId;
        const server = serverId();
        const token = ApiClient.accessToken();
        const current = () => ApiClient.getCurrentUserId() === user && serverId() === server &&
            ApiClient.accessToken() === token && JE.session?.isCurrent?.(epoch) !== false;
        return Object.freeze({ userId: user, serverId: server, token, epoch, current });
    }

    // ------------------------------------------------------------------ owner tokens (D46S2-R10 shape 1)
    // Authority is explicit: every effect takes a token minted here. There is no ambient owner (no JE.NATIVE, no
    // window.event, no "the node is on the page"). A token is current while its lifetimes hold, its mount (when given)
    // says so and its parent is current; once it is not, it never is again.
    // The core decides (D46S2-R11-1..3): whether a token is current or may write comes from the core's own record of it,
    // never from the token object or a binding a caller hands back (their methods are conveniences for the holder; a
    // caller's predicate can only further restrict).
    const minted = new WeakSet();
    const records = new WeakMap();
    /**
     * Mints an owner token. kind: 'operation' (a title action's submitted work), 'native' (a viewer's own gesture, see
     * {@link JE.nativeFrom}) or 'publication' (an answer's handle, see {@link JE.publication}). `parent`: its ancestry
     * (current only while the parent is). `mount`: an extra lifetime (the owning row or card is still this one).
     */
    function mint(kind, { parent = null, mount = null, session = captureSession() } = {}) {
        const born = { route: observe(), document: documentGeneration };
        let ended = false;
        let stopped = false;
        const parentRecord = parent ? records.get(parent) : null;
        const current = () => {
            if (!ended && (observe() !== born.route || documentGeneration !== born.document || !session.current() ||
                (mount && mount() === false) || (parentRecord && parentRecord.current() === false))) ended = true;
            return !ended;
        };
        // It may still write (D46S2 audit S3): an operation or publication while current; a viewer's own gesture while
        // its session is the signed-in one (the viewer asked for the write; its page effects still end with its route).
        const writable = () => kind === 'native' ? session.current() && !stopped : current();
        const token = {
            kind, native: kind === 'native', parent, session,
            /** Its root: the token at the top of its ancestry (a publication's operation, or a native gesture). */
            get root() { let t = token; while (t.parent) t = t.parent; return t; },
            current,
            /** Its session is still the signed-in one (an accepted write reconciles into that session's state). */
            sessionCurrent: () => session.current(),
            writable,
            end() { ended = stopped = true; sweep(); },
            /**
             * The core transport binding of a write this token owns: sent only while the token may write (an operation
             * or publication: while it is current; a viewer's own gesture: while its session is the signed-in one, since
             * the viewer asked for it) and `check()` (when given) is true, checked right before the bytes go out.
             */
            bound: check => Object.freeze({ session, token, current: () => writable() && (!check || check() === true) }),
            bind: callback => (...args) => current() ? callback(...args) : false,
            onCancel: dismiss => { dismissals.add(dismiss); return () => dismissals.delete(dismiss); },
            /** A token serializes as its kind only (it is a capability, never data). */
            toJSON: () => ({ owner: kind }),
        };
        minted.add(token);
        records.set(token, { kind, session, parent, current, writable });
        return token;
    }
    JE.isOwnerToken = x => !!x && typeof x === 'object' && minted.has(x);
    /** Current now, by the core's record of `x` (false for anything the core did not mint). */
    const isCurrent = x => records.get(x)?.current() === true;
    /** The root record of a minted token's ancestry. */
    const rootRecord = x => { let r = records.get(x); while (r?.parent) r = records.get(r.parent); return r || null; };
    const nativeRoot = x => rootRecord(x)?.kind === 'native';
    /** A minted token by the core's record; anything else (a caller's own state object) by its own current(). */
    const holds = x => records.has(x) ? isCurrent(x) : x?.current?.() !== false;
    /**
     * The transport's own check of an owned write (D46S2-R11-3): `token` is one the core minted and may write now (not
     * ended, its session the signed-in one, its write lifetime), by the core's record; `session` (when given) must be
     * that token's own session. A binding's predicate is checked as well, never instead.
     */
    JE.mayWrite = (token, session) => {
        const record = records.get(token);
        return !!record && (session === undefined || session === record.session) && record.writable() === true;
    };

    // Who is acting right now — RESTRICTIONS only, never authority (D46S2-R10-3): while an operation's press, runner or
    // publication callback runs synchronously, a native owner named, an unbound write sent, or a binding made there is
    // that operation's (or refused). Nothing here ever grants an owner.
    const acting = [];
    const actingOperation = () => acting.length ? acting[acting.length - 1] : null;
    function restricted(token, fn) {
        acting.push(token);
        try { return fn(); } finally { acting.pop(); }
    }

    // ------------------------------------------------------------------ gestures (D46S2-R11-1, -2)
    // A native owner comes only from the viewer's own gesture, decided here from what the core itself observed:
    // - a TRUSTED event (the browser's own; a re-dispatch makes it untrusted), checked at every lookup;
    // - or the host's own activation of the focused control, verified: jellyfin-web (10.11.11 and 12.2, its
    //   gamepad-to-key and keyboard navigation modules) turns a gamepad's OK into a keyup Event {key 'GamepadA', keyCode
    //   13} on the focused element followed, in the same call, by that element's click(); and a UWP gamepad's OK (a
    //   trusted keydown, keyCode 195) into inputManager's select: click() on the focused element inside that keydown's
    //   dispatch. Only the first click after that key event, on the same focused element, while nothing of JE's acts.
    // Focus alone never grants; a plain object never grants; a token is remembered per event only for the same target
    // and the same dispatch, and never consulted inside an operation.
    const GESTURE_TYPES = ['click', 'auxclick', 'dblclick', 'contextmenu', 'keydown', 'keyup', 'pointerdown', 'pointerup',
        'mousedown', 'mouseup', 'touchstart', 'touchend', 'submit', 'change', 'input'];
    // Each gesture event object's dispatches as the core saw them (window, capture: before any other listener).
    const dispatches = new WeakMap();
    let armed = null;
    const count = event => { dispatches.set(event, (dispatches.get(event) || 0) + 1); };
    for (const type of GESTURE_TYPES) window.addEventListener(type, count, true);
    /** The host's activation chain started on `event.target` (the focused element). */
    function arm(event, during) {
        const target = event.target;
        if (!target || target.nodeType !== 1 || target !== document.activeElement) { armed = null; return; }
        const mine = armed = { target, key: event, during, click: null };
        // The gamepad's click() follows in the same call: nothing later (another task, a JE continuation) is it.
        if (!during) queueMicrotask(() => { if (armed === mine) armed = null; });
    }
    window.addEventListener('keyup', event => { if (!event.isTrusted && event.key === 'GamepadA' && event.keyCode === 13) arm(event, false); }, true);
    window.addEventListener('keydown', event => {
        if (event.isTrusted && event.keyCode === 195) arm(event, true);
        else if (armed && armed.key !== event) armed = null;
    }, true);
    window.addEventListener('click', event => {
        if (!armed) return;
        // Only the first click after the key event is the host's.
        if (armed.click || event.isTrusted) armed = null; else armed.click = event;
    }, true);
    /** True once for the click jellyfin-web's own activation chain made (consumed). */
    function hostActivation(event) {
        const chain = armed;
        if (!chain || chain.click !== event || event.type !== 'click' || event.target !== chain.target ||
            chain.target !== document.activeElement || (chain.during && chain.key.eventPhase === 0)) return false;
        armed = null;
        return true;
    }
    // Controls drawn for the viewer (D46S2-R11-1): a gesture grants authority over one only while its mount is current —
    // the session it was drawn for, on the page it was drawn for (its semantic route: a view jellyfin-web keeps and shows
    // again is the same page, with its controls live again; one drawn for another account never is).
    const mounts = new WeakMap();
    /** Marks `node` (a control or the card/row holding controls) as drawn now. Returns it. */
    JE.mountControl = function (node) {
        if (node && node.nodeType === 1) mounts.set(node, { session: captureSession(), page: routeKey() });
        return node;
    };
    /** The nearest mount of `node` is still current (true when none was recorded: jellyfin-web's own controls). */
    function mountCurrent(node) {
        for (let n = node; n; n = n.parentNode || n.host) {
            const mount = mounts.get(n);
            if (mount) return mount.session.current() && mount.page === routeKey();
        }
        return true;
    }

    // Native tokens minted per gesture: one per event, for its target and dispatch.
    const gestures = new WeakMap();
    /**
     * True for an event someone made (D46S2-R11-1): a trusted one (asked again later: while it is still trusted), or the
     * host's verified activation of the focused control (remembered for that target and dispatch only).
     */
    function gesture(event) {
        if (event.isTrusted === true) return true;
        const known = gestures.get(event);
        if (known) return known.activation && known.target === event.target && known.dispatch === (dispatches.get(event) || 0);
        if (!hostActivation(event)) return false;
        gestures.set(event, { token: null, target: event.target, dispatch: dispatches.get(event) || 0, activation: true });
        return true;
    }
    /**
     * The native owner of a viewer's gesture (see above): minted only while the event is dispatched, from a trusted
     * event or the host's verified activation, on a control whose mount is current, while no JE press, runner or
     * publication callback acts (inside one: refused, before anything is remembered or consulted). Asked again for the
     * same event later (after an await), the same token comes back only for the same target and the same dispatch, and
     * for a trusted one only while it is still trusted. Its lifetimes: the session, the document and the semantic route
     * of the gesture. Null otherwise.
     */
    JE.nativeFrom = function (event) {
        if (!(event instanceof Event) || presses.has(event) || !gesture(event)) return null;
        if (actingOperation()) return refused('a native owner was minted inside an operation (its owner was dropped)');
        const known = gestures.get(event);
        const dispatch = dispatches.get(event) || 0;
        if (known && (known.target !== event.target || known.dispatch !== dispatch)) return null;
        if (known?.token) return known.token;
        if (event.eventPhase === 0 || !mountCurrent(event.target)) return null;
        const token = mint('native');
        gestures.set(event, { token, target: event.target, dispatch, activation: event.isTrusted !== true });
        return token;
    };

    // The route's own native token (a page adapter acting for the route it shows without a gesture: a page that falls
    // back to its window): one per semantic route generation, current while that route is shown.
    let routeToken = null;
    /**
     * The native owner of the page the viewer is on now, for a page adapter's own lifecycle step (no gesture): handed
     * out only for `expected`, the semantic route the caller recorded for itself ({@link JE.routeKey}), so a stale
     * continuation (another route) gets none. Refused inside an operation. Pinned to its callers by the lint.
     */
    JE.routeOwner = function (expected, reason) {
        if (actingOperation()) return refused(`a route owner (${reason}) was named inside an operation (its owner was dropped)`);
        if (routeKey() !== expected) return null;
        if (!routeToken || !isCurrent(routeToken)) routeToken = mint('native');
        return routeToken;
    };
    JE.routeKey = routeKey;
    /** The current route generation (D46S2-R10 shape 3: a fetch → render path carries it and re-checks it). */
    JE.routeGeneration = () => observe();

    /** The owner of the registered surface `node` is in (or is), else null. */
    function scopeOf(node) {
        for (let n = node; n; n = n.parentNode || n.host) { const owner = owners.get(n); if (owner) return owner; }
        return null;
    }
    JE.scopeOf = scopeOf;

    /**
     * The owner `x` names, explicitly (D46S2-R10: nothing is ambient). A minted token: itself. Something holding one (a
     * captured action): its token. A node: the owner of the registered surface it is in (every JE surface registers,
     * native ones too), else none. An event: the token a title action pressed it with ({@link JE.press}); else the owner
     * of the surface it happened in, for a gesture someone made (trusted, or the host's verified activation); else, for
     * such a gesture, its native token ({@link JE.nativeFrom}). A script's or a re-dispatched event, and anything else (a
     * plain object shaped like an event), names none. Null: no owner.
     */
    function ownerOf(x) {
        if (!x || typeof x !== 'object') return null;
        if (minted.has(x)) return x;
        if (minted.has(x.owner)) return x.owner;
        if (typeof x.nodeType === 'number') return scopeOf(x);
        if (x instanceof Event) {
            const pressed = presses.get(x);
            if (pressed) return pressed;
            // Only an event someone made names an owner (D46S2-R11-1): the viewer's own (trusted) or the host's verified
            // activation. A script's click or a re-dispatched event names none, inside a surface too.
            if (!gesture(x)) return null;
            // Inside a registered surface: that surface's owner (derived from where it happened, never minted). Else the
            // gesture's own native token.
            return scopeOf(x.composedPath?.()[0] || x.target) || JE.nativeFrom(x);
        }
        return null;
    }
    JE.ownerOf = ownerOf;

    /**
     * The owner `x` names (see ownerOf), or null after {@link missing} when it names none. Every owner-taking call
     * resolves its owner here. A native owner named while an operation acts synchronously (its press, runner or
     * publication callback) is refused: that operation's owner was dropped (D46S2-R9-4, R10-3).
     */
    JE.requireOwner = (x, site) => {
        const owner = ownerOf(x) || missing(site || 'an owner-taking call');
        return owner && nativeRoot(owner) && actingOperation() && !nativeRoot(actingOperation())
            ? refused(`${site || 'an owner-taking call'} took a native owner inside an operation (its owner was dropped)`) : owner;
    };
    /**
     * The owner an effect acts for, checked AT the effect (opening a window, sheet or dialog, navigating, publishing,
     * rendering, a delayed refresh): resolved as {@link JE.requireOwner} does and current now. Null: no effect.
     */
    JE.effectOwner = (x, site) => {
        const owner = JE.requireOwner(x, site);
        return owner && isCurrent(owner) ? owner : null;
    };
    /**
     * The checked runner: runs `fn` as `owner` only while it is current now; an operation's (or publication's) runner
     * restricts what runs inside it (see acting). A native owner adds no authority to anything. Else nothing runs.
     */
    JE.runAs = function (owner, fn) {
        const resolved = JE.effectOwner(owner, 'runAs');
        if (!resolved) return undefined;
        return records.get(resolved).kind === 'native' ? fn() : restricted(resolved, fn);
    };
    /** A timer through the checked runner: `fn` runs after `ms` only if `owner` is current then. Returns cancel(). */
    JE.later = function (owner, fn, ms) {
        const resolved = JE.requireOwner(owner, 'later');
        if (!resolved) return () => {};
        const timer = setTimeout(() => JE.runAs(resolved, fn), ms);
        return () => clearTimeout(timer);
    };
    /**
     * The surface a completion's answer goes to (D46S2-R9-2): a connected node, resolved before anything it came from
     * goes. None (unknown, e.g. a portaled popup whose source was lost) fails closed: an error (throws in tests), and
     * the caller opens and sends nothing; one that left the page is null without an error.
     */
    JE.requireOrigin = (node, site) => !node || node.nodeType !== 1 ? refused(`${site} has no origin (nothing opens or is sent)`) : node.isConnected ? node : null;
    /**
     * A write sent without a token's binding (the transport asks): true (refused) while an operation acts synchronously
     * (its press, runner or publication callback), which dropped that operation's owner; it throws in tests.
     */
    JE.refuseUnboundWrite = what => !!actingOperation() && refused(`${what} was sent without its binding inside an operation (its owner was dropped)`) === null;
    /** The operation an owner stands for (null for a native one). */
    const operationOf = owner => owner && !nativeRoot(owner) ? owner : null;

    /** Mints an operation token (a title action's submitted work); see mint. */
    JE.operation = options => mint('operation', options);

    /**
     * Presses `source` for `owner` (a title action pressing an owner's control, D46S2-R6): a fresh click event that
     * carries its owner, which the control's handler reads explicitly ({@link JE.ownerOf}(event)). Like click(), a
     * disabled control is not pressed; an owner that is not current presses nothing, before any handler or default
     * runs (D46S2-R10-4). While it is dispatched, the owner restricts what its handlers do (see acting).
     */
    JE.press = function (source, owner) {
        if (!source || source.disabled) return false;
        const resolved = JE.effectOwner(owner, 'press');
        if (!resolved) return false;
        const event = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
        presses.set(event, resolved);
        return restricted(resolved, () => source.dispatchEvent(event));
    };

    /**
     * Takes the owner work was invoked for (`owner`: a token, a captured action, a node inside UI it opened, or the press
     * event; required) at its entry point, for work that continues after an await. `current()`: the owner is current.
     * `bound()`: the transport binding of its writes (see mint). Without an owner nothing it guards proceeds.
     */
    JE.captureSubmitted = function (owner) {
        const resolved = JE.requireOwner(owner, 'captureSubmitted');
        const operation = operationOf(resolved);
        const current = () => !!resolved && isCurrent(resolved);
        return { owner: resolved, operation, current, session: resolved?.session || null,
            /** Its writes may still go out (see the token's writable()). */
            writable: () => !!resolved && JE.mayWrite(resolved),
            bound: check => resolved ? resolved.bound(check) : Object.freeze({ session: captureSession(), current: () => false }) };
    };

    // ------------------------------------------------------------------ surfaces (audit S2: one terminal lifecycle)
    // Every surface JE opens (a sheet, drawer, modal, window, popup portaled to the body, a host dialog) is admitted for an
    // owner, sits on one stack, closes once (terminal and at once inert: it takes no input, its focus goes back to its
    // opener) and is dismissed by Escape or Back only while it is the topmost one.
    const stack = [];
    /**
     * UI opened for an owner only closes once `ended(event)`: a click, middle-click, key press or form submission inside
     * `root` is cancelled whole first, its default included, and then `close()` runs.
     */
    JE.rejectEnded = function (root, ended, close) {
        const reject = event => {
            if (!ended(event)) return;
            event.preventDefault(); event.stopImmediatePropagation();
            close(event);
        };
        for (const type of ['click', 'auxclick', 'submit', 'keydown']) root.addEventListener(type, reject, true);
    };
    /**
     * Admits a surface for `owner` (an opening checks this BEFORE it touches the DOM, history, focus or inert state;
     * D46S2 audit S2): the owner resolved and current now, and `intent()` (when given: the opening is still its
     * surface's latest) true. Null: the opening is rejected and does nothing else.
     */
    JE.admitSurface = function (owner, site, intent) {
        const resolved = JE.effectOwner(owner, site || 'a surface');
        return resolved && (!intent || intent() === true) ? resolved : null;
    };
    // Focus (D46S2-R11-12): opening a surface moves focus into it; Tab (and jellyfin-web's D-pad: a `focuscontainer`)
    // stays inside the topmost one; closing gives focus back to its opener while that is still live, else to the next
    // surface down, else to what held the opener (its card, row or page), else to the page.
    const FOCUSABLE = 'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]';
    /** The controls of `root` focus can be on, in order (enabled, not hidden, not inert, not tabindex -1). */
    const focusables = root => [...root.querySelectorAll(FOCUSABLE)].filter(n => !n.disabled && n.tabIndex >= 0 &&
        !n.closest('[hidden], [inert], .hide') && n.style.display !== 'none' && n.style.visibility !== 'hidden');
    /** Focuses the first of `nodes` that takes focus; true when one did. */
    function focusFirst(nodes) {
        for (const node of nodes) {
            try { node.focus({ preventScroll: true }); } catch (_) { /* not focusable */ }
            if (document.activeElement === node) return true;
        }
        return false;
    }
    /** Moves focus into `root` unless it is already there: its [autofocus] control, else its first control, else itself. */
    function focusInto(root) {
        if (!root.isConnected || root.contains(document.activeElement)) return;
        const preferred = root.querySelector('[autofocus]');
        if (focusFirst([...(preferred ? [preferred] : []), ...focusables(root)])) return;
        if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
        focusFirst([root]);
    }
    /** A control focus may go back to: connected, enabled, not inert and not inside a closed surface. */
    const live = node => !!node?.isConnected && typeof node.focus === 'function' && !node.disabled && !node.closest('[inert]') &&
        !(node.closest && [...stack].some(entry => entry.closed && entry.root.contains(node)));
    /** Where focus goes when a surface closes (see above). */
    function restoreFocus(entry) {
        if (live(entry.opener) && focusFirst([entry.opener])) return;
        const below = topmost();
        if (below) { if (!below.host) focusInto(below.root); return; }
        const holder = entry.holder?.isConnected ? entry.holder : document.querySelector('.mainAnimatedPage:not(.hide), .page:not(.hide)');
        if (holder && focusFirst(focusables(holder))) return;
        document.activeElement?.blur?.();
    }

    /**
     * Registers an admitted surface `root` for `owner` (see admitSurface; an owner that is not current is rejected:
     * null, and `close()` runs at once for a caller that drew it already). `close()` closes it; `options.opener`: the
     * control focus goes back to (default: the focused one); `options.dismiss`: what Escape and every Back key do while
     * it is topmost (default close). It joins the one surface stack, takes focus (once it is in the document) and keeps
     * the host's D-pad inside it. Once the owner ends, the surface takes no more input and closes at the next lifecycle
     * step. Returns release() for a normal close (the surface leaves the stack and every registry, turns inert and gives
     * focus back), or null when rejected.
     */
    JE.openSurface = function (root, close, owner, options = {}) {
        if (!root) return null;
        const resolved = JE.admitSurface(owner, 'openSurface');
        // Rejected: nothing registers; a caller that already drew it (it should admit first) has it closed at once.
        if (!resolved) { queueMicrotask(close); return null; }
        owners.set(root, resolved);
        let surfaces = scopes.get(resolved);
        if (!surfaces) scopes.set(resolved, surfaces = new Set());
        const opener = options.opener || (document.activeElement !== document.body ? document.activeElement : null);
        const entry = { root, owner: resolved, dismiss: options.dismiss || null, closed: false, close: null, release: null, opener,
            holder: opener?.closest?.('.card, .jellyseerr-card, .mainDetailButtons, .detailButtons, .je-more-info-modal, .page') || null };
        entry.release = () => {
            if (entry.closed) return;
            entry.closed = true;
            surfaces.delete(entry);
            if (!surfaces.size && scopes.get(resolved) === surfaces) scopes.delete(resolved);
            const index = stack.indexOf(entry);
            if (index >= 0) stack.splice(index, 1);
            root.setAttribute('inert', '');
            root._jeClosed = true;
            const focused = document.activeElement;
            if (!focused || focused === document.body || root.contains(focused)) restoreFocus(entry);
            entry.opener = entry.holder = null;
        };
        entry.close = () => { if (entry.closed) return; entry.release(); close(); };
        surfaces.add(entry);
        stack.push(entry);
        watchHost();
        root.classList.add('focuscontainer');
        // Its opener draws it now (it may be appended after this call): focus moves in once it is in the document.
        queueMicrotask(() => { if (!entry.closed && JE.isTopmostSurface(root)) focusInto(root); });
        JE.rejectEnded(root, event => {
            // A press dispatched inside it for another, current owner (an owned control of a closed sheet) is that owner's.
            const pressed = event && presses.get(event);
            if (pressed && pressed !== resolved && isCurrent(pressed)) return false;
            // Closed: terminal, it takes no input. Else only while its owner is current.
            if (entry.closed) return event.type !== 'keydown';
            return !isCurrent(resolved);
        }, entry.close);
        return entry.release;
    };

    // Dismissal keys (D46S2-R11-11): every key jellyfin-web turns into Back (its keyboard navigation and input manager on
    // 10.11.11 and 12.2: keyCode 461 and 10009, TV-layout Escape (27, also a gamepad's B through its gamepad-to-key) and a
    // UWP gamepad's B (196), Backspace on Hisense VIDAA TVs; plus the browser's own Back key) dismisses the topmost JE
    // surface only, and is consumed before jellyfin-web's router (its window keydown listener ignores a prevented key)
    // or the browser sees it. Escape closes a JE surface on every layout. A host dialog on top keeps its own keys.
    const VIDAA = /vidaa/i.test(navigator.userAgent || '');
    const editable = node => !!node && (/^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName) || node.isContentEditable);
    /** True for a key jellyfin-web (or the browser) treats as Back. */
    const dismissalKey = event => [27, 196, 461, 10009].includes(event.keyCode) || ['Escape', 'GoBack', 'BrowserBack'].includes(event.key) ||
        event.code === 'BrowserBack' || (VIDAA && event.key === 'Backspace' && !editable(event.target));
    JE.isDismissalKey = dismissalKey;
    window.addEventListener('keydown', event => {
        const top = topmost();
        if (!top || top.host || event.defaultPrevented) return;
        if (dismissalKey(event)) {
            event.preventDefault(); event.stopImmediatePropagation();
            if (top.dismiss) top.dismiss(event); else top.close();
            return;
        }
        if (event.key !== 'Tab' || event.ctrlKey || event.altKey || event.metaKey) return;
        // Tab stays inside the topmost surface: from outside it, or past either end, focus wraps inside.
        const controls = focusables(top.root);
        const active = document.activeElement;
        const inside = top.root.contains(active);
        const edge = event.shiftKey ? controls[0] : controls[controls.length - 1];
        if (inside && controls.length && active !== edge && active !== top.root) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (!controls.length) { focusInto(top.root); return; }
        focusFirst(event.shiftKey ? [controls[controls.length - 1]] : [controls[0]]);
    }, true);
    // ------------------------------------------------------------------ popups (audit S6: a real popup lifecycle)
    const POPUP_MARGIN = 8;
    /**
     * Places `popup` next to `anchor`, measured: below it when it fits in the viewport, else above it, else clamped
     * inside the viewport; never wider than the viewport, its left edge kept inside it. False once the anchor has gone.
     */
    JE.placePopup = function (popup, anchor, { gap = 4, matchWidth = true } = {}) {
        if (!anchor?.isConnected) return false;
        const rect = anchor.getBoundingClientRect();
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        popup.style.position = 'fixed';
        if (matchWidth) popup.style.width = `${Math.max(0, Math.min(rect.width, viewportWidth - 2 * POPUP_MARGIN))}px`;
        popup.style.maxWidth = `${Math.max(0, viewportWidth - 2 * POPUP_MARGIN)}px`;
        popup.style.maxHeight = `${Math.max(0, viewportHeight - 2 * POPUP_MARGIN)}px`;
        const box = popup.getBoundingClientRect();
        const width = box.width || popup.offsetWidth || 0;
        const height = box.height || popup.offsetHeight || 0;
        const below = rect.bottom + gap;
        const above = rect.top - gap - height;
        let top = below;
        if (below + height > viewportHeight - POPUP_MARGIN) top = above >= POPUP_MARGIN ? above : Math.max(POPUP_MARGIN, viewportHeight - POPUP_MARGIN - height);
        const left = Math.min(Math.max(rect.left, POPUP_MARGIN), Math.max(POPUP_MARGIN, viewportWidth - POPUP_MARGIN - width));
        popup.style.top = `${top}px`;
        popup.style.left = `${left}px`;
        popup.dataset.jePlacement = top === below ? 'below' : top === above ? 'above' : 'clamped';
        return true;
    };
    /**
     * Opens a popup portaled to the body as a surface of `owner` (see openSurface): it is placed next to `anchor`
     * (measured, flipped or clamped into the viewport) and follows the page while open (scroll, resize; it closes once
     * the anchor goes); Escape or a remote's Back close it while it is the topmost surface, with focus back on `opener`;
     * opened from the keyboard or a remote (`keyboard`), its first enabled item takes focus. `close()` removes it.
     * Returns release() (the caller's normal close calls it), or null when the owner is not current (nothing opened).
     */
    JE.openPopup = function (popup, { anchor, owner, opener, close, keyboard = false, gap = 4, matchWidth = true }) {
        const admitted = JE.admitSurface(owner, 'a popup');
        if (!admitted) return null;
        let life = null;
        const finish = () => {
            if (!life) return;
            const current = life; life = null;
            window.removeEventListener('scroll', current.follow, true);
            window.removeEventListener('resize', current.follow);
            current.release?.();
        };
        // Escape and every Back key reach it through the surface stack while it is topmost (its focus goes back to its
        // opener as it closes).
        const release = JE.openSurface(popup, () => { finish(); close(); }, admitted, { opener });
        if (!release) return null;
        const follow = () => { if (life && !JE.placePopup(popup, anchor, { gap, matchWidth })) { finish(); close(); } };
        life = { release, follow };
        if (!popup.isConnected) document.body.appendChild(popup);
        JE.placePopup(popup, anchor, { gap, matchWidth });
        window.addEventListener('scroll', follow, true);
        window.addEventListener('resize', follow);
        if (keyboard) popup.querySelector('button:not(:disabled), [tabindex="0"]')?.focus();
        return finish;
    };

    /** The topmost open surface's root (or null). */
    const topmost = () => {
        for (let i = stack.length - 1; i >= 0; i--) if (!stack[i].closed && stack[i].root.isConnected) return stack[i];
        return null;
    };
    /** True while `root` is the topmost open surface: Escape and Back act on it only (D46S2 audit S2). */
    JE.isTopmostSurface = root => topmost()?.root === root;
    /** True once `root` (a surface) has closed: it is terminal, no input reaches it. */
    JE.surfaceClosed = root => !!root?._jeClosed;

    /** Closes every registered surface whose owner has ended; each lifecycle step (route, user, document, mount) calls it. */
    JE.endScopes = function () {
        for (const [owner, surfaces] of [...scopes]) {
            if (isCurrent(owner)) continue;
            for (const entry of [...surfaces]) { try { entry.close(); } catch (error) { console.error('Jellyfin Enhanced: closing an ended surface failed', error); } }
        }
    };
    JE.session?.onUserChange?.('session-actions', () => {
        for (const dismiss of [...dismissals]) dismiss();
        dismissals.clear();
        JE.endScopes();
    });

    // ------------------------------------------------------------------ host dialogs (D46S2-R10-10: correlated by identity)
    // jellyfin-web's dialogs (Dashboard.alert, Dashboard.confirm): each opens in its own container on the body, a moment
    // after the call, and the host returns no handle. Each opening stamps its text with an invisible marker of its own
    // (mark(text)); a container is claimed only by the opening whose marker it shows, an unmarked or unknown container
    // is left alone, and an opening whose open() fails or adds nothing within 5 s deregisters.
    const HOST_DIALOG = '.dialogContainer';
    /** Dismisses a host dialog the way its viewer would: its first button, else the container goes. */
    function dismissHostDialog(node) {
        if (!node.isConnected) return;
        const button = node.querySelector('.btnOption, .formDialogFooterItem, button');
        if (button) button.click(); else node.remove();
    }
    const openings = new Map();
    let markers = 0;
    // Zero-width marks: U+2060 frames the opening's number in U+200B (0) / U+200C (1).
    const markOf = n => '\u2060' + n.toString(2).replace(/0/g, '\u200b').replace(/1/g, '\u200c') + '\u2060';
    // The host's dialogs on the one surface stack (D46S2-R11-10): a host dialog that arrives while a JE surface is open
    // is registered on arrival (topmost: Escape and Back are the host's, nothing under it takes them) and released when
    // the host removes it; an opening's claim on its own dialog (see openHostDialog) is released with it. No record or
    // node outlives the dialog.
    const claims = new Map();
    let hostObserver = null;
    function hostChanged(records) {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node.nodeType !== 1 || !node.matches(HOST_DIALOG)) continue;
                const text = node.textContent || '';
                for (const [mark, opening] of openings) {
                    if (!text.includes(mark)) continue;
                    openings.delete(mark);
                    opening.arrive(node);
                    break;
                }
                if (node.isConnected && stack.some(entry => !entry.host && !entry.closed) && !stack.some(entry => entry.root === node))
                    stack.push({ root: node, host: true, closed: false, close: () => dismissHostDialog(node) });
            }
            for (const node of record.removedNodes) {
                if (node.nodeType !== 1 || node.isConnected) continue;
                const index = stack.findIndex(entry => entry.host && entry.root === node);
                if (index >= 0) { stack[index].closed = true; stack.splice(index, 1); }
                const claim = claims.get(node);
                if (claim) { claims.delete(node); claim(); }
            }
        }
    }
    /** Starts watching the body's children for host dialogs (once; the body's direct children only). */
    function watchHost() {
        if (hostObserver || !document.body) return;
        hostObserver = new MutationObserver(hostChanged);
        hostObserver.observe(document.body, { childList: true });
    }
    /**
     * Opens a host dialog for `owner` (required, D46S2-R7-4), a surface like every other: nothing opens unless the owner
     * is current at the call; `open(mark)` opens it and stamps its text with `mark(text)`; the dialog it opened is
     * dismissed once its owner ends (one that attaches after that is dismissed as it arrives), and every record of it
     * goes once the host removes it. Returns the host's result, or null when nothing opened.
     */
    JE.openHostDialog = function (open, owner) {
        const resolved = JE.effectOwner(owner, 'openHostDialog');
        if (!resolved) return null;
        const mark = markOf(++markers);
        let surfaces = scopes.get(resolved);
        if (!surfaces) scopes.set(resolved, surfaces = new Set());
        const release = () => { surfaces.delete(entry); if (!surfaces.size && scopes.get(resolved) === surfaces) scopes.delete(resolved); };
        // Ended before its dialog arrived: the opening keeps waiting (up to its 5 s) and dismisses it on arrival.
        const entry = { node: null, ended: false, close: () => { entry.ended = true; release(); if (entry.node) dismissHostDialog(entry.node); } };
        const opening = { arrive(node) {
            entry.node = node;
            claims.set(node, () => { release(); entry.node = null; });
            if (entry.ended || !isCurrent(resolved)) dismissHostDialog(node);
        } };
        openings.set(mark, opening);
        surfaces.add(entry);
        watchHost();
        let result;
        try { result = open(text => String(text ?? '') + mark); }
        catch (error) { openings.delete(mark); release(); throw error; }
        if (hostObserver) hostChanged(hostObserver.takeRecords());
        // A container later than 5 s after the call is not this opening's.
        setTimeout(() => { if (openings.get(mark) === opening) { openings.delete(mark); if (!entry.node) release(); } }, 5000);
        if (!isCurrent(resolved)) queueMicrotask(entry.close);
        return result;
    };

    // ------------------------------------------------------------------ intents and publications
    // Each surface's intents (D46S2-R8-2, R9-3): its reads, and the writes that answer into it, one slot per write identity.
    const intents = new WeakMap();
    /**
     * Starts an intent of `surface` (a window, a card, a form's opener) and returns its check, also false once `owner`
     * (when given) ends. A read (no `key`: a Refresh, a redraw) holds while no later intent of the surface has started;
     * a write (`key`: its identity, see {@link JE.publication}) holds while no later read of the surface and no later
     * write of the same identity has started, so a standard and a 4K request answer independently (D46S2-R9-3) while a
     * Refresh or a replacement still supersedes both.
     */
    JE.surfaceIntent = function (surface, owner, key) {
        let slot = intents.get(surface);
        if (!slot) intents.set(surface, slot = { all: 0, reads: 0, writes: new Map() });
        const mine = ++slot.all;
        const live = () => !owner || holds(owner);
        if (key == null) { slot.reads = mine; return () => slot.all === mine && live(); }
        const reads = slot.reads;
        slot.writes.set(key, mine);
        return () => slot.reads === reads && slot.writes.get(key) === mine && live();
    };

    // Nodes naming a title, and the surfaces that draw what they show from their own reads (they take only their own
    // publications; a card elsewhere follows any publication of its title).
    const NAMED = '[data-tmdb-id][data-media-type]';
    const SELF_DRAWN = '.je-more-info-modal';
    /**
     * The title a node shows: {tmdbId, mediaType, edition}. A control (a button) shows one edition (data-je-edition,
     * a 4K toggle, arrow or popup item: '4k'; else 'standard'); a surface (a window, a card) shows both (null). What the
     * node does not name comes from the nearest ancestor that names a title; null when there is none.
     */
    function identityOf(node) {
        if (!node || node.nodeType !== 1) return null;
        const named = node.matches(NAMED) ? node : node.closest(NAMED);
        const tmdbId = node.dataset.tmdbId || named?.dataset.tmdbId;
        const mediaType = node.dataset.mediaType || named?.dataset.mediaType;
        if (!tmdbId || !mediaType) return null;
        const edition = !node.matches('button, [role="button"]') ? null
            : node.dataset.jeEdition === '4k' || node.dataset.toggle4k === 'true' || node.matches('.jellyseerr-split-arrow, .je-4k-popup-item, .jellyseerr-4k-popup-item') ? '4k' : 'standard';
        return { tmdbId: String(tmdbId), mediaType: String(mediaType).toLowerCase(), edition };
    }
    JE.identityOf = identityOf;

    // The surfaces that follow publications (D46S2-R9-5, R10-6): a window, the search and discovery cards.
    const followers = new Set();
    /**
     * Follows the publications of completions, declaratively (D46S2-R10-6): `{ selector, within, exclude }` names the
     * nodes (those matching `selector` in `within`, a node or the document, `within` itself included, none inside an
     * `exclude` match); core selects them, so
     * no follower code runs before a publication is admitted. `apply(handle)` runs for each node the publication reaches,
     * under the publication's token (it restricts what runs, see acting), with a scoped handle: `handle.node`,
     * `handle.answer` (the published detail plus {tmdbId, mediaType, is4k, variant}), `handle.current()`,
     * `handle.mutate(fn)` (fn(node) only while the publication still reaches it) and `handle.intent(surface)` (a read
     * the answer starts there, see {@link JE.surfaceIntent}). Returns unfollow().
     */
    JE.followPublications = function ({ selector, within, exclude } = {}, apply) {
        if (typeof selector !== 'string' || typeof apply !== 'function') return () => {};
        const follower = { selector, within, exclude, apply };
        followers.add(follower);
        return () => followers.delete(follower);
    };
    function candidatesOf({ selector, within, exclude }) {
        const root = within || document;
        if (within && !within.isConnected) return [];
        const nodes = [...(root.nodeType === 1 && root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)];
        return exclude ? nodes.filter(node => !node.closest(exclude)) : nodes;
    }

    /**
     * The publication of a completion (D46S2-R8-2, R8-6, R9-5), taken before the write's await: the only handle that
     * may change UI for its answer (chips, labels, the cards that follow the title, a refusal's dialog), and a token
     * itself (a child of `owner`, so a dialog opened for it opens only while it holds and closes with it). `owner`
     * (required): the press's; `surface`: the window, card or form opener the write started in, shown while connected
     * and not closing; its newest intent for this identity starts here (a later read of the surface, or a later write
     * of the same identity, supersedes it: {@link JE.surfaceIntent}); `identity`: {tmdbId, mediaType, is4k, variant}
     * (title, media type, edition and an optional variant such as a season set: `key`). Its effects check it at the
     * moment they happen and run under it: `run(fn)`: fn() now, only while current; `apply(node, fn)`: fn(node) only
     * while it reaches `node`; `publish(detail)`: the followers' apply for every node it reaches. `reaches(node)`:
     * current, and `node` shows this title and media type (a control: this edition) inside the surface, or outside every
     * window (a card following the title elsewhere).
     */
    JE.publication = function ({ owner, surface, identity }) {
        const resolved = JE.requireOwner(owner, 'publication');
        const id = identity ? { tmdbId: String(identity.tmdbId), mediaType: String(identity.mediaType || '').toLowerCase(), edition: identity.is4k ? '4k' : 'standard',
            variant: identity.variant == null ? '' : String(identity.variant) } : null;
        const key = id ? `${id.tmdbId}|${id.mediaType}|${id.edition}|${id.variant}` : '';
        const newest = surface && resolved ? JE.surfaceIntent(surface, resolved, key) : () => false;
        const shows = () => !!resolved && !!surface && surface.isConnected === true && !surface._isClosing && !surface._jeClosed && newest();
        const self = resolved ? mint('publication', { parent: resolved, mount: shows, session: resolved.session }) : null;
        const lives = self ? self.current : () => false;
        const current = () => lives();
        function reaches(node) {
            if (!id || !node || !current()) return false;
            const named = identityOf(node);
            // Its own surface, even one that names no title (an opener drawn without its ids).
            if (!named) return node === surface;
            if (named.tmdbId !== id.tmdbId || named.mediaType !== id.mediaType || (named.edition && named.edition !== id.edition)) return false;
            return node === surface || surface.contains(node) || !node.closest(SELF_DRAWN);
        }
        const failed = error => {
            if (JE.strictOwners === true && /^Jellyfin Enhanced: /.test(error?.message || '')) throw error;
            console.error('Jellyfin Enhanced: a publication follower failed', error);
        };
        const handle = Object.assign(self || {}, {
            owner: resolved, surface, identity: id, key, current, reaches,
            run(fn) {
                if (!current()) return false;
                restricted(self, fn);
                return true;
            },
            apply(node, fn) {
                if (!reaches(node)) return false;
                restricted(self, () => fn(node));
                return true;
            },
            publish(detail = {}) {
                if (!id || !current()) return false;
                const answer = Object.freeze({ ...detail, tmdbId: id.tmdbId, mediaType: id.mediaType, is4k: id.edition === '4k', variant: id.variant });
                for (const follower of [...followers]) {
                    try {
                        for (const node of candidatesOf(follower)) {
                            if (!reaches(node)) continue;
                            const scoped = Object.freeze({ node, answer, current: () => reaches(node),
                                mutate: fn => reaches(node) ? (fn(node), true) : false,
                                // A read this answer starts in `surface` (a series re-read): the newest intent of this
                                // publication's identity there, while its owner is current.
                                intent: within => JE.surfaceIntent(within, resolved, key) });
                            restricted(self, () => follower.apply(scoped));
                        }
                    } catch (error) { failed(error); }
                }
                return true;
            },
        });
        return handle;
    };

    /**
     * Publication for the newest intent of one surface (D46S2-R6 shape 3): each call starts an intent and returns its
     * check, true only while no later intent of the same surface has started and `owner` (when given) is current. A
     * read's answer renders only while its check holds, so an older, slower answer never replaces a newer one.
     */
    JE.latestIntent = function () {
        let latest = 0;
        return owner => { const mine = ++latest; return () => mine === latest && (!owner || holds(owner)); };
    };

    /**
     * Captures identity before a gesture, confirmation, timer or asynchronous lookup. With `{ owner }` (required
     * whenever the work belongs to whoever invoked it: a token, a node or the press event) the action is that owner's:
     * current while it is, and its writes carry its binding. Without options it captures the session only (no
     * authority): current while the session is; a binding taken from it inside an operation's press or runner also
     * ends with that operation, so it never outlives it (D46S2-R10-1).
     */
    JE.createSessionAction = function (options) {
        const owned = !!options && ('owner' in options || 'submitted' in options);
        const resolved = owned ? ('owner' in options ? JE.requireOwner(options.owner, 'createSessionAction') : missing('createSessionAction({ submitted })')) : null;
        const inside = owned ? null : actingOperation();
        const session = resolved?.session || captureSession();
        const live = () => !owned || (!!resolved && isCurrent(resolved));
        const current = () => session.current() && live();
        const writable = () => session.current() && (!owned || (!!resolved && JE.mayWrite(resolved))) && (!inside || isCurrent(inside));
        /**
         * The request binding for work this action owns: the transport sends it only while this session is the
         * signed-in one, its owner (if any) may write and `check()` (when given) is true, right before the bytes go out.
         */
        const bound = check => resolved ? resolved.bound(check)
            : Object.freeze({ session, current: () => live() && (!inside || isCurrent(inside)) && (!check || check() === true) });
        return {
            current,
            /** Its writes may still go out: its owner's writable() (a session capture: its session, and the operation it was taken in). */
            writable,
            session,
            /** The operation this action is bound to (null natively or without an owner). */
            operation: operationOf(resolved),
            /** Its owner: a token, or null (a session capture, or an owner-taking call that named none). */
            owner: resolved,
            bound,
            /** `bound(check)` for a write its owner makes. */
            operationBound: check => bound(check),
            /** Rejects a deferred callback after either identity or epoch changes. */
            bind: callback => (...args) => current() ? callback(...args) : false,
            /** Registers owned UI cleanup; returns a release function for normal dismissal. */
            onCancel: dismiss => {
                dismissals.add(dismiss);
                return () => dismissals.delete(dismiss);
            }
        };
    };
})(window.JellyfinEnhanced);
