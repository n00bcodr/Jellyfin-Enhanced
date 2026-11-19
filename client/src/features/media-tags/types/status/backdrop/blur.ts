// The blur of the status tags' painted backdrop (upstream abcaa16d, tags/status-tag-backdrop.js): Chromium's backdrop
// filter, measured on synthetic pages (Chromium 145). The kernel is Skia's Gaussian approximation: three box blurs of
// floor(sigma × 3 × sqrt(2π) / 4 + 0.5) pixels (two of that width and one a pixel wider when it is even), rows first,
// rounded to whole channel values after each direction, over the box mirrored at its edges. Pure.

/**
 * The three box widths Skia blurs with for a Gaussian of this sigma.
 * @param sigma - In pixels.
 * @returns Empty when the blur is too small to change anything.
 */
export function boxSizes(sigma: number): number[] {
    const width = Math.floor(sigma * 3 * Math.sqrt(2 * Math.PI) / 4 + 0.5);
    if (!(width > 1)) return [];
    return width % 2 ? [width, width, width] : [width, width, width + 1];
}

/**
 * Blur the lines of one direction in place: every line is extended by mirroring, summed three times and rounded.
 * @param data - RGBA.
 * @param lines - Lines to blur.
 * @param length - Pixels a line.
 * @param lineStep - Array distance between lines.
 * @param pixelStep - Array distance between a line's pixels.
 * @param sizes - Box widths.
 * @param a - Scratch, at least length + sum(sizes) long.
 * @param b - Scratch of the same size.
 */
function blurLines(data: Uint8ClampedArray, lines: number, length: number, lineStep: number, pixelStep: number, sizes: number[], a: Float64Array, b: Float64Array): void {
    const [s0 = 0, s1 = 0, s2 = 0] = sizes;
    const pad = (s0 + s1 + s2 - 3) / 2;
    const period = 2 * length;
    const padded = length + 2 * pad;
    const norm = 1 / (s0 * s1 * s2);
    for (let line = 0; line < lines; line++) {
        for (let channel = 0; channel < 3; channel++) {
            const base = line * lineStep + channel;
            for (let k = 0; k < padded; k++) {
                let j = (k - pad) % period;
                if (j < 0) j += period;
                if (j >= length) j = period - 1 - j;
                a[k] = data[base + j * pixelStep] ?? 0;
            }
            let from = a, to = b, count = padded;
            for (let pass = 0; pass < 3; pass++) {
                const size = sizes[pass] ?? 1;
                const out = count - size + 1;
                let sum = 0;
                for (let k = 0; k < size; k++) sum += from[k] ?? 0;
                to[0] = sum;
                for (let k = 1; k < out; k++) {
                    sum += (from[k + size - 1] ?? 0) - (from[k - 1] ?? 0);
                    to[k] = sum;
                }
                count = out;
                const swap = from; from = to; to = swap;
            }
            for (let j = 0; j < length; j++) data[base + j * pixelStep] = Math.floor((from[j] ?? 0) * norm + 0.5);
        }
    }
}

/**
 * Blur opaque RGBA pixels in place the way Chromium's backdrop filter does: mirrored edges, three box blurs, rows then
 * columns. Alpha is left as it is.
 * @param sigma - In pixels.
 * @returns The same array.
 */
export function blurRgba(data: Uint8ClampedArray, width: number, height: number, sigma: number): Uint8ClampedArray {
    const sizes = boxSizes(sigma);
    if (!sizes.length || !(width > 0 && height > 0)) return data;
    const scratch = Math.max(width, height) + sizes.reduce((sum, size) => sum + size, 0);
    const a = new Float64Array(scratch), b = new Float64Array(scratch);
    blurLines(data, height, width, width * 4, 4, sizes, a, b);
    blurLines(data, width, height, 4, width * 4, sizes, a, b);
    return data;
}
