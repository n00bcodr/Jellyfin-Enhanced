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
    // Maintainerr's address and key are fields of the Media Tags tab (Status badges > Leaving soon); this card only explains and links.
    'svc-maintainerr': {
        title: 'Maintainerr', iconImg: 'selfhst/svg/maintainerr.svg',
        items: [
            { type: 'note', html: 'Maintainerr is only used to show <strong>how many days are left</strong> before an item leaves, on the <strong>Leaving soon</strong> media tag. Nothing else in Jellyfin Enhanced talks to it.' },
            { type: 'custom', html: '<a class="jea-btn jea-btn-primary" href="#/configurationpage?name=Jellyfin%20Enhanced&amp;jeSection=media-tags&amp;tab=badges"><i class="material-icons" aria-hidden="true">sell</i><span>Set up Leaving soon</span></a>' }
        ]
    },
    'svc-tmdb': { mirrorOf: 'elsewhere-tmdb' },
    'svc-anilist': { mirrorOf: 'reviews-anilist' },
    'svc-mdblist': { mirrorOf: 'mdblist' },
    'svc-ddd': { mirrorOf: 'content-warnings' }
});
}
