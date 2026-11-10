(() => {
"use strict";(()=>{function b(s){let a=window.JellyfinEnhanced?.core?.sharedModules?.[s];if(!a)throw new Error(`${s} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return a}function d(s,a){return s[a]}var D=b("features/media-tags/host");var U=d(D,"mediaTagsContext");var m=b("features/media-tags/pipeline/dto");var v=d(m,"finite");var w=d(m,"isRecord");var x=d(m,"own"),u=d(m,"record");var H={ratingTagsOnMovies:"movies",ratingTagsOnSeries:"series",ratingTagsOnSeasons:"seasons",ratingTagsOnEpisodes:"episodes",ratingTagsOnContinueWatching:"continueWatching",ratingTagsOnNextUp:"nextUp"};function z(s){let a=s.core,T="🪼 Jellyfin Enhanced: Rating Tags:",g="rating-overlay-container",l="rating-tag",j=60*1e3;function I(n){if(n==null)return null;let t=Number(n);return Number.isFinite(t)?Math.max(0,Math.min(100,Math.round(t))):null}let $={Movie:{userKey:"ratingTagsOnMovies",pluginKey:"RatingTagsOnMovies"},Series:{userKey:"ratingTagsOnSeries",pluginKey:"RatingTagsOnSeries"},Season:{userKey:"ratingTagsOnSeasons",pluginKey:"RatingTagsOnSeasons"},Episode:{userKey:"ratingTagsOnEpisodes",pluginKey:"RatingTagsOnEpisodes"}},O={continuewatching:{userKey:"ratingTagsOnContinueWatching",pluginKey:"RatingTagsOnContinueWatching"},nextup:{userKey:"ratingTagsOnNextUp",pluginKey:"RatingTagsOnNextUp"}},J=Object.values(O);function y(n){let t=x(H,n.userKey);if(t&&a.core?.tagScopes)return a.core.tagScopes.allows("rating",t);let e=a.currentSettings?.[n.userKey];if(typeof e=="boolean")return e;let r=a.pluginConfig?.[n.pluginKey];return typeof r=="boolean"?r:!0}function p(n,t){let e=n.closest("[data-type]")?.getAttribute("data-type")||(typeof t=="string"?t:null),r=e?x($,e):null;if(r&&!y(r))return!0;if(typeof a.detectCardRowSurface=="function"&&J.some(o=>!y(o))){let o=x(O,a.detectCardRowSurface(n));if(o&&!y(o))return!0}return!1}a.isRatingTagExcludedByScope=p;function h(){try{let n=s.peer("spoilerBlur");return!n||a.pluginConfig?.SpoilerBlurEnabled!==!0?!1:typeof n.isLoaded=="function"?n.isLoaded()!==!0:typeof n.isLoadOk=="function"&&n.isLoadOk()!==!0}catch{return!1}}function C(n){try{if(!n||!a.pluginConfig||a.pluginConfig.SpoilerBlurEnabled!==!0||a.pluginConfig.SpoilerStripRatings===!1)return!1;let t=s.peer("spoilerBlur");if(!t||typeof t.isEnabledFor!="function"||typeof t.getUserPrefs=="function"&&t.getUserPrefs()?.HideRatings===!1)return!1;let e=typeof t.isLoadOk=="function"?t.isLoadOk()===!0:!0;return n.Type==="Series"?n.Id?e?t.isEnabledFor(n.Id)===!0:!0:!1:n.Type==="Season"?n.SeriesId?e?t.isEnabledFor(n.SeriesId)===!0:!0:!1:n.Type==="Episode"?u(n.UserData).Played===!0||!n.SeriesId?!1:e?t.isEnabledFor(n.SeriesId)===!0:!0:!1}catch{return!!(a.pluginConfig&&a.pluginConfig.SpoilerBlurEnabled===!0)}}function E(n,t){let e=n.getPersistent(t)??n.hot?.get(t);if(!e)return null;let r=w(e)?v(e.refreshAt):null;return r!==null&&Date.now()>=r?null:typeof e=="string"||typeof e=="number"?{tmdb:String(e),critic:null}:w(e)?{...e,tmdb:e.tmdb??null,critic:e.critic??null}:null}function L(n,t,e){n.setPersistent(t,e),n.hot?.set(t,e)}function f(n,t,e){if(!e)return;let r=a.ratingSources.resolve(e.tmdb,e.critic,e.ratings);if(n.removeExistingOverlay(t),!r.length)return;let o=document.createElement("div");o.className=g;for(let i of r)o.appendChild(a.ratingSources.chip(i));n.commitOverlay(t,o)}let S={logPrefix:T,settingKey:"ratingTagsEnabled",containerClass:g,taggedAttr:"jeRatingTagged",styleId:"jellyfin-enhanced-rating-tags-css",position:{userKey:"ratingTagsPosition",pluginKey:"RatingTagsPosition",fallback:"bottom-right"},cache:{key:"JellyfinEnhanced-ratingTagsCache",legacyPrefix:"ratingTagsCache",hotBucket:"rating",saveOnUnload:!1},buildCss(){return`
                .${g} {
                    display: flex;
                    flex-direction: column;
                    gap: calc(4px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    align-items: flex-end;
                    z-index: 10;
                    pointer-events: none;
                    max-width: calc(100% - 12px);
                }

                .${l} {
                    display: inline-flex;
                    align-items: center;
                    gap: calc(4px * var(--je-tag-scale, 1));
                    padding: calc(4px * var(--je-tag-scale, 1)) calc(8px * var(--je-tag-scale, 1));
                    background: rgba(0, 0, 0, 0.8);
                    color: #ffc107;
                    font-size: calc(13px * var(--je-tag-scale, 1));
                    font-weight: 600;
                    border-radius: 4px;
                    /* backdrop-filter removed — blur causes jank during hover animations */
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
                    white-space: nowrap;
                    line-height: 1;
                    pointer-events: none;
                }

                .${l}.rating-tag-critic { color: #ffffff; }
                .${l}.rating-tag-tmdb { background: rgba(0, 0, 0, 0.85); color: #ffc107; }

                .rating-star-icon { color: #ffc107 !important; font-size: calc(14px * var(--je-tag-scale, 1)); line-height: 1; }
                .rating-tomato-icon { width: calc(14px * var(--je-tag-scale, 1)); height: calc(14px * var(--je-tag-scale, 1)); flex-shrink: 0; background-size: contain; background-repeat: no-repeat; background-position: center; display: inline-block; }
                .rating-tomato-icon.fresh { background-image: url(assets/img/fresh.svg); }
                .rating-tomato-icon.rotten { background-image: url(assets/img/rotten.svg); }
                .rating-text { line-height: 1; }
                .je-rating-source-logo { display: inline-flex; width: calc(14px * var(--je-tag-scale, 1)); height: calc(14px * var(--je-tag-scale, 1)); flex-shrink: 0; }
                .je-rating-source-logo :is(svg, img) { width: 100%; height: 100%; display: block; object-fit: contain; }
                .rating-tag--source { color: #fff; }
                .rating-tag[data-je-rating-compact] > :first-child { display: none; }
                .rating-tag[data-je-rating-compact]::before { content: ''; width: calc(2px * var(--je-tag-scale, 1)); height: calc(2px * var(--je-tag-scale, 1)); border-radius: 50%; background: var(--je-rating-source-color); }


                .layout-mobile .${l} {
                    padding: calc(2px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1));
                    font-size: calc(11px * var(--je-tag-scale, 1));
                    border-radius: 3px;
                }
                .layout-mobile .${g} { gap: calc(3px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                .layout-mobile .rating-star-icon { font-size: calc(12px * var(--je-tag-scale, 1)) !important; }
                .layout-mobile .rating-tomato-icon { width: calc(12px * var(--je-tag-scale, 1)); height: calc(12px * var(--je-tag-scale, 1)); }

                @media (max-width: 768px) {
                    .${l} { padding: calc(3px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1)); font-size: calc(12px * var(--je-tag-scale, 1)); }
                    .${g} { gap: calc(3px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                }

                @media (max-width: 480px) {
                    .${g} { gap: calc(2px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                    .${l} { padding: calc(2px * var(--je-tag-scale, 1)) calc(4px * var(--je-tag-scale, 1)); font-size: calc(clamp(10px, 2vw, 11px) * var(--je-tag-scale, 1)); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }
                    .rating-star-icon { font-size: calc(clamp(10px, 2.5vw, 11px) * var(--je-tag-scale, 1)) !important; }
                    .rating-tomato-icon { width: calc(clamp(10px, 2.5vw, 11px) * var(--je-tag-scale, 1)); height: calc(clamp(10px, 2.5vw, 11px) * var(--je-tag-scale, 1)); }
                }
            `},pipeline:{needsFirstEpisode:!1,needsParentSeries:!1,render(n,t,e,r){if(n.shouldIgnore(t)||n.isTagged(t)||t.closest(".je-hidden"))return;if(p(t,e.Type)){n.markTagged(t);return}let o=String(e.Id);if(C(e)){n.markTagged(t),!h()&&typeof a.appendUserRatingToContainer=="function"&&a.appendUserRatingToContainer(t,e,r);return}let i=E(n,o);if(i&&i.tmdb!==void 0){(i.tmdb||i.critic!==null||i.ratings)&&f(n,t,i),typeof a.appendUserRatingToContainer=="function"&&a.appendUserRatingToContainer(t,e,r);return}let c=e;r.ratingParentSeries&&!e.CommunityRating&&!e.CriticRating&&(c=r.ratingParentSeries);let P=c.CommunityRating!=null?parseFloat(String(c.CommunityRating)).toFixed(1):null,k=c.CriticRating!=null?I(c.CriticRating):null,R={tmdb:P,critic:k,ratings:e.Ratings??r.ratingParentSeries?.Ratings},N=u(e.ProviderIds),M=u(r?.parentSeries?.ProviderIds),_=N.Tmdb||N.tmdb||null,A=M.Tmdb||M.tmdb||null,B=e.Type==="Series"?"tv":"movie",F=v(e.RatingsRefreshAt),K=e.RatingsPending===!0?Date.now()+j:F!==null?Math.max(F,Date.now()+j):null;L(n,o,{...R,...K!==null?{refreshAt:K}:{},tmdbId:_,seriesTmdbId:A,tmdbMediaType:B,seasonNumber:e.IndexNumber??null,episodeNumber:e.Type==="Episode"?e.IndexNumber:null,parentSeasonNumber:e.Type==="Episode"?e.ParentIndexNumber:null,sgType:e.Type,sgSeriesId:e.SeriesId||(e.Type==="Series"?e.Id:null),sgPlayed:u(e.UserData).Played===!0}),(P||k!==null||R.ratings)&&f(n,t,R),typeof a.appendUserRatingToContainer=="function"&&a.appendUserRatingToContainer(t,e,r)},renderFromCache(n,t,e){if(n.isTagged(t)||n.shouldIgnore(t)||t.closest(".je-hidden"))return!0;let r=E(n,e);if(p(t,r?.sgType))return n.markTagged(t),!0;if(!r)return!1;if(C({Type:r.sgType,Id:e,SeriesId:r.sgSeriesId,UserData:{Played:r.sgPlayed===!0}}))return n.markTagged(t),h()||typeof a.appendUserRatingToContainer=="function"&&(r.tmdbId||r.seriesTmdbId)&&a.appendUserRatingToContainer(t,{Type:r.sgType,ProviderIds:r.tmdbId?{Tmdb:r.tmdbId}:{},SeriesProviderIds:r.seriesTmdbId?{Tmdb:r.seriesTmdbId}:{}}),!0;if((r.tmdb||r.critic!==null||r.ratings)&&f(n,t,r),typeof a.appendUserRatingToContainer=="function"&&(r.tmdbId||r.seriesTmdbId)){let o={Type:r.tmdbMediaType==="tv"?"Series":"Movie",ProviderIds:r.tmdbId?{Tmdb:r.tmdbId}:{},SeriesProviderIds:r.seriesTmdbId?{Tmdb:r.seriesTmdbId}:{},IndexNumber:r.seasonNumber,ParentIndexNumber:r.parentSeasonNumber};r.seriesTmdbId&&r.episodeNumber!=null?(o.Type="Episode",o.IndexNumber=r.episodeNumber,o.ParentIndexNumber=r.parentSeasonNumber):r.seriesTmdbId&&r.seasonNumber!=null&&(o.Type="Season",o.IndexNumber=r.seasonNumber),a.appendUserRatingToContainer(t,o)}return!0},renderFromServerCache(n,t,e,r){if(n.isTagged(t)||n.shouldIgnore(t))return;if(p(t,e.Type)){n.markTagged(t);return}if((e.Type==="Series"||e.Type==="Season")&&C({Type:e.Type,Id:r,SeriesId:e.SeriesId})){if(n.markTagged(t),h())return}else{let i=e.CommunityRating!=null?parseFloat(String(e.CommunityRating)).toFixed(1):null,c=e.CriticRating!=null?I(e.CriticRating):null;(i||c!==null||e.Ratings)&&f(n,t,{tmdb:i,critic:c,ratings:e.Ratings})}if(typeof a.appendUserRatingToContainer=="function"){let i={Type:e.Type,ProviderIds:e.TmdbId?{Tmdb:e.TmdbId}:{},SeriesProviderIds:e.SeriesTmdbId?{Tmdb:e.SeriesTmdbId}:{},IndexNumber:e.SeasonNumber,ParentIndexNumber:e.SeasonNumber,...e.Type==="Episode"?{ParentIndexNumber:e.SeasonNumber,IndexNumber:e.EpisodeNumber}:{}};(e.TmdbId||e.SeriesTmdbId)&&a.appendUserRatingToContainer(t,i,null)}}}};a.initializeRatingTags=function(){console.log(`${T} Starting...`),a.core.tagRenderer.register("rating",S).injectCss(),console.log(`${T} Initialized successfully.`)},a.reinitializeRatingTags=function(){a.core.tagRenderer.reinitialize("rating",S)},a.core.tagRenderer.registerStyles(S)}z(U());})();
})();
