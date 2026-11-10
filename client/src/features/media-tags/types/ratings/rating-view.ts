import { COLORS, LOGOS, LOGO_FILES, NAMES, NAME_KEYS } from './rating-data';
import type { RatingSourceId } from './rating-data';
import type { RatingFact } from './rating-sources';
export interface RatingViewHost {
    document: Document;
    translate(key: string): string;
    assetUrl?: ((bucket: string, file: string) => string) | undefined;
}
export function sourceName(id: RatingSourceId, translate: (key: string) => string): string {
    return NAMES[id] || translate(NAME_KEYS[id] || id);
}
export function createRatingView(host: RatingViewHost) {
    const document = host.document;
    const logoFile = (id: RatingSourceId, value: number) => id === 'rtCritic'
        ? (value < 60 ? 'rottentomatoes_rotten.png' : 'rottentomatoes_fresh.png') : LOGO_FILES[id];
    function logo(id: RatingSourceId, value: number) {
        const el = document.createElement('span');
        el.className = 'je-rating-source-logo';
        el.setAttribute('aria-hidden', 'true');
        const file = logoFile(id, value);
        if (file && host.assetUrl) {
            const img = document.createElement('img');
            img.src = host.assetUrl('mdblist-logos', file);
            img.alt = '';
            img.decoding = 'async';
            el.appendChild(img);
        }
        else {
            el.innerHTML = LOGOS[id] || '';
        }
        return el;
    }
    /** Render the same chip for posters and the settings hub preview. */
    function chip(fact: RatingFact) {
        const el = document.createElement('div');
        const legacy = fact.id === 'community' ? ' rating-tag-tmdb' : fact.id === 'critic' ? ' rating-tag-critic' : ' rating-tag--source';
        el.className = 'rating-tag' + legacy;
        el.dataset.jeRatingSource = fact.id;
        el.style.setProperty('--je-rating-source-color', COLORS[fact.id] || '');
        if (fact.color)
            el.style.color = fact.color;
        el.title = sourceName(fact.id, host.translate) + ': ' + fact.text;
        el.setAttribute('aria-label', el.title);
        const icon = fact.id === 'community' || fact.id === 'critic' ? document.createElement('span') : logo(fact.id, fact.value);
        if (fact.id === 'community') {
            icon.className = 'material-icons rating-star-icon';
            icon.textContent = 'star';
        }
        if (fact.id === 'critic')
            icon.className = 'rating-tomato-icon ' + (fact.value < 60 ? 'rotten' : 'fresh');
        icon.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.className = 'rating-text';
        text.textContent = fact.text;
        el.append(icon, text);
        return el;
    }
    return { chip };
}
