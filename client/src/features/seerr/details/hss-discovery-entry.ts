import { bridge, SEERR_LOG } from '../host-details';
import { parseMediaType } from './domain/media';

/**
 * Home Screen Sections: a click on a discover card opens the more-info modal instead
 * of leaving for the Seerr website. The request button keeps its own behaviour.
 */
const JE = bridge();
const logPrefix = `${SEERR_LOG} HSS Discovery Handler:`;

document.addEventListener('click', event => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('.discover-requestbutton')) return;
    const card = event.target.closest<HTMLElement>('.discover-card');
    if (!card) return;
    // The card belongs to another plugin: its attributes are only ever an id and a type.
    const tmdbId = card.dataset.tmdbId;
    const mediaType = parseMediaType(card.dataset.mediaType);
    const open = JE.jellyseerrMoreInfo?.open;
    if (!tmdbId || !/^\d+$/.test(tmdbId) || !mediaType || !open) return;
    console.log(`${logPrefix} Opening more-info modal for TMDB ID: ${tmdbId}, Type: ${mediaType}`);
    event.preventDefault();
    event.stopPropagation();
    void open.call(JE.jellyseerrMoreInfo, tmdbId, mediaType);
}, true);
