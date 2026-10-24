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
/// What the host vouches for, asked by a protected item's projection. Every answer is the host's OWN value, never the
/// value asked about: the entry of one of its closed tables (a language's code, a parental rating as its rating table
/// spells it, a country's code, the labels a media stream's display title uses), the title-level item a protected item's
/// vocabulary is copied from (an episode's series, an extra's owner) with that item's own genres, studios and people, and
/// the request's own device id and access token (the values the host puts into its URLs). Answers are memoized for one
/// projection.
/// </summary>
public sealed class PrivacyValueHost
{
    private readonly Dictionary<string, CultureDto?> _languages = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, string?> _ratingEntries = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<Guid, BaseItem?> _items = new();
    private readonly Dictionary<(Guid, TextMember), CapturedText> _text = new();
    private readonly Dictionary<(Guid, VocabularyList, string), CapturedText> _vocabulary = new();
    private readonly Dictionary<Guid, ReferenceValues> _references = new();
    private readonly Dictionary<Guid, IReadOnlyList<PersonValue>> _people = new();
    private Dictionary<string, string>? _countries;

    /// <summary>Creates the host view for one projection.</summary>
    /// <param name="library">The library (entities); null vouches for none.</param>
    /// <param name="localization">The host's localization (closed lists and labels); null vouches for none.</param>
    /// <param name="caller">The request the projection answers (its device id and token), when there is one.</param>
    public PrivacyValueHost(ILibraryManager? library, ILocalizationManager? localization, System.Security.Claims.ClaimsPrincipal? caller = null)
    {
        Library = library;
        Localization = localization;
        Caller = new PrivacyTokens.Caller(caller?.FindFirst("Jellyfin-DeviceId")?.Value, caller?.FindFirst("Jellyfin-Token")?.Value);
    }

    /// <summary>The library.</summary>
    public ILibraryManager? Library { get; }

    /// <summary>The host's localization.</summary>
    public ILocalizationManager? Localization { get; }

    /// <summary>The request's own device id and access token.</summary>
    internal PrivacyTokens.Caller Caller { get; }

    private CultureDto? Culture(string value)
    {
        if (_languages.TryGetValue(value, out var known)) return known;
        CultureDto? found = null;
        try { found = Localization?.FindLanguageInfo(value); }
        catch (Exception) { found = null; }
        return _languages[value] = found;
    }

    /// <summary>The culture's own code (or name) that the value names, as the host's language list spells it.</summary>
    private static string? EntryOf(CultureDto culture, string value)
    {
        foreach (var code in culture.ThreeLetterISOLanguageNames ?? []) if (string.Equals(code, value, StringComparison.OrdinalIgnoreCase)) return code;
        if (string.Equals(culture.TwoLetterISOLanguageName, value, StringComparison.OrdinalIgnoreCase)) return culture.TwoLetterISOLanguageName;
        if (string.Equals(culture.Name, value, StringComparison.OrdinalIgnoreCase)) return culture.Name;
        if (string.Equals(culture.DisplayName, value, StringComparison.OrdinalIgnoreCase)) return culture.DisplayName;
        return null;
    }

