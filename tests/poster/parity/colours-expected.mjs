#!/usr/bin/env node
// Builds data/colours-expected.json: the Poster Tag Styles preset's colours
// for synthetic posters (solid, two-tone, gradient, letterboxed, near-black,
// translucent, noise), computed by the REAL js/tags/tag-poster-colours.js in a
// VM, so `PosterTagParity colours` can check Services/PosterTags/PosterColour.cs
// against it.
//
// Posters at sample size (32px on the long side or less) are compared exactly:
// both sides run the same arithmetic on the same pixels. Full-size posters are
// downscaled differently by the browser (createImageBitmap) and by Skia; here
// the web's input is an exact area average, and the C# side may differ by the
// tolerance written with each fixture (the documented deliberate difference).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const jsRoot = join(here, '..', '..', '..', 'Jellyfin.Plugin.JellyfinEnhanced', 'js');
const dataDir = join(here, 'data');
mkdirSync(dataDir, { recursive: true });

// The module needs only JE on window at load time.
const sandbox = { window: { JellyfinEnhanced: {} }, console, Math, Int32Array, Float64Array, Uint8ClampedArray };
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(jsRoot, 'tags/tag-poster-colours.js'), 'utf8'), sandbox, { filename: 'tag-poster-colours.js' });
const P = sandbox.window.JellyfinEnhanced.tagPosterColours;

/** RGBA bytes from a paint function. */
function paint(width, height, fn) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(fn(x, y, width, height), (y * width + x) * 4);
    return data;
}

/** Exact area-average downscale to at most 32px on the long side (what the browser's resize approximates). */
function areaAverage(data, width, height) {
    const scale = Math.min(1, 32 / Math.max(width, height));
    const w = Math.max(1, Math.floor(width * scale + 0.5));
    const h = Math.max(1, Math.floor(height * scale + 0.5));
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const x0 = Math.floor((x * width) / w), x1 = Math.floor(((x + 1) * width) / w);
            const y0 = Math.floor((y * height) / h), y1 = Math.floor(((y + 1) * height) / h);
            const sum = [0, 0, 0, 0];
            let n = 0;
            for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { for (let c = 0; c < 4; c++) sum[c] += data[(yy * width + xx) * 4 + c]; n++; }
            for (let c = 0; c < 4; c++) out[(y * w + x) * 4 + c] = Math.round(sum[c] / n);
        }
    }
    return { data: out, width: w, height: h };
}

const lerp = (a, b, t) => Math.round(a + (b - a) * t);
let seed = 20261030;
const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed & 255; };

const small = {
    'solid-red': [21, 32, () => [200, 30, 30, 255]],
    'solid-navy': [21, 32, () => [20, 30, 90, 255]],
    'solid-yellow': [21, 32, () => [250, 230, 40, 255]],
    'solid-grey': [21, 32, () => [120, 120, 124, 255]],
    'solid-near-black': [21, 32, () => [12, 14, 16, 255]],
    'two-tone-blue-red': [21, 32, (x) => (x < 14 ? [30, 60, 200, 255] : [200, 40, 40, 255])],
    'two-tone-grey-green': [20, 32, (x) => (x < 10 ? [128, 128, 128, 255] : [40, 140, 60, 255])],
    'gradient-red-blue': [21, 32, (x, y, w, h) => [lerp(220, 20, y / (h - 1)), 30, lerp(20, 220, y / (h - 1)), 255]],
    'gradient-teal-orange': [32, 18, (x, y, w) => [lerp(20, 240, x / (w - 1)), lerp(140, 120, x / (w - 1)), lerp(150, 20, x / (w - 1)), 255]],
    'letterboxed-teal': [21, 32, (x, y) => (y < 10 || y >= 22 ? [0, 0, 0, 255] : x < 2 || x >= 19 ? [255, 255, 255, 255] : [20, 130, 140, 255])],
    'translucent-red': [21, 32, (x) => (x < 16 ? [200, 30, 30, 40] : [30, 160, 60, 255])],
    'noise': [21, 32, () => [random(), random(), random(), 255]],
    'pastel': [21, 32, () => [240, 200, 220, 255]],
    'tie': [2, 1, (x) => (x === 0 ? [200, 40, 40, 255] : [40, 40, 200, 255])],
};
// [width, height, paint, tolerance]: flat areas survive any downscale; a smooth
// gradient's winning histogram bin can move one step (up to 16 per channel
// after normalisation) with the filter, so it is held to the same hue only.
const large = {
    'large-solid-red': [180, 270, () => [190, 30, 30, 255], 6],
    'large-two-tone': [180, 270, (x) => (x < 120 ? [30, 60, 200, 255] : [200, 40, 40, 255]), 6],
    'large-gradient': [180, 270, (x, y, w, h) => [lerp(220, 20, y / (h - 1)), 40, lerp(20, 220, y / (h - 1)), 255], 16],
};

const fixtures = [];
const add = (name, width, height, data, input, tolerance) => {
    const dominant = P.dominant(input.data, input.width, input.height);
    const c = P.normalise(dominant);
    fixtures.push({
        name, width, height, tolerance, rgba: Buffer.from(data).toString('base64'),
        dominant: dominant ? Array.from(dominant) : null,
        background: Array.from(c.background), border: Array.from(c.border), text: Array.from(c.text),
    });
};
for (const [name, [w, h, fn]] of Object.entries(small)) {
    const data = paint(w, h, fn);
    add(name, w, h, data, { data, width: w, height: h }, 0);
}
for (const [name, [w, h, fn, tolerance]] of Object.entries(large)) {
    const data = paint(w, h, fn);
    add(name, w, h, data, areaAverage(data, w, h), tolerance);
}

writeFileSync(join(dataDir, 'colours-expected.json'), JSON.stringify(fixtures));
console.log(`colours: ${fixtures.length} synthetic posters`);
