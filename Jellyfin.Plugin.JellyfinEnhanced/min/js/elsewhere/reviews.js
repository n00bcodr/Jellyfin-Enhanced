(() => {
"use strict";(()=>{function X(a){let i=window.JellyfinEnhanced?.core?.sharedModules?.[a];if(!i)throw new Error(`${a} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);return i}function v(a,i){return a[i]}var Y=X("features/details-providers/host"),Q=v(Y,"api"),Se=v(Y,"bridge"),ve=v(Y,"browserTranslator"),be=v(Y,"currentUserId"),oe=v(Y,"dashboard"),Me=v(Y,"detailsContext");var ae=X("features/details-providers/page");var he=v(ae,"detailsLease");var xe=v(ae,"hashItemId");var ye=v(ae,"lookupDetailsItem");var le=v(ae,"visibleDetailPage");function te(a){return encodeURIComponent(a)}var B=X("features/details-providers/wire"),Re=v(B,"bool"),$e=v(B,"decodeDetailsItem");var ne=v(B,"errorShape"),N=v(B,"field");var ce=v(B,"isRecord"),Z=v(B,"list"),de=v(B,"num");var M=v(B,"str");var Ie=v(B,"text");function Ee(a){let i=String(a).replace(/<a\s[^>]*?href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,"[$2]($1)").replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi,"**$2**").replace(/<(em|i)>([\s\S]*?)<\/\1>/gi,"*$2*").replace(/<br\s*\/?>/gi,`
`).replace(/<\/p>\s*<p[^>]*>/gi,`

`),l;do l=i,i=i.replace(/<\/?[a-z][^>]*>/gi,"");while(i!==l);return i}function _e(a){return Ee(a).replace(/\[([^\]]+)\]\(https?:\/\/[^)\s]+\)/g,"$1").replace(/https?:\/\/[^\s<]+/g,"").replace(/(\*\*|__|~~|\*|`)/g,"").replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g,"$1$2").replace(/[ \t]+/g," ").replace(/ ?\n ?/g,`
`).trim()}function He(a){let i=[];for(let l of Ee(a).matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g))l[1]!==void 0&&l[2]!==void 0&&i.push({label:l[1],url:l[2]});return i}function Pe(a,i,l){if(l.length!==i.length)return a;let d=a,y=[];return i.forEach((w,I)=>{let D=d.toLowerCase(),T=[w.label,l[I]||""].map(_=>_.trim().replace(/[[\]]/g,"")).find(_=>_&&D.includes(_.toLowerCase()));if(!T)return;let R=D.indexOf(T.toLowerCase());y.push(`[${d.substr(R,T.length)}](${w.url})`),d=`${d.slice(0,R)}${y.length-1}${d.slice(R+T.length)}`}),d.replace(/\u0001(\d+)\u0002/g,(w,I)=>y[Number(I)]??"")}function Ae(a,i){if(!a)return"";let l=i(Ee(a)),d="\0JE";for(;l.includes(d);)d+="J";let y=[],w=C=>`${d}${y.push(C)-1}\0`,I=C=>C.replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>").replace(/__(.+?)__/g,"<strong>$1</strong>").replace(/\*(.+?)\*/g,"<em>$1</em>").replace(/_(.+?)_/g,"<em>$1</em>").replace(/~~(.+?)~~/g,"<del>$1</del>"),D=(C,b)=>`<a is="emby-linkbutton" href="${b}" target="_blank" rel="noopener noreferrer">${C}</a>`;l=l.replace(/`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<]+)/gi,(C,b,q,O,pe)=>{if(b!==void 0)return w(`<code>${b}</code>`);if(q!==void 0&&O!==void 0)return w(D(I(q),O));let re=pe??"",ee=re.replace(/[.,;!?)]+$/,"");return w(D(ee,ee))+re.slice(ee.length)}),l=I(l);let T=l.split(/\r?\n/),R=[],_=!1,U=[],K=!1,J=[];for(let C of T){let b=C.trim();if(b.startsWith("&gt; ")){_||(_=!0,U=[]),U.push(b.substring(5));continue}else _&&(R.push("<blockquote>"+U.join("<br>")+"</blockquote>"),_=!1,U=[]);if(/^[-*]\s+/.test(b)){K||(K=!0,J=[]),J.push("<li>"+b.substring(2)+"</li>");continue}else K&&(R.push("<ul>"+J.join("")+"</ul>"),K=!1,J=[]);let q=/^(#{1,6})\s/.exec(b);if(q?.[1]){let O=/^#+/.exec(b)?.[0].length??q[1].length;R.push(`<h${O}>${b.substring(O+1)}</h${O}>`);continue}if(/^([-*]){3,}$/.test(b)){R.push("<hr>");continue}R.push(b?C:"<br>")}return _&&R.push("<blockquote>"+U.join("<br>")+"</blockquote>"),K&&R.push("<ul>"+J.join("")+"</ul>"),y.reduce((C,b,q)=>C.split(`${d}${q}\0`).join(b),R.join(""))}var Ce='<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>';function je(a){let i=Math.round(Math.max(0,Math.min(1,a))*100);return`<span class="je-star-icon" aria-hidden="true">
                <svg class="je-star-icon-base" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${Ce}</svg>
                <svg class="je-star-icon-fill" style="clip-path: inset(0 ${100-i}% 0 0);" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${Ce}</svg>
            </span>`}function Ne(a){return a?`<span class="je-user-star-rating">${Array.from({length:5},(l,d)=>je(Math.max(0,Math.min(1,a-d)))).join("")}</span>`:""}function ue(a){return a?new Date(a).toLocaleDateString(void 0,{year:"numeric",month:"short",day:"numeric"}):""}function Ue(a){return Z(N(a,"results")).filter(ce).map(i=>({author:M(i.author),created_at:M(i.created_at),content:M(i.content),rating:de(N(i.author_details,"rating"))??null,url:M(i.url)}))}function De(a){return Z(N(a,"Reviews")).filter(ce).map(i=>{let l=M(i.Content),d=M(i.Summary),y=de(i.Score);return{source:"anilist",author:Ie(i.Author)||"Anonymous",created_at:M(i.CreatedAt),content:d?`**${d}**

${l}`:l,rating:y?Number((y/10).toFixed(1)):null,url:M(i.Url)}})}function qe(a){return Z(N(a,"reviews")).filter(ce).map(i=>({userId:M(i.userId)??"",userName:M(i.userName),content:M(i.content),rating:de(i.rating)??null,createdAt:M(i.createdAt),updatedAt:M(i.updatedAt)}))}var me=(a,i)=>a.replace(/-/g,"")===i.replace(/-/g,"");function Be(a){let i=a.filter(d=>!!d.rating);if(i.length===0)return null;let l=i.reduce((d,y)=>d+y.rating,0)/i.length*2;return{display:Number.isInteger(l)?`${l}`:`${l.toFixed(1)}`,count:i.length}}function Oe(a){let[i,l]=a.split("-"),d=(i||"").toLowerCase();if(!d||d==="en")return null;let y=d==="zh"&&/^(tw|hk|mo)$/i.test(l||"");return{server:y?"zt":d,browser:y?"zh-Hant":d}}function Fe(a,i){let l=a;if(i)for(let[d,y]of Object.entries(i))l=l.replace(new RegExp(`\\{${d}\\}`,"g"),()=>String(y));return l}function ze(a){let i=null;return()=>{if(i)return i;let l=i=a();return l.catch(()=>{i===l&&(i=null)}),l}}var o=Se("Reviews"),Ke=Me(o),Te=350;o.initializeReviewsScript=function(){let i=o.pluginConfig,l=i.ShowReviews&&i.TmdbEnabled,d=i.ShowUserReviews,y=i.ShowAnilistReviews;if(!l&&!d&&!y){console.log("🪼 Jellyfin Enhanced: Reviews feature disabled.");return}let w="🪼 Jellyfin Enhanced: Reviews:",I=new WeakMap,D=new WeakMap;o.session?.onUserChange("details-reviews",()=>{document.querySelectorAll(".tmdb-reviews-section, .je-avg-user-rating-chip").forEach(e=>e.remove()),I=new WeakMap,D=new WeakMap});let T=e=>o.escapeHtml(e),R=e=>Ae(e,T);async function _(e,t){try{if(t!=="Series"&&t!=="Movie"&&t!=="Season"&&t!=="Episode"||!o.pluginConfig.SpoilerBlurEnabled||o.pluginConfig.SpoilerStripReviews===!1)return!1;let n=Ke.peer("spoilerBlur");if(!n)return!1;if(typeof n.whenLoaded=="function"&&await n.whenLoaded(),typeof n.isLoadOk=="function"&&!n.isLoadOk())return console.warn(`${w} Spoiler Guard state load failed; suppressing reviews fail-closed.`),!0;if(typeof n.getUserPrefs=="function"&&(n.getUserPrefs()||{}).HideReviews===!1)return!1;if(t==="Movie"){let s=n.isMovieInScope;if(typeof s!="function")throw new TypeError("Spoiler Guard movie scope unavailable");return await s.call(n,e?.Id||"")}let r=t==="Series"?e?.Id||"":e?.SeriesId||"";return!!(n.isEnabledFor&&n.isEnabledFor(r))}catch(n){return console.warn(`${w} Spoiler Guard check failed; suppressing reviews:`,n),!0}}function U(e){try{let t=e||le()||document;t.querySelector(".tmdb-reviews-section")?.remove(),t.querySelector(".je-avg-user-rating-chip")?.remove()}catch(t){console.warn(`${w} removeReviewsSection failed:`,t)}}function K(e,t){let n=t==="Series"?"tv":"movie",r=te(e),s=`/${n}/${r}/reviews?language=en-US&page=1`,u=`${Q().getUrl(`/JellyfinEnhanced/tmdb/${n}/${r}/reviews`)}?language=en-US&page=1`;return o.core.api.fetch(u,{cacheKey:`tmdb:${s}`}).then(Ue).catch(p=>(console.error(`${w} Failed to fetch reviews.`,p),null))}function J(e){let t=e?.ProviderIds,n=parseInt(t?.AniList||t?.Anilist||"",10);if(!n)return Promise.resolve(null);let r=`anilistId=${n}`;return o.core.api.fetch(`${Q().getUrl("/JellyfinEnhanced/anilist/reviews")}?${r}`,{cacheKey:`anilist:${r}`}).then(De).catch(s=>(console.error(`${w} Failed to fetch AniList reviews.`,s),null))}async function C(e,t,n){if(n!=="Movie"&&n!=="Series")return null;let[r,s]=await Promise.all([l?K(t.split(":")[0]??"",n):null,y?J(e):null]);return r||s?[...r||[],...s||[]]:null}let b=e=>e.split(":").map(te).join(":");function q(e,t){return o.core.api.plugin(`/reviews/${t}/${b(e)}`).then(qe).catch(n=>(console.error(`${w} Failed to fetch user reviews.`,n),null))}async function O(e,t,n,r){try{return await o.core.api.plugin(`/reviews/${t}/${b(e)}`,{method:"POST",body:{content:n,rating:r||null},skipRetry:!0})}catch(s){let u=ne(s);throw new Error(u.responseMessage||u.message)}}async function pe(e,t){await o.core.api.plugin(`/reviews/${t}/${b(e)}`,{method:"DELETE",skipRetry:!0})}async function re(e,t,n){let r=(e||"").replace(/-/g,"");try{await o.core.api.plugin(`/reviews/admin/${te(r)}/${n}/${b(t)}`,{method:"DELETE",skipRetry:!0})}catch(s){throw ne(s).status===404?new Error("No matching review to delete (it may have already been removed)."):s}}function ee(e,t){return new Promise(n=>{let r=oe();if(r&&typeof r.confirm=="function")try{r.confirm(e,t,n);return}catch(s){console.warn(`${w} Dashboard.confirm threw, falling back:`,s)}n(window.confirm(t?`${t}

${e}`:e))})}function Je(e,t){let n=oe();if(n&&typeof n.alert=="function")try{n.alert({title:t||"",message:e||""});return}catch(r){console.warn(`${w} Dashboard.alert threw, falling back:`,r)}window.alert(t?`${t}

${e}`:e)}let ke=new Set;function A(e,t,n){let r;try{r=o.t(e,n)}catch(s){console.warn(`${w} JE.t('${e}') threw, using fallback:`,s),r=null}return!r||r===e?(ke.has(e)||(ke.add(e),console.warn(`${w} Missing translation key '${e}', using inline fallback.`)),Fe(t,n)):r}let fe=e=>`<span class="tmdb-review-toggle">${o.t(e)}</span>`;function ge(e,t){let n=e.length>Te;return R(n&&!t?e.substring(0,Te):e)+(n?fe(t?"reviews_read_less":"reviews_read_more"):"")}function Ve(e){let t=document.createElement("div");t.className="tmdb-review-card";let n=e.source==="anilist";n&&t.classList.add("je-anilist-review-card"),t.dataset.fullContent=e.content||"";let r=e.content||"No content available",s=ue(e.created_at),u=e.rating?`<span class="tmdb-review-rating">${o.icon(o.IconName.STAR)} ${e.rating}</span>`:"";t.innerHTML=`
                <div class="tmdb-review-header">
                    <div class="tmdb-review-author-info">
                        <strong class="tmdb-review-author">${T(e.author||"Anonymous")}</strong>
                        <span class="tmdb-review-date">${T(s)}</span>
                    </div>
                    ${u}
                </div>
                <div class="tmdb-review-content-wrapper">
                    <p class="tmdb-review-text"></p>
                </div>
            `;let p=e.url||"",h=n?/^https:\/\/anilist\.co\//.test(p)?p:"":/^https:\/\/www\.themoviedb\.org\//.test(p)?p:"",E=h?o.helpers.createExternalLink(h,{className:"je-review-source",resetStyle:!0}):Object.assign(document.createElement("span"),{className:"je-review-source"}),g=document.createElement("img");g.src=o.cdn.url("mdblist-logos",n?"anilist.png":"tmdb.png"),g.alt="",g.className="je-review-source-logo",g.loading="lazy",E.append(g,n?"AniList":"TMDB");let m=t.querySelector(".tmdb-review-date");s&&m?.append(Object.assign(document.createElement("span"),{textContent:"·"})),m?.append(E);let L=t.querySelector(".tmdb-review-text");return L&&(L.innerHTML=ge(r,!1)),Ze(t,e.content||""),t}function We(){let e="";try{e=localStorage.getItem(`${be()}-language`)||""}catch{}return Oe(e||document.documentElement.lang||"")}let Ge=ze(()=>o.core.api.plugin("/translate/languages",{skipRetry:!0}).then(e=>Z(N(e,"languages")).filter(t=>typeof t=="string")));async function Xe(e){try{let t=ve();return!window.isSecureContext||!t?!1:await t.availability({sourceLanguage:"en",targetLanguage:e})!=="unavailable"}catch{return!1}}async function Ye(e,t){let n=ve();if(!n)throw new Error("Browser translator unavailable");let r=await n.create({sourceLanguage:"en",targetLanguage:t});try{let s=[];for(let u of e.split(`
`))s.push(u.trim()?await r.translate(u):u);return s.join(`
`)}finally{r.destroy?.()}}function Qe(e){let t=ne(e);if(t.status===429||t.responseCode==="translation_rate_limited"){let n=t.retryAfterSeconds;return n!==void 0&&n>0?o.t("reviews_translate_rate_limited_wait",{seconds:n}):o.t("reviews_translate_rate_limited")}return t.responseCode==="translation_refused"?o.t("reviews_translate_refused"):o.t("reviews_translate_failed")}function Ze(e,t){if(!o.pluginConfig.ReviewTranslationEnabled||!t.trim())return;let n=We();n&&Promise.all([Xe(n.browser),o.pluginConfig.ReviewTranslationServer?Ge().then(r=>r.includes(n.server),r=>(console.warn(`${w} Translation languages unavailable; asking again on the next render.`,r),!1)):!1]).then(([r,s])=>{if(!r&&!s)return;let u=e.querySelector(".tmdb-review-text"),p=u?.parentElement;if(!u||!p)return;let h=document.createElement("span");h.className="je-review-translate";let E=Object.assign(document.createElement("span"),{className:"je-msym-rounded",textContent:"translate"});E.setAttribute("aria-hidden","true");let g=Object.assign(document.createElement("span"),{className:"je-review-translate-label"});h.append(E,g);let m=f=>{g.textContent=o.t(f)};m("reviews_translate"),p.appendChild(h);let L=async f=>{if(r)try{return await Ye(f,n.browser)}catch(x){if(!s)throw x}let S=await o.core.api.plugin("/translate",{method:"POST",body:{text:f,target:n.server},skipRetry:!0}),c=M(N(S,"text"));if(c===void 0)throw new Error("Invalid translation response");return c},$=async()=>{let f=await L(_e(t)),S=He(t);if(!S.length)return f;let c=await L(S.map(x=>x.label.replace(/\s+/g," ")).join(`
`));return Pe(f,S,c.split(`
`))},H=f=>{u.innerHTML=ge(f,u.classList.contains("expanded"))},k=!1;h.addEventListener("click",async()=>{if(!k){if(e.dataset.showTranslated==="1"){e.dataset.showTranslated="0",H(t),m("reviews_translate");return}if(e.dataset.translatedContent===void 0){k=!0,m("reviews_translating");try{e.dataset.translatedContent=await $()}catch(f){m("reviews_translate"),o.toast(Qe(f));return}finally{k=!1}}e.dataset.showTranslated="1",H(e.dataset.translatedContent??""),m("reviews_show_original")}})})}function et(e,t,n,r){let s=document.createElement("div");s.className="tmdb-review-card je-user-review-card";let u=e.content||"",p=ue(e.updatedAt)||ue(e.createdAt),h=e.rating?`<span class="tmdb-review-rating je-user-review-rating">${Ne(e.rating)}</span>`:"",E=Q().getUrl(`/Users/${te(e.userId)}/Images/Primary`)+"?width=48&quality=90",g=me(e.userId,t.id),m=!g&&t.isAdmin,L=A("reviews_edit","Edit"),$=A("reviews_delete","Delete"),H=A("reviews_admin_delete","Delete as admin"),k="";g?k=`
                <div class="je-user-review-actions">
                    <button class="je-review-btn je-review-edit-btn" title="${T(L)}"><span class="material-icons" aria-hidden="true">edit</span></button>
                    <button class="je-review-btn je-review-delete-btn" title="${T($)}"><span class="material-icons" aria-hidden="true">delete</span></button>
                </div>`:m&&(k=`
                <div class="je-user-review-actions">
                    <button class="je-review-btn je-review-delete-btn je-review-admin-delete-btn" title="${T(H)}"><span class="material-icons" aria-hidden="true">delete</span></button>
                </div>`),s.innerHTML=`
                <div class="tmdb-review-header je-user-review-header">
                    <div class="je-user-review-avatar-wrapper">
                        <img class="je-user-avatar" src="${T(E)}" alt="">
                    </div>
                    <div class="tmdb-review-author-info">
                        <strong class="tmdb-review-author">${T(e.userName||"User")}</strong>
                        <span class="tmdb-review-date">${T(p)}</span>
                    </div>
                    ${h}
                    ${k}
                </div>
                ${u.length>0?`
                <div class="tmdb-review-content-wrapper">
                    <p class="tmdb-review-text"></p>
                </div>`:""}
            `;let f=s.querySelector(".je-user-avatar");f&&(f.onerror=()=>{f.style.display="none"});let S=s.querySelector(".tmdb-review-text");return S&&(S.innerHTML=ge(u,!1)),s.dataset.fullContent=u,g?(s.querySelector(".je-review-edit-btn")?.addEventListener("click",()=>n(e)),s.querySelector(".je-review-delete-btn")?.addEventListener("click",()=>r(e))):m&&s.querySelector(".je-review-admin-delete-btn")?.addEventListener("click",()=>r(e)),s}function tt(e,t,n){let r=document.createElement("div");r.className="je-review-form";let s=e?.rating||0;r.innerHTML=`
                ${e?"":`<h4 class="je-review-form-title">${o.t("reviews_add")}</h4>`}
                <div class="je-review-star-picker" role="radiogroup">
                    ${[1,2,3,4,5].map(c=>`<button class="je-star-btn" data-value="${c}" type="button" aria-label="${c} stars">${je(0)}</button>`).join("")}
                    <button class="je-star-clear-btn" type="button"><span class="material-icons" aria-hidden="true">close</span></button>
                    <span class="je-star-label"></span>
                </div>
                <textarea class="je-review-textarea" maxlength="2000">${T(e?.content||"")}</textarea>
                <div class="je-review-char-counter"><span class="je-review-char-count">${e?.content?.length||0}</span>/2000</div>
                <div class="je-review-form-btns">
                    <button class="je-review-btn je-review-submit-btn" type="button"><span class="material-icons" aria-hidden="true">save</span></button>
                    <button class="je-review-btn je-review-cancel-btn" type="button"><span class="material-icons" aria-hidden="true">close</span></button>
                </div>
                <div class="je-review-form-error" aria-live="polite"></div>
            `;let u=r.querySelectorAll(".je-star-btn"),p=c=>{let x=r.querySelector(c);if(!x)throw new Error(`Review form is missing ${c}`);return x},h=p(".je-star-clear-btn"),E=p(".je-star-label"),g=p(".je-review-textarea"),m=p(".je-review-char-count"),L=p(".je-review-submit-btn"),$=p(".je-review-cancel-btn"),H=p(".je-review-form-error"),k=c=>{u.forEach(x=>{let V=parseInt(x.dataset.value??"0",10),W=Math.round(Math.max(0,Math.min(1,c-(V-1)))*100),G=x.querySelector(".je-star-icon-fill");G&&(G.style.clipPath=`inset(0 ${100-W}% 0 0)`)})},f=c=>{s=c,k(c),E.textContent=s>0?`${s}/5`:""},S=(c,x)=>{let V=parseInt(c.dataset.value??"0",10),W=c.getBoundingClientRect();return x-W.left<W.width/2?V-.5:V};return f(s),u.forEach(c=>{c.addEventListener("click",x=>f(S(c,x.clientX))),c.addEventListener("mousemove",x=>k(S(c,x.clientX))),c.addEventListener("mouseleave",()=>k(s))}),h.addEventListener("click",()=>f(0)),g.addEventListener("input",()=>{m.textContent=String(g.value.length)}),L.addEventListener("click",async()=>{let c=g.value.trim();if(!c&&!s){H.textContent=o.t("reviews_form_error_empty");return}H.textContent="",L.disabled=!0,L.innerHTML='<span class="material-icons" aria-hidden="true">hourglass_empty</span>';try{await t(c,s||null)}catch{H.textContent=o.t("reviews_form_error_save"),L.disabled=!1,L.innerHTML='<span class="material-icons" aria-hidden="true">save</span>'}}),$.addEventListener("click",n),r}function nt(e,t){let n=Be(t);if(e.querySelector(".je-avg-user-rating-chip")?.remove(),!n)return;let r=document.createElement("div");r.className="mediaInfoCriticRating mediaInfoItem je-avg-user-rating-chip",r.title=A("reviews_avg_rating_tooltip","Average rating from {count} user(s)",{count:n.count}),r.innerHTML=`<span class="je-msym-rounded starIcon" aria-hidden="true" style="color:#e91e8c;">person_heart</span>${T(n.display)}`;let s=e.querySelector(".mediaInfoCriticRating")||e.querySelector(".starRatingContainer");s?.parentNode?s.parentNode.insertBefore(r,s.nextSibling):e.querySelector(".mediaInfoItems")?.appendChild(r)}function rt(e,t,n,r,s){U(n);let u=t??[],p=d&&t===null;d&&u.length>0&&nt(n,u);let{tmdbKey:h,apiMediaType:E}=r,g=u.find(j=>me(j.userId,s.id)),m=document.createElement("details");m.className="detailSection tmdb-reviews-section";let L=he(o.session,xe()||"",n),$=()=>m.isConnected&&L.current();o.currentSettings?.reviewsExpandedByDefault&&m.setAttribute("open","");let H=(e?e.length:0)+u.length,k=document.createElement("summary");k.className="sectionTitle",k.innerHTML=`${o.t("reviews_title",{count:H})} <i class="material-icons expand-icon">expand_more</i>`,m.appendChild(k);let f=document.createElement("div");f.className="je-review-action-bar";let S=null;p?f.appendChild(Object.assign(document.createElement("div"),{className:"je-review-unavailable",textContent:A("reviews_user_unavailable","User reviews couldn't be loaded. Reload the page to try again.")})):d&&!g&&(S=document.createElement("button"),S.className="je-review-btn je-review-write-btn",S.textContent=o.t("reviews_add"),f.appendChild(S)),m.appendChild(f);let c=document.createElement("div");c.className="je-review-form-placeholder",m.appendChild(c);let x=document.createElement("div");x.className="tmdb-review-swipe-container";let V=j=>{if(!$())return;c.replaceChildren();let P=tt(j,async(F,z)=>{$()&&(await O(h,E,F,z),$()&&we(n))},()=>{c.replaceChildren()});c.appendChild(P),m.setAttribute("open",""),P.querySelector(".je-review-textarea")?.focus()},W=async j=>{if(!$())return;let P=me(j.userId,s.id),F=j.userName||"user",z=P?A("reviews_delete_title","Delete review"):A("reviews_admin_delete_title","Delete review (admin)"),ie=P?A("reviews_delete_confirm","Delete your review for this item?"):A("reviews_admin_delete_confirm","Delete this review by {user}? This cannot be undone.",{user:F});if(!(!await ee(ie,z)||!$()))try{P?await pe(h,E):await re(j.userId,h,E),$()&&we(n)}catch(se){if(!$())return;console.error(`${w} Delete failed`,se);let ct=A("reviews_delete_error_title","Delete failed"),dt=A("reviews_delete_error_body","Could not delete the review: {err}",{err:ne(se).message||"Unknown error"});Je(dt,ct),we(n)}};for(let j of u)x.appendChild(et(j,s,P=>V(P),W));for(let j of(e??[]).slice(0,10))x.appendChild(Ve(j));m.appendChild(x),S?.addEventListener("click",()=>{c.querySelector(".je-review-form")?c.replaceChildren():V(g||null)}),x.addEventListener("click",j=>{let P=j.target;if(!(P instanceof Element)||!P.classList.contains("tmdb-review-toggle"))return;let F=P.parentElement,z=F?.closest(".tmdb-review-card");if(!F||!z)return;let ie=(z.dataset.showTranslated==="1"?z.dataset.translatedContent:z.dataset.fullContent)||"",se=F.classList.toggle("expanded");F.innerHTML=se?R(ie)+fe("reviews_read_less"):R(ie.substring(0,Te))+fe("reviews_read_more")}),m.addEventListener("toggle",()=>{if($())try{let j=o.currentSettings=o.currentSettings||o.loadSettings?.()||{};j.reviewsExpandedByDefault!==m.open&&(j.reviewsExpandedByDefault=m.open,typeof o.saveUserSettings=="function"&&o.saveUserSettings("settings.json",j))}catch(j){console.error(`${w} Failed to persist reviews expanded state`,j)}});let G=n.querySelector(".streaming-lookup-container")||n.querySelector(".itemExternalLinks")||n.querySelector(".tagline");G?.parentNode?G.parentNode.insertBefore(m,G.nextSibling):console.error(`${w} Could not find a suitable anchor to insert reviews.`)}async function it(e,t,n){if(!e)return null;if(t==="Movie"||t==="Series"){let s=e.ProviderIds.Tmdb;return s?{tmdbKey:s,apiMediaType:t==="Movie"?"movie":"tv"}:null}if(t!=="Season"&&t!=="Episode")return null;let r=e.SeriesProviderIds.Tmdb;if(!r&&e.SeriesId)try{r=(await n(e.SeriesId))?.ProviderIds.Tmdb}catch{}return!r||e.IndexNumber==null?null:t==="Season"?{tmdbKey:`${r}:s${e.IndexNumber}`,apiMediaType:"tv"}:e.ParentIndexNumber==null?null:{tmdbKey:`${r}:s${e.ParentIndexNumber}:e${e.IndexNumber}`,apiMediaType:"tv"}}async function st(){let e=Q(),t=null;try{t=e.getCurrentUser?await e.getCurrentUser():null}catch{t=null}return{id:M(N(t,"Id"))||e.getCurrentUserId()||"",isAdmin:Re(N(N(t,"Policy"),"IsAdministrator"))===!0}}async function Le(e,t,n=!1){let r=xe(),s=be();if(!r||!s)return;let u=he(o.session,r,e),p={};D.set(e,p);let h=()=>u.current()&&D.get(e)===p,E=await ye(o.helpers,r,!0,s);if(!h())return;let g=E?.Type;if(!E||!g){U(e),I.delete(e);return}if(await _(E,g)){h()&&(U(e),I.delete(e));return}if(!h()||!n&&I.get(e)?.current()&&e.querySelector(".tmdb-reviews-section"))return;let m=await it(E,g,f=>t(s,f));if(!m||!g||!h())return;let[L,$,H]=await Promise.all([C(E,m.tmdbKey,g),d?q(m.tmdbKey,m.apiMediaType):Promise.resolve([]),st()]);if(!h())return;rt(L,$,e,m,H),I.set(e,u);let k=Ke.peer("invalidateUserReviewTagCache");typeof k=="function"&&k(m.tmdbKey)}async function we(e){try{await Le(le()||e,async(t,n)=>$e(await Q().getItem(t,n)),!0)}catch(t){console.error(`${w} Failed to refresh reviews:`,t)}}async function ot(e){if(e){I.get(e)?.current()||(U(e),I.delete(e));try{await Le(e,(t,n)=>ye(o.helpers,n,!0,t))}catch(t){console.error(`${w} Error processing page:`,t)}}}function at(){let e="tmdb-reviews-enhanced-styles";if(document.getElementById(e))return;let t=document.createElement("style");t.id=e,t.textContent=ut,document.head.appendChild(t)}at();let lt=o.helpers.onViewPage(async(e,t,n)=>{if(!o.pluginConfig.ShowReviews&&!o.pluginConfig.ShowUserReviews&&!o.pluginConfig.ShowAnilistReviews){lt?.();return}let r=window.location.hash.includes("id=")||typeof n=="string"&&n.includes("id="),s=!!t&&(t.id==="itemDetailPage"||t.classList.contains("itemDetailPage"));if(!r&&!s)return;await new Promise(p=>setTimeout(p,150));let u=le();u&&ot(u)},{pages:null,fetchItem:!1,immediate:!0})};var ut=`
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