    /// <summary>
    /// A language as the host's language list spells it: the entry (code, culture name or display name) the value names, or
    /// a BCP-47 tag rebuilt from the language's entry and a region from the host's country list ("en-US") or a UN M.49 number
    /// ("es-419", as Matroska stores them). Null when the host does not know it.
    /// </summary>
    public string? Language(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 64) return null;
        if (Culture(value) is { } culture && EntryOf(culture, value) is { } entry) return entry;
        var dash = value.IndexOf('-', StringComparison.Ordinal);
        if (dash <= 0 || Culture(value[..dash]) is not { } language || EntryOf(language, value[..dash]) is not { } code) return null;
        var region = value[(dash + 1)..];
        if (region.Length == 3 && region.All(char.IsAsciiDigit)) return code + "-" + int.Parse(region, CultureInfo.InvariantCulture).ToString("D3", CultureInfo.InvariantCulture);
        return Country(region) is { } country ? code + "-" + country : null;
    }

    /// <summary>The host's display name of a known language (its first name, as Jellyfin 12 builds LocalizedLanguage).</summary>
    public string? LanguageName(string? value)
    {
        if (Language(value) is not { } entry) return null;
        var culture = Culture(entry) ?? Culture(entry[..entry.IndexOf('-', StringComparison.Ordinal)]);
        return culture?.DisplayName.Split(';', ',')[0].Trim();
    }

    /// <summary>The host's own localized label for one of its phrases.</summary>
    public string? Label(string phrase)
    {
        try { return Localization?.GetLocalizedString(phrase); }
        catch (Exception) { return null; }
    }

    /// <summary>
    /// A parental rating as the host's rating tables spell it: the table entry the value names (every country's table, read
    /// from the host's own rating resources, and the server's list of ratings), a country-qualified entry rebuilt as
    /// "{country}-{entry}" with the country's table, a whole number (the host reads it as a score), or the first entry of a
    /// "/"-separated list. A value with any other text (the host's parser accepts "text:PG" or "text/PG") is null.
    /// </summary>
    public string? Rating(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 64) return null;
        if (_ratingEntries.TryGetValue(value, out var known)) return known;
        var tables = PrivacyRatingTables.Of(Localization);
        string? Single(string text)
        {
            text = text.Trim();
            if (text.Length is > 0 and <= 3 && text.All(char.IsAsciiDigit)) return int.Parse(text, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);
            if (tables.Any.TryGetValue(text, out var entry)) return entry;
            if (text.Length > 3 && text[2] is '-' or ':' && tables.ByCountry.TryGetValue(text[..2], out var country) && country.Table.TryGetValue(text[3..].Trim(), out var qualified))
                return country.Code + "-" + qualified;
            return null;
        }
        var answer = Single(value);
        if (answer == null && value.Contains('/', StringComparison.Ordinal))
        {
            var parts = value.Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            // Every part is a rating the tables name; the first is the one the host scores.
            var entries = parts.Select(Single).ToArray();
            answer = entries.Length > 0 && entries.All(e => e != null) ? entries[0] : null;
        }
        return _ratingEntries[value] = answer;
    }

    /// <summary>A two-letter country code as the host's country list spells it.</summary>
    public string? Country(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (_countries == null)
        {
            _countries = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                foreach (var c in Localization?.GetCountries() ?? [])
                    if (!string.IsNullOrEmpty(c.TwoLetterISORegionName)) _countries.TryAdd(c.TwoLetterISORegionName, c.TwoLetterISORegionName);
            }
            catch (Exception) { _countries.Clear(); }
        }
        return _countries.TryGetValue(value, out var entry) ? entry : null;
    }

    /// <summary>The library's item (memoized; null when the library cannot resolve it).</summary>
    public BaseItem? Item(Guid? id)
    {
        if (id is not { } key || key == Guid.Empty || Library == null) return null;
        // An entity the projection reads is one of the answer's inputs: read as the host serves it now, and its facts (or
        // its absence) recorded in the attempt's read-set; a memo hit within the strip replays them.
        if (_items.TryGetValue(key, out var known))
        {
            Consumed(key, known);
            return known;
        }
        BaseItem? item;
        try { item = PrivacyHostView.Item(Library, key); }
        catch (Exception) { item = null; }
        Consumed(key, item);
        return _items[key] = item;
    }

    /// <summary>Reads several items a projection will take values from in one batch (each then answers from the memo).</summary>
    public void Prefetch(IEnumerable<Guid> ids)
    {
        if (Library == null) return;
        var wanted = ids.Where(id => id != Guid.Empty && !_items.ContainsKey(id)).Distinct().ToArray();
        if (wanted.Length == 0) return;
        Dictionary<Guid, BaseItem> found;
        try { found = PrivacyHostView.Items(Library, wanted); }
        catch (Exception) { return; }
        foreach (var id in wanted) _items[id] = found.GetValueOrDefault(id);
    }

    /// <summary>
    /// A text projection the accessor may capture. Computed sort names are read only when consumed.
    /// </summary>
    public enum TextMember { Name, SortName, OriginalTitle, OfficialRating }
    /// <summary>The title-owned vocabulary lists used by scalar and name/id-pair projections.</summary>
    public enum VocabularyList { Genres, Studios }
    /// <summary>Canonical references and numbering consumed by a projection, separate from any carried DTO.</summary>
    public sealed record ReferenceValues(bool Present, BaseItemKind Kind, Guid Series, Guid Season, int? Parent, int? Index, Guid? Channel);

    /// <summary>Captures references once and replays their immutable proof at every reuse.</summary>
    public ReferenceValues References(Guid id)
    {
        static ReferenceValues Read(BaseItem? item)
        {
            if (item == null) return new(false, default, Guid.Empty, Guid.Empty, null, null, null);
            // Some host item kinds carry a channel reference, others have no such input.
            var value = item.GetType().GetProperty("ChannelId")?.GetValue(item);
            var channel = value is Guid guid ? guid : Guid.TryParse(value as string, out var parsed) ? parsed : (Guid?)null;
            return new(true, item.GetBaseItemKind(), item switch { MediaBrowser.Controller.Entities.TV.Episode ep => ep.SeriesId, MediaBrowser.Controller.Entities.TV.Season season => season.SeriesId, _ => Guid.Empty },
                item is MediaBrowser.Controller.Entities.TV.Episode episode ? episode.SeasonId : Guid.Empty,
                item.ParentIndexNumber, item.IndexNumber, channel);
        }
        var item = Item(id);
        if (!_references.TryGetValue(id, out var captured)) _references[id] = captured = Read(item);
        PrivacyReads.Query("projection-references:" + id.ToString("N"), Newtonsoft.Json.JsonConvert.SerializeObject(captured),
            check => Newtonsoft.Json.JsonConvert.SerializeObject(Read(check.Item(id))));
        return captured;
    }
    private sealed record CapturedText(bool Present, string? Value)
    {
        [Newtonsoft.Json.JsonIgnore]
        public string Proof => Newtonsoft.Json.JsonConvert.SerializeObject(this);
    }

    /// <summary>Captures one consumed field, and replays the same immutable evidence on memo hits.</summary>
    public string? Text(Guid? id, TextMember member)
    {
        if (id is not { } key || key == Guid.Empty) return null;
        static CapturedText Read(BaseItem? item, TextMember field) => new(item != null, item == null ? null : field switch
        {
            TextMember.Name => item.Name, TextMember.SortName => item.SortName,
            TextMember.OriginalTitle => item.OriginalTitle, TextMember.OfficialRating => item.OfficialRating,
            _ => throw new ArgumentOutOfRangeException(nameof(field))
        });
        var item = Item(key);
        if (!_text.TryGetValue((key, member), out var captured)) _text[(key, member)] = captured = Read(item, member);
        PrivacyReads.Query("text:" + key.ToString("N") + ":" + member, captured.Proof, check => Read(check.Item(key), member).Proof);
        return captured.Value;
    }

    /// <summary>The actual membership/spelling consumed, rather than a fingerprint of unrelated list entries.</summary>
    public string? Entry(Guid? id, VocabularyList list, string? candidate)
    {
        if (id is not { } key || key == Guid.Empty || candidate == null) return null;
        static CapturedText Read(BaseItem? item, VocabularyList list, string candidate)
            => new(item != null, EntryIn(item == null ? null : list == VocabularyList.Genres ? item.Genres : item.Studios, candidate));
        var item = Item(key);
        if (!_vocabulary.TryGetValue((key, list, candidate), out var captured))
            _vocabulary[(key, list, candidate)] = captured = Read(item, list, candidate);
        var digest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(candidate)));
        PrivacyReads.Query("vocabulary:" + key.ToString("N") + ":" + list + ":" + digest, captured.Proof,
            check => Read(check.Item(key), list, candidate).Proof);
        return captured.Value;
    }

    private void Consumed(Guid id, BaseItem? item)
    {
        var library = Library!;
        PrivacyReads.Judged(library, id, item);
    }

    /// <summary>Whether the library holds an entity of this kind with this id and exactly this name.</summary>
    public bool Named<T>(Guid id, string? name) where T : BaseItem => name != null && Item(id) is T && string.Equals(Text(id, TextMember.Name), name, StringComparison.Ordinal);

    /// <summary>
    /// The title-level item a protected item's vocabulary (genres, studios, people) is copied from: an episode's or season's
    /// series, an extra's owner by the one ownership rule (that owner's series when it is an episode or season), else the item itself (a movie or a
    /// series is its own title). Null when the library cannot resolve it.
    /// </summary>
    public BaseItem? Title(Guid id)
    {
        var item = Item(id);
        for (var hop = 0; hop < 2 && item != null; hop++)
        {
            // The one ownership rule (on 10.11 also the owner that lists the item in its extras).
            if (PrivacyIdentities.ExtraOwner(Library, item) is var owner && owner != Guid.Empty) { item = Item(owner); continue; }
            if (item is MediaBrowser.Controller.Entities.TV.Episode episode) { item = Item(episode.SeriesId); continue; }
            if (item is MediaBrowser.Controller.Entities.TV.Season season) { item = Item(season.SeriesId); continue; }
            break;
        }
        return item is MediaBrowser.Controller.Entities.TV.Episode or MediaBrowser.Controller.Entities.TV.Season ? null : item;
    }

    /// <summary>The captured owning title's id, without lending a mutable entity to projection rules.</summary>
    public Guid? TitleId(Guid id) => Title(id)?.Id;

    /// <summary>The captured ownership rule, as a scalar projection input.</summary>
    public bool IsExtra(Guid id) => Library != null && Item(id) is { } item && PrivacyIdentities.ExtraOwner(Library, item) != Guid.Empty;

    /// <summary>The current ownership classifier's constructed extra label.</summary>
    public string ExtraName(Guid id, BaseItemKind kind)
        => Item(id) is { } item ? PrivacyValues.ExtraLabel(item, kind) : "Extra";

    /// <summary>The title's own entry for a name in one of its lists (as the title spells it), or null.</summary>
    public static string? EntryIn(IEnumerable<string>? list, string? name)
        => name == null ? null : list?.FirstOrDefault(entry => string.Equals(entry, name, StringComparison.OrdinalIgnoreCase));

    /// <summary>The title's own people (the library's people of that item), memoized.</summary>
    public sealed record PersonValue(string? Name, string? Role, string? Type);

    public IReadOnlyList<PersonValue> People(BaseItem title)
    {
        static PersonValue Capture(PersonInfo person) => new(person.Name, person.Role, Convert.ToString(person.Type, CultureInfo.InvariantCulture));
        if (!_people.TryGetValue(title.Id, out var people))
        {
            try { people = Array.AsReadOnly((Library?.GetPeople(title) ?? []).Select(Capture).ToArray()); }
            catch (Exception) { people = []; }
            _people[title.Id] = people;
        }
        // The names a protected item may keep are the title's own: a fact of the answer (memo hits included).
        if (Library is { } library)
        {
            static string Names(IEnumerable<PersonValue> list) => Newtonsoft.Json.JsonConvert.SerializeObject(list);
            PrivacyReads.Query("people:" + title.Id.ToString("N"), Names(people), check =>
            {
                try { return check.Item(title.Id) is { } live ? Names((library.GetPeople(live) ?? []).Select(Capture)) : null; }
                catch (Exception) { return null; }
            });
        }
        return people;
    }

    /// <summary>A title-owned person's spelling, with the people query's complete proof replayed.</summary>
    public string? PersonName(Guid? title, string? candidate)
        => title is { } id && candidate != null && Item(id) is { } item
            ? People(item).FirstOrDefault(p => string.Equals(p.Name, candidate, StringComparison.OrdinalIgnoreCase))?.Name : null;
}

