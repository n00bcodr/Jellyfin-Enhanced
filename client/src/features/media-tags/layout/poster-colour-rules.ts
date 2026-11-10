export type RGB = readonly [
    number,
    number,
    number
];
export interface Palette {
    background: RGB;
    border: RGB;
    text: RGB;
}
export const logPrefix = '🪼 Jellyfin Enhanced: Poster colours:';
export const ALGORITHM = 1;
export const SAMPLE_SIZE = 32;
export const MIN_ALPHA = 128;
export const NEAR_BLACK = 28;
export const NEAR_WHITE = 235;
export const GREY_CHROMA = 24;
export const MIN_SATURATION = 0.45;
export const MAX_SATURATION = 0.85;
export const MIN_LIGHTNESS = 0.20;
export const MAX_LIGHTNESS = 0.42;
export const BORDER_STEP = 0.16;
export const NEUTRAL: Palette = Object.freeze<Palette>({ background: [40, 40, 40], border: [88, 88, 88], text: [255, 255, 255] });
export const SLICE_CARDS = 40;
export const MAX_DECODES = 4;
export const STEP_MIN_MS = 4;
export const SLICE_BUDGET_MS = 8;
export const MEMORY_CAP = 3000;
export const STORE_CAP = 2000;
export const PERSIST_DELAY_MS = 2000;
export const SWEEP_MS = 3000;
export const FAILED = 'failed';
export const STALE = 'stale';
// ── The algorithm (pure, shared with PosterColour.cs) ─────────────────
export function dominant(data: ArrayLike<number>, width: number, height: number): RGB | null {
    const count = new Int32Array(512);
    const sumR = new Float64Array(512), sumG = new Float64Array(512), sumB = new Float64Array(512);
    const pixels = Math.min(width * height, Math.floor(data.length / 4));
    for (let i = 0; i < pixels; i++) {
        const o = i * 4;
        const r = data[o], g = data[o + 1], b = data[o + 2], a = data[o + 3];
        if (r === undefined || g === undefined || b === undefined || a === undefined || ![r, g, b, a].every(v => Number.isFinite(v) && v >= 0 && v <= 255))
            continue;
        if (a < MIN_ALPHA)
            continue;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        if (max < NEAR_BLACK || min > NEAR_WHITE)
            continue;
        const bin = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
        count[bin] = (count[bin] || 0) + 1;
        sumR[bin] = (sumR[bin] || 0) + r;
        sumG[bin] = (sumG[bin] || 0) + g;
        sumB[bin] = (sumB[bin] || 0) + b;
    }
    let best = -1;
    let bestScore = 0;
    for (let bin = 0; bin < 512; bin++) {
        if (count[bin] === 0)
            continue;
        const cr = ((bin >> 6) << 5) + 16, cg = (((bin >> 3) & 7) << 5) + 16, cb = ((bin & 7) << 5) + 16;
        const chroma = Math.max(cr, cg, cb) - Math.min(cr, cg, cb);
        const score = (count[bin] || 0) * (256 + 2 * chroma);
        if (score > bestScore) {
            bestScore = score;
            best = bin;
        }
    }
    if (best < 0)
        return null;
    const n = count[best] || 1;
    const mean = (sum: number) => Math.floor((2 * sum + n) / (2 * n));
    return [mean(sumR[best] || 0), mean(sumG[best] || 0), mean(sumB[best] || 0)];
}
export function textContrast(rgb: RGB, white: boolean) {
    const channel = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    const l = 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
    return white ? 1.05 / (l + 0.05) : (l + 0.05) / 0.05;
}
export function hsl(hue: number, saturation: number, lightness: number): RGB {
    const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const x = c * (1 - Math.abs((hue % 2) - 1));
    const m = lightness - c / 2;
    const sextant = Math.trunc(hue);
    const [r, g, b] = sextant === 0 ? [c, x, 0] : sextant === 1 ? [x, c, 0] : sextant === 2 ? [0, c, x]
        : sextant === 3 ? [0, x, c] : sextant === 4 ? [x, 0, c] : [c, 0, x];
    const round = (v: number) => Math.min(255, Math.max(0, Math.floor(v * 255 + 0.5)));
    return [round(r + m), round(g + m), round(b + m)];
}
export function normalise(input: unknown): Palette {
    if (!Array.isArray(input) || input.length !== 3 || !input.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 255))
        return NEUTRAL;
    const rgb: RGB = [Number(input[0]), Number(input[1]), Number(input[2])];
    const [r, g, b] = rgb;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const chroma = max - min;
    if (chroma < GREY_CHROMA)
        return NEUTRAL;
    let hue = max === r ? (g - b) / chroma : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
    if (hue < 0)
        hue += 6;
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const saturation = clamp(chroma / (255 - Math.abs(max + min - 255)), MIN_SATURATION, MAX_SATURATION);
    const lightness = clamp((max + min) / 510, MIN_LIGHTNESS, MAX_LIGHTNESS);
    const background = hsl(hue, saturation, lightness);
    const white = textContrast(background, true) >= 4.5;
    const border = hsl(hue, saturation, clamp(lightness + (white ? BORDER_STEP : -BORDER_STEP), 0, 1));
    return { background, border, text: white ? [255, 255, 255] : [0, 0, 0] };
}
export function coloursOf(data: ArrayLike<number>, width: number, height: number) {
    return normalise(dominant(data, width, height));
}
export const css = (rgb: RGB) => `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
export function keyOf(url: string) {
    if (!url || /^(?:data|blob):/i.test(url))
        return null;
    const m = /\/Items\/([0-9a-f-]{32,36})\/Images\/([A-Za-z]+)(?:\/(\d+))?/i.exec(url);
    if (!m?.[1] || !m[2])
        return url.split('#')[0] || null;
    const tag = /[?&]tag=([^&#]+)/i.exec(url);
    return `${m[1].replace(/-/g, '').toLowerCase()}:${m[2].toLowerCase()}:${m[3] || 0}:${tag?.[1] ? safeDecode(tag[1]) : ''}`;
}
function safeDecode(value: string): string { try {
    return decodeURIComponent(value);
}
catch {
    return value;
} }
