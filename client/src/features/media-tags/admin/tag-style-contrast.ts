/**
 * @file The Tag Styles editor's contrast helpers (pure): parse a colour, paint
 * it over another, WCAG luminance and contrast, and the badge a ratio earns.
 */
import { fmt } from './format';

export interface Rgba { r: number; g: number; b: number; a: number }
export interface Rgb { r: number; g: number; b: number }

/**
 * Parses `rgba(r, g, b, a)`, `rgb(r, g, b)` or `#rrggbb`.
 * @param css
 * @returns {Rgba|null}
 */
export function rgbaOf(css: unknown): Rgba | null {
    const value = String(css || '').trim().toLowerCase();
    const hex = /^#([0-9a-f]{6})$/.exec(value);
    const digits = hex?.[1];
    if (digits) return { r: parseInt(digits.slice(0, 2), 16), g: parseInt(digits.slice(2, 4), 16), b: parseInt(digits.slice(4, 6), 16), a: 1 };
    const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
    if (!fn) return null;
    return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: fn[4] === undefined ? 1 : Number(fn[4]) };
}

/**
 * Paints `top` over the opaque colour `under`, rounding to whole channel values.
 * @param top
 * @param under
 * @returns {Rgba}
 */
export function compositeOver(top: Rgba, under: Rgb): Rgba {
    const mix = (t: number, u: number) => Math.round(t * top.a + u * (1 - top.a));
    return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b), a: 1 };
}

/**
 * WCAG 2 relative luminance of an opaque colour.
 * @param c
 * @returns {number}
 */
export function luminance(c: Rgb): number {
    const ch = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

/**
 * WCAG contrast of text over a chip background, both painted over a dark poster (#262626).
 * @param text
 * @param background
 * @returns {number|null} The ratio (1-21), or null when a colour does not parse.
 */
export function contrastRatio(text: unknown, background: unknown): number | null {
    const t = rgbaOf(text), b = rgbaOf(background);
    if (!t || !b) return null;
    const bg = compositeOver(b, { r: 38, g: 38, b: 38 });
    const fg = compositeOver(t, bg);
    const l1 = luminance(fg), l2 = luminance(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * The contrast badge for a ratio: AA from 4.5, AA large only from 3, else low.
 * @param ratio
 * @returns {{level: string, label: string}}
 */
export function contrastLevel(ratio: number): { level: 'aa' | 'large' | 'low'; label: string } {
    if (ratio >= 4.5) return { level: 'aa', label: 'AA' };
    if (ratio >= 3) return { level: 'large', label: fmt('AA large only') };
    return { level: 'low', label: fmt('Low contrast') };
}