/// <summary>
/// The host's parental rating tables: every country's table, as its own rating resources hold them (the files
/// LocalizationManager loads: "countryCode", "ratings[].ratingStrings"), plus the server's list of ratings. Read once per
/// localization implementation.
/// </summary>
internal sealed class PrivacyRatingTables
{
    private static readonly ConditionalWeakTable<object, PrivacyRatingTables> _cache = new();

    /// <summary>Any table's entry, by its spelling (case-insensitive).</summary>
    public Dictionary<string, string> Any { get; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>A country's own table, by its two-letter code.</summary>
    public Dictionary<string, (string Code, Dictionary<string, string> Table)> ByCountry { get; } = new(StringComparer.OrdinalIgnoreCase);

    public static PrivacyRatingTables Of(ILocalizationManager? localization)
    {
        if (localization == null) return new PrivacyRatingTables();
        return _cache.GetValue(localization, l => Load((ILocalizationManager)l));
    }

    private static PrivacyRatingTables Load(ILocalizationManager localization)
    {
        var tables = new PrivacyRatingTables();
        try
        {
            var assembly = localization.GetType().Assembly;
            foreach (var name in assembly.GetManifestResourceNames().Where(n => n.Contains(".Localization.Ratings.", StringComparison.Ordinal) && n.EndsWith(".json", StringComparison.OrdinalIgnoreCase)))
            {
                using var stream = assembly.GetManifestResourceStream(name);
                if (stream == null) continue;
                using var json = System.Text.Json.JsonDocument.Parse(stream);
                var root = json.RootElement;
                var code = Property(root, "countryCode")?.GetString();
                if (Property(root, "ratings") is not { ValueKind: System.Text.Json.JsonValueKind.Array } ratings) continue;
                var table = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var rating in ratings.EnumerateArray())
                    if (Property(rating, "ratingStrings") is { ValueKind: System.Text.Json.JsonValueKind.Array } strings)
                        foreach (var entry in strings.EnumerateArray())
                            if (entry.GetString() is { Length: > 0 and <= 32 } text) { table.TryAdd(text, text); tables.Any.TryAdd(text, text); }
                if (code is { Length: 2 } && code.All(char.IsAsciiLetter)) tables.ByCountry[code] = (code.ToUpperInvariant(), table);
            }
        }
        catch (Exception)
        {
            // A host without readable rating resources still has its server list.
        }
        try
        {
            foreach (var rating in localization.GetParentalRatings() ?? [])
                if (rating?.Name is { Length: > 0 and <= 32 } text) tables.Any.TryAdd(text, text);
        }
        catch (Exception)
        {
        }
        return tables;
    }

    private static System.Text.Json.JsonElement? Property(System.Text.Json.JsonElement element, string name)
    {
        if (element.ValueKind != System.Text.Json.JsonValueKind.Object) return null;
        foreach (var p in element.EnumerateObject()) if (string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase)) return p.Value;
        return null;
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
public static partial class PrivacyValues
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

        /// <summary>The protected subject captured at payload ingestion.</summary>
        public Guid SubjectId { get; init; }

        /// <summary>An absent title the native details facade built from provider data (no library entity).</summary>
        public bool Synthetic { get; init; }

        /// <summary>A constructed name (a row's or a hint's).</summary>
        public string? Name { get; init; }

