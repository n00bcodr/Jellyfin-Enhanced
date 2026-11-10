/**
 * Pure review text handling: TMDB/AniList review markup to safe HTML, the
 * plain prose sent to a translator, re-linking a translation, the star
 * renderer and the response projections.
 */
import { field, isRecord, list, num, str, text } from './wire';

/**
 * TMDB reviews mix markdown and HTML (<em>, <a href>, <br>). The HTML becomes
 * the markdown parseMarkdown understands and any other tag is dropped.
 */
export function htmlToMarkdown(value: string): string {
    let out = String(value)
        .replace(/<a\s[^>]*?href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
        .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**')
        .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '*$2*')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n');
    // Strip until stable so removing one tag can't assemble another (e.g. "<<b>script>").
    let previous: string;
    do {
        previous = out;
        out = out.replace(/<\/?[a-z][^>]*>/gi, '');
    } while (out !== previous);
    return out;
}

/** Review text as plain prose for translation: links keep only their text. */
export function toPlainText(value: string): string {
    return htmlToMarkdown(value)
        .replace(/\[([^\]]+)\]\(https?:\/\/[^)\s]+\)/g, '$1')
        .replace(/https?:\/\/[^\s<]+/g, '')
        .replace(/(\*\*|__|~~|\*|`)/g, '')
        .replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1$2')
        .replace(/[ \t]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .trim();
}

export interface ReviewLink { label: string; url: string }
/** The links of a review, in order, to put back after it is translated. */
export function extractLinks(value: string): ReviewLink[] {
    const links: ReviewLink[] = [];
    for (const match of htmlToMarkdown(value).matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
        if (match[1] !== undefined && match[2] !== undefined) links.push({ label: match[1], url: match[2] });
    }
    return links;
}

/**
 * Links each label inside the translated text, found by its translation or by
 * its original wording. Links with no match stay plain text.
 */
export function relink(translated: string, links: readonly ReviewLink[], labels: readonly string[]): string {
    if (labels.length !== links.length) return translated;
    let out = translated;
    const linked: string[] = [];
    links.forEach((link, i) => {
        const lower = out.toLowerCase();
        const label = [link.label, labels[i] || ''].map(l => l.trim().replace(/[[\]]/g, '')).find(l => l && lower.includes(l.toLowerCase()));
        if (!label) return;
        const at = lower.indexOf(label.toLowerCase());
        linked.push(`[${out.substr(at, label.length)}](${link.url})`);
        out = `${out.slice(0, at)}\u0001${linked.length - 1}\u0002${out.slice(at + label.length)}`;
    });
    return out.replace(/\u0001(\d+)\u0002/g, (_match, n: string) => linked[Number(n)] ?? '');
}

/**
 * Markdown to HTML. Raw HTML is escaped before any markdown transform, so
 * API-sourced review content cannot inject tags; links allow http(s) only.
 */
export function parseMarkdown(value: string, escapeHtml: (text: string) => string): string {
    if (!value) return '';
    let html = escapeHtml(htmlToMarkdown(value));
    // Protect complete links before emphasis; underscores belong to their URLs.
    // Choose a marker absent from the escaped source so text cannot forge tokens.
    let marker = '\u0000JE';
    while (html.includes(marker)) marker += 'J';
    const protectedHtml: string[] = [];
    const protect = (content: string) => `${marker}${protectedHtml.push(content) - 1}\u0000`;
    const emphasize = (text: string) => text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/__(.+?)__/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/_(.+?)_/g, '<em>$1</em>').replace(/~~(.+?)~~/g, '<del>$1</del>');
    const anchor = (label: string, url: string) => `<a is="emby-linkbutton" href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    html = html.replace(/`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<]+)/gi,
        (_match, code: string | undefined, label: string | undefined, url: string | undefined, plainUrl: string | undefined) => {
            if (code !== undefined) return protect(`<code>${code}</code>`);
            if (label !== undefined && url !== undefined) return protect(anchor(emphasize(label), url));
            const raw = plainUrl ?? '';
            const trimmed = raw.replace(/[.,;!?)]+$/, '');
            return protect(anchor(trimmed, trimmed)) + raw.slice(trimmed.length);
        });
    html = emphasize(html);

    const lines = html.split(/\r?\n/);
    const processed: string[] = [];
    let inBlockquote = false;
    let blockquoteLines: string[] = [];
    let inList = false;
    let listItems: string[] = [];
    for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('&gt; ')) {
            if (!inBlockquote) {
                inBlockquote = true;
                blockquoteLines = [];
            }
            blockquoteLines.push(trimmedLine.substring(5));
            continue;
        } else if (inBlockquote) {
            processed.push('<blockquote>' + blockquoteLines.join('<br>') + '</blockquote>');
            inBlockquote = false;
            blockquoteLines = [];
        }
        if (/^[-*]\s+/.test(trimmedLine)) {
            if (!inList) {
                inList = true;
                listItems = [];
            }
            listItems.push('<li>' + trimmedLine.substring(2) + '</li>');
            continue;
        } else if (inList) {
            processed.push('<ul>' + listItems.join('') + '</ul>');
            inList = false;
            listItems = [];
        }
        const heading = /^(#{1,6})\s/.exec(trimmedLine);
        if (heading?.[1]) {
            const level = /^#+/.exec(trimmedLine)?.[0].length ?? heading[1].length;
            processed.push(`<h${level}>${trimmedLine.substring(level + 1)}</h${level}>`);
            continue;
        }
        if (/^([-*]){3,}$/.test(trimmedLine)) {
            processed.push('<hr>');
            continue;
        }
        processed.push(trimmedLine ? line : '<br>');
    }
    if (inBlockquote) processed.push('<blockquote>' + blockquoteLines.join('<br>') + '</blockquote>');
    if (inList) processed.push('<ul>' + listItems.join('') + '</ul>');
    return protectedHtml.reduce((text, content, index) => text.split(`${marker}${index}\u0000`).join(content), processed.join(''));
}

const STAR_POLYGON = '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>';
/** An outline star with a filled star on top clipped to `fillFraction` (0-1) of its width. */
export function starIconHtml(fillFraction: number): string {
    const pct = Math.round(Math.max(0, Math.min(1, fillFraction)) * 100);
    return `<span class="je-star-icon" aria-hidden="true">
                <svg class="je-star-icon-base" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${STAR_POLYGON}</svg>
                <svg class="je-star-icon-fill" style="clip-path: inset(0 ${100 - pct}% 0 0);" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${STAR_POLYGON}</svg>
            </span>`;
}
/** Five stars for a 1–5 rating in 0.5 increments. */
export function renderUserStarRating(rating: number | null): string {
    if (!rating) return '';
    const stars = Array.from({ length: 5 }, (_, index) => starIconHtml(Math.max(0, Math.min(1, rating - index)))).join('');
    return `<span class="je-user-star-rating">${stars}</span>`;
}

/** Same calendar formatting as the rest of the details page. */
export function reviewDate(value: string | undefined): string {
    return value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
}

/** TMDB (or AniList mapped to TMDB's card shape) review. */
export interface ExternalReview {
    source?: 'anilist'; author: string | undefined; created_at: string | undefined; content: string | undefined;
    rating: number | null; url: string | undefined;
}
export function decodeTmdbReviews(value: unknown): ExternalReview[] {
    return list(field(value, 'results')).filter(isRecord).map(review => ({
        author: str(review.author), created_at: str(review.created_at), content: str(review.content),
        // Rendered into markup: only a finite number is a rating.
        rating: num(field(review.author_details, 'rating')) ?? null,
        url: str(review.url)
    }));
}
/** AniList reviews (PascalCase from Jellyfin) in TMDB's card shape. */
export function decodeAnilistReviews(value: unknown): ExternalReview[] {
    return list(field(value, 'Reviews')).filter(isRecord).map(review => {
        const content = str(review.Content);
        const summary = str(review.Summary);
        const score = num(review.Score);
        return {
            source: 'anilist' as const,
            author: text(review.Author) || 'Anonymous',
            created_at: str(review.CreatedAt),
            content: summary ? `**${summary}**\n\n${content}` : content,
            rating: score ? Number((score / 10).toFixed(1)) : null,
            url: str(review.Url)
        };
    });
}

/** A JE user review (camelCase from the plugin). */
export interface UserReview {
    userId: string; userName: string | undefined; content: string | undefined; rating: number | null;
    createdAt: string | undefined; updatedAt: string | undefined;
}
export function decodeUserReviews(value: unknown): UserReview[] {
    return list(field(value, 'reviews')).filter(isRecord).map(review => ({
        userId: str(review.userId) ?? '',
        userName: str(review.userName),
        content: str(review.content),
        rating: num(review.rating) ?? null,
        createdAt: str(review.createdAt),
        updatedAt: str(review.updatedAt)
    }));
}
export const sameUser = (a: string, b: string) => a.replace(/-/g, '') === b.replace(/-/g, '');

/** Average of the rated reviews on the 10-point scale chip, or null. */
export function averageUserRating(reviews: readonly UserReview[]): { display: string; count: number } | null {
    const rated = reviews.filter((review): review is UserReview & { rating: number } => !!review.rating);
    if (rated.length === 0) return null;
    const raw = (rated.reduce((sum, review) => sum + review.rating, 0) / rated.length) * 2;
    return { display: Number.isInteger(raw) ? `${raw}` : `${raw.toFixed(1)}`, count: rated.length };
}

/**
 * The language to translate English reviews into (the user's Jellyfin
 * language). Null when it is English or unknown. The browser and
 * LibreTranslate name Traditional Chinese differently.
 */
export function translationTargets(language: string): { server: string; browser: string } | null {
    const [base, region] = language.split('-');
    const code = (base || '').toLowerCase();
    if (!code || code === 'en') return null;
    const traditional = code === 'zh' && /^(tw|hk|mo)$/i.test(region || '');
    return { server: traditional ? 'zt' : code, browser: traditional ? 'zh-Hant' : code };
}

/** Replaces `{name}` placeholders; a replacement function avoids `$&`-style patterns. */
export function interpolate(template: string, params: Record<string, string | number> | undefined): string {
    let out = template;
    if (params) {
        for (const [key, value] of Object.entries(params)) {
            out = out.replace(new RegExp(`\\{${key}\\}`, 'g'), () => String(value));
        }
    }
    return out;
}

/** Memoises an async load until it fails: a rejected load is forgotten, so the next call starts it again. */
export function memoUntilFailure<T>(load: () => Promise<T>): () => Promise<T> {
    let pending: Promise<T> | null = null;
    return () => {
        if (pending) return pending;
        const current = pending = load();
        current.catch(() => { if (pending === current) pending = null; });
        return current;
    };
}
