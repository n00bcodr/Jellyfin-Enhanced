import type { DefineSections } from '../engine/schema';

export function defineElsewhere(define: DefineSections): void {
/* Elsewhere tab sections. See jeAdmin.js for the field spec.
 * TMDB key and region stay hand-wired (html items): the key has a Test button, is mirrored to the Seerr tab's copy,
 * and the region list is filled by populateRegionSelect() in the page script. They sit in their own section, ahead
 * of Elsewhere, because Reviews and Release Dates need them even when Elsewhere is off. */
define({
    'elsewhere-tmdb': {
        title: 'TMDB', iconImg: 'selfhst/svg/tmdb.svg',
        items: [
            { type: 'custom', html:
                '<div class="inputContainer jea-row"><label class="inputLabel" for="TMDB_API_KEY">TMDB API Key</label>'
                + '<div class="je-api-row"><input id="TMDB_API_KEY" name="TMDB_API_KEY" type="text" autocomplete="off" class="je-api-input jea-input"/>'
                + '<span id="tmdbStatusIndicator" class="material-icons"></span>'
                + '<button type="button" class="testTmdbBtn jea-btn">Test</button></div></div>'
                + '<div class="je-setting-description" data-desc-for="TMDB_API_KEY"><div class="fieldDescription">Your API key from The Movie DB (TMDB). <a class="sectionTitle" href="https://www.themoviedb.org/settings/api" target="_blank">How to?</a> Shared with Seerr Settings. Needed by Elsewhere, TMDB Reviews and Release Dates.</div></div>' },
            { id: 'DEFAULT_REGION', prop: 'DEFAULT_REGION', manual: true, type: 'select', options: [], label: 'Default Region',
                           desc: 'The default region for streaming provider lookup and release dates. Empty defaults to US. <a class="sectionTitle" href="https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Elsewhere/resources/regions.txt" target="_blank">Full List</a>' }
        ]
    },
    'elsewhere': {
        title: 'Elsewhere (Streaming Providers)', icon: 'live_tv',
        items: [
            { id: 'elsewhereEnabled', prop: 'ElsewhereEnabled', type: 'toggle', main: true, label: 'Enable Elsewhere',
              desc: 'Adds an "Elsewhere" panel to item detail pages showing where the title is available on streaming services in the user\'s region (powered by TMDB watch-provider data).' },
            { id: 'DEFAULT_PROVIDERS', prop: 'DEFAULT_PROVIDERS', type: 'text', label: 'Default Providers', placeholder: 'e.g., Netflix,Hulu',
              desc: 'A list of default streaming providers to show. Leave blank to show all. <a class="sectionTitle" href="https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Elsewhere/resources/providers.txt" target="_blank">Full List</a>' },
            { id: 'IGNORE_PROVIDERS', prop: 'IGNORE_PROVIDERS', type: 'text', label: 'Ignore Providers', placeholder: 'e.g., .*with Ads, Hulu',
              desc: 'A list of providers to ignore from the default region (supports regex). <a class="sectionTitle" href="https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Elsewhere/resources/providers.txt" target="_blank">Full List</a>' },
            { id: 'ElsewhereSeasonProviders', prop: 'ElsewhereSeasonProviders', type: 'toggle', default: true, label: 'Per-season providers',
              desc: 'On Series and Season pages, look up streaming providers per season from TMDB. A season is labelled only when seasons differ; seasons TMDB has no data for fall back to the series providers. Only applies when the series uses the default (aired) season order. Users can turn this off for themselves in the Elsewhere search settings.' },
            { type: 'group', title: 'Custom Branding', items: [
                { id: 'ElsewhereCustomBrandingText', prop: 'ElsewhereCustomBrandingText', type: 'text', label: 'Custom Branding Message', placeholder: 'e.g., Only available on My Server',
                  desc: 'Custom message to display when content is not available on any streaming providers. Leave blank to disable custom branding.' },
                { id: 'ElsewhereCustomBrandingImageUrl', prop: 'ElsewhereCustomBrandingImageUrl', type: 'text', label: 'Custom Branding Icon URL', placeholder: '/web/assets/img/icon.png',
                  desc: 'Optional URL for an icon to display next to the custom message. Leave blank for no icon.' }
            ] }
        ]
    },
    'reviews-panel': {
        title: 'Reviews Panel', icon: 'rate_review',
        items: [
            { id: 'reviewsExpandedByDefault', prop: 'ReviewsExpandedByDefault', type: 'toggle', label: 'Expand reviews by default',
              desc: 'When enabled, the reviews section opens expanded by default for all users (unless they override in their session).' }
        ]
    },
    'reviews-tmdb': {
        title: 'TMDB Reviews', icon: 'reviews',
        items: [
            { id: 'showReviews', prop: 'ShowReviews', type: 'toggle', main: true, label: 'Show TMDB Reviews',
              desc: 'Requires TMDB API Key to be set.' }
        ]
    },
    'reviews-anilist': {
        title: 'AniList', iconImg: 'anilist-static/icon.svg',
        items: [
            { id: 'showAnilistReviews', prop: 'ShowAnilistReviews', type: 'toggle', main: true, label: 'Show AniList Reviews',
              desc: 'Shows the top AniList user reviews for anime in the reviews section.<br>Will only work if AniList is a metadata provider, since items are matched by their AniList ID.<br>No API key needed.<br>Spoiler sections of reviews are hidden.' }
        ]
    },
    'reviews-translation': {
        title: 'Review Translation', icon: 'translate',
        items: [
            { id: 'reviewTranslationEnabled', prop: 'ReviewTranslationEnabled', type: 'toggle', main: true, label: 'Enable Review Translation',
              desc: 'Adds a Translate button to English TMDB and AniList reviews, translating them into the user\'s Jellyfin language.<br>Desktop Chrome and Edge translate on the device, with nothing sent anywhere, but only over HTTPS or localhost. Firefox, Safari, mobile browsers and the Jellyfin apps do not have a built-in translator.<br>Everyone else uses your own <a class="sectionTitle" href="https://libretranslate.com" target="_blank">LibreTranslate</a> instance, if you set one below. Only the review text is sent to it.<br>Translations are done live and are not stored. The button only shows for languages the browser or your instance offers.' },
            { id: 'reviewTranslationUrl', prop: 'ReviewTranslationUrl', type: 'text', label: 'LibreTranslate URL (optional)', placeholder: 'http://localhost:5000',
              toConfig: (v) => (v || '').trim(),
              desc: 'Fallback for browsers without a built-in translator. Base address of the instance, without a trailing path.' },
            { id: 'reviewTranslationApiKey', prop: 'ReviewTranslationApiKey', type: 'password', label: 'LibreTranslate API Key (optional)',
              toConfig: (v) => (v || '').trim(),
              desc: 'Only needed when your instance requires a key.' }
        ]
    },
    'reviews-user': {
        title: 'User Reviews', icon: 'rate_review',
        items: [
            { type: 'note', html: 'Completely independent of Elsewhere being enabled and TMDB Reviews being enabled.' },
            { id: 'showUserReviews', prop: 'ShowUserReviews', type: 'toggle', main: true, label: 'Enable User Written Reviews',
              desc: 'Allows users to write reviews and rate items in the library.' },
            { id: 'hideReviewsFromHiddenUsers', prop: 'HideReviewsFromHiddenUsers', type: 'toggle', default: true, label: 'Hide reviews from hidden users',
              desc: 'When enabled, reviews written by Jellyfin users marked as "Hide this user from login screens" are hidden from non-admin viewers. Admins always see all reviews.' },
            { id: 'hideReviewsFromDisabledUsers', prop: 'HideReviewsFromDisabledUsers', type: 'toggle', default: true, label: 'Hide reviews from disabled users',
              desc: 'When enabled, reviews written by Jellyfin users marked as "Disable this user" are hidden from non-admin viewers. Admins always see all reviews.' },
            { id: 'mirrorReviewRatingsToJellyfin', prop: 'MirrorReviewRatingsToJellyfin', type: 'toggle', label: 'Also save review star ratings as the user\'s Jellyfin rating',
              desc: 'When a user rates a movie or series in a review, also write that rating (scaled to Jellyfin\'s 0-10) to their Jellyfin user rating for the item, so scrobblers and rating sync tools that read Jellyfin user data pick it up. Overwrites any rating the user set elsewhere. Deleting a review, or removing its stars, clears the Jellyfin rating only if it still matches the review; a rating changed elsewhere since is left alone. Season/episode reviews are not mirrored.' },
            { type: 'group', title: 'Poster cards', items: [
                { id: 'showUserRatingOnPosters', prop: 'ShowUserRatingOnPosters', type: 'toggle', label: 'Show average user rating on poster cards',
                  desc: 'When Rating Tags are enabled, overlay a <span class="je-msym-rounded" style="font-size:14px;vertical-align:middle;color:#e91e8c;">person_heart</span> chip on poster cards showing the average rating from all user reviews.' },
                { id: 'showUserRatingDash', prop: 'ShowUserRatingDash', type: 'toggle', default: true, label: 'Show a dash on posters for unrated items',
                  desc: 'When Rating Tags are enabled, a <span class="je-msym-rounded" style="font-size:14px;vertical-align:middle;color:#e91e8c;">person_heart</span> chip appears on every poster. Enable this to show a dash for items the user has not rated yet. Disable to hide the chip entirely for unrated items.' }
            ] }
        ]
    },
    'release-dates': {
        title: 'Release Dates', icon: 'event',
        items: [
            { id: 'showReleaseDate', prop: 'ShowReleaseDates', type: 'toggle', main: true, label: 'Show Release/Air Date',
              desc: 'Requires TMDB API Key to be set. Shows a chip on Movie, Series, Season and Episode detail pages with the cinema/digital/physical release date or next/last air date, sourced from TMDB. Uses the Default Region set under TMDB Connection above to pick which country\'s dates to prefer.' }
        ]
    }
});
}
