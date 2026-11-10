# seerr

Seerr (Jellyseerr) integration: the API client and UI core (`core/`), item details and more-info modal (`details/`), discovery rows (`discovery/`) and recommendations (`recommendations/`).

Owner: Jellyfin Enhanced maintainers. Backend counterpart: `Features/Seerr/` (PLAN.md canonical feature list).

## Entry points → shipped files

Sources are relative to this folder; outputs are relative to `Jellyfin.Plugin.JellyfinEnhanced/` and declared in `client/entries/seerr-core.json`, `client/entries/seerr-details.json`, `client/entries/discovery-recommendations.json`. Load position is the 1-based index among the scripts in `js/component-scripts.json` (`–` = not in that list; loaded by its page or another script). `tests/frontend/architecture/feature-readme.test.mjs` checks this table against `client/generated-manifest.json`: update it whenever an entry source moves or an output is added.

| source | output | load position |
|---|---|---|
| `core/api-entry.ts` | `js/jellyseerr/api.js` | 99 |
| `core/modal-entry.ts` | `js/jellyseerr/modal.js` | 111 |
| `core/request-manager-entry.ts` | `js/jellyseerr/request-manager.js` | 98 |
| `core/search-entry.ts` | `js/jellyseerr/jellyseerr.js` | 100 |
| `core/status-entry.ts` | `js/jellyseerr/seerr-status.js` | 97 |
| `core/ui/badges-entry.ts` | `js/jellyseerr/ui/ui-badges.js` | 104 |
| `core/ui/buttons-entry.ts` | `js/jellyseerr/ui/ui-buttons.js` | 106 |
| `core/ui/cards-entry.ts` | `js/jellyseerr/ui/ui-cards.js` | 105 |
| `core/ui/icons-entry.ts` | `js/jellyseerr/ui/ui-icons.js` | 101 |
| `core/ui/popover-entry.ts` | `js/jellyseerr/ui/ui-popover.js` | 103 |
| `core/ui/quota-entry.ts` | `js/jellyseerr/ui/ui-quota.js` | 107 |
| `core/ui/request-modals-entry.ts` | `js/jellyseerr/ui/ui-request-modals.js` | 109 |
| `core/ui/results-entry.ts` | `js/jellyseerr/ui/ui-results.js` | 108 |
| `core/ui/season-modal-entry.ts` | `js/jellyseerr/ui/ui-season-modal.js` | 110 |
| `core/ui/styles-entry.ts` | `js/jellyseerr/ui/ui-styles.js` | 102 |
| `details/details-page/item-details-entry.ts` | `js/jellyseerr/item-details.js` | 122 |
| `details/hss-discovery-entry.ts` | `js/jellyseerr/hss-discovery-handler.js` | 121 |
| `details/issues/issue-reporter-entry.ts` | `js/jellyseerr/issue-reporter.js` | 123 |
| `details/moreinfo/actions-entry.ts` | `js/jellyseerr/moreinfo/more-info-modal-actions.js` | 118 |
| `details/moreinfo/actions-tv-entry.ts` | `js/jellyseerr/moreinfo/more-info-modal-actions-tv.js` | 117 |
| `details/moreinfo/badges-entry.ts` | `js/jellyseerr/moreinfo/more-info-modal-badges.js` | 115 |
| `details/moreinfo/data-entry.ts` | `js/jellyseerr/moreinfo/more-info-modal-data.js` | 113 |
| `details/moreinfo/init-entry.ts` | `js/jellyseerr/moreinfo/more-info-modal-init.js` | 119 |
| `details/moreinfo/render-entry.ts` | `js/jellyseerr/moreinfo/more-info-modal-render.js` | 116 |
| `details/moreinfo/seasons-entry.ts` | `js/jellyseerr/moreinfo/more-info-modal-seasons.js` | 114 |
| `details/moreinfo/styles-entry.ts` | `js/jellyseerr/moreinfo/more-info-modal-styles.js` | 112 |
| `details/scroll/seamless-scroll-entry.ts` | `js/jellyseerr/seamless-scroll.js` | 124 |
| `details/seerr-detail-link-entry.ts` | `js/jellyseerr/seerr-detail-link.js` | 120 |
| `discovery/collection-discovery.ts` | `js/jellyseerr/discovery/collection-discovery.js` | 131 |
| `discovery/discovery-base.ts` | `js/jellyseerr/discovery/discovery-base.js` | 126 |
| `discovery/discovery-filter-utils.ts` | `js/jellyseerr/discovery/discovery-filter-utils.js` | 125 |
| `discovery/genre-discovery.ts` | `js/jellyseerr/discovery/genre-discovery.js` | 129 |
| `discovery/network-discovery.ts` | `js/jellyseerr/discovery/network-discovery.js` | 127 |
| `discovery/person-discovery.ts` | `js/jellyseerr/discovery/person-discovery.js` | 128 |
| `discovery/tag-discovery.ts` | `js/jellyseerr/discovery/tag-discovery.js` | 130 |
| `recommendations/recommendations-catalog.ts` | `js/jellyseerr/recommendations/recommendations-catalog.js` | 133 |
| `recommendations/recommendations-category.ts` | `js/jellyseerr/recommendations/recommendations-category.js` | 137 |
| `recommendations/recommendations-custom-tab.ts` | `js/jellyseerr/recommendations/recommendations-custom-tab.js` | 139 |
| `recommendations/recommendations-data.ts` | `js/jellyseerr/recommendations/recommendations-data.js` | 134 |
| `recommendations/recommendations-init.ts` | `js/jellyseerr/recommendations/recommendations-init.js` | 138 |
| `recommendations/recommendations-page.ts` | `js/jellyseerr/recommendations/recommendations-page.js` | 136 |
| `recommendations/recommendations-render.ts` | `js/jellyseerr/recommendations/recommendations-render.js` | 135 |
| `recommendations/recommendations-styles.ts` | `js/jellyseerr/recommendations/recommendations-styles.js` | 132 |

## Public API and global slots

`public-api.ts` is the only module another feature may import, and only with `import type` (feature-boundaries rule 1). It holds types only, no runtime code.

- Facades this feature publishes on `window.JellyfinEnhanced`: `jellyseerrAPI`, `jellyseerrUI`, `jellyseerrMoreInfo`, `requestManager`, `discoveryFilter`, `seamlessScroll`.
- `JE.internals` slots it owns (`tests/frontend/architecture/internals-owners.json`): `jellyseerrUi`, `moreInfoModal`, `recommendationsPage`.

## Settings / admin UI

None in this folder. Any toggles are in the settings-panel shell (`settings-panel/ui-panel-settings.ts`) until step A5 moves them into per-feature `settings/` sections.

## Tests

```bash
node --test tests/frontend/pages/pages-seerr-*.test.mjs tests/frontend/pages/pages-{moreinfo,scroll}.test.mjs tests/frontend/pages/pages-{discovery,recommendations}*.test.mjs tests/frontend/requests/*.test.mjs tests/frontend/features/spoiler-guard/features-seerr-spoiler-guard.test.mjs
```

[`docs/feature-map.json`](../../../../docs/feature-map.json) lists this feature's test folders. `npm test` runs them all.

## Generated files here (do not edit)

None.
