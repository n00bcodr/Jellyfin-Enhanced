# Changelog

## [1.0.0.0] - 2026-11-08

### Changed
- Renamed plugin project/namespace from `Jellyfin.Plugin.JellyfinEnhanced` to `Jellyfin.Plugin.SpoilerGuard`.
- Version bumped to 1.0.0.0 (manifest + assembly).
- Updated repository metadata, About, and topics to reflect Spoiler Guard Lite only.

### Removed
- Legacy Jellyfin-Enhanced contributor docs, security guidelines, funding, and bug issue template.
- Empty placeholder `images/` directory and empty `.vscode` settings.
- All prior pre-1.0 releases, tags, and failed workflow runs/deployments for a clean 1.0 start.

### Kept
- CI workflows retained for commit checks.
- Spoiler Guard Lite features: server-side episode thumbnail blurring, spoiler metadata stripping, Moonfin/Trickplay bypass, scheduled library scans.