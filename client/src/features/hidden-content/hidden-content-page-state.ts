import { installOnce, onDispose, selectionLease, enqueueWrite, pendingWrites } from './host';
import { lease } from './host';
import { record, decodeLibraryItem, decodeSeerrItem, decodeSeerrSearch, type HiddenItem, type ListedItem } from './model';
import type { PageState, Group, SearchResult, PageSurface } from './page-model';
import { host, registry, type HiddenHost } from './host';
/**
 * @file Hidden Content Page — shared page state, scope-label helpers, and the
 * styled unhide-confirmation dialog.
 * Split from hidden-content-page.js (code motion; bodies verbatim). Loads
 * first: owns the state object and parse-time sidebar/Plugin-Pages detection
 * that every other hidden-content-page-* module reads.
 */
(function () {
    if(!installOnce(host.JellyfinEnhanced,'hidden-content-page-state'))return;
  "use strict";

  const JE = host.JellyfinEnhanced;
  const internal = registry(JE, 'hiddenContentPage');

  const sidebar = document.querySelector('.mainDrawer-scrollContainer');
  const pluginPagesExists = !!sidebar?.querySelector<HTMLElement>(
    'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.HiddenContentPage"]'
  );

  // ============================================================
  // State
  // ============================================================

  const state: PageState = {
    pageVisible: false,
    previousPage: null,
    searchQuery: '',
    scopedOnly: false,
    locationSignature: null,
    locationTimer: null,
    _customTabContainer: null,
    // Admin cross-user view: an admin can view another user's hidden content
    // read-only via a toolbar dropdown. All of these stay inert/empty for non-admins.
    adminIsAdmin: null,          // tri-state: null = not yet resolved, then true/false (false only when authoritative)
    adminUsers: null,            // cached dropdown list: [{ userId, userName, count }]; null = needs (re)fetch
    adminUsersLoading: false,    // guards against concurrent user-list fetches
    selectedAdminUserId: null,   // null = viewing own list; otherwise the target user's N-id
    adminEditMode: false,        // when viewing another user, allow editing (unhiding) their items
    adminUserName: '',           // display name of the selected user (for the header badge)
    adminItems: null,            // cached hidden items for the selected user
    adminItemsUserId: null,      // which user adminItems belongs to (guards against showing stale items)
    adminLoadError: false,       // true when the selected user's items failed to load (vs genuinely empty)
    adminLoadToken: 0,           // increments per fetch so stale responses are ignored
  };

  // The admin gate and the cross-user view are resolved for the signed-in
  // user; after a user switch the new user must re-resolve (a non-admin must
  // never inherit an admin's cached gate, and vice versa).
  host.JellyfinEnhanced.session?.onUserChange('hidden-content-page', () => {
    state._customTabContainer?.replaceChildren();
    document.querySelectorAll('#je-hidden-content-container,#je-hidden-content-container-tab').forEach(el=>el.replaceChildren());
    state.searchQuery='';state.scopedOnly=false;
    state.adminIsAdmin = null;
    state.adminUsers = null;
    state.adminUsersLoading = false;
    state.selectedAdminUserId = null;
    state.adminEditMode = false;
    state.adminUserName = '';
    state.adminItems = null;
    state.adminItemsUserId = null;
    state.adminLoadError = false;
    state.adminLoadToken++; // in-flight admin fetches see a stale token and drop their result
  });

  function scopeBadgeText(scope?: string) {
    const s = (scope || '').toLowerCase();
    if (s === 'continuewatching') return JE.t('hidden_content_scope_cw_label');
    if (s === 'nextup')           return JE.t('hidden_content_scope_nextup_label');
    if (s === 'homesections')     return JE.t('hidden_content_scope_homesections_label');
    return '';
  }

  function scopeUnhideText(scope?: string) {
    if ((scope || '').toLowerCase() === 'continuewatching') {
      return JE.t('hidden_content_add_back_to_cw');
    }
    return JE.t('hidden_content_unhide');
  }

  /** Max poster width when loading images. */
  const POSTER_MAX_WIDTH = 300;

  /**
   * Shows a styled confirmation dialog matching the hide-confirm style.
   * Used for unhide confirmations to provide visual consistency.
   * @param {string} message The confirmation heading to display.
   * @param {Function} onConfirm Called when user confirms.
   * @param {string} [itemName] Optional item name to show below the heading.
   */
  function showUnhideConfirmation(message: string, onConfirm: () => void, itemName?: string) {
    const token=selectionLease(JE);
    const originalConfirm=onConfirm;onConfirm=()=>{if(token.current())originalConfirm();};
    document.querySelector('.je-hide-confirm-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'je-hide-confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'je-hide-confirm-dialog';

    const title = document.createElement('h3');
    title.textContent = message;
    dialog.appendChild(title);

    if (itemName) {
      const body = document.createElement('p');
      body.textContent = itemName;
      dialog.appendChild(body);
    }

    const closeDialog = () => {
            release();
      overlay.remove();
      document.removeEventListener('keydown', escHandler);
    };

    const buttons = document.createElement('div');
    buttons.className = 'je-hide-confirm-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'je-hide-confirm-cancel';
    cancelBtn.textContent = JE.t('hidden_content_confirm_cancel') || 'Cancel';
    cancelBtn.addEventListener('click', closeDialog);
    buttons.appendChild(cancelBtn);

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'je-hide-confirm-hide';
    confirmBtn.textContent = JE.t('hidden_content_unhide') || 'Unhide';
    confirmBtn.addEventListener('click', () => {
      closeDialog();
      onConfirm();
    });
    buttons.appendChild(confirmBtn);

    dialog.appendChild(buttons);
    overlay.appendChild(dialog);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeDialog();
    });

    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDialog();
    };
    document.addEventListener('keydown', escHandler);

    const release=onDispose(JE,closeDialog);
        document.body.appendChild(overlay);
  }

  Object.assign(internal, {
    state,
    sidebar,
    pluginPagesExists,
    scopeBadgeText,
    scopeUnhideText,
    POSTER_MAX_WIDTH,
    showUnhideConfirmation,
  });

})();
