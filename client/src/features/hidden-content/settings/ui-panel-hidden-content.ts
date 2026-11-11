/**
 * @file Hidden Content section wiring inside the settings panel (toggles,
 * surface filters, experimental options, manage button).
 * Strict TypeScript replacement of the module split from ui.js (same markup, ids and behaviour).
 */
import { panelHost, registry, type HiddenContentSettingKey, type PanelBridge } from './host';
import type { PanelContext } from '../../settings-panel/public-api';
import { inputById } from '../../shared/dom';

type Deps = Pick<PanelBridge, 'internals' | 'hiddenContent' | 'hiddenContentPage' | 'pluginConfig'>;

const HIDDEN_BUTTON_TOGGLES: ReadonlyArray<readonly [string, HiddenContentSettingKey]> = [
    ['hiddenShowButtonJellyseerr', 'showButtonJellyseerr'],
    ['hiddenShowButtonLibrary', 'showButtonLibrary'],
    ['hiddenShowButtonDetails', 'showButtonDetails'],
    ['hiddenShowButtonCast', 'showButtonCast']
];
const HIDDEN_SURFACE_TOGGLES: ReadonlyArray<readonly [string, HiddenContentSettingKey]> = [
    ['hiddenFilterLibrary', 'filterLibrary'],
    ['hiddenFilterDiscovery', 'filterDiscovery'],
    ['hiddenFilterSearch', 'filterSearch'],
    ['hiddenFilterCalendar', 'filterCalendar'],
    ['hiddenFilterUpcoming', 'filterUpcoming'],
    ['hiddenFilterRecommendations', 'filterRecommendations'],
    ['hiddenFilterRequests', 'filterRequests'],
    ['hiddenFilterNextUp', 'filterNextUp'],
    ['hiddenFilterContinueWatching', 'filterContinueWatching']
];

export function installUiPanelHiddenContent(JE: Deps): void {
    const internal = registry(JE);

    /**
     * Wires the Hidden Content settings-panel listeners: master enable,
     * button visibility, surface filters, confirmation dialog, experimental
     * collections, and the "Manage Hidden Content" button.
     * @param ctx Shared panel context assembled in ui-panel.ts.
     */
    internal.wireHiddenContentListeners = function(ctx: Pick<PanelContext, 'resetAutoCloseTimer' | 'closePanel'>) {
        const { resetAutoCloseTimer } = ctx;
        // Read at wiring time; the Hidden Content module owns the surface.
        const hidden = JE.hiddenContent;
        if (!hidden) return;

        /** Bind a checkbox's change to its handler (absent controls are skipped). */
        const onToggle = (id: string, handler: (checked: boolean) => void) => {
            const el = inputById(id);
            if (el) el.addEventListener('change', () => handler(el.checked));
        };

        for (const [id, key] of HIDDEN_BUTTON_TOGGLES) {
            onToggle(id, (checked) => {
                hidden.updateSettings({ [key]: checked });
                if (key === 'showButtonLibrary' || key === 'showButtonCast') {
                    if (checked) {
                        hidden.addLibraryHideButtons();
                    } else {
                        hidden.removeLibraryHideButtons();
                        hidden.addLibraryHideButtons();
                    }
                }
                resetAutoCloseTimer();
            });
        }
        onToggle('hiddenContentEnabledToggle', (checked) => {
            hidden.updateSettings({ enabled: checked });
            resetAutoCloseTimer();
        });
        onToggle('hiddenShowHideButtons', (checked) => {
            hidden.updateSettings({ showHideButtons: checked });
            if (checked) {
                if (hidden.getSettings().showButtonLibrary) {
                    hidden.addLibraryHideButtons();
                }
            } else {
                hidden.removeLibraryHideButtons();
            }
            resetAutoCloseTimer();
        });
        for (const [id, key] of HIDDEN_SURFACE_TOGGLES) {
            onToggle(id, (checked) => {
                hidden.updateSettings({ [key]: checked });
                resetAutoCloseTimer();
            });
        }
        onToggle('hiddenShowConfirmation', (checked) => {
            hidden.updateSettings({ showHideConfirmation: checked });
            localStorage.removeItem('je_hide_confirm_suppressed_until');
            resetAutoCloseTimer();
        });
        onToggle('hiddenExperimentalCollections', (checked) => {
            hidden.updateSettings({ experimentalHideCollections: checked });
            if (!checked) {
                hidden.removeLibraryHideButtons();
                hidden.addLibraryHideButtons();
            }
            resetAutoCloseTimer();
        });
        const manageBtn = document.getElementById('manageHiddenContentBtn');
        if (manageBtn) {
            manageBtn.addEventListener('click', () => {
                // Both the page and fallback modal take over from this dialog.
                ctx.closePanel();
                // Placed as a tab or Plugin Page, the page never opens over the current view: manage here instead.
                const config = JE.pluginConfig;
                const placed = config?.HiddenContentUseNativeTab || config?.HiddenContentUseCustomTabs || config?.HiddenContentUsePluginPages;
                if (config?.HiddenContentEnabled && JE.hiddenContentPage && !placed) {
                    JE.hiddenContentPage.showPage();
                } else {
                    hidden.showManagementPanel();
                }
            });
        }
    };
}

installUiPanelHiddenContent(panelHost());
