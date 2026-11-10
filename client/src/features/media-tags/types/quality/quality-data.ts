// Quality vocabulary and appearance. scripts/build_poster_assets.py reads qualityColors, audioBases and the
// LOW-RES rule from this file as text, and scripts/generate_technical_ratios.py writes the aspect table below.
export interface QualityCategory {
    key: string;
    items: readonly string[];
    settingKey: string;
    pluginKey: string;
    orderUserKey: string;
    orderPluginKey: string;
    defaultOrder: number;
    fallback?: boolean;
}
export interface QualityColour { bg: string; text: string }
// Within-category sort orders (more important = lower index inside each category).
export const resolutionOrder = ['8K', '4K', '1440p', '1080p', '1080i', '720p', '576p', '576i', '480p', '480i', 'LOW-RES', 'SD'];
export const sourceOrder = ['REMUX', 'BluRay', 'WEB', 'HD DVD', 'DVD', 'VHS', 'HDTV', 'SDTV', 'Physical', 'CAM', 'TS', 'TC', 'SCR'];
export const EDITION_PREFIX = 'edition:';
const editionOrder: string[] = [];
export const dynamicRangeOrder = ['Dolby Vision', 'HDR10+', 'HDR10', 'HLG', 'HDR', 'SDR'];
export const specialFormatOrder = ['IMAX', '3D'];
export const codecOrder = ['VVC', 'AV1', 'HEVC', 'H265', 'VP9', 'H264', 'VP8', 'XVID', 'DIVX', 'VC-1', 'WMV', 'MPEG2', 'MPEG4', 'MJPEG', 'THEORA', 'ProRes'];
// TRaSH-Guides audio scores, highest first; from Dolby Digital+ on, lossy tracks rank by channels first.
export const audioOrder = ['TRUEHD ATMOS', 'DTS-X', 'ATMOS', 'DD+ ATMOS', 'TRUEHD', 'DTS-HD MA', 'PCM', 'FLAC', 'DTS-HD HRA', 'DTS-HD', 'Dolby Digital+', 'DTS', 'Dolby Digital', '7.1', '6.1', '5.1'];

// showXxxTag = enable, xxxTagOrder = 1..N stack position.
export const CATEGORIES: readonly QualityCategory[] = [
    { key: 'resolution',    items: resolutionOrder,    settingKey: 'showResolutionTag',    pluginKey: 'ShowResolutionTag',    orderUserKey: 'resolutionTagOrder',    orderPluginKey: 'ResolutionTagOrder',    defaultOrder: 1 },
    { key: 'source',        items: sourceOrder,        settingKey: 'showSourceTag',        pluginKey: 'ShowSourceTag',        orderUserKey: 'sourceTagOrder',        orderPluginKey: 'SourceTagOrder',        defaultOrder: 2 },
    { key: 'dynamicRange',  items: dynamicRangeOrder,  settingKey: 'showDynamicRangeTag',  pluginKey: 'ShowDynamicRangeTag',  orderUserKey: 'dynamicRangeTagOrder',  orderPluginKey: 'DynamicRangeTagOrder',  defaultOrder: 3 },
    { key: 'specialFormat', items: specialFormatOrder, settingKey: 'showSpecialFormatTag', pluginKey: 'ShowSpecialFormatTag', orderUserKey: 'specialFormatTagOrder', orderPluginKey: 'SpecialFormatTagOrder', defaultOrder: 4 },
    { key: 'videoCodec',    items: codecOrder,         settingKey: 'showVideoCodecTag',    pluginKey: 'ShowVideoCodecTag',    orderUserKey: 'videoCodecTagOrder',    orderPluginKey: 'VideoCodecTagOrder',    defaultOrder: 5 },
    { key: 'audio',         items: audioOrder,         settingKey: 'showAudioInfoTag',     pluginKey: 'ShowAudioInfoTag',     orderUserKey: 'audioInfoTagOrder',     orderPluginKey: 'AudioInfoTagOrder',     defaultOrder: 6 },
    { key: 'edition', items: editionOrder, settingKey: 'showEditionTag', pluginKey: 'ShowEditionTag', orderUserKey: 'editionTagOrder', orderPluginKey: 'EditionTagOrder', defaultOrder: 7 },
    { key: 'runtime', items: [], settingKey: 'showRuntimeTag', pluginKey: 'ShowRuntimeTag', orderUserKey: 'runtimeTagOrder', orderPluginKey: 'RuntimeTagOrder', defaultOrder: 8, fallback: false },
    { key: 'aspectRatio', items: [], settingKey: 'showAspectRatioTag', pluginKey: 'ShowAspectRatioTag', orderUserKey: 'aspectRatioTagOrder', orderPluginKey: 'AspectRatioTagOrder', defaultOrder: 9, fallback: false },
    { key: 'frameRate', items: [], settingKey: 'showFrameRateTag', pluginKey: 'ShowFrameRateTag', orderUserKey: 'frameRateTagOrder', orderPluginKey: 'FrameRateTagOrder', defaultOrder: 10, fallback: false },
    { key: 'versions', items: [], settingKey: 'showVersionsTag', pluginKey: 'ShowVersionsTag', orderUserKey: 'versionsTagOrder', orderPluginKey: 'VersionsTagOrder', defaultOrder: 11, fallback: false },
];

