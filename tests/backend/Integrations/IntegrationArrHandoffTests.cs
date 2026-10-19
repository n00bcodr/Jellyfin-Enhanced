using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace JE.Tests;

/// <summary>
/// Reason code <c>approved_not_in_arr</c> (Requests &amp; downloads, phase 2) in the style of the
/// reason-code appendix: a request Seerr OK'd that no Sonarr/Radarr holds. Administrators are told
/// after the grace period ("OK'd in Seerr {age} ago, but no Sonarr/Radarr has it"), family members
/// keep "OK'd! Getting started" until the "still looking" hours, then "Taking longer than usual".
/// Never while an instance can't be read, while an arr holds the title, or with phase 2 off.
/// </summary>
public class IntegrationArrHandoffTests
{
    private static readonly DateTime Now = new(2026, 10, 12, 12, 0, 0, DateTimeKind.Utc);
    private static readonly ArrConnection Radarr = new() { Id = "6d0b7d1c-0000-4000-8000-0000000000c1", Kind = ArrKind.Radarr, Name = "Radarr", Url = "http://radarr.lan:7878" };
    private static readonly StatusViewer Member = new() { UserId = Guid.NewGuid(), PolicyRevision = "m" };
    private static readonly StatusViewer Admin = new() { UserId = Guid.NewGuid(), IsAdmin = true, PolicyRevision = "a" };
    private static readonly TitleKey MovieKey = TitleKey.Parse("movie:tmdb:27205")!;
    private static readonly TitleKey ShowKey = TitleKey.Parse("tv:tvdb:279121")!;

    public static TheoryData<string> Rows() => new()
    {
        "family, OK'd 20 min ago, no arr has it",
        "admin, OK'd 20 min ago, no arr has it",
        "admin, OK'd 10 min ago (inside the grace)",
        "family, OK'd 25 h ago, no arr has it",
        "admin, phase 2 off",
        "admin, Radarr holds it",
        "admin, Radarr can't be read",
        "admin, Radarr's latest read failed (index from before)",
        "admin, still waiting for an OK",
        "admin, declined",
        "admin, no Radarr set up in Jellyfin Enhanced",
        "family, OK'd 25 h ago, no Radarr set up in Jellyfin Enhanced",
    };

    private static (StatusViewer Viewer, double Minutes, bool Holds, bool Unreadable, TimeSpan? Grace, RequestFacts Request, string Stage, string Code, bool Attention) Row(string name)
    {
        RequestFacts Ok(double minutes) => new() { AskedAt = Now.AddMinutes(-minutes - 5), ApprovedAt = Now.AddMinutes(-minutes) };
        var grace = TimeSpan.FromMinutes(15);
        return name switch
        {
            "family, OK'd 20 min ago, no arr has it" => (Member, 20, false, false, grace, Ok(20), StatusStage.Approved, StatusReasonCode.Approved, false),
            "admin, OK'd 20 min ago, no arr has it" => (Admin, 20, false, false, grace, Ok(20), StatusStage.Approved, StatusReasonCode.ApprovedNotInArr, true),
            "admin, OK'd 10 min ago (inside the grace)" => (Admin, 10, false, false, grace, Ok(10), StatusStage.Approved, StatusReasonCode.Approved, false),
            "family, OK'd 25 h ago, no arr has it" => (Member, 1500, false, false, grace, Ok(1500), StatusStage.Approved, StatusReasonCode.ApprovedNotInArr, true),
            "admin, phase 2 off" => (Admin, 20, false, false, null, Ok(20), StatusStage.Approved, StatusReasonCode.Approved, false),
            "admin, Radarr holds it" => (Admin, 20, true, false, grace, Ok(20), StatusStage.Looking, StatusReasonCode.Looking, false),
            "admin, Radarr can't be read" => (Admin, 20, false, true, grace, Ok(20), StatusStage.Approved, StatusReasonCode.Approved, false),
            "admin, Radarr's latest read failed (index from before)" => (Admin, 20, false, false, grace, Ok(20), StatusStage.Approved, StatusReasonCode.Approved, false),
            "admin, still waiting for an OK" => (Admin, 600, false, false, grace, new RequestFacts { AskedAt = Now.AddHours(-10), Pending = true }, StatusStage.Asked, StatusReasonCode.AwaitingApproval, false),
            "admin, declined" => (Admin, 600, false, false, grace, new RequestFacts { AskedAt = Now.AddHours(-10), Declined = true }, StatusStage.NotHere, StatusReasonCode.Declined, false),
            // Seerr hands the title to an arr Jellyfin Enhanced doesn't know: nobody can say none has it.
            "admin, no Radarr set up in Jellyfin Enhanced" => (Admin, 20, false, false, grace, Ok(20), StatusStage.Approved, StatusReasonCode.Approved, false),
            "family, OK'd 25 h ago, no Radarr set up in Jellyfin Enhanced" => (Member, 1500, false, false, grace, Ok(1500), StatusStage.Approved, StatusReasonCode.Approved, false),
            _ => throw new ArgumentOutOfRangeException(nameof(name)),
        };
    }

