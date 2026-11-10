(() => {
"use strict";(()=>{function J(a){let s=window.JellyfinEnhanced?.core?.sharedModules?.[a];if(!s)throw new Error(`${a} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return s}function v(a,s){return a[s]}var Y=J("features/details-providers/host"),Q=v(Y,"api"),Se=v(Y,"bridge"),we=v(Y,"browserTranslator"),ve=v(Y,"currentUserId"),be=v(Y,"dashboard"),Ce=v(Y,"detailsContext");var oe=J("features/details-providers/page");var he=v(oe,"detailsLease");var xe=v(oe,"hashItemId");var ye=v(oe,"lookupDetailsItem");var ae=v(oe,"visibleDetailPage");var ut=J("features/details-providers/links");var te=v(ut,"pathSegment");var B=J("features/details-providers/wire"),Ie=v(B,"bool"),Le=v(B,"decodeDetailsItem");var re=v(B,"errorShape"),D=v(B,"field");var le=v(B,"isRecord"),Z=v(B,"list"),ce=v(B,"num");var C=v(B,"str");var Te=v(B,"text");function je(a){return String(a).replace(/<a\s[^>]*?href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,"[$2]($1)").replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi,"**$2**").replace(/<(em|i)>([\s\S]*?)<\/\1>/gi,"*$2*").replace(/<br\s*\/?>/gi,`
`).replace(/<\/p>\s*<p[^>]*>/gi,`

`).replace(/<\/?[a-z][^>]*>/gi,"")}function Me(a){return je(a).replace(/\[([^\]]+)\]\(https?:\/\/[^)\s]+\)/g,"$1").replace(/https?:\/\/[^\s<]+/g,"").replace(/(\*\*|__|~~|\*|`)/g,"").replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g,"$1$2").replace(/[ \t]+/g," ").replace(/ ?\n ?/g,`
`).trim()}function Pe(a){let s=[];for(let l of je(a).matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g))l[1]!==void 0&&l[2]!==void 0&&s.push({label:l[1],url:l[2]});return s}function Ue(a,s,l){if(l.length!==s.length)return a;let d=a,y=[];return s.forEach((w,T)=>{let H=d.toLowerCase(),k=[w.label,l[T]||""].map(M=>M.trim().replace(/[[\]]/g,"")).find(M=>M&&H.includes(M.toLowerCase()));if(!k)return;let I=H.indexOf(k.toLowerCase());y.push(`[${d.substr(I,k.length)}](${w.url})`),d=`${d.slice(0,I)}${y.length-1}${d.slice(I+k.length)}`}),d.replace(/\u0001(\d+)\u0002/g,(w,T)=>y[Number(T)]??"")}function Ae(a,s){if(!a)return"";let l=s(je(a)),d="\0JE";for(;l.includes(d);)d+="J";let y=[],w=_=>`${d}${y.push(_)-1}\0`,T=_=>_.replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>").replace(/__(.+?)__/g,"<strong>$1</strong>").replace(/\*(.+?)\*/g,"<em>$1</em>").replace(/_(.+?)_/g,"<em>$1</em>").replace(/~~(.+?)~~/g,"<del>$1</del>"),H=(_,b)=>`<a is="emby-linkbutton" href="${b}" target="_blank" rel="noopener noreferrer">${_}</a>`;l=l.replace(/`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<]+)/gi,(_,b,O,F,me)=>{if(b!==void 0)return w(`<code>${b}</code>`);if(O!==void 0&&F!==void 0)return w(H(T(O),F));let ne=me??"",ee=ne.replace(/[.,;!?)]+$/,"");return w(H(ee,ee))+ne.slice(ee.length)}),l=T(l);let k=l.split(/\r?\n/),I=[],M=!1,N=[],K=!1,V=[];for(let _ of k){let b=_.trim();if(b.startsWith("&gt; ")){M||(M=!0,N=[]),N.push(b.substring(5));continue}else M&&(I.push("<blockquote>"+N.join("<br>")+"</blockquote>"),M=!1,N=[]);if(/^[-*]\s+/.test(b)){K||(K=!0,V=[]),V.push("<li>"+b.substring(2)+"</li>");continue}else K&&(I.push("<ul>"+V.join("")+"</ul>"),K=!1,V=[]);let O=/^(#{1,6})\s/.exec(b);if(O?.[1]){let F=/^#+/.exec(b)?.[0].length??O[1].length;I.push(`<h${F}>${b.substring(F+1)}</h${F}>`);continue}if(/^([-*]){3,}$/.test(b)){I.push("<hr>");continue}I.push(b?_:"<br>")}return M&&I.push("<blockquote>"+N.join("<br>")+"</blockquote>"),K&&I.push("<ul>"+V.join("")+"</ul>"),y.reduce((_,b,O)=>_.split(`${d}${O}\0`).join(b),I.join(""))}var _e='<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>';function Ee(a){let s=Math.round(Math.max(0,Math.min(1,a))*100);return`<span class="je-star-icon" aria-hidden="true">
                <svg class="je-star-icon-base" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${_e}</svg>
                <svg class="je-star-icon-fill" style="clip-path: inset(0 ${100-s}% 0 0);" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${_e}</svg>
            </span>`}function De(a){return a?`<span class="je-user-star-rating">${Array.from({length:5},(l,d)=>Ee(Math.max(0,Math.min(1,a-d)))).join("")}</span>`:""}function de(a){return a?new Date(a).toLocaleDateString(void 0,{year:"numeric",month:"short",day:"numeric"}):""}function Ne(a){return Z(D(a,"results")).filter(le).map(s=>({author:C(s.author),created_at:C(s.created_at),content:C(s.content),rating:ce(D(s.author_details,"rating"))??null,url:C(s.url)}))}function He(a){return Z(D(a,"Reviews")).filter(le).map(s=>{let l=C(s.Content),d=C(s.Summary),y=ce(s.Score);return{source:"anilist",author:Te(s.Author)||"Anonymous",created_at:C(s.CreatedAt),content:d?`**${d}**

${l}`:l,rating:y?Number((y/10).toFixed(1)):null,url:C(s.Url)}})}function Oe(a){return Z(D(a,"reviews")).filter(le).map(s=>({userId:C(s.userId)??"",userName:C(s.userName),content:C(s.content),rating:ce(s.rating)??null,createdAt:C(s.createdAt),updatedAt:C(s.updatedAt)}))}var ue=(a,s)=>a.replace(/-/g,"")===s.replace(/-/g,"");function Be(a){let s=a.filter(d=>!!d.rating);if(s.length===0)return null;let l=s.reduce((d,y)=>d+y.rating,0)/s.length*2;return{display:Number.isInteger(l)?`${l}`:`${l.toFixed(1)}`,count:s.length}}function Fe(a){let[s,l]=a.split("-"),d=(s||"").toLowerCase();if(!d||d==="en")return null;let y=d==="zh"&&/^(tw|hk|mo)$/i.test(l||"");return{server:y?"zt":d,browser:y?"zh-Hant":d}}function qe(a,s){let l=a;if(s)for(let[d,y]of Object.entries(s))l=l.replace(new RegExp(`\\{${d}\\}`,"g"),()=>String(y));return l}function ze(a){let s=null;return()=>{if(s)return s;let l=s=a();return l.catch(()=>{s===l&&(s=null)}),l}}var o=Se("Reviews"),Je=Ce(o),ke=350;o.initializeReviewsScript=function(){let s=o.pluginConfig,l=s.ShowReviews&&s.TmdbEnabled,d=s.ShowUserReviews,y=s.ShowAnilistReviews;if(!l&&!d&&!y){console.log("🪼 Jellyfin Enhanced: Reviews feature disabled.");return}let w="🪼 Jellyfin Enhanced: Reviews:",T=new WeakMap,H=new WeakMap;o.session?.onUserChange("details-reviews",()=>{document.querySelectorAll(".tmdb-reviews-section, .je-avg-user-rating-chip").forEach(e=>e.remove()),T=new WeakMap,H=new WeakMap});let k=e=>o.escapeHtml(e),I=e=>Ae(e,k);async function M(e,t){try{if(t!=="Series"&&t!=="Movie"&&t!=="Season"&&t!=="Episode"||!o.pluginConfig.SpoilerBlurEnabled||o.pluginConfig.SpoilerStripReviews===!1)return!1;let r=Je.peer("spoilerBlur");if(!r)return!1;if(typeof r.whenLoaded=="function"&&await r.whenLoaded(),typeof r.isLoadOk=="function"&&!r.isLoadOk())return console.warn(`${w} Spoiler Guard state load failed; suppressing reviews fail-closed.`),!0;if(typeof r.getUserPrefs=="function"&&(r.getUserPrefs()||{}).HideReviews===!1)return!1;if(t==="Movie"){let i=r.isMovieInScope;if(typeof i!="function")throw new TypeError("Spoiler Guard movie scope unavailable");return await i.call(r,e?.Id||"")}let n=t==="Series"?e?.Id||"":e?.SeriesId||"";return!!(r.isEnabledFor&&r.isEnabledFor(n))}catch(r){return console.warn(`${w} Spoiler Guard check failed; suppressing reviews:`,r),!0}}function N(e){try{let t=e||ae()||document;t.querySelector(".tmdb-reviews-section")?.remove(),t.querySelector(".je-avg-user-rating-chip")?.remove()}catch(t){console.warn(`${w} removeReviewsSection failed:`,t)}}function K(e,t){let r=t==="Series"?"tv":"movie",n=te(e),i=`/${r}/${n}/reviews?language=en-US&page=1`,u=`${Q().getUrl(`/JellyfinEnhanced/tmdb/${r}/${n}/reviews`)}?language=en-US&page=1`;return o.core.api.fetch(u,{cacheKey:`tmdb:${i}`}).then(Ne).catch(p=>(console.error(`${w} Failed to fetch reviews.`,p),null))}function V(e){let t=e?.ProviderIds,r=parseInt(t?.AniList||t?.Anilist||"",10);if(!r)return Promise.resolve(null);let n=`anilistId=${r}`;return o.core.api.fetch(`${Q().getUrl("/JellyfinEnhanced/anilist/reviews")}?${n}`,{cacheKey:`anilist:${n}`}).then(He).catch(i=>(console.error(`${w} Failed to fetch AniList reviews.`,i),null))}async function _(e,t,r){if(r!=="Movie"&&r!=="Series")return null;let[n,i]=await Promise.all([l?K(t.split(":")[0]??"",r):null,y?V(e):null]);return n||i?[...n||[],...i||[]]:null}let b=e=>e.split(":").map(te).join(":");function O(e,t){return o.core.api.plugin(`/reviews/${t}/${b(e)}`).then(Oe).catch(r=>(console.error(`${w} Failed to fetch user reviews.`,r),null))}async function F(e,t,r,n){try{return await o.core.api.plugin(`/reviews/${t}/${b(e)}`,{method:"POST",body:{content:r,rating:n||null},skipRetry:!0})}catch(i){let u=re(i);throw new Error(u.responseMessage||u.message)}}async function me(e,t){await o.core.api.plugin(`/reviews/${t}/${b(e)}`,{method:"DELETE",skipRetry:!0})}async function ne(e,t,r){let n=(e||"").replace(/-/g,"");try{await o.core.api.plugin(`/reviews/admin/${te(n)}/${r}/${b(t)}`,{method:"DELETE",skipRetry:!0})}catch(i){throw re(i).status===404?new Error("No matching review to delete (it may have already been removed)."):i}}function ee(e,t){return new Promise(r=>{let n=be();if(n&&typeof n.confirm=="function")try{n.confirm(e,t,r);return}catch(i){console.warn(`${w} Dashboard.confirm threw, falling back:`,i)}r(window.confirm(t?`${t}

${e}`:e))})}function Ke(e,t){let r=be();if(r&&typeof r.alert=="function")try{r.alert({title:t||"",message:e||""});return}catch(n){console.warn(`${w} Dashboard.alert threw, falling back:`,n)}window.alert(t?`${t}

${e}`:e)}let Re=new Set;function A(e,t,r){let n;try{n=o.t(e,r)}catch(i){console.warn(`${w} JE.t('${e}') threw, using fallback:`,i),n=null}return!n||n===e?(Re.has(e)||(Re.add(e),console.warn(`${w} Missing translation key '${e}', using inline fallback.`)),qe(t,r)):n}let pe=e=>`<span class="tmdb-review-toggle">${o.t(e)}</span>`;function ge(e,t){let r=e.length>ke;return I(r&&!t?e.substring(0,ke):e)+(r?pe(t?"reviews_read_less":"reviews_read_more"):"")}function Ve(e){let t=document.createElement("div");t.className="tmdb-review-card";let r=e.source==="anilist";r&&t.classList.add("je-anilist-review-card"),t.dataset.fullContent=e.content||"";let n=e.content||"No content available",i=de(e.created_at),u=e.rating?`<span class="tmdb-review-rating">${o.icon(o.IconName.STAR)} ${e.rating}</span>`:"";t.innerHTML=`
                <div class="tmdb-review-header">
                    <div class="tmdb-review-author-info">
                        <strong class="tmdb-review-author">${k(e.author||"Anonymous")}</strong>
                        <span class="tmdb-review-date">${k(i)}</span>
                    </div>
                    ${u}
                </div>
                <div class="tmdb-review-content-wrapper">
                    <p class="tmdb-review-text"></p>
                </div>
            `;let p=e.url||"",h=r?/^https:\/\/anilist\.co\//.test(p)?p:"":/^https:\/\/www\.themoviedb\.org\//.test(p)?p:"",j=h?o.helpers.createExternalLink(h,{className:"je-review-source",resetStyle:!0}):Object.assign(document.createElement("span"),{className:"je-review-source"}),f=document.createElement("img");f.src=o.cdn.url("mdblist-logos",r?"anilist.png":"tmdb.png"),f.alt="",f.className="je-review-source-logo",f.loading="lazy",j.append(f,r?"AniList":"TMDB");let m=t.querySelector(".tmdb-review-date");i&&m?.append(Object.assign(document.createElement("span"),{textContent:"·"})),m?.append(j);let $=t.querySelector(".tmdb-review-text");return $&&($.innerHTML=ge(n,!1)),Ze(t,e.content||""),t}function We(){let e="";try{e=localStorage.getItem(`${ve()}-language`)||""}catch{}return Fe(e||document.documentElement.lang||"")}let Ge=ze(()=>o.core.api.plugin("/translate/languages",{skipRetry:!0}).then(e=>Z(D(e,"languages")).filter(t=>typeof t=="string")));async function Xe(e){try{let t=we();return!window.isSecureContext||!t?!1:await t.availability({sourceLanguage:"en",targetLanguage:e})!=="unavailable"}catch{return!1}}async function Ye(e,t){let r=we();if(!r)throw new Error("Browser translator unavailable");let n=await r.create({sourceLanguage:"en",targetLanguage:t});try{let i=[];for(let u of e.split(`
`))i.push(u.trim()?await n.translate(u):u);return i.join(`
`)}finally{n.destroy?.()}}function Qe(e){let t=re(e);if(t.status===429||t.responseCode==="translation_rate_limited"){let r=t.retryAfterSeconds;return r!==void 0&&r>0?o.t("reviews_translate_rate_limited_wait",{seconds:r}):o.t("reviews_translate_rate_limited")}return t.responseCode==="translation_refused"?o.t("reviews_translate_refused"):o.t("reviews_translate_failed")}function Ze(e,t){if(!o.pluginConfig.ReviewTranslationEnabled||!t.trim())return;let r=We();r&&Promise.all([Xe(r.browser),o.pluginConfig.ReviewTranslationServer?Ge().then(n=>n.includes(r.server),n=>(console.warn(`${w} Translation languages unavailable; asking again on the next render.`,n),!1)):!1]).then(([n,i])=>{if(!n&&!i)return;let u=e.querySelector(".tmdb-review-text"),p=u?.parentElement;if(!u||!p)return;let h=document.createElement("span");h.className="je-review-translate";let j=Object.assign(document.createElement("span"),{className:"je-msym-rounded",textContent:"translate"});j.setAttribute("aria-hidden","true");let f=Object.assign(document.createElement("span"),{className:"je-review-translate-label"});h.append(j,f);let m=g=>{f.textContent=o.t(g)};m("reviews_translate"),p.appendChild(h);let $=async g=>{if(n)try{return await Ye(g,r.browser)}catch(x){if(!i)throw x}let S=await o.core.api.plugin("/translate",{method:"POST",body:{text:g,target:r.server},skipRetry:!0}),c=C(D(S,"text"));if(c===void 0)throw new Error("Invalid translation response");return c},L=async()=>{let g=await $(Me(t)),S=Pe(t);if(!S.length)return g;let c=await $(S.map(x=>x.label.replace(/\s+/g," ")).join(`
`));return Ue(g,S,c.split(`
`))},P=g=>{u.innerHTML=ge(g,u.classList.contains("expanded"))},R=!1;h.addEventListener("click",async()=>{if(!R){if(e.dataset.showTranslated==="1"){e.dataset.showTranslated="0",P(t),m("reviews_translate");return}if(e.dataset.translatedContent===void 0){R=!0,m("reviews_translating");try{e.dataset.translatedContent=await L()}catch(g){m("reviews_translate"),o.toast(Qe(g));return}finally{R=!1}}e.dataset.showTranslated="1",P(e.dataset.translatedContent??""),m("reviews_show_original")}})})}function et(e,t,r,n){let i=document.createElement("div");i.className="tmdb-review-card je-user-review-card";let u=e.content||"",p=de(e.updatedAt)||de(e.createdAt),h=e.rating?`<span class="tmdb-review-rating je-user-review-rating">${De(e.rating)}</span>`:"",j=Q().getUrl(`/Users/${te(e.userId)}/Images/Primary`)+"?width=48&quality=90",f=ue(e.userId,t.id),m=!f&&t.isAdmin,$=A("reviews_edit","Edit"),L=A("reviews_delete","Delete"),P=A("reviews_admin_delete","Delete as admin"),R="";f?R=`
                <div class="je-user-review-actions">
                    <button class="je-review-btn je-review-edit-btn" title="${k($)}"><span class="material-icons" aria-hidden="true">edit</span></button>
                    <button class="je-review-btn je-review-delete-btn" title="${k(L)}"><span class="material-icons" aria-hidden="true">delete</span></button>
                </div>`:m&&(R=`
                <div class="je-user-review-actions">
                    <button class="je-review-btn je-review-delete-btn je-review-admin-delete-btn" title="${k(P)}"><span class="material-icons" aria-hidden="true">delete</span></button>
                </div>`),i.innerHTML=`
                <div class="tmdb-review-header je-user-review-header">
                    <div class="je-user-review-avatar-wrapper">
                        <img class="je-user-avatar" src="${k(j)}" alt="">
                    </div>
                    <div class="tmdb-review-author-info">
                        <strong class="tmdb-review-author">${k(e.userName||"User")}</strong>
                        <span class="tmdb-review-date">${k(p)}</span>
                    </div>
                    ${h}
                    ${R}
                </div>
                ${u.length>0?`
                <div class="tmdb-review-content-wrapper">
                    <p class="tmdb-review-text"></p>
                </div>`:""}
            `;let g=i.querySelector(".je-user-avatar");g&&(g.onerror=()=>{g.style.display="none"});let S=i.querySelector(".tmdb-review-text");return S&&(S.innerHTML=ge(u,!1)),i.dataset.fullContent=u,f?(i.querySelector(".je-review-edit-btn")?.addEventListener("click",()=>r(e)),i.querySelector(".je-review-delete-btn")?.addEventListener("click",()=>n(e))):m&&i.querySelector(".je-review-admin-delete-btn")?.addEventListener("click",()=>n(e)),i}function tt(e,t,r){let n=document.createElement("div");n.className="je-review-form";let i=e?.rating||0;n.innerHTML=`
                ${e?"":`<h4 class="je-review-form-title">${o.t("reviews_add")}</h4>`}
                <div class="je-review-star-picker" role="radiogroup">
                    ${[1,2,3,4,5].map(c=>`<button class="je-star-btn" data-value="${c}" type="button" aria-label="${c} stars">${Ee(0)}</button>`).join("")}
                    <button class="je-star-clear-btn" type="button"><span class="material-icons" aria-hidden="true">close</span></button>
                    <span class="je-star-label"></span>
                </div>
                <textarea class="je-review-textarea" maxlength="2000">${k(e?.content||"")}</textarea>
                <div class="je-review-char-counter"><span class="je-review-char-count">${e?.content?.length||0}</span>/2000</div>
                <div class="je-review-form-btns">
                    <button class="je-review-btn je-review-submit-btn" type="button"><span class="material-icons" aria-hidden="true">save</span></button>
                    <button class="je-review-btn je-review-cancel-btn" type="button"><span class="material-icons" aria-hidden="true">close</span></button>
                </div>
                <div class="je-review-form-error" aria-live="polite"></div>
            `;let u=n.querySelectorAll(".je-star-btn"),p=c=>{let x=n.querySelector(c);if(!x)throw new Error(`Review form is missing ${c}`);return x},h=p(".je-star-clear-btn"),j=p(".je-star-label"),f=p(".je-review-textarea"),m=p(".je-review-char-count"),$=p(".je-review-submit-btn"),L=p(".je-review-cancel-btn"),P=p(".je-review-form-error"),R=c=>{u.forEach(x=>{let W=parseInt(x.dataset.value??"0",10),G=Math.round(Math.max(0,Math.min(1,c-(W-1)))*100),X=x.querySelector(".je-star-icon-fill");X&&(X.style.clipPath=`inset(0 ${100-G}% 0 0)`)})},g=c=>{i=c,R(c),j.textContent=i>0?`${i}/5`:""},S=(c,x)=>{let W=parseInt(c.dataset.value??"0",10),G=c.getBoundingClientRect();return x-G.left<G.width/2?W-.5:W};return g(i),u.forEach(c=>{c.addEventListener("click",x=>g(S(c,x.clientX))),c.addEventListener("mousemove",x=>R(S(c,x.clientX))),c.addEventListener("mouseleave",()=>R(i))}),h.addEventListener("click",()=>g(0)),f.addEventListener("input",()=>{m.textContent=String(f.value.length)}),$.addEventListener("click",async()=>{let c=f.value.trim();if(!c&&!i){P.textContent=o.t("reviews_form_error_empty");return}P.textContent="",$.disabled=!0,$.innerHTML='<span class="material-icons" aria-hidden="true">hourglass_empty</span>';try{await t(c,i||null)}catch{P.textContent=o.t("reviews_form_error_save"),$.disabled=!1,$.innerHTML='<span class="material-icons" aria-hidden="true">save</span>'}}),L.addEventListener("click",r),n}function rt(e,t){let r=Be(t);if(e.querySelector(".je-avg-user-rating-chip")?.remove(),!r)return;let n=document.createElement("div");n.className="mediaInfoCriticRating mediaInfoItem je-avg-user-rating-chip",n.title=A("reviews_avg_rating_tooltip","Average rating from {count} user(s)",{count:r.count}),n.innerHTML=`<span class="je-msym-rounded starIcon" aria-hidden="true" style="color:#e91e8c;">person_heart</span>${k(r.display)}`;let i=e.querySelector(".mediaInfoCriticRating")||e.querySelector(".starRatingContainer");i?.parentNode?i.parentNode.insertBefore(n,i.nextSibling):e.querySelector(".mediaInfoItems")?.appendChild(n)}function nt(e,t,r,n,i){N(r);let u=t??[],p=d&&t===null;d&&u.length>0&&rt(r,u);let{tmdbKey:h,apiMediaType:j}=n,f=u.find(E=>ue(E.userId,i.id)),m=document.createElement("details");m.className="detailSection tmdb-reviews-section";let $=he(o.session,xe()||"",r),L=()=>m.isConnected&&$.current();o.currentSettings?.reviewsExpandedByDefault&&m.setAttribute("open","");let P=(e?e.length:0)+u.length,R=document.createElement("summary");R.className="sectionTitle",R.innerHTML=`${o.t("reviews_title",{count:P})} <i class="material-icons expand-icon">expand_more</i>`,m.appendChild(R);let g=document.createElement("div");g.className="je-review-action-bar";let S=null;p?g.appendChild(Object.assign(document.createElement("div"),{className:"je-review-unavailable",textContent:A("reviews_user_unavailable","User reviews couldn't be loaded. Reload the page to try again.")})):d&&!f&&(S=document.createElement("button"),S.className="je-review-btn je-review-write-btn",S.textContent=o.t("reviews_add"),g.appendChild(S)),m.appendChild(g);let c=document.createElement("div");c.className="je-review-form-placeholder",m.appendChild(c);let x=document.createElement("div");x.className="tmdb-review-swipe-container";let W=E=>{if(!L())return;c.replaceChildren();let U=tt(E,async(q,z)=>{L()&&(await F(h,j,q,z),L()&&fe(r))},()=>{c.replaceChildren()});c.appendChild(U),m.setAttribute("open",""),U.querySelector(".je-review-textarea")?.focus()},G=async E=>{if(!L())return;let U=ue(E.userId,i.id),q=E.userName||"user",z=U?A("reviews_delete_title","Delete review"):A("reviews_admin_delete_title","Delete review (admin)"),ie=U?A("reviews_delete_confirm","Delete your review for this item?"):A("reviews_admin_delete_confirm","Delete this review by {user}? This cannot be undone.",{user:q});if(!(!await ee(ie,z)||!L()))try{U?await me(h,j):await ne(E.userId,h,j),L()&&fe(r)}catch(se){if(!L())return;console.error(`${w} Delete failed`,se);let ct=A("reviews_delete_error_title","Delete failed"),dt=A("reviews_delete_error_body","Could not delete the review: {err}",{err:re(se).message||"Unknown error"});Ke(dt,ct),fe(r)}};for(let E of u)x.appendChild(et(E,i,U=>W(U),G));for(let E of(e??[]).slice(0,10))x.appendChild(Ve(E));m.appendChild(x),S?.addEventListener("click",()=>{c.querySelector(".je-review-form")?c.replaceChildren():W(f||null)}),x.addEventListener("click",E=>{let U=E.target;if(!(U instanceof Element)||!U.classList.contains("tmdb-review-toggle"))return;let q=U.parentElement,z=q?.closest(".tmdb-review-card");if(!q||!z)return;let ie=(z.dataset.showTranslated==="1"?z.dataset.translatedContent:z.dataset.fullContent)||"",se=q.classList.toggle("expanded");q.innerHTML=se?I(ie)+pe("reviews_read_less"):I(ie.substring(0,ke))+pe("reviews_read_more")}),m.addEventListener("toggle",()=>{if(L())try{let E=o.currentSettings=o.currentSettings||o.loadSettings?.()||{};E.reviewsExpandedByDefault!==m.open&&(E.reviewsExpandedByDefault=m.open,typeof o.saveUserSettings=="function"&&o.saveUserSettings("settings.json",E))}catch(E){console.error(`${w} Failed to persist reviews expanded state`,E)}});let X=r.querySelector(".streaming-lookup-container")||r.querySelector(".itemExternalLinks")||r.querySelector(".tagline");X?.parentNode?X.parentNode.insertBefore(m,X.nextSibling):console.error(`${w} Could not find a suitable anchor to insert reviews.`)}async function it(e,t,r){if(!e)return null;if(t==="Movie"||t==="Series"){let i=e.ProviderIds.Tmdb;return i?{tmdbKey:i,apiMediaType:t==="Movie"?"movie":"tv"}:null}if(t!=="Season"&&t!=="Episode")return null;let n=e.SeriesProviderIds.Tmdb;if(!n&&e.SeriesId)try{n=(await r(e.SeriesId))?.ProviderIds.Tmdb}catch{}return!n||e.IndexNumber==null?null:t==="Season"?{tmdbKey:`${n}:s${e.IndexNumber}`,apiMediaType:"tv"}:e.ParentIndexNumber==null?null:{tmdbKey:`${n}:s${e.ParentIndexNumber}:e${e.IndexNumber}`,apiMediaType:"tv"}}async function st(){let e=Q(),t=null;try{t=e.getCurrentUser?await e.getCurrentUser():null}catch{t=null}return{id:C(D(t,"Id"))||e.getCurrentUserId()||"",isAdmin:Ie(D(D(t,"Policy"),"IsAdministrator"))===!0}}async function $e(e,t,r=!1){let n=xe(),i=ve();if(!n||!i)return;let u=he(o.session,n,e),p={};H.set(e,p);let h=()=>u.current()&&H.get(e)===p,j=await ye(o.helpers,n,!0,i);if(!h())return;let f=j?.Type;if(!j||!f){N(e),T.delete(e);return}if(await M(j,f)){h()&&(N(e),T.delete(e));return}if(!h()||!r&&T.get(e)?.current()&&e.querySelector(".tmdb-reviews-section"))return;let m=await it(j,f,g=>t(i,g));if(!m||!f||!h())return;let[$,L,P]=await Promise.all([_(j,m.tmdbKey,f),d?O(m.tmdbKey,m.apiMediaType):Promise.resolve([]),st()]);if(!h())return;nt($,L,e,m,P),T.set(e,u);let R=Je.peer("invalidateUserReviewTagCache");typeof R=="function"&&R(m.tmdbKey)}async function fe(e){try{await $e(ae()||e,async(t,r)=>Le(await Q().getItem(t,r)),!0)}catch(t){console.error(`${w} Failed to refresh reviews:`,t)}}async function ot(e){if(e){T.get(e)?.current()||(N(e),T.delete(e));try{await $e(e,(t,r)=>ye(o.helpers,r,!0,t))}catch(t){console.error(`${w} Error processing page:`,t)}}}function at(){let e="tmdb-reviews-enhanced-styles";if(document.getElementById(e))return;let t=document.createElement("style");t.id=e,t.textContent=mt,document.head.appendChild(t)}at();let lt=o.helpers.onViewPage(async(e,t,r)=>{if(!o.pluginConfig.ShowReviews&&!o.pluginConfig.ShowUserReviews&&!o.pluginConfig.ShowAnilistReviews){lt?.();return}let n=window.location.hash.includes("id=")||typeof r=="string"&&r.includes("id="),i=!!t&&(t.id==="itemDetailPage"||t.classList.contains("itemDetailPage"));if(!n&&!i)return;await new Promise(p=>setTimeout(p,150));let u=ae();u&&ot(u)},{pages:null,fetchItem:!1,immediate:!0})};var mt=`
                .je-msym-rounded {
                    font-family: 'JE Material Symbols Rounded';
                    font-weight: normal;
                    font-style: normal;
                    line-height: 1;
                    letter-spacing: normal;
                    text-transform: none;
                    display: inline-block;
                    white-space: nowrap;
                    word-wrap: normal;
                    direction: ltr;
                    -webkit-font-feature-settings: 'liga';
                    font-feature-settings: 'liga';
                    -webkit-font-smoothing: antialiased;
                }
                /* Some themes style .detailSection as a grid, and a flex/grid
                   item's default min-width is auto — so this section's
                   horizontally-scrolling card row can report its full
                   unscrolled width as intrinsic size and blow out past the
                   viewport. width:100%+min-width:0 here and on the swipe
                   container below keep both pinned to the available width. */
                .tmdb-reviews-section { margin: 2em 0 1em 0; display: flex !important; flex-direction: column; width: 100%; min-width: 0;}
                .tmdb-reviews-section summary { cursor: pointer; display: flex; align-items: center; justify-content: space-between; user-select: none; -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none; -webkit-tap-highlight-color: transparent;}
                .tmdb-reviews-section summary .expand-icon { color: rgba(255, 255, 255,.8);transition: transform 0.2s ease-in-out;}
                .tmdb-reviews-section[open] summary .expand-icon { transform: rotate(180deg);}
                .tmdb-review-swipe-container {
                    display: flex;
                    overflow-x: auto;
                    gap: 1.2em;
                    padding: 1em 0.5em;
                    scroll-snap-type: x mandatory;
                    width: 100%;
                    min-width: 0;
                }
                .tmdb-review-card {
                    flex: 0 0 85%;
                    max-width: 500px;
                    background: rgba(0, 0, 0, 0.3);
                    border-radius: 8px;
                    border-left: 4px solid rgb(1, 180, 228);
                    padding: 1.5em;
                    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
                    scroll-snap-align: start;
                    display: flex;
                    flex-direction: column;
                }
                .je-anilist-review-card { border-left-color: rgb(61, 180, 242); }
                .je-review-source { color: rgb(1, 180, 228); display: inline-flex; align-items: center; gap: 0.3em; }
                .je-anilist-review-card .je-review-source { color: rgb(61, 180, 242); }
                .je-review-source-logo { width: 1.1em; height: 1.1em; border-radius: 3px; }
                .je-user-review-card {
                    border-left-color: rgb(94, 213, 95);
                    background: rgba(10, 26, 10, 0.52);
                }
                @media (min-width: 768px) { .tmdb-review-card { flex-basis: 400px; } }
                .tmdb-review-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1em; }
                .je-user-review-header { align-items: center; gap: 0.75em; }
                .tmdb-review-author-info { display: flex; flex-direction: column; gap: 0.3em; flex: 1; }
                .tmdb-review-author { color: #fff; font-size: 1.1em; font-weight: 600; }
                .tmdb-review-date { color: #aaa; font-size: 0.9em; display: flex; align-items: center; gap: 0.4em; }
                .tmdb-review-rating { display: inline-flex; align-items: center; color: #ffd700; background: rgba(255, 215, 0, 0.1); padding: 0.2em 0.5em; border-radius: 4px; gap: 0.2em;}
                .je-user-review-rating {
                    white-space: nowrap;
                    background: rgba(94, 213, 95, 0.12);
                    color: #ffd700;
                }
                .je-user-star-rating { display: inline-flex; align-items: center; gap: 0.02em; }
                .je-star-icon { position: relative; display: inline-block; width: 1em; height: 1em; color: rgba(255, 255, 255, 0.28); }
                .je-star-icon svg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: block; }
                .je-star-icon-fill { color: #ffd700; }
                .je-user-star-rating .je-star-icon { width: 1.05em; height: 1.05em; vertical-align: middle; }
                .tmdb-review-content-wrapper { flex-grow: 1; line-height: 1.7; overflow-y: auto; color: #ddd; font-size: 0.95em; }
                .tmdb-review-text { word-wrap: break-word; }
                .tmdb-review-text strong { color: #fff; font-weight: 600; }
                .tmdb-review-text em { font-style: italic; color: #e0e0e0; }
                .tmdb-review-text del { text-decoration: line-through; opacity: 0.7; }
                .tmdb-review-text code { background: rgba(255, 255, 255, 0.1); padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 0.9em; color: #ffa500; }
                .tmdb-review-text blockquote { border-left: 3px solid rgb(1, 180, 228); padding-left: 1em; margin: 0.8em 0; color: #aaa; font-style: italic; }
                .tmdb-review-text h1, .tmdb-review-text h2, .tmdb-review-text h3, .tmdb-review-text h4, .tmdb-review-text h5, .tmdb-review-text h6 { color: #fff; margin: 0.8em 0 0.4em 0; font-weight: 600; }
                .tmdb-review-text h1 { font-size: 1.5em; }
                .tmdb-review-text h2 { font-size: 1.3em; }
                .tmdb-review-text h3 { font-size: 1.15em; }
                .tmdb-review-text h4, .tmdb-review-text h5, .tmdb-review-text h6 { font-size: 1.05em; }
                .tmdb-review-text ul, .tmdb-review-text ol { margin: 0.5em 0; padding-left: 1.5em; }
                .tmdb-review-text li { margin: 0.3em 0; }
                .tmdb-review-text hr { border: none; border-top: 1px solid rgba(255, 255, 255, 0.2); margin: 1em 0; }
                .tmdb-review-text a { color: rgb(1, 180, 228); text-decoration: underline; }
                .tmdb-review-text a:hover { color: rgb(50, 200, 250); }
                /* emby-linkbutton gives links button padding, margin and weight, which breaks line spacing */
                .tmdb-review-text a[is="emby-linkbutton"] { display: inline !important; padding: 0 !important; margin: 0 !important; min-width: 0 !important; font-weight: inherit !important; vertical-align: baseline !important; }
                .tmdb-review-toggle { color: rgb(1, 180, 228); font-weight: bold; cursor: pointer; text-decoration: underline; margin-left: 0.3em; }
                .je-review-translate { display: inline-flex; align-items: center; gap: 0.3em; margin-top: 0.5em; color: rgb(1, 180, 228); font-size: 0.9em; cursor: pointer; }
                .je-review-translate .je-msym-rounded { font-size: 1.3em; }
                .je-review-translate-label { text-decoration: underline; }

                /* User avatar */
                .je-user-avatar-wrapper { flex-shrink: 0; }
                .je-user-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 2px solid rgb(94, 213, 95); display: block; }

                /* Action bar */
                .je-review-action-bar { padding: 0.5em 0.5em 0; display: flex; gap: 0.75em; } .je-review-unavailable { opacity: 0.75; font-size: 0.9em; }
                .je-user-review-actions { display: flex; gap: 0.5em; flex-shrink: 0; }

                /* Shared button style */
                .je-review-btn {
                    background: rgba(255,255,255,0.08);
                    border: 1px solid rgba(255,255,255,0.15);
                    border-radius: 6px;
                    color: #fff;
                    cursor: pointer;
                    font-size: 0.85em;
                    padding: 0.35em 0.9em;
                    transition: background 0.15s;
                }
                .je-review-btn:hover { background: rgba(255,255,255,0.15); }
                .je-review-write-btn { border-color: rgb(94, 213, 95); color: rgb(94, 213, 95); }
                .je-review-write-btn:hover { background: rgba(94, 213, 95, 0.15); }
                .je-review-edit-btn, .je-review-delete-btn, .je-review-submit-btn, .je-review-cancel-btn {
                    width: 2.4em;
                    height: 2.4em;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    padding: 0;
                }
                .je-review-edit-btn .material-icons, .je-review-delete-btn .material-icons, .je-review-submit-btn .material-icons, .je-review-cancel-btn .material-icons, .je-star-clear-btn .material-icons { font-size: 18px; }
                .je-review-edit-btn { border-color: rgb(94, 213, 95); color: rgb(94, 213, 95); }
                .je-review-delete-btn { border-color: rgb(244, 67, 54); color: rgb(244, 67, 54); }
                .je-review-delete-btn:hover { background: rgba(244, 67, 54, 0.15); }

                /* Inline review form */
                .je-review-form-placeholder { padding: 0 0.5em; }
                .je-review-form {
                    background: rgba(0,0,0,0.4);
                    border: 1px solid rgba(94, 213, 95, 0.4);
                    border-radius: 8px;
                    padding: 1.2em;
                    margin: 0.75em 0;
                    display: flex;
                    flex-direction: column;
                    gap: 0.75em;
                }
                .je-review-form-title { margin: 0; font-size: 1em; color: #fff; font-weight: 600; }
                .je-review-star-picker { display: flex; align-items: center; gap: 0.3em; }
                .je-star-btn {
                    display: inline-flex;
                    align-items: center;
                    background: none;
                    border: none;
                    cursor: pointer;
                    padding: 0;
                    line-height: 1;
                    transition: transform 0.1s;
                }
                .je-star-btn .je-star-icon { width: 1.6em; height: 1.6em; pointer-events: none; }
                .je-star-btn:hover { transform: scale(1.2); }
                .je-star-clear-btn {
                    background: rgba(255,255,255,0.08);
                    border: 1px solid rgba(255,255,255,0.15);
                    border-radius: 6px;
                    cursor: pointer;
                    color: rgba(255,255,255,0.7);
                    width: 2.2em;
                    height: 2.2em;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    padding: 0;
                }
                .je-star-clear-btn:hover { background: rgba(255,255,255,0.15); }
                .je-star-label { color: #ffd700; font-size: 0.9em; margin-left: 0.25em; min-width: 2.5em; }
                .je-review-textarea {
                    width: 100%;
                    min-height: 100px;
                    resize: vertical;
                    background: rgba(255,255,255,0.06);
                    border: 1px solid rgba(255,255,255,0.15);
                    border-radius: 6px;
                    color: #fff;
                    font-size: 0.95em;
                    padding: 0.6em 0.8em;
                    box-sizing: border-box;
                    font-family: inherit;
                    line-height: 1.5;
                }
                .je-review-textarea:focus { outline: none; border-color: rgb(94, 213, 95); }
                .je-review-char-counter { font-size: 0.8em; color: rgba(255,255,255,0.4); text-align: right; }
                .je-review-form-btns { display: flex; gap: 0.75em; }
                .je-review-submit-btn { border-color: rgb(94, 213, 95); color: rgb(94, 213, 95); }
                .je-review-submit-btn:hover { background: rgba(94, 213, 95, 0.15); }
                .je-review-submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
                .je-review-form-error { color: rgb(244, 67, 54); font-size: 0.85em; min-height: 1em; }

                /* Average user rating chip in item details */
                .je-avg-user-rating-chip .starIcon { color: #e91e8c !important; }
                /* Remove the padding coming from using critic rating container */
                .je-avg-user-rating-chip { padding-left: 0 !important; }
                /* Remove the % added by ElegantFin Theme */
                .mediaInfoCriticRating.mediaInfoItem.je-avg-user-rating-chip::after {
                    content: "";
                }
            `;})();
})();
