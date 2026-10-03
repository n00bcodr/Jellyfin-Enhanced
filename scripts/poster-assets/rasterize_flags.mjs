// Rasterises every <code>.svg in <src> to <dst>/<code>.png at <w>x<h> with the
// headless Chromium pinned by this folder's package-lock.json (playwright 1.58.2),
// i.e. the same engine jellyfin-web uses to draw flag-icons in an <img>.
// Called by scripts/build_poster_assets.py; not part of the plugin build.
//
// Usage: node rasterize_flags.mjs <src> <dst> <w> <h>
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const [src, dst, w, h] = process.argv.slice(2);
if (!src || !dst || !w || !h) {
    console.error('usage: node rasterize_flags.mjs <src> <dst> <w> <h>');
    process.exit(2);
}
const width = Number(w);
const height = Number(h);

const browser = await chromium.launch();
try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent('<html><body style="margin:0;background:transparent"><img id="i" style="display:block"></body></html>');
    for (const file of readdirSync(src).filter((n) => n.endsWith('.svg')).sort()) {
        const svg = readFileSync(join(src, file)).toString('base64');
        await page.evaluate(async ({ svg, width, height }) => {
            const img = document.getElementById('i');
            img.style.width = `${width}px`;
            img.style.height = `${height}px`;
            img.src = `data:image/svg+xml;base64,${svg}`;
            await img.decode();
        }, { svg, width, height });
        await page.screenshot({
            path: join(dst, file.replace(/\.svg$/, '.png')),
            omitBackground: true,
            clip: { x: 0, y: 0, width, height },
        });
    }
} finally {
    await browser.close();
}