    [Theory]
    [MemberData(nameof(Rows))]
    public void AnOkdRequestNoArrHoldsIsReportedAfterTheGracePerRole(string scenario)
    {
        var row = Row(scenario);
        var facts = new TitleFacts(MovieKey) { Request = row.Request };
        if (row.Holds)
            facts.Copies.Add(new ArrCopyFacts(Radarr) { Movie = new ArrMovieEntry { Id = 1, TmdbId = 27205, Title = "Inception", Monitored = true, Added = Now.AddHours(-1) } });
        if (row.Unreadable) facts.Unreadable.Add(new UnreadableArr(Radarr, "Radarr (Unreachable)"));
        else if (!scenario.Contains("no Radarr set up", StringComparison.Ordinal)) facts.Checked.Add(Radarr);
        if (scenario.Contains("latest read failed", StringComparison.Ordinal)) facts.Stale.Add(Radarr);
        var c = new ComposeContext(row.Viewer, Now, 24) { HandoffGrace = row.Grace };
        var status = StatusComposer.Movie(facts, null, Array.Empty<JfCopy>(), c, detail: false);
        Assert.True((row.Stage, row.Code, row.Attention) == (status.Stage, status.Reason.Code, status.Attention), $"{scenario}: got {(status.Stage, status.Reason.Code, status.Attention)}");
        if (row.Viewer.IsAdmin)
        {
            // The admin pill line carries when Seerr OK'd it, only for this reason.
            Assert.Equal(row.Code == StatusReasonCode.ApprovedNotInArr ? Now.AddMinutes(-row.Minutes) : null, status.Admin!.ApprovedNotInArrSince);
        }
        else
        {
            Assert.Null(status.Admin);
        }
    }

    [Fact]
    public void SeriesAskedForByKeyAndRequestedSeasonsFollowTheSameRule()
    {
        var request = new RequestFacts { AskedAt = Now.AddHours(-1), ApprovedAt = Now.AddMinutes(-30) };
        var facts = new TitleFacts(ShowKey) { Request = request };
        facts.Checked.Add(new ArrConnection { Id = "6d0b7d1c-0000-4000-8000-0000000000c2", Kind = ArrKind.Sonarr, Name = "Sonarr", Url = "http://sonarr.lan:8989" });
        var admin = new ComposeContext(Admin, Now, 24) { HandoffGrace = TimeSpan.FromMinutes(15) };
        var member = new ComposeContext(Member, Now, 24) { HandoffGrace = TimeSpan.FromMinutes(15) };
        var forAdmin = StatusComposer.SeriesByKey(facts, Array.Empty<JfCopy>(), admin);
        Assert.Equal((StatusReasonCode.ApprovedNotInArr, true), (forAdmin.Reason.Code, forAdmin.Attention));
        Assert.Equal(Now.AddMinutes(-30), forAdmin.Admin!.ApprovedNotInArrSince);
        Assert.Equal(StatusReasonCode.Approved, StatusComposer.SeriesByKey(facts, Array.Empty<JfCopy>(), member).Reason.Code);
        var (seasons, _) = StatusComposer.RequestedSeasons(facts, forAdmin, new[] { 2 }, null, Array.Empty<JfCopy>(), admin);
        Assert.Equal(StatusReasonCode.ApprovedNotInArr, seasons.Reason.Code);
        Assert.NotNull(seasons.Admin!.ApprovedNotInArrSince);
    }

