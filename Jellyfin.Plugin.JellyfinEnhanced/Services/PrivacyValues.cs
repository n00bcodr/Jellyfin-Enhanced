using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Activity;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.LiveTv;
using MediaBrowser.Model.Search;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>
/// What the host vouches for, asked by a protected item's projection: its own closed lists (languages, parental ratings,
/// countries, the labels a media stream's display title uses) and the library's own entities (genres, studios, people,
/// artists, an item's own and its parent's titles). Answers are memoized for one projection.
/// </summary>
public sealed class PrivacyValueHost
{
    private readonly Dictionary<string, CultureDto?> _languages = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, bool> _ratings = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<Guid, BaseItem?> _items = new();
    private HashSet<string>? _countries;

    /// <summary>Creates the host view for one projection.</summary>
    /// <param name="library">The library (entities); null vouches for none.</param>
    /// <param name="localization">The host's localization (closed lists and labels); null vouches for none.</param>
    public PrivacyValueHost(ILibraryManager? library, ILocalizationManager? localization)
    {
        Library = library;
        Localization = localization;
    }

    /// <summary>The library.</summary>
    public ILibraryManager? Library { get; }

    /// <summary>The host's localization.</summary>
    public ILocalizationManager? Localization { get; }

    private CultureDto? Culture(string value)
    {
        if (_languages.TryGetValue(value, out var known)) return known;
        CultureDto? found = null;
        try { found = Localization?.FindLanguageInfo(value); }
        catch (Exception) { found = null; }
        return _languages[value] = found;
    }

    /// <summary>
    /// A language the host's own language list knows (a code, a culture name or its display name), or a BCP-47 tag whose
    /// language the host knows with a region subtag ("en-US", "es-419", as Matroska stores them).
    /// </summary>
    public bool Language(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 64) return false;
        if (Culture(value) != null) return true;
        var dash = value.IndexOf('-', StringComparison.Ordinal);
        if (dash <= 0) return false;
        var region = value[(dash + 1)..];
        return (region.Length == 2 && region.All(char.IsAsciiLetter) || region.Length == 3 && region.All(char.IsAsciiDigit)) && Culture(value[..dash]) != null;
    }

    /// <summary>The host's display name of a known language (its first name, as Jellyfin 12 builds LocalizedLanguage).</summary>
    public string? LanguageName(string? value)
        => Language(value) && (Culture(value!) ?? Culture(value![..value!.IndexOf('-', StringComparison.Ordinal)])) is { } culture ? culture.DisplayName.Split(';', ',')[0].Trim() : null;

    /// <summary>The host's own localized label for one of its phrases.</summary>
    public string? Label(string phrase)
    {
        try { return Localization?.GetLocalizedString(phrase); }
        catch (Exception) { return null; }
    }

    /// <summary>A parental rating the host's rating tables know.</summary>
    public bool Rating(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 32) return false;
        if (_ratings.TryGetValue(value, out var known)) return known;
        bool ok;
        try { ok = Localization?.GetRatingScore(value) != null; }
        catch (Exception) { ok = false; }
        return _ratings[value] = ok;
    }

    /// <summary>A two-letter country code the host's country list knows.</summary>
    public bool Country(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return false;
        if (_countries == null)
        {
            try { _countries = (Localization?.GetCountries() ?? []).Select(c => c.TwoLetterISORegionName).Where(c => !string.IsNullOrEmpty(c)).ToHashSet(StringComparer.OrdinalIgnoreCase); }
            catch (Exception) { _countries = new HashSet<string>(); }
        }
        return _countries.Contains(value);
    }

    /// <summary>The library's item (memoized; null when the library cannot resolve it).</summary>
    public BaseItem? Item(Guid? id)
    {
        if (id is not { } key || key == Guid.Empty || Library == null) return null;
        if (_items.TryGetValue(key, out var known)) return known;
        BaseItem? item;
        try { item = Library.GetItemById(key); }
        catch (Exception) { item = null; }
        return _items[key] = item;
    }

    /// <summary>Whether the library holds an entity of this kind with this id and exactly this name.</summary>
    public bool Named<T>(Guid id, string? name) where T : BaseItem => name != null && Item(id) is T entity && string.Equals(entity.Name, name, StringComparison.Ordinal);

    /// <summary>A genre (or music genre) entity's name.</summary>
    public bool Genre(string? name)
    {
        if (string.IsNullOrWhiteSpace(name) || Library == null) return false;
        try { return Named<Genre>(Library.GetGenreId(name), name) || Named<MusicGenre>(Library.GetMusicGenreId(name), name); }
        catch (Exception) { return false; }
    }

    /// <summary>A studio entity's name.</summary>
    public bool Studio(string? name)
    {
        if (string.IsNullOrWhiteSpace(name) || Library == null) return false;
        try { return Named<Studio>(Library.GetStudioId(name), name); }
        catch (Exception) { return false; }
    }
}

/// <summary>
/// What Spoiler Guard deliberately leaves on a guarded item: the parts an administrator's or the viewer's switch turned
/// off, and the chapters a movie's viewer has already watched. Everything else is protected.
/// </summary>
public sealed record PrivacyReveal
{
    /// <summary>Nothing revealed (a hidden item's stub; every Spoiler Guard strip on).</summary>
    public static readonly PrivacyReveal None = new();

