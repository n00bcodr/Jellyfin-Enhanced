import { seerrCoreHost } from '../../host-core';
import { firstInstall } from '../runtime';
import { MAIN_CSS, MAIN_STYLE_ID, SEASON_MODAL_CSS, SEASON_MODAL_STYLE_ID } from './styles-css';

const { JE, document } = seerrCoreHost();
/** Adds a stylesheet once; an existing element with the id is left as it is. */
function addStyle(id: string, css: string): void {
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
}
if (firstInstall(JE, 'ui-styles')) {
    const ui = JE.jellyseerrUI ||= {};
    ui.addMainStyles = () => addStyle(MAIN_STYLE_ID, MAIN_CSS);
    ui.addSeasonModalStyles = () => addStyle(SEASON_MODAL_STYLE_ID, SEASON_MODAL_CSS);
    // Injected at load so every Seerr surface (item details, discovery, issue
    // reporter) is styled whether or not the search integration is enabled.
    ui.addMainStyles();
    ui.addSeasonModalStyles();
}
