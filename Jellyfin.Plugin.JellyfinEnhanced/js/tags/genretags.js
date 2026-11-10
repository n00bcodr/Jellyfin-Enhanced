(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/generated-shared/stub/client/src/features/media-tags/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/media-tags/host");
  var export4 = /* @__PURE__ */ sharedExport(shared, "tagRuntimeHost");

  // client/generated-shared/stub/client/src/features/media-tags/pipeline/dto.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/media-tags/pipeline/dto");
  var export6 = /* @__PURE__ */ sharedExport(shared2, "memberText");
  var export7 = /* @__PURE__ */ sharedExport(shared2, "members");
  var export10 = /* @__PURE__ */ sharedExport(shared2, "record");

  // client/src/features/media-tags/types/genre/genre-table.ts
  var tables = /* @__PURE__ */ (() => {
    const genreIconMap2 = {
      // Default
      "default": "theaters",
      // English
      "action": "sports_martial_arts",
      "adventure": "explore",
      "animation": "animation",
      "comedy": "mood",
      "crime": "local_police",
      "documentary": "article",
      "drama": "theater_comedy",
      "family": "family_restroom",
      "fantasy": "auto_awesome",
      "history": "history_edu",
      "horror": "skull",
      "music": "music_note",
      "mystery": "psychology_alt",
      "romance": "favorite",
      "science fiction": "science",
      "sci-fi": "science",
      "tv movie": "tv",
      "thriller": "psychology",
      "war": "military_tech",
      "western": "landscape",
      "superhero": "domino_mask",
      "musical": "music_video",
      "biography": "menu_book",
      "sport": "sports_soccer",
      "game-show": "quiz",
      "reality-tv": "live_tv",
      // French (fr)
      "aventure": "explore",
      "comédie": "mood",
      "drame": "theater_comedy",
      "fantastique": "auto_awesome",
      "histoire": "history_edu",
      "horreur": "skull",
      "musique": "music_note",
      "mystère": "psychology_alt",
      "science-fiction": "science",
      "téléfilm": "tv",
      "guerre": "military_tech",
      "comédie musicale": "music_video",
      "biographie": "menu_book",
      "familial": "family_restroom",
      "historique": "history_edu",
      "jeu-concours": "quiz",
      "télé-réalité": "live_tv",
      // Spanish (es)
      "acción": "sports_martial_arts",
      "aventura": "explore",
      "animación": "animation",
      "comedia": "mood",
      "crimen": "local_police",
      "documental": "article",
      "familiar": "family_restroom",
      "fantasía": "auto_awesome",
      "historia": "history_edu",
      "terror": "skull",
      "música": "music_note",
      "misterio": "psychology_alt",
      "ciencia ficción": "science",
      "película de tv": "tv",
      "suspense": "psychology",
      "bélica": "military_tech",
      "superhéroes": "domino_mask",
      "biografía": "menu_book",
      "deporte": "sports_soccer",
      "concurso": "quiz",
      "telerrealidad": "live_tv",
      // German (de)
      "abenteuer": "explore",
      "komödie": "mood",
      "krimi": "local_police",
      "dokumentarfilm": "article",
      "familienfilm": "family_restroom",
      "geschichte": "history_edu",
      "kriegsfilm": "military_tech",
      "musikfilm": "music_video",
      "liebesfilm": "favorite",
      "fernsehfilm": "tv",
      "spielshow": "quiz",
      // Italian (it)
      "azione": "sports_martial_arts",
      "avventura": "explore",
      "animazione": "animation",
      "commedia": "mood",
      "crimine": "local_police",
      "documentario": "article",
      "drammatico": "theater_comedy",
      "famiglia": "family_restroom",
      "fantastico": "auto_awesome",
      "storico": "history_edu",
      "orrore": "skull",
      "musica": "music_note",
      "mistero": "psychology_alt",
      "romantico": "favorite",
      "fantascienza": "science",
      "film per la tv": "tv",
      "guerra": "military_tech",
      "biografico": "menu_book",
      "sportivo": "sports_soccer",
      "game show": "quiz",
      "reality tv": "live_tv",
      // Danish (da)
      "eventyr": "explore",
      "komedie": "mood",
      "dokumentar": "article",
      "familie": "family_restroom",
      "historie": "history_edu",
      "gyser": "skull",
      "musik": "music_note",
      "mysterie": "psychology_alt",
      "romantik": "favorite",
      "krig": "military_tech",
      "tv-film": "tv",
      "spilshow": "quiz",
      // Swedish (sv)
      "äventyr": "explore",
      "komedi": "mood",
      "brott": "local_police",
      "dokumentär": "article",
      "familj": "family_restroom",
      "skräck": "skull",
      "mysterium": "psychology_alt",
      "krigs": "military_tech",
      "spelshow": "quiz",
      // Hungarian (hu)
      "akció": "sports_martial_arts",
      "kaland": "explore",
      "animációs": "animation",
      "vígjáték": "mood",
      "bűnügyi": "local_police",
      "dokumentum": "article",
      "dráma": "theater_comedy",
      "családi": "family_restroom",
      "történelmi": "history_edu",
      "zenei": "music_note",
      "misztikus": "psychology_alt",
      "romantikus": "favorite",
      "tv film": "tv",
      "háborús": "military_tech",
      "életrajzi": "menu_book",
      "játékshow": "quiz",
      "valóság-tv": "live_tv",
      // Russian (ru)
      "боевик": "sports_martial_arts",
      "приключения": "explore",
      "мультфильм": "animation",
      "комедия": "mood",
      "криминал": "local_police",
      "документальный": "article",
      "драма": "theater_comedy",
      "семейный": "family_restroom",
      "фэнтези": "auto_awesome",
      "история": "history_edu",
      "ужасы": "skull",
      "музыка": "music_note",
      "детектив": "psychology_alt",
      "мелодрама": "favorite",
      "фантастика": "science",
      "НФ и Фэнтези": "science",
      "телевизионный фильм": "tv",
      "триллер": "psychology",
      "военный": "military_tech",
      "вестерн": "landscape",
      "реалити-шоу": "live_tv"
    };
    const genreLabelOfIcon2 = {
      "sports_martial_arts": "action",
      "explore": "adventure",
      "animation": "animation",
      "mood": "comedy",
      "local_police": "crime",
      "article": "documentary",
      "theater_comedy": "drama",
      "family_restroom": "family",
      "auto_awesome": "fantasy",
      "history_edu": "history",
      "skull": "horror",
      "music_note": "music",
      "psychology_alt": "mystery",
      "favorite": "romance",
      "science": "science fiction",
      "tv": "tv movie",
      "psychology": "thriller",
      "military_tech": "war",
      "landscape": "western",
      "domino_mask": "superhero",
      "music_video": "musical",
      "menu_book": "biography",
      "sports_soccer": "sport",
      "quiz": "game-show",
      "live_tv": "reality-tv"
    };
    const genreOtherLabel2 = "other";
    return { genreIconMap: genreIconMap2, genreLabelOfIcon: genreLabelOfIcon2, genreOtherLabel: genreOtherLabel2 };
  })();
  var genreIconMap = tables.genreIconMap;
  var genreLabelOfIcon = tables.genreLabelOfIcon;
  var genreOtherLabel = tables.genreOtherLabel;

  // client/src/features/media-tags/types/genre/genretags.ts
  var has = (table, key) => Object.prototype.hasOwnProperty.call(table, key);
  function createGenreTags(JE) {
    const logPrefix = "🪼 Jellyfin Enhanced: Genre Tags:";
    const containerClass = "genre-overlay-container";
    const tagClass = "genre-tag";
    function iconFor(genreName) {
      return genreIconMap[genreName.toLowerCase()] || genreIconMap["default"] || "theaters";
    }
    function labelOfIcon(iconName) {
      return (typeof iconName === "string" && has(genreLabelOfIcon, iconName) ? genreLabelOfIcon[iconName] : void 0) ?? genreOtherLabel;
    }
    function genreCapFitsTruncated() {
      const cap = JE.core.tagLayout?.resolveLayout(null).caps.genre;
      return cap === void 0 || cap > 0 && cap <= 3;
    }
    function insertGenreTags(ctx, container, genres) {
      if (!container) return;
      ctx.removeExistingOverlay(container);
      if (container.style.position !== "relative") container.style.position = "relative";
      const genreContainer = document.createElement("div");
      genreContainer.className = containerClass;
      genres.forEach(function(member) {
        const genreName = export6(member);
        const iconName = iconFor(genreName);
        const tag = document.createElement("div");
        tag.className = tagClass;
        tag.title = genreName;
        tag.dataset.jeGenre = labelOfIcon(iconName);
        const iconSpan = document.createElement("span");
        iconSpan.className = "je-msym-outlined";
        iconSpan.textContent = iconName;
        tag.appendChild(iconSpan);
        const textSpan = document.createElement("span");
        textSpan.className = "genre-text";
        textSpan.textContent = genreName;
        tag.appendChild(textSpan);
        genreContainer.appendChild(tag);
      });
      ctx.commitOverlay(container, genreContainer);
    }
    const spec = {
      logPrefix,
      settingKey: "genreTagsEnabled",
      containerClass,
      taggedAttr: "jeGenreTagged",
      styleId: "genre-tags-styles",
      position: { userKey: "genreTagsPosition", pluginKey: "GenreTagsPosition", fallback: "top-right" },
      cache: {
        key: "JellyfinEnhanced-genreTagsCache",
        legacyPrefix: "genreTagsCache",
        hotBucket: "genre"
      },
      // Genre uses container-level selectors (not .cardImageContainer-scoped)
      // and adds a video-player check — kept as a module-specific override.
      ignoreSelectors: [
        ".je-hidden",
        "#itemDetailPage .infoWrapper",
        "#itemDetailPage #castCollapsible",
        "#indexPage .verticalSection.MyMedia",
        ".formDialog",
        "#itemDetailPage .chapterCardImageContainer",
        "#pluginsPage, #pluginCatalogPage, #devicesPage, #mediaLibraryPage"
      ],
      searchPageIgnoreSelector: "#searchPage",
      shouldIgnore(el, defaultMatcher) {
        if (document.querySelector(".videoPlayerContainer")) return true;
        return defaultMatcher(el);
      },
      buildCss() {
        return `
                .je-msym-outlined {
                    font-family: 'JE Material Symbols Outlined';
                    font-weight: normal;
                    font-style: normal;
                    font-size: calc(24px * var(--je-tag-scale, 1));
                    line-height: 1;
                    letter-spacing: normal;
                    text-transform: none;
                    display: inline-block;
                    white-space: nowrap;
                    word-wrap: normal;
                    direction: ltr;
                    -webkit-font-feature-settings: 'liga';
                    -webkit-font-smoothing: antialiased;
                }

                .${containerClass} {
                    display: flex;
                    flex-direction: column;
                    gap: calc(3px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    align-items: flex-end;
                    z-index: 101;
                    pointer-events: none;
                    max-height: 90%;
                    overflow: visible;
                }
                .${tagClass} {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    height: calc(clamp(22px, 4.5vw, 30px) * var(--je-tag-scale, 1));
                    width: calc(clamp(22px, 4.5vw, 30px) * var(--je-tag-scale, 1));
                    border-radius: 50%;
                    box-shadow: 0 1px 4px rgba(0,0,0,0.4);
                    overflow: visible;
                    background-color: rgba(10, 10, 10, 0.8);
                    color: #E0E0E0;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    flex-shrink: 0;
                    contain: style;
                    position: relative;
                }
                .${tagClass} .je-msym-outlined {
                    font-size: calc(clamp(1em, 2.8vw, 1.4em) * var(--je-tag-scale, 1));
                    line-height: 1;
                }
                .${tagClass} .genre-text {
                    /* Absolutely positioned label = no layout reflow when shown/hidden.
                       Appears beside the icon on hover via opacity (GPU-composited).
                       Direction depends on the slot (layout stylesheet): icons on the
                       right → label floats left, on the left → floats right. */
                    position: absolute;
                    right: calc(100% + 4px);
                    top: 50%;
                    transform: translateY(-50%);
                    white-space: nowrap;
                    font-size: calc(clamp(9px, 1.7vw, 11px) * var(--je-tag-scale, 1));
                    font-weight: 500;
                    text-transform: capitalize;
                    background: rgba(10, 10, 10, 0.85);
                    color: #E0E0E0;
                    padding: calc(2px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1));
                    border-radius: 4px;
                    box-sizing: border-box;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    opacity: 0;
                    pointer-events: none;
                    transition: opacity 0.12s ease;
                }
                /* Bounded when the card is revealed (core/tag-layout.js fitReveal): no room left beside the icon. */
                .${tagClass} .genre-text[data-je-genre-fit="hidden"] { display: none; }
                .card:hover .${tagClass} .genre-text,
                .je-tag-reveal .${tagClass} .genre-text {
                    opacity: 1;
                }
                .layout-mobile .${containerClass} { gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                .layout-mobile .${tagClass} {
                    height: calc(clamp(20px, 4vw, 26px) * var(--je-tag-scale, 1));
                    min-width: calc(clamp(20px, 4vw, 26px) * var(--je-tag-scale, 1));
                }
                .layout-mobile .${tagClass} .je-msym-outlined {
                    font-size: calc(clamp(0.95em, 2.4vw, 1.25em) * var(--je-tag-scale, 1));
                }
                @media (max-width: 768px) {
                    .${containerClass} { gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                    .${tagClass} {
                        height: calc(clamp(21px, 4vw, 26px) * var(--je-tag-scale, 1));
                        min-width: calc(clamp(21px, 4vw, 26px) * var(--je-tag-scale, 1));
                    }
                }
                @media (max-width: 480px) {
                    .${containerClass} { gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); max-height: 85%; }
                    .${tagClass} {
                        height: calc(clamp(20px, 3.6vw, 24px) * var(--je-tag-scale, 1));
                        min-width: calc(clamp(20px, 3.6vw, 24px) * var(--je-tag-scale, 1));
                        box-shadow: 0 1px 3px rgba(0,0,0,0.4);
                    }
                    .${tagClass} .je-msym-outlined {
                        font-size: calc(clamp(0.85em, 2.2vw, 1.1em) * var(--je-tag-scale, 1));
                    }
                }
            `;
      },
      pipeline: {
        needsFirstEpisode: true,
        needsParentSeries: true,
        render(ctx, el, item, extras) {
          if (ctx.isTagged(el)) return;
          if (ctx.shouldIgnore(el)) return;
          const own = export7(item.Genres);
          const parent = export7(extras.parentSeries?.Genres);
          const episode = export7(extras.firstEpisode?.Genres);
          let genres = own;
          if (item.Type === "Season" && own.length === 0 && parent.length > 0) {
            genres = parent;
          } else if (item.Type === "Series" && own.length === 0 && episode.length > 0) {
            genres = episode;
          }
          const itemId = item.Id;
          if (itemId) {
            ctx.setPersistent(String(itemId), { genres: genres.slice(), full: true, timestamp: Date.now() });
          }
          insertGenreTags(ctx, el, genres);
        },
        renderFromCache(ctx, el, itemId) {
          if (ctx.isTagged(el)) return true;
          const cached = ctx.hot?.get(itemId) || ctx.getPersistent(itemId);
          if (cached) {
            const entry = export10(cached);
            const stored = Array.isArray(cached) ? cached : entry.genres;
            if (Array.isArray(stored)) {
              const genres = stored;
              if (genres.length >= 3 && !entry.full && !genreCapFitsTruncated()) return false;
              if (genres.length) insertGenreTags(ctx, el, genres);
              return true;
            }
          }
          return false;
        },
        renderFromServerCache(ctx, el, entry) {
          if (ctx.isTagged(el)) return;
          if (ctx.shouldIgnore(el)) return;
          const genres = export7(entry.Genres);
          if (genres.length > 0) {
            insertGenreTags(ctx, el, genres);
          }
        }
      }
    };
    JE.genreTags = {
      iconFor,
      /**
       * A genre's Tag Styles label, as its chip's data-je-genre.
       * */
      labelFor: (genreName) => labelOfIcon(iconFor(String(genreName)))
    };
    JE.initializeGenreTags = function() {
      JE.core.tagRenderer.register("genre", spec);
      console.log(`${logPrefix} Initialized successfully.`);
    };
    JE.reinitializeGenreTags = function() {
      JE.core.tagRenderer.reinitialize("genre", spec);
    };
    JE.core.tagRenderer.registerStyles(spec);
  }

  // client/src/features/media-tags/types/genre/genretags-entry.ts
  createGenreTags(export4());
})();
})();
//# sourceMappingURL=genretags.js.map