    [Fact]
    public void AFourKRequestIsJudgedOnTheFourKRadarrAndSaysSoInTheAdminLine()
    {
        // The standard Radarr holds the movie; the 4K Radarr (read, holding nothing) doesn't.
        var fourK = new ArrConnection { Id = "6d0b7d1c-0000-4000-8000-0000000000c3", Kind = ArrKind.Radarr, Name = "Radarr 4K", Url = "http://radarr4k.lan:7878", Role = "4k" };
        var request = new RequestFacts { AskedAt = Now.AddHours(-1), ApprovedAt = Now.AddMinutes(-30) };
        var facts = new TitleFacts(MovieKey) { Request = request };
        facts.Copies.Add(new ArrCopyFacts(Radarr) { Movie = new ArrMovieEntry { Id = 1, TmdbId = 27205, Title = "Inception", Monitored = true, HasFile = true, Added = Now.AddDays(-9) } });
        facts.Checked.Add(Radarr);
        facts.Checked.Add(fourK);
        var c = new ComposeContext(Admin, Now, 24) { HandoffGrace = TimeSpan.FromMinutes(15) };
        var whole = StatusComposer.Movie(facts, null, Array.Empty<JfCopy>(), c, detail: false);
        Assert.NotEqual(StatusReasonCode.ApprovedNotInArr, whole.Reason.Code);
        var (status, _, _) = StatusComposer.Requested4k(facts, whole, Array.Empty<JfCopy>(), c);
        Assert.Equal((StatusReasonCode.ApprovedNotInArr, true), (status.Reason.Code, status.Attention));
        Assert.Equal((Now.AddMinutes(-30), (bool?)true), (status.Admin!.ApprovedNotInArrSince, status.Admin.ApprovedNotIn4k));

        // No 4K Radarr could be read: nothing to judge on (the standard one says nothing about 4K).
        facts.Checked.Remove(fourK);
        var (unknown, _, _) = StatusComposer.Requested4k(facts, whole, Array.Empty<JfCopy>(), c);
        Assert.Equal(StatusReasonCode.Approved, unknown.Reason.Code);
        Assert.Null(unknown.Admin!.ApprovedNotInArrSince);
    }

    [Theory]
    [InlineData("the standard Radarr can't be read")]
    [InlineData("the standard Radarr's latest read failed")]
    public void AFourKRequestIsNotHeldUpByAProblemWithTheStandardRadarr(string scenario)
    {
        // The 4K Radarr was read and doesn't hold the movie; only the standard Radarr has trouble.
        var fourK = new ArrConnection { Id = "6d0b7d1c-0000-4000-8000-0000000000c3", Kind = ArrKind.Radarr, Name = "Radarr 4K", Url = "http://radarr4k.lan:7878", Role = "4k" };
        var standard = new ArrConnection { Id = Radarr.Id, Kind = ArrKind.Radarr, Name = "Radarr", Url = Radarr.Url, Role = "standard" };
        var facts = new TitleFacts(MovieKey) { Request = new RequestFacts { AskedAt = Now.AddHours(-1), ApprovedAt = Now.AddMinutes(-30) } };
        facts.Checked.Add(fourK);
        if (scenario.Contains("can't be read", StringComparison.Ordinal))
        {
            facts.Unreadable.Add(new UnreadableArr(standard, "Radarr (Unreachable)"));
        }
        else
        {
            facts.Checked.Add(standard);
            facts.Stale.Add(standard);
        }

        var c = new ComposeContext(Admin, Now, 24) { HandoffGrace = TimeSpan.FromMinutes(15) };
        var whole = StatusComposer.Movie(facts, null, Array.Empty<JfCopy>(), c, detail: false);
        var (status, _, _) = StatusComposer.Requested4k(facts, whole, Array.Empty<JfCopy>(), c);
        Assert.Equal((StatusReasonCode.ApprovedNotInArr, true), (status.Reason.Code, status.Attention));
        Assert.Equal((Now.AddMinutes(-30), (bool?)true), (status.Admin!.ApprovedNotInArrSince, status.Admin.ApprovedNotIn4k));

        // A problem with the 4K Radarr itself still holds the verdict back.
        var broken = new TitleFacts(MovieKey) { Request = facts.Request };
        broken.Checked.Add(fourK);
        broken.Stale.Add(fourK);
        var (held, _, _) = StatusComposer.Requested4k(broken, whole, Array.Empty<JfCopy>(), c);
        Assert.Equal(StatusReasonCode.Approved, held.Reason.Code);
    }