        /// <summary>A constructed series name (a hint's).</summary>
        public string? Series { get; init; }
    }

    /// <summary>One member's rule: what the projection keeps of its value (null drops it).</summary>
    internal sealed record Rule(string Name, Func<object?, Scope, Context, object?> Apply);

    internal sealed record ProjectionInputs
    {
        public Guid Id { get; init; }
        public BaseItemKind Type { get; init; }
        public Guid? SeriesId { get; init; }
        public Guid? ChannelId { get; init; }
        public int? ParentIndexNumber { get; init; }
        public int? IndexNumber { get; init; }
        public string? Language { get; init; }
        public bool IsExternalUrl { get; init; }
        public MediaBrowser.Model.MediaInfo.MediaProtocol Protocol { get; init; }
        public long ChapterStart { get; init; } = long.MaxValue;
        public string? VersionName { get; init; }
    }
    /// <summary>Pure rules receive captured scalar inputs, never the mutable source carrier.</summary>
    internal readonly record struct Context(ProjectionInputs Input, Type Declared, int Index);

    // The named raw-carrier ingestion adapter. Library references have live
    // evidence; media primitives are the frozen payload validated by the table.
    private static ProjectionInputs CaptureInputs(object source, Scope scope, int index)
    {
        if (source is BaseItemDto dto)
        {
            if (scope.Mode == Mode.Stub) return CaptureControlInputs(dto);
            if (SyntheticId.HasNamespace(dto.Id)) return new() {Id=dto.Id,Type=dto.Type,SeriesId=dto.SeriesId,ChannelId=dto.ChannelId,ParentIndexNumber=dto.ParentIndexNumber,IndexNumber=dto.IndexNumber};
            var refs=scope.Host.References(dto.Id);
            return new() {Id=dto.Id,Type=refs.Present?refs.Kind:dto.Type,SeriesId=refs.Series==Guid.Empty?null:refs.Series,
                ChannelId=refs.Channel,ParentIndexNumber=refs.Parent,IndexNumber=refs.Index};
        }
        return source switch
        {
            MediaStream stream => new() {Language=stream.Language,IsExternalUrl=stream.IsExternalUrl==true},
            MediaSourceInfo media => new() {Protocol=media.Protocol,VersionName=media.Name==null || scope.Mode!=Mode.Stub && scope.Reveal.TitleFamily ? null : CaptureVersionLabel(media,scope,index)},
            ChapterInfo chapter => new() {ChapterStart=chapter.StartPositionTicks},
            SearchHint hint => new() {ChannelId=scope.Host.References(hint.Id).Channel},
            BaseTimerInfoDto timer => new() {ChannelId=timer.ChannelId},
            _ => new()
        };
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Entry points.

    /// <summary>
    /// What a hidden item a session's controls hang on leaves: its host-required members (classification) through their
    /// value rules (media streams rebuilt from validated values, so the host rebuilds DisplayTitle from them) and the
    /// neutral name.
    /// </summary>
    public static BaseItemDto Stub(BaseItemDto dto, PrivacyValueHost host)
        => (BaseItemDto)RebuildCaptured(dto, typeof(BaseItemDto), new Scope { Host = host, Mode = Mode.Stub, SubjectId = dto.Id }, 0, CaptureControlInputs(dto))!;

    // A control-only stub authorizes no title or reveal. Its host-required
    // identifiers and numbers belong to the frozen native payload, so the safe
    // fallback can be built without asking the library after final validation.
    private static ProjectionInputs CaptureControlInputs(BaseItemDto dto)
        => new() { Id=dto.Id, Type=dto.Type, SeriesId=dto.SeriesId, ChannelId=dto.ChannelId,
            ParentIndexNumber=dto.ParentIndexNumber, IndexNumber=dto.IndexNumber };

    /// <summary>A guarded item as Spoiler Guard delivers it: a new item of the classified type, every value through its rule.</summary>
    public static BaseItemDto Guarded(BaseItemDto dto, PrivacyReveal reveal, PrivacyValueHost host)
    {
        var synthetic = SyntheticId.HasNamespace(dto.Id);
        var captured = synthetic ? dto : CaptureDto(dto, host);
        return (BaseItemDto)Rebuild(captured, typeof(BaseItemDto), new Scope { Host = host, Mode = Mode.Guarded, Reveal = reveal, SubjectId = captured.Id, Synthetic = synthetic }, 0)!;
    }

    private static readonly MethodInfo CloneObject = typeof(object).GetMethod("MemberwiseClone", BindingFlags.NonPublic | BindingFlags.Instance)!;

    // Named payload-ingestion adapter: owns a shallow snapshot; the pure walk
    // cannot borrow a different series/channel or numbering from a stale DTO.
    private static BaseItemDto CaptureDto(BaseItemDto dto, PrivacyValueHost host)
    {
        var captured = (BaseItemDto)CloneObject.Invoke(dto, null)!;
        var refs = host.References(dto.Id);
        if (refs.Present) captured.Type = refs.Kind;
        captured.SeriesId = refs.Series == Guid.Empty ? null : refs.Series;
        captured.SeasonId = refs.Season == Guid.Empty ? null : refs.Season;
        captured.ParentIndexNumber = refs.Parent;
        captured.IndexNumber = refs.Index;
        captured.ChannelId = refs.Channel;
        return captured;
    }

    /// <summary>A guarded item's media source (an opened item's playback info).</summary>
    public static MediaSourceInfo Source(MediaSourceInfo source, BaseItemKind kind, PrivacyReveal reveal, PrivacyValueHost host, int index)
        => (MediaSourceInfo)Rebuild(source, typeof(MediaSourceInfo), new Scope { Host = host, Mode = Mode.Guarded, Reveal = reveal }, index)!;

    /// <summary>A guarded item's image list entry (its route's image infos).</summary>
    public static ImageInfo Image(ImageInfo image, PrivacyReveal reveal, PrivacyValueHost host)
        => (ImageInfo)Rebuild(image, typeof(ImageInfo), new Scope { Host = host, Mode = Mode.Guarded, Reveal = reveal }, 0)!;

    /// <summary>A search hint of a guarded item: its name and series constructed (<see cref="NameOf"/>), every other value through its rule.</summary>
    public static SearchHint Hint(SearchHint hint, PrivacyIdentity identity, PrivacyReveal reveal, PrivacyValueHost host)
    {
        var captured = (SearchHint)CloneObject.Invoke(hint, null)!;
        var refs = host.References(identity.ItemId);
        captured.ParentIndexNumber = refs.Parent;
        captured.IndexNumber = refs.Index;
        captured.ChannelId = refs.Channel;
        var name = NameOf(identity.Kind, identity.ItemId, refs.Parent, refs.Index, hint.Name, reveal, host);
        return (SearchHint)Rebuild(captured, typeof(SearchHint), new Scope { Host = host, Mode = Mode.Row, Reveal = reveal, Name = name, Series = SeriesNameOf(identity, host) }, 0)!;
    }

    /// <summary>
    /// A protected item's activity entry: a new row whose text is constructed from structured data only (the account, what
    /// happened by the entry's type, the item as <see cref="NameOf"/> names it), never patched from the text the host
    /// stored when it recorded the entry; the stored text only where Spoiler Guard reveals the item's own name. An item
    /// the library can no longer resolve (<paramref name="identity"/> null) is named by nothing but its kind of event.
    /// </summary>
    /// <param name="entry">The host's entry.</param>
    /// <param name="identity">The entry's item, or null when the library cannot resolve it.</param>
    /// <param name="reveal">What Spoiler Guard reveals to this viewer; null when its policy cannot be read.</param>
    /// <param name="user">The entry's account name (by its user id), when known.</param>
    /// <param name="host">The host's vouching.</param>
    public static ActivityLogEntry Activity(ActivityLogEntry entry, PrivacyIdentity? identity, PrivacyReveal? reveal, string? user, PrivacyValueHost host)
    {
        var text = identity != null && reveal != null && (identity.IsExtra ? reveal.TitleFamily : reveal.Title) ? entry.Name : ActivityText(entry.Type, identity, user, host);
        return Row(entry, text, host);
    }

    private static string ActivityText(string? type, PrivacyIdentity? identity, string? user, PrivacyValueHost host)
    {
        static string Join(string? series, string numbers) => string.IsNullOrEmpty(series) ? numbers : series + " - " + numbers;
        var label = "an item";
        if (identity != null)
        {
            var item = host.References(identity.ItemId);
            label = identity.Kind switch
            {
                BaseItemKind.Episode => item.Present
                    ? Join(SeriesNameOf(identity, host), NameOf(BaseItemKind.Episode, identity.ItemId, item.Parent, item.Index, null, PrivacyReveal.None, host)!)
                    : "an episode",
                BaseItemKind.Season => item.Present
                    ? Join(SeriesNameOf(identity, host), NameOf(BaseItemKind.Season, identity.ItemId, null, item.Index, null, PrivacyReveal.None, host)!)
                    : "a season",
                _ => item.Present ? NameOf(identity.Kind, identity.ItemId, null, null, null, PrivacyReveal.None, host) ?? "an item" : "an item",
            };
        }
        var playing = type is "VideoPlayback" or "AudioPlayback";
        var finished = type is "VideoPlaybackStopped" or "AudioPlaybackStopped";
        if (user == null) return playing ? "Playing " + label : finished ? "Finished playing " + label : label;
        return playing ? user + " is playing " + label : finished ? user + " has finished playing " + label : user + ": " + label;
    }

    /// <summary>
    /// The one construction of a protected item's name, for every site that names one (its DTO, a search hint, an activity
    /// entry): an episode's or season's neutral name, an extra's kind ("Theme video"), a movie's or series' own title from
    /// the library (the guard's subject), and the original (<paramref name="original"/>, or an extra's own name) only where
    /// a switch reveals it.
    /// </summary>
    /// <param name="kind">The item's kind.</param>
    /// <param name="id">The item's id.</param>
    /// <param name="parentIndex">An episode's season number.</param>
    /// <param name="index">An episode's or season's own number.</param>
    /// <param name="original">The site's own name for the item (revealed only by the title switch).</param>
    /// <param name="reveal">What Spoiler Guard reveals.</param>
    /// <param name="host">The library's titles.</param>
    /// <param name="synthetic">An absent title: the facade's own construction is its name.</param>
    /// <param name="known">The library item, when the caller already holds it (else the library is asked by id).</param>
    internal static string? NameOf(BaseItemKind kind, Guid id, int? parentIndex, int? index, string? original, PrivacyReveal reveal, PrivacyValueHost host, bool synthetic = false, BaseItem? known = null)
    {
        if (Protects(kind))
        {
            if (!synthetic && host.Library is { } library)
            {
                var numbers = PrivacyReads.Numbers(library, id);
                (parentIndex, index) = (numbers.Parent, numbers.Index);
            }
            return reveal.Title ? original : kind == BaseItemKind.Episode ? NeutralNames.Episode(parentIndex, index) : NeutralNames.Season(index);
        }
        // A caller's retained entity cannot skip the vocabulary accessor's
        // live capture and complete proof (including memo hits).
        if (!synthetic && host.IsExtra(id))
            return reveal.TitleFamily ? host.Text(id, PrivacyValueHost.TextMember.Name) : host.ExtraName(id, kind);
        if (!synthetic && host.References(id).Present)
            return host.Text(id, PrivacyValueHost.TextMember.Name) ?? kind.ToString();
        return (synthetic ? original : null) ?? kind.ToString();
    }

    /// <summary>The series a protected episode or season belongs to, by the library's own name; null for any other kind.</summary>
    internal static string? SeriesNameOf(PrivacyIdentity identity, PrivacyValueHost host)
        => identity.Kind is BaseItemKind.Episode or BaseItemKind.Season ? host.Text(identity.OwnerId, PrivacyValueHost.TextMember.Name) : null;

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
        => RebuildCaptured(value, known, scope, index, CaptureInputs(value, scope, index));

    private static object? RebuildCaptured(object value, Type known, Scope scope, int index, ProjectionInputs inputs)
    {
        var copy = known.GetConstructor(Type.EmptyTypes) != null ? Activator.CreateInstance(known)! : RuntimeHelpers.GetUninitializedObject(known);
        foreach (var (property, rule) in Plan(known, scope.Mode))
        {
            var original = property.GetValue(value);
            // Shapes are host-required too: a collection the host sent stays a collection (empty when its values are
            // withheld), because the host's clients index it (RequiredHttpHeaders.length, MediaStreams.filter).
            var kept = rule.Apply(original, scope, new Context(inputs, property.PropertyType, index)) ?? (original != null ? Empty(property.PropertyType) : null);
            if (kept == null && property.PropertyType.IsValueType && Nullable.GetUnderlyingType(property.PropertyType) == null) continue;
            property.SetValue(copy, kept);
        }
        return Admit(copy) ? copy : null;
    }

    /// <summary>An empty collection of a member's declared type (an array, a list or a dictionary); null for anything else.</summary>
    internal static object? Empty(Type declared)
    {
        if (declared == typeof(string)) return null;
        if (declared.IsArray) return Array.CreateInstance(declared.GetElementType()!, 0);
        if (!declared.IsGenericType) return null;
        var arguments = declared.GetGenericArguments();
        var definition = declared.GetGenericTypeDefinition();
        if (arguments.Length == 2 && (definition == typeof(Dictionary<,>) || definition == typeof(IDictionary<,>) || definition == typeof(IReadOnlyDictionary<,>)))
            return Activator.CreateInstance(typeof(Dictionary<,>).MakeGenericType(arguments));
        if (arguments.Length != 1) return null;
        var array = Array.CreateInstance(arguments[0], 0);
        if (declared.IsAssignableFrom(array.GetType())) return array;
        var list = typeof(List<>).MakeGenericType(arguments);
        return declared.IsAssignableFrom(list) ? Activator.CreateInstance(list) : null;
    }

    /// <summary>The members a type's projection copies, each with its rule; cached per type and mode.</summary>
    private static (PropertyInfo Property, Rule Rule)[] Plan(Type known, Mode mode) => _plans.GetOrAdd((known, mode), key =>
    {
        var table = _rules[key.Item1];
        return key.Item1.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.GetIndexParameters().Length == 0 && p.GetMethod is { IsPublic: true } && p.SetMethod is { IsPublic: true })
            // A stub keeps the host-required members of the item itself only (the classification); nested values keep theirs.
            // The others are withheld (a collection keeps its empty shape).
            .Select(p => (p, key.Item2 == Mode.Stub && key.Item1 == typeof(BaseItemDto) && PrivacyFieldClassification.Of(typeof(BaseItemDto), p.Name) != PrivacyField.HostRequired && p.Name != "Name"
                ? Drop : table.TryGetValue(p.Name, out var rule) ? rule : Default(p.PropertyType)))
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

    /// <summary>A value the rule CONSTRUCTS from the original (a table's own entry, a rebuilt URL, a title's own name); null drops it.</summary>
    private static Rule Val(string name, Func<string, Scope, Context, string?> make) => new(name, (v, s, c) => v is string t ? make(t, s, c) : null);

    private static Rule Val(string name, Func<string?, string?> make) => Val(name, (t, _, _) => make(t));

    /// <summary>A sequence of strings, each constructed by the rule (dropped when it gives none); the sequence's own type kept.</summary>
    private static Rule Vals(string name, Func<string, Scope, Context, string?> make) => new(name, (v, s, c) =>
        v is IEnumerable<string> values ? Typed(c.Declared, values.Where(t => t != null).Select(t => make(t, s, c)).OfType<string>().Distinct(StringComparer.Ordinal).ToArray()) : null);

    private static Rule Vals(string name, Func<string?, string?> make) => Vals(name, (t, _, _) => make(t));

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

    /// <summary>
    /// The title-level item a protected item's vocabulary is copied from (an episode's or season's series, an extra's owner;
    /// a movie or series is its own title): never the protected item's own names, which Jellyfin creates its genre, studio
    /// and person entities FROM (an entity's existence vouches for nothing).
    /// </summary>
    private static Guid? TitleOf(Scope s) => s.SubjectId != Guid.Empty ? s.Host.TitleId(s.SubjectId) : null;

    /// <summary>A name in the title's own list, as the title spells it (an absent title: the facade's own construction).</summary>
    private static Rule TitleEntry(string list, PrivacyValueHost.VocabularyList entries)
        => Vals("the title's own " + list + " entry (copied from the series / owner / title, never the protected item's)", (t, s, _) => s.Synthetic ? t : s.Host.Entry(TitleOf(s), entries, t));

    /// <summary>Name/id pairs whose name is in the title's own list: the title's spelling, the host's id.</summary>
    private static Rule TitlePairs(string list, PrivacyValueHost.VocabularyList entries) => new("the title's own " + list + " (copied from the series / owner / title)", (v, s, c) =>
        v is IEnumerable<NameGuidPair> pairs
            ? Typed(c.Declared, CapturePairs(pairs)
                .Select(p => (p.Id, Name: s.Synthetic ? p.Name : s.Host.Entry(TitleOf(s), entries, p.Name)))
                .Where(p => p.Name != null).Select(p => new NameGuidPair { Name = p.Name, Id = p.Id }).ToArray())
            : null);

    // Raw payload adapter: the pure vocabulary rule receives owned scalar pairs.
    private static (Guid Id, string? Name)[] CapturePairs(IEnumerable<NameGuidPair> pairs)
        => pairs.Where(p => p != null).Select(p => (p.Id, (string?)p.Name)).ToArray();

    /// <summary>A value only an absent title's facade constructs (a library item's own artist and album tags are not trusted).</summary>
    private static Rule FacadeOnly(Rule rule) => new("the facade's own (absent titles); a library item's dropped", (v, s, c) => s.Synthetic ? rule.Apply(v, s, c) : null);

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
    private static string? Entity(Scope s, Guid? id, PrivacyValueHost.TextMember field, object? facade)
    {
        if (s.Synthetic) return facade as string;
        // A computed entity field (a sort name built from the server's settings) that cannot be computed is left out.
        try { return s.Host.Text(id, field); }
        catch (Exception) { return null; }
    }

    private static bool Protects(BaseItemKind kind) => kind is BaseItemKind.Episode or BaseItemKind.Season;

    /// <summary>Whether the projected item is an extra another title owns (a library item with an owner).</summary>
    private static bool IsExtra(Scope s, Context c) => !s.Synthetic && s.Host.IsExtra(c.Input.Id);

    /// <summary>An extra's constructed name: what kind of extra it is ("Trailer", "Theme video", "Behind the scenes").</summary>
    internal static string ExtraLabel(BaseItem extra, BaseItemKind kind) => PrivacyIdentities.ExtraKind(extra) switch
    {
        ExtraType.Trailer => "Trailer",
        ExtraType.ThemeSong => "Theme song",
        ExtraType.ThemeVideo => "Theme video",
        ExtraType.BehindTheScenes => "Behind the scenes",
        ExtraType.DeletedScene => "Deleted scene",
        ExtraType.Interview => "Interview",
        ExtraType.Scene => "Scene",
        ExtraType.Sample => "Sample",
        ExtraType.Featurette => "Featurette",
        ExtraType.Short => "Short",
        ExtraType.Clip => "Clip",
        _ => kind switch { BaseItemKind.Trailer => "Trailer", BaseItemKind.Audio => "Theme song", _ => "Extra" },
    };

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
    private static readonly Rule IdText = Val("id (rebuilt from its parsed value)", PrivacyTokens.IdOf);
    private static readonly Rule TitleFamily = Revealed(r => r.TitleFamily, Drop, "kept");

    private static Rule LabelOf(string phrase) => Construct("the host's \"" + phrase + "\" label", (v, s, _) => v == null ? null : s.Host.Label(phrase));

    private static readonly Dictionary<Type, Dictionary<string, Rule>> _rules = new()
    {
        [typeof(BaseItemDto)] = new(StringComparer.Ordinal)
        {
            ["Name"] = Construct("constructed: the stub's neutral name, else NameOf (an episode's or season's neutral name, an extra's kind (\"Trailer\"), a movie's or series' own title from the library, the original only where a switch reveals it)", (v, s, c) =>
            {
                var item = c.Input;
                return s.Mode == Mode.Stub ? PrivacyFieldClassification.HiddenName : NameOf(item.Type, item.Id, item.ParentIndexNumber, item.IndexNumber, v as string, s.Reveal, s.Host, s.Synthetic);
            }),
            ["SortName"] = Construct("episode/season: dropped unless revealed; an extra: dropped unless its title family is revealed; else the title's own sort name", (v, s, c) =>
                Protects(c.Input.Type) ? (s.Reveal.Title ? v : null) : IsExtra(s, c) && !s.Reveal.TitleFamily ? null : Entity(s, c.Input.Id, PrivacyValueHost.TextMember.SortName, v)),
            ["OriginalTitle"] = Construct("episode/season: dropped unless revealed; an extra: dropped unless its title family is revealed; else the title's own original title", (v, s, c) =>
                Protects(c.Input.Type) ? (s.Reveal.Title ? v : null) : IsExtra(s, c) && !s.Reveal.TitleFamily ? null : Entity(s, c.Input.Id, PrivacyValueHost.TextMember.OriginalTitle, v)),
            ["ForcedSortName"] = TitleFamily,
            ["EpisodeTitle"] = TitleFamily,
            ["Path"] = TitleFamily,
            ["CustomRating"] = TitleFamily,
            ["ExternalUrls"] = TitleFamily,
            ["RemoteTrailers"] = TitleFamily,
            ["Overview"] = Construct("kept when revealed, else the placeholder (when there was one)", (v, s, _) => s.Reveal.Overview ? v : string.IsNullOrEmpty(v as string) ? null : s.Reveal.Placeholder),
            ["Taglines"] = Construct("kept when revealed, else empty", (v, s, _) => s.Reveal.Taglines ? v : v == null ? null : Array.Empty<string>()),
            ["Tags"] = Construct("kept when revealed, else empty", (v, s, _) => s.Reveal.Tags ? v : v == null ? null : Array.Empty<string>()),
            ["SeriesName"] = Construct("the series entity's name", (v, s, c) => Entity(s, c.Input.SeriesId, PrivacyValueHost.TextMember.Name, v)),
            ["SeasonName"] = Construct("kept when revealed, else the neutral season name", (v, s, c) => v == null ? null : s.Reveal.Title ? v : NeutralNames.Season(c.Input.ParentIndexNumber)),
            ["Album"] = FacadeOnly(Keep),
            ["AlbumArtist"] = FacadeOnly(Keep),
            ["AlbumArtists"] = FacadeOnly(Keep),
            ["Artists"] = FacadeOnly(Keep),
            ["ArtistItems"] = FacadeOnly(Keep),
            ["SeriesStudio"] = Val("the title's own studio entry (copied from the series / owner / title)", (t, s, _) => s.Synthetic ? t : s.Host.Entry(TitleOf(s), PrivacyValueHost.VocabularyList.Studios, t)),
            ["Genres"] = TitleEntry("genre", PrivacyValueHost.VocabularyList.Genres),
            ["GenreItems"] = TitlePairs("genres", PrivacyValueHost.VocabularyList.Genres),
            ["Studios"] = TitlePairs("studios", PrivacyValueHost.VocabularyList.Studios),
            ["People"] = Nested(typeof(BaseItemPerson)),
            ["Chapters"] = Nested(typeof(ChapterInfo)),
            ["MediaSources"] = Nested(typeof(MediaSourceInfo)),
            ["MediaStreams"] = Nested(typeof(MediaStream)),
            ["UserData"] = Nested(typeof(UserItemDataDto)),
            ["CurrentProgram"] = Drop,
            ["ChannelName"] = Construct("the channel entity's name", (v, s, c) => Entity(s, c.Input.ChannelId, PrivacyValueHost.TextMember.Name, v)),
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
            ["Container"] = Val("the container table's entries (host ffprobe)", PrivacyTokens.Container),
            ["DisplayOrder"] = Val("the display order list's entry", t => PrivacyTokens.OneOf(t, _displayOrders)),
            ["SourceType"] = Val("the source type list's entry", t => PrivacyTokens.OneOf(t, "Library", "LiveTV", "Channel")),
            ["Status"] = Val("the status list's entry", t => PrivacyTokens.OneOf(t, _statuses)),
            ["OfficialRating"] = Val("the host's rating table entry (a country-qualified entry rebuilt; any other text dropped)", (t, s, _) => s.Host.Rating(t)),
            ["OriginalLanguage"] = Val("the host's language list entry", (t, s, _) => s.Host.Language(t)),
            ["PreferredMetadataLanguage"] = Val("the host's language list entry", (t, s, _) => s.Host.Language(t)),
            ["PreferredMetadataCountryCode"] = Val("the host's country list entry", (t, s, _) => s.Host.Country(t)),
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
            ["Language"] = Val("the host's language list entry", (t, s, _) => s.Host.Language(t)),
            ["LocalizedLanguage"] = Construct("the host's own display name of the language list entry (constructed)", (v, s, c) => v == null ? null : s.Host.LanguageName(c.Input.Language)),
            ["LocalizedDefault"] = LabelOf("Default"),
            ["LocalizedExternal"] = LabelOf("External"),
            ["LocalizedForced"] = LabelOf("Forced"),
            ["LocalizedHearingImpaired"] = LabelOf("HearingImpaired"),
            ["LocalizedOriginal"] = LabelOf("Original"),
            ["LocalizedUndefined"] = LabelOf("Undefined"),
            ["Codec"] = Val("the codec table's entry (host ffprobe)", PrivacyTokens.Codec),
            ["CodecTag"] = Str("four-character code", PrivacyTokens.FourCc),
            ["Profile"] = Val("the profile table's entry", PrivacyTokens.Profile),
            ["ChannelLayout"] = Val("the channel layout table's entry (host ffprobe), or \"N channels\" rebuilt", PrivacyTokens.Layout),
            ["PixelFormat"] = Val("the pixel format table's entry (host ffprobe)", PrivacyTokens.PixelFormat),
            ["ColorPrimaries"] = Val("the colour table's entry", PrivacyTokens.Color),
            ["ColorRange"] = Val("the colour table's entry", PrivacyTokens.Color),
            ["ColorSpace"] = Val("the colour table's entry", PrivacyTokens.Color),
            ["ColorTransfer"] = Val("the colour table's entry", PrivacyTokens.Color),
            ["AspectRatio"] = Str("ratio", PrivacyTokens.Ratio),
            ["TimeBase"] = Str("rational", PrivacyTokens.Rational),
            ["CodecTimeBase"] = Str("rational", PrivacyTokens.Rational),
            ["NalLengthSize"] = Str("number", PrivacyTokens.Number),
            ["DeliveryUrl"] = Construct("rebuilt from the host's subtitle route template (named parameters, the host's file name \"Stream\", the caller's token); a raw external URL only when revealed", (v, s, c) =>
                s.Mode != Mode.Stub && s.Reveal.TitleFamily ? v : c.Input.IsExternalUrl == true ? null : PrivacyTokens.DeliveryUrl(v as string, s.Host.Caller)),
        },
        [typeof(MediaSourceInfo)] = new(StringComparer.Ordinal)
        {
            ["Name"] = Construct("kept when revealed, else a label from the version's validated video stream (\"1080p HEVC SDR\") or \"Version N\"", (v, s, c) =>
                s.Mode != Mode.Stub && s.Reveal.TitleFamily ? v : c.Input.VersionName),
            ["Path"] = TitleFamily,
            // A remote source's Path is the URL a client direct-plays (jellyfin-web plays MediaSource.Path when it may):
            // withheld, the source is offered for the host's own stream route instead (Videos/{id}/stream, which the server
            // proxies), so the client never needs the remote URL and its file name.
            ["SupportsDirectPlay"] = Construct("kept for a file source; a remote source whose URL is withheld: false (the client streams it through the host's route)", (v, s, c) =>
                v is true && c.Input.Protocol != MediaBrowser.Model.MediaInfo.MediaProtocol.File && !(s.Mode != Mode.Stub && s.Reveal.TitleFamily) ? false : v),
            ["EncoderPath"] = Drop,
            ["OpenToken"] = Drop,
            ["RequiredHttpHeaders"] = Drop,
            ["Id"] = Val("id (rebuilt from its parsed value) or the host's hex/underscore source id", t => PrivacyTokens.IdOf(t) ?? (PrivacyTokens.IdShaped(t) || HexList(t) ? t : null)),
            ["LiveStreamId"] = Str("the host's hex/underscore live stream id (closed format)", HexList),
            ["ETag"] = Tag,
            ["Container"] = Val("the container table's entries (host ffprobe)", PrivacyTokens.Container),
            ["TranscodingContainer"] = Val("the container table's entries (host ffprobe)", PrivacyTokens.Container),
            ["Formats"] = Vals("the container table's entries (host ffprobe)", PrivacyTokens.Container),
            ["TranscodingUrl"] = Val("rebuilt from the host's transcoding route template (named parameters, each value by its rule; the caller's device id and token)", (t, s, _) => PrivacyTokens.TranscodingUrl(t, s.Host.Caller)),
            ["MediaStreams"] = Nested(typeof(MediaStream)),
            ["MediaAttachments"] = Nested(typeof(MediaAttachment)),
        },
        [typeof(MediaAttachment)] = new(StringComparer.Ordinal)
        {
            ["Comment"] = TitleFamily,
            ["FileName"] = TitleFamily,
            ["Codec"] = Val("the codec table's entry (host ffprobe)", PrivacyTokens.Codec),
            ["CodecTag"] = Str("four-character code", PrivacyTokens.FourCc),
            ["MimeType"] = Val("the attachment MIME table's entry", PrivacyTokens.MimeType),
            ["DeliveryUrl"] = Val("rebuilt from the host's attachment route template", (t, s, _) => PrivacyTokens.DeliveryUrl(t, s.Host.Caller)),
        },
        [typeof(ChapterInfo)] = new(StringComparer.Ordinal)
        {
            ["Name"] = Construct("kept when revealed or already watched, else \"Chapter N\"", (v, s, c) =>
                v == null ? null : s.Reveal.ChapterNames || Watched(c.Input.ChapterStart, s) ? v : string.Create(CultureInfo.InvariantCulture, $"Chapter {c.Index + 1}")),
            ["ImagePath"] = Construct("kept when revealed or already watched, else dropped", (v, s, c) => s.Reveal.TitleFamily || Watched(c.Input.ChapterStart, s) ? v : null),
            ["ImageTag"] = Tag,
        },
        [typeof(BaseItemPerson)] = new(StringComparer.Ordinal)
        {
            ["Name"] = Val("the title's own person (copied from the series / owner / title; an episode's guest leaves)", (t, s, _) =>
                s.Synthetic ? t : s.Host.PersonName(TitleOf(s), t)),
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
            ["ChannelName"] = Construct("the channel entity's name", (_, s, c) => Entity(s, c.Input.ChannelId, PrivacyValueHost.TextMember.Name, null)),
            ["Status"] = Val("the status list's entry", t => PrivacyTokens.OneOf(t, _statuses)),
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
            ["Type"] = Val("the activity type list's entry", t => PrivacyTokens.OneOf(t, _activityTypes)),
            ["ItemId"] = IdText,
            ["UserPrimaryImageTag"] = Tag,
        },
    };

    private static Dictionary<string, Rule> Timer() => new(StringComparer.Ordinal)
    {
        ["Name"] = Drop,
        ["Overview"] = Drop,
        ["ProgramInfo"] = Drop,
        ["ChannelName"] = Construct("the channel entity's name", (_, s, c) => Entity(s, c.Input.ChannelId, PrivacyValueHost.TextMember.Name, null)),
        ["ServiceName"] = Drop,
        ["Id"] = IdText,
        ["ServerId"] = IdText,
        ["Type"] = Val("the timer type list's entry", t => PrivacyTokens.OneOf(t, "Timer", "SeriesTimer")),
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
    private static bool Watched(long start, Scope s) => s.Reveal.WatchedThrough is { } through && start < through;

    /// <summary>A movie version's label, built from its own validated video stream ("1080p HEVC SDR"), or "Version N".</summary>
    private static string CaptureVersionLabel(MediaSourceInfo source, Scope s, int index)
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
