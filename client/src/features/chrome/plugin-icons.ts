import { captureIdentity, isSameIdentity, type BodyMutationCallback, type ChromeCore, type ChromeSession, type IdentityClient, type Unsubscribe } from './host';

export interface PluginIconsBridge {
    cdn: { url(source: string, path: string): string };
    core: Pick<ChromeCore, 'lifecycle' | 'navigation'>;
    helpers?: { onBodyMutation?(id: string, callback: BodyMutationCallback): Unsubscribe };
    session?: ChromeSession;
    initializePluginIcons?: () => Promise<void>;
    stopPluginIconsMonitoring?: () => void;
    customPlugins?: { refresh(): void };
}
export interface PluginIconsClient extends IdentityClient {
    getPluginConfiguration(pluginId: string): Promise<unknown>;
}
/** One "Name|icon" row of the CustomPluginLinks setting, or a configuration-page test link. */
export interface CustomPlugin { name: string; icon: string; iconType: 'material'; id: string }
interface TestLink { name?: unknown; icon?: unknown }
interface IconsWindow extends Window { testCustomPluginLinks?: unknown; ApiClient?: PluginIconsClient }

type IconConfig =
    | { selector: string; type: 'image'; src: string; alt: string }
    | { selector: string; type: 'material'; icon: string };

const PLUGIN_ID = 'f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b';
const SECTION = 'ul[aria-labelledby="plugins-subheader"]';
const LINK_ATTRIBUTE = 'data-jellyfin-enhanced-plugin-id';
const SIGNATURE_ATTRIBUTE = 'data-jellyfin-enhanced-plugin-signature';

/** Parse the CustomPluginLinks text ("Name | icon" per line). Ids keep the source line index. */
export function parseCustomPluginLinks(text: unknown): CustomPlugin[] {
    if (typeof text !== 'string' || !text.trim()) return [];
    const plugins: CustomPlugin[] = [];
    text.split('\n').forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const parts = trimmed.split('|').map(part => part.trim());
        const [name, icon] = parts;
        if (parts.length >= 2 && name !== undefined && icon !== undefined) {
            plugins.push({ name, icon, iconType: 'material', id: `custom-${index}` });
        }
    });
    return plugins;
}
/** The configuration page's unsaved "Test Links" preview, as plain strings. */
export function testPlugins(value: unknown): CustomPlugin[] | null {
    if (!Array.isArray(value)) return value ? [] : null;
    return value.map((entry: TestLink, index) => ({
        name: String(entry?.name ?? ''), icon: String(entry?.icon ?? ''), iconType: 'material', id: `test-${index}`
    }));
}
const signature = (plugin: CustomPlugin): string => `${plugin.name}\u0000${plugin.icon}`;