    [Fact]
    public void AScopedStatusNeverInheritsTheWholeTitlesHandoffLine()
    {
        // No Radarr holds the movie: the whole title is "OK'd, no Sonarr/Radarr has it". A 4K request
        // with no 4K Radarr set up has only the request to go by, so it can't be overdue: no line.
        var facts = new TitleFacts(MovieKey) { Request = new RequestFacts { AskedAt = Now.AddHours(-1), ApprovedAt = Now.AddMinutes(-30) } };
        facts.Checked.Add(Radarr);
        var c = new ComposeContext(Admin, Now, 24) { HandoffGrace = TimeSpan.FromMinutes(15) };
        var whole = StatusComposer.Movie(facts, null, Array.Empty<JfCopy>(), c, detail: false);
        Assert.NotNull(whole.Admin!.ApprovedNotInArrSince);
        var (only, _) = StatusComposer.RequestedOnly(whole, facts.Request, false, null);
        Assert.Equal(StatusReasonCode.Approved, only.Reason.Code);
        Assert.Null(only.Admin!.ApprovedNotInArrSince);
        Assert.Null(only.Admin.ApprovedNotIn4k);

        // A 4K request whose 4K Radarr holds the movie (looking): the whole title's line goes too.
        var fourK = new ArrConnection { Id = "6d0b7d1c-0000-4000-8000-0000000000c3", Kind = ArrKind.Radarr, Name = "Radarr 4K", Url = "http://radarr4k.lan:7878", Role = "4k" };
        var held = new TitleFacts(MovieKey) { Request = facts.Request };
        held.Checked.Add(fourK);
        held.Copies.Add(new ArrCopyFacts(fourK) { Movie = new ArrMovieEntry { Id = 1, TmdbId = 27205, Title = "Inception", Monitored = true, Added = Now.AddHours(-1) } });
        var (looking, _, _) = StatusComposer.Requested4k(held, whole, Array.Empty<JfCopy>(), c);
        Assert.NotEqual(StatusReasonCode.ApprovedNotInArr, looking.Reason.Code);
        Assert.Null(looking.Admin!.ApprovedNotInArrSince);
    }

    [Fact]
    public void TheGraceComesFromTheSettingOnlyWithPhaseTwoOn()
    {
        var config = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration { ArrIntegrationEnabled = true, ArrPhase1Enabled = true, ArrSeerrHandoffGraceMinutes = 0 };
        Assert.Null(ArrStatusService.HandoffGrace(config));
        config.ArrPhase2Enabled = true;
        Assert.Equal(TimeSpan.FromMinutes(1), ArrStatusService.HandoffGrace(config));
        config.ArrSeerrHandoffGraceMinutes = 99999;
        Assert.Equal(TimeSpan.FromMinutes(1440), ArrStatusService.HandoffGrace(config));
        config.ArrIntegrationEnabled = false;
        Assert.Null(ArrStatusService.HandoffGrace(config));
    }
}
