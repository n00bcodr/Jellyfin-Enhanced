(() => {
"use strict";(()=>{function f(r){let s=window.JellyfinEnhanced?.core?.sharedModules?.[r];if(!s)throw new Error(`${r} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return s}function u(r,s){return r[s]}var R=f("features/media-tags/host");var C=u(R,"tagRuntimeHost");var b=f("features/media-tags/pipeline/dto");var O=u(b,"memberText"),g=u(b,"members");var T=u(b,"record");var w={genreIconMap:{default:"theaters",action:"sports_martial_arts",adventure:"explore",animation:"animation",comedy:"mood",crime:"local_police",documentary:"article",drama:"theater_comedy",family:"family_restroom",fantasy:"auto_awesome",history:"history_edu",horror:"skull",music:"music_note",mystery:"psychology_alt",romance:"favorite","science fiction":"science","sci-fi":"science","tv movie":"tv",thriller:"psychology",war:"military_tech",western:"landscape",superhero:"domino_mask",musical:"music_video",biography:"menu_book",sport:"sports_soccer","game-show":"quiz","reality-tv":"live_tv",aventure:"explore",comédie:"mood",drame:"theater_comedy",fantastique:"auto_awesome",histoire:"history_edu",horreur:"skull",musique:"music_note",mystère:"psychology_alt","science-fiction":"science",téléfilm:"tv",guerre:"military_tech","comédie musicale":"music_video",biographie:"menu_book",familial:"family_restroom",historique:"history_edu","jeu-concours":"quiz","télé-réalité":"live_tv",acción:"sports_martial_arts",aventura:"explore",animación:"animation",comedia:"mood",crimen:"local_police",documental:"article",familiar:"family_restroom",fantasía:"auto_awesome",historia:"history_edu",terror:"skull",música:"music_note",misterio:"psychology_alt","ciencia ficción":"science","película de tv":"tv",suspense:"psychology",bélica:"military_tech",superhéroes:"domino_mask",biografía:"menu_book",deporte:"sports_soccer",concurso:"quiz",telerrealidad:"live_tv",abenteuer:"explore",komödie:"mood",krimi:"local_police",dokumentarfilm:"article",familienfilm:"family_restroom",geschichte:"history_edu",kriegsfilm:"military_tech",musikfilm:"music_video",liebesfilm:"favorite",fernsehfilm:"tv",spielshow:"quiz",azione:"sports_martial_arts",avventura:"explore",animazione:"animation",commedia:"mood",crimine:"local_police",documentario:"article",drammatico:"theater_comedy",famiglia:"family_restroom",fantastico:"auto_awesome",storico:"history_edu",orrore:"skull",musica:"music_note",mistero:"psychology_alt",romantico:"favorite",fantascienza:"science","film per la tv":"tv",guerra:"military_tech",biografico:"menu_book",sportivo:"sports_soccer","game show":"quiz","reality tv":"live_tv",eventyr:"explore",komedie:"mood",dokumentar:"article",familie:"family_restroom",historie:"history_edu",gyser:"skull",musik:"music_note",mysterie:"psychology_alt",romantik:"favorite",krig:"military_tech","tv-film":"tv",spilshow:"quiz",äventyr:"explore",komedi:"mood",brott:"local_police",dokumentär:"article",familj:"family_restroom",skräck:"skull",mysterium:"psychology_alt",krigs:"military_tech",spelshow:"quiz",akció:"sports_martial_arts",kaland:"explore",animációs:"animation",vígjáték:"mood",bűnügyi:"local_police",dokumentum:"article",dráma:"theater_comedy",családi:"family_restroom",történelmi:"history_edu",zenei:"music_note",misztikus:"psychology_alt",romantikus:"favorite","tv film":"tv",háborús:"military_tech",életrajzi:"menu_book",játékshow:"quiz","valóság-tv":"live_tv",боевик:"sports_martial_arts",приключения:"explore",мультфильм:"animation",комедия:"mood",криминал:"local_police",документальный:"article",драма:"theater_comedy",семейный:"family_restroom",фэнтези:"auto_awesome",история:"history_edu",ужасы:"skull",музыка:"music_note",детектив:"psychology_alt",мелодрама:"favorite",фантастика:"science","НФ и Фэнтези":"science","телевизионный фильм":"tv",триллер:"psychology",военный:"military_tech",вестерн:"landscape","реалити-шоу":"live_tv"},genreLabelOfIcon:{sports_martial_arts:"action",explore:"adventure",animation:"animation",mood:"comedy",local_police:"crime",article:"documentary",theater_comedy:"drama",family_restroom:"family",auto_awesome:"fantasy",history_edu:"history",skull:"horror",music_note:"music",psychology_alt:"mystery",favorite:"romance",science:"science fiction",tv:"tv movie",psychology:"thriller",military_tech:"war",landscape:"western",domino_mask:"superhero",music_video:"musical",menu_book:"biography",sports_soccer:"sport",quiz:"game-show",live_tv:"reality-tv"},genreOtherLabel:"other"},_=w.genreIconMap,j=w.genreLabelOfIcon,P=w.genreOtherLabel;var E=(r,s)=>Object.prototype.hasOwnProperty.call(r,s);function S(r){let s="🪼 Jellyfin Enhanced: Genre Tags:",d="genre-overlay-container",a="genre-tag";function h(e){return _[e.toLowerCase()]||_.default||"theaters"}function k(e){return(typeof e=="string"&&E(j,e)?j[e]:void 0)??P}function z(){let e=r.core.tagLayout?.resolveLayout(null).caps.genre;return e===void 0||e>0&&e<=3}function y(e,t,n){if(!t)return;e.removeExistingOverlay(t),t.style.position!=="relative"&&(t.style.position="relative");let o=document.createElement("div");o.className=d,n.forEach(function(m){let l=O(m),c=h(l),i=document.createElement("div");i.className=a,i.title=l,i.dataset.jeGenre=k(c);let p=document.createElement("span");p.className="je-msym-outlined",p.textContent=c,i.appendChild(p);let v=document.createElement("span");v.className="genre-text",v.textContent=l,i.appendChild(v),o.appendChild(i)}),e.commitOverlay(t,o)}let x={logPrefix:s,settingKey:"genreTagsEnabled",containerClass:d,taggedAttr:"jeGenreTagged",styleId:"genre-tags-styles",position:{userKey:"genreTagsPosition",pluginKey:"GenreTagsPosition",fallback:"top-right"},cache:{key:"JellyfinEnhanced-genreTagsCache",legacyPrefix:"genreTagsCache",hotBucket:"genre"},ignoreSelectors:[".je-hidden","#itemDetailPage .infoWrapper","#itemDetailPage #castCollapsible","#indexPage .verticalSection.MyMedia",".formDialog","#itemDetailPage .chapterCardImageContainer","#pluginsPage, #pluginCatalogPage, #devicesPage, #mediaLibraryPage"],searchPageIgnoreSelector:"#searchPage",shouldIgnore(e,t){return document.querySelector(".videoPlayerContainer")?!0:t(e)},buildCss(){return`
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

                .${d} {
                    display: flex;
                    flex-direction: column;
                    gap: calc(3px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    align-items: flex-end;
                    z-index: 101;
                    pointer-events: none;
                    max-height: 90%;
                    overflow: visible;
                }
                .${a} {
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
                .${a} .je-msym-outlined {
                    font-size: calc(clamp(1em, 2.8vw, 1.4em) * var(--je-tag-scale, 1));
                    line-height: 1;
                }
                .${a} .genre-text {
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
                .${a} .genre-text[data-je-genre-fit="hidden"] { display: none; }
                .card:hover .${a} .genre-text,
                .je-tag-reveal .${a} .genre-text {
                    opacity: 1;
                }
                .layout-mobile .${d} { gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                .layout-mobile .${a} {
                    height: calc(clamp(20px, 4vw, 26px) * var(--je-tag-scale, 1));
                    min-width: calc(clamp(20px, 4vw, 26px) * var(--je-tag-scale, 1));
                }
                .layout-mobile .${a} .je-msym-outlined {
                    font-size: calc(clamp(0.95em, 2.4vw, 1.25em) * var(--je-tag-scale, 1));
                }
                @media (max-width: 768px) {
                    .${d} { gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                    .${a} {
                        height: calc(clamp(21px, 4vw, 26px) * var(--je-tag-scale, 1));
                        min-width: calc(clamp(21px, 4vw, 26px) * var(--je-tag-scale, 1));
                    }
                }
                @media (max-width: 480px) {
                    .${d} { gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); max-height: 85%; }
                    .${a} {
                        height: calc(clamp(20px, 3.6vw, 24px) * var(--je-tag-scale, 1));
                        min-width: calc(clamp(20px, 3.6vw, 24px) * var(--je-tag-scale, 1));
                        box-shadow: 0 1px 3px rgba(0,0,0,0.4);
                    }
                    .${a} .je-msym-outlined {
                        font-size: calc(clamp(0.85em, 2.2vw, 1.1em) * var(--je-tag-scale, 1));
                    }
                }
            `},pipeline:{needsFirstEpisode:!0,needsParentSeries:!0,render(e,t,n,o){if(e.isTagged(t)||e.shouldIgnore(t))return;let m=g(n.Genres),l=g(o.parentSeries?.Genres),c=g(o.firstEpisode?.Genres),i=m;n.Type==="Season"&&m.length===0&&l.length>0?i=l:n.Type==="Series"&&m.length===0&&c.length>0&&(i=c);let p=n.Id;p&&e.setPersistent(String(p),{genres:i.slice(),full:!0,timestamp:Date.now()}),y(e,t,i)},renderFromCache(e,t,n){if(e.isTagged(t))return!0;let o=e.hot?.get(n)||e.getPersistent(n);if(o){let m=T(o),l=Array.isArray(o)?o:m.genres;if(Array.isArray(l)){let c=l;return c.length>=3&&!m.full&&!z()?!1:(c.length&&y(e,t,c),!0)}}return!1},renderFromServerCache(e,t,n){if(e.isTagged(t)||e.shouldIgnore(t))return;let o=g(n.Genres);o.length>0&&y(e,t,o)}}};r.genreTags={iconFor:h,labelFor:e=>k(h(String(e)))},r.initializeGenreTags=function(){r.core.tagRenderer.register("genre",x),console.log(`${s} Initialized successfully.`)},r.reinitializeGenreTags=function(){r.core.tagRenderer.reinitialize("genre",x)},r.core.tagRenderer.registerStyles(x)}S(C());})();
})();
