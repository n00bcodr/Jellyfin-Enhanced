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
  var export0 = /* @__PURE__ */ sharedExport(shared, "apiClient");
  var export2 = /* @__PURE__ */ sharedExport(shared, "mediaTagsContext");

  // client/generated-shared/stub/client/src/features/media-tags/pipeline/dto.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/media-tags/pipeline/dto");
  var export1 = /* @__PURE__ */ sharedExport(shared2, "errorStatus");
  var export4 = /* @__PURE__ */ sharedExport(shared2, "isRecord");
  var export10 = /* @__PURE__ */ sharedExport(shared2, "record");

  // client/src/features/media-tags/types/people/people-countries.ts
  var COUNTRY_MAP = {
    "United States": "US",
    "USA": "US",
    "America": "US",
    "United Kingdom": "GB",
    "UK": "GB",
    "England": "GB",
    "Scotland": "GB",
    "Wales": "GB",
    "Canada": "CA",
    "Australia": "AU",
    "New Zealand": "NZ",
    "Germany": "DE",
    "France": "FR",
    "Italy": "IT",
    "Spain": "ES",
    "Mexico": "MX",
    "Brazil": "BR",
    "Argentina": "AR",
    "Japan": "JP",
    "South Korea": "KR",
    "China": "CN",
    "India": "IN",
    "Russia": "RU",
    "Sweden": "SE",
    "Norway": "NO",
    "Denmark": "DK",
    "Finland": "FI",
    "Netherlands": "NL",
    "Belgium": "BE",
    "Austria": "AT",
    "Switzerland": "CH",
    "Poland": "PL",
    "Czech Republic": "CZ",
    "Czechia": "CZ",
    "Greece": "GR",
    "Portugal": "PT",
    "Turkey": "TR",
    "Israel": "IL",
    "South Africa": "ZA",
    "Chile": "CL",
    "Colombia": "CO",
    "Peru": "PE",
    "Thailand": "TH",
    "Malaysia": "MY",
    "Singapore": "SG",
    "Philippines": "PH",
    "Indonesia": "ID",
    "Vietnam": "VN",
    "Ukraine": "UA",
    "Iran": "IR",
    "Ireland": "IE",
    "Hungary": "HU",
    "Romania": "RO",
    "Bulgaria": "BG",
    "Croatia": "HR",
    "Serbia": "RS",
    "Slovenia": "SI",
    "Estonia": "EE",
    "Latvia": "LV",
    "Lithuania": "LT",
    "Iceland": "IS",
    "Luxembourg": "LU",
    "Monaco": "MC",
    "Liechtenstein": "LI",
    "Malta": "MT",
    "Cyprus": "CY",
    "Slovakia": "SK",
    "Bosnia and Herzegovina": "BA",
    "Bosnia": "BA",
    "North Macedonia": "MK",
    "Macedonia": "MK",
    "Albania": "AL",
    "Montenegro": "ME",
    "Moldova": "MD",
    "Belarus": "BY",
    "Kosovo": "XK",
    "Georgia": "GE",
    "Armenia": "AM",
    "Azerbaijan": "AZ",
    "Saudi Arabia": "SA",
    "United Arab Emirates": "AE",
    "UAE": "AE",
    "Qatar": "QA",
    "Kuwait": "KW",
    "Bahrain": "BH",
    "Oman": "OM",
    "Jordan": "JO",
    "Lebanon": "LB",
    "Egypt": "EG",
    "Iraq": "IQ",
    "Syria": "SY",
    "Yemen": "YE",
    "Palestine": "PS",
    "Pakistan": "PK",
    "Bangladesh": "BD",
    "Sri Lanka": "LK",
    "Nepal": "NP",
    "Taiwan": "TW",
    "Hong Kong": "HK",
    "Macau": "MO",
    "Kazakhstan": "KZ",
    "Uzbekistan": "UZ",
    "Afghanistan": "AF",
    "Mongolia": "MN",
    "Myanmar": "MM",
    "Cambodia": "KH",
    "Laos": "LA",
    "Venezuela": "VE",
    "Ecuador": "EC",
    "Uruguay": "UY",
    "Paraguay": "PY",
    "Bolivia": "BO",
    "Costa Rica": "CR",
    "Panama": "PA",
    "Nicaragua": "NI",
    "Honduras": "HN",
    "El Salvador": "SV",
    "Guatemala": "GT",
    "Belize": "BZ",
    "Cuba": "CU",
    "Jamaica": "JM",
    "Dominican Republic": "DO",
    "Puerto Rico": "PR",
    "Trinidad and Tobago": "TT",
    "Barbados": "BB",
    "Haiti": "HT",
    "Bahamas": "BS",
    "Guyana": "GY",
    "Suriname": "SR",
    "Nigeria": "NG",
    "Kenya": "KE",
    "Ghana": "GH",
    "Ethiopia": "ET",
    "Morocco": "MA",
    "Algeria": "DZ",
    "Tunisia": "TN",
    "Libya": "LY",
    "Senegal": "SN",
    "Uganda": "UG",
    "Tanzania": "TZ",
    "Zimbabwe": "ZW",
    "Zambia": "ZM",
    "Botswana": "BW",
    "Namibia": "NA",
    "Angola": "AO",
    "Mozambique": "MZ",
    "Madagascar": "MG",
    "Cameroon": "CM",
    "Ivory Coast": "CI",
    "Côte d'Ivoire": "CI",
    "Mali": "ML",
    "Burkina Faso": "BF",
    "Papua New Guinea": "PG",
    "Fiji": "FJ",
    "Samoa": "WS",
    "Tonga": "TO"
  };

  // client/src/features/media-tags/types/people/people-model.ts
  var DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;
  var PERSON_ID_PATTERN = /^[0-9a-f]{32}$/;
  var MAX_BIRTHPLACE_LENGTH = 300;
  function isLeapYear(year) {
    return year % 4 === 0 && year % 100 !== 0 || year % 400 === 0;
  }
  function daysInMonth(year, month) {
    return month === 2 ? isLeapYear(year) ? 29 : 28 : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 31;
  }
  function parseCalendarDate(value) {
    if (typeof value !== "string") return null;
    const match = DATE_PATTERN.exec(value);
    if (!match) return null;
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
    return { y, m, d };
  }
  function compareDates(a, b) {
    return a.y - b.y || a.m - b.m || a.d - b.d;
  }
  function calculateAge(birth, reference) {
    let age = reference.y - birth.y;
    const anniversary = { y: reference.y, m: birth.m, d: Math.min(birth.d, daysInMonth(reference.y, birth.m)) };
    if (compareDates(reference, anniversary) < 0) age--;
    return Math.max(0, age);
  }
  function todayDate(now = /* @__PURE__ */ new Date()) {
    return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  }
  function factsFromResponse(data) {
    if (!export4(data)) return null;
    const facts = {};
    if (parseCalendarDate(data.birthDate)) facts.birthDate = String(data.birthDate).slice(0, 10);
    if (parseCalendarDate(data.deathDate)) facts.deathDate = String(data.deathDate).slice(0, 10);
    if (typeof data.birthPlace === "string" && data.birthPlace.trim()) {
      facts.birthPlace = data.birthPlace.trim().slice(0, MAX_BIRTHPLACE_LENGTH);
    }
    return facts;
  }
  function describePerson(facts, premiere, today) {
    const birth = parseCalendarDate(facts.birthDate);
    const death = parseCalendarDate(facts.deathDate);
    const isDeceased = !!death && compareDates(death, today) <= 0;
    let currentAge = null;
    let ageAtDeath = null;
    let ageAtItemRelease = null;
    if (birth) {
      if (death && isDeceased) ageAtDeath = calculateAge(birth, death);
      else currentAge = calculateAge(birth, today);
      if (premiere) ageAtItemRelease = calculateAge(birth, premiere);
    }
    return { birthPlace: facts.birthPlace || null, isDeceased, currentAge, ageAtDeath, ageAtItemRelease };
  }
  function sanitizeEntry(id, entry, now, ttlMs) {
    if (!PERSON_ID_PATTERN.test(id) || !export4(entry)) return null;
    const ts = entry.ts;
    if (typeof ts !== "number" || !Number.isFinite(ts) || now - ts >= ttlMs || ts > now + 864e5) return null;
    const clean = { ts };
    for (const field of ["b", "d"]) {
      const value = entry[field];
      if (value === void 0) continue;
      if (typeof value !== "string" || value.length !== 10 || !parseCalendarDate(value)) return null;
      clean[field] = value;
    }
    if (entry.p !== void 0) {
      if (typeof entry.p !== "string" || !entry.p || entry.p.length > MAX_BIRTHPLACE_LENGTH) return null;
      clean.p = entry.p;
    }
    return clean;
  }
  function evictOldest(people, maxEntries) {
    if (people.size <= maxEntries) return false;
    const oldestFirst = [...people].sort((a, b) => a[1].ts - b[1].ts);
    for (const [id] of oldestFirst.slice(0, oldestFirst.length - maxEntries)) people.delete(id);
    return true;
  }
  function loadPeopleStore(raw, owner, now, ttlMs, maxEntries) {
    const people = /* @__PURE__ */ new Map();
    if (raw === null || raw === void 0) return { people, rewrite: false };
    let value = null;
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
    const parsed = export10(value);
    if (parsed.v !== 2 || parsed.owner !== owner || !export4(parsed.people)) {
      return { people, rewrite: true };
    }
    let rewrite = false;
    for (const [id, entry] of Object.entries(parsed.people)) {
      const clean = sanitizeEntry(id, entry, now, ttlMs);
      if (clean) people.set(id, clean);
      else rewrite = true;
    }
    if (evictOldest(people, maxEntries)) rewrite = true;
    return { people, rewrite };
  }
  function serializePeopleStore(owner, people) {
    return JSON.stringify({ v: 2, owner, people: Object.fromEntries(people) });
  }

  // client/src/features/media-tags/types/people/peopletags.ts
  function isHotPerson(value) {
    return export4(value) && export4(value.data) && typeof value.timestamp === "number";
  }
  function createPeopleTags(ctx) {
    const JE = ctx.core;
    JE.initializePeopleTags = function() {
      if (!JE.currentSettings?.peopleTagsEnabled) {
        console.log("🪼 Jellyfin Enhanced: People Tags: Feature is disabled in settings.");
        return;
      }
      const logPrefix = "🪼 Jellyfin Enhanced: People Tags:";
      const CACHE_KEY = "JellyfinEnhanced-peopleTagsCache-v2";
      const LEGACY_KEYS = [
        "JellyfinEnhanced-peopleTagsCache",
        "JellyfinEnhanced-peopleTagsCacheTimestamp",
        "JellyfinEnhanced-peopleTagsCacheIdentityOwner"
      ];
      const MAX_CACHED_PEOPLE = 3e3;
      const CACHE_TTL = Number(JE.pluginConfig?.TagsCacheTtlDays || 30) * 24 * 60 * 60 * 1e3;
      const BATCH_SIZE = 100;
      const FIRST_CHUNK_SIZE = 8;
      const RETRY_DELAYS_MS = [1e3, 3e3];
      const MAX_PASSES = 5;
      const currentOwner = () => `${JE.session?.getServerId() || ""}:${JE.session?.getUserId() || export0().getCurrentUserId() || ""}`;
      let storeOwner = currentOwner();
      let peopleStore = /* @__PURE__ */ new Map();
      try {
        for (const key of LEGACY_KEYS) localStorage.removeItem(key);
        const loaded = loadPeopleStore(localStorage.getItem(CACHE_KEY), storeOwner, Date.now(), CACHE_TTL, MAX_CACHED_PEOPLE);
        peopleStore = loaded.people;
        if (loaded.rewrite) persistPeopleStore();
      } catch (e) {
        console.warn(`${logPrefix} Could not read people cache`, e);
        peopleStore = /* @__PURE__ */ new Map();
      }
      const Hot = JE._hotCache = JE._hotCache || { ttl: CACHE_TTL };
      const sharedHot = Hot.peopleTags;
      const hotPeople = typeof sharedHot === "object" ? sharedHot : /* @__PURE__ */ new Map();
      Hot.peopleTags = hotPeople;
      JE.session?.onUserChange("people-tags", (change) => {
        resetBatchController();
        for (const itemId of [...prefetches.keys()]) dropPrefetch(itemId);
        peopleStore = /* @__PURE__ */ new Map();
        hotPeople.clear();
        storeOwner = `${change.serverId || ""}:${change.userId || ""}`;
        persistPeopleStore();
      });
      let processedCastMembers = /* @__PURE__ */ new WeakSet();
      let pendingCards = /* @__PURE__ */ new WeakSet();
      let failedCards = /* @__PURE__ */ new WeakSet();
      let lastProcessedItemId = null;
      let peopleTagsComplete = false;
      let isProcessing = false;
      let processingFast = false;
      let debouncedSkipped = false;
      let cardsClaimed = false;
      const lifecycle = JE.core.lifecycle.register("people-tags");
      lifecycle.teardown();
      let batchController = null;
      const retryWaits = /* @__PURE__ */ new Set();
      function resetBatchController() {
        cancelRetryWaits();
        if (batchController) {
          batchController.abort();
          lifecycle.untrack(batchController);
        }
        batchController = lifecycle.track(new AbortController());
        return batchController;
      }
      const prefetches = /* @__PURE__ */ new Map();
      function dropPrefetch(itemId) {
        const entry = prefetches.get(itemId);
        if (!entry) return;
        prefetches.delete(itemId);
        if (entry.ctl) {
          entry.ctl.abort();
          lifecycle.untrack(entry.ctl);
        }
      }
      JE.core.ui.injectCss("je-people-tags-styles", `

            .je-msym-rounded {
                font-family: 'JE Material Symbols Rounded';
                font-weight: normal;
                font-style: normal;
                font-size: 24px;
                line-height: 1;
                letter-spacing: normal;
                text-transform: none;
                display: inline-block;
                white-space: nowrap;
                word-wrap: normal;
                direction: ltr;
                -webkit-font-feature-settings: 'liga';
                -moz-font-feature-settings: 'liga';
                font-feature-settings: 'liga';
                -webkit-font-smoothing: antialiased;
            }

            /* Ensure cardScalable has position: relative for absolute positioned overlays */
            #castCollapsible .personCard .cardScalable {
                position: relative;
            }

            /* Deceased poster styling */
            .je-deceased-poster .cardImageContainer {
                filter: grayscale(100%) opacity(0.7);
            }

            .je-deceased-poster .cardScalable::after {
                content: "✝";
                /* Not in Jellyfin's web fonts: name the generic family directly so
                   the first cross does not walk the CJK families of the body
                   stack (a ~500 ms one-off layout stall on Linux, see icons.js). */
                font-family: sans-serif;
                position: absolute;
                top: 8px;
                right: 8px;
                z-index: 3;
                color: white;
                font-weight: bold;
                font-size: 2em;
                text-shadow: 0 0 4px black;
                pointer-events: none;
            }

            /* People tag banner styling */
            .je-people-tag-banner {
                max-width: 100%;
                box-sizing: border-box;
            }

            /* Round portraits: themes clip the whole .cardScalable to a circle, which
               crops corner-anchored tags. Clip the image instead so age badges can
               overlap the edge, and inset the birthplace pill. */
            .je-people-round .cardScalable {
                overflow: visible !important;
                aspect-ratio: 1 / 1;
            }
            .je-people-round .cardPadder {
                display: none !important;
            }
            .je-people-round .cardImageContainer,
            .je-people-round .cardOverlayContainer {
                bottom: auto !important;
                height: auto !important;
                aspect-ratio: 1 / 1;
                border-radius: 50% !important;
                overflow: hidden;
            }
            .je-people-round .je-people-age-container {
                top: 2% !important;
                left: -6% !important;
                gap: 3px !important;
            }
            .je-people-round .je-people-age-chip {
                padding: 2px 6px !important;
                font-size: 11px !important;
                border-radius: 999px !important;
                box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6) !important;
            }
            .je-people-round .je-people-place-banner {
                left: 12% !important;
                right: 12% !important;
                bottom: 9% !important;
                padding: 3px 8px !important;
                justify-content: center;
                border-radius: 999px;
                background: rgba(0, 0, 0, 0.7) !important;
            }
            .je-people-round .je-people-place-text {
                flex: 0 1 auto !important;
            }
        `);
      console.log(`${logPrefix} Initialized`);
      function getCountryCodeFromBirthPlace(placeString) {
        if (!placeString || typeof placeString !== "string") return null;
        const parts = placeString.split(",").map((p) => p.trim());
        if (parts.length === 0) return null;
        const lastPart = parts[parts.length - 1] ?? "";
        for (const [countryName, code] of Object.entries(COUNTRY_MAP)) {
          if (countryName.toLowerCase() === lastPart.toLowerCase()) {
            return code;
          }
        }
        return null;
      }
      function normalizeId(id) {
        return String(id).toLowerCase().replace(/-/g, "");
      }
      function getCachedFacts(personKey, now) {
        const hot = hotPeople.get(personKey);
        if (isHotPerson(hot) && now - hot.timestamp < CACHE_TTL) return hot.data;
        const entry = peopleStore.get(personKey);
        if (entry && now - entry.ts < CACHE_TTL) {
          const data = { birthDate: entry.b, deathDate: entry.d, birthPlace: entry.p };
          hotPeople.set(personKey, { data, timestamp: entry.ts });
          return data;
        }
        return null;
      }
      function rememberFacts(personKey, facts, now) {
        const entry = { ts: now };
        if (facts.birthDate) entry.b = facts.birthDate;
        if (facts.deathDate) entry.d = facts.deathDate;
        if (facts.birthPlace) entry.p = facts.birthPlace;
        peopleStore.delete(personKey);
        peopleStore.set(personKey, entry);
        hotPeople.set(personKey, { data: facts, timestamp: now });
      }
      function persistPeopleStore() {
        evictOldest(peopleStore, MAX_CACHED_PEOPLE);
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            localStorage.setItem(CACHE_KEY, serializePeopleStore(storeOwner, peopleStore));
            return;
          } catch (e) {
            if (attempt === 0 && peopleStore.size > 0) {
              evictOldest(peopleStore, Math.floor(peopleStore.size / 2));
              continue;
            }
            console.debug(`${logPrefix} People cache not persisted`, e);
            return;
          }
        }
      }
      function getItemPremiereDate(itemId) {
        const load = typeof JE.helpers?.getItemCached === "function" ? JE.helpers.getItemCached(itemId) : export0().getItem(export0().getCurrentUserId(), itemId);
        return Promise.resolve(load).then((item) => parseCalendarDate(export10(item).PremiereDate)).catch(() => null);
      }
      function peopleInfoPath(ids) {
        return `/people/info?ids=${ids.map(encodeURIComponent).join(",")}`;
      }
      function rememberResponse(ids, response) {
        const people = export10(export10(response).people);
        const now = Date.now();
        let cached = false;
        const facts = ids.map((id) => {
          const personFacts = factsFromResponse(people[normalizeId(id)]);
          if (personFacts) {
            rememberFacts(normalizeId(id), personFacts, now);
            cached = true;
          }
          return personFacts;
        });
        return { facts, cached };
      }
      function chunkMisses(list) {
        const chunks = [];
        if (list.length > 0) {
          chunks.push(list.slice(0, FIRST_CHUNK_SIZE));
          for (let i = FIRST_CHUNK_SIZE; i < list.length; i += BATCH_SIZE) {
            chunks.push(list.slice(i, i + BATCH_SIZE));
          }
        }
        return chunks;
      }
      function paintPerson(cards, personId, facts, premiere) {
        const view = describePerson(facts, premiere, todayDate());
        for (const card of cards) {
          renderPersonCard(card, personId, view);
          pendingCards.delete(card);
          processedCastMembers.add(card);
        }
      }
      function isCurrentEpoch(epoch) {
        return !JE.session || JE.session.isCurrent(epoch);
      }
      function waitForRetry(ms) {
        return new Promise((resolve) => {
          const wait = { timeoutId: 0, cancel: () => {
          } };
          const finish = (proceed) => {
            if (!retryWaits.delete(wait)) return;
            lifecycle.untrack(wait.cancel);
            resolve(proceed);
          };
          wait.cancel = () => {
            clearTimeout(wait.timeoutId);
            finish(false);
          };
          wait.timeoutId = setTimeout(() => finish(true), ms);
          retryWaits.add(wait);
          lifecycle.track(wait.cancel);
        });
      }
      function cancelRetryWaits() {
        for (const wait of [...retryWaits]) wait.cancel();
      }
      function releaseCards(entries, failed = false) {
        for (const [, cards] of entries) {
          for (const card of cards) {
            pendingCards.delete(card);
            if (failed) failedCards.add(card);
          }
        }
      }
      async function fetchAndRenderChunk(chunk, itemId, signal, requestEpoch, premierePromise) {
        const ids = chunk.map(([personId]) => personId);
        const path = peopleInfoPath(ids);
        let response = null;
        for (let attempt = 0; ; attempt++) {
          try {
            response = await JE.core.api.plugin(path, { signal, skipRetry: true });
            break;
          } catch (error) {
            if (signal.aborted) {
              releaseCards(chunk);
              return false;
            }
            const status = export1(error);
            const retryable = !status || status >= 500 || status === 408 || status === 429;
            if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
              console.warn(`${logPrefix} Failed to fetch person info for ${ids.length} people:`, error);
              releaseCards(chunk, true);
              return false;
            }
            const retryDelay = RETRY_DELAYS_MS[attempt] ?? 0;
            console.debug(`${logPrefix} Person info request failed, retrying in ${retryDelay}ms`, error);
            if (!await waitForRetry(retryDelay) || signal.aborted) {
              releaseCards(chunk);
              return false;
            }
          }
        }
        if (signal.aborted || !isCurrentEpoch(requestEpoch) || lastProcessedItemId !== itemId) {
          releaseCards(chunk);
          return false;
        }
        const { facts, cached } = rememberResponse(ids, response);
        const answered = chunk.map((entry, i) => [entry, facts[i] ?? null]);
        const premiere = await premierePromise;
        if (signal.aborted || !isCurrentEpoch(requestEpoch) || lastProcessedItemId !== itemId) {
          releaseCards(chunk);
          return cached;
        }
        applyAnswers(answered, premiere);
        return cached;
      }
      function applyAnswers(answered, premiere) {
        const paint = !!JE.currentSettings?.peopleTagsEnabled;
        for (const [[personId, cards], facts] of answered) {
          if (!paint) {
            releaseCards([[personId, cards]]);
          } else if (facts) {
            paintPerson(cards, personId, facts, premiere);
          } else {
            for (const card of cards) {
              pendingCards.delete(card);
              processedCastMembers.add(card);
            }
          }
        }
      }
      async function joinPrefetchedChunk(chunk, outcomePromise, itemId, signal, requestEpoch, premierePromise) {
        const outcome = await outcomePromise;
        const premiere = await premierePromise;
        if (signal.aborted || !isCurrentEpoch(requestEpoch) || lastProcessedItemId !== itemId) {
          releaseCards(chunk);
          return false;
        }
        if (outcome.status !== "answered") {
          return fetchAndRenderChunk(chunk, itemId, signal, requestEpoch, premierePromise);
        }
        applyAnswers(chunk.map((entry) => [entry, outcome.factsById.get(entry[0]) || null]), premiere);
        return false;
      }
      function createAgeChip(variant, background, iconName, age) {
        const ageChip = document.createElement("div");
        ageChip.className = `je-people-age-chip je-people-age-${variant}`;
        ageChip.style.cssText = `
                display: flex;
                align-items: center;
                gap: 4px;
                background: ${background};
                padding: 3px 8px;
                border-radius: 3px;
                font-size: 11px;
                font-weight: 500;
                color: white;
                box-shadow: 0 1px 3px rgba(0,0,0,0.3);
            `;
        const icon = document.createElement("span");
        icon.className = "je-msym-rounded je-people-age-icon";
        icon.textContent = iconName;
        icon.style.cssText = "font-size: 13px;";
        ageChip.appendChild(icon);
        const text = document.createElement("span");
        text.className = "je-people-age-text";
        const short = typeof JE.t === "function" ? JE.t("tag_people_age_short", { age }) : "tag_people_age_short";
        text.textContent = short === "tag_people_age_short" ? `${age}y` : short;
        ageChip.appendChild(text);
        return ageChip;
      }
      function createPeopleTag(personData) {
        const ageContainer = document.createElement("div");
        ageContainer.className = "je-people-age-container";
        ageContainer.style.cssText = `
                position: absolute;
                top: 8px;
                left: 8px;
                display: flex;
                flex-direction: column;
                gap: 4px;
                align-items: flex-start;
                z-index: 3;
                pointer-events: none;
            `;
        if (personData.isDeceased && personData.ageAtDeath !== null && personData.ageAtDeath !== void 0) {
          ageContainer.appendChild(createAgeChip("deceased", "rgba(180, 50, 50, 0.85)", "event_busy", personData.ageAtDeath));
        } else if (personData.currentAge !== null && personData.currentAge !== void 0) {
          ageContainer.appendChild(createAgeChip("current", "rgba(100, 170, 100, 0.85)", "cake", personData.currentAge));
        }
        if (personData.ageAtItemRelease !== null && personData.ageAtItemRelease !== void 0) {
          ageContainer.appendChild(createAgeChip("release", "rgba(70, 130, 180, 0.85)", "movie", personData.ageAtItemRelease));
        }
        const placeContainer = document.createElement("div");
        placeContainer.className = "je-people-place-banner";
        placeContainer.style.cssText = `
                position: absolute;
                bottom: 0;
                left: 0;
                right: 0;
                background: linear-gradient(to top, rgba(0,0,0,0.9), rgba(0,0,0,0.7), transparent);
                padding: 12px 8px 8px 8px;
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 11px;
                color: white;
                z-index: 1;
                pointer-events: none;
            `;
        if (personData.birthPlace) {
          const countryCode = getCountryCodeFromBirthPlace(personData.birthPlace);
          if (countryCode) {
            const flagImg = document.createElement("img");
            flagImg.className = "je-people-flag";
            flagImg.src = JE.cdn.flagPng(countryCode);
            flagImg.style.cssText = "width: 16px; height: 12px; border-radius: 2px; object-fit: cover;";
            flagImg.alt = countryCode;
            placeContainer.appendChild(flagImg);
          }
          const locationIcon = document.createElement("span");
          locationIcon.className = "je-msym-rounded je-people-place-icon";
          locationIcon.textContent = "place";
          locationIcon.style.cssText = "font-size: 14px; opacity: 0.9;";
          placeContainer.appendChild(locationIcon);
          const placeText = document.createElement("span");
          placeText.className = "je-people-place-text";
          placeText.textContent = personData.birthPlace;
          placeText.style.cssText = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; opacity: 0.95;";
          placeText.title = personData.birthPlace;
          placeContainer.appendChild(placeText);
        }
        return { ageContainer, placeContainer };
      }
      function renderPersonCard(card, personId, personData) {
        try {
          if (personData.isDeceased) {
            card.classList.add("je-deceased-poster");
            console.debug(`${logPrefix} Marked ${personId} as deceased`);
          }
          const cardScalable = card.querySelector(".cardScalable");
          if (!cardScalable) {
            console.warn(`${logPrefix} No cardScalable found for ${personId}`);
            return;
          }
          const radius = getComputedStyle(cardScalable).borderRadius;
          card.classList.toggle("je-people-round", radius.includes("%") && parseFloat(radius) >= 40);
          const existingAgeContainer = cardScalable.querySelector(".je-people-age-container");
          if (existingAgeContainer) {
            existingAgeContainer.remove();
          }
          const existingPlaceBanner = cardScalable.querySelector(".je-people-place-banner");
          if (existingPlaceBanner) {
            existingPlaceBanner.remove();
          }
          const tags = createPeopleTag(personData);
          if (tags.ageContainer.children.length > 0) {
            cardScalable.appendChild(tags.ageContainer);
          }
          if (tags.placeContainer.children.length > 0) {
            cardScalable.appendChild(tags.placeContainer);
          }
        } catch (error) {
          console.warn(`${logPrefix} Error processing cast member ${personId}:`, error);
        }
      }
      function forEachCandidateCard(page, fn, log = false) {
        for (const collapsibleSelector of ["#castCollapsible", "#guestCastCollapsible"]) {
          const collapsible = page ? page.querySelector(collapsibleSelector) : document.querySelector(`#itemDetailPage:not(.hide) ${collapsibleSelector}`);
          if (!collapsible) continue;
          const castCards = collapsible.querySelectorAll(".personCard");
          if (castCards.length === 0) continue;
          if (log) console.debug(`${logPrefix} Found ${castCards.length} cast members in ${collapsibleSelector}`);
          for (const card of castCards) fn(card);
        }
      }
      function collectPendingCards() {
        const groups = /* @__PURE__ */ new Map();
        forEachCandidateCard(null, (card) => {
          if (processedCastMembers.has(card) || pendingCards.has(card) || failedCards.has(card)) return;
          const personId = card.getAttribute("data-id");
          if (!personId) return;
          pendingCards.add(card);
          cardsClaimed = true;
          const cards = groups.get(personId);
          if (cards) cards.push(card);
          else groups.set(personId, [card]);
        }, true);
        return groups;
      }
      async function processPendingCards(groups, currentItemId, signal) {
        const entries = [...groups];
        if (!JE.currentSettings?.peopleTagsEnabled) {
          releaseCards(entries);
          return;
        }
        const now = Date.now();
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const premierePromise = getItemPremiereDate(currentItemId);
        const prefetched = prefetches.get(currentItemId)?.people;
        const hits = [];
        const joined = /* @__PURE__ */ new Map();
        const misses = [];
        for (const entry of entries) {
          const facts = getCachedFacts(normalizeId(entry[0]), now);
          const outcome = facts ? null : prefetched?.get(entry[0]);
          if (facts) {
            hits.push([entry, facts]);
          } else if (outcome) {
            const waiting = joined.get(outcome);
            if (waiting) waiting.push(entry);
            else joined.set(outcome, [entry]);
          } else {
            misses.push(entry);
          }
        }
        const pendingChunks = chunkMisses(misses).map((chunk) => fetchAndRenderChunk(chunk, currentItemId, signal, requestEpoch, premierePromise));
        for (const [outcome, chunk] of joined) {
          pendingChunks.push(joinPrefetchedChunk(chunk, outcome, currentItemId, signal, requestEpoch, premierePromise));
        }
        if (hits.length > 0) {
          const premiere = await premierePromise;
          if (signal.aborted || !isCurrentEpoch(requestEpoch) || lastProcessedItemId !== currentItemId || !JE.currentSettings?.peopleTagsEnabled) {
            releaseCards(hits.map(([entry]) => entry));
          } else {
            for (const [[personId, cards], facts] of hits) paintPerson(cards, personId, facts, premiere);
          }
        }
        const results = await Promise.all(pendingChunks);
        if (results.some(Boolean) && isCurrentEpoch(requestEpoch)) persistPeopleStore();
      }
      async function processCastMembers() {
        if (isProcessing) return;
        isProcessing = true;
        try {
          const hash = window.location.hash;
          const params = new URLSearchParams(hash.split("?")[1]);
          const currentItemId = params.get("id");
          if (!currentItemId) {
            console.debug(`${logPrefix} No item ID found in URL`);
            return;
          }
          const signal = (batchController || resetBatchController()).signal;
          for (let pass = 0; pass < MAX_PASSES && JE.currentSettings?.peopleTagsEnabled; pass++) {
            const pending = collectPendingCards();
            if (pending.size === 0) break;
            await processPendingCards(pending, currentItemId, signal);
            if (signal.aborted || lastProcessedItemId !== currentItemId) break;
          }
        } catch (error) {
          console.error(`${logPrefix} Error in processCastMembers:`, error);
        } finally {
          isProcessing = false;
        }
      }
      function currentHashItemId() {
        try {
          return new URLSearchParams(window.location.hash.split("?")[1]).get("id");
        } catch {
          return null;
        }
      }
      function castOrderPersonIds(item) {
        if (!Array.isArray(item?.People)) return null;
        const cast = [];
        const guestStars = [];
        for (const entry of item.People) {
          const person = export10(entry);
          if (typeof person.Id !== "string" || !person.Id) return null;
          if (person.Type === "Artist" || person.Type === "AlbumArtist") return null;
          (person.Type === "GuestStar" ? guestStars : cast).push(person.Id);
        }
        return [.../* @__PURE__ */ new Set([...cast, ...guestStars])];
      }
      function initialize() {
        console.debug(`${logPrefix} Initializing with managed observer pattern`);
        function runPeopleTags(fast) {
          if (!JE.currentSettings?.peopleTagsEnabled) return;
          const castSection = document.querySelector("#itemDetailPage:not(.hide) #castCollapsible");
          const guestCastSection = document.querySelector("#itemDetailPage:not(.hide) #guestCastCollapsible");
          if (!castSection && !guestCastSection) return;
          try {
            const itemId = new URLSearchParams(window.location.hash.split("?")[1]).get("id");
            if (!itemId) return;
            if (lastProcessedItemId !== itemId) {
              lastProcessedItemId = itemId;
              resetBatchController();
              processedCastMembers = /* @__PURE__ */ new WeakSet();
              pendingCards = /* @__PURE__ */ new WeakSet();
              failedCards = /* @__PURE__ */ new WeakSet();
              peopleTagsComplete = false;
              debouncedSkipped = false;
              cardsClaimed = false;
              for (const key of [...prefetches.keys()]) {
                if (key !== itemId) dropPrefetch(key);
              }
              console.debug(`${logPrefix} New item detected: ${itemId}`);
            }
            if (peopleTagsComplete) {
              return;
            }
            if (isProcessing) {
              if (!fast && processingFast) debouncedSkipped = true;
              return;
            }
            const processingItemId = itemId;
            processingFast = fast;
            processCastMembers().then(() => {
              if (lastProcessedItemId !== processingItemId) {
                debouncedSkipped = false;
                handlePeopleTags();
                return;
              }
              if (fast) {
                if (debouncedSkipped) {
                  debouncedSkipped = false;
                  handlePeopleTags();
                }
                return;
              }
              setTimeout(() => {
                if (lastProcessedItemId === processingItemId && (cardsClaimed || !prefetches.has(processingItemId))) {
                  peopleTagsComplete = true;
                }
              }, 2e3);
            });
          } catch (e) {
          }
        }
        const helpers = JE.helpers;
        if (!helpers) return;
        const handlePeopleTags = helpers.debounce(() => runPeopleTags(false), 100);
        function tryFastPath(hashId = currentHashItemId()) {
          const entry = hashId ? prefetches.get(hashId) : null;
          if (!entry || !entry.view || !isCurrentEpoch(entry.epoch) || !JE.currentSettings?.peopleTagsEnabled) return;
          const sameItem = lastProcessedItemId === hashId;
          if (sameItem && (peopleTagsComplete || isProcessing)) return;
          if (document.querySelector("#itemDetailPage:not(.hide)") !== entry.view) return;
          const now = Date.now();
          let unclaimed = 0;
          let covered = true;
          forEachCandidateCard(entry.view, (card) => {
            if (!covered) return;
            if (sameItem && (processedCastMembers.has(card) || pendingCards.has(card) || failedCards.has(card))) return;
            const personId = card.getAttribute("data-id");
            if (!personId) return;
            unclaimed++;
            if (!entry.people.has(personId) && !getCachedFacts(normalizeId(personId), now)) covered = false;
          });
          if (covered && unclaimed > 0) runPeopleTags(true);
        }
        function prefetch(itemId, item, view, epoch) {
          if (!JE.currentSettings?.peopleTagsEnabled || !isCurrentEpoch(epoch) || typeof JE.core?.api?.plugin !== "function") return;
          if (!itemId || prefetches.has(itemId)) return;
          if (lastProcessedItemId === itemId && (cardsClaimed || peopleTagsComplete)) return;
          const ids = castOrderPersonIds(item);
          if (!ids || ids.length === 0) return;
          for (const key of [...prefetches.keys()]) {
            if (key !== lastProcessedItemId) dropPrefetch(key);
          }
          const now = Date.now();
          const misses = ids.filter((id) => !getCachedFacts(normalizeId(id), now));
          const ctl = misses.length ? lifecycle.track(new AbortController()) : null;
          const entry = { ctl, view, epoch, people: /* @__PURE__ */ new Map() };
          prefetches.set(itemId, entry);
          const outcomes = chunkMisses(misses).map((chunk) => {
            const signal = ctl?.signal;
            const outcome = JE.core.api.plugin(peopleInfoPath(chunk), { ...signal ? { signal } : {}, skipRetry: true }).then((response) => {
              if (signal?.aborted || !isCurrentEpoch(epoch)) return { status: "aborted" };
              const { facts, cached } = rememberResponse(chunk, response);
              return { status: "answered", factsById: new Map(chunk.map((id, i) => [id, facts[i] ?? null])), cached };
            }).catch((error) => {
              console.debug(`${logPrefix} Person info prefetch failed`, error);
              return { status: signal?.aborted ? "aborted" : "failed" };
            });
            for (const id of chunk) entry.people.set(id, outcome);
            return outcome;
          });
          if (ctl) {
            Promise.all(outcomes).then((settled) => {
              if (settled.some((outcome) => outcome.cached) && isCurrentEpoch(epoch)) persistPeopleStore();
              lifecycle.untrack(ctl);
            });
          }
          tryFastPath();
        }
        function leave(itemId) {
          if (lastProcessedItemId !== itemId || !cardsClaimed) {
            dropPrefetch(itemId);
            return;
          }
          const entry = prefetches.get(itemId);
          if (entry) entry.view = null;
        }
        helpers.createObserver?.(
          "people-tags",
          (mutations) => {
            if (!JE.currentSettings?.peopleTagsEnabled) return;
            const hashId = currentHashItemId();
            if (hashId && hashId !== lastProcessedItemId) {
              peopleTagsComplete = false;
            }
            if (peopleTagsComplete) return;
            if (!document.querySelector("#itemDetailPage:not(.hide)")) return;
            let hasNewNodes = false;
            for (const mutation of mutations) {
              if (mutation.addedNodes.length > 0) {
                hasNewNodes = true;
                break;
              }
            }
            if (!hasNewNodes) return;
            const castSection = document.querySelector("#itemDetailPage:not(.hide) #castCollapsible");
            const guestCastSection = document.querySelector("#itemDetailPage:not(.hide) #guestCastCollapsible");
            if (!castSection && !guestCastSection) return;
            tryFastPath(hashId);
            handlePeopleTags();
          },
          document.body,
          {
            childList: true,
            subtree: true
          }
        );
        handlePeopleTags();
        ctx.own.peopleTags = JE.peopleTags = { prefetch, leave };
        console.debug(`${logPrefix} Initialization complete`);
      }
      initialize();
    };
  }

  // client/src/features/media-tags/types/people/peopletags-entry.ts
  createPeopleTags(export2());
})();
})();
//# sourceMappingURL=peopletags.js.map