    /// <summary>The title strip is off: an episode's or season's own name fields.</summary>
    public bool Title { get; init; }

    /// <summary>Neither the title nor the overview strip is on: paths, stream and source titles, roles, links.</summary>
    public bool TitleFamily { get; init; }

    /// <summary>The overview strip is off.</summary>
    public bool Overview { get; init; }

    /// <summary>The tag strip is off.</summary>
    public bool Tags { get; init; }

    /// <summary>The tagline strip is off.</summary>
    public bool Taglines { get; init; }

    /// <summary>The chapter-name strip is off.</summary>
    public bool ChapterNames { get; init; }

    /// <summary>Chapters starting before this tick (a movie the viewer is part-way through) keep their names and images.</summary>
    public long? WatchedThrough { get; init; }

    /// <summary>The overview placeholder (the administrator's, sanitized).</summary>
    public string Placeholder { get; init; } = "Spoiler Guard activated";
}

/// <summary>
/// Values, not fields: a protected item's projection, built by one walk. Every retained string is either constructed by
/// JE (a neutral name, a rebuilt label, a library entity's own name) or passes its member's validator over a closed
/// format (ids, image tags, the host's language/rating/country lists, ffprobe's codec/profile/layout tokens, enum
/// names); anything else is dropped. Dictionaries are judged per key (known providers with id-shaped values; transport
/// headers never leave). The walk builds a new instance of the CLASSIFIED type (the nearest base type the classification
/// names), copying only the members the table names, each through its rule: a runtime subclass's extra property and a
/// member the table does not name are never copied (one unknown default, on the hidden and the guarded path alike); a
/// nested value (an element of a derived array included) is rebuilt by the type it is assignable to, or dropped.
/// </summary>
public static class PrivacyValues
{
    /// <summary>How the walk treats an item.</summary>
    internal enum Mode
    {
        /// <summary>A hidden item a session's controls hang on: its host-required members only, a neutral name.</summary>
        Stub,

        /// <summary>A guarded item: every member, through its rule, with Spoiler Guard's reveals.</summary>
        Guarded,

        /// <summary>A row naming a protected item (a timer, an activity entry, a search hint): every member through its rule.</summary>
        Row,
    }

    /// <summary>The walk's context: the host's vouching, the reveals, the item being projected and constructed texts.</summary>
    internal sealed class Scope
    {
        public required PrivacyValueHost Host { get; init; }

        public required Mode Mode { get; init; }

        public PrivacyReveal Reveal { get; init; } = PrivacyReveal.None;

        /// <summary>The protected item (kind, numbers, ids) the walk is projecting.</summary>
        public BaseItemDto? Item { get; init; }

        /// <summary>An absent title the native details facade built from provider data (no library entity).</summary>
        public bool Synthetic { get; init; }

        /// <summary>A constructed name (a row's or a hint's).</summary>
        public string? Name { get; init; }

        /// <summary>A constructed series name (a hint's).</summary>
        public string? Series { get; init; }
    }

    /// <summary>One member's rule: what the projection keeps of its value (null drops it).</summary>
    internal sealed record Rule(string Name, Func<object?, Scope, Context, object?> Apply);

    /// <summary>The member being projected: its source object, declared type and position among its siblings.</summary>
    internal readonly record struct Context(object Source, Type Declared, int Index);

    // ---------------------------------------------------------------------------------------------------------------
    // Entry points.

    /// <summary>
    /// What a hidden item a session's controls hang on leaves: its host-required members (classification) through their
    /// value rules (media streams rebuilt from validated values, so the host rebuilds DisplayTitle from them) and the
    /// neutral name.
    /// </summary>
    public static BaseItemDto Stub(BaseItemDto dto, PrivacyValueHost host)
        => (BaseItemDto)Rebuild(dto, typeof(BaseItemDto), new Scope { Host = host, Mode = Mode.Stub, Item = dto }, 0)!;

    /// <summary>A guarded item as Spoiler Guard delivers it: a new item of the classified type, every value through its rule.</summary>
    public static BaseItemDto Guarded(BaseItemDto dto, PrivacyReveal reveal, PrivacyValueHost host)
        => (BaseItemDto)Rebuild(dto, typeof(BaseItemDto), new Scope { Host = host, Mode = Mode.Guarded, Reveal = reveal, Item = dto, Synthetic = SyntheticId.HasNamespace(dto.Id) }, 0)!;

    /// <summary>A guarded item's media source (an opened item's playback info).</summary>
    public static MediaSourceInfo Source(MediaSourceInfo source, BaseItemKind kind, PrivacyReveal reveal, PrivacyValueHost host, int index)
        => (MediaSourceInfo)Rebuild(source, typeof(MediaSourceInfo), new Scope { Host = host, Mode = Mode.Guarded, Reveal = reveal, Item = new BaseItemDto { Type = kind } }, index)!;

    /// <summary>A guarded item's image list entry (its route's image infos).</summary>
    public static ImageInfo Image(ImageInfo image, PrivacyReveal reveal, PrivacyValueHost host)
        => (ImageInfo)Rebuild(image, typeof(ImageInfo), new Scope { Host = host, Mode = Mode.Guarded, Reveal = reveal }, 0)!;

