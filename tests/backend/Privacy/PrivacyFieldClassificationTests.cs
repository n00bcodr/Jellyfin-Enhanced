using System.Collections;
using System.Reflection;
using System.Text.Json;
using Jellyfin.Data.Enums;
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
        var dto = Filled(new BaseItemDto { Id = Guid.NewGuid(), ServerId = "0202511b0eac4284ab045b3ba556d72e", Type = Jellyfin.Data.Enums.BaseItemKind.Movie, MediaType = Jellyfin.Data.Enums.MediaType.Video,
            IsFolder = false, RunTimeTicks = 6_000_000_000, LocationType = LocationType.FileSystem, ProductionYear = 1991, CommunityRating = 9 });
        dto.PlaylistItemId = "p0";
        var stub = NativePrivacyProjection.Stub(dto, new PrivacyValueHost(null, PrivacyTestHost.Localization()));
        Assert.Equal(PrivacyFieldClassification.HiddenName, stub.Name);
        Assert.Empty(TitleLeaks(stub, new HashSet<string>()));
        Assert.DoesNotContain(Secret, JsonSerializer.Serialize(stub, Jellyfin.Extensions.Json.JsonDefaults.Options));
        foreach (var p in typeof(BaseItemDto).GetProperties().Where(p => p.SetMethod is { IsPublic: true } && p.Name != "Name"))
        {
            var kind = PrivacyFieldClassification.Of(typeof(BaseItemDto), p.Name);
            var value = p.GetValue(stub);
            // Nothing else: no value (a collection the host sent keeps its shape, empty: its clients index it).
            if (kind != PrivacyField.HostRequired)
                Assert.True(value == null || value is System.Collections.IEnumerable list and not string && !list.Cast<object>().Any() || p.PropertyType.IsValueType && value.Equals(Activator.CreateInstance(p.PropertyType)), p.Name + " left in the stub");
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
        rig.Items[dto.Id].ParentIndexNumber = season;
        rig.Items[dto.Id].IndexNumber = episode;
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

    // ---------------------------------------------------------------------------------------------------------------
    // Values, not fields (review round 19): one value rule per member.

    [Theory]
    [MemberData(nameof(Hosts))]
    public void EveryStringOrObjectMemberTheHostListsHasItsOwnValueRule(string host)
    {
        // A value-typed member (number, flag, date, enum) is closed by its type; every other member a protected item can
        // carry names its rule explicitly (a deliberate drop included), so nothing is kept or dropped by accident.
        var types = PrivacyValues.Types.ToDictionary(t => t.Name);
        var missing = HostFields(host).Where(f => types.ContainsKey(f.Type) && f.Writable)
            .Select(f => (f.Type, f.Property, Clr: types[f.Type].GetProperty(f.Property)?.PropertyType))
            .Where(f => f.Clr != null && !IsClosedValue(f.Clr) && !PrivacyValues.RulesOf(types[f.Type]).ContainsKey(f.Property))
            .Select(f => f.Type + "." + f.Property).ToArray();
        Assert.True(missing.Length == 0, host + ": members without a value rule: " + string.Join(", ", missing.Take(30)));
    }

    private static bool IsClosedValue(Type type)
    {
        var element = type.IsArray ? type.GetElementType()! : type;
        element = Nullable.GetUnderlyingType(element) ?? element;
        return element.IsPrimitive || element.IsEnum || element == typeof(DateTime) || element == typeof(Guid) || element == typeof(decimal);
    }

    /// <summary>Members whose values the hosts produce from their own closed sets: every captured value must pass its validator.</summary>
    private static readonly (string Name, Func<BaseItemDto, IEnumerable<string?>> Values)[] HostValues =
    [
        ("ServerId", d => [d.ServerId]), ("Etag", d => [d.Etag]), ("Container", d => [d.Container]), ("PlaylistItemId", d => [d.PlaylistItemId]),
        ("ImageTags", d => d.ImageTags?.Values.ToArray() ?? []), ("BackdropImageTags", d => d.BackdropImageTags ?? []),
        ("ProviderIds", d => (d.ProviderIds ?? []).Where(p => p.Key is "Tmdb" or "Imdb" or "Tvdb").Select(p => p.Key + "=" + p.Value)),
        ("MediaStreams.Codec", d => (d.MediaStreams ?? []).Select(m => m.Codec)), ("MediaStreams.Profile", d => (d.MediaStreams ?? []).Select(m => m.Profile)),
        ("MediaStreams.ChannelLayout", d => (d.MediaStreams ?? []).Select(m => m.ChannelLayout)), ("MediaStreams.PixelFormat", d => (d.MediaStreams ?? []).Select(m => m.PixelFormat)),
        ("MediaStreams.TimeBase", d => (d.MediaStreams ?? []).Select(m => m.TimeBase)), ("MediaStreams.AspectRatio", d => (d.MediaStreams ?? []).Select(m => m.AspectRatio)),
        ("MediaStreams.CodecTag", d => (d.MediaStreams ?? []).Select(m => m.CodecTag)), ("MediaStreams.Language", d => (d.MediaStreams ?? []).Select(m => m.Language)),
        ("MediaSources.Id", d => (d.MediaSources ?? []).Select(m => m.Id)), ("MediaSources.ETag", d => (d.MediaSources ?? []).Select(m => m.ETag)),
        ("MediaSources.Container", d => (d.MediaSources ?? []).Select(m => m.Container)),
    ];

    [Fact]
    public void EveryValueTheHostsProducedForAKeptMemberPassesItsValidator()
    {
        // The captured answers of this build's host (12.2 for jf12, 10.11.11 for jf10), every item rebuilt as Spoiler Guard
        // delivers it with every strip on: what the host itself wrote for these members comes through unchanged. (A user-data
        // key the host derives from a name, an extra's "Theme Song" or a studio's "Studio-…", is free text and rightly
        // leaves a protected item; folders and views are never protected, and their captured tags were anonymized.)
        var host = new PrivacyValueHost(null, PrivacyTestHost.Localization());
        var dropped = new List<string>();
        var compared = 0;
        foreach (var shot in PrivacyHostShapeModelTests.Data.Shots.Where(s => !s.Endpoint.StartsWith("User.Authenticate", StringComparison.Ordinal)))
            foreach (var dto in AllDtos(PrivacyHostShapeModelTests.Value(shot)).Where(d => d.IsFolder != true || d.Type is BaseItemKind.Series or BaseItemKind.Season))
            {
                var rebuilt = PrivacyValues.Guarded(dto, PrivacyReveal.None, host);
                // A track without a title of its own is labelled exactly as the host labels it (the label is rebuilt from the
                // validated values: language, codec, profile, layout, flags).
                foreach (var stream in (dto.MediaStreams ?? []).Where(m => m.Title == null))
                {
                    compared++;
                    var label = rebuilt.MediaStreams?.FirstOrDefault(m => m.Index == stream.Index && m.Type == stream.Type)?.DisplayTitle;
                    if (label != stream.DisplayTitle) dropped.Add(shot.File + ": DisplayTitle " + stream.DisplayTitle + " -> " + label);
                }
                foreach (var (name, values) in HostValues)
                {
                    var before = values(dto).Where(v => v != null).ToArray();
                    var after = values(rebuilt).Where(v => v != null).ToArray();
                    compared += before.Length;
                    if (!before.SequenceEqual(after)) dropped.Add(shot.File + ": " + name + " " + string.Join("|", before.Except(after)));
                }
            }
        Assert.True(compared > 200, "captured values compared: " + compared);
        Assert.True(dropped.Count == 0, dropped.Count + " captured host values dropped, e.g. " + string.Join("; ", dropped.Distinct().Take(15)));
    }

    private static IEnumerable<BaseItemDto> AllDtos(object? node, int depth = 0)
    {
        if (node == null || depth > 6 || node is string || node.GetType().IsValueType) yield break;
        if (node is BaseItemDto dto) yield return dto;
        if (node is IEnumerable sequence) { foreach (var e in sequence) foreach (var d in AllDtos(e, depth + 1)) yield return d; yield break; }
        foreach (var p in node.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance).Where(p => p.GetIndexParameters().Length == 0 && !p.PropertyType.IsValueType && p.PropertyType != typeof(string)))
            foreach (var d in AllDtos(p.GetValue(node), depth + 1)) yield return d;
    }

    /// <summary>
    /// The hosts' own URL shapes (live, 12.2 and 10.11.11; api keys masked as hex) are rebuilt byte for byte from their
    /// route templates, with the caller's own device id and token; a URL carrying text keeps none of it.
    /// </summary>
    [Theory]
    [InlineData("/videos/7a2e4f8e-f2cf-9cdb-31bc-06e83a64bf87/master.m3u8?DeviceId=d46r20-live-18554&MediaSourceId=7a2e4f8ef2cf9cdb31bc06e83a64bf87&VideoCodec=h264&AudioCodec=aac&AudioStreamIndex=2&VideoBitrate=808000&AudioBitrate=192000&AudioSampleRate=44100&MaxFramerate=24&SegmentContainer=ts&BreakOnNonKeyFrames=False&PlaySessionId=bea7025a61ca464884ea2a18f785d2a4&ApiKey=0123456789abcdef0123456789abcdef&RequireAvc=false&EnableAudioVbrEncoding=true&Tag=5304726cd85a2d70bf6431e65e91b5ca&h264-level=12&h264-profile=high&TranscodeReasons=DirectPlayError,ContainerNotSupported&allowVideoStreamCopy=false", "d46r20-live-18554", true)]
    [InlineData("/videos/7a2e4f8e-f2cf-9cdb-31bc-06e83a64bf87/master.m3u8?&DeviceId=d46r20-probe&MediaSourceId=7a2e4f8ef2cf9cdb31bc06e83a64bf87&VideoCodec=h264&AudioCodec=aac&AudioStreamIndex=2&ApiKey=0123456789abcdef0123456789abcdef&h264-videobitdepth=8&aac-profile=lc&TranscodeReasons=DirectPlayError&allowAudioStreamCopy=false", "d46r20-probe", true)]
    [InlineData("/audio/7a2e4f8e-f2cf-9cdb-31bc-06e83a64bf87/stream.mp3?Static=true&DeviceId=TW96aWxsYS81LjA%3D", "TW96aWxsYS81LjA=", true)]
    [InlineData("/videos/7a2e4f8e-f2cf-9cdb-31bc-06e83a64bf87/master.m3u8?DeviceId=x&Title=Secret%20ending", "x", false)]
    [InlineData("/videos/7a2e4f8e-f2cf-9cdb-31bc-06e83a64bf87/master.m3u8?Name=Secret ending", "x", false)]
    [InlineData("/videos/7a2e4f8e-f2cf-9cdb-31bc-06e83a64bf87/master.m3u8?Title=The.Death.of.Secret.mkv&PlaySessionId=SecretEnding&VideoCodec=h264,Secret", "x", false)]
    [InlineData("/videos/7a2e4f8e-f2cf-9cdb-31bc-06e83a64bf87/stream.Secret?Static=true", "x", false)]
    [InlineData("https://provider.invalid/Secret.m3u8", "x", false)]
    public void TheTranscodingUrlIsRebuiltFromTheHostsTemplate(string url, string device, bool host)
    {
        var rebuilt = PrivacyTokens.TranscodingUrl(url, new PrivacyTokens.Caller(device, "0123456789abcdef0123456789abcdef"));
        if (host) Assert.Equal(url, rebuilt);
        else Assert.DoesNotContain("Secret", rebuilt ?? "", StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TheTranscodingUrlCarriesTheCallersOwnDeviceAndToken()
    {
        const string url = "/videos/7a2e4f8e-f2cf-9cdb-31bc-06e83a64bf87/master.m3u8?DeviceId=SecretDevice&MediaSourceId=7a2e4f8ef2cf9cdb31bc06e83a64bf87&ApiKey=0123456789abcdef0123456789abcdef";
        Assert.Equal("/videos/7a2e4f8e-f2cf-9cdb-31bc-06e83a64bf87/master.m3u8?DeviceId=own-device&MediaSourceId=7a2e4f8ef2cf9cdb31bc06e83a64bf87&ApiKey=ffffffffffffffffffffffffffffffff",
            PrivacyTokens.TranscodingUrl(url, new PrivacyTokens.Caller("own-device", "ffffffffffffffffffffffffffffffff")));
        // Without a caller (no request), the parameters the host fills from the request are left out.
        Assert.Equal("/videos/7a2e4f8e-f2cf-9cdb-31bc-06e83a64bf87/master.m3u8?MediaSourceId=7a2e4f8ef2cf9cdb31bc06e83a64bf87", PrivacyTokens.TranscodingUrl(url, default));
    }

    [Theory]
    [InlineData("/Videos/7a2e4f8e-f2cf-9cdb-31bc-06e83a64bf87/7a2e4f8ef2cf9cdb31bc06e83a64bf87/Subtitles/0/0/Stream.srt?ApiKey=0123456789abcdef0123456789abcdef", true)]
    [InlineData("/Videos/7a2e4f8e-f2cf-9cdb-31bc-06e83a64bf87/7a2e4f8ef2cf9cdb31bc06e83a64bf87/Subtitles/2/0/Stream.vtt", true)]
    [InlineData("/Videos/7a2e4f8e-f2cf-9cdb-31bc-06e83a64bf87/7a2e4f8ef2cf9cdb31bc06e83a64bf87/Attachments/3", true)]
    [InlineData("/Videos/7a2e4f8e-f2cf-9cdb-31bc-06e83a64bf87/7a2e4f8ef2cf9cdb31bc06e83a64bf87/Subtitles/0/0/TheDeathOfSecret.srt?ApiKey=0123456789abcdef0123456789abcdef", false)]
    [InlineData("/Videos/7a2e4f8e-f2cf-9cdb-31bc-06e83a64bf87/7a2e4f8ef2cf9cdb31bc06e83a64bf87/Attachments/3?Name=Secret", false)]
    [InlineData("/config/media/D46 R20 Secret - S01E01.en.srt", false)]
    [InlineData("https://provider.invalid/Secret.srt", false)]
    public void TheDeliveryUrlIsRebuiltWithTheHostsFileName(string url, bool host)
    {
        var rebuilt = PrivacyTokens.DeliveryUrl(url, new PrivacyTokens.Caller(null, "0123456789abcdef0123456789abcdef"));
        if (host) Assert.Equal(url, rebuilt);
        else Assert.DoesNotContain("Secret", rebuilt ?? "", StringComparison.OrdinalIgnoreCase);
    }
}
