(function (JE) {
    'use strict';

    console.log('[JE-ICONS] Module loading...');

    // Poor mans enum for icon name constants   
    // usage: JE.IconName.PLAYBACK
    //
    // This helps avoid typos when requesting icons via JE.icon(name). It will
    // also warn if an unknown name or wrong format is used, typescript style.
    //
    // Note: When adding new icons, update IconName, EMOJI and LUCIDE
    // objects below (and any additional icon sets added in the future).
    const IconName = Object.freeze({
        PLAYBACK: 'playback',
        SKIP: 'skip',
        SUBTITLES: 'subtitles',
        RANDOM: 'random',
        UI: 'ui',
        KEYBOARD: 'keyboard',
        LANGUAGE: 'language',
        SEARCH: 'search',
        HOME: 'home',
        DASHBOARD: 'dashboard',
        SPEED: 'speed',
        ERROR: 'error',
        WARNING: 'warning',
        SUCCESS: 'success',
        INFO: 'info',
        NOTE: 'note',
        VIDEO: 'video',
        AUDIO: 'audio',
        SUBTITLE: 'subtitle',
        ASPECT_RATIO: 'aspectRatio',
        PAUSE: 'pause',
        PLAY: 'play',
        FAST_FORWARD: 'fastForward',
        PIP: 'pip',
        FILE: 'file',
        SPEAKER: 'speaker',
        EYE: 'eye',
        TAG: 'tag',
        MASK: 'mask',
        FLAG: 'flag',
        STAR: 'star',
        NO_ENTRY: 'noEntry',
        LINK: 'link',
        JELLYFISH: 'jellyfish',
        CLIPBOARD: 'clipboard',
        TRASH: 'trash',
        BOOKMARK: 'bookmark',
        PAINT: 'paint',
        RULER: 'ruler',
        FONT: 'font',
        TV: 'tv',
        QUESTION: 'question'
    });

    const validIconNames = new Set(Object.values(IconName));

    const EMOJI = {
        playback: '⏯️',
        skip: '↪️',
        subtitles: '📝',
        random: '🎲',
        ui: '🖥️',
        keyboard: '⌨️',
        language: '🌐',
        search: '🔍',
        home: '🏠',
        dashboard: '📊',
        speed: '⚡',
        error: '❌',
        warning: '⚠️',
        success: '✅',
        info: 'ℹ️',
        note: '📝',
        video: '🎬',
        audio: '🎵',
        subtitle: '📝',
        aspectRatio: '📐',
        pause: '⏸️',
        play: '▶️',
        fastForward: '⏩',
        pip: '🖼️',
        file: '📄',
        speaker: '🗣️',
        eye: '👁️',
        tag: '🏷️',
        mask: '🎭',
        flag: '🏳️',
        star: '⭐',
        noEntry: '🚫',
        link: '🔗',
        jellyfish: '🪼',
        clipboard: '📋',
        trash: '🗑️',
        bookmark: '📍',
        paint: '🎨',
        ruler: '📏',
        font: '🔤',
        tv: '📺',
        question: '❓'
    };

    const LUCIDE = {
        playback: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
        skip: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/></svg>',
        subtitles: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="14" x="3" y="5" rx="2" ry="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/></svg>',
        random: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/></svg>',
        ui: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>',
        keyboard: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2" ry="2"/><path d="M6 8h.001"/><path d="M10 8h.001"/><path d="M14 8h.001"/><path d="M18 8h.001"/><path d="M8 12h.001"/><path d="M12 12h.001"/><path d="M16 12h.001"/><path d="M7 16h10"/></svg>',
        language: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" x2="22" y1="12" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
        search: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
        home: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
        dashboard: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>',
        speed: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
        error: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
        warning: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/></svg>',
        success: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
        info: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
        note: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/></svg>',
        video: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>',
        audio: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
        subtitle: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="14" x="3" y="5" rx="2" ry="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/></svg>',
        aspectRatio: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 7h3v3"/><path d="M17 17h-3v-3"/></svg>',
        pause: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="4" height="16" x="6" y="4"/><rect width="4" height="16" x="14" y="4"/></svg>',
        play: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
        fastForward: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/></svg>',
        pip: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><rect width="7" height="5" x="12" y="14"/></svg>',
        file: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>',
        speaker: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6V2H8"/><path d="m8 18-4 4V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2Z"/><path d="M2 12h2"/></svg>',
        eye: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
        tag: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><path d="M7 7h.01"/></svg>',
        mask: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12a5 5 0 0 0 5 5 8 8 0 0 1 5 2 8 8 0 0 1 5-2 5 5 0 0 0 5-5V7H2Z"/><path d="M6 11c1.5 0 3 .5 3 2-2 0-3 0-3-2Z"/><path d="M18 11c-1.5 0-3 .5-3 2 2 0 3 0 3-2Z"/></svg>',
        flag: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/></svg>',
        star: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
        noEntry: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>',
        link: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
        jellyfish: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c5.523 0 10 4.477 10 10v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1C2 6.477 6.477 2 12 2Z"/><path d="M6.5 15v7"/><path d="M9 15v5.5"/><path d="M12 15v6"/><path d="M15 15v5.5"/><path d="M17.5 15v7"/></svg>',
        clipboard: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>',
        trash: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>',
        bookmark: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
        paint: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11Z"/><path d="m5 2 5 5"/><path d="M2 13h15"/><path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z"/></svg>',
        ruler: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/></svg>',
        font: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/></svg>',
        tv: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="15" x="2" y="7" rx="2" ry="2"/><polyline points="17 2 12 7 7 2"/></svg>',
        question: '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>'
    };

    const MUI = {
        playback: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">play_circle</span>',
        skip: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">skip_next</span>',
        subtitles: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">subtitles</span>',
        random: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">shuffle</span>',
        ui: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">desktop_windows</span>',
        keyboard: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">keyboard</span>',
        language: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">language</span>',
        search: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">search</span>',
        home: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">home</span>',
        dashboard: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">dashboard</span>',
        speed: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">bolt</span>',
        error: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">error</span>',
        warning: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">warning</span>',
        success: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">check_circle</span>',
        info: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">info</span>',
        note: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">description</span>',
        video: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">videocam</span>',
        audio: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">music_note</span>',
        subtitle: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">closed_caption</span>',
        aspectRatio: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">aspect_ratio</span>',
        pause: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">pause</span>',
        play: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">play_arrow</span>',
        fastForward: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">fast_forward</span>',
        pip: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">picture_in_picture</span>',
        file: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">insert_drive_file</span>',
        speaker: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">record_voice_over</span>',
        eye: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">visibility</span>',
        tag: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">label</span>',
        mask: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">theater_comedy</span>',
        flag: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">flag</span>',
        star: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">star</span>',
        noEntry: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">block</span>',
        link: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">link</span>',
        jellyfish: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">water</span>',
        clipboard: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">content_paste</span>',
        trash: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">delete</span>',
        bookmark: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">bookmark</span>',
        paint: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">palette</span>',
        ruler: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">straighten</span>',
        font: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">text_fields</span>',
        tv: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">tv</span>',
        question: '<span class="material-icons" style="font-size:1em;vertical-align:middle;">help</span>'
    };

    JE.icon = function (name) {
        if (!validIconNames.has(name)) console.warn(`[JE-ICONS] Unknown icon name "${name}". Use JE.IconName constants.`);

        const config = JE.pluginConfig || {};
        const useIcons = config.UseIcons !== undefined ? config.UseIcons : (config.useIcons !== undefined ? config.useIcons : true);
        const iconStyle = config.IconStyle || config.iconStyle || 'emoji';
        
        if (useIcons === false) return '';

        switch (iconStyle) {
            case 'lucide':
                return LUCIDE[name] || EMOJI[name] || '';
            case 'mui':
                return MUI[name] || EMOJI[name] || '';
            case 'emoji':
            default:
                return EMOJI[name] || '';
        }
    };

    JE.IconName = IconName;
    JE.icons = { EMOJI, LUCIDE, MUI };

    console.log('[JE-ICONS] Module loaded successfully. JE.icon is now available.');

})(window.JellyfinEnhanced);