export const TAG_TO_CATEGORY = new Map<string, string>();
for (const cat of CATEGORIES) {
    for (const item of cat.items) TAG_TO_CATEGORY.set(item, cat.key);
}
export const CATEGORY_BY_KEY = new Map(CATEGORIES.map(c => [c.key, c]));
// Color definitions for each quality tag.
const qualityColors = {
    '8K': { bg: 'rgba(220, 20, 60, 0.95)', text: '#ffffff' },
    '4K': { bg: 'rgba(189, 5, 232, 0.95)', text: '#ffffff' },
    '1440p': { bg: 'rgba(255, 20, 147, 0.9)', text: '#ffffff' },
    '1080p': { bg: 'rgba(0, 160, 230, 0.9)', text: '#ffffff' },
    '1080i': { bg: 'rgba(0, 160, 230, 0.9)', text: '#ffffff' },
    '720p': { bg: 'rgba(255, 165, 0, 0.9)', text: '#000000' },
    '576p': { bg: 'rgba(255, 179, 0, 0.85)', text: '#000000' },
    '576i': { bg: 'rgba(255, 179, 0, 0.85)', text: '#000000' },
    '480p': { bg: 'rgba(255, 193, 7, 0.85)', text: '#000000' },
    '480i': { bg: 'rgba(255, 193, 7, 0.85)', text: '#000000' },
    'SD': { bg: 'rgba(108, 117, 125, 0.85)', text: '#ffffff' },
    'SDR': { bg: 'rgba(84, 110, 122, 0.9)', text: '#ffffff' },
    'HDR': { bg: 'rgba(255, 215, 0, 0.95)', text: '#000000' },
    'HDR10': { bg: 'rgba(255, 215, 0, 0.95)', text: '#000000' },
    'HDR10+': { bg: 'rgba(255, 215, 0, 0.95)', text: '#000000' },
    'HLG': { bg: 'rgba(255, 215, 0, 0.95)', text: '#000000' },
    'Dolby Vision': { bg: 'rgba(139, 69, 19, 0.95)', text: '#ffffff' },
    'IMAX': { bg: 'rgba(0, 114, 206, 0.9)', text: '#ffffff' },
    'ATMOS': { bg: 'rgba(0, 100, 255, 0.9)', text: '#ffffff' },
    'TRUEHD ATMOS': { bg: 'rgba(0, 100, 255, 0.9)', text: '#ffffff' },
    'DD+ ATMOS': { bg: 'rgba(0, 100, 255, 0.9)', text: '#ffffff' },
    'DTS-X': { bg: 'rgba(255, 100, 0, 0.9)', text: '#ffffff' },
    'DTS-HD MA': { bg: 'rgba(245, 130, 0, 0.85)', text: '#ffffff' },
    'DTS-HD HRA': { bg: 'rgba(245, 130, 0, 0.85)', text: '#ffffff' },
    'DTS-HD': { bg: 'rgba(245, 130, 0, 0.85)', text: '#ffffff' },
    'Dolby Digital': { bg: 'rgba(0, 150, 136, 0.9)', text: '#ffffff' },
    'DTS': { bg: 'rgba(245, 130, 0, 0.85)', text: '#ffffff' },
    'Dolby Digital+': { bg: 'rgba(0, 150, 136, 0.9)', text: '#ffffff' },
    'TRUEHD': { bg: 'rgba(76, 175, 80, 0.9)', text: '#ffffff' },
    'PCM': { bg: 'rgba(46, 125, 50, 0.9)', text: '#ffffff' },
    'FLAC': { bg: 'rgba(46, 125, 50, 0.9)', text: '#ffffff' },
    '7.1': { bg: 'rgba(156, 39, 176, 0.9)', text: '#ffffff' },
    '6.1': { bg: 'rgba(126, 87, 194, 0.9)', text: '#ffffff' },
    '5.1': { bg: 'rgba(103, 58, 183, 0.9)', text: '#ffffff' },
    '3D': { bg: 'rgba(0, 150, 255, 0.9)', text: '#ffffff' },
    'VVC': { bg: 'rgba(230, 74, 25, 0.95)', text: '#ffffff' },
    'AV1': { bg: 'rgba(255, 87, 34, 0.95)', text: '#ffffff' },
    'HEVC': { bg: 'rgba(33, 150, 243, 0.9)', text: '#ffffff' },
    'H265': { bg: 'rgba(63, 81, 181, 0.9)', text: '#ffffff' },
    'VP9': { bg: 'rgba(156, 39, 176, 0.9)', text: '#ffffff' },
    'H264': { bg: 'rgba(76, 175, 80, 0.9)', text: '#ffffff' },
    'VP8': { bg: 'rgba(121, 85, 72, 0.9)', text: '#ffffff' },
    'XVID': { bg: 'rgba(255, 152, 0, 0.9)', text: '#000000' },
    'DIVX': { bg: 'rgba(255, 193, 7, 0.9)', text: '#000000' },
    'VC-1': { bg: 'rgba(0, 188, 212, 0.9)', text: '#000000' },
    'WMV': { bg: 'rgba(0, 188, 212, 0.9)', text: '#000000' },
    'MPEG2': { bg: 'rgba(96, 125, 139, 0.9)', text: '#ffffff' },
    'MPEG4': { bg: 'rgba(158, 158, 158, 0.9)', text: '#ffffff' },
    'MJPEG': { bg: 'rgba(233, 30, 99, 0.9)', text: '#ffffff' },
    'THEORA': { bg: 'rgba(139, 195, 74, 0.9)', text: '#000000' },
    'ProRes': { bg: 'rgba(96, 125, 139, 0.9)', text: '#ffffff' },
    'REMUX': { bg: 'rgba(13, 71, 161, 0.95)', text: '#ffffff' },
    'WEB': { bg: 'rgba(0, 121, 107, 0.95)', text: '#ffffff' },
    'CAM': { bg: 'rgba(183, 28, 28, 0.95)', text: '#ffffff' },
    'TS': { bg: 'rgba(183, 28, 28, 0.95)', text: '#ffffff' },
    'TC': { bg: 'rgba(183, 28, 28, 0.95)', text: '#ffffff' },
    'SCR': { bg: 'rgba(183, 28, 28, 0.95)', text: '#ffffff' },
    'Director\'s Cut': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Extended': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Unrated': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Theatrical': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Remastered': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Criterion': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Uncut': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Final Cut': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Special Edition': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Redux': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Ultimate': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Collector\'s Edition': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Anniversary': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Uncensored': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Open Matte': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Rogue Cut': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Producer\'s Cut': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Alternate Cut': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Assembly Cut': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'International Cut': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Restored': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Hybrid': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Roadshow': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Despecialized': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Fan Edit': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Black and Chrome': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'Masters of Cinema': { bg: 'rgba(106, 27, 154, 0.95)', text: '#ffffff' },
    'BluRay': { bg: 'rgba(0, 102, 204, 0.95)', text: '#ffffff' },
    'HD DVD': { bg: 'rgba(128, 0, 32, 0.95)', text: '#ffffff' },
    'DVD': { bg: 'rgba(102, 102, 102, 0.95)', text: '#ffffff' },
    'VHS': { bg: 'rgba(139, 69, 19, 0.95)', text: '#ffffff' },
    'HDTV': { bg: 'rgba(69, 90, 100, 0.95)', text: '#ffffff' },
    'SDTV': { bg: 'rgba(69, 90, 100, 0.95)', text: '#ffffff' },
    'Physical': { bg: 'rgba(102, 102, 102, 0.9)', text: '#ffffff' },
    'Mixed': { bg: '#546e7a', text: '#ffffff' }
};
export const QUALITY_COLOURS: Readonly<Record<string, QualityColour>> = qualityColors;
// The compound sound labels, longest name first: "Dolby Digital+ 5.1" is Dolby Digital+, not Dolby Digital.
const audioBases = ['TRUEHD ATMOS', 'DD+ ATMOS', 'Dolby Digital+', 'Dolby Digital', 'ATMOS', 'DTS-X', 'TRUEHD', 'DTS-HD MA', 'DTS-HD HRA', 'DTS-HD', 'DTS', 'PCM', 'FLAC'];
export const AUDIO_BASES: readonly string[] = audioBases;
// Full words are translatable; compact edition codes and proper nouns are literals.
export const EDITIONS: Readonly<Record<string, readonly [string | null, string | null]>> = {"Director's Cut": ["quality_edition_directors_cut", "DC"], "Extended": ["quality_edition_extended", "Ext"], "Unrated": ["quality_edition_unrated", "Unr"], "Theatrical": ["quality_edition_theatrical", null], "IMAX": [null, "IMAX"], "Remastered": ["quality_edition_remastered", "Rem"], "Criterion": [null, "CC"], "Uncut": ["quality_edition_uncut", null], "Final Cut": ["quality_edition_final_cut", null], "Special Edition": ["quality_edition_special", "quality_edition_special_compact"], "Redux": [null, "Redux"], "Ultimate": ["quality_edition_ultimate", "Ult"], "Collector's Edition": ["quality_edition_collectors", "CE"], "Anniversary": ["quality_edition_anniversary", "Anniv"], "Uncensored": ["quality_edition_uncensored", "Unc"], "Open Matte": [null, "OM"], "Rogue Cut": [null, "Rogue"], "Producer's Cut": ["quality_edition_producers_cut", "PC"], "Alternate Cut": ["quality_edition_alternate_cut", "Alt"], "Assembly Cut": ["quality_edition_assembly_cut", "Asm"], "International Cut": ["quality_edition_international_cut", "Intl"], "Restored": ["quality_edition_restored", "Rest"], "Hybrid": ["quality_edition_hybrid", "Hyb"], "Black and Chrome": [null, "B&C"], "Masters of Cinema": [null, "MoC"], "Roadshow": ["quality_edition_roadshow", "Road"], "Despecialized": [null, "Despec"], "Fan Edit": ["quality_edition_fan_edit", "Fan"]};
export const aspectRatios = (() => {
    // Generated by scripts/generate_technical_ratios.py; edit TechnicalQualityRules.cs.
    const ratios: readonly (readonly [number, number, string])[] = [[1.3333333333333333,0.025,"4:3"],[1.43,0.015,"1.43:1"],[1.66,0.02,"1.66:1"],[1.7777777777777777,0.025,"16:9"],[1.85,0.025,"1.85:1"],[1.9,0.02,"1.90:1"],[2.0,0.025,"2:1"],[2.2,0.025,"2.20:1"],[2.35,0.019,"2.35:1"],[2.39,0.025,"2.39:1"],[2.76,0.025,"2.76:1"]];
    // End generated aspect ratios.
    return ratios;
})();

