using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;

namespace JE.Tests;

// Review round 1 (arr track): a reused requestId with a different add is refused instead of replaying another add's
// result, a follow-up search that couldn't be started is reported (and replayed), name resolution counts against the
// per-call timeout, and long instance names survive the round trip through the dialog.
[Collection("Plugin singleton")]
public class ListPlaceholdersReviewR1eTests
{
    private const string Admin = "0123456789abcdef0123456789abcdef";

    private const string MovieBody = "{\"requestId\":\"r1e-1\",\"mediaType\":\"movie\",\"instance\":0,\"tmdbId\":49521,\"scope\":\"movie\",\"qualityProfileId\":4,\"rootFolderPath\":\"/movies\",\"search\":true}";

    private const string SeasonBody = "{\"requestId\":\"r1e-season\",\"mediaType\":\"tv\",\"instance\":0,\"tmdbId\":110492,\"scope\":\"season\",\"seasonNumber\":2,\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\",\"search\":true}";

    private sealed class Fixture : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public FakeArr Arr { get; } = new();
        public ListPlaceholderArrService Service { get; }

        public Fixture(string radarrName = "Movies")
        {
            var config = Plugin.Plugin.Configuration;
            config.ListPlaceholdersEnabled = true;
            config.ListPlaceholdersArrEnabled = true;
            config.RadarrInstances = JsonSerializer.Serialize(new[] { new { Name = radarrName, Url = FakeArr.RadarrUrl, ApiKey = FakeArr.RadarrKey, Enabled = true } });
            config.SonarrInstances = $"[{{\"Name\":\"TV\",\"Url\":\"{FakeArr.SonarrUrl}\",\"ApiKey\":\"{FakeArr.SonarrKey}\",\"Enabled\":true}}]";
            Service = new ListPlaceholderArrService(Arr.Transport, new ListPlaceholderStore(Plugin.Core.Paths.Object, Plugin.Core.Logger), Plugin.Core.Logger)
            {
                EpisodePollInterval = TimeSpan.FromMilliseconds(1),
            };
            Arr.RadarrCatalog.Add(FakeArr.Movie(49521, "Man of Steel", 2013, "tt0770828"));
            Arr.AddSeriesToCatalog(391153, 110492, "Peacemaker", "peacemaker", 3, 8, 8);
        }

        public Task<ListOutcome> Add(string json, string user = Admin) =>
            Service.AddAsync(JsonSerializer.Deserialize<ArrAddRequest>(json), user, "admin", CancellationToken.None);

