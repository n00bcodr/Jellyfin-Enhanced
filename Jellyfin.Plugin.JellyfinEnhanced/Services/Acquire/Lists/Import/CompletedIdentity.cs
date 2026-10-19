using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import
{
    /// <summary>
    /// A title's identity once it is complete enough to find every library copy of it (review round 3, D53 rule 2 at the
    /// candidate): the ids the candidate or source entry carries, filled in through the title lookup when the library
    /// holds copies of that kind that carry none of them. Built ONCE per candidate or entry, before anything reads it,
    /// and only by <see cref="Completion"/> (the constructor is private), so every consumer that takes one (the
    /// physical-title check, "in library" (<see cref="LibraryScope"/>), Spoiler Guard (<see cref="ImportViewer"/>), the
    /// review's ids, the placeholder built from a candidate, the snapshot's filter) sees the same completed ids, and a
    /// consumer asked under the TMDB id alone can't be written.
    /// </summary>
    public sealed class CompletedIdentity
    {
        private readonly ImportIdentity _ids;

        private CompletedIdentity(ImportIdentity ids)
        {
            _ids = ids;
        }

        /// <summary>Movie (else series).</summary>
        public bool Movie => _ids.Movie;

        /// <summary>The usable title keys of every id.</summary>
        public IReadOnlyList<TitleKey> Keys => _ids.Keys;

        /// <summary>TMDB id, if known.</summary>
        public int? Tmdb => Has("tmdb") ? _ids.Tmdb : null;

        /// <summary>TVDB id (series only), if known.</summary>
        public int? Tvdb => Has("tvdb") ? _ids.Tvdb : null;

        /// <summary>IMDb id of the title (never an episode's), if known.</summary>
        public string? Imdb => Has("imdb") ? _ids.Imdb : null;

        /// <summary>A stable text of the ids (a cache key).</summary>
        /// <returns>The text.</returns>
        public string Text() => _ids.Text();

        private bool Has(string provider) => _ids.Keys.Any(k => k.Provider == provider);

        /// <summary>
        /// The one step that completes identities, one per import call (resolve) or source read (preview): the ids at
        /// hand, as they are when every copy of that kind in the library carries at least one of their providers (or no
        /// library reader is set up), else completed through the title lookup (TMDB details' external ids; an IMDb/TVDB id
        /// first to its TMDB title). One completion per identity per call, also when entries complete concurrently.
        /// </summary>
        internal sealed class Completion
        {
            private readonly IImportPhysicalTitles? _physical;
            private readonly IImportLookup? _lookup;
            private readonly ImportCallContext _context;
            private readonly ConcurrentDictionary<string, Lazy<Task<CompletedIdentity?>>> _completed = new(StringComparer.Ordinal);
            private readonly ConcurrentDictionary<string, bool> _beyond = new(StringComparer.Ordinal);
            private readonly SemaphoreSlim? _lookups;

            /// <summary>Creates the step.</summary>
            /// <param name="physical">The library reader (null: nothing is held anywhere, so the ids at hand are complete).</param>
            /// <param name="lookup">The title lookup (null: an identity that needs completing can't be completed).</param>
            /// <param name="context">The call's lookup context.</param>
            /// <param name="maxLookups">Completions looking titles up at once (0: no bound of its own; every lookup still
            /// takes its turn at the shared metadata limiter).</param>
            public Completion(IImportPhysicalTitles? physical, IImportLookup? lookup, ImportCallContext context, int maxLookups = 0)
            {
                _physical = physical;
                _lookup = lookup;
                _context = context;
                _lookups = maxLookups > 0 ? new SemaphoreSlim(maxLookups, maxLookups) : null;
            }

            /// <summary>The completed identity; null when it needed completing and the lookup failed (the caller retries or leaves the entry out).</summary>
            /// <param name="identity">The ids the candidate or entry carries.</param>
            /// <param name="cancellationToken">Cancellation (the call's).</param>
            /// <returns>The completed identity, or null.</returns>
            public Task<CompletedIdentity?> CompleteAsync(ImportIdentity identity, CancellationToken cancellationToken)
            {
                if (identity.Keys.Count == 0 || identity.Full || _physical == null)
                {
                    return Task.FromResult<CompletedIdentity?>(new CompletedIdentity(identity));
                }

                return _completed.GetOrAdd(identity.Text(), _ => new Lazy<Task<CompletedIdentity?>>(() => RunAsync(identity, cancellationToken))).Value;
            }

            private async Task<CompletedIdentity?> RunAsync(ImportIdentity identity, CancellationToken cancellationToken)
            {
                var providers = (identity.Movie ? "m:" : "t:") + string.Join(',', identity.Providers.OrderBy(p => p, StringComparer.Ordinal));
                if (!_beyond.GetOrAdd(providers, _ => _physical!.HoldsCopiesBeyond(identity)))
                {
                    return new CompletedIdentity(identity); // every copy of this kind carries one of the ids at hand
                }

                if (_lookups != null)
                {
                    await _lookups.WaitAsync(cancellationToken).ConfigureAwait(false);
                }

                try
                {
                    var completed = await LookupAsync(identity, cancellationToken).ConfigureAwait(false);
                    return completed == null ? null : new CompletedIdentity(completed);
                }
                finally
                {
                    _lookups?.Release();
                }
            }

            private async Task<ImportIdentity?> LookupAsync(ImportIdentity identity, CancellationToken cancellationToken)
            {
                if (_lookup == null)
                {
                    return null;
                }

                var type = identity.Movie ? "movie" : "tv";
                var tmdb = identity.Tmdb is > 0 ? identity.Tmdb : null;
                if (tmdb == null)
                {
                    var imdb = identity.Keys.FirstOrDefault(k => k.Provider == "imdb")?.Id;
                    var query = imdb != null ? "imdb:" + imdb : "tvdb:" + identity.Tvdb!.Value.ToString(CultureInfo.InvariantCulture);
                    var hits = await _lookup.SearchAsync(query, _context, cancellationToken).ConfigureAwait(false);
                    if (hits.Status == LookupStatus.Transient)
                    {
                        return null;
                    }

                    tmdb = hits.Value?.FirstOrDefault(h => h.MediaType == type)?.TmdbId;
                    if (tmdb is not > 0)
                    {
                        // The lookup doesn't know the title: these are all its ids, but only a Valid answer proves that (a
                        // row it couldn't read may be the title; review round 7).
                        return hits.Verdict == ResponseVerdict.Valid ? identity : null;
                    }
                }

                // Only Valid details complete an identity (review round 7, 4c2-R7-1): an id they don't carry is then proven
                // absent; details without their external ids (Partial) prove nothing about them, so the identity stays
                // incomplete and the caller retries or leaves the entry out.
                var details = await _lookup.GetDetailsAsync(type, tmdb.Value, _context, cancellationToken).ConfigureAwait(false);
                return details.Status switch
                {
                    LookupStatus.Transient => null,
                    LookupStatus.Ok when details.Verdict != ResponseVerdict.Valid || details.Value?.Verdict != ResponseVerdict.Valid => null,
                    _ => identity.With(tmdb, details.Value?.TvdbId, details.Value?.ImdbId),
                };
            }
        }
    }
}
