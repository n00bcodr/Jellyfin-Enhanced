import type { DefineSections } from '../engine/schema';

export function defineAbout(define: DefineSections): void {
/* About tab: credits for the projects this plugin's features build on. */
define({
    'credits': {
        title: 'Credits', icon: 'favorite',
        items: [
            { type: 'note', html: 'Jellyfin Enhanced builds on the work of other Jellyfin community projects. Thank you to their authors.' },
            { type: 'html', html: '<ul class="jea-credits">'
                + '<li><strong>Media Tags</strong><span>Based on <a href="https://github.com/BobHasNoSoul/Jellyfin-Qualitytags/" target="_blank" rel="noopener">Jellyfin-Qualitytags</a> by BobHasNoSoul</span></li>'
                + '<li><strong>Custom pause screen</strong><span>Based on <a href="https://github.com/BobHasNoSoul/Jellyfin-PauseScreen" target="_blank" rel="noopener">Jellyfin-PauseScreen</a> by BobHasNoSoul</span></li>'
                + '<li><strong>MDBList ratings</strong><span>Based on <a href="https://github.com/xroguel1ke/jellyfin_ratings" target="_blank" rel="noopener">jellyfin_ratings</a> by xroguel1ke</span></li>'
                + '<li><strong>Metadata icons</strong><span>Uses <a href="https://github.com/Druidblack/jellyfin-icon-metadata" target="_blank" rel="noopener">jellyfin-icon-metadata</a> by Druidblack</span></li>'
                + '</ul>' }
        ]
    }
});

/* ===== Services: linked copies of cards that live in their feature tabs ===== */
define({
    // Maintainerr's card lives in the *arr tab (its fields belong to the main form); this is its linked copy.
    'svc-maintainerr': { mirrorOf: 'arr-maintainerr' },
    'svc-tmdb': { mirrorOf: 'elsewhere-tmdb' },
    'svc-anilist': { mirrorOf: 'reviews-anilist' },
    'svc-mdblist': { mirrorOf: 'mdblist' },
    'svc-ddd': { mirrorOf: 'content-warnings' }
});
}
