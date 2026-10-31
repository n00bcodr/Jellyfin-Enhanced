using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>Builds container summaries from streams already loaded by the episode walk; never queries the library.</summary>
internal static class SeriesQualityAggregation
{
    // Streams are immutable cache facts shared by Series and Season. A weak memo
    // avoids repeating detection in both containers and in restricted-user reads.
    private sealed record AudioValue(string? Label);
    private sealed class Detected
    {
        public Detected(TagStreamData streams)
        {
            Labels = QualityTagRules.DetectNonAudio(streams);
            SingleAudioLanguage = streams.Streams?.Where(stream => stream?.Type == "Audio").Select(stream => stream.Language).Distinct(StringComparer.OrdinalIgnoreCase).Take(2).Count() <= 1;
            var videos = streams.Streams?.Where(stream => stream?.Type == "Video").ToList();
            if (videos is not { Count: > 1 }) return;
            // Media versions are already flattened in StreamData. Each category
            // can select a different version without opening any media again.
            var candidates = videos.SelectMany(video => QualityTagRules.DetectNonAudio(new TagStreamData { Streams = new() { video } })).ToList();
            foreach (var key in new[] { QualityTagRules.Resolution, QualityTagRules.DynamicRange, QualityTagRules.VideoCodec })
            {
                Labels.RemoveAll(label => QualityTagRules.CategoryOf(label) == key);
                var best = candidates.Where(label => QualityTagRules.CategoryOf(label) == key).OrderBy(label => QualityTagRules.AggregationRank(label, key)).FirstOrDefault();
                if (best != null) Labels.Add(best);
            }
        }
        public bool SingleAudioLanguage { get; }
        public List<string> Labels { get; }
        public ConcurrentDictionary<string, AudioValue> Audio { get; } = new(StringComparer.Ordinal);
    }
    private static readonly ConditionalWeakTable<TagStreamData, Detected> Detection = new();
    private static List<string> Labels(TagStreamData? streams) => streams == null ? new() : Detection.GetValue(streams, data => new(data)).Labels;
    private static string? Audio(TagStreamData? streams, string? language)
    {
        if (streams == null) return null;
        var detected = Detection.GetValue(streams, data => new(data));
        // With one audio language every preference selects those same tracks,
        // whether by exact match or fallback. Most episode files take this path.
        var key = detected.SingleAudioLanguage ? "" : language ?? "";
        return detected.Audio.GetOrAdd(key, code => new(QualityTagRules.DetectAggregationAudio(streams, code))).Label;
    }

    internal sealed record Episode(string Id, long? Aired, TagStreamData? Streams, string? Source = null, string? Edition = null);
    private static readonly string[] Categories = { QualityTagRules.Resolution, QualityTagRules.DynamicRange, QualityTagRules.VideoCodec, QualityTagRules.AudioInfo };

    /// <summary>Normalize fixed policy values at settings and rendering boundaries.</summary>
    public static string Normalize(string? policy) => policy is "latest" or "best" or "shared" or "mixed" ? policy : "representative";

    /// <summary>Summarize all non-virtual members, including specials and unknown/unprobed values.</summary>
    public static TagQualitySummary Build(IReadOnlyList<Episode> episodes, long? now = null)
    {
        var boundary = now ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Stable ties use scan order; a future premiere or missing air date is never "latest".
        var latest = -1;
        for (var i = 0; i < episodes.Count; i++)
        {
            if (episodes[i].Aired is { } aired && aired <= boundary
                && (latest < 0 || aired > episodes[latest].Aired)) latest = i;
        }
        var labels = episodes.Select(e => Labels(e.Streams)).ToArray();
        var categories = Categories.ToDictionary(key => key, key => Summarize(key == QualityTagRules.AudioInfo ? episodes.Select(e => Audio(e.Streams, null)).ToArray()
            : labels.Select(list => list.FirstOrDefault(label => QualityTagRules.CategoryOf(label) == key)).ToArray(), key, latest, episodes.Select(e => QualityTagRules.DistinctValues(e.Streams, key, null)).ToArray()));
        var languages = new HashSet<string>(StringComparer.Ordinal);
        foreach (var episode in episodes)
        {
            foreach (var stream in episode.Streams?.Streams ?? new List<TagMediaStream>())
            {
                if (stream?.Type != "Audio" || !LanguageFlagRules.Parse(stream.Language, out var parsed) || parsed.Base == null) continue;
                var code = LanguageFlagRules.CanonicalBase(parsed.Base)!;
                languages.Add(parsed.Region == null ? code : code + "-" + (parsed.Region == "uk" ? "gb" : parsed.Region));
                languages.Add(code);
            }
        }
        var audio = new Dictionary<string, TagQualityCategory>(StringComparer.Ordinal);
        foreach (var language in languages.OrderBy(l => l, StringComparer.Ordinal))
        {
            var values = episodes.Select(e => Audio(e.Streams, language)).ToArray();
            audio[language] = Summarize(values, QualityTagRules.AudioInfo, latest, episodes.Select(e => QualityTagRules.DistinctValues(e.Streams, QualityTagRules.AudioInfo, language)).ToArray());
        }
        var regionFallback = new Dictionary<string, TagQualityCategory>(StringComparer.Ordinal);
        foreach (var language in languages.Where(code => !code.Contains('-') && languages.Any(variant => variant.StartsWith(code + "-", StringComparison.Ordinal))).OrderBy(code => code, StringComparer.Ordinal))
            regionFallback[language] = Summarize(episodes.Select(e => Audio(e.Streams, language + "-ZZ")).ToArray(), QualityTagRules.AudioInfo, latest, episodes.Select(e => QualityTagRules.DistinctValues(e.Streams, QualityTagRules.AudioInfo, language + "-ZZ")).ToArray());
        return new TagQualitySummary
        {
            NextPremiere = episodes.Select(e => e.Aired).Where(date => date > boundary).Min(),
            EpisodeCount = episodes.Count, Categories = categories, AudioByLanguage = audio, AudioRegionFallback = regionFallback,
            LatestExtras = latest < 0 ? Array.Empty<string>() : QualityTagRules.Detect(episodes[latest].Streams, null, episodes[latest].Source, episodes[latest].Edition).Where(label => !Categories.Contains(QualityTagRules.CategoryOf(label))).ToArray(),
        };
    }