/** The group's stylesheet: base chips, then one colour rule per label. */
export function qualityCss(overlayClass: string, containerClass: string, chipBaseCss: (selector: string) => string): string {
    // Generate CSS rules from the color configuration
    const rules = Object.entries(qualityColors).map(([k, v]) => {
        return chipBaseCss(`.${overlayClass}`) + `.${containerClass} .${overlayClass}[data-quality="${k}"] {
                    background: ${v.bg} !important;
                    color: ${v.text} !important;
                }`;
    }).join("\n");

    // Placement (corner, band, caption...) comes from the layout
    // stylesheet (tags/tag-layout-styles.js); this only styles the group.
    return `
                .${containerClass} {
                    display: flex;
                    flex-direction: column;
                    gap: calc(4px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    align-items: flex-start;
                    z-index: 100;
                    max-width: calc(100% - 12px);
                    max-height: 90%;
                    overflow: hidden;
                    pointer-events: none;
                }


                .layout-mobile .${containerClass} {
                    gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                }
                @media (min-width: 1440px) {

                    .${containerClass} {
                        gap: calc(6px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    }
                }
                @media (max-width: 768px) {

                    .${containerClass} {
                        gap: calc(1px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    }
                }
                @media (max-width: 480px) {

                    .${containerClass} {
                        gap: calc(1px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                        max-height: 85%;
                    }
                }
                /* Generic style for low resolution content */
                .${containerClass} .${overlayClass}[data-quality="LOW-RES"] {
                    background: rgba(128, 128, 128, 0.8) !important;
                    color: #ffffff !important;
                }
                .${overlayClass}[data-je-quality-category] {
                    background: rgba(55, 71, 79, 0.95) !important;
                    color: #ffffff !important;
                }
                ${rules}
                .${containerClass} .${overlayClass}[data-je-edition] {
                    background: rgba(106, 27, 154, 0.95) !important;
                    color: #ffffff !important;
                }
            `;
}