        public void Dispose()
        {
            Arr.Dispose();
            Plugin.Dispose();
        }
    }

    private static ArrAddResultDto Ok(ListOutcome outcome)
    {
        Assert.True(outcome.StatusCode == 200, $"expected 200, got {outcome.StatusCode}: {JsonSerializer.Serialize(outcome.Value)}");
        return Assert.IsType<ArrAddResultDto>(outcome.Value);
    }

    private static ListErrorDto Error(ListOutcome outcome, int status, string code)
    {
        Assert.True(outcome.StatusCode == status, $"expected {status}, got {outcome.StatusCode}: {JsonSerializer.Serialize(outcome.Value)} {outcome.RawJson}");
        var error = Assert.IsType<ListErrorDto>(outcome.Value);
        Assert.Equal(code, error.Code);
        return error;
    }

    private static Func<string, HttpRequestMessage, HttpResponseMessage?> FailCommands() =>
        (_, request) => request.Method == HttpMethod.Post && request.RequestUri!.AbsolutePath == "/api/v3/command"
            ? IntegrationTransport.Response("{\"message\":\"boom\"}", 500)
            : null;

    // ── F31: a requestId only replays the add it was first used for ──

    [Fact]
    public async Task AReusedRequestIdWithADifferentAddIsRefusedNotReplayed()
    {
        using var f = new Fixture();
        Assert.Equal("added", Ok(await f.Add(MovieBody)).Result);

        // Same id, other choices (a lost answer, then the admin changed the dialog): never the first add's "added".
        var changed = await f.Add(MovieBody.Replace("\"qualityProfileId\":4", "\"qualityProfileId\":1", StringComparison.Ordinal));
        Error(changed, 409, "request_mismatch");
        var otherScope = await f.Add(MovieBody.Replace("\"search\":true", "\"search\":false", StringComparison.Ordinal));
        Error(otherScope, 409, "request_mismatch");

        // The identical retry still replays.
        var replay = await f.Add(MovieBody);
        Assert.Equal(200, replay.StatusCode);
        Assert.Equal("added", JsonNode.Parse(replay.RawJson!)!["result"]!.GetValue<string>());
        Assert.Single(f.Arr.Writes("radarr"));
    }

    // ── F32: a follow-up search that couldn't be started is reported ──

    [Fact]
    public async Task AFollowUpSearchThatFailsIsReportedAndReplayed()
    {
        using var f = new Fixture();
        f.Arr.SeedSeries(391153, monitored: true, s => s == 1, (s, _) => s == 1);
        f.Arr.Override = FailCommands();

        var result = Ok(await f.Add(SeasonBody));
        Assert.Equal("monitoring_added", result.Result);
        Assert.False(result.Searched);
        Assert.True(result.SearchFailed);

        var replay = await f.Add(SeasonBody);
        Assert.Equal(200, replay.StatusCode);
        Assert.True(JsonNode.Parse(replay.RawJson!)!["searchFailed"]!.GetValue<bool>());
    }

    [Fact]
    public async Task AFailedEpisodeSearchIsReportedForExistingAndNewSeries()
    {
        using var f = new Fixture();
        f.Arr.Override = FailCommands();
        const string episodes = "{\"mediaType\":\"tv\",\"instance\":0,\"tvdbId\":391153,\"scope\":\"episodes\",\"seasonNumber\":1,\"episodes\":[{\"s\":1,\"e\":3}],\"qualityProfileId\":4,\"rootFolderPath\":\"/tv\",\"search\":true}";

        var added = Ok(await f.Add(episodes));
        Assert.Equal("added", added.Result);
        Assert.True(added.SearchFailed);

        var more = Ok(await f.Add(episodes.Replace("\"e\":3", "\"e\":5", StringComparison.Ordinal)));
        Assert.Equal("monitoring_added", more.Result);
        Assert.False(more.Searched);
        Assert.True(more.SearchFailed);
    }

    [Fact]
    public async Task NoSearchAskedOrAStartedSearchIsNeverASearchFailure()
    {
        using var f = new Fixture();
        f.Arr.SeedSeries(391153, monitored: true, s => s == 1, (s, _) => s == 1);
        var searched = Ok(await f.Add(SeasonBody));
        Assert.True(searched.Searched);
        Assert.Null(searched.SearchFailed);

        f.Arr.Override = FailCommands();
        var unasked = Ok(await f.Add(SeasonBody.Replace("\"seasonNumber\":2", "\"seasonNumber\":0", StringComparison.Ordinal).Replace("\"search\":true", "\"search\":false", StringComparison.Ordinal).Replace("r1e-season", "r1e-season-0", StringComparison.Ordinal)));
        Assert.False(unasked.Searched);
        Assert.Null(unasked.SearchFailed);
    }

    // ── Review round 2: the add's budget running out during the search is a failed search, not a failed add ──

    [Fact]
    public async Task RunningOutOfTimeDuringTheSearchReportsAFailedSearchAndReplaysIt()
    {
        using var f = new Fixture();
        f.Service.AddBudget = TimeSpan.FromMilliseconds(500);
        f.Arr.SeedSeries(391153, monitored: true, s => s == 1, (s, _) => s == 1);
        f.Arr.Delay = (_, request, ct) => request.Method == HttpMethod.Post && request.RequestUri!.AbsolutePath == "/api/v3/command"
            ? Task.Delay(Timeout.Infinite, ct)
            : Task.CompletedTask;

        var result = Ok(await f.Add(SeasonBody));
        Assert.Equal("monitoring_added", result.Result);
        Assert.False(result.Searched);
        Assert.True(result.SearchFailed);

        f.Arr.Delay = null;
        var replay = await f.Add(SeasonBody);
        Assert.Equal(200, replay.StatusCode);
        Assert.True(JsonNode.Parse(replay.RawJson!)!["searchFailed"]!.GetValue<bool>());
    }

    // ── F33: name resolution is part of the per-call time limit ──

    [Fact]
    public async Task AHangingNameLookupTimesOutWithinTheCallTimeout()
    {
        using var f = new Fixture();
        f.Service.CallTimeout = TimeSpan.FromMilliseconds(50);
        f.Service.AddBudget = TimeSpan.FromSeconds(5);
        f.Service.UrlGuard = async (_, ct) =>
        {
            await Task.Delay(Timeout.Infinite, ct);
            return true;
        };

        var clock = Stopwatch.StartNew();
        var error = Error(await f.Add(MovieBody), 504, "arr_timeout");
        clock.Stop();

        // The per-call limit answered ("didn't answer in time"), not the whole-add budget ("took too long").
        Assert.Contains("didn't answer in time", error.Message, StringComparison.Ordinal);
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(3), $"took {clock.Elapsed}");
        Assert.Empty(f.Arr.Calls);
    }

    // ── F35: long instance names come back unchanged from the dialog ──

    [Theory]
    [InlineData(" and a long tail", 99)]
    [InlineData("\U0001F600 emoji tail", 99)]
    [InlineData("b\U0001F600 emoji tail", 100)]
    public async Task ALongInstanceNameRoundTripsThroughTheDialog(string tail, int expectedLength)
    {
        var name = new string('a', 99) + tail;
        using var f = new Fixture(name);
        var options = Assert.IsType<ArrOptionsDto>((await f.Service.GetOptionsAsync("movie", CancellationToken.None)).Value);
        var shown = Assert.Single(options.Radarr).Name;

        Assert.Equal(expectedLength, shown.Length);
        Assert.Equal(shown.TrimEnd(), shown);
        Assert.False(char.IsHighSurrogate(shown[^1]), "the name ends in half an emoji");

        // What the browser gets and sends back as instanceName.
        var echoed = JsonNode.Parse(JsonSerializer.Serialize(options))!["radarr"]![0]!["name"]!.GetValue<string>();
        var body = JsonNode.Parse(MovieBody)!.AsObject();
        body["instanceName"] = echoed;
        body["instanceKey"] = Assert.Single(options.Radarr).Key;
        Assert.Equal("added", Ok(await f.Add(body.ToJsonString())).Result);
    }
}
