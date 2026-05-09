Now I have a comprehensive understanding of the codebase. Let me deliver a comprehensive bug audit. I have enough context to identify the key UI/UX bugs.

---

# Jellyfin Enhanced Seerr/Discovery JavaScript Bug Audit

Comprehensive review of `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/`. Findings are sorted by severity within categories.

---

## CRITICAL

1. **`api.checkUserStatus` caches FAILURE forever (causes silent discovery loss — user complaint #1)**
   File: `api.js:198-213`
   Bug: When the proxy returns 401/403/500 on first call (e.g., session token not yet ready, transient backend hiccup), the catch block sets `cachedUserStatus = { active: false, userFound: false }`. There is no TTL — this cached negative result is returned for the entire SPA session. Every discovery module checks `status.active` and silently `return`s if false, so the entire Seerr UI vanishes.
   Repro: Open Jellyfin while plugin loads before `ApiClient.accessToken()` is fully populated, OR experience any 5xx blip on the initial `/user-status` call. All discovery sections disappear until full page reload.
   Fix: Differentiate transient errors from confirmed-inactive responses; only cache successful results, OR add a TTL with `cachedAt` and bypass the cache after, say, 60 s on negative results.

2. **Issue #577 root cause: `checkUserStatus` failure leaks silently into every discovery module**
   File: `api.js:198-213` + `genre-discovery.js:572`, `network-discovery.js:635`, `tag-discovery.js:492`, `person-discovery.js:461`, `collection-discovery.js:179`, `item-details.js:271`
   Bug: Each discovery module fires `JE.jellyseerrAPI.checkUserStatus()` and bails on `!status?.active`. There is zero UX surface (no toast, no banner, no inline) when this fails or returns `active:false`. From the user's perspective the section "just doesn't appear" with no clue why.
   Repro: Hit any condition that 401s the user-status endpoint (e.g., proxy auth misconfigured, Cloudflare challenge page returning HTML).
   Fix: When `status.active === false` for an API/network reason, surface a one-time toast or inline "Discovery unavailable — check Seerr connection" message.

3. **`fetchRatings` in more-info-modal does NOT use proxy — bypasses request-manager**
   File: `more-info-modal.js:185-204` (and `fetchMediaDetails` 209-227)
   Bug: Both call raw `ApiClient.ajax` instead of `JE.requestManager.fetchWithRetry`. This means: no retry on 502/503, no concurrency limit, no cache, and no AbortController integration. Modal data fetch competes for sockets with all other requests.
   Repro: Open more-info modal while many discovery sections are still fetching; modal fetches block on slow Seerr responses with no cancel.
   Fix: Route through `JE.jellyseerrAPI.fetchMovieDetails`/`fetchTvShowDetails` which already use `managedFetch`.

4. **`item-details.js` does NOT cleanup observers on plugin unload / SPA navigation away from item page**
   File: `item-details.js:730-737` + `685-698`
   Bug: `cleanup()` only runs inside `hashchange` handler. If a user navigates Jellyfin without a hashchange fire (e.g., back-button hash-only changes or `viewshow` without hash change for episode→episode within same series), `currentAbortController` from previous render is replaced with a new one but the DOM's IntersectionObservers/timers are never disconnected.
   Combined with `processedItems.add(itemId)` only on success, a stuck-in-progress request can permanently disable retry for that item.
   Repro: Open item A, scroll fast, go back, open item A again — `processedItems` blocks re-render but the in-flight call from the first viewshow may have left dangling promises.
   Fix: Wire `cleanup()` to `document.addEventListener('viewbeforehide', ...)` and to a Visibility/page-blur listener.

5. **Issue #472/#528 selector mismatch — `#listChildrenCollapsible` may not exist on Jellyfin 10.11.x**
   File: `item-details.js:482`
   Bug: `waitForSeasonsHeading` polls for `#listChildrenCollapsible h2.sectionTitle.sectionTitle-cards`. In Jellyfin 10.11.x web client, the seasons heading was refactored (the wrapper changed; current main uses `.detailSection` blocks with different IDs). On 10.11 the polling will exhaust its 5-second timeout, the Request More button silently never appears, and there's no diagnostic.
   Repro: Run the plugin against a Jellyfin 10.11 server with a partially-requested series.
   Fix: Add a fallback selector chain (e.g., `.detailSection h2:has(span)` etc.) and surface a debug log when none match.

6. **Modal `popstate` handler hijacks browser back-button with no scoping**
   File: `modal.js:131-132,160-174`
   Bug: `show()` calls `history.pushState(null, '', location.href)` and registers `popstate → close`. If the user opens any other modal (e.g., more-info-modal), navigates with back, then this listener still fires and calls `close()` on a modal that was already closed — but more importantly, `cancelBtn.click → history.back()` and `modalElement.click → history.back()` will navigate the SPA backwards if the pushState was somehow squashed. With nested modals, two `history.back()` calls leave the user on a different page.
   Repro: Open season modal, open another modal, dismiss outer modal first.
   Fix: Track pushState depth or use a sentinel state object with a unique id; verify `event.state` matches before closing.

7. **`history.back()` close mechanism breaks SPA when modal opens at root URL**
   File: `modal.js:173-174`
   Bug: Cancel/backdrop click calls `history.back()`. If the modal is opened from a freshly-loaded page (no prior history entries beyond the pushed sentinel), `history.back()` may navigate the SPA to a different URL or leave the page in a "blank" state on iOS Safari. On Android webview some implementations return to the launcher.
   Repro: Open Jellyfin → search page → open modal directly via deep link → click cancel.
   Fix: Call `close()` directly instead of `history.back()` when the pushed state is on top; or compare `history.state` to a sentinel.

8. **Issue reporter `cachedUserCanReport` written but never read — dead-but-dangerous code**
   File: `issue-reporter.js:10,72`
   Bug: On a thrown error inside `checkReportingAvailability`, the catch sets `cachedUserCanReport = 'available'` then returns `'available'`. The variable is never read elsewhere. Worse, "available" on error means a Seerr outage causes the report button to appear and clicking it later will fail with an unhelpful generic toast.
   Repro: Disconnect Seerr, navigate to an item; the orange report button still appears and clicking it breaks.
   Fix: Remove the variable. Let the failure path return `'no-jellyseerr'`.

---

## HIGH

9. **Stale closure in `setupSearchInfiniteScroll(query)`**
   File: `jellyseerr.js:205-215`
   Bug: The closure captures `query` at setup time. After `loadMoreSearchResults` triggers a fetch, the in-flight check uses `lastProcessedQuery !== query` (line 161). If the user types a new query mid-scroll-load and the fetch completes after `lastProcessedQuery` is updated, the `query` in the closure is stale and the abort guard works correctly — BUT on rapid query switching (`query A → B → A` in 600 ms), a stale loadMore for A may run AFTER A is again `lastProcessedQuery`, appending duplicates.
   Repro: Type quickly with debounce, scroll, type again to same value.
   Fix: Use an AbortController per render; cancel on resetSearchPagination instead of relying on string equality.

10. **`debounceTimeout` never cleared on SPA leave from search page**
    File: `jellyseerr.js:28,324-345`
    Bug: When user navigates away from `/search` with a pending debounce, `clearTimeout` is only fired inside `handleSearch`. If the search page is removed from DOM mid-debounce, the closure runs and `searchInput.value` may throw on the now-null element (gracefully handled by `?.`), but `lastProcessedQuery` is then re-set from `null` and an empty fetch fires.
    Fix: Listen for `je:navigate` and clear `debounceTimeout` + reset `lastProcessedQuery` there.

11. **`renderJellyseerrResults` MutationObserver leaks if user navigates before timeout**
    File: `ui.js:859-870`
    Bug: When `findLastPrimarySection()` initially returns null, a MutationObserver is created and a 5 s timeout disconnects it. If the user navigates away from `/search` within 5 s, the observer keeps firing on every body mutation across the entire SPA; no abort signal cancels it.
    Fix: Tie observer disconnect to a `je:navigate` event in addition to the timeout.

12. **`onClose` callback never fires when modal close path is `popstate` instead of cancel-button**
    File: `modal.js:148-170`
    Bug: `close()` checks `isClosing` and runs `onClose`. But because both cancel-button and backdrop click call `history.back()`, the `popstate` listener invokes `close()`. That works. However, if the user navigates the SPA hash for unrelated reasons (e.g., a deep link scroll), `popstate` still fires `close()` and runs `onClose`. The season modal's `onClose` clears `refreshModalInterval` (line 2196-2200 in ui.js) — fine. But if other code opens nested modals that share the same `popstate` listener pattern, multiple `onClose` callbacks fire on a single back action.
    Fix: Stop using `history.pushState` for in-page modals; use a dedicated keydown/click manager.

13. **`refreshModalInterval` polling never stops when navigation closes modal without `onClose` running**
    File: `ui.js:2385-2395`
    Bug: A 10-second interval polls `fetchTvShowDetails`. The `onClose` callback (line 2196-2200) clears it. But if the user reloads the page or the modal element is force-removed from DOM (e.g., theme nukes `body` content), the interval handle leaks and continues firing fetches every 10 s until tab close.
    Repro: Open season modal → trigger any custom theme that wipes DOM → interval keeps hitting Seerr forever.
    Fix: Store interval handle on `currentModal._refreshInterval` and clear in a `MutationObserver` watching for the modal node being detached.

14. **`prepareResultsWithCollections` mutates the `results` array in-place (immutability violation)**
    File: `jellyseerr.js:222-273`
    Bug: `results = await JE.jellyseerrAPI.addCollections(results)` reassigns OK, but lines 263-265: `results.splice(position + 1, 0, collectionCard)` mutates the array passed in by reference. If callers (or cache) hold a reference to the original results, they will see synthetic collection cards injected. Cache poisoning across refresh runs is possible since `jellyseerrAPI.search` may return a cached object.
    Fix: Build a new array; never `splice` into the input.

15. **`api.search` filter mutation potential**
    File: `api.js:228-245`
    Bug: The function correctly returns `{ ...data, results: filteredResults }`, but the cached `data` itself is what the request manager stored (line 51-53 in `setCache`). Subsequent calls hit the cache and re-filter the SAME cached object's `data.results` reference — `filter` returns a new array, so this is OK. BUT note `totalResults: filteredResults.length` is misleading because the cached source had the real total. Not a bug; downstream `searchTotalPages` logic uses `totalPages` which is correct. Skipping this finding.

16. **`fetchAndRenderResults` does not cancel in-flight searches when query changes rapidly**
    File: `jellyseerr.js:123-154`
    Bug: There is no AbortController — when query changes, the in-flight `search()` for the old query still resolves and `renderJellyseerrResults` renders stale cards before the new fetch completes. Mitigated by the `lastProcessedQuery !== query` check inside the enrichment promise (line 142), but the initial `renderJellyseerrResults` call on line 138 has no such guard, so old results CAN render.
    Fix: Pass a signal to `search()` and check `signal.aborted` before each render.

17. **`request-manager.js` never wires `abortAllRequests` to navigation**
    File: `request-manager.js:239-245,388-389`
    Bug: The comment says "Individual modules handle their own cleanup on hashchange" but only the discovery modules abort. There is no global `je:navigate → abortAllRequests()`. In-flight `more-info-modal.js`, `item-details.js` ratings, `issue-reporter.js` calls keep running after navigation.
    Fix: Add a single `window.addEventListener('hashchange', () => JE.requestManager.abortAllRequests())`.

18. **`response.json()` thrown without content-type check**
    File: `api.js:48` and many discovery fetches
    Bug: `managedFetch` always calls `response.json()`. If Seerr returns HTML (Cloudflare challenge, login redirect, 502 maintenance page), the `.json()` throw bubbles up as a generic SyntaxError. The catch in caller `console.error`s and returns `{ results: [] }` — discovery section disappears silently.
    Repro: Put Seerr behind Cloudflare with bot protection.
    Fix: Check `response.headers.get('content-type')?.includes('application/json')` before parsing; surface a "Seerr proxy returned non-JSON" toast.

19. **`request-manager.fetchWithRetry` does not propagate non-retryable error bodies for AbortError correctly**
    File: `request-manager.js:97-148`
    Bug: When `response.ok` is false, the body is read via `response.clone().text()` — but if the original response stream is consumed elsewhere, `.clone()` may fail on Safari iOS. Also, the body reading can abort if the user navigates, throwing `AbortError` from `readErr.name === 'AbortError'` re-throw at line 129. The outer try-catch at line 136 then catches that, sees `error.name === 'AbortError'` and re-throws — fine. BUT, `lastError` is then set to the AbortError; if the loop iterates again the retry check at line 91 catches it. OK. False alarm. Skipping.

20. **`onBodyMutation` registration is not cleaned up across initialization (memory leak)**
    File: `jellyseerr.js:389` (and similar in item-details.js:130)
    Bug: Each call to `JE.helpers.onBodyMutation('jellyseerr-search-listener', ...)` registers a callback. Per the project memory (`feedback_je_async_gotchas.md`), the shared body observer "drops attr/text mutations." But more importantly — if `initializeJellyseerrScript` is called more than once (which can happen if plugin.js re-inits on theme reload), multiple callbacks pile up.
    Fix: Use the returned handle and unsubscribe in a teardown path.

21. **Race: `currentRenderingPageKey` is set AFTER `cancelAbortController` is already set, but BEFORE await — race window**
    File: `genre-discovery.js:550-562` (mirrored in network/tag/person)
    Bug: Lines 549-562:
    ```
    if (currentRenderingPageKey === pageKey) return;
    if (config disabled) return;
    currentRenderingPageKey = pageKey;
    if (currentAbortController) currentAbortController.abort();
    currentAbortController = new AbortController();
    ```
    If two `renderGenreDiscovery()` calls fire near-simultaneously (e.g., `hashchange` + `viewshow` 1 ms apart, common on Jellyfin SPA), both pass the first guard since neither has set `currentRenderingPageKey` yet. The second call aborts the first's AbortController — but the first call's promise chain has already started. The first call's abort signal is now from the SECOND controller, not its own. Result: the first call may proceed thinking it's still active, while the second runs in parallel.
    Fix: Capture the local controller into the closure before any await; check both `signal.aborted` AND `currentAbortController === localController` after each await.

22. **`processedPages` is a per-module Set that grows unbounded**
    File: `genre-discovery.js:10`, `network-discovery.js:16`, `tag-discovery.js:10`, `person-discovery.js:12`, `collection-discovery.js:8`, `item-details.js:12-13`
    Bug: Each module accumulates `pageKey` strings (containing the full hash). A power user who visits 1000 different genre/tag/network pages in a session keeps 1000 entries forever. Cleanup runs on `hashchange` and clears the set — wait, it does (line 718, 788, 618, etc.). OK. But `personIdCache`, `keywordIdCache`, `networkIdCache`, `genreInfoCache` (lines 9-13 in respective files) are never cleared and grow without bound across sessions.
    Fix: Add a per-cache `MAX_ENTRIES` and LRU eviction.

23. **Issue reporter status check uses raw `ApiClient.ajax`, not the cached `checkUserStatus`**
    File: `issue-reporter.js:32-34, 1106-1107`
    Bug: Each invocation of `checkReportingAvailability` and `initialize()` makes a fresh `/JellyfinEnhanced/jellyseerr/status` call. Not deduplicated with `api.checkUserStatus`. On every detail page view, this fires again. Unnecessary load.
    Fix: Use `JE.jellyseerrAPI.checkUserStatus()` which already caches.

24. **N+1 in `issue-reporter` season/episode lookup**
    File: `issue-reporter.js:399-419`
    Bug: For each season, a separate `ApiClient.ajax` call is awaited sequentially in a `for` loop. A 10-season show makes 10 sequential round-trips before the modal becomes interactive.
    Repro: Open issue reporter on a long-running series.
    Fix: `Promise.all(seasons.map(s => fetchEpisodes(s.id)))`.

25. **`prepareResultsWithCollections` runs inside the search promise but does not await the deduplicator filter**
    File: `jellyseerr.js:141-147`
    Bug: After enrichment, `searchDeduplicator.filter(enrichedResults)` is missing — only the original `results` were filtered. The enriched results may contain new collection cards that bypass the deduplicator entirely. Acceptable in practice (collection cards are unique by collection id), but worth noting that the deduplicator key is `${mediaType}-${id}` and collection cards have `mediaType: 'collection'` — collisions theoretically possible if the same collection appears twice across pages.
    Fix: Pass enriched results through the deduplicator before re-rendering.

26. **`createJellyseerrCard` never escapes `posterUrl` interpolated into a `style` attribute**
    File: `ui.js:1069`
    Bug: `style="background-image: url('${posterUrl}');"` — `posterUrl` comes from `https://image.tmdb.org/t/p/w400${item.posterPath}`. `item.posterPath` is API-sourced. While TMDB normally returns sanitized paths like `/abc.jpg`, a malicious or compromised Seerr could return `'); evil:...; --` and break out of the `style` attribute. CSS-context XSS is hard to exploit but trivial to fix.
    Fix: Validate poster path against `/^\/[a-zA-Z0-9._-]+\.[a-zA-Z]+$/` (the modal already has `isValidPosterPath` at `more-info-modal.js:19` — apply it here too).

27. **`fetchProviderIcons` fetches via raw `fetch()`, bypasses request manager**
    File: `ui.js:1403`
    Bug: Raw `fetch(url, { headers: {'X-Emby-Token': ApiClient.accessToken()} })`. No timeout, no retry, no abort on navigation. On a slow TMDB proxy this can keep firing per card.
    Fix: Use `JE.requestManager.fetchWithRetry`.

28. **Issue reporter cancel button toast `'Issue Type is required'` is hardcoded English**
    File: `issue-reporter.js:165`
    Bug: All other strings use `JE.t('...')`, but this one is bare English. Also, the validation only fires when issueType is missing — with native browser `required` on the radio, the form should never submit, but `radio` `required` works inconsistently across browsers.
    Fix: Use a translation key.

29. **`searchInput` listener attaches alphabetPicker click without removal — duplicates if user navigates away & back**
    File: `jellyseerr.js:368-374`
    Bug: The `dataset.jellyseerrListener` guard prevents re-attaching the `input` listener, but the `alphaPicker.click` listener has no equivalent guard. Each `tryAttachSearchListener` call adds a new click handler without removing the old one. Search page MutationObserver fires multiple times on rebuild.
    Fix: Either guard with `dataset.jellyseerrAlphaPickerListener` or use `removeEventListener` symmetrically.

30. **Modal focus trap selector excludes contenteditable / role=button elements**
    File: `modal.js:101-103`
    Bug: Focusable selector list misses `[contenteditable="true"]` and `audio[controls], video[controls], iframe`. Not critical for the request modal but the issue reporter modal embeds rich textareas where the user can paste HTML.
    Fix: Expand selector list to match WCAG focusable patterns.

---

## MEDIUM

31. **`handleSearch` assumes `searchInput.value` is the latest — race vs. debounce**
    File: `jellyseerr.js:330`
    Bug: After 300 ms debounce, `searchInput.value` is re-read but the user may have erased it. The check `if (latestQuery === lastProcessedQuery) return;` short-circuits if value matches the previous search but if the user rapidly types `abc → abcd → abc` within 300 ms, the second `abc` fetch is suppressed because `lastProcessedQuery === 'abc'`. That's a feature, not a bug; skipping.

32. **No URL parameter validation in popup `query` extraction**
    File: `jellyseerr.js:524-525, 2255, 2679`
    Bug: `new URLSearchParams(window.location.hash.split('?')[1])?.get('query')` — if hash is malformed (e.g., contains `?` from mobile share sheet), this can throw or return wrong value. The `?.` chains protect against `null` from `split`, but `URLSearchParams` does not throw on bad input — it silently parses garbage. Result: `query` may be wrong, leading to a refetch with wrong term.
    Fix: Wrap in try/catch and fall back to last-known query.

33. **`item-details.js:isPersonPage` and `getTmdbIdFromItem` fetch full item data per navigation**
    File: `item-details.js:30-72, 660-680`
    Bug: Every viewshow fetches the item from Jellyfin to determine TMDB id and type. Cached via `JE.helpers.getItemCached`, OK. But when caching is unavailable, raw `ApiClient.getItem` fires twice per page load (once here, once for issue reporter, once for person discovery, etc.). High load on Jellyfin.
    Fix: Centralize the per-page item lookup behind a single shared promise per `itemId+pageLoadId`.

34. **`person-discovery.searchTmdbPerson` filters `mediaType === 'person'` — case mismatch potential**
    File: `person-discovery.js:137`
    Bug: The TMDB search response may use `media_type` (snake_case) vs `mediaType` depending on which proxy normalization runs. If the C# proxy ever passes through raw TMDB data, this filter returns empty.
    Fix: Check both `r.mediaType` and `r.media_type`.

35. **`network-discovery.TV_NETWORKS` hardcoded list — unmaintainable**
    File: `network-discovery.js:51-105`
    Bug: A 40-line lookup table of network name → TMDB id. Misses many regional networks (RTÉ, ARD, ZDF, France Télévisions, NHK, KBS, etc.). Affected users in non-English markets see "no network discovery for ZDF" with no debug.
    Fix: Use TMDB's `/network/{id}` lookup or fall back to company search; surface a warning when no match.

36. **`fetchTmdbCompany` scoring prefers US — locale bias**
    File: `network-discovery.js:201-209`
    Bug: For non-US users, this picks US-origin companies first. A user in Germany searching for "Universal" may get Universal Pictures (US) instead of a German-licensed entity, then `discover/movies/studio/{id}` results may be empty.
    Fix: Use `JE.userConfig?.elsewhere?.Region` as the preferred origin; fall back to US.

37. **`person-discovery.js` client-side sort assumes `releaseDate` strings are ISO-comparable — fragile**
    File: `person-discovery.js:207-218`
    Bug: `dateA.localeCompare(dateB)` works for `YYYY-MM-DD` but breaks if Seerr returns localized formats or partial dates (e.g., `2024`). Items with missing dates sort to the front of `release_date.desc` rather than the end, polluting top results.
    Fix: Coerce to Date and treat NaN as Infinity.

38. **`hss-discovery-handler.js` registers click capture on document with no removal**
    File: `hss-discovery-handler.js:14-42`
    Bug: A capture-phase document click listener that intercepts every `.discover-card` click. If the plugin is hot-swapped (settings change), a new listener is added without removing the old. Each adds another `e.preventDefault()` / `e.stopPropagation()` — they cascade.
    Fix: Use a delegation guard with a `data-handler-id` attribute, or unsubscribe on settings reload.

39. **`hss-discovery-handler.js` blocks click even when more-info modal is unavailable**
    File: `hss-discovery-handler.js:31-32`
    Bug: If `JE.jellyseerrMoreInfo.open` is undefined, the handler returns early — but earlier `e.target.closest('.discover-requestbutton')` is the only escape. Cards lacking `data-tmdb-id` fall through to the early-return without ever calling `e.preventDefault`. So when the modal IS available but the card has no tmdbId, the click is allowed to navigate to Seerr web. OK, this is intended. Skipping.

40. **`seamless-scroll.js` retry button text is hardcoded English**
    File: `seamless-scroll.js:170`
    Bug: `retryButton.textContent = '⟳ Tap to retry';` — not translated.
    Fix: Use `JE.t('infinite_scroll_retry')` with English fallback.

41. **`seamless-scroll.js` recursive `wrappedLoad` in retry path can stack-overflow**
    File: `seamless-scroll.js:213-218`
    Bug: When `retryCount < maxAttempts`, `wrappedLoad` is awaited recursively. With a flaky network and `maxAttempts: 3`, that's only 2 levels deep — fine. But the user's clicked retry button bypasses the counter (line 182: `retryCount = 0`), and if the retry fails, the recursion starts over from 0. Worst case is 3 deep. Acceptable. Skipping.

42. **`seamless-scroll.js:259` saves `_removeRetryRow` reference but cleanup nulls it after calling — not a leak**
    Fine. Skipping.

43. **`createCardsFragment` filter bypasses cache invalidation after request**
    File: `discovery-filter-utils.js:390-449`
    Bug: When a user requests a movie via the more-info modal, the parent discovery cards still show "Request" status because:
    - `invalidateRequestCaches` (api.js:144) clears Seerr proxy cache for `/movie/${id}`
    - But the discovery fragments are created from results that came from `/discover/movies/...` whose cache was NOT invalidated
    - The pattern in `invalidateRequestCaches` uses `'jellyseerr:/discover/'` — that DOES match, OK (line 161)
    - However `discoveryFilter.fetchWithManagedRequest` uses `${cachePrefix}:${path}` keys (line 350: `${cachePrefix}:${path}`). The prefix is `'genre'`, `'network'`, etc. — NOT `'jellyseerr'`. So `clearCacheMatching('jellyseerr:/discover/')` does NOT clear genre/tag/network discovery caches.
    Repro: Browse a genre, request a movie via the card, navigate to a different genre and back — the previous card still shows "Request" instead of "Pending."
    Fix: `clearCacheMatching('genre:')`, `clearCacheMatching('network:')`, etc., OR change cache key prefix to be uniform.

44. **`api.checkUserStatus` cache survives explicit logout if `clearUserStatusCache` not called**
    File: `api.js:218-220`
    Bug: `clearUserStatusCache` exists but I see no caller wiring it to user logout. Searched all files — no callers found. Result: a session that logs in as user A, gets cached, then user B logs in via the same SPA, sees A's userFound state.
    Fix: Hook `clearUserStatusCache` to ApiClient logout events or detect ApiClient.getCurrentUserId() change.

45. **`fetchOverrideRules` has 5-minute TTL but no cap on cached size; OK fine — single object — skipping**

46. **`requestMedia` mutates `searchResultItem.mediaInfo` by setting `status4k = 3`**
    File: `jellyseerr.js:518-519`
    Bug: After 4K request, `searchResultItem.mediaInfo.status4k = 3;` — direct mutation of the object that was JSON-serialized into a button dataset. Other cards or cached results sharing reference (impossible due to JSON parse, but...) — actually `searchResultItem = JSON.parse(button.dataset.searchResultItem)` gives a fresh object, so the mutation is isolated. Skipping.

47. **`refreshModalData` mutates `data` via `Object.assign`**
    File: `more-info-modal.js:248`
    Bug: `Object.assign(data, freshData)` mutates the closure-captured `data` object. Multiple modals open in sequence may share `data` references, leading to subtle bugs when an old modal's fetch completes after a new one opens. Mitigated by tmdbId/mediaType comparison (line 163-164) but `Object.assign` itself violates immutability.
    Fix: Clone with `data = { ...data, ...freshData }` and store the new ref on the modal.

48. **`fetchTvShowDetails` results are NOT deduplicated against in-flight request — TWO consumers cause double fetch**
    File: `api.js:311-317`
    Bug: `requestManager.deduplicatedFetch` only kicks in when `cacheKey` is provided AND signal is null (line 175). The default `cacheKey` is `jellyseerr:/tv/${tmdbId}`. If two callers (more-info modal + season selection modal) both call `fetchTvShowDetails(123)` while the response is queued, both should hit the dedup. OK, that does work. Skipping.

49. **`fetchUserQuota` skipCache option is forwarded but `get()` only honors `skipCache` to bypass cache lookup, not to skip cache write**
    File: `api.js:91-95, 686-693`
    Bug: When `skipCache: true`, the code sets `cacheKey = null`. With null cacheKey, `setCache` is never called. OK — but then the next call without skipCache refetches anyway because nothing was cached. Acceptable.

50. **More-info modal `escape key` handler not `e.preventDefault()` — escape may close two modals**
    File: `more-info-modal.js:473-478`
    Bug: When a season modal is open inside more-info-modal (theoretically possible if season selection is triggered), pressing Escape fires both handlers — outer modal closes first.
    Fix: `e.preventDefault()` and `e.stopPropagation()` after detecting modal is on top.

51. **`buildModalContent` `posterUrl` and `backdropUrl` interpolated raw without escaping**
    File: `more-info-modal.js:557, 566`
    Bug: `style="background-image: url('${backdropUrl}');"` and `<img src="${posterUrl}" alt="${title}" />` — title is escaped, but URLs are not. URLs are derived from TMDB paths which are typically safe, but if Seerr injects a malicious posterPath like `"></div><script>...</script>` the modal HTML breaks. The dedicated `isValidPosterPath` exists at line 19 but is only used in `backfillSeasonMetadata`.
    Fix: Validate `data.posterPath` and `data.backdropPath` with `isValidPosterPath` before constructing URLs.

52. **`buildRatingLogos` interpolates `ratings.rt.criticsScore` and `audienceScore` without type check**
    File: `more-info-modal.js:807, 820`
    Bug: `${ratings.rt.criticsScore}%` — if criticsScore is somehow a string `"</span><script>..."`, it gets injected. The `if (ratings?.rt?.criticsScore !== undefined)` guard doesn't validate type. Same for `imdb.criticsScore.toFixed(1)` — toFixed throws on non-number, killing the modal.
    Fix: Coerce with `Number()` and check `Number.isFinite`.

53. **`buildSeasonsSection` interpolates `season.episodeCount` raw — but `escapeHtml` is used at line 1938**
    File: `more-info-modal.js:1938`
    Bug: `${escapeHtml(season.episodeCount || 0)} Episodes` — escapeHtml expects a string and may misbehave on numbers (depending on `JE.escapeHtml` impl). Most escapeHtml implementations call `String()` first. Likely fine, but worth checking against `helpers.js`.
    Fix: Cast explicitly: `escapeHtml(String(season.episodeCount || 0))`.

54. **`renderActions` on modal close-then-reopen of same item leaks request listener**
    File: `more-info-modal.js:488-512`
    Bug: `handleTvRequest` listener is added per-modal; `_cleanupTvListener` removes it on `close()`. But if `showModal` is called while `currentModal` is non-null, `moreInfoModal.close()` is invoked, which is async (300 ms transition). The new modal is created and adds its own listener immediately. Until the old modal's `setTimeout(..., 300)` runs, both listeners are alive — when a TV request completes, both fire and the orphan one calls `renderActions` on the old `data`/`modal` references.
    Fix: Synchronously remove old listener before showing new modal.

55. **`fetchJellyfinSeasonMap` not aborted on modal close**
    File: `more-info-modal.js:311-340`
    Bug: When modal closes mid-fetch, the Jellyfin `/Items` request keeps running and result is dropped silently. Not a bug, but wasted bandwidth.
    Fix: Pass an AbortSignal tied to modal lifecycle.

56. **`enrichSeasonCardsWithJellyfinLinks` mutates `data._jellyfinSeasonIdMap`**
    File: `more-info-modal.js:351`
    Bug: Stores `_jellyfinSeasonIdMap` on the `data` object. If `data` is shared across re-renders, this is fine — but if the modal is reopened with `data` from a different request payload, the stale map persists.
    Fix: Store on `currentModal._seasonIdMap` instead of mutating `data`.

57. **Modal `keydown` listener registers on `document` without capture flag — themes may swallow it**
    File: `modal.js:133`
    Bug: `document.addEventListener('keydown', handleKeydown)` — non-capture phase. A theme adding capture-phase Escape handler can prevent the modal from closing.
    Fix: Use `{ capture: true }` for modal-priority handlers.

58. **`network-discovery.searchTmdbCompany` cache by lowercase name only — collision risk**
    File: `network-discovery.js:179`
    Bug: `cacheKey = networkName.toLowerCase().trim()` — different studios with the same name in different countries collide, e.g., "Universal" → first match wins forever.
    Fix: Include locale in the key.

59. **`more-info-modal.refreshModalData` errors call `showError(...)` which uses `alert()`**
    File: `more-info-modal.js:1996-1998`
    Bug: Native `alert()` is blocking, ugly, and inconsistent with `JE.toast`. On Android webview alert may break the modal animation.
    Fix: Replace with `JE.toast`.

60. **`buildSingle4kButton` and friends: `JE.jellyseerrUIIcons` referenced but module exposes `JE.jellyseerrUI.icons`**
    File: `more-info-modal.js:1071, 1162, 1180, 1194` etc.
    Bug: `JE.jellyseerrUIIcons?.request` — but `ui.js:2779` exposes `ui.icons`, accessible as `JE.jellyseerrUI.icons`. The optional chain `JE.jellyseerrUIIcons?.request` is always `undefined`, so the fallback `<span class="material-icons">download</span>` is always used. Functional but design-broken — the fallback works.
    Fix: Reference `JE.jellyseerrUI?.icons?.request`.

61. **`createCardsFragment` library-link override doesn't preserve `is="emby-linkbutton"` attribute**
    File: `discovery-filter-utils.js:434-442`, mirrored in `item-details.js:218-226`
    Bug: When converting a Seerr card link to a Jellyfin library link, the code sets `titleLink.href` and removes `target` / `rel`. But the original `is="emby-linkbutton"` attribute is preserved (since the element was created with it). This is correct for iOS routing. Skipping.

62. **`createJellyseerrCard` external Seerr link uses `target="_blank"` but no fallback for iOS standalone PWA mode**
    File: `ui.js:1060`
    Bug: When Jellyfin is "Add to Home Screen" PWA on iOS, `target="_blank"` opens in the same standalone shell instead of Safari. Some iOS versions silently no-op.
    Fix: Use `is="emby-linkbutton"` (already present) — that should hand off to system browser. Verify across iOS versions.

63. **`isPlainLeftClick` referenced but never defined**
    File: `ui.js:1286`
    Bug: `if (isExternalJellyseerrLink && isPlainLeftClick) { return; }` — `isPlainLeftClick` is not declared anywhere in the function or module. This throws `ReferenceError: isPlainLeftClick is not defined` when the condition is reached, in strict mode.
    Repro: Click an external Seerr link on a non-library item with `useMoreInfoModal === false` and `mediaType !== 'collection'`. The error bubbles up, `e.preventDefault()` was never called, and the link works by accident — but the console shows a ReferenceError every click.
    Fix: Either define `isPlainLeftClick = e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey` or remove the condition.

64. **`refreshModalData` on more-info modal — refresh button enabled state desync**
    File: `more-info-modal.js:232-264`
    Bug: If `refreshBtn.disabled = true` is set, then `showError` is called early-returning, the button is re-enabled at line 243. But when the catch runs at line 259, the button is also re-enabled. If a user double-clicks, the second click's promise enables the button while the first is still pending.
    Fix: Track in-flight state with a counter or guard.

65. **`buildStatusChip` link doesn't escape `mediaId`**
    File: `more-info-modal.js:1418`
    Bug: `link.href = '#!/details?id=' + mediaId;` — mediaId comes from `data.mediaInfo.jellyfinMediaId`. While Jellyfin IDs are GUIDs, untrusted Seerr could inject `?id=evil#xss` and the URL would be set verbatim.
    Fix: `encodeURIComponent(mediaId)`.

---

## LOW

66. **`console.log` debug statements throughout production code**
    Files: `jellyseerr.js:12,16,22,285,610`, `ui.js:758,766,796`, `item-details.js:722`, `issue-reporter.js:178,699,704,724,731,943,997,1004,1079,1102,1134`, `hss-discovery-handler.js:35`
    Bug: Per project coding-style rules: "No `console.log` statements in production code." There are many `console.log` calls, not just `console.debug`/`console.warn`.
    Fix: Replace with `console.debug` or remove.

67. **Hardcoded English strings in `seamless-scroll.js` and `modal.js`**
    Files: `seamless-scroll.js:170`, `modal.js:229-231`, `ui.js:284,289`, `more-info-modal.js:1119,1131,1252,1314` etc.
    Bug: Strings like `"Select Server..."`, `"Select Quality..."`, `"4K Available"`, `"4K Requested"`, `"Request in 4K"` should use `JE.t(...)`. Some are wrapped with `||` fallback (`JE.t(...) || 'Default'`) but many are bare English.
    Per memory `feedback_je_use_plain_jet.md`: should use plain `JE.t(key)` for new translations, never `tWithFallback`/`|| 'English'`.
    Fix: Add translation keys.

68. **`api.requestMedia` and friends return raw response — may include sensitive Seerr fields**
    File: `api.js:533, 576`
    Bug: Caller logs `console.debug(... 'response:', response)` — full response includes user emails, raw createdBy info, etc. Log statements may end up in browser memory dumps.
    Fix: Strip sensitive fields before logging.

69. **`ui.js:1099` overlayContainer gets `pointerEvents = 'none'` — accessibility regression**
    File: `ui.js:1097-1099`
    Bug: Disabling pointer events on `cardOverlayContainer` removes Jellyfin's default keyboard focus behavior on the overlay, breaking screen-reader navigation that relies on the overlay as a clickable target.
    Fix: Use `data-action="none"` instead of fully disabling pointer events.

70. **`fetchProviderIcons` regex compilation per item (perf)**
    File: `ui.js:1423`
    Bug: `IGNORE_PROVIDERS.map(pattern => new RegExp(pattern, 'i'))` runs once per card. The `IGNORE_PROVIDERS` list is constant for the page; compile once and reuse.
    Fix: Compile patterns once at module init.

71. **Issue reporter renders user-supplied issue messages with `escapeHtml` → that's good — but `mainMessage = escapeHtml(issue.message || ...)` and then injected with `.innerHTML =`**
    File: `issue-reporter.js:297-302`
    Bug: The message IS escaped before injection, OK. But the wider `summary` includes `escapeHtml(String(issue.id))` — if `issue.id` is non-string, this works fine. Skipping.

72. **`fetchTmdbGenres` cache is module-scoped and never expires**
    File: `genre-discovery.js:13, 51`
    Bug: `tmdbGenreCache` is set once and lives forever. TMDB rarely adds genres — fine. But when a user with stale cache hits a never-before-seen genre, the lookup returns null and discovery silently fails.
    Fix: Add a 24-hour TTL.

73. **`tag-discovery.js` and others: search keyword cache entries cap-less**
    File: `tag-discovery.js:9`, `network-discovery.js:10-13`, `person-discovery.js:10-11`, `genre-discovery.js:9`
    Bug: Same as #22.

74. **`buildKeywordsSection` shows up to 20 keywords; very long ones overflow**
    File: `more-info-modal.js:785`
    Bug: No truncation per keyword. A keyword like "based on a real-life event from the early 1900s" overflows the keyword chip on mobile.
    Fix: CSS `text-overflow: ellipsis` on `.keyword`.

75. **Issue reporter modal `style` block injected inside `formHtml` — duplicates if modal opens twice**
    File: `issue-reporter.js:88-108`
    Bug: The `<style>` block is part of `formHtml` and goes into `bodyHtml`. Each open of the modal adds another copy of these styles to the DOM. While inert, it bloats the page.
    Fix: Inject styles via `<style id="...">` in head once, like other modules.

76. **`more-info-modal.js` injects styles via `<style>` element but never namespaces against Jellyfin's `.modal-overlay`**
    File: `more-info-modal.js:2040`
    Bug: `.je-more-info-modal .modal-overlay` is scoped, but Jellyfin's own dialogs use `.modal-overlay` too. If a Jellyfin native dialog opens above the more-info modal, styling cascades.
    Fix: Rename to `.je-more-info-overlay` or similar.

77. **Person discovery uses `localeCompare` for date comparison — locale-dependent ordering**
    File: `person-discovery.js:210, 215`
    Bug: `localeCompare` uses the user's locale collation; for `YYYY-MM-DD` strings the order is identical to `<` / `>`, but spec doesn't guarantee it for non-ASCII characters in dates. Edge case only.
    Fix: Use direct `<` comparison.

78. **`createSectionHeader` filter and sort controls use inline `style.cssText` extensively**
    File: `discovery-filter-utils.js:177, 202, 264-284, etc.`
    Bug: Inline styles via `cssText` overwrite any existing styles. User CSS customizations (a common Jellyfin power-user practice) are clobbered.
    Fix: Use a CSS class with theme variables.

79. **`renderJellyseerrResults` calls `noResultsMessage.textContent = JE.t(...)` — overrides Jellyfin's empty-state message**
    File: `ui.js:834`
    Bug: When Jellyfin shows "No items found", the plugin overwrites the text with a Seerr-specific message. If the user disables Seerr search results mid-session via plugin settings, the original Jellyfin text doesn't come back.
    Fix: Cache and restore the original text on plugin disable.

80. **`updateJellyseerrIcon` searches multiple selectors — silent no-op on selector mismatch**
    File: `ui.js:697-701`
    Bug: If none of `.searchFields .inputContainer`, `#searchPage .searchFields`, or `#searchPage` match (e.g., on Jellyfin 10.11 web client refactor), the icon is never added and there's no log.
    Fix: Add `console.warn` when no anchor found.

81. **Modal title in `modal.create` derived from `title` text — `bodyHtml` is trusted innerHTML**
    File: `modal.js:65`
    Bug: Comment says "bodyHtml is intentionally trusted HTML from internal callers" — true for built-in modules, but `modalElement.bodyHtml` is set from `formHtml` strings constructed with template literals. If anyone interpolates a non-escaped value, it's stored XSS.
    Risk: Issue reporter `formHtml` (line 113-118) interpolates `type.label` directly without escape — `type.label` comes from `JE.t('jellyseerr_report_issue_type_video')` etc. If a translation file is compromised, XSS via translation. Not high-risk but worth hardening.
    Fix: Use DOM construction, not string template + innerHTML.

82. **Discovery modules' `requestAnimationFrame` wrapper is unnecessary and can desync state**
    File: `genre-discovery.js:750`, `network-discovery.js:822`, `tag-discovery.js:651`, `person-discovery.js:611`, `collection-discovery.js:301`
    Bug: `requestAnimationFrame(() => renderXxxDiscovery())` defers by one frame for "DOM sync" — but the function then `await`s several promises before touching DOM. The rAF gives no benefit and creates a small race window.
    Fix: Drop the rAF wrapper.

83. **`searchScrollState` is a single shared object across infinite scroll setups**
    File: `jellyseerr.js:40, 116`
    Bug: One module-scoped object reused across queries. `cleanupInfiniteScroll(searchScrollState)` clears it. If two queries fire near-simultaneously, the second's `setupInfiniteScroll` may trample the first's state before it cleans up.
    Fix: Create a new state object per query.

84. **`api.fetchAdvancedRequestData` does a serial-ish fetch — `Promise.all(map())` ✓ but each map calls `get(/${serverType}/${server.id})` separately**
    File: `api.js:656-672`
    Bug: With 5 Radarr servers, that's 5 parallel proxy calls. Acceptable. Skipping.

85. **`isQuotaError` regex `/quota\s+exceeded/i` brittle — Seerr translation may break it**
    File: `ui.js:1921`
    Bug: When Seerr is set to a non-English locale, the message is localized. The regex misses "Cuota excedida" / "クォータ超過". Quota-error path silently falls back to a generic toast.
    Fix: Check error code/status combo instead of message text.

86. **`fetchOverrideRules` returns stale cache on error with no min-cache-age**
    File: `api.js:354-367`
    Bug: When TTL expires and the refetch fails, `cachedOverrideRules` (the stale one) is returned. There's no upper bound on staleness — the user could receive override rules from days ago.
    Fix: Track `cachedAt` and disable cache after 24 h regardless.

87. **`api.evaluateOverrideRules` — language match uses `originalLanguage` not user's preferred language**
    File: `api.js:415-419`
    Bug: A rule like "language=en" matches movies with English original language, regardless of whether the user wants English. This is the documented Seerr behavior, but a user expecting "give me English audio" may be surprised. Documentation issue, not a code bug.

88. **`item-details.js:waitForChecker` polls 3 s for `JE.jellyseerrMoreInfo.checkForUnrequestedSeasons`**
    File: `item-details.js:503-511`
    Bug: 3 s timeout assumes module load order. If `more-info-modal.js` is delayed (theme-side script blocking), the Request More button silently never appears. There is a `console.warn` (line 609) but no UX feedback.
    Fix: Surface a one-time toast on timeout. Or refactor to event-based ready signaling.

89. **`person-discovery.handleFilterChange` rebuilds the entire list on filter switch — perf**
    File: `person-discovery.js:318-329`
    Bug: Even though `applyFilterVisibility` exists for CSS-only filtering elsewhere, person-discovery uses `renderChunk(...true)` which clears and rebuilds the DOM. With 200 cast items, this is noticeable lag.
    Fix: Use the same CSS-class filter approach.

90. **Translation keys referenced but possibly missing from locales**
    Files: many
    Bug: I see references to: `discovery_more_with_genre`, `discovery_more_from_studio`, `discovery_more_with_tag`, `discovery_more_from_person`, `jellyseerr_btn_request_more`, `jellyseerr_quota_dialog_title`, `jellyseerr_quota_dialog_hint`, `jellyseerr_quota_label_movie`, `jellyseerr_quota_label_tv`, `jellyseerr_quota_unlimited`, `jellyseerr_quota_usage_window`, `jellyseerr_quota_usage`, `jellyseerr_quota_reset_now`, `jellyseerr_quota_reset_in_minutes`, `jellyseerr_quota_reset_in_hours`, `jellyseerr_quota_reset_in_days`, `jellyseerr_quota_restricted_hint`, `jellyseerr_select_all_movies`, `jellyseerr_modal_request_collection`, `jellyseerr_modal_request_selected_movies`, `jellyseerr_toast_movies`, `jellyseerr_toast_collection_requested`, `jellyseerr_toast_collection_failed_count`, `jellyseerr_toast_collection_fetch_failed`, `jellyseerr_toast_no_movies_in_collection`, `jellyseerr_btn_user_not_found`, `jellyseerr_btn_blocklisted`, `jellyseerr_btn_deleted`, `jellyseerr_err_no_request_permission`, `jellyseerr_err_no_issue_permission`, `jellyseerr_modal_overview`, `jellyseerr_modal_streaming`, `jellyseerr_modal_status`, `jellyseerr_modal_first_air_date`, `jellyseerr_modal_last_air_date`, `jellyseerr_modal_release_date`, `jellyseerr_modal_revenue`, `jellyseerr_modal_budget`, `jellyseerr_modal_original_language`, `jellyseerr_modal_production_country`, `jellyseerr_modal_studios`, `jellyseerr_modal_keywords`, `jellyseerr_modal_cast`, `jellyseerr_modal_trailers`, `jellyseerr_modal_director`, `jellyseerr_modal_writers`, `jellyseerr_modal_created_by`, `jellyseerr_btn_view_collection`, `jellyseerr_existing_issues`, `jellyseerr_loading_issues`, `jellyseerr_no_issues_yet`, `jellyseerr_load_issues_error`, `jellyseerr_issue_open`, `jellyseerr_issue_resolved`, `jellyseerr_report_issue_type_video`, `jellyseerr_report_issue_type_audio`, `jellyseerr_report_issue_type_subtitles`, `jellyseerr_report_issue_type_other`, `jellyseerr_report_issue_type_label`, `jellyseerr_report_issue_message`, `jellyseerr_report_issue_message_placeholder`, `jellyseerr_report_issue_title`, `jellyseerr_report_issue_submit`, `jellyseerr_report_issue_submitting`, `jellyseerr_report_issue_success`, `jellyseerr_report_issue_error`, `jellyseerr_report_issue_button`, `jellyseerr_report_unavailable_button`, `jellyseerr_report_unavailable_toast`, `jellyseerr_report_issue_season`, `jellyseerr_report_issue_episode`, `infinite_scroll_retry`, etc.
    Per memory `feedback_je_use_plain_jet.md`: should use plain `JE.t(key)` — but multiple files use `JE.t(...) || 'English fallback'` patterns. The fallback is a code-smell that masks missing keys.
    Fix: Audit `js/locales/*` to confirm each key exists; remove `||` fallbacks once verified.

91. **`api.search` → `data.results.filter(result => result.mediaType !== 'person')` — drops people but page metadata keeps original `totalPages`**
    File: `api.js:236-237`
    Bug: After filtering people, `totalPages` is unchanged but `totalResults` is reduced. Pagination logic relying on `totalPages` may overshoot. Mostly harmless because the next page also filters.

92. **`fetchTvSeasonDetails` returns null on failure but caller expects `detail?.episodes?.[0]?.airDate`**
    File: `api.js:326-333`
    Bug: Callers handle `null` via optional chaining — OK. Skipping.

93. **`person-discovery.applySortOrder` empty-string `releaseDate` localeCompare puts items with no date FIRST in DESC sort**
    File: `person-discovery.js:208-211`
    Bug: `''.localeCompare('2024-01-01')` returns negative, so empty strings sort BEFORE valid dates in DESC. User sees undated items at the top of "Newest" — looks like garbage.
    Fix: Treat empty as `'0000-00-00'` for descending, or filter first.

94. **`buildSeasonsSection` doesn't handle `data.seasons` being `null` (already filters `data.seasons` but then `.length`)**
    File: `more-info-modal.js:1903`
    Bug: `if (!data.seasons || !data.seasons.length) return '';` — OK. Skipping.

95. **`fetchAndRenderResults` calls `prepareResultsWithCollections(...).then` with a closure capturing `query`**
    File: `jellyseerr.js:141-147`
    Bug: After the outer await for `search()`, the `.then` checks `lastProcessedQuery !== query`. OK guard. But between the time the closure runs and `renderJellyseerrResults` is called, `lastProcessedQuery` could change again (the user types). The render then uses stale data. Mitigated by single-frame-render but possible.
    Fix: Re-check `lastProcessedQuery !== query` immediately before each DOM mutation.

96. **Discovery `cleanup()` blowing the genreInfoCache could surface "first-load" delay on every navigation**
    File: `genre-discovery.js:712-742`
    Bug: cleanup clears `processedPages` and AbortController but NOT `genreInfoCache`. So genre name lookups stay cached — good. Skipping.

97. **`network-discovery` `studioInfoCache` not cleared on cleanup**
    File: `network-discovery.js:13, 782-813`
    Bug: studioInfoCache (line 13) lives forever within session; same for `personInfoCache` and `boxsetInfoCache`. Memory grows but bounded by the user's actual library.

98. **`renderJellyseerrResults` doesn't account for noResultsMessage being inside a different parent**
    File: `ui.js:835`
    Bug: `noResultsMessage.parentElement.insertBefore(sectionToInject, noResultsMessage.nextSibling)` — if `noResultsMessage` was added by a Jellyfin theme into a wrapper that's later removed, this throws on a null parent. Mitigated by `if (noResultsMessage)` check.

99. **`fetchUserQuota` returns null when feature disabled but UI doesn't surface that**
    File: `api.js:683`
    Bug: When `JellyseerrShowQuotaInfo === false`, fetchUserQuota returns null and the quota chip silently disappears. Intentional, but no diagnostic.

100. **`jellyseerr.js:471-475` 4K popup outside-click handler doesn't use AbortController for removal — fine because the handler removes it**
     Skipping.

101. **`item-details.js` does not handle `viewshow` events on a non-detail page (e.g., home, library)**
     File: `item-details.js:736`
     Bug: `handleItemDetailsPage` early-returns if hash doesn't include `/details?id=`. OK, but `viewshow` listener still fires for every page — minor wasted work.

102. **`buildModalContent` interpolates `data.tagline`, `data.overview` with escapeHtml — OK**
     Skipping.

103. **`hss-discovery-handler` stops propagation but doesn't `event.preventDefault()` on touch events**
     File: `hss-discovery-handler.js:36-37`
     Bug: Click events are fine. But on iOS some discover cards bind touch handlers that fire before click. The capture-phase click handler may not catch tap-to-open if touchend fires a ghost click.
     Fix: Also intercept `touchend` or use a touchstart guard.

---

## Summary

```
| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 8     | block  |
| HIGH     | 22    | warn   |
| MEDIUM   | 35    | info   |
| LOW      | 38    | note   |

Verdict: BLOCK — 8 CRITICAL issues (especially #1/#2 — silent discovery loss
on user-status failure — match the #1 reported user complaint and issue #577).
```

### Top 5 must-fix before merge

1. **Bug #1 / #2** — `cachedUserStatus` never expires negative results. Causes universal silent discovery failure. Direct cause of issue #577 and most "discovery just disappeared" complaints.
2. **Bug #5** — `#listChildrenCollapsible` selector likely broken on Jellyfin 10.11.x (issues #472, #528). Need fallback selectors and observable diagnostics.
3. **Bug #18** — Non-JSON Seerr responses (Cloudflare challenge, login redirect, HTML error page) cause every discovery to silently die.
4. **Bug #43** — Cache invalidation pattern mismatch (`'jellyseerr:/discover/'` doesn't clear `'genre:'`/`'network:'`/etc. cache prefixes). After requesting a movie, discovery cards keep showing stale "Request" status.
5. **Bug #63** — Undefined `isPlainLeftClick` reference. Throws ReferenceError on every external Seerr link click in strict mode.

### Files needing the most attention

- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/api.js` — cache TTL design flaw, content-type validation
- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/item-details.js` — selector fragility for Jellyfin 10.11
- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/more-info-modal.js` — bypasses request-manager, mutation issues, undefined icon refs
- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/ui.js` — undefined `isPlainLeftClick`, hardcoded English in 4K popup, listener leak in alphaPicker
- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/discovery-filter-utils.js` — cache prefix mismatch causes stale UI after request
- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/jellyseerr.js` — missing AbortController on search, debounce leak on navigation
- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/issue-reporter.js` — N+1 episode fetch, `cachedUserCanReport` dead code, hardcoded English
