import assert from 'node:assert/strict';

/** Lets every promise chain the page can run without a timer settle (the mocked server answers in microtasks). */
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

/**
 * A manual clock for a harness window (pass `clock.globals` to createHarness): the page's setTimeout/setInterval callbacks
 * run only when the test moves time on, in time order, so a test never races the host's real timers or CPU load. Time is
 * logical; Date.now() is untouched unless `date` is set: then the page's Date (Date.now() and `new Date()`) reads the
 * same logical time, from the real time at creation, for a page that measures waits with Date.now() between its timers.
 * @param {{date?: boolean}} [options]
 * @returns {{globals: object, now: () => number, advance: (ms: number) => Promise<void>, until: (check: () => any, ms?: number) => Promise<void>}}
 */
export function fakeClock({ date = false } = {}) {
  let now = 0, sequence = 0;
  const epoch = Date.now();
  /** The page's Date on the logical clock (every other use of Date is the real one). */
  class LogicalDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(epoch + now); }
    static now() { return epoch + now; }
  }
  const timers = new Map();
  const add = (callback, ms, args, every) => {
    const id = ++sequence;
    timers.set(id, { at: now + Math.max(0, Number(ms) || 0), callback, args, every, order: id });
    return id;
  };
  const clear = id => { timers.delete(id); };
  const next = () => [...timers.entries()].sort(([, a], [, b]) => a.at - b.at || a.order - b.order)[0];
  /** Runs the next due timer (at or before `limit`); false when there is none. */
  const fire = limit => {
    const entry = next();
    if (!entry || entry[1].at > limit) return false;
    const [id, timer] = entry;
    now = Math.max(now, timer.at);
    if (timer.every === undefined) timers.delete(id);
    else timer.at = now + Math.max(1, timer.every);
    timer.callback(...timer.args);
    return true;
  };
  return {
    globals: {
      setTimeout: (callback, ms, ...args) => add(callback, ms, args),
      clearTimeout: clear,
      setInterval: (callback, ms, ...args) => add(callback, ms, args, Number(ms) || 0),
      clearInterval: clear,
      ...(date ? { Date: LogicalDate } : {})
    },
    now: () => now,
    /** Moves time on by `ms`, running every timer that falls due, with the page's promise chains settled after each. */
    async advance(ms) {
      const end = now + ms;
      await settle();
      while (fire(end)) await settle();
      now = end;
    },
    /**
     * Waits until `check()` holds, moving time on from timer to timer, for at most `ms` of the page's time. The answer
     * depends only on what the page does and when its timers are due, never on how busy the machine is.
     */
    async until(check, ms = 10000) {
      const end = now + ms;
      await settle();
      while (!check() && fire(end)) await settle();
      assert.ok(check(), `condition never became true within ${ms} ms of page time`);
    }
  };
}
