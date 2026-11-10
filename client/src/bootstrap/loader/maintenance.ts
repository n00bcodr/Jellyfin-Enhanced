import { liveNamespace } from '../../host/bootstrap-pages-host';

const DEFAULT_MESSAGE = 'This server is currently undergoing maintenance. Please try again later.';

/** "1h 05m", "12m". Minutes round up so the last minute never reads "0m". */
export function formatMaintenanceCountdown(msRemaining: number): string {
    const totalMinutes = Math.max(0, Math.ceil(msRemaining / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}

/**
 * Replace {countdown} and {ends_at}, appending the time remaining when the
 * message has no {countdown}. Mirrors MaintenanceModeService.FormatMessage.
 * Runs pre-login with no translations loaded, hence the literal English.
 */
export function formatMaintenanceText(message: string, endsAt: Date | null): string {
    const text = (message || '').trim() || DEFAULT_MESSAGE;
    if (!endsAt) return text.replace(/\{countdown\}/gi, '').replace(/\{ends_at\}/gi, '').trim();
    const countdown = formatMaintenanceCountdown(endsAt.getTime() - Date.now());
    const endsAtText = endsAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const hasToken = /\{countdown\}/i.test(text);
    const out = text.replace(/\{countdown\}/gi, () => countdown).replace(/\{ends_at\}/gi, () => endsAtText).trim();
    return hasToken ? out : `${out} Time remaining: ${countdown}.`;
}

const offsetRules = (height: number) => [
    `body { padding-top: ${height}px !important; }`,
    `.skinHeader { top: ${height}px !important; }`,
    `.mainDrawer { top: ${height}px !important; }`,
    // Jellyfin 12 Modern Layout: MUI app bar and side drawers are fixed at top:0 too.
    `.MuiAppBar-positionFixed { top: ${height}px !important; }`,
    `.MuiDrawer-paperAnchorLeft, .MuiDrawer-paperAnchorRight { top: ${height}px !important; height: calc(100% - ${height}px) !important; }`,
    '.videoOsdBottom { bottom: 0 !important; }'
].join('\n');

/**
 * Inject the banner. With an end time it counts down every 15s and removes
 * itself once maintenance is over. Dismissal lasts for this page load.
 */
export function injectMaintenanceBanner(message: string, endsAtIso: string | null): void {
    if (document.getElementById('je-maintenance-banner')) return;
    const endsAt = endsAtIso && !isNaN(Date.parse(endsAtIso)) ? new Date(endsAtIso) : null;
    if (endsAt && endsAt.getTime() <= Date.now()) return;
    const banner = document.createElement('div');
    banner.id = 'je-maintenance-banner';
    // Above Jellyfin's own chrome but below JE's modals (9999+), so a full-height
    // modal's close button is never hidden under it.
    banner.style.cssText = ['position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9990',
        'background:#b71c1c', 'color:#fff', 'text-align:center', 'padding:10px 48px', 'font-size:14px', 'font-weight:600',
        'letter-spacing:0.02em', 'box-shadow:0 2px 8px rgba(0,0,0,0.4)', 'font-family:inherit'].join(';');
    const label = document.createTextNode(formatMaintenanceText(message, endsAt));
    banner.append(label);
    // A style element shifts Jellyfin's fixed chrome by the banner height, so the rules survive
    // it re-rendering its header. The height is tracked rather than measured once: the countdown
    // text, a narrow viewport or a resize can change how many lines the banner wraps to.
    let appliedHeight = -1;
    const applyOffset = () => {
        const height = banner.isConnected ? banner.offsetHeight : 0;
        if (height === appliedHeight) return;
        appliedHeight = height;
        const existing = document.getElementById('je-maintenance-banner-style');
        if (height <= 0) { existing?.remove(); return; }
        const style = existing ?? document.head.appendChild(Object.assign(document.createElement('style'), { id: 'je-maintenance-banner-style' }));
        style.textContent = offsetRules(height);
    };
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(applyOffset) : null;
    const remove = () => {
        banner.remove();
        resizeObserver?.disconnect();
        applyOffset();
    };
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.textContent = '×';
    const closeLabel = liveNamespace()?.t?.('awards_close') ?? '';
    closeButton.setAttribute('aria-label', closeLabel && closeLabel !== 'awards_close' ? closeLabel : 'Close');
    closeButton.style.cssText = 'position:absolute;top:50%;right:12px;transform:translateY(-50%);background:none;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:2px 8px;opacity:0.85';
    closeButton.addEventListener('click', remove);
    document.body.appendChild(banner);
    requestAnimationFrame(applyOffset);
    resizeObserver?.observe(banner);
    banner.appendChild(closeButton);
    if (!endsAt) return;
    const tick = setInterval(() => {
        if (!document.body.contains(banner)) { clearInterval(tick); return; }
        if (endsAt.getTime() <= Date.now()) { clearInterval(tick); remove(); return; }
        label.nodeValue = formatMaintenanceText(message, endsAt);
    }, 15000);
}
