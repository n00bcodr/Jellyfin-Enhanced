/** Awards vocabulary, bundled marks and the group's stylesheet. */
export type AwardId = 'imdbTop250' | 'certifiedFresh' | 'oscar' | 'emmy' | 'letterboxdTop250';
export const NAMES: Readonly<Record<AwardId, string>> = {"imdbTop250": "awards_tags_imdbTop250", "certifiedFresh": "awards_tags_certifiedFresh", "oscar": "awards_tags_oscar", "emmy": "awards_tags_emmy", "letterboxdTop250": "awards_tags_letterboxdTop250"};
export const CAPTION_KEYS: Readonly<Record<AwardId, string>> = {"imdbTop250": "awards_tags_label_imdbTop250", "certifiedFresh": "awards_tags_label_certifiedFresh", "oscar": "awards_tags_oscar", "emmy": "awards_tags_emmy", "letterboxdTop250": "awards_tags_label_imdbTop250"};
export const LOGOS = {"imdbTop250":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 16\"><path fill=\"#f5c518\" d=\"M1 2H23V14H1Z\"/><path fill=\"#151515\" d=\"M3 4H5V12H3ZM7 4H10L11 8L12 4H15V12H13V7L12 12H10L9 7V12H7ZM17 4H20L22 6V10L20 12H17ZM19 6V10H20V6Z\"/></svg>","certifiedFresh":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#ef4135\" d=\"M4 7C1 17 9 23 15 20C23 18 23 7 16 6C12 3 7 3 4 7Z\"/><path fill=\"#48a848\" d=\"M12 8L6 2L11 4L14 0L15 5L21 3L17 8Z\"/></svg>","oscar":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#d7ae52\" d=\"M10 1H14L15 5L13 8L15 17H18V20H20V23H4V20H6V17H9L11 8L9 5Z\"/></svg>","emmy":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#d7ae52\" d=\"M2 3L9 7L12 2L15 7L22 3L19 12L14 14L15 20H19V23H5V20H9L10 14L5 12ZM9 9L12 12L15 9L12 6Z\"/></svg>","letterboxdTop250":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path fill=\"#ff8000\" d=\"M0 12A5 5 0 1 0 10 12A5 5 0 1 0 0 12\"/><path fill=\"#00e054\" d=\"M7 12A5 5 0 1 0 17 12A5 5 0 1 0 7 12\"/><path fill=\"#40bcf4\" d=\"M14 12A5 5 0 1 0 24 12A5 5 0 1 0 14 12\"/></svg>"};
export const LABELS: Readonly<Record<AwardId, string>> = { imdbTop250: 'Top 250', certifiedFresh: 'Certified Fresh', oscar: 'Oscar Winner', emmy: 'Emmy Winner', letterboxdTop250: 'Top 250' };
export const CSS = `
        .awards-overlay-container { display:flex; flex-direction:column; gap:calc(4px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); pointer-events:none; max-width:100%; }
        /* Only chip anchors intercept hover; empty poster space still reaches Jellyfin. */
        .je-tag-host:has(.awards-overlay-container) { z-index:2; }
        .awards-link { display:inline-flex; color:inherit; text-decoration:none; pointer-events:auto; }
        .je-tag-pill[href] { pointer-events:auto; text-decoration:none; }
        .awards-tag { display:inline-flex; align-items:center; gap:calc(4px * var(--je-tag-scale, 1)); padding:calc(4px * var(--je-tag-scale, 1)) calc(8px * var(--je-tag-scale, 1)); background:rgba(15,15,15,.85); color:#fff; border-radius:4px; font-size:calc(13px * var(--je-tag-scale, 1)); font-weight:700; line-height:1; white-space:nowrap; box-shadow:0 2px 4px rgba(0,0,0,.3); }
        .awards-tag-logo { display:inline-flex; width:calc(14px * var(--je-tag-scale, 1)); height:calc(14px * var(--je-tag-scale, 1)); flex:0 0 calc(14px * var(--je-tag-scale, 1)); }
        .awards-tag-logo :is(svg, img) { width:100%; height:100%; display:block; object-fit:contain; }
        @supports (container-type:inline-size) { html:not(.layout-mobile) .je-tag-host .awards-tag { font-size:calc(clamp(9px,6.8cqw,13px) * var(--je-tag-scale, 1)); padding:calc(clamp(2px,2cqw,4px) * var(--je-tag-scale, 1)) calc(clamp(4px,4.5cqw,8px) * var(--je-tag-scale, 1)); } }
        .layout-mobile .awards-tag { font-size:calc(11px * var(--je-tag-scale, 1)); padding:calc(2px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1)); }
        @media(max-width:480px) { .awards-tag { font-size:calc(11px * var(--je-tag-scale, 1)); padding:calc(2px * var(--je-tag-scale, 1)) calc(4px * var(--je-tag-scale, 1)); } }
    `;
// [CDN source, file]: the bundled artwork each chip shows; the inline sprites above remain the fallback.
export const LOGO_FILES: Readonly<Record<AwardId, readonly [string, string]>> = { imdbTop250: ['mdblist-logos', 'imdb.png'], letterboxdTop250: ['mdblist-logos', 'letterboxd.png'],
    certifiedFresh: ['mdblist-logos', 'rottentomatoes_fresh.png'], oscar: ['award-logos', 'oscar'], emmy: ['award-logos', 'emmy'] };