export function createPluginIcons(JE: PluginIconsBridge) {
    const host: IconsWindow = window;
    let isProcessing = false;
    let rerun = false;
    let observer: Unsubscribe | null = null;
    let lifecycleActive = false;
    let debounceTimer: number | undefined;
    /** Server/user that owns the cached CustomPluginLinks: plugin config is per server (CHR-ICONS-2). */
    let renderedOwner: ReturnType<typeof captureIdentity> | null = null;
    let cache: { owner: ReturnType<typeof captureIdentity>; plugins: CustomPlugin[] } | null = null;

    function injectCSS(): void {
        if (document.getElementById('plugin-icons-material')) return;
        const style = document.createElement('style');
        style.id = 'plugin-icons-material';
        style.textContent = `
        .plugin-material-icon {
          font-family: 'Material Icons';
          font-size: 24px;
          line-height: 1;
          display: inline-flex !important;
          align-items: center !important;
          justify-content: center !important;
          -webkit-font-smoothing: antialiased;
        }
      `;
        document.head.appendChild(style);
    }

    /** The links to show; null when the reply belonged to an account/server that is no longer signed in. */
    async function getCustomPlugins(): Promise<CustomPlugin[] | null | undefined> {
        const preview = testPlugins(host.testCustomPluginLinks);
        if (preview) return preview;
        const client = host.ApiClient;
        const owner = captureIdentity(JE.session, client);
        if (cache && isSameIdentity(cache.owner, owner)) return cache.plugins;
        try {
            if (!client) return undefined;
            const config = await client.getPluginConfiguration(PLUGIN_ID);
            const links = typeof config === 'object' && config !== null && 'CustomPluginLinks' in config ? config.CustomPluginLinks : '';
            const plugins = parseCustomPluginLinks(links || '');
            // A reply for an account/server that is no longer signed in is discarded.
            if (host.ApiClient !== client || !isSameIdentity(owner, captureIdentity(JE.session, host.ApiClient))) return null;
            cache = { owner, plugins };
            return plugins;
        } catch (error) {
            console.warn('Failed to load custom plugins from server:', error);
        }
        return undefined;
    }

    function createCustomPluginLink(section: Element, plugin: CustomPlugin): void {
        const existing = [...section.querySelectorAll(`[${LINK_ATTRIBUTE}]`)].find(link => link.getAttribute(LINK_ATTRIBUTE) === plugin.id);
        if (existing) return;
        const link = document.createElement('a');
        link.className = 'MuiButtonBase-root MuiListItemButton-root MuiListItemButton-gutters MuiListItemButton-root MuiListItemButton-gutters css-yknuxp';
        link.tabIndex = 0;
        link.href = `${window.location.origin + window.location.pathname}#/configurationpage?name=${encodeURIComponent(plugin.name)}`;
        link.setAttribute(LINK_ATTRIBUTE, plugin.id);
        link.setAttribute(SIGNATURE_ATTRIBUTE, signature(plugin));
        const iconDiv = document.createElement('div');
        iconDiv.className = 'MuiListItemIcon-root css-5pks8q';
        const icon = document.createElement('span');
        icon.className = 'material-icons plugin-material-icon';
        icon.textContent = plugin.icon;
        icon.setAttribute('aria-hidden', 'true');
        iconDiv.appendChild(icon);
        const textDiv = document.createElement('div');
        textDiv.className = 'MuiListItemText-root css-t3p1a1';
        const text = document.createElement('span');
        text.className = 'MuiTypography-root MuiTypography-body1 MuiListItemText-primary css-pl8nxc';
        text.textContent = plugin.name;
        textDiv.appendChild(text);
        link.appendChild(iconDiv);
        link.appendChild(textDiv);
        section.appendChild(link);
    }

    function replacePluginIcon(config: IconConfig): boolean {
        const iconDiv = document.querySelector(config.selector)?.querySelector('.MuiListItemIcon-root');
        if (!iconDiv) return false;
        if (iconDiv.querySelector('.plugin-material-icon, .plugin-custom-icon-img')) return false;
        // Jellyfin 12 renders MUI's <Icon> ligature span instead of the old <svg>; accept either.
        const oldIcon = iconDiv.querySelector('svg, .material-icons');
        if (!oldIcon) return false;
        let element: HTMLElement;
        if (config.type === 'image') {
            const img = document.createElement('img');
            img.src = config.src;
            img.style.width = '24px';
            img.style.height = '24px';
            img.alt = config.alt;
            img.className = 'plugin-custom-icon-img';
            element = img;
        } else {
            element = document.createElement('span');
            element.className = 'material-icons plugin-material-icon';
            element.textContent = config.icon;
            element.setAttribute('aria-hidden', 'true');
        }
        oldIcon.replaceWith(element);
        return true;
    }

    function iconConfigs(): IconConfig[] {
        return [
            { selector: 'a[href*="Jellyfin%20Enhanced"]', type: 'image', src: JE.cdn.url('jellyfish', 'logos/favicon.ico'), alt: 'Jellyfin Enhanced' },
            { selector: 'a[href*="JavaScript%20Injector"]', type: 'image', src: JE.cdn.url('dashboard-icons', 'svg/javascript.svg'), alt: 'JavaScript' },
            { selector: 'a[href*="Intro%20Skipper"]', type: 'material', icon: 'redo' },
            { selector: 'a[href*="reports"]', type: 'material', icon: 'insert_chart_outlined' },
            { selector: 'a[href*="Jellysleep"]', type: 'material', icon: 'dark_mode' },
            { selector: 'a[href*="Home%20Screen%20Sections"]', type: 'material', icon: 'dashboard_customize' },
            { selector: 'a[href*="File%20Transformation"]', type: 'material', icon: 'file_open' },
            { selector: 'a[href*="Newsletters"]', type: 'material', icon: 'newspaper' },
            { selector: 'a[href*="Segment%20Editor"]', type: 'material', icon: 'content_cut' },
            { selector: 'a[href*="Jellyfin%20Helper"]', type: 'image', src: JE.cdn.url('jelly-helper', 'media/favicon.ico'), alt: 'Jellyfin Helper' },
            { selector: 'a[href*="Moonbase"]', type: 'image', src: JE.cdn.url('moonbase', 'moonfin-client'), alt: 'Moonbase' }
        ];
    }

    async function processPluginIcons(): Promise<void> {
        if (isProcessing) { rerun = true; return; }
        isProcessing = true;
        try {
            if (!document.querySelector(SECTION)) return;
            for (const config of iconConfigs()) replacePluginIcon(config);
            const currentOwner = captureIdentity(JE.session, host.ApiClient);
            if (renderedOwner && !isSameIdentity(renderedOwner, currentOwner)) {
                document.querySelectorAll('[' + LINK_ATTRIBUTE + ']').forEach(link => link.remove());
                renderedOwner = null;
            }
            const plugins = await getCustomPlugins();
            // A failed refresh is not an authoritative empty configuration.
            if (plugins === undefined) return;
            // A stale reply is dropped; read again for whoever is signed in now.
            if (!plugins) { rerun = true; return; }
            // The list may have been re-rendered while the configuration loaded.
            const section = document.querySelector(SECTION);
            if (!section) return;
            // Test links are replaced only when the preview set changed. Rewriting
            // them on every pass re-triggered this observer forever (CHR-ICONS-1).
            const wanted = new Map(plugins.map(plugin => [plugin.id, signature(plugin)]));
            const previewActive = testPlugins(host.testCustomPluginLinks) !== null;
            section.querySelectorAll('[' + LINK_ATTRIBUTE + ']').forEach(link => {
                if (previewActive && link.getAttribute(LINK_ATTRIBUTE)?.startsWith('custom-')) return;
                if (wanted.get(link.getAttribute(LINK_ATTRIBUTE) ?? '') !== link.getAttribute(SIGNATURE_ATTRIBUTE)) link.remove();
            });
            for (const plugin of plugins) createCustomPluginLink(section, plugin);
            renderedOwner = captureIdentity(JE.session, host.ApiClient);
        } finally {
            isProcessing = false;
            if (rerun) { rerun = false; schedule(100); }
        }
    }

    function schedule(delay: number): void {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => { void processPluginIcons(); }, delay);
    }

    function onMutations(mutations: MutationRecord[]): void {
        // The plugins list only exists in the dashboard document.
        if (!document.body.classList.contains('dashboardDocument')) return;
        const relevant = mutations.some(mutation => {
            const target = mutation.target;
            if (mutation.type !== 'childList' || !(target instanceof Element)) return false;
            return target.matches(SECTION) || !!target.querySelector(SECTION) || !!target.closest(SECTION) ||
                target === document.body || target.classList.contains('dashboardDocument') ||
                target.classList.contains('settingsDocument') || target.classList.contains('dashboardPage');
        });
        if (relevant) schedule(100);
    }

    function startMonitoring(): void {
        if (observer) return;
        if (JE.helpers?.onBodyMutation) {
            observer = JE.helpers.onBodyMutation('plugin-icons', onMutations);
        } else {
            const native = new MutationObserver(onMutations);
            native.observe(document.body, { childList: true, subtree: true });
            observer = { unsubscribe: () => native.disconnect() };
        }
    }

    function stopMonitoring(): void {
        observer?.unsubscribe();
        observer = null;
        clearTimeout(debounceTimer);
        if (lifecycleActive) {
            JE.core.lifecycle.register('plugin-icons').teardown();
            lifecycleActive = false;
        }
    }

    function setupNavigationListener(): void {
        const lifecycle = JE.core.lifecycle.register('plugin-icons');
        // Re-initialization replaces, never duplicates, the navigation hook.
        lifecycle.teardown();
        lifecycleActive = true;
        lifecycle.track(JE.core.navigation.onNavigate(() => {
            const hash = window.location.hash;
            if (hash.includes('#/dashboard') || hash.includes('#/settings') || hash.includes('#/configurationpage')) schedule(300);
        }));
    }

    async function initialize(): Promise<void> {
        injectCSS();
        setupNavigationListener();
        let retries = 0;
        const tryInitialize = async (): Promise<void> => {
            if (host.ApiClient) {
                await processPluginIcons();
                startMonitoring();
            } else if (retries < 10) {
                retries++;
                setTimeout(() => { void tryInitialize(); }, 500);
            } else {
                console.warn('ApiClient not available after retries, custom plugin links will not work');
                await processPluginIcons();
                startMonitoring();
            }
        };
        void tryInitialize();
    }

    JE.session?.onUserChange('plugin-icons', () => {
        cache = null;
        renderedOwner = null;
        host.testCustomPluginLinks = undefined;
        document.querySelectorAll('[' + LINK_ATTRIBUTE + ']').forEach(link => link.remove());
        schedule(0);
    });

    return {
        initialize,
        stopMonitoring,
        refresh(): void {
            cache = null;
            void processPluginIcons();
        }
    };
}
