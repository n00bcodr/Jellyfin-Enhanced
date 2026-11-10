// Starve this Node process's event loop at random moments, the way a CPU-saturated machine does to a test: block it
// for 20-80 ms, then let it run for 0-100 ms, again and again. While the loop is blocked every timer that falls due
// waits, and they then run in a burst, in order of their due time, so a fixed wait can end between two links of a
// chain of tasks it meant to wait for. Tests that assume work settles within a fixed time fail far more often under
// this than beside a CPU hog, which makes it a quick way to find them and to show a fix holds.
//
//   NODE_OPTIONS=--import=$PWD/tests/runner/starve.mjs node --test tests/frontend/requests/seerr-review-r2.test.mjs
//   scripts/test-under-load.py --starve --hog 0 --runs 20 -- node --test ...
//
// JE_STARVE="minMs,maxMs,maxGapMs" changes the block and gap lengths; JE_STARVE_SEED makes a run repeatable (the
// default seed is the process id, so concurrent test processes starve at different moments).
const [min, max, gap] = (process.env.JE_STARVE || '20,80,100').split(',').map(Number);
let seed = Number(process.env.JE_STARVE_SEED || process.pid) >>> 0;
function random() {                         // mulberry32
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function block() {
    const end = performance.now() + min + random() * (max - min);
    while (performance.now() < end) { /* the loop is starved */ }
    setTimeout(block, random() * gap).unref();
}
setTimeout(block, random() * gap).unref();
