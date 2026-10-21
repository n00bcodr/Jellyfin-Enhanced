using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources
{
    /// <summary>One list entry built from one or more source entries (a movie, or a run of episodes of one season).</summary>
    public sealed class SourceGroup
    {
        /// <summary>Creates a group.</summary>
        /// <param name="kind">movie | series | season | episodes.</param>
        /// <param name="items">Its source entries, in source order (all with keys).</param>
        public SourceGroup(string kind, IReadOnlyList<SourceItem> items)
        {
            Kind = kind;
            Items = items;
            Keys = items.Select(i => i.Key!).ToList();
        }

        /// <summary>movie | series | season | episodes.</summary>
        public string Kind { get; }

        /// <summary>Source entries, in source order.</summary>
        public IReadOnlyList<SourceItem> Items { get; }

        /// <summary>The source key of every entry (per episode), in order.</summary>
        public IReadOnlyList<string> Keys { get; }

        /// <summary>The group's representative key (its first entry's; stored as the placeholder's sourceKey).</summary>
        public string Key => Keys[0];

        /// <summary>The first entry.</summary>
        public SourceItem First => Items[0];
    }

    /// <summary>Facts about a whole fetched list that grouping and entry building need.</summary>
    public sealed class SourceListFacts
    {
        /// <summary>Earliest dated entry per show in the list (stands in for the show's first air date).</summary>
        public Dictionary<int, string> FirstDate { get; } = new();

        /// <summary>
        /// TMDB's episode count per (show, season), where known (filled from Seerr by the caller). Only a run that this
        /// count confirms is a whole season: the list alone can't tell a whole season from its first episodes.
        /// </summary>
        public Dictionary<(int Show, int Season), int> SeasonEpisodes { get; } = new();
    }

    /// <summary>
    /// Groups the entries of exact sources (chronolists) into list entries and builds their prepared resolutions, so an
    /// 800-episode watch order becomes a few hundred placeholders without a title lookup (Seerr is only asked for the
    /// season episode counts of the shows, see <see cref="SourceListFacts.SeasonEpisodes"/>):
    /// <list type="bullet">
    /// <item>Movies: one entry each.</item>
    /// <item>Episodes: a run of consecutive entries of the same show and season with consecutive episode numbers is one
    /// entry. A run that is the whole season (E1 to the last episode by TMDB's episode count,
    /// <see cref="SourceListFacts.SeasonEpisodes"/>; never specials) is a <c>season</c> placeholder, otherwise (also when
    /// the count is unknown) an <c>episodes</c> placeholder, split at <see cref="ListRules.MaxEpisodes"/>.</item>
    /// </list>
    /// Provenance stays per episode: every episode keeps its own source key (<c>tv|show|season|episode</c>) and the
    /// group's keys all own the one placeholder, so a sync can tell which episode was added, removed or swapped in
    /// even though one placeholder stands for many.
    /// </summary>
    public static class ListSourceGroups
    {
        /// <summary>Collects the list-wide facts.</summary>
        /// <param name="items">Every keyed entry of the list.</param>
        /// <returns>Facts.</returns>
        public static SourceListFacts Facts(IEnumerable<SourceItem> items)
        {
            var facts = new SourceListFacts();
            foreach (var item in items)
            {
                if (item.MediaType != "tv" || item.TmdbId is not > 0)
                {
                    continue;
                }

                var show = item.TmdbId.Value;
                var date = item.Details?.Date;
                if (date != null && (!facts.FirstDate.TryGetValue(show, out var first) || string.CompareOrdinal(date, first) < 0))
                {
                    facts.FirstDate[show] = date;
                }
            }

            return facts;
        }

        /// <summary>Groups entries (see the class remarks).</summary>
        /// <param name="items">Keyed entries in source order, each with its position in the WHOLE source list (entries are
        /// only grouped when they are adjacent there, so a sync that adds a few new entries groups them like an import).</param>
        /// <param name="facts">Facts of the whole list.</param>
        /// <returns>Groups in source order.</returns>
        public static List<SourceGroup> Group(IReadOnlyList<(SourceItem Item, int Position)> items, SourceListFacts facts)
        {
            var groups = new List<SourceGroup>();
            var run = new List<SourceItem>();
            var lastPosition = -2;

            void Flush()
            {
                if (run.Count > 0)
                {
                    groups.AddRange(SplitRun(run, facts));
                    run = new List<SourceItem>();
                }
            }

            foreach (var (item, position) in items)
            {
                if (item.Key == null)
                {
                    continue;
                }

                if (item.MediaType == "tv" && item.TmdbId is > 0 && item.Season.HasValue && item.Episode.HasValue)
                {
                    var previous = run.Count > 0 ? run[^1] : null;
                    if (previous == null || previous.TmdbId != item.TmdbId || previous.Season != item.Season
                        || previous.Episode + 1 != item.Episode || lastPosition + 1 != position)
                    {
                        Flush();
                    }

                    run.Add(item);
                    lastPosition = position;
                    continue;
                }

                Flush();
                var kind = item.MediaType == "movie" ? PlaceholderKinds.Movie : item.Season.HasValue ? PlaceholderKinds.Season : PlaceholderKinds.Series;
                groups.Add(new SourceGroup(kind, new[] { item }));
                lastPosition = position;
            }

            Flush();
            return groups;
        }

        private static IEnumerable<SourceGroup> SplitRun(List<SourceItem> run, SourceListFacts facts)
        {
            var first = run[0];
            var season = first.Season!.Value;
            // A season placeholder stands for every episode of the season (swap-in fills it with any of them), so the run
            // must be all of it by TMDB's count; the highest episode the list happens to have isn't enough.
            var whole = season > 0 && first.Episode == 1
                && facts.SeasonEpisodes.TryGetValue((first.TmdbId!.Value, season), out var total) && run[^1].Episode == total && run.Count == total;
            if (whole)
            {
                yield return new SourceGroup(PlaceholderKinds.Season, run);
                yield break;
            }

            for (var start = 0; start < run.Count; start += ListRules.MaxEpisodes)
            {
                yield return new SourceGroup(PlaceholderKinds.Episodes, run.Skip(start).Take(ListRules.MaxEpisodes).ToList());
            }
        }

        /// <summary>
        /// The TMDB candidate a group stands for (the same shape /resolve answers with), named by the group's completed
        /// identity (its ids, and the identity the placeholder, "in library" and Spoiler Guard take).
        /// </summary>
        /// <param name="group">Group.</param>
        /// <param name="facts">Facts of the whole list.</param>
        /// <param name="identity">The completed identity of the group's title.</param>
        /// <returns>The candidate.</returns>
        public static ImportCandidateDto Candidate(SourceGroup group, SourceListFacts facts, CompletedIdentity identity)
        {
            var first = group.First;
            var details = first.Details;
            if (first.MediaType == "movie")
            {
                return new ImportCandidateDto
                {
                    MediaType = "movie",
                    TmdbId = first.TmdbId!.Value,
                    Title = first.Title ?? string.Empty,
                    Year = first.Year,
                    ReleaseDate = details?.Date,
                    PosterPath = details?.PosterPath,
                    Overview = details?.Overview,
                    ImdbId = identity.Imdb,
                    Score = 1000,
                    Identity = identity,
                };
            }

            var show = first.TmdbId!.Value;
            var firstDate = facts.FirstDate.GetValueOrDefault(show);
            var candidate = new ImportCandidateDto
            {
                MediaType = "tv",
                TmdbId = show,
                Title = first.Title ?? string.Empty,
                Year = firstDate != null && int.TryParse(firstDate.AsSpan(0, 4), NumberStyles.None, CultureInfo.InvariantCulture, out var year) ? year : first.Year,
                ReleaseDate = firstDate,
                PosterPath = details?.PosterPath,
                TvdbId = identity.Tvdb,
                ImdbId = identity.Imdb,
                Score = 1000,
                Identity = identity,
            };

            if (group.Kind is PlaceholderKinds.Season or PlaceholderKinds.Episodes && first.Season.HasValue)
            {
                candidate.Season = new ImportSeasonDto
                {
                    SeasonNumber = first.Season.Value,
                    EpisodeCount = group.Kind == PlaceholderKinds.Season ? group.Items.Count : null,
                    AirDate = details?.Date,
                    Name = details?.SeasonName,
                };
            }

            if (group.Kind == PlaceholderKinds.Episodes)
            {
                candidate.Episodes = group.Items.Select(i => new ImportEpisodeInfoDto { S = i.Season!.Value, E = i.Episode!.Value, Title = i.Details?.EpisodeTitle, AirDate = i.Details?.Date }).ToList();
            }

            return candidate;
        }

        /// <summary>The placeholder body of a group (exactly what the import review builds from the prepared candidate).</summary>
        /// <param name="group">Group.</param>
        /// <param name="facts">Facts of the whole list.</param>
        /// <param name="identity">The completed identity of the group's title.</param>
        /// <returns>The body, or null.</returns>
        public static NewPlaceholderDto? Placeholder(SourceGroup group, SourceListFacts facts, CompletedIdentity identity) =>
            ImportPlaceholders.FromCandidate(
                Candidate(group, facts, identity),
                group.Kind,
                group.First.Season,
                group.Kind == PlaceholderKinds.Episodes ? group.Items.Select(i => i.Episode!.Value).ToList() : null,
                group.First.Note);

        /// <summary>What to look for in the library for a group.</summary>
        /// <param name="group">Group.</param>
        /// <param name="identity">The completed identity of the group's title.</param>
        /// <returns>The scope.</returns>
        public static LibraryScope Scope(SourceGroup group, CompletedIdentity identity)
        {
            var first = group.First;
            return new LibraryScope(
                group.Kind,
                identity,
                group.Kind is PlaceholderKinds.Season or PlaceholderKinds.Episodes ? first.Season : null,
                group.Kind == PlaceholderKinds.Episodes ? group.Items.Select(i => i.Episode!.Value).ToList() : null);
        }

        /// <summary>The fetched entry of a group: ids, every source key, and its prepared (high-confidence) resolution.</summary>
        /// <param name="group">Group.</param>
        /// <param name="index">Position in the response.</param>
        /// <param name="facts">Facts of the whole list.</param>
        /// <param name="identity">The completed identity of the group's title.</param>
        /// <param name="inLibrary">Library match visible to the caller (and the target playlist's owner), if any.</param>
        /// <returns>The entry.</returns>
        public static ImportEntryDto Entry(SourceGroup group, int index, SourceListFacts facts, CompletedIdentity identity, ImportLibraryDto? inLibrary)
        {
            var first = group.First;
            var candidate = Candidate(group, facts, identity);
            candidate.InLibrary = inLibrary;
            return new ImportEntryDto
            {
                Index = index,
                Title = first.Title,
                Year = first.Year,
                TypeHint = first.MediaType,
                Season = group.Kind is PlaceholderKinds.Season or PlaceholderKinds.Episodes ? first.Season : null,
                Episodes = group.Kind == PlaceholderKinds.Episodes ? group.Items.Select(i => new ImportEpisodeDto { S = i.Season!.Value, E = i.Episode!.Value }).ToList() : null,
                Ids = new ImportIdsDto { Tmdb = first.TmdbId, TmdbType = first.MediaType, Imdb = identity.Imdb, Tvdb = identity.Tvdb },
                Note = first.Note,
                SourceKey = group.Key,
                SourceKeys = group.Keys.ToList(),
                Prepared = new ResolvedEntryDto
                {
                    Index = index,
                    State = "ok",
                    Confidence = ImportScoring.Levels.High,
                    Kind = group.Kind,
                    Match = candidate,
                    // The match is the only candidate; it isn't repeated here (a run lists up to 100 episodes and a watch
                    // order has hundreds of entries). Clients treat the match as the first candidate.
                    Candidates = new List<ImportCandidateDto>(),
                },
            };
        }
    }
}
