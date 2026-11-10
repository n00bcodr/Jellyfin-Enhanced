import { COMPACT_QUALITY } from '../types/quality/compact-quality';
export { COMPACT_QUALITY } from '../types/quality/compact-quality';
import * as rules from './layout-rules';
import type { LayoutSettings } from './layout-rules';
export const SHAPE_RATIO = 1.2;
export function preserveLegacySizing(css: string) {
    return css.replace(/([^{}]+)\{([^{}]*)\}/g, (rule: string, selector: string, body: string) => {
        if (!body.includes('--je-tag-scale'))
            return rule;
        const declarations = body.split(';').filter((declaration) => declaration.includes('--je-tag-scale')).join(';') + ';';
        const original = declarations.replace(/calc\((clamp\([^)]*\)|[\d.]+(?:px|rem|em|cqw|vw)) \* var\(--je-tag-scale, 1\)(?: \* var\(--je-tag-gap, 1\))?\)/g, '$1');
        if (original === declarations)
            return rule;
        const scoped = selector.includes('.je-tag-host')
            ? selector.trim().replace(/\.je-tag-host/g, '.je-tag-host[data-je-legacy]')
            : `.je-tag-host[data-je-legacy] :is(${selector.trim()})`;
        return `${rule}\n${scoped} {${original}}`;
    });
}
export function revealSettings(conf: LayoutSettings) {
    return conf.density === 'compact' ? conf : { ...conf, density: 'compact' };
}
export const FIT_MAX_ROWS = 2;
export const centreRowLimit = (height: number, offset: number) => Math.max(0, Math.min(height / 3, height / 2 - offset));
export function shapeOfSize(width: number, height: number) {
    return width > 0 && height > 0 && width / height > SHAPE_RATIO ? 'landscape' : 'portrait';
}
export function compactQualityLabel(label: string) {
    const audio = /^(.*) (\d+\.\d+(?:\.\d+)?)$/.exec(label);
    const base = audio?.[1] || label;
    const compact = rules.hasOwn(COMPACT_QUALITY, base) ? COMPACT_QUALITY[base] : undefined;
    if (!compact)
        return label;
    const [text, keepChannels] = compact;
    return text + (audio && keepChannels ? ` ${audio[2]}` : '');
}
export function chipsThatFit(widths: number[], available: number, gap: number, maxRows: number, moreWidth: number, rowsOut?: number[], moreOut?: {
    row: number;
}) {
    // Flex wraps a chip that overflows by any fraction of a pixel.
    const fits = (need: number, room: number) => need <= room + 0.01;
    const rowOf: number[] = [];
    let rows = 0;
    let x = 0;
    for (const w of widths) {
        if (rows === 0 || !fits(x + gap + w, available)) {
            rows++;
            x = w;
        }
        else
            x += gap + w;
        rowOf.push(rows);
    }
    if (rows <= maxRows && widths.every((w) => fits(w, available))) {
        rowsOut?.push(...rowOf);
        if (moreOut)
            moreOut.row = 0;
        return widths.map(() => true);
    }
    const roomOn = (row: number) => (row === maxRows ? available - gap - moreWidth : available);
    // A chip that could never be shown (wider than a whole row; in a single row, too wide to sit
    // beside "+N") is skipped on its own and does not end the row.
    const usable = (w: number) => fits(w, maxRows === 1 ? roomOn(1) : available);
    let row = 1;
    x = 0;
    let ended = false;
    const shown = widths.map((w) => {
        if (maxRows > 0 && !ended && usable(w)) {
            if (fits(x === 0 ? w : x + gap + w, roomOn(row))) {
                x = x === 0 ? w : x + gap + w;
                rowsOut?.push(row);
                return true;
            }
            if (row < maxRows && x > 0 && fits(w, roomOn(row + 1))) {
                row++;
                x = w;
                rowsOut?.push(row);
                return true;
            }
            ended = true;
        }
        rowsOut?.push(0);
        return false;
    });
    // Room for "+N" is only reserved on the last allowed row; when the shown
    // chips stop on an earlier row it wraps below them unless it fits after them.
    if (moreOut)
        moreOut.row = x === 0 || fits(x + gap + moreWidth, available) ? Math.max(1, row) : row + 1;
    return shown;
}
export function rowBudget(heights: number[], moreHeight: number, limit: number, rowGap: number) {
    const tallest = [moreHeight, ...heights].filter((h) => h > 0).sort((a, b) => b - a);
    if (!tallest.length)
        return FIT_MAX_ROWS;
    for (let rows = FIT_MAX_ROWS; rows >= 1; rows--) {
        const height = tallest.slice(0, rows).reduce((sum, h) => sum + h, 0) + rowGap * (rows - 1);
        if (height <= limit + 0.01)
            return rows;
    }
    return 0;
}
export function rowsHeight(shown: boolean[], rows: number[], heights: number[], moreHeight: number, gap: number, moreRow: number) {
    const tallest: number[] = [];
    shown.forEach((on, i) => { if (on)
        tallest[(rows[i] ?? 0) - 1] = Math.max(tallest[(rows[i] ?? 0) - 1] || 0, (heights[i] ?? 0)); });
    if (shown.includes(false) && moreRow > 0)
        tallest[moreRow - 1] = Math.max(tallest[moreRow - 1] || 0, moreHeight);
    const used = tallest.filter((h) => h !== undefined);
    return used.reduce((sum, h) => sum + h, 0) + gap * Math.max(0, used.length - 1);
}
