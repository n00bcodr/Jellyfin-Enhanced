# Tag episode selection regression tests

Run with a current .NET 10 SDK/runtime:

```sh
dotnet test tests/TagEpisodeSelector.Tests
```

Or use Docker:

```sh
docker run --rm -v "$PWD:/work" -w /work mcr.microsoft.com/dotnet/sdk:10.0 \
  dotnet test tests/TagEpisodeSelector.Tests
```

The test project links the production selector source. It covers streamless and
subtitle-only sources, alternate media sources, more than one page of unusable
episodes or specials, specials-only libraries, early exit within a Specials season,
empty results, and the query's
virtual-item, container, and user filters.

## Issue #817 reproduction and verification

Investigation used checkout `d44fa3f`, including the episode-selection changes in
`0d08bef`, and all 18 comments on
[issue #817](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/817), including
the screenshots and attached server log. The log confirms a completed full cache
rebuild, so an unfinished generation task does not explain the report.

Three isolated test series each contained a generated H264 1080p MKV with Japanese
AAC audio, dated 2020-01-01:

- **Control:** only the real episode.
- **Virtual First:** an earlier virtual episode (season zero, dated 1990-01-01)
  without a file or streams, plus the real episode. The virtual row and ancestor
  links were seeded in the stopped test container's database to reproduce stored
  missing-episode metadata without depending on a remote metadata provider.
- **Streamless First:** an earlier disc-stub special and 55 disc-stub regular
  episodes dated 2000-01-01, followed by the real episode. Jellyfin scanned the
  `.bluray.disc` files normally; their media sources contain no streams.

On Jellyfin 12.1, the baseline produced:

| Series | Batch endpoint's selected episode | Rebuilt server cache |
| --- | --- | --- |
| Control | Real episode, 2 streams | 2 streams, `jpn` |
| Virtual First | Virtual missing special, 0 streams | 2 streams, `jpn` |
| Streamless First | Streamless special, 0 streams | Streamless regular episode, 0 streams, no languages |

The batch endpoint still used the earliest episode with `Limit = 1`, bypassing
the browser's virtual-item filter by supplying `FirstEpisode.Id` directly. The
server cache's earlier fix excluded virtual items but tested source count instead
of stream content and stopped at 20 candidates. Rebuilding repeated those choices.

With the shared selector, both endpoints choose the real episode for all three
series on Jellyfin **12.1 and 10.11.11**. Each returns two streams and Japanese
audio. The first usable regular episode is beyond the first 50-candidate page in
the streamless fixture. Startup also discards schema-v4 cache entries and rebuilds
them as schema v5 automatically.

Chromium verification against Jellyfin 12.1's actual series listing confirmed
1080p/H264 badges and Japanese flags on all three series, both with server caching
enabled and with it disabled. Fresh browser contexts avoid existing local caches.
No page errors were observed. Switching back to the baseline DLL reproduces the
missing overlays in the same library.

Both `jf12` and `jf10` plugin targets build with zero warnings/errors. These are
controlled reproductions of the reported failure mechanism, not an inspection of
the reporters' private databases or a native iOS test.
