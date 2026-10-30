# Phase 4a implementation choices

| ID | Question | Chosen behavior | Reversal |
|---|---|---|---|
| P4a-1 | How long should a finale remain news? | Use the new-release window for TMDB finales, and require the matching episode in the visible library; old completed shows use the optional status badge. | Remove the client freshness condition. |
| P4a-2 | What does Complete Season establish without an upstream episode count? | All non-virtual episodes available in Jellyfin have valid added dates within the just-added window, including single-episode seasons. No invented two-day drop limit. It does not certify acquisition of missing TMDB episodes. | Add a separate expected-count requirement later. |
| P4a-3 | Which source wins for series status? | Jellyfin Continuing/Ended first; TMDB may refine Ended to Cancelled, and supplies the status when Jellyfin has none. | Change seriesStatusBadge only. |
| P4a-4 | How should missing episode_type be resolved? | Read the latest aired episode's TMDB season through the same six-hour cache and rate limiter; if still absent, require the local last-episode flag plus no next episode in that season. | Remove season enrichment or tighten the fallback. |
| P4a-5 | What happens when an aggregate includes hidden episodes? | Conservatively omit all related aggregate facts using StatusEpisodeIds and the existing access/filterRevision path; fallback computes through the caller. | Recompute per user at serve time. |
| P4a-6 | How should new dashboard text be translated when injected JE is absent? | Load the embedded English dictionary and use a local JE.t adapter; injected JE.t is preferred when available. Badge labels use the shared JE.t only. | Adopt the dashboard's future translation framework. |
