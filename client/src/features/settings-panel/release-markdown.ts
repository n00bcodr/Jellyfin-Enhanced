/** Callout icons, already rendered by the icon module. */
export interface CalloutIcons { WARNING: string; NOTE: string; TIP: string; IMPORTANT: string }
type Callout = keyof CalloutIcons;
const isCallout = (value: string): value is Callout => value === 'WARNING' || value === 'NOTE' || value === 'TIP' || value === 'IMPORTANT';

/**
 * Convert release-note markdown to HTML safe for innerHTML. Raw HTML is
 * escaped first, so API-sourced text cannot inject tags; the markdown chain
 * then builds its own markup. Pure: no DOM or globals.
 */
export function markdownToHtml(text: string, escapeHtml: (value: string) => string, icons: CalloutIcons): string {
    if (!text) return '';
    const colors: Record<Callout, { border: string; bg: string; icon: string }> = {
        WARNING: { border: '#f0ad4e', bg: 'rgba(240, 173, 78, 0.1)', icon: icons.WARNING },
        NOTE: { border: '#00a4dc', bg: 'rgba(0, 164, 220, 0.1)', icon: icons.NOTE },
        TIP: { border: '#28a745', bg: 'rgba(40, 167, 69, 0.1)', icon: icons.TIP },
        IMPORTANT: { border: '#dc3545', bg: 'rgba(220, 53, 69, 0.1)', icon: icons.IMPORTANT }
    };
    return escapeHtml(text)
        // Blockquotes with callouts — match &gt; since input is now escaped
        .replace(/^&gt;\s*\[!(WARNING|NOTE|TIP|IMPORTANT)\]\s*\r?\n((?:&gt;.*(?:\r?\n|$))+)/gm, (_match: string, type: string, content: string) => {
            const noteContent = content.replace(/^&gt;\s?/gm, '');
            const style = isCallout(type) ? colors[type] : colors.NOTE;
            return `<div style="padding: 12px 16px; border-left: 4px solid ${style.border}; background-color: ${style.bg}; margin: 12px 0; border-radius: 4px;"><strong>${style.icon} ${type}:</strong><br>${noteContent}</div>`;
        })
        // Headings (with better spacing)
        .replace(/^### (.*$)/gm, '<h4 style="font-size: 1.1em; margin: 1em 0 0 0; font-weight: 600; color: rgba(255,255,255,0.9);">$1</h4>')
        .replace(/^## (.*$)/gm, '<h3 style="font-size: 1.25em; margin: 1.2em 0 0 0; font-weight: 600; color: rgba(255,255,255,0.95);">$1</h3>')
        .replace(/^# (.*$)/gm, '<h2 style="font-size: 1.4em; margin: 1.2em 0 0 0; font-weight: 700;">$1</h2>')
        // Code blocks (inline)
        .replace(/`([^`]+)`/g, '<code style="background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 0.9em;">$1</code>')
        // Links
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color: var(--primary-accent-color, #00a4dc); text-decoration: underline; text-decoration-color: rgba(0, 164, 220, 0.3);">$1</a>')
        // Bold and Italic
        .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        // Numbered lists
        .replace(/^\d+\.\s+(.*)$/gm, (_match: string, item: string) => `<ol style="margin: 0; padding-left: 20px;"><li style="margin: 4px 0;">${item}</li></ol>`)
        .replace(/<\/ol>\s*<ol[^>]*>/g, '') // Merge adjacent numbered lists
        // Bullet lists
        .replace(/^[-*]\s+(.*)$/gm, (_match: string, item: string) => `<ul style="margin: 0; padding-left: 20px;"><li style="margin: 4px 0;">${item}</li></ul>`)
        .replace(/<\/ul>\s*<ul[^>]*>/g, '') // Merge adjacent lists
        // Handle backslash at end of line as line break (markdown line break)
        .replace(/\\\s*\n/g, '<br>')
        // General newlines (double newline - paragraph break, single - line break)
        .replace(/\n\n+/g, '<br><br>')
        .replace(/\n/g, '<br>')
        // Collapse excessive line breaks (max 2)
        .replace(/(<br>\s*){3,}/g, '<br><br>');
}

/** The fields of a GitHub "latest release" response the notification shows. */
export interface ReleaseView { body: string | undefined; tagName: unknown; published: Date; htmlUrl: string }

/**
 * Decode an untrusted GitHub release response. The link only keeps an http(s)
 * URL (escaping alone does not stop a `javascript:` href); anything else
 * points at the repository's latest release page.
 */
export function decodeRelease(value: unknown, repository: string): ReleaseView {
    const record = value !== null && typeof value === 'object' ? value : {};
    const field = (name: string): unknown => Object.prototype.hasOwnProperty.call(record, name) ? Reflect.get(record, name) : undefined;
    const body = field('body');
    const publishedAt = field('published_at');
    const url = field('html_url');
    return {
        body: typeof body === 'string' ? body : undefined,
        tagName: field('tag_name'),
        published: publishedAt === null ? new Date(0)
            : typeof publishedAt === 'string' || typeof publishedAt === 'number' ? new Date(publishedAt) : new Date(NaN),
        htmlUrl: typeof url === 'string' && /^https?:\/\//i.test(url) ? url : `https://github.com/${repository}/releases/latest`,
    };
}

/** Release notes as shown: the body cut at 3000 characters, or a placeholder. */
export function releaseNotesText(body: string | undefined): string {
    return body ? (body.length > 3000 ? body.substring(0, 3000) + '...' : body) : 'No release notes available.';
}