    /// <summary>A search hint of a guarded item: the constructed name and series, every other value through its rule.</summary>
    public static SearchHint Hint(SearchHint hint, string? name, string? series, PrivacyReveal reveal, PrivacyValueHost host)
        => (SearchHint)Rebuild(hint, typeof(SearchHint), new Scope { Host = host, Mode = Mode.Row, Reveal = reveal, Name = name, Series = series }, 0)!;

    /// <summary>
    /// A row naming a protected item (a hidden programme's timer or series timer, a protected item's activity entry): a new
    /// row of its classified type, every value through its rule, the name constructed (<paramref name="name"/>).
    /// </summary>
    public static T Row<T>(T row, string? name, PrivacyValueHost host) where T : class
    {
        var known = Known(row.GetType()) ?? throw new InvalidOperationException(row.GetType().Name + " is not a classified row");
        return (T)Rebuild(row, known, new Scope { Host = host, Mode = Mode.Row, Name = name }, 0)!;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The walk.

    private static readonly ConcurrentDictionary<(Type, Mode), (PropertyInfo Property, Rule Rule)[]> _plans = new();

    /// <summary>The classified type a runtime type is (itself or its nearest classified base type), or null.</summary>
    internal static Type? Known(Type type)
    {
        for (var t = type; t != null && t != typeof(object); t = t.BaseType)
            if (_rules.ContainsKey(t)) return t;
        return null;
    }

    private static object? Rebuild(object value, Type known, Scope scope, int index)
    {
        var copy = known.GetConstructor(Type.EmptyTypes) != null ? Activator.CreateInstance(known)! : RuntimeHelpers.GetUninitializedObject(known);
        foreach (var (property, rule) in Plan(known, scope.Mode))
            property.SetValue(copy, rule.Apply(property.GetValue(value), scope, new Context(value, property.PropertyType, index)));
        return Admit(copy) ? copy : null;
    }

    /// <summary>The members a type's projection copies, each with its rule; cached per type and mode.</summary>
    private static (PropertyInfo Property, Rule Rule)[] Plan(Type known, Mode mode) => _plans.GetOrAdd((known, mode), key =>
    {
        var table = _rules[key.Item1];
        return key.Item1.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.GetIndexParameters().Length == 0 && p.GetMethod is { IsPublic: true } && p.SetMethod is { IsPublic: true })
            // A stub keeps the host-required members of the item itself only (the classification); nested values keep theirs.
            .Where(p => !(key.Item2 == Mode.Stub && key.Item1 == typeof(BaseItemDto) && PrivacyFieldClassification.Of(typeof(BaseItemDto), p.Name) != PrivacyField.HostRequired && p.Name != "Name"))
            .Select(p => (p, table.TryGetValue(p.Name, out var rule) ? rule : Default(p.PropertyType)))
            .ToArray();
    });

    /// <summary>A member the table does not name: a closed value type (number, flag, date, enum) is kept, anything else withheld.</summary>
    private static Rule Default(Type type)
    {
        var element = type.IsArray ? type.GetElementType()! : type;
        element = Nullable.GetUnderlyingType(element) ?? element;
        return element.IsPrimitive || element.IsEnum || element == typeof(DateTime) || element == typeof(DateTimeOffset) || element == typeof(Guid) || element == typeof(decimal) || element == typeof(TimeSpan)
            ? Keep : Drop;
    }

    /// <summary>Whether a rebuilt element stays (a person or name pair whose name the library cannot vouch for leaves).</summary>
    private static bool Admit(object rebuilt) => rebuilt switch
    {
        BaseItemPerson person => person.Name != null,
        _ => true,
    };

    // ---------------------------------------------------------------------------------------------------------------
    // Rule builders.

    private static readonly Rule Keep = new("kept (closed value type)", (v, _, _) => v);

    private static readonly Rule Drop = new("dropped", (_, _, _) => null);

    private static Rule Str(string name, Func<string, Scope, Context, bool> ok) => new(name, (v, s, c) => v is string t && ok(t, s, c) ? t : null);

    private static Rule Str(string name, Func<string?, bool> ok) => Str(name, (t, _, _) => ok(t));

    /// <summary>A sequence of strings, each through the validator (the sequence's own type kept: an array or a list).</summary>
    private static Rule Strs(string name, Func<string, Scope, Context, bool> ok) => new(name, (v, s, c) => v is IEnumerable<string> values ? Typed(c.Declared, values.Where(t => t != null && ok(t, s, c)).ToArray()) : null);

    private static Rule Strs(string name, Func<string?, bool> ok) => Strs(name, (t, _, _) => ok(t));

    private static Rule Revealed(Func<PrivacyReveal, bool> revealed, Rule otherwise, string what)
        => new(what + " when revealed, else " + otherwise.Name, (v, s, c) => s.Mode != Mode.Stub && revealed(s.Reveal) ? v : otherwise.Apply(v, s, c));

    private static Rule Construct(string name, Func<object?, Scope, Context, object?> make) => new(name, make);

