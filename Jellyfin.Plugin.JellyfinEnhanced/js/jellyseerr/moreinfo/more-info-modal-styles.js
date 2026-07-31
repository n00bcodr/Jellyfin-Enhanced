// @ts-check
// /js/jellyseerr/moreinfo/more-info-modal-styles.js
// CSS for the Jellyseerr more-info modal, injected once at load.
(function(JE) {
    'use strict';


// Add styles to the page (CSS text is verbatim from the pre-split module)
const css = `
        .je-more-info-modal {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0, 0, 0, 0.95);
            opacity: 0;
            transition: opacity 0.3s ease;
            overflow: hidden;
        }

        .je-more-info-modal.active {
            opacity: 1;
        }

        .je-more-info-modal .modal-overlay {
            width: 100%;
            height: 100%;
            overflow: hidden;
        }

        .je-more-info-modal .modal-container {
            position: relative;
            max-width: 70vw;
            max-height: 100%;
            width: 100%;
            height: 100%;
            margin: 0 auto;
            background: #0f172a;
            border-radius: 8px;
            overflow-y: auto;
            overflow-x: hidden;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.9);
            display: flex;
            flex-direction: column;
        }

        .layout-mobile .je-more-info-modal .modal-container {
            max-width: 100vw;
        }

        .je-more-info-modal .modal-container::-webkit-scrollbar {
            width: 8px;
        }

        .je-more-info-modal .modal-container::-webkit-scrollbar-track {
            background: rgba(255, 255, 255, 0.05);
        }

        .je-more-info-modal .modal-container::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.2);
            border-radius: 4px;
        }

        .je-more-info-modal .modal-container::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.3);
        }

        .je-more-info-modal .modal-refresh,
        .je-more-info-modal .modal-close {
            position: absolute;
            top: 1.5rem;
            background: rgba(0, 0, 0, 0.6);
            border: none;
            border-radius: 50%;
            color: white;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
            width: 40px;
            height: 40px;
            z-index: 100;
        }

        .je-more-info-modal .modal-refresh {
            right: 5.5rem;
        }

        .je-more-info-modal .modal-close {
            right: 1.5rem;
        }

        .je-more-info-modal .modal-refresh:hover:not(:disabled),
        .je-more-info-modal .modal-close:hover {
            background: rgba(0, 0, 0, 0.9);
            transform: scale(1.1);
        }

        .je-more-info-modal .modal-refresh:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }

        .je-more-info-modal .modal-refresh.loading svg {
            animation: spin 1.5s linear infinite;
        }

        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }

        .je-more-info-modal .modal-refresh svg,
        .je-more-info-modal .modal-close svg {
            width: 24px;
            height: 24px;
        }

        .je-more-info-modal .modal-backdrop {
            position: relative;
            height: 300px;
            background-size: cover;
            background-position: center calc(-50px);
            background-repeat: no-repeat;
            flex-shrink: 0;
        }

        .je-more-info-modal .je-modal-backdrop-overlay {
            position: absolute;
            inset: 0;
            background: linear-gradient(to bottom, transparent 0%, #0f172a 100%);
        }

        .je-more-info-modal .modal-content {
            position: relative;
            padding: 0 2rem 1.5rem;
            margin-top: -80px;
            color: white;
            flex: 1;
            overflow-y: auto;
            min-height: 0;
            max-width: 100%;
            box-sizing: border-box;
        }

        .je-more-info-modal .modal-main {
            display: grid;
            grid-template-columns: 1fr 380px;
            gap: 2rem;
            margin-bottom: 1rem;
            flex-shrink: 0;
        }

        .je-more-info-modal .modal-left {
            flex: 1;
            min-width: 0;
        }

        .je-more-info-modal .modal-right {
            width: 380px;
        }

        .je-more-info-modal .header-section {
            display: flex;
            gap: 1.5rem;
            margin-bottom: 1.5rem;
        }

        .je-more-info-modal .header-poster {
            width: 120px;
            flex-shrink: 0;
        }

        .je-more-info-modal .header-poster img {
            width: 100%;
            border-radius: 8px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
        }

        .je-more-info-modal .header-info {
            flex: 1;
        }

        .je-more-info-modal .title {
            font-size: 2.5rem;
            font-weight: 700;
            margin: 0 0 0.25rem;
            line-height: 1.2;
        }

        .je-more-info-modal .title-row {
            display: flex;
            align-items: center;
            gap: 0.65rem;
            flex-wrap: wrap;
        }

        .je-more-info-modal .title-chip {
            display: flex;
            align-items: center;
        }

        .je-more-info-modal .title-chip:empty {
            display: none;
        }

        .je-more-info-modal .year {
            font-weight: 400;
            opacity: 0.7;
            font-size: 2rem;
        }

        .je-more-info-modal .meta-info {
            display: flex;
            gap: 1rem;
            margin-bottom: 1rem;
            margin-top: 1rem;
            font-size: 1rem;
            align-items: center;
        }

        .je-more-info-modal .rating-badge {
            background: rgba(255, 255, 255, 0.1);
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-weight: 600;
        }

        .je-more-info-modal .runtime,
        .je-more-info-modal .genres {
            opacity: 0.8;
            width: fit-content;
        }

        .je-more-info-modal .tagline {
            font-size: 1rem;
            font-style: italic;
            opacity: 0.7;
            margin: 0;
        }

        .je-more-info-modal .je-requested-by:empty {
            display: none;
        }

        .je-more-info-modal .je-requested-by-row {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 0.4rem;
            font-size: 0.85rem;
            opacity: 0.85;
            margin-top: 0.3rem;
        }

        .je-more-info-modal .je-requested-by-label {
            opacity: 0.7;
        }

        .je-more-info-modal .je-requested-by-item {
            display: inline-flex;
            align-items: center;
            gap: 0.3rem;
        }

        .je-more-info-modal .je-request-avatar {
            width: 18px;
            height: 18px;
            border-radius: 50%;
            object-fit: cover;
        }

        .je-more-info-modal .je-more-info-actions {
            margin-top: 0.6rem;
            flex-direction: column;
            display: inline-flex;
            width: auto;
            position: relative;
            gap: 0;
            align-items: stretch;
            border-radius: 8px;
            overflow: hidden;
        }

        /* Quota chip in more-info modal — tighter spacing than the season modal. */
        .je-more-info-modal .je-more-info-quota-chip {
            margin: 0 0 0.5rem 0;
            font-size: 0.85rem;
            padding: 8px 12px;
            border-radius: 8px;
            order: -1;
        }

        .je-more-info-modal .je-downloads {
            margin-top: 0.45rem;
        }

        .je-more-info-actions-row {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 0.5rem;
        }

        .je-more-info-actions-column {
            display: flex;
            flex-direction: column;
            gap: 0.35rem;
            align-items: flex-start;
        }

        .je-more-info-button-group {
            display: inline-flex;
            align-items: stretch;
            border-radius: 8px;
            overflow: hidden;
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: rgba(255, 255, 255, 0.04);
        }

        .je-more-info-button-group .jellyseerr-request-button {
            border: none;
            background: transparent;
            padding: 0.5rem 0.9rem;
        }

        .je-more-info-button-group .jellyseerr-split-arrow {
            border: none;
            background: rgba(255, 255, 255, 0.08);
            padding: 0 0.55rem;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .je-status-chip {
            display: inline-flex;
            align-items: center;
            gap: 0.35rem;
            padding: 0.35rem 0.75rem;
            border-radius: 999px;
            font-weight: 700;
            letter-spacing: 0.02em;
            font-size: 0.85rem;
            text-transform: uppercase;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.12);
        }

        .je-status-chip.chip-available { background: rgba(34, 197, 94, 0.25); color: #f0f9ff; border-color: rgba(34, 197, 94, 0.5); }
        .je-status-chip.chip-partial { background: rgba(234, 179, 8, 0.25); color: #f0f9ff; border-color: rgba(234, 179, 8, 0.5); }
        .je-status-chip.chip-processing { background: rgba(59, 130, 246, 0.25); color: #f0f9ff; border-color: rgba(59, 130, 246, 0.5); }
        .je-status-chip.chip-requested { background: rgba(168, 85, 247, 0.25); color: #f0f9ff; border-color: rgba(168, 85, 247, 0.5); }
        .je-status-chip.chip-blocklisted { background: rgba(120, 53, 15, 0.25); color: #f0f9ff; border-color: rgba(120, 53, 15, 0.5); }
        .je-status-chip.chip-deleted { background: rgba(220, 38, 38, 0.22); color: #ffe4e6; border-color: rgba(248, 113, 113, 0.55); }

        .je-download-bars {
            display: flex;
            flex-direction: column;
            gap: 0.35rem;
            width: 100%;
            margin-top: 0.15rem;
            box-sizing: border-box;
            overflow: hidden;
        }

        .je-download-row {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 8px;
            padding: 0.5rem 0.75rem;
            box-sizing: border-box;
            min-width: 0;
            overflow: hidden;
            width: 100%;
        }

        .je-download-title {
            font-weight: 600;
            font-size: 0.9rem;
            margin-bottom: 0.2rem;
            word-break: break-word;
            white-space: normal;
        }

        .je-download-progress {
            position: relative;
            height: 6px;
            background: rgba(255, 255, 255, 0.08);
            border-radius: 999px;
            overflow: hidden;
        }

        .je-download-progress .fill {
            position: absolute;
            inset: 0;
            background: linear-gradient(90deg, #31bcd1, #4450df);
            border-radius: inherit;
        }

        .je-download-meta {
            display: flex;
            justify-content: space-between;
            gap: 0.35rem;
            font-size: 0.75rem;
            opacity: 0.75;
            margin-top: 0.25rem;
            flex-wrap: wrap;
            word-break: break-word;
        }

        .je-download-eta {
            margin-left: auto;
            color: #cbd5e1;
            opacity: 0.9;
            white-space: nowrap;
        }

        .je-4k-popup {
            position: fixed;
            z-index: 11000;
            background: #0b1223;
            color: #fff;
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 8px;
            padding: 0.25rem;
            min-width: 160px;
            box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
            opacity: 0;
            transform: translateY(-4px);
            transition: opacity 0.12s ease, transform 0.12s ease;
        }

        .je-4k-popup.show {
            opacity: 1;
            transform: translateY(0);
        }

        .je-4k-popup-item {
            width: 100%;
            background: transparent;
            border: none;
            color: #fff;
            padding: 0.45rem 0.65rem;
            text-align: left;
            font-weight: 600;
            border-radius: 6px;
            cursor: pointer;
        }

        .je-4k-popup-item:hover {
            background: rgba(255, 255, 255, 0.08);
        }

        /* Status-based popup colors matching button styles */
        .je-4k-popup-item.je-4k-request { background-color: #5a3fb8 !important; color: #fff !important; }
        .je-4k-popup-item.je-4k-pending { background-color: #b45309 !important; color: #fff !important; }
        .je-4k-popup-item.je-4k-processing { background-color: #581c87 !important; color: #fff !important; }
        .je-4k-popup-item.je-4k-blocklisted { background-color: #78350f !important; color: #fff !important; }
        .je-4k-popup-item.je-4k-available { background-color: #16a34a !important; color: #fff !important; }

        .je-more-info-modal .overview-section {
            margin-bottom: 1rem;
        }

        .je-more-info-modal .overview-section h3 {
            font-size: 1.3rem;
            margin: 0 0 0.5rem;
            font-weight: 600;
        }

        .je-more-info-modal .overview-section p {
            line-height: 1.6;
            opacity: 0.85;
            font-size: 1rem;
        }

        .je-more-info-modal .crew-section {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 1rem;
            margin-bottom: 2rem;
        }

        .je-more-info-modal .crew-item,
        .je-more-info-modal .creators {
            margin-bottom: 1rem;
        }

        .je-more-info-modal .crew-item h4,
        .je-more-info-modal .creators h4 {
            font-size: 0.85rem;
            opacity: 0.6;
            margin: 0 0 0.25rem;
            text-transform: uppercase;
            font-weight: 600;
        }

        .je-more-info-modal .crew-item p,
        .je-more-info-modal .creators p {
            margin: 0;
            font-size: 1rem;
            line-height: 1.3;
        }

        .je-more-info-modal .keywords-section {
            margin: 1.5rem 0 0.75rem;
            display: block;
        }

        .je-more-info-modal .keywords-section h3 {
            font-size: 1.1rem;
            margin: 0 0 0.6rem;
            font-weight: 600;
        }

        .je-more-info-modal .keywords-grid {
            display: flex;
            flex-wrap: wrap;
            gap: 0.5rem;
        }

        .je-more-info-modal .keyword {
            display: inline-block;
            padding: 0.3rem 0.6rem;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 20px;
            font-size: 0.75rem;
        }

        .je-more-info-modal .cast-section {
            margin-bottom: 2rem;
            margin-top: 2rem;
        }

        .je-more-info-modal .cast-section h3 {
            font-size: 1.3rem;
            font-weight: 600;
            margin: 0 0 1rem;
        }

        .je-more-info-modal .cast-scroll {
            display: flex;
            gap: 1.5rem;
            overflow-x: auto;
            overflow-y: hidden;
            padding-bottom: 0.75rem;
            margin-bottom: 0;
            width: 100%;
            scrollbar-width: none;
            -webkit-overflow-scrolling: touch;
        }

        .je-more-info-modal .cast-scroll::-webkit-scrollbar {
            display: none;
        }

        .je-more-info-modal .cast-member {
            flex: 0 0 auto;
            text-align: center;
            width: 80px;
        }

        .je-more-info-modal .person-avatar {
            width: 6rem;
            height: 6rem;
            border-radius: 50%;
            overflow: hidden;
            background: rgba(255, 255, 255, 0.1);
            margin: 0 auto 0.4rem;
            border: 1px solid rgba(255, 255, 255, 0.15);
        }

        .je-more-info-modal .person-avatar img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }

        .je-more-info-modal .person-name {
            font-weight: 600;
            font-size: 0.85rem;
            margin-bottom: 0.15rem;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .je-more-info-modal .person-character {
            font-size: 0.75rem;
            opacity: 0.6;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .je-more-info-modal .trailers-section {
            margin-bottom: 1rem;
        }

        .je-more-info-modal .trailers-section h3 {
            font-size: 1.3rem;
            margin: 0 0 0.75rem;
            font-weight: 600;
        }

        .je-more-info-modal .trailers-grid {
            display: flex;
            gap: 1rem;
            overflow-x: auto;
            overflow-y: hidden;
            padding-bottom: 0.75rem;
            margin-bottom: 0;
            width: 100%;
            scrollbar-width: none;
            -webkit-overflow-scrolling: touch;
        }

        .je-more-info-modal .trailers-grid::-webkit-scrollbar {
            display: none;
        }

        .je-more-info-modal .trailer-item {
            flex: 0 0 auto;
            width: 200px;
            cursor: pointer;
            border-radius: 6px;
            overflow: hidden;
            transition: transform 0.2s;
            background: rgba(0, 0, 0, 0.2);
            border: 1px solid rgba(255, 255, 255, 0.1);
            text-decoration: none;
            display: block;
            color: inherit;
        }

        .je-more-info-modal .trailer-item:hover {
            transform: translateY(-3px);
        }

        .je-more-info-modal .trailer-thumbnail {
            position: relative;
            aspect-ratio: 16/9;
            background: #000;
        }

        .je-more-info-modal .trailer-thumbnail img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }

        .je-more-info-modal .je-modal-play-button {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 50px;
            height: 50px;
            background: rgba(255, 255, 255, 0.9);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #000;
            transition: transform 0.2s;
        }

        .je-more-info-modal .trailer-item:hover .je-modal-play-button {
            transform: translate(-50%, -50%) scale(1.1);
        }

        .je-more-info-modal .je-modal-play-button svg {
            width: 25px;
            height: 25px;
            margin-left: 2px;
        }

        .je-more-info-modal .trailer-info {
            padding: 0.5rem;
        }

        .je-more-info-modal .trailer-name {
            font-weight: 600;
            font-size: 0.9rem;
            margin-bottom: 0.15rem;
        }

        .je-more-info-modal .trailer-type {
            font-size: 0.8rem;
        }

        .je-more-info-modal .trailer-youtube-icon {
            position: absolute;
            top: 5px;
            right: 5px;
            width: 28px !important;
            height: 28px !important;
            padding: 3px;
            z-index: 10;
            opacity: 0.7;
        }

        .je-more-info-modal .stats-section {
            margin-bottom: 1rem;
        }

        .je-more-info-modal .stats-section h3 {
            font-size: 1rem;
            margin: 0 0 0.75rem;
        }

        .je-more-info-modal .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
            gap: 0.75rem;
        }

        .je-more-info-modal .stat-item {
            background: rgba(255, 255, 255, 0.08);
            padding: 0.75rem;
            border-radius: 6px;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .je-more-info-modal .seasons-section {
            margin-bottom: 2rem;
        }

        .je-more-info-modal .seasons-section h3 {
            font-size: 1.3rem;
            margin: 0 0 0.75rem;
            font-weight: 600;
        }

        .je-more-info-right-panel {
            position: sticky;
            top: 1rem;
            max-height: calc(100vh - 2rem);
            overflow-y: auto;
        }

        .je-more-info-ratings-row {
            display: flex;
            flex-wrap: wrap;
            justify-content: flex-end;
            gap: 1rem;
            padding-bottom: 1rem;
        }

        .je-more-info-rating-badge-item {
            display: flex;
            align-items: center;
            gap: 0.4rem;
            padding: 0.75rem;
            text-align: center;
            text-decoration: none;
            color: white;
            transition: all 0.2s;
        }

        .je-more-info-rating-badge-item:hover {
            transform: translateY(-2px);
        }

        /* Reset emby-linkbutton styling for all external links in the modal */
        .je-more-info-modal a[is="emby-linkbutton"] {
            padding: 0 !important;
            margin: 0 !important;
        }

        .je-more-info-rating-icon {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 2.5rem;
            height: 2.5rem;
            font-size: 0.8rem;
        }
        /* Safari/WebKit: inline SVGs with only viewBox (no width/height attrs) collapse
           to 0×0 inside a flex container because the browser cannot infer aspect ratio.
           Force them to fill the icon container on all platforms. */
        .je-more-info-rating-icon svg {
            display: block;
            width: 100%;
            height: 100%;
        }
        .je-more-info-rating-percent {
            font-size: .9rem;
            font-weight: 500;
        }

        .je-more-info-rating-score {
            font-size: .9rem;
            font-weight: 500;
        }

        .je-more-info-media-ratings {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.9rem;
            flex-wrap: wrap;
        }

        /* Ratings skeleton */
        .je-more-info-ratings-skeleton {
            display: flex;
            width: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.9rem;
            flex-wrap: wrap;
        }
        .je-skel-badge {
            display: inline-block;
            height: 28px;
            width: 56px;
            border-radius: 999px;
            background: linear-gradient(90deg, rgba(255,255,255,0.06) 25%, rgba(255,255,255,0.14) 37%, rgba(255,255,255,0.06) 63%);
            background-size: 400% 100%;
            animation: je-skel-shimmer 1.2s ease-in-out infinite;
        }
        @keyframes je-skel-shimmer {
            0% { background-position: 100% 0; }
            100% { background-position: 0 0; }
        }

        .je-more-info-ratings-cell {
            display: flex;
            justify-content: flex-end;
        }

        /* Collection Card (Jellyseerr-style) */
        .je-collection-card {
            position: relative;
            z-index: 0;
            cursor: pointer;
            overflow: hidden;
            border-radius: 8px;
            background: #1f2937;
            background-size: cover;
            background-position: center;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.08);
            transition: all 0.3s duration;
            margin-bottom: 1rem;
        }

        .je-collection-card:hover {
            border-color: rgba(255, 255, 255, 0.15);
            box-shadow: 0 8px 12px rgba(0, 0, 0, 0.2);
        }

        .je-collection-card-backdrop {
            position: absolute;
            inset: 0;
            z-index: 0;
            overflow: hidden;
        }

        .je-collection-card-backdrop img {
            position: absolute;
            height: 100%;
            width: 100%;
            inset: 0;
            object-fit: cover;
            color: transparent;
        }

        .je-collection-card-overlay {
            position: absolute;
            inset: 0;
            background-image: linear-gradient(rgba(31, 41, 55, 0.47) 0%, rgba(31, 41, 55, 0.8) 100%);
        }

        .je-collection-card-content {
            position: relative;
            z-index: 10;
            display: flex;
            height: 100%;
            align-items: center;
            justify-content: space-between;
            padding: 1rem;
            color: #e5e7eb;
            transition: all 0.3s duration;
        }

        .je-collection-card:hover .je-collection-card-content {
            color: #ffffff;
        }

        .je-collection-card-title {
            font-weight: 600;
            font-size: 1rem;
            flex: 1;
        }

        .je-collection-card-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            border: 1px solid rgba(255, 255, 255, 0.25);
            font-weight: 500;
            border-radius: 4px;
            outline: none;
            transition: all 0.15s ease-in-out;
            cursor: pointer;
            color: #e5e7eb;
            background: rgba(31, 41, 55, 0.8);
            border-color: rgba(107, 114, 128, 0.7);
            padding: 0.375rem 0.625rem;
            font-size: 0.875rem;
            white-space: nowrap;
            margin-left: 0.75rem;
            flex-shrink: 0;
        }

        .je-collection-card:hover .je-collection-card-button {
            color: #ffffff;
            background: rgba(55, 65, 81, 0.9);
            border-color: rgba(107, 114, 128, 0.9);
        }

        .je-collection-card-button:active {
            color: #e5e7eb;
            background: rgba(55, 65, 81, 0.8);
            border-color: rgba(107, 114, 128, 0.7);
        }

        .je-more-info-media-facts {
            margin-top: 1rem;
        }

        .je-more-info-media-facts-row {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.9rem;
            flex-wrap: wrap;
        }

        .je-more-info-media-facts-row a {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 2.5rem;
            height: 2.5rem;
            opacity: 0.75;
            transition: transform 0.15s ease, opacity 0.15s ease, background 0.15s ease, border-color 0.15s ease;
        }

        .je-more-info-media-facts-row a:hover {
            opacity: 1;
            transform: translateY(-2px);
        }

        .je-more-info-media-facts-row svg {
            width: 100%;
            height: 100%;
        }

        .je-more-info-stats-panel {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 8px;
            padding: 1.5rem;
        }

        .je-more-info-stat-row {
            display: grid;
            align-items: center;
            grid-template-columns: auto 1fr;
            gap: 1rem;
            padding-bottom: .5rem;
            padding-top: .5rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }

        .je-more-info-stat-row:last-child {
            border-bottom: none;
            padding-bottom: 0;
        }

        .je-more-info-stat-label {
            font-size: 0.8rem;
            opacity: 0.6;
            text-transform: uppercase;
            font-weight: 600;
        }

        .je-more-info-stat-value {
            font-size: 1rem;
            line-height: 1.4;
            text-align: end;
            word-break: break-word;
        }

        .je-more-info-providers-list {
            display: flex;
            gap: 0.5rem;
            flex-wrap: wrap;
            justify-content: flex-end;
        }

        .je-more-info-providers-list img {
            width: 30px;
            height: 30px;
            border-radius: 4px;
            object-fit: cover;
        }

        .je-more-info-modal .seasons-grid {
            display: flex;
            flex-direction: column;
            gap: 1rem;
            margin-top: 1rem;
        }

        .je-more-info-modal .season-card {
            display: flex;
            gap: 1rem;
            background: rgba(0, 0, 0, 0.2);
            border-radius: 6px;
            overflow: hidden;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .je-more-info-modal .season-poster {
            width: 70px;
            flex-shrink: 0;
        }

        .je-more-info-modal .season-poster img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }

        .je-more-info-modal .season-info {
            padding: 0.75rem;
            flex: 1;
        }

        .je-more-info-modal .season-name {
            font-size: 0.95rem;
            font-weight: 600;
            margin-bottom: 0.35rem;
        }

        .je-more-info-modal .season-meta {
            font-size: 0.8rem;
            opacity: 0.6;
            margin-bottom: 0.5rem;
        }

        .je-more-info-modal .season-overview {
            font-size: 0.85rem;
            line-height: 1.4;
            opacity: 0.8;
        }

        .je-more-info-modal .season-links {
            display: flex;
            flex-wrap: wrap;
            gap: 0.45rem;
            margin-bottom: 0.55rem;
        }

        .je-more-info-modal a[is="emby-linkbutton"].season-link-chip {
            display: inline-flex;
            align-items: center;
            border-radius: 999px;
            border: 1px solid rgba(255, 255, 255, 0.2) !important;
            padding: 0.2rem 0.6rem !important;
            font-size: 0.74rem;
            font-weight: 600;
            line-height: 1;
            color: #e5e7eb !important;
            text-decoration: none;
            background: rgba(255, 255, 255, 0.06) !important;
        }

        .je-more-info-modal a[is="emby-linkbutton"].season-link-chip.available {
            color: #9af5c6 !important;
            border-color: rgba(44, 194, 129, 0.45) !important;
            background: rgba(44, 194, 129, 0.16) !important;
        }

        .je-more-info-modal a[is="emby-linkbutton"].season-link-chip.available-4k {
            color: #b5d8ff !important;
            border-color: rgba(70, 142, 255, 0.45) !important;
            background: rgba(70, 142, 255, 0.16) !important;
        }

        .je-more-info-modal a[is="emby-linkbutton"].season-link-chip:hover {
            filter: brightness(1.08);
            transform: translateY(-1px);
        }

        @media (max-width: 1024px) {
            .je-more-info-modal .modal-main {
                grid-template-columns: 1fr;
            }

            .je-more-info-modal .modal-right {
                width: 100%;
            }

            .je-more-info-right-panel {
                position: static;
                max-height: none;
            }
        }

        @media (max-width: 768px) {
            .je-more-info-modal .modal-backdrop {
                height: 200px;
                background-position: center;
            }

            .je-more-info-modal .modal-content {
                padding: 0 1rem 1rem;
                margin-top: -60px;
            }

            .je-more-info-modal .header-section {
                gap: 1rem;
                margin-bottom: 1.5rem;
            }

            .je-more-info-modal .header-poster {
                width: 120px;
            }

            .je-more-info-modal .title {
                font-size: 1.75rem;
            }

            .je-more-info-modal .crew-section {
                grid-template-columns: 1fr;
                gap: 1rem;
            }

            .je-more-info-modal .trailers-grid {
                gap: 1rem;
            }

            .je-more-info-modal .trailer-item {
                width: 180px;
            }

            .je-more-info-ratings-row {
                justify-content: flex-start;
            }

            /* Mobile optimizations for download bars */
            .je-download-bars {
                gap: 0.25rem;
            }

            .je-download-row {
                padding: 0.4rem 0.6rem;
                width: 100%;
            }

            .je-download-title {
                font-size: 0.8rem;
                word-break: break-word;
            }

            .je-download-meta {
                font-size: 0.65rem;
                gap: 0.25rem;
            }
        }
    `;

    // Inject styles when module loads
    JE.core.ui.injectCss('je-more-info-modal-styles', css);

})(window.JellyfinEnhanced);