    private static TagQualityCategory Summarize(string?[] values, string category, int latest, List<string>[] sets) => new()
    {
        All = sets.SelectMany(set => set).Distinct(StringComparer.Ordinal).OrderBy(label => QualityTagRules.AggregationRank(label, category)).ThenBy(label => label, StringComparer.Ordinal).ToArray(),
        Shared = sets.Length == 0 ? Array.Empty<string>() : sets[0].Where(label => sets.All(set => set.Contains(label, StringComparer.Ordinal))).ToArray(),
        LatestAll = latest < 0 ? Array.Empty<string>() : sets[latest].ToArray(),
        AllSetsAgree = sets.Length > 0 && sets.All(set => set.SequenceEqual(sets[0])),
        Best = values.Where(value => value != null).OrderBy(value => QualityTagRules.AggregationRank(value!, category)).FirstOrDefault(),
        Latest = latest < 0 ? null : values[latest],
        Values = values.Distinct(StringComparer.Ordinal).Take(4).ToArray(),
        AllAgree = values.Length > 0 && values.All(value => value == values[0]),
    };

    /// <summary>Resolve the same category facts the web reads, with exact-region then base-language audio matching.</summary>
    public static IEnumerable<KeyValuePair<string, TagQualityCategory>> EffectiveCategories(TagQualitySummary summary, string? preferred)
    {
        var audio = summary.AudioByLanguage.FirstOrDefault(pair => LanguageFlagRules.MatchesLanguage(pair.Key, preferred, true)).Value;
        if (audio == null && LanguageFlagRules.Parse(preferred, out var wanted) && wanted.Region != null)
            audio = summary.AudioRegionFallback.FirstOrDefault(pair => LanguageFlagRules.MatchesLanguage(pair.Key, preferred, false)).Value;
        audio ??= summary.AudioByLanguage.FirstOrDefault(pair => LanguageFlagRules.MatchesLanguage(pair.Key, preferred, false)
            && LanguageFlagRules.Parse(pair.Key, out var tag) && tag.Region == null).Value;
        return summary.Categories.Select(pair => pair.Key == QualityTagRules.AudioInfo && audio != null ? new KeyValuePair<string, TagQualityCategory>(pair.Key, audio) : pair);
    }

    /// <summary>Apply a policy while retaining representative source/format tags, except latest uses its own.</summary>
    public static List<string> Resolve(TagCacheEntry entry, string policy, string? preferred, Func<string, bool>? shown = null, Func<string, bool>? all = null)
    {
        var representative = QualityTagRules.ApplyDisplayModes(entry.StreamData, QualityTagRules.Detect(entry.StreamData, preferred, entry.Source, entry.Edition), preferred, all);
        if (entry.Type is not ("Series" or "Season") || entry.QualitySummary == null || Normalize(policy) == "representative") return representative;
        var summary = entry.QualitySummary;
        var result = policy == "latest" ? summary.LatestExtras.ToList() : representative.Where(label => !Categories.Contains(QualityTagRules.CategoryOf(label))).ToList();
        var mixed = false;
        foreach (var pair in EffectiveCategories(summary, preferred))
        {
            var category = pair.Value;
            if (all?.Invoke(pair.Key) == true)
            {
                result.AddRange(policy == "latest" ? category.LatestAll : policy == "shared" ? category.Shared : category.All);
                mixed |= !category.AllSetsAgree && (shown?.Invoke(pair.Key) ?? true);
                continue;
            }
            var value = policy == "latest" ? category.Latest : policy == "shared" && !category.AllAgree ? null : category.Best;
            if (value != null) result.Add(value);
            mixed |= !category.AllAgree && (shown?.Invoke(pair.Key) ?? true);
        }
        if (policy == "mixed" && summary.EpisodeCount > 1 && mixed) result.Add("Mixed");
        return result;
    }
}