    /// <summary>A nested value (or every element of a sequence) rebuilt as the classified type it is assignable to; others dropped.</summary>
    private static Rule Nested(Type known) => new("rebuilt " + known.Name, (v, s, c) =>
    {
        if (v == null) return null;
        if (v is IEnumerable sequence and not string && !known.IsInstanceOfType(v))
        {
            var kept = new List<object>();
            var i = 0;
            foreach (var element in sequence)
            {
                if (element != null && known.IsInstanceOfType(element) && Rebuild(element, known, s, i) is { } rebuilt) kept.Add(rebuilt);
                i++;
            }
            var array = Array.CreateInstance(known, kept.Count);
            for (var j = 0; j < kept.Count; j++) array.SetValue(kept[j], j);
            return Typed(c.Declared, array);
        }
        return known.IsInstanceOfType(v) ? Rebuild(v, known, s, c.Index) : null;
    });

    /// <summary>An array as the member's declared sequence type (the array itself, or a list).</summary>
    private static object Typed(Type declared, Array array)
    {
        if (declared.IsAssignableFrom(array.GetType())) return array;
        var list = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(array.GetType().GetElementType()!))!;
        foreach (var e in array) list.Add(e);
        return list;
    }

    /// <summary>Name/id pairs the library vouches for: the entity with that id has exactly that name.</summary>
    private static Rule Pairs(string name, Func<PrivacyValueHost, Guid, string?, bool> ok) => new(name, (v, s, c) =>
        v is IEnumerable<NameGuidPair> pairs
            ? Typed(c.Declared, pairs.Where(p => p != null && (s.Synthetic || ok(s.Host, p.Id, p.Name))).Select(p => new NameGuidPair { Name = p.Name, Id = p.Id }).ToArray())
            : null);

    /// <summary>An image-tag dictionary: keys are the enum, values image tags.</summary>
    private static readonly Rule ImageTags = new("image tag per image type", (v, _, _) =>
        v is IDictionary<ImageType, string> tags ? tags.Where(t => PrivacyTokens.Tag(t.Value)).ToDictionary(t => t.Key, t => t.Value) : null);

    /// <summary>A BlurHash dictionary: image type → image tag → BlurHash.</summary>
    private static readonly Rule BlurHashes = new("BlurHash per image tag", (v, _, _) =>
        v is IDictionary<ImageType, Dictionary<string, string>> hashes
            ? hashes.ToDictionary(h => h.Key, h => (h.Value ?? new()).Where(t => PrivacyTokens.Tag(t.Key) && PrivacyTokens.BlurHash(t.Value)).ToDictionary(t => t.Key, t => t.Value))
            : null);

    /// <summary>Provider ids: known providers only, each with its id format; JE's own guard marker. Unknown keys leave.</summary>
    private static readonly Dictionary<string, Func<string, bool>> _providers = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Tmdb"] = Digits, ["TmdbCollection"] = Digits, ["Tvdb"] = Digits, ["TvdbCollection"] = Digits, ["TvRage"] = Digits, ["TvMaze"] = Digits, ["Trakt"] = Digits,
        ["AniDB"] = Digits, ["AniList"] = Digits, ["Kitsu"] = Digits, ["MyAnimeList"] = Digits, ["AudioDbAlbum"] = Digits, ["AudioDbArtist"] = Digits,
        ["Imdb"] = v => v.Length is >= 6 and <= 14 && (v.StartsWith("tt", StringComparison.Ordinal) || v.StartsWith("nm", StringComparison.Ordinal)) && Digits(v[2..]),
        ["Zap2It"] = v => v.Length is >= 4 and <= 16 && char.IsAsciiLetterUpper(v[0]) && char.IsAsciiLetterUpper(v[1]) && Digits(v[2..]),
        ["MusicBrainzAlbum"] = IsGuid, ["MusicBrainzAlbumArtist"] = IsGuid, ["MusicBrainzArtist"] = IsGuid, ["MusicBrainzReleaseGroup"] = IsGuid,
        ["MusicBrainzTrack"] = IsGuid, ["MusicBrainzRecording"] = IsGuid,
        ["JeSpoilerGuarded"] = v => v is "true" or "false",
    };

    /// <summary>Hex digits joined by underscores or dashes (the host's live-stream and media-source ids).</summary>
    private static bool HexList(string? value) => value is { Length: > 0 and <= 200 } && value.All(ch => Uri.IsHexDigit(ch) || ch is '_' or '-');

    private static bool Digits(string value) => value.Length is > 0 and <= 20 && value.All(char.IsAsciiDigit);

    private static bool IsGuid(string value) => Guid.TryParse(value, out _);

    private static readonly Rule Providers = new("known providers with id-shaped values; unknown keys dropped", (v, _, _) =>
        v is IDictionary<string, string> ids
            ? ids.Where(p => p.Key != null && p.Value != null && _providers.TryGetValue(p.Key, out var ok) && ok(p.Value))
                .ToDictionary(p => p.Key, p => p.Value, StringComparer.OrdinalIgnoreCase)
            : null);

    /// <summary>Trickplay: keyed by the media source id; the tile info is numbers.</summary>
    private static readonly Rule Trickplay = new("trickplay per media source id", (v, _, _) =>
        v is IDictionary<string, Dictionary<int, TrickplayInfoDto>> tiles
            ? tiles.Where(t => PrivacyTokens.Id(t.Key) && t.Value != null)
                .ToDictionary(t => t.Key, t => t.Value.Where(i => i.Value?.GetType() == typeof(TrickplayInfoDto)).ToDictionary(i => i.Key, i => i.Value))
            : null);

    /// <summary>
    /// A text the library vouches for: the named entity's own field (the item's own title for a kind Spoiler Guard does not
    /// rename, its series' name); for an absent title the facade's own construction; otherwise nothing.
    /// </summary>
    private static string? Entity(Scope s, Guid? id, Func<BaseItem, string?> field, object? facade)
    {
        if (s.Host.Item(id) is not { } entity) return s.Synthetic ? facade as string : null;
        // A computed entity field (a sort name built from the server's settings) that cannot be computed is left out.
        try { return field(entity); }
        catch (Exception) { return null; }
    }

    private static bool Protects(BaseItemKind kind) => kind is BaseItemKind.Episode or BaseItemKind.Season;

    private static readonly string[] _statuses = ["Continuing", "Ended", "Unreleased", "New", "InProgress", "Completed", "Cancelled", "ConflictedOk", "ConflictedNotOk", "Error"];

    private static readonly string[] _displayOrders =
        ["aired", "originalAir", "absolute", "dvd", "digital", "storyArc", "production", "tv", "alternate", "regional", "altdvd", "Default", "PremiereDate", "SortName", "DateCreated"];

    private static readonly string[] _activityTypes =
    [
        "VideoPlayback", "VideoPlaybackStopped", "AudioPlayback", "AudioPlaybackStopped", "SessionStarted", "SessionEnded", "AuthenticationSucceeded", "AuthenticationFailed",
        "UserCreated", "UserDeleted", "UserPasswordChanged", "UserLockedOut", "UserPolicyUpdated", "UserConfigurationUpdated", "PluginInstalled", "PluginUninstalled",
        "PluginUpdateInstalled", "InstallationFailed", "TaskFailed", "SubtitleDownloadFailure", "LyricDownloadFailure",
    ];

    // ---------------------------------------------------------------------------------------------------------------
    // The table: every string-typed (or object-typed) member of every classified type, one rule each. Value-typed members
    // the table does not name are kept (closed by their type); any other unnamed member is withheld.

    private static readonly Rule Tag = Str("image tag", PrivacyTokens.Tag);
    private static readonly Rule Tags = Strs("image tags", PrivacyTokens.Tag);
    private static readonly Rule IdText = Str("id", PrivacyTokens.Id);
    private static readonly Rule TitleFamily = Revealed(r => r.TitleFamily, Drop, "kept");

    private static Rule LabelOf(string phrase) => Construct("the host's \"" + phrase + "\" label", (v, s, _) => v == null ? null : s.Host.Label(phrase));

    private static readonly Dictionary<Type, Dictionary<string, Rule>> _rules = new()
    {
        [typeof(BaseItemDto)] = new(StringComparer.Ordinal)
        {
            ["Name"] = Construct("neutral name (stub); episode/season neutral name unless revealed; else the library entity's name", (v, s, c) =>
            {
                var item = (BaseItemDto)c.Source;
                if (s.Mode == Mode.Stub) return PrivacyFieldClassification.HiddenName;
                if (Protects(item.Type)) return s.Reveal.Title ? v : item.Type == BaseItemKind.Episode ? NeutralNames.Episode(item.ParentIndexNumber, item.IndexNumber) : NeutralNames.Season(item.IndexNumber);
                return Entity(s, item.Id, e => e.Name, v) ?? item.Type.ToString();
            }),
            ["SortName"] = Construct("episode/season: dropped unless revealed; else the library entity's sort name", (v, s, c) =>
                Protects(((BaseItemDto)c.Source).Type) ? (s.Reveal.Title ? v : null) : Entity(s, ((BaseItemDto)c.Source).Id, e => e.SortName, v)),
            ["OriginalTitle"] = Construct("episode/season: dropped unless revealed; else the library entity's original title", (v, s, c) =>
                Protects(((BaseItemDto)c.Source).Type) ? (s.Reveal.Title ? v : null) : Entity(s, ((BaseItemDto)c.Source).Id, e => e.OriginalTitle, v)),
            ["ForcedSortName"] = TitleFamily,
            ["EpisodeTitle"] = TitleFamily,
            ["Path"] = TitleFamily,
            ["CustomRating"] = TitleFamily,
            ["ExternalUrls"] = TitleFamily,
            ["RemoteTrailers"] = TitleFamily,
            ["Overview"] = Construct("kept when revealed, else the placeholder (when there was one)", (v, s, _) => s.Reveal.Overview ? v : string.IsNullOrEmpty(v as string) ? null : s.Reveal.Placeholder),
            ["Taglines"] = Construct("kept when revealed, else empty", (v, s, _) => s.Reveal.Taglines ? v : v == null ? null : Array.Empty<string>()),
            ["Tags"] = Construct("kept when revealed, else empty", (v, s, _) => s.Reveal.Tags ? v : v == null ? null : Array.Empty<string>()),
            ["SeriesName"] = Construct("the series entity's name", (v, s, c) => Entity(s, ((BaseItemDto)c.Source).SeriesId, e => e.Name, v)),
            ["SeasonName"] = Construct("kept when revealed, else the neutral season name", (v, s, c) => v == null ? null : s.Reveal.Title ? v : NeutralNames.Season(((BaseItemDto)c.Source).ParentIndexNumber)),
            ["Album"] = Construct("the album entity's name", (v, s, c) => Entity(s, ((BaseItemDto)c.Source).AlbumId, e => e is MusicAlbum ? e.Name : null, v)),
            ["AlbumArtist"] = Str("a vouched album artist's name", (t, s, c) => s.Synthetic || ((BaseItemDto)c.Source).AlbumArtists?.Any(p => p.Name == t && s.Host.Named<MusicArtist>(p.Id, p.Name)) == true),
            ["AlbumArtists"] = Pairs("music artist entities", (h, id, n) => h.Named<MusicArtist>(id, n)),
            ["Artists"] = Strs("a vouched artist's name", (t, s, c) => s.Synthetic || ((BaseItemDto)c.Source).ArtistItems?.Any(p => p.Name == t && s.Host.Named<MusicArtist>(p.Id, p.Name)) == true),
            ["ArtistItems"] = Pairs("music artist entities", (h, id, n) => h.Named<MusicArtist>(id, n)),
            ["SeriesStudio"] = Str("a studio entity's name", (t, s, _) => s.Synthetic || s.Host.Studio(t)),
            ["Genres"] = Strs("genre entities' names", (t, s, _) => s.Synthetic || s.Host.Genre(t)),
            ["GenreItems"] = Pairs("genre entities", (h, id, n) => h.Named<Genre>(id, n) || h.Named<MusicGenre>(id, n)),
            ["Studios"] = Pairs("studio entities", (h, id, n) => h.Named<Studio>(id, n)),
            ["People"] = Nested(typeof(BaseItemPerson)),
            ["Chapters"] = Nested(typeof(ChapterInfo)),
            ["MediaSources"] = Nested(typeof(MediaSourceInfo)),
            ["MediaStreams"] = Nested(typeof(MediaStream)),
            ["UserData"] = Nested(typeof(UserItemDataDto)),
            ["CurrentProgram"] = Drop,
            ["ChannelName"] = Construct("the channel entity's name", (v, s, c) => Entity(s, ((BaseItemDto)c.Source).ChannelId, e => e.Name, v)),
            ["CameraMake"] = Drop,
            ["CameraModel"] = Drop,
            ["Software"] = Drop,
            ["ProductionLocations"] = Drop,
            ["ServerId"] = IdText,
            ["Etag"] = Tag,
            ["DisplayPreferencesId"] = IdText,
            ["ProgramId"] = IdText,
            ["SeriesTimerId"] = IdText,
            ["TimerId"] = IdText,
            ["PlaylistItemId"] = Str("a client-assigned queue id", PrivacyTokens.IdShaped),
            ["AirTime"] = Str("clock time", PrivacyTokens.Time),
            ["AspectRatio"] = Str("ratio", PrivacyTokens.Ratio),
            ["ChannelNumber"] = Str("number", PrivacyTokens.Number),
            ["Number"] = Str("number", PrivacyTokens.Number),
            ["Container"] = Str("container tokens (host ffprobe)", PrivacyTokens.Container),
            ["DisplayOrder"] = Str("display order name", t => PrivacyTokens.OneOf(t, _displayOrders)),
            ["SourceType"] = Str("source type name", t => PrivacyTokens.OneOf(t, "Library", "LiveTV", "Channel")),
            ["Status"] = Str("status name", t => PrivacyTokens.OneOf(t, _statuses)),
            ["OfficialRating"] = Str("a rating the host's tables know", (t, s, _) => s.Host.Rating(t)),
            ["OriginalLanguage"] = Str("a language the host knows", (t, s, _) => s.Host.Language(t)),
            ["PreferredMetadataLanguage"] = Str("a language the host knows", (t, s, _) => s.Host.Language(t)),
            ["PreferredMetadataCountryCode"] = Str("a country the host knows", (t, s, _) => s.Host.Country(t)),
            ["ProviderIds"] = Providers,
            ["ImageTags"] = ImageTags,
            ["ImageBlurHashes"] = BlurHashes,
            ["Trickplay"] = Trickplay,
            ["BackdropImageTags"] = Tags,
            ["ParentBackdropImageTags"] = Tags,
            ["ScreenshotImageTags"] = Tags,
            ["AlbumPrimaryImageTag"] = Tag,
            ["ChannelPrimaryImageTag"] = Tag,
            ["ParentArtImageTag"] = Tag,
            ["ParentLogoImageTag"] = Tag,
            ["ParentPrimaryImageTag"] = Tag,
            ["ParentThumbImageTag"] = Tag,
            ["SeriesPrimaryImageTag"] = Tag,
            ["SeriesThumbImageTag"] = Tag,
        },
        [typeof(MediaStream)] = new(StringComparer.Ordinal)
        {
            ["Title"] = TitleFamily,
            ["Comment"] = TitleFamily,
            ["Path"] = TitleFamily,
            ["Language"] = Str("a language the host knows", (t, s, _) => s.Host.Language(t)),
            ["LocalizedLanguage"] = Construct("the host's name of the validated language", (v, s, c) => v == null ? null : s.Host.LanguageName(((MediaStream)c.Source).Language)),
            ["LocalizedDefault"] = LabelOf("Default"),
            ["LocalizedExternal"] = LabelOf("External"),
            ["LocalizedForced"] = LabelOf("Forced"),
            ["LocalizedHearingImpaired"] = LabelOf("HearingImpaired"),
            ["LocalizedOriginal"] = LabelOf("Original"),
            ["LocalizedUndefined"] = LabelOf("Undefined"),
            ["Codec"] = Str("codec token (host ffprobe)", PrivacyTokens.Codec),
            ["CodecTag"] = Str("four-character code", PrivacyTokens.FourCc),
            ["Profile"] = Str("codec profile name", PrivacyTokens.Profile),
            ["ChannelLayout"] = Str("channel layout token (host ffprobe)", PrivacyTokens.Layout),
            ["PixelFormat"] = Str("pixel format token (host ffprobe)", PrivacyTokens.PixelFormat),
            ["ColorPrimaries"] = Str("colour token", PrivacyTokens.Color),
            ["ColorRange"] = Str("colour token", PrivacyTokens.Color),
            ["ColorSpace"] = Str("colour token", PrivacyTokens.Color),
            ["ColorTransfer"] = Str("colour token", PrivacyTokens.Color),
            ["AspectRatio"] = Str("ratio", PrivacyTokens.Ratio),
            ["TimeBase"] = Str("rational", PrivacyTokens.Rational),
            ["CodecTimeBase"] = Str("rational", PrivacyTokens.Rational),
            ["NalLengthSize"] = Str("number", PrivacyTokens.Number),
            ["DeliveryUrl"] = Construct("the host's indexed delivery URL (a raw external URL only when revealed)", (v, s, c) =>
                s.Mode != Mode.Stub && s.Reveal.TitleFamily ? v : ((MediaStream)c.Source).IsExternalUrl == true || !PrivacyTokens.DeliveryUrl(v as string) ? null : v),
        },
        [typeof(MediaSourceInfo)] = new(StringComparer.Ordinal)
        {
            ["Name"] = Construct("kept when revealed, else a label from the version's validated video stream (\"1080p HEVC SDR\") or \"Version N\"", (v, s, c) =>
                s.Mode != Mode.Stub && s.Reveal.TitleFamily ? v : VersionLabel((MediaSourceInfo)c.Source, s, c.Index)),
            ["Path"] = TitleFamily,
            ["EncoderPath"] = Drop,
            ["OpenToken"] = Drop,
            ["RequiredHttpHeaders"] = Drop,
            ["Id"] = Str("id", t => PrivacyTokens.Id(t) || PrivacyTokens.IdShaped(t) || HexList(t)),
            ["LiveStreamId"] = Str("id", HexList),
            ["ETag"] = Tag,
            ["Container"] = Str("container tokens (host ffprobe)", PrivacyTokens.Container),
            ["TranscodingContainer"] = Str("container tokens (host ffprobe)", PrivacyTokens.Container),
            ["Formats"] = Strs("container tokens (host ffprobe)", PrivacyTokens.Container),
            ["TranscodingUrl"] = Str("the host's transcoding route with token parameters", PrivacyTokens.TranscodingUrl),
            ["MediaStreams"] = Nested(typeof(MediaStream)),
            ["MediaAttachments"] = Nested(typeof(MediaAttachment)),
        },
        [typeof(MediaAttachment)] = new(StringComparer.Ordinal)
        {
            ["Comment"] = TitleFamily,
            ["FileName"] = TitleFamily,
            ["Codec"] = Str("codec token (host ffprobe)", PrivacyTokens.Codec),
            ["CodecTag"] = Str("four-character code", PrivacyTokens.FourCc),
            ["MimeType"] = Str("attachment MIME type", PrivacyTokens.MimeType),
            ["DeliveryUrl"] = Str("the host's indexed delivery URL", PrivacyTokens.DeliveryUrl),
        },
        [typeof(ChapterInfo)] = new(StringComparer.Ordinal)
        {
            ["Name"] = Construct("kept when revealed or already watched, else \"Chapter N\"", (v, s, c) =>
                v == null ? null : s.Reveal.ChapterNames || Watched((ChapterInfo)c.Source, s) ? v : string.Create(CultureInfo.InvariantCulture, $"Chapter {c.Index + 1}")),
            ["ImagePath"] = Construct("kept when revealed or already watched, else dropped", (v, s, c) => s.Reveal.TitleFamily || Watched((ChapterInfo)c.Source, s) ? v : null),
            ["ImageTag"] = Tag,
        },
        [typeof(BaseItemPerson)] = new(StringComparer.Ordinal)
        {
            ["Name"] = Str("a person entity's name (the person leaves without it)", (t, s, c) => s.Synthetic || s.Host.Named<Person>(((BaseItemPerson)c.Source).Id, t)),
            ["Role"] = TitleFamily,
            ["PrimaryImageTag"] = Tag,
            ["ImageBlurHashes"] = BlurHashes,
        },
        [typeof(UserItemDataDto)] = new(StringComparer.Ordinal)
        {
            ["Key"] = Str("user-data key (ids and provider digits)", PrivacyTokens.UserDataKey),
            ["ItemId"] = IdText,
        },
        [typeof(ImageInfo)] = new(StringComparer.Ordinal)
        {
            ["Path"] = TitleFamily,
            ["ImageTag"] = Tag,
            ["BlurHash"] = Str("BlurHash", PrivacyTokens.BlurHash),
        },
        [typeof(SearchHint)] = new(StringComparer.Ordinal)
        {
            ["Name"] = Construct("the constructed name", (_, s, _) => s.Name),
            ["MatchedTerm"] = TitleFamily,
            ["Series"] = Construct("the series entity's name", (_, s, _) => s.Series),
            ["Album"] = Drop,
            ["AlbumArtist"] = Drop,
            ["Artists"] = Drop,
            ["ChannelName"] = Construct("the channel entity's name", (_, s, c) => Entity(s, ((SearchHint)c.Source).ChannelId, e => e.Name, null)),
            ["Status"] = Str("status name", t => PrivacyTokens.OneOf(t, _statuses)),
            ["BackdropImageItemId"] = IdText,
            ["ThumbImageItemId"] = IdText,
            ["BackdropImageTag"] = Tag,
            ["PrimaryImageTag"] = Tag,
            ["ThumbImageTag"] = Tag,
        },
        [typeof(BaseTimerInfoDto)] = Timer(),
        [typeof(TimerInfoDto)] = Timer(),
        [typeof(SeriesTimerInfoDto)] = Timer(),
        [typeof(ActivityLogEntry)] = new(StringComparer.Ordinal)
        {
            ["Name"] = Construct("the constructed text", (_, s, _) => s.Name),
            ["Overview"] = Drop,
            ["ShortOverview"] = Drop,
            ["Type"] = Str("activity type name", t => PrivacyTokens.OneOf(t, _activityTypes)),
            ["ItemId"] = IdText,
            ["UserPrimaryImageTag"] = Tag,
        },
    };

    private static Dictionary<string, Rule> Timer() => new(StringComparer.Ordinal)
    {
        ["Name"] = Drop,
        ["Overview"] = Drop,
        ["ProgramInfo"] = Drop,
        ["ChannelName"] = Construct("the channel entity's name", (_, s, c) => Entity(s, ((BaseTimerInfoDto)c.Source).ChannelId, e => e.Name, null)),
        ["ServiceName"] = Drop,
        ["Id"] = IdText,
        ["ServerId"] = IdText,
        ["Type"] = Str("timer type name", t => PrivacyTokens.OneOf(t, "Timer", "SeriesTimer")),
        ["ProgramId"] = IdText,
        ["SeriesTimerId"] = IdText,
        ["ExternalId"] = Str("provider id", PrivacyTokens.IdShaped),
        ["ExternalChannelId"] = Str("provider id", PrivacyTokens.IdShaped),
        ["ExternalProgramId"] = Str("provider id", PrivacyTokens.IdShaped),
        ["ExternalSeriesTimerId"] = Str("provider id", PrivacyTokens.IdShaped),
        ["ParentBackdropItemId"] = IdText,
        ["ParentThumbItemId"] = IdText,
        ["ParentPrimaryImageItemId"] = IdText,
        ["ParentBackdropImageTags"] = Tags,
        ["ChannelPrimaryImageTag"] = Tag,
        ["ParentPrimaryImageTag"] = Tag,
        ["ParentThumbImageTag"] = Tag,
        ["ImageTags"] = ImageTags,
    };

    /// <summary>Whether a chapter starts before the point the viewer has watched through (a movie's progressive strip).</summary>
    private static bool Watched(ChapterInfo chapter, Scope s) => s.Reveal.WatchedThrough is { } through && chapter.StartPositionTicks < through;

    /// <summary>A movie version's label, built from its own validated video stream ("1080p HEVC SDR"), or "Version N".</summary>
    private static string VersionLabel(MediaSourceInfo source, Scope s, int index)
    {
        var video = source.MediaStreams?.FirstOrDefault(m => m is { Type: MediaStreamType.Video });
        var label = video != null && Rebuild(video, typeof(MediaStream), s, 0) is MediaStream rebuilt ? rebuilt.DisplayTitle : null;
        return string.IsNullOrWhiteSpace(label) ? string.Create(CultureInfo.InvariantCulture, $"Version {index + 1}") : label;
    }

    /// <summary>The classified types and the rule each of their members has (for coverage tests and the report).</summary>
    public static IReadOnlyDictionary<string, string> RulesOf(Type type)
        => _rules.TryGetValue(type, out var table) ? table.ToDictionary(r => r.Key, r => r.Value.Name) : new Dictionary<string, string>();

    /// <summary>The types the walk classifies.</summary>
    public static IEnumerable<Type> Types => _rules.Keys;
}
