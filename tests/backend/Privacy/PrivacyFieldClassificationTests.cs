using System.Collections;
using System.Reflection;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Providers;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace JE.Tests;

/// <summary>
/// The one field classification (<see cref="PrivacyFieldClassification"/>) against the hosts' own DTO types: every
/// public property of every type the privacy walker touches on 12.2 and 10.11.11 (tests/fixtures/host-endpoints
/// dto-fields-*.tsv, read from the hosts' assemblies by tests/host/endpoint-registry --fields) is classified; the walker
/// keeps a stub exactly where the classification says the host needs one; a stub keeps every host-required field and no
/// other; Spoiler Guard's strip removes every title-bearing field of a protected episode whatever its numbering.
/// </summary>
[Collection("Plugin singleton")]
public class PrivacyFieldClassificationTests
{
    private const string Secret = "SECRET-r19";

    public static IEnumerable<object[]> Hosts() => new[] { "12.2", "10.11.11" }.Select(h => new object[] { h });

    private static IReadOnlyList<(string Type, string Property, bool Writable)> HostFields(string host)
    {
        using var stream = typeof(PrivacyFieldClassificationTests).Assembly.GetManifestResourceStream("JE.Tests.HostDtoFields." + host)!;
        return new StreamReader(stream).ReadToEnd().Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Split('\t')).Select(c => (c[0].Split('<')[0], c[1], c[3].Trim() == "rw")).ToArray();
    }

    [Theory]
    [MemberData(nameof(Hosts))]
    public void EveryFieldOfEveryTypeTheWalkerTouchesOnTheHostIsClassified(string host)
    {
        var fields = HostFields(host);
        Assert.True(fields.Count > 400, "the host's field list");
        var missing = fields.Where(f => PrivacyFieldClassification.Fields(f.Type)?.ContainsKey(f.Property) != true).Select(f => f.Type + "." + f.Property).ToArray();
        Assert.True(missing.Length == 0, host + ": unclassified: " + string.Join(", ", missing));
        // Every type the walker touches on the host is in the table.
        Assert.Empty(fields.Select(f => f.Type).Distinct().Where(t => PrivacyFieldClassification.Fields(t) == null));
    }

    [Fact]
    public void TheClassificationNamesNoFieldEitherHostLacks()
    {
        var known = Hosts().SelectMany(h => HostFields((string)h[0])).Select(f => f.Type + "." + f.Property).ToHashSet();
        var stale = PrivacyFieldClassification.Types.SelectMany(t => PrivacyFieldClassification.Fields(t)!.Keys.Select(p => t + "." + p)).Where(n => !known.Contains(n)).ToArray();
        Assert.True(stale.Length == 0, "classified but on no host: " + string.Join(", ", stale));
    }

    [Theory]
    [InlineData(typeof(SessionInfoDto), "NowPlayingItem", true)]
    [InlineData(typeof(SessionInfoDto), "NowViewingItem", false)]
    [InlineData(typeof(BaseItemDto), "CurrentProgram", false)]
    [InlineData(typeof(MediaBrowser.Model.LiveTv.TimerInfoDto), "ProgramInfo", false)]
    public void TheWalkerKeepsAStubExactlyWhereTheHostNeedsTheMember(Type type, string member, bool stub)
    {
        var property = type.GetProperty(member)!;
        Assert.Equal(stub, PrivacyFieldClassification.KeepsControls(property));
        Assert.Equal(stub ? PrivacyField.HostRequired : PrivacyField.TitleBearing, PrivacyFieldClassification.Of(type, member));
    }

    /// <summary>A DTO whose every writable string (and string list) carries the secret, with titled media streams.</summary>
    private static BaseItemDto Filled(BaseItemDto dto)
    {
        foreach (var p in typeof(BaseItemDto).GetProperties().Where(p => p.SetMethod is { IsPublic: true }))
        {
            if (p.PropertyType == typeof(string) && p.Name is not ("ServerId" or "Etag" or "Container")) p.SetValue(dto, Secret + " " + p.Name);
            else if (p.PropertyType == typeof(string[])) p.SetValue(dto, new[] { Secret + " " + p.Name });
        }
        dto.People = [new BaseItemPerson { Name = "Guest", Role = Secret + " role", Type = Jellyfin.Data.Enums.PersonKind.Actor }];
        dto.Chapters = [new ChapterInfo { Name = Secret + " chapter", ImagePath = Secret + " chapter path", StartPositionTicks = 10 }];
        dto.ExternalUrls = [new ExternalUrl { Name = Secret + " link", Url = "https://example.invalid/" + Secret }];
        dto.RemoteTrailers = [new MediaUrl { Name = Secret + " trailer", Url = "https://example.invalid/" + Secret }];
        MediaStream Titled(MediaStreamType type, int index, bool external = false)
            => new() { Type = type, Index = index, Codec = type == MediaStreamType.Audio ? "aac" : "srt", Language = "eng", Title = Secret + " track " + index, Comment = Secret + " comment",
                IsExternal = external, Path = external ? "/media/" + Secret + ".srt" : null, Channels = type == MediaStreamType.Audio ? 2 : null };
        dto.MediaStreams = [Titled(MediaStreamType.Audio, 1), Titled(MediaStreamType.Audio, 2), Titled(MediaStreamType.Subtitle, 3), Titled(MediaStreamType.Subtitle, 4, external: true)];
        dto.MediaSources = [new MediaSourceInfo { Id = "s", Name = Secret + " version", Path = "/media/" + Secret + ".mkv", MediaStreams = dto.MediaStreams.ToList(),
            MediaAttachments = [new MediaAttachment { FileName = Secret + ".ttf", Comment = Secret }] }];
        return dto;
    }

    /// <summary>Every title-bearing field at any depth of a classified value that still carries the secret.</summary>
    private static List<string> TitleLeaks(object value, ISet<string> exempt, string path = "$")
    {
        var leaks = new List<string>();
        var type = value.GetType();
        if (PrivacyFieldClassification.Fields(type.Name) == null) return leaks;
        foreach (var p in type.GetProperties(BindingFlags.Public | BindingFlags.Instance).Where(p => p.GetIndexParameters().Length == 0))
        {
            var v = p.GetValue(value);
            if (v == null) continue;
            if (PrivacyFieldClassification.Of(type, p.Name) == PrivacyField.TitleBearing && !exempt.Contains(type.Name + "." + p.Name)
                && JsonSerializer.Serialize(v, v.GetType()).Contains(Secret, StringComparison.Ordinal)) leaks.Add(path + "." + p.Name);
            if (v is IEnumerable list and not string) { var i = 0; foreach (var e in list) if (e != null) leaks.AddRange(TitleLeaks(e, exempt, path + "." + p.Name + "[" + i++ + "]")); }
            else if (v is not string) leaks.AddRange(TitleLeaks(v, exempt, path + "." + p.Name));
        }
        return leaks;
    }

    [Fact]
    public void AStubKeepsEveryHostRequiredFieldAndNothingElse()
    {
        var dto = Filled(new BaseItemDto { Id = Guid.NewGuid(), ServerId = "srv", Type = Jellyfin.Data.Enums.BaseItemKind.Movie, MediaType = Jellyfin.Data.Enums.MediaType.Video,
            IsFolder = false, RunTimeTicks = 6_000_000_000, LocationType = LocationType.FileSystem, ProductionYear = 1991, CommunityRating = 9 });
        dto.PlaylistItemId = "p0";
        var stub = NativePrivacyProjection.Stub(dto);
        Assert.Equal(PrivacyFieldClassification.HiddenName, stub.Name);
        Assert.Empty(TitleLeaks(stub, new HashSet<string>()));
        Assert.DoesNotContain(Secret, JsonSerializer.Serialize(stub, Jellyfin.Extensions.Json.JsonDefaults.Options));
        foreach (var p in typeof(BaseItemDto).GetProperties().Where(p => p.SetMethod is { IsPublic: true } && p.Name != "Name"))
        {
            var kind = PrivacyFieldClassification.Of(typeof(BaseItemDto), p.Name);
            var value = p.GetValue(stub);
            if (kind != PrivacyField.HostRequired) Assert.True(value == null || value.Equals(Activator.CreateInstance(p.PropertyType)), p.Name + " left in the stub");
            else if (p.Name != "MediaStreams") Assert.Equal(p.GetValue(dto), value);
        }
        // Media streams: the same tracks, no title-bearing field, a display title the menus can show.
        Assert.Equal(dto.MediaStreams!.Select(s => (s.Type, s.Index, s.Codec, s.Language, s.IsExternal)), stub.MediaStreams!.Select(s => (s.Type, s.Index, s.Codec, s.Language, s.IsExternal)));
        Assert.All(stub.MediaStreams!, s => { Assert.Null(s.Title); Assert.Null(s.Comment); Assert.Null(s.Path); Assert.False(string.IsNullOrWhiteSpace(s.DisplayTitle)); });
        // The host's own (shared) item is untouched.
        Assert.Contains(Secret, dto.MediaStreams![0].Title);
    }

    public static IEnumerable<object?[]> Numberings() => new object?[][] { [1, 1, "Season 1, Episode 1"], [1, null, "Season 1, Episode"], [null, null, "Episode"], [null, 5, "Episode 5"], [3, 7, "Season 3, Episode 7"] };

    /// <summary>
    /// Spoiler Guard's strip at the final gate removes every title-bearing field of a guarded unwatched episode, at any
    /// depth, whatever numbering it has; the parent titles Spoiler Guard shows by design (the series, its studio) are the
    /// only title-bearing fields kept. Host-required fields stay.
    /// </summary>
    [Theory]
    [MemberData(nameof(Numberings))]
    public void AGuardedEpisodeLosesEveryTitleBearingFieldWhateverItsNumbering(int? season, int? episode, string name)
    {
        using var rig = new PrivacyHostShapeModelTests.Rig();
        var config = rig.F.Plugin.Configuration;
        config.SpoilerStripTags = true; config.SpoilerStripChapters = true; config.SpoilerStripTaglines = true; config.SpoilerStripCast = true;
        rig.Commit(PrivacyHostShapeModelTests.Rules.Single(r => r.Id == "sg-r19-series"), rig.Admin);
        var shot = PrivacyHostShapeModelTests.Data.Shots.Single(s => s.File == "UserLibrary.GetItem.r19-e3.json");
        var dto = Filled((BaseItemDto)PrivacyHostShapeModelTests.Value(shot));
        dto.ParentIndexNumber = season; dto.IndexNumber = episode; dto.UserData = null;
        var streams = dto.MediaStreams!.Length;
        var delivery = new ResultExecutingContext(PrivacyHostShapeModelTests.Context(shot, rig.Admin), new List<IFilterMetadata>(), new ObjectResult(dto), new object());
        rig.Gate().OnResultExecuting(delivery);
        var delivered = Assert.IsType<BaseItemDto>(Assert.IsAssignableFrom<ObjectResult>(delivery.Result).Value);
        Assert.Equal(name, delivered.Name);
        var exempt = new HashSet<string> { "BaseItemDto.SeriesName", "BaseItemDto.SeriesStudio", "BaseItemDto.Album", "BaseItemDto.AlbumArtist", "BaseItemDto.AlbumArtists", "BaseItemDto.Artists", "BaseItemDto.ArtistItems", "BaseItemDto.Name" };
        var leaks = TitleLeaks(delivered, exempt);
        Assert.True(leaks.Count == 0, "title-bearing fields kept: " + string.Join(", ", leaks));
        Assert.Equal(streams, delivered.MediaStreams!.Length);
        Assert.Equal(PrivacyHostShapeModelTests.G(PrivacyHostShapeModelTests.Data.Roles["episode:r19-e3"]), delivered.Id);
        Assert.Equal(10, delivered.Chapters![0].StartPositionTicks);
    }

    [Theory]
    [InlineData(2, 6, "Season 2, Episode 6")]
    [InlineData(2, null, "Season 2, Episode")]
    [InlineData(null, 6, "Episode 6")]
    [InlineData(null, null, "Episode")]
    public void TheNeutralEpisodeNameUsesWhateverNumberingThereIs(int? season, int? episode, string expected)
    {
        Assert.Equal(expected, NeutralNames.Episode(season, episode));
        Assert.Equal(season is { } s ? "Season " + s : "Season", NeutralNames.Season(season));
    }
}
