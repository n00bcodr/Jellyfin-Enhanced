// A DOM-write spy for the list pages (phase 4c3a): every DOM write made by a list module (a synchronous stack frame in
// js/arr/lists/) must happen inside the paint gate's paint() or erase() (lp.gate.scope()), and erase() only takes
// things away. Anything else is recorded as a violation.
//
// It wraps the window's mutating DOM methods and every property setter of the DOM prototypes, plus dataset writes.
// Writes inside paint() return at once; the stack is only read for writes outside it (test fixtures, Jellyfin's fakes).
//
// Bounded: it keeps at most MAX_VIOLATIONS records (the rest are counted), and after MAX_WRITES writes on one window it
// throws on every write. That stops a runaway paint/observer loop at the write that would feed it, instead of letting
// the test process grow without limit.

const MUTATORS = new Set([
  'appendChild', 'insertBefore', 'removeChild', 'replaceChild', 'append', 'prepend', 'after', 'before', 'replaceWith',
  'remove', 'replaceChildren', 'insertAdjacentElement', 'insertAdjacentHTML', 'insertAdjacentText', 'setAttribute',
  'setAttributeNS', 'removeAttribute', 'removeAttributeNS', 'toggleAttribute', 'setAttributeNode', 'removeAttributeNode',
  'normalize', 'appendData', 'insertData', 'deleteData', 'replaceData', 'splitText', 'add', 'toggle', 'replace'
]);
// What erase() may not do: put anything in.
const INSERTS = new Set([
  'appendChild', 'insertBefore', 'replaceChild', 'append', 'prepend', 'after', 'before', 'replaceWith', 'replaceChildren',
  'insertAdjacentElement', 'insertAdjacentHTML', 'insertAdjacentText', 'add', 'toggle', 'replace', 'set innerHTML',
  'set outerHTML', 'set textContent', 'set innerText', 'set className', 'dataset set', 'setAttribute', 'setAttributeNS',
  'toggleAttribute', 'setAttributeNode'
]);
const PROTOTYPES = /^(Node|Element|CharacterData|Text|Document|DocumentFragment|DOMTokenList|HTML\w*Element)$/;
const LIST_FRAME = /\/js\/arr\/lists\/[\w-]+\.js/;
const MAX_VIOLATIONS = 50;
const MAX_WRITES = 2_000_000;
const INSTALLED = Symbol.for('je-dom-write-spy');

/**
 * Installs the spy on a harness window (once per window).
 * @param {Window} window The harness window.
 * @returns {{violations: Array<{op: string, scope: string, frame: string}>, writes: function(): number,
 *   overflow: function(): number, take: function(): Array}} Spy.
 */
export function installDomWriteSpy(window) {
  if (window[INSTALLED]) return window[INSTALLED];
  const violations = [];
  let listWrites = 0;
  let allWrites = 0;
  let overflow = 0;
  let checking = false;
  const scope = () => {
    try {
      return window.JellyfinEnhanced?.internals?.arrListPages?.gate?.scope?.() || '';
    } catch {
      return '';
    }
  };
  const check = (op) => {
    allWrites += 1;
    if (allWrites > MAX_WRITES) throw new Error(`dom-write-spy: more than ${MAX_WRITES} DOM writes on one window (a runaway loop?)`);
    if (checking) return;
    checking = true;
    try {
      const where = scope();
      if (where === 'paint') { listWrites += 1; return; }
      const previous = Error.stackTraceLimit;
      Error.stackTraceLimit = 40;
      const stack = new Error().stack || '';
      Error.stackTraceLimit = previous;
      // Synchronous frames only: an awaiting caller ("at async …") isn't the writer.
      const frame = stack.split('\n').slice(1).find(line => !/^\s*at async /.test(line) && LIST_FRAME.test(line));
      if (!frame) return;
      listWrites += 1;
      if (where === 'erase' && !INSERTS.has(op)) return;
      if (violations.length >= MAX_VIOLATIONS) { overflow += 1; return; }
      violations.push({ op, scope: where || 'none', frame: frame.trim() });
    } finally {
      checking = false;
    }
  };
  for (const name of Object.getOwnPropertyNames(window)) {
    if (!PROTOTYPES.test(name)) continue;
    const proto = window[name]?.prototype;
    if (!proto) continue;
    for (const key of Object.getOwnPropertyNames(proto)) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, key);
      if (!descriptor?.configurable) continue;
      if (typeof descriptor.value === 'function' && MUTATORS.has(key)) {
        const original = descriptor.value;
        const op = key === 'remove' && name === 'DOMTokenList' ? 'classList remove' : key;
        Object.defineProperty(proto, key, { ...descriptor, value: function (...args) { check(op); return original.apply(this, args); } });
      } else if (typeof descriptor.set === 'function') {
        const original = descriptor.set;
        const op = `set ${key}`;
        Object.defineProperty(proto, key, { ...descriptor, set: function (value) { check(op); return original.call(this, value); } });
      }
      if (key === 'dataset' && typeof descriptor.get === 'function') {
        const original = descriptor.get;
        Object.defineProperty(proto, key, {
          ...descriptor,
          get: function () {
            const map = original.call(this);
            return new Proxy(map, {
              get: (target, k) => target[k],
              set: (target, k, v) => { check('dataset set'); target[k] = v; return true; },
              deleteProperty: (target, k) => { check('dataset delete'); delete target[k]; return true; }
            });
          }
        });
      }
    }
  }
  /** Takes the violations recorded so far (a planted one the test expected), counting the overflow with them. */
  const take = () => {
    const taken = violations.splice(0);
    const more = overflow;
    overflow = 0;
    return Object.assign(taken, { overflow: more });
  };
  const spy = { violations, writes: () => listWrites, overflow: () => overflow, take };
  window[INSTALLED] = spy;
  return spy;
}
