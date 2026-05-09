# Section A: configPage findings + Section B: Issue #591 hypothesis

[Output trimmed to fit. See full output above. Key findings:]

## Section A — configPage Seerr-related bugs

A1.  Stale "Last tested" cache survives invalid-URL save (Medium) — configPage.html:6298-6303
A2.  JellyseerrUrls saved without scheme/format validation (Medium) — :4310, :2807
A3.  JellyseerrApiKey accepts whitespace-mixed strings (Low-Med) — :4311, :2808, :5055
A4.  connectionErrorMessage collapses 401/403 into one (Medium) — :6336
A5.  Test button truncates errors at exactly 80 chars (Low) — :2852
A6.  Test connection: 200 with {ok:false} swallowed (Low) — :2823-2839
A7.  URL Mapping format check rejects URLs with literal | in path (Low) — :6448
A8.  URL Mapping validator stale-state vs save (Low) — :6501-6518
A9.  Mapping subdomain duplicates not warned (Low) — :6517
A10. validateSeerrMappingsBtn no signal for whitespace-only input (Low) — :6671-6679
A11. Save flow: Test/Save race corrupts UI cache (Medium) — :2806-2855, :4563-4602
A12. Blocked-users load/save format asymmetry (Low) — :6968-6970, :7024
A13. Trigger-scan-now: defensive parsing gap (Low) — :6726-6730
A14. Trigger scan doesn't honor _testToken (Low-Med) — :6705-6749
A15. Permission Audit error message exposure broad (Low) — :7218-7222
A16. Audit summary partial-render on mid-try error (UX Low) — :7225-7227
A17. "Import Users Now" triggers full saveConfig (incl. arr alerts) (Medium) — :7027-7045
A18. **HIGH: Blocklist hidden field WIPED if /Users API fails to load** — :7012-7015, :7024
A19. hasJellyseerrConfigured allows malformed URL to pass (Medium) — :5052-5056
A20. IsAllowedUrl rejection shows "Missing URL" message (Low) — controller:677-678
A21. JellyseerrUseMoreInfoModal default inconsistency (Low) — :4022, :4291
A22. JellyseerrShowSearchResults parent-deps misses 4K toggles (Low) — :5287
A23. Translation coverage gap on admin config page — many lines
A24. Test button disabled state can leak on synchronous throw (Low) — :2806-2855
A25. Sign-in requirement banner buried under URL Mappings details (UX Low) — :1048-1054

## Section B — Issue #591: ObjectDisposedException root cause

NOT a JE bug. Root cause: FileTransformation plugin's PluginInterface.RegisterTransformation
captures the application root IServiceProvider once at FT plugin construction, and JE's startup
registers via that captured closure. When JE's config save:
1. Writes Jellyfin.Plugin.JellyfinEnhanced.xml
2. FT's ConfigVersionService (FileSystemWatcher on plugin XMLs) bumps its version counter
3. FT injects auto-reload script into /web/ index.html
4. Browser reload + slow Seerr URL keeps /web/* requests in-flight long enough
5. If the captured ServiceProvider was disposed mid-flight (host scope rebuild), GetRequiredService throws

Evidence:
- StartupService.RegisterFileTransformation registers a TRIVIAL static callback (TransformationPatches.IndexHtml) that does NOT touch ServiceProvider — JE-side closure is innocent
- JellyfinEnhanced.cs has no OnConfigurationUpdated override and no DI registration on save
- FT's FileTransformationPlugin.cs:21-26 captures IServiceProvider at construction (root, not scoped)
- /home/jake/Documents/jellyfin-plugin-file-transformation/issues/bugs/di-race/ exists locally — confirms FT maintainer is aware

The Seerr URL specifically widens the failure window because slow validation timeouts (15s) + the
auto-reload chain keeps multiple /web/* requests in-flight while host scope rebuilds.

**Recommend: file upstream bug against FileTransformation, not JE.**

JE could mitigate by:
- A19 fix (block save of malformed URL) reduces the trigger surface
- Add config-save URL validation that rejects unreachable URLs with confirmation prompt
- Optionally fall back to Jellyfin's InjectScript() helper (though loses asset-replace features)
