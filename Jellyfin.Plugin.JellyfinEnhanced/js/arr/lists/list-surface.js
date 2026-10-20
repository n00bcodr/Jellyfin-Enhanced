/**
 * @file Requests & downloads, phase 4c3b: who owns a list authoring surface (a picker, a search, a note editor), when
 * what it read may still be shown, and the one place its deferred effects and its words are made. Nothing runs on load.
 *
 * An **origin** ({@link origin}) is one opened surface: its explicit owner (an operation, or JE.NATIVE only at a
 * declared native root, never as a stand-in for a lost owner), the session it opened in (epoch, person, server), the
 * document lifecycle it opened in (a pagehide or freeze ends it; a back-forward cache restore does not bring it back),
 * its mount (still in the document) and a live check of the flags and access it needs (asked again at every decision).
 * Once any of these fails it has ended, for good. It owns:
 * - a real paint ticket with no list (lp.gate.issue(null, ...)) whose Spoiler policy is the viewer's, read through the
 *   policy loader given (guard everything until it is read, or when there is none);
 * - per-channel newest-intent checks ({@link intent}): a newer query, season, reload or read of the same channel makes
 *   the older one's answer unpublishable; channels are independent;
 * - a **target** ({@link selectTarget}): the chosen list, with its own ticket (that list id). What depends on the target
 *   is declared ({@link ORIGIN_DEPENDS}): choosing another list, or a new one ({@link clearTarget}), ends the old
 *   target's ticket (its reads), its results and every target-bound intent at once; the origin lives on. A list just
 *   created becomes the target the same way ({@link created}): its read-back runs under the same origin;
 * - {@link handoff}: a replacement or a fallback reopen carries the owner, the session and the document lifecycle
 *   captured BEFORE the old surface closes; it opens one replacement, and nothing if any of them ended meanwhile.
 * {@link inflight}: in-flight work keyed by owner and immutable input; a second press of the same owner joins nothing
 * new, another owner's identical press starts on its own, and a release only removes its own entry.
 *
 * **Effects** ({@link effects}) are the one wrapper for everything that runs later: paints held by the gate for the
 * Spoiler policy, awaited continuations ({@link task}'s step), listeners and portal closes. Each re-checks, WHEN IT RUNS,
 * the ticket (owner, session, lifecycle, mount and live check through the origin; session and page for a page ticket),
 * the intent it was made for (including what that intent depends on), and the presenter's own destroyed state, which is
 * monotonic and never revokes a shared ticket. **Words** ({@link words}, {@link put}) are the one way text reaches the
 * page: titles, notes, air dates and years go through the ticket's Spoiler policy, and the text sinks take nothing else.
 * The list authoring tests scan the eight modules: deferred calls and text sinks outside this file's helper region fail.
 *
 * Internal: lp.surface { origin, inflight, requireOwner, effects, words, put, ORIGIN_DEPENDS, subscribers }.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.arrListPages = JE.internals.arrListPages || {};

    /** Most in-flight entries kept (the oldest is forgotten beyond it). */
    const MAX_INFLIGHT = 256;
    /**
     * What depends on what in an origin (upstream → dependents; `name:*` is every channel of that name). A change of an
     * upstream ends its dependents: their intents stop holding and their reset runs.
     */
    const ORIGIN_DEPENDS = Object.freeze({ target: Object.freeze(['target:*']) });

    /**
     * A programming error: thrown where JE.strictOwners is set (tests), logged in production.
     * @param {string} message What.
     */
    function refuse(message) {
        const text = `Jellyfin Enhanced: ${message}`;
        if (JE.strictOwners === true) throw new Error(text);
        console.error(text);
    }

    /**
     * An explicit owner (an operation: anything with current(); JE.NATIVE only at a declared native root). No owner is
     * a programming error: it throws where JE.strictOwners is set (tests), and is logged in production, where nothing
     * opens.
     * @param {*} owner Owner.
     * @param {boolean} nativeRoot The caller is a genuine native entry point.
     * @param {string} site Caller.
     * @returns {Object|null} Owner.
     */
    function requireOwner(owner, nativeRoot, site) {
        const native = owner && owner.native === true;
        if (native && !(nativeRoot === true && JE.NATIVE && owner === JE.NATIVE)) {
            refuse(`${site} was given a native owner outside a native root`);
            return null;
        }
        if (owner && typeof owner === 'object' && typeof owner.current === 'function') return owner;
        refuse(`${site} was called without an owner`);
        return null;
    }

    /** @returns {{epoch: number, user: (string|null), server: (string|null)}} The session now. */
    function sessionNow() {
        const s = JE.session;
        return { epoch: s?.getEpoch ? s.getEpoch() : 0, user: s?.getUserId ? s.getUserId() : null, server: s?.getServerId ? s.getServerId() : null };
    }

    /** @param {Object} a Session. @param {Object} b Session. @returns {boolean} The same session. */
    const sameSession = (a, b) => !!a && !!b && a.epoch === b.epoch && a.user === b.user && a.server === b.server;

    /**
     * The viewer's Spoiler policy for a target (or none), or guard-everything.
     * @param {Function|undefined} loader The caller's loader.
     * @param {Object|null} target {listKind, listId} or null.
     * @returns {Object|function(): Promise<Object>} Policy or its loader (lp.gate.issue's argument).
     */
    function policyOf(loader, target) {
        if (typeof loader !== 'function') return lp.gate.GUARD_ALL;
        let value;
        try {
            value = loader(target);
        } catch (error) {
            return () => Promise.reject(error);
        }
        // Known at once (Spoiler Guard off): no wait; else the gate waits for it, guarding everything meanwhile.
        return typeof value === 'function' && value.resolved === true ? value : () => value;
    }

    // @je-guard-begin
    // The helper region: the only code in the list authoring modules that hands a callback to something that runs it
    // later, or writes words into the page. Every such callback re-checks its binding when it runs.

    /** The document lifecycle: a pagehide or freeze starts a new one (a back-forward cache restore does not go back). */
    const lifecycle = { epoch: 0, installed: false, subscribers: new Set() };

    /**
     * The document lifecycle now (its listeners are added once, on first use, never on load).
     * @returns {number} Its epoch.
     */
    function lifecycleNow() {
        if (!lifecycle.installed) {
            lifecycle.installed = true;
            const hide = () => {
                lifecycle.epoch++;
                for (const fn of Array.from(lifecycle.subscribers)) fn();
            };
            window.addEventListener('pagehide', hide);
            document.addEventListener('freeze', hide);
        }
        return lifecycle.epoch;
    }

    /**
     * Ends something when the document lifecycle ends (teardown only).
     * @param {function(): void} fn What ends.
     * @returns {function(): void} Unsubscribe.
     */
    function onLifecycleEnd(fn) {
        lifecycleNow();
        lifecycle.subscribers.add(fn);
        return () => lifecycle.subscribers.delete(fn);
    }

    /**
     * Runs teardown (cleanup and closes): it may only take things away, never put anything in.
     * @param {function(): void} fn Teardown.
     */
    function teardown(fn) {
        try {
            lp.gate.erase(fn);
        } catch (error) {
            console.warn('🪼 Jellyfin Enhanced: Lists: a surface cleanup failed', error);
        }
    }

    /** A step whose binding ended (internal to {@link effects}' task; never escapes it). */
    const STALE = Object.freeze({ staleStep: true });
    /** An intent check that never holds. */
    const DEAD = () => false;
    let fxSeq = 0;

    /**
     * The one wrapper for the deferred effects of one surface or presenter.
     * @param {{ticket: Object, depends?: Object<string, string[]>}} options Its ticket (whose current() carries the
     *   owner, session, lifecycle, mount and live check, or a page's session and scope) and its dependency table.
     * @returns {Object} Effects: intent, change, reset, paint, publish, task, on, portal, destroy.
     */
    function effects(options) {
        const ticket = options?.ticket;
        const table = options?.depends || {};
        const gens = new Map();
        const resets = new Map();
        const listeners = [];
        const uid = ++fxSeq;
        let destroyed = false;

        const gen = channel => gens.get(channel) || 0;
        /** @returns {boolean} The binding holds: not destroyed and the ticket current. */
        const valid = () => !destroyed && !!ticket && typeof ticket.current === 'function' && ticket.current() === true;
        /** @param {string} pattern A declared dependent. @param {string} channel A channel. @returns {boolean} Matches. */
        const matches = (pattern, channel) => pattern === channel || (pattern.endsWith(':*') && channel.startsWith(pattern.slice(0, -1)));
        /** @param {string} channel Channel. @returns {string[]} Its upstreams, all the way up. */
        const upstreams = (channel) => {
            const out = [];
            const visit = (c) => {
                for (const [up, downs] of Object.entries(table)) {
                    if (out.includes(up) || !downs.some(d => matches(d, c))) continue;
                    out.push(up);
                    visit(up);
                }
            };
            visit(channel);
            return out;
        };
        /** @param {string} channel Channel. @returns {string[]} The known channels that depend on it, all the way down. */
        const dependents = (channel) => {
            const known = Array.from(new Set([...gens.keys(), ...resets.keys()]));
            const out = [];
            const visit = (c) => {
                for (const pattern of table[c] || []) {
                    const named = pattern.endsWith(':*') ? known.filter(k => matches(pattern, k)) : [pattern];
                    for (const d of named) {
                        if (out.includes(d) || d === channel) continue;
                        out.push(d);
                        visit(d);
                    }
                }
            };
            visit(channel);
            return out;
        };
        /** A change of a channel: its older intents stop holding, and so does everything that depends on it. */
        const bump = (channel) => {
            gens.set(channel, gen(channel) + 1);
            for (const d of dependents(channel)) {
                gens.set(d, gen(d) + 1);
                const reset = resets.get(d);
                if (reset) reset();
            }
        };
        /** @param {function(): boolean|null} check An intent check (null: none). @returns {boolean} It and the binding hold. */
        const holds = check => (check == null || check() === true) && valid();

        const fx = {
            ticket,
            /** @returns {boolean} The binding holds now. */
            current: valid,
            /** @returns {boolean} Destroyed (for good). */
            get destroyed() {
                return destroyed;
            },
            /**
             * A new intent on a channel: older intents of the channel, and everything depending on the channel, stop holding.
             * @param {string} channel Channel.
             * @returns {function(): boolean} Holds while it is the newest of its channel, nothing upstream changed, and the binding holds.
             */
            intent(channel) {
                if (!valid()) return DEAD;
                bump(channel);
                const chain = [channel, ...upstreams(channel)];
                const seen = chain.map(gen);
                return () => valid() && chain.every((c, i) => gen(c) === seen[i]);
            },
            /** An upstream changed: its dependents stop holding and reset. @param {string} channel Channel. */
            change(channel) {
                bump(channel);
            },
            /**
             * What a dependent drops when something it depends on changes.
             * @param {string} channel The dependent.
             * @param {function(): void} fn Reset (state only; it never paints by itself).
             */
            reset(channel, fn) {
                resets.set(channel, fn);
            },
            /**
             * Paints through the gate; the writes run only if, when they run (now, or once the Spoiler policy is known),
             * the intent and the binding still hold.
             * @param {function(): boolean|null} check Intent check (null: none).
             * @param {function(): void} fn Writes.
             * @param {string} [key] Paint key (this presenter's own; another presenter's paint of the same name never replaces it).
             * @returns {boolean} Painted now.
             */
            paint(check, fn, key = 'paint') {
                if (!holds(check)) return false;
                let ran = false;
                const painted = lp.gate.paint(ticket, () => {
                    if (!holds(check)) return;
                    ran = true;
                    fn();
                }, `${uid}:${key}`);
                return painted && ran;
            },
            /**
             * Runs a non-DOM effect (cache, event, toast, navigation, remembered choice) for the newest intent only.
             * @param {function(): boolean} check Intent check.
             * @param {function(): void} fn Effect.
             * @returns {boolean} Ran.
             */
            publish(check, fn) {
                if (typeof check !== 'function' || !holds(check)) return false;
                fn();
                return true;
            },
            /**
             * Runs async work whose every continuation is checked: `await step(x)` resumes only while the intent and the
             * binding hold (resolving to {ok: true, value} or {ok: false, error}); otherwise the work stops there.
             * @param {function(): boolean|null} check Intent check (null: none).
             * @param {function(function(*): Promise<{ok: boolean, value?: *, error?: *}>): Promise<*>} body Work.
             * @param {*} [stopped] What it resolves to when it stopped (default null).
             * @returns {Promise<*>} Its result, or `stopped`.
             */
            task(check, body, stopped = null) {
                if (!holds(check)) return Promise.resolve(stopped);
                const step = (value) => {
                    let pending;
                    try {
                        pending = Promise.resolve(typeof value === 'function' ? value() : value);
                    } catch (error) {
                        pending = Promise.reject(error);
                    }
                    return pending.then(
                        v => (holds(check) ? { ok: true, value: v } : Promise.reject(STALE)),
                        e => (holds(check) ? { ok: false, error: e } : Promise.reject(STALE)));
                };
                let run;
                try {
                    run = Promise.resolve(body(step));
                } catch (error) {
                    run = Promise.reject(error);
                }
                return run.then(v => (holds(check) ? v : stopped), e => (e === STALE ? stopped : Promise.reject(e)));
            },
            /**
             * A listener that acts only while the binding holds; removed when this is destroyed.
             * @param {EventTarget} target Target.
             * @param {string} type Event.
             * @param {function(Event): void} fn Handler.
             */
            on(target, type, fn) {
                if (destroyed) return;
                const handler = (e) => {
                    if (valid()) fn(e);
                };
                target.addEventListener(type, handler);
                listeners.push([target, type, handler]);
            },
            /**
             * Registers a portal with the shared surface registry; it closes (teardown only, once) when its owner ends.
             * @param {Function} openSurface The registry (JE.openSurface).
             * @param {HTMLElement} root The portal.
             * @param {function(): void} close Closes it.
             * @param {Object} owner What it answers to.
             * @returns {{close: function(): void, release: function(): void}} Close (from the owner's end) and release (a normal close).
             */
            portal(openSurface, root, close, owner) {
                let closed = false;
                const once = () => {
                    if (closed) return;
                    closed = true;
                    teardown(close);
                };
                const release = openSurface(root, once, owner);
                return {
                    close: once,
                    release: () => {
                        closed = true;
                        if (typeof release === 'function') release();
                    }
                };
            },
            /** Destroyed for good: nothing held or awaited runs, listeners go. The ticket is not revoked (it may be shared). */
            destroy() {
                if (destroyed) return;
                destroyed = true;
                for (const [target, type, handler] of listeners) target.removeEventListener(type, handler);
                listeners.length = 0;
            }
        };
        return fx;
    }

    /** Words: text that went through the guarded policy (the sinks take nothing else). */
    const WORDS = new WeakSet();
    /** @param {*} text Text. @returns {Object} Words. */
    const word = (text) => {
        const out = Object.freeze({ text: String(text ?? '') });
        WORDS.add(out);
        return out;
    };
    const EMPTY = word('');
    const SPACE = word(' ');
    /** Attributes that carry words a person reads or hears. */
    const TEXT_ATTRIBUTES = new Set(['aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'aria-placeholder', 'title', 'placeholder', 'alt', 'label']);
    /** An identity value (option, radio, checkbox): never prose. */
    const DATA_RE = /^[A-Za-z0-9:_-]{0,80}$/;

    /** @param {*} value Value. @returns {boolean} Words. */
    const isWords = value => !!value && typeof value === 'object' && WORDS.has(value);

    /** @param {*} value Words. @returns {string} Their text, or '' (refused) for anything else. */
    function textOf(value) {
        if (isWords(value)) return value.text;
        refuse('a text sink was given unguarded text');
        return '';
    }

    /** @returns {string} Today, yyyy-MM-dd (UTC). */
    const today = () => new Date().toISOString().slice(0, 10);

    /**
     * The words of one ticket: what a person may read, through its Spoiler policy (read when the words are made: inside
     * a paint, that is the resolved policy; before it, everything is guarded).
     * @param {Object} ticket Paint ticket.
     * @returns {Object} key, name, title, note, date, year, covered, join, none, space.
     */
    function words(ticket) {
        const policy = () => (typeof ticket?.policy === 'function' ? ticket.policy : lp.gate.FAIL_CLOSED);
        const guarded = entry => lp.authoring.guarded(ticket, entry);
        return Object.freeze({
            /**
             * Translated words; parameters are words or numbers only.
             * @param {string} key en.json key. @param {Object} [params] Parameters. @returns {Object} Words.
             */
            key(key, params) {
                const values = {};
                for (const [name, value] of Object.entries(params || {})) {
                    if (typeof value === 'number' && Number.isFinite(value)) values[name] = value;
                    else if (isWords(value)) values[name] = value.text;
                    else {
                        refuse(`the words of ${key} were given unguarded text`);
                        values[name] = '';
                    }
                }
                return word(lp.render.tr(key, values));
            },
            /** A name Spoiler Guard never hides (a list, its owner, a movie or show). @param {*} value Name. @returns {Object} Words. */
            name: value => word(lp.authoring.clean(value)),
            /** An entry's title, hidden while the entry is guarded. @returns {Object} Words. */
            title: (entry, value) => (guarded(entry) ? EMPTY : word(lp.authoring.clean(value))),
            /** An entry's note, hidden while the entry is guarded. @returns {Object} Words. */
            note: (entry, value) => (guarded(entry) ? EMPTY : word(value)),
            /** An air date: hidden when no policy could be read, or while the entry is guarded. @returns {Object} Words. */
            date: (entry, iso) => (policy().allDates === true || guarded(entry) ? EMPTY : word(lp.render.formatDate(iso))),
            /**
             * A year as the list pages say it: none when no policy could be read; for a guarded entry whose air dates are
             * hidden, only once it is out.
             * @param {Object} entry Entry or title.
             * @param {{year?: number, releaseDate?: string, released?: boolean}} facts Facts.
             * @returns {Object} Words.
             */
            year(entry, facts) {
                const p = policy();
                const date = lp.authoring.day(facts?.releaseDate);
                const value = date ? Number(date.slice(0, 4)) : Number.isInteger(facts?.year) ? facts.year : null;
                if (value === null || p.allDates === true) return EMPTY;
                if (guarded(entry) && p.airDates === true && !(facts?.released === true || (date !== null && date <= today()))) return EMPTY;
                return word(String(value));
            },
            /** @param {Object} entry Entry. @returns {boolean} Guarded (to pick the guarded wording). */
            covered: entry => guarded(entry),
            /** Words joined (empty ones left out). @param {Object[]} parts Words. @param {string} separator Separator. @returns {Object} Words. */
            join: (parts, separator) => word(parts.map(textOf).filter(Boolean).join(separator)),
            none: EMPTY,
            space: SPACE
        });
    }

    /** The text sinks: each takes words only (and identity values only through data). */
    const put = Object.freeze({
        /** @returns {HTMLElement} A new element, with its words. */
        el(tag, cls, text) {
            const node = lp.render.el(tag, cls);
            if (text !== undefined) node.textContent = textOf(text);
            return node;
        },
        /** Sets a node's words. */
        text(node, text) {
            node.textContent = textOf(text);
        },
        /** Sets a words attribute (aria-label, title, placeholder, label, ...). */
        attr(node, name, text) {
            if (!TEXT_ATTRIBUTES.has(name)) {
                refuse(`${name} is not a words attribute`);
                return;
            }
            node.setAttribute(name, textOf(text));
        },
        /** Sets the words a field shows. */
        value(node, text) {
            node.value = textOf(text);
        },
        /** Sets an identity value (an option's, a radio's or a select's choice): never prose. */
        data(node, value) {
            const text = String(value ?? '');
            if (!DATA_RE.test(text)) {
                refuse('a value is not an identity value');
                return;
            }
            node.value = text;
        }
    });

    // @je-guard-end

    /** Handoffs not yet used (one replacement each). */
    const handoffs = new WeakSet();

    /**
     * Opens an origin, or the replacement a {@link handoff} carries.
     * @param {{owner: Object, nativeRoot?: boolean, mount: Node, live: function(): boolean,
     *   policy?: function(Object|null): (Object|Promise<Object>), openSurface?: Function}} options Options, or a handoff.
     * @param {{mount?: Node}} [replacement] For a handoff: the replacement's own mount (default: the old one).
     * @returns {Object|null} Origin (null: no owner, the owner already ended, or a handoff whose session or lifecycle ended).
     */
    function origin(options, replacement = {}) {
        const carried = options && Object.prototype.hasOwnProperty.call(options, 'session');
        if (carried) {
            // A replacement: only the handoff itself, once, in the session and document lifecycle it was taken in.
            if (!handoffs.has(options)) return null;
            handoffs.delete(options);
            if (!sameSession(options.session, sessionNow()) || options.lifecycle !== lifecycleNow()) return null;
        }
        const owner = requireOwner(options?.owner, options?.nativeRoot, 'a list surface');
        if (!owner) return null;
        if (typeof options.live !== 'function') {
            refuse('a list surface was opened without its live check');
            return null;
        }
        const { live, policy } = options;
        const mount = carried && replacement?.mount ? replacement.mount : options.mount;
        if (owner.current() === false || !mount || mount.isConnected !== true || live() !== true) return null;
        const opened = carried ? options.session : sessionNow();
        const openedLifecycle = lifecycleNow();
        let ended = false;
        const endListeners = new Set();
        let target = null;

        /** @returns {boolean} The origin still holds (and ends it for good when it doesn't). */
        const current = () => {
            if (ended) return false;
            const ok = owner.current() !== false && sameSession(sessionNow(), opened) && lifecycle.epoch === openedLifecycle
                && !!mount && mount.isConnected === true && live() === true;
            if (!ok) end('lost');
            return ok;
        };

        const ticket = lp.gate.issue(null, current, policyOf(policy, null));
        const fx = effects({ ticket, depends: ORIGIN_DEPENDS });
        // The target and what depends on it end together (ORIGIN_DEPENDS: target → target:*).
        fx.reset('target:@list', () => {
            const old = target;
            target = null;
            if (old) {
                old.effects.destroy();
                old.ticket.revoke();
            }
        });
        const stopLifecycle = onLifecycleEnd(() => end('pagehide'));

        /** Ends the origin (once): tickets revoked, cleanups run (teardown only). @param {string} [reason] Why. */
        function end(reason) {
            if (ended) return;
            ended = true;
            stopLifecycle();
            fx.change('target');
            ticket.revoke();
            fx.destroy();
            for (const fn of Array.from(endListeners)) teardown(() => fn(reason || 'ended'));
            endListeners.clear();
        }

        /** The owner a registered portal answers to: this origin, as long as it holds. */
        const surfaceOwner = Object.freeze({ current });

        const self = {
            owner,
            ticket,
            current,
            end,
            get ended() {
                return ended || !current();
            },
            /**
             * A check that holds while this is the newest intent of its channel (and, for target-bound ones, the
             * target it began on) and the origin is current.
             * @param {string} channel Channel ('query', 'season', 'reload', 'details', ...).
             * @param {{target?: boolean}} [opts] Bound to the current target.
             * @returns {function(): boolean} Check.
             */
            intent(channel, opts = {}) {
                return fx.intent(opts.target === true ? `target:${channel}` : channel);
            },
            /**
             * Chooses the target list: a new ticket for that list; the old target, its reads, results and target-bound
             * intents end.
             * @param {string} listId List id.
             * @param {{listKind?: string}} [opts] Its kind (for its Spoiler policy).
             * @returns {{listId: string, listKind: string, ticket: Object, current: function(): boolean}|null} Target.
             */
            selectTarget(listId, opts = {}) {
                if (!current()) return null;
                fx.change('target');
                const held = fx.intent('target:@list');
                const list = { listKind: opts.listKind || 'playlist', listId };
                const targetTicket = lp.gate.issue(listId, held, policyOf(policy, list));
                target = Object.freeze({ listId, listKind: list.listKind, current: held, ticket: targetTicket, effects: effects({ ticket: targetTicket }) });
                return target;
            },
            /** No existing list is the target any more (a new list was chosen): the old target and its work end. */
            clearTarget() {
                fx.change('target');
            },
            /** @returns {Object|null} The current target. */
            target: () => (target && target.current() ? target : null),
            /**
             * A list this origin just created: its read-back target, under the same origin.
             * @param {string} listId The new list's id.
             * @param {{listKind?: string}} [opts] Kind.
             * @returns {Object|null} Target.
             */
            created(listId, opts) {
                return self.selectTarget(listId, opts);
            },
            /**
             * Effects bound to this origin's ticket, for a presenter on it (its own destroyed state and intents).
             * @param {{depends?: Object}} [opts] Its dependency table.
             * @returns {Object} Effects.
             */
            effects: (opts = {}) => effects({ ticket, depends: opts.depends }),
            /** @see effects publish */
            publish: (check, fn) => fx.publish(check, fn),
            /** @see effects task */
            task: (check, body, stopped) => fx.task(check, body, stopped),
            /**
             * Paints through the gate for the newest intent only, checked again when the paint runs.
             * @param {function(): boolean|null} check From {@link intent} (null: no intent).
             * @param {Object} paintTicket This origin's or its target's ticket.
             * @param {function(): void} fn Writes.
             * @param {string} [key] Paint key.
             * @returns {boolean} Painted.
             */
            paint(check, paintTicket, fn, key) {
                if (paintTicket === ticket) return fx.paint(check, fn, key);
                const now = self.target();
                if (now && paintTicket === now.ticket) return now.effects.paint(check, fn, key);
                return false;
            },
            /** @returns {boolean} The shared surface registry is there. */
            registrable: () => typeof (options.openSurface || JE.openSurface) === 'function',
            /**
             * Registers a portal for this origin's owner with the shared registry; it closes when the owner ends.
             * @param {HTMLElement} root The portal.
             * @param {function(): void} close Closes it.
             * @returns {function(): void|null} Release for a normal close, or null: unavailable (don't show it).
             */
            register(root, close) {
                const openSurface = options.openSurface || JE.openSurface;
                if (typeof openSurface !== 'function' || !current()) return null;
                // The portal belongs to this origin: it ends with the owner, the session, the lifecycle, the mount or the live check.
                const portal = fx.portal(openSurface, root, close, owner === JE.NATIVE ? owner : surfaceOwner);
                endListeners.add(portal.close);
                return () => {
                    endListeners.delete(portal.close);
                    portal.release();
                };
            },
            /**
             * What a replacement or fallback needs to open for the same owner, in the same session and document
             * lifecycle, taken before this one closes. It opens one replacement.
             * @returns {Object|null} A handoff for {@link origin} (null: this one already ended).
             */
            handoff() {
                if (!current()) return null;
                const out = Object.freeze({ owner, nativeRoot: options.nativeRoot, mount, live, policy, openSurface: options.openSurface, session: opened, lifecycle: openedLifecycle });
                handoffs.add(out);
                return out;
            },
            /**
             * Registers cleanup for when the origin ends (teardown only); returns an unsubscribe function.
             * @param {function(string): void} fn Cleanup.
             * @returns {function(): void} Unsubscribe.
             */
            onEnd(fn) {
                if (ended) {
                    teardown(() => fn('ended'));
                    return () => {};
                }
                endListeners.add(fn);
                return () => endListeners.delete(fn);
            },
            /**
             * Closes normally: focus goes back to the opener only when it is still connected and the origin was live.
             * @param {{opener?: HTMLElement}} [opts] Opener.
             */
            close(opts = {}) {
                const wasLive = current();
                end('closed');
                const opener = opts.opener;
                if (wasLive && opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
            }
        };
        return self;
    }

    /** @type {Map<string, {owner: Object, token: Object}>} in-flight work: key + owner → entry */
    const work = new Map();
    const ownerIds = new WeakMap();
    let ownerSeq = 0;

    /** @param {Object} owner Owner. @returns {number} A stable id for an owner object. */
    function ownerId(owner) {
        if (!ownerIds.has(owner)) ownerIds.set(owner, ++ownerSeq);
        return ownerIds.get(owner);
    }

    const inflight = Object.freeze({
        /**
         * Starts work for an owner and an immutable input key.
         * @param {string} key Input key.
         * @param {Object} owner Owner.
         * @returns {{release: function(): void}|null} The entry, or null: the owner ended or this owner's identical work runs.
         */
        claim(key, owner) {
            if (!owner || typeof owner.current !== 'function' || owner.current() === false) return null;
            const id = `${ownerId(owner)}\u0000${key}`;
            if (work.has(id)) return null;
            if (work.size >= MAX_INFLIGHT) work.delete(work.keys().next().value);
            const token = { release: () => { if (work.get(id)?.token === token) work.delete(id); } };
            work.set(id, { owner, token });
            return token;
        },
        /** @returns {boolean} This owner's work for the key runs. */
        active: (key, owner) => !!owner && work.has(`${ownerId(owner)}\u0000${key}`),
        size: () => work.size
    });

    lp.surface = Object.freeze({ origin, inflight, requireOwner, effects, words, put, ORIGIN_DEPENDS, subscribers: () => lifecycle.subscribers.size });
})(window.JellyfinEnhanced);
