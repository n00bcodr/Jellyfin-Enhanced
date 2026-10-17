using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;

namespace JE.Tests;

/// <summary>
/// Phase 4b: household rules (fixed conditions per role with deterministic precedence and visible rationale), the
/// Trusted role, group quota pools and the batch preview, on the production request policy and ledger.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationHouseholdRulesTests
{
    // ------------------------------------------------------------------ fixtures

    /// <summary>TMDB answers for rule facts (a path's body; null: the read fails).</summary>
    internal sealed class FakeTmdb
    {
        public Dictionary<string, string?> Bodies { get; } = new(StringComparer.Ordinal);
        public int Reads { get; private set; }
        public bool Down { get; set; }

        public Task<string?> Get(string path, CancellationToken ct)
        {
            Reads++;
            return Task.FromResult(Down ? null : Bodies.GetValueOrDefault(path));
        }

        /// <summary>A movie with its certification per country, genres, language and services per country.</summary>
        public void Movie(int id, string language, int[] genres, Dictionary<string, string> certs, Dictionary<string, (int Id, string Name)[]>? providers = null)
        {
            Bodies["movie/" + id] = JsonSerializer.Serialize(new { id, original_language = language, genres = genres.Select(g => new { id = g, name = "g" + g }) });
            Bodies["movie/" + id + "/release_dates"] = JsonSerializer.Serialize(new
            {
                results = certs.Select(c => new { iso_3166_1 = c.Key, release_dates = new object[] { new { type = 4, certification = "" }, new { type = 3, certification = c.Value } } }),
            });
            var results = new JsonObject();
            foreach (var (country, list) in providers ?? new())
                results[country] = new JsonObject { ["flatrate"] = new JsonArray(list.Select(p => (JsonNode)new JsonObject { ["provider_id"] = p.Id, ["provider_name"] = p.Name }).ToArray()) };
            Bodies["movie/" + id + "/watch/providers"] = new JsonObject { ["results"] = results }.ToJsonString();
        }
    }

    /// <summary>US certification scores like Jellyfin's (G 0 … NC-17 17); anything else can't be scored.</summary>
    internal static int? Score(string cert, string country)
        => country != "US" ? null : cert switch { "G" => 0, "PG" => 10, "PG-13" => 13, "R" => 17, "NC-17" => 18, _ => null };

    /// <summary>The production policy over a fake Jellyfin and arr lab, with household-rule facts from <see cref="FakeTmdb"/>.</summary>
    internal sealed class Rules : IDisposable
    {
        public IntegrationRequestBackendsTests.Lab Lab { get; } = new();
        public FakeJellyfinView View { get; } = new();
        public FakeTmdb Tmdb { get; } = new();
        public HouseholdRuleFacts Facts { get; }
        public RequestPolicy Policy { get; }
        public IntegrationRequestLedgerTests.Rig Rig { get; } = new();
        public RequestService Service { get; }
        public StatusViewer Admin { get; }
        public StatusViewer Member { get; }
        public StatusViewer Kid { get; }
        public StatusViewer Trusted { get; }
        public StatusViewer Manager { get; }
        public PluginConfiguration Config => Lab.Config;
        public DateTimeOffset Now { get => Rig.Now; set => Rig.Now = value; }

        public Rules()
        {
            Admin = View.AddUser(true);
            Member = View.AddUser(false);
            Kid = View.AddUser(false);
            Trusted = View.AddUser(false);
            Manager = View.AddUser(false);
            Config.ArrRequestDefaultRole = "Member";
            Config.ArrRequestQuotaLimit = 7;
            Config.ArrRequestPreset = "ask_first";
            Config.ArrPhase4Enabled = true;
            Config.ArrPhase4HouseholdRulesEnabled = true;
            Config.ArrHouseholdRules = string.Empty;
            Config.ArrGroupQuotaPools = string.Empty;
            Config.ArrHouseholdStreamingCountry = string.Empty;
            Config.ArrHouseholdStreamingServices = string.Empty;
            Config.ArrPhase4GroupQuotasEnabled = false;
            Config.ArrRequestUsers = JsonSerializer.Serialize(new Dictionary<string, object>
            {
                [Kid.UserId.ToString("N")] = new { Role = "Kid" },
                [Trusted.UserId.ToString("N")] = new { Role = "Trusted" },
                [Manager.UserId.ToString("N")] = new { Role = "Manager" },
            });
            Facts = new HouseholdRuleFacts((t, _) => Task.FromResult(t.Provider == "tmdb" ? t.NumericId : null), Tmdb.Get, Score, () => Rig.Now);
            Policy = new RequestPolicy(View, Lab.Store, new ArrInstanceLibraries(Lab.Store, new FakeLibraryAccess()), new TitleAliases(Lab.Store, null), null!, Lab.Arr.Factory, new UnavailableRequestBackend(), Facts);
            Service = new RequestService(Rig.Ledger, Policy, View, Rig.Feed, () => Rig.Now);
        }

        public void Set(object rules) => Config.ArrHouseholdRules = JsonSerializer.Serialize(rules);

        /// <summary>The outbox over the production policy and a backend that confirms every send.</summary>
        public RequestOutbox Runner() => new(Rig.Ledger, Policy, Rig.Backend, new RequestTitleLocks(), Rig.Feed, Rig.Audit, () => Rig.Now);

        public Task<RequestOutcome> Ask(StatusViewer who, int movie = 603, string? client = null, string variant = "standard")
            => Service.CreateAsync(who.UserId, new CreateRequest(client ?? Guid.NewGuid().ToString("N"), new MutationInput { Key = "movie:tmdb:" + movie, Variant = variant }), default);

        public RequestWant Want(RequestOutcome outcome) => Rig.Ledger.Find(outcome.RequestId!)!;

        public void Dispose()
        {
            Config.ArrPhase4Enabled = false;
            Config.ArrPhase4HouseholdRulesEnabled = false;
            Config.ArrPhase4GroupQuotasEnabled = false;
            Config.ArrHouseholdRules = string.Empty;
            Config.ArrGroupQuotaPools = string.Empty;
            Config.ArrHouseholdStreamingCountry = string.Empty;
            Config.ArrHouseholdStreamingServices = string.Empty;
            Rig.Dispose();
            Lab.Dispose();
        }
    }

    private static readonly Dictionary<string, string> Pg13 = new() { ["US"] = "PG-13" };
    private static readonly Dictionary<string, string> R = new() { ["US"] = "R" };

    // ------------------------------------------------------------------ switches and the Trusted role

    [Fact]
    public void EveryPhase4bSwitchIsOffByDefaultAndEachNeedsItsParents()
    {
        var fresh = new PluginConfiguration();
        Assert.False(fresh.ArrPhase4HouseholdRulesEnabled);
        Assert.False(fresh.ArrPhase4GroupQuotasEnabled);
        Assert.False(fresh.ArrPhase4SeerrRequestOptionsEnabled);
        Assert.Equal(string.Empty, fresh.ArrHouseholdRules + fresh.ArrGroupQuotaPools + fresh.ArrHouseholdStreamingCountry + fresh.ArrHouseholdStreamingServices);
        // Serialization defaults: an XML without the fields reads them as off/empty.
        var xml = new System.Xml.Serialization.XmlSerializer(typeof(PluginConfiguration));
        using var reader = new StringReader("<PluginConfiguration />");
        var read = (PluginConfiguration)xml.Deserialize(reader)!;
        Assert.False(read.ArrPhase4HouseholdRulesEnabled || read.ArrPhase4GroupQuotasEnabled || read.ArrPhase4SeerrRequestOptionsEnabled);

        var on = new PluginConfiguration { ArrIntegrationEnabled = true, ArrPhase1Enabled = true, ArrPhase3Enabled = true, ArrPhase4Enabled = true, ArrPhase4HouseholdRulesEnabled = true, ArrPhase4GroupQuotasEnabled = true, ArrPhase4SeerrRequestOptionsEnabled = true, ArrRequestBackend = "je" };
        Assert.True(HouseholdFlags.Rules(on) && HouseholdFlags.RulesApply(on) && HouseholdFlags.Pools(on) && HouseholdFlags.SeerrOptions(on));
        foreach (var off in new Action<PluginConfiguration>[] { c => c.ArrIntegrationEnabled = false, c => c.ArrPhase1Enabled = false, c => c.ArrPhase3Enabled = false, c => c.ArrPhase4Enabled = false })
        {
            var copy = Clone(on);
            off(copy);
            Assert.False(HouseholdFlags.Rules(copy) || HouseholdFlags.Pools(copy) || HouseholdFlags.SeerrOptions(copy));
        }
        var rulesOff = Clone(on); rulesOff.ArrPhase4HouseholdRulesEnabled = false;
        Assert.False(HouseholdFlags.Pools(rulesOff));
        Assert.True(HouseholdFlags.SeerrOptions(rulesOff));   // the JE-only rule switches are not its parents
        var seerr = Clone(on); seerr.ArrRequestBackend = "seerr";
        Assert.True(HouseholdFlags.Rules(seerr));
        Assert.False(HouseholdFlags.RulesApply(seerr) || HouseholdFlags.Pools(seerr));
    }

    private static PluginConfiguration Clone(PluginConfiguration c)
    {
        var xml = new System.Xml.Serialization.XmlSerializer(typeof(PluginConfiguration));
        using var writer = new StringWriter();
        xml.Serialize(writer, c);
        using var reader = new StringReader(writer.ToString());
        return (PluginConfiguration)xml.Deserialize(reader)!;
    }

    [Fact]
    public async Task TrustedCountsOnlyWithHouseholdRulesOnAndAsksWithoutAnOkButGainsNoManagerPowers()
    {
        using var r = new Rules();
        r.Config.ArrRequestPreset = "approve_everything";
        // Off: a stored Trusted is a Member, as before the role existed (asks wait under approve everything).
        r.Config.ArrPhase4HouseholdRulesEnabled = false;
        Assert.Equal("Member", r.Service.Identity(r.Trusted.UserId).Role);
        Assert.False(new HouseholdTrust(() => r.Config).IsTrusted(r.Trusted.UserId));
        Assert.Equal("pending", r.Want(await r.Ask(r.Trusted, 1)).Status);
        // On: Trusted asks go ahead in every preset, with no allowance limit; no approval, household or 4K power.
        r.Config.ArrPhase4HouseholdRulesEnabled = true;
        var facts = r.Service.Identity(r.Trusted.UserId);
        Assert.Equal("Trusted", facts.Role);
        Assert.Null(facts.Limit);
        Assert.False(facts.CanApprove);
        Assert.False(facts.Can4k);
        Assert.True(new HouseholdTrust(() => r.Config).IsTrusted(r.Trusted.UserId));
        Assert.False(new HouseholdTrust(() => r.Config).IsTrusted(r.Manager.UserId));
        Assert.False(new HouseholdTrust(() => r.Config).IsTrusted(r.Member.UserId));
        var ask = await r.Ask(r.Trusted, 2);
        Assert.Equal(("queued", "queued_outage"), (r.Want(ask).Status, r.Want(ask).Reason));
        Assert.Equal("trusted", r.Service.Me(r.Trusted.UserId).Role);
        Assert.False(r.Service.Me(r.Trusted.UserId).CanApprove);
        // The Requests page's household routes stay Manager/Admin only.
        var hub = new AcquireRequestsController(r.Service) { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
        hub.HttpContext.User = TestCallers.Principal(r.Trusted.UserId, false);
        var approvals = Assert.IsType<ObjectResult>(await hub.List("pending", default));
        Assert.Equal(403, approvals.StatusCode);
    }

    [Fact]
    public async Task UnderTheEngineTrustedAutomaticAsksGoAheadAndMembersAndKidsStillWait()
    {
        using var r = new Rules();
        var eligibility = new AutomationEligibility(new AutomationStore(r.Rig.Db), new HouseholdTrust(() => r.Config));
        Assert.Equal("trusted", eligibility.Why(r.Trusted.UserId, r.Service.Identity(r.Trusted.UserId).Role));
        Assert.Null(eligibility.Why(r.Member.UserId, "Member"));
        Assert.Null(eligibility.Why(r.Manager.UserId, "Manager"));   // Manager status alone grants no eligibility
        Assert.Null(eligibility.Why(r.Kid.UserId, "Kid"));
        // The ledger: a Trusted person's automatic ask goes ahead, a Member's waits for an OK.
        var trusted = await r.Service.CreateAsync(r.Trusted.UserId, new CreateRequest("auto-t", new MutationInput { Key = "movie:tmdb:900" }), default, RequestOrigin.Automation(AutomationRecipes.AutoMovie));
        var member = await r.Service.CreateAsync(r.Member.UserId, new CreateRequest("auto-m", new MutationInput { Key = "movie:tmdb:901" }), default, RequestOrigin.Automation(AutomationRecipes.AutoMovie));
        Assert.Equal("queued", r.Want(trusted).Status);
        Assert.Equal("pending", r.Want(member).Status);
        // Household rules off: the stored Trusted is a Member again, and not eligible.
        r.Config.ArrPhase4HouseholdRulesEnabled = false;
        Assert.Null(eligibility.Why(r.Trusted.UserId, r.Service.Identity(r.Trusted.UserId).Role));
    }

    [Fact]
    public async Task SameAccessDifferentRoleBodiesHaveDifferentEtags()
    {
        using var r = new Rules();
        var member = r.Service.List(r.Member.UserId, false);
        var trusted = r.Service.List(r.Trusted.UserId, false);
        Assert.NotEqual(member.ETag, trusted.ETag);
        r.Config.ArrRequestUsers = JsonSerializer.Serialize(new Dictionary<string, object> { [r.Member.UserId.ToString("N")] = new { Role = "Trusted" } });
        Assert.NotEqual(member.ETag, r.Service.List(r.Member.UserId, false).ETag);
        await Task.CompletedTask;
    }

    // ------------------------------------------------------------------ conditions

    [Fact]
    public void ConditionsMatchFailOrAreUnknownAndCombineDenyReviewApproveNone()
    {
        var facts = new RuleFactSet(1, new Dictionary<string, string> { ["US"] = "PG-13" }, new[] { 27, 53 }, "ko",
            new Dictionary<string, IReadOnlyList<RuleProvider>> { ["GB"] = new[] { new RuleProvider(8, "Netflix") } }, DateTimeOffset.UnixEpoch);
        var none = new HashSet<int>();
        HouseholdRuleVerdict Eval(HouseholdRoleRules rules, RuleFactSet? f = null, double gb = 8, string? country = null, IReadOnlySet<int>? services = null)
            => HouseholdRules.Evaluate(rules, "v", f, gb, country, services ?? none, Score);

        // Rating: within the limit matches; above doesn't; unrated or unscorable is unknown (a look).
        var rating = new HouseholdRoleRules { Rating = new HouseholdRatingRule { Max = "PG-13", Country = "US", Match = "approve", Otherwise = "deny" } };
        Assert.Equal("approve", Eval(rating, facts).Verdict);
        Assert.Equal("deny", Eval(rating with { Rating = rating.Rating! with { Max = "PG" } }, facts).Verdict);
        Assert.Equal("review", Eval(rating, facts with { Certifications = new Dictionary<string, string>() }).Verdict);
        Assert.Equal("review", Eval(rating, null).Verdict);
        Assert.Equal("review", Eval(rating with { Rating = rating.Rating! with { Country = "GB" } }, facts).Verdict);
        var hit = Assert.Single(Eval(rating with { Rating = rating.Rating! with { Max = "PG" } }, facts).Hits);
        Assert.Equal(("rating", "deny", (bool?)false, "PG-13", "PG"), (hit.Condition, hit.Action, hit.Matched, hit.Value, hit.Limit));

        // Genre, language, size.
        Assert.Equal("review", Eval(new HouseholdRoleRules { Genre = new HouseholdGenreRule { Ids = new[] { 27 }, Match = "review" } }, facts).Verdict);
        Assert.Equal("none", Eval(new HouseholdRoleRules { Genre = new HouseholdGenreRule { Ids = new[] { 16 }, Match = "review" } }, facts).Verdict);
        Assert.Equal("review", Eval(new HouseholdRoleRules { Genre = new HouseholdGenreRule { Ids = new[] { 16 }, Match = "review" } }, facts with { Genres = null }).Verdict);
        Assert.Equal("deny", Eval(new HouseholdRoleRules { Language = new HouseholdLanguageRule { Codes = new[] { "en" }, Otherwise = "deny" } }, facts).Verdict);
        Assert.Equal("none", Eval(new HouseholdRoleRules { Language = new HouseholdLanguageRule { Codes = new[] { "ko" }, Otherwise = "deny" } }, facts).Verdict);
        var size = new HouseholdRoleRules { Size = new HouseholdSizeRule { MaxGb = 20, Match = "approve", Otherwise = "review" } };
        Assert.Equal("approve", Eval(size, null, 8).Verdict);        // size needs no title facts
        Assert.Equal("review", Eval(size, null, 40).Verdict);

        // Streaming: inactive until the household country and services are set; then matched against that country.
        var streaming = new HouseholdRoleRules { Streaming = new HouseholdStreamingRule { Match = "deny" } };
        Assert.Equal("none", Eval(streaming, facts).Verdict);
        Assert.Equal("none", Eval(streaming, facts, country: "GB").Verdict);
        Assert.Equal("deny", Eval(streaming, facts, country: "GB", services: new HashSet<int> { 8 }).Verdict);
        Assert.Equal("Netflix", Eval(streaming, facts, country: "GB", services: new HashSet<int> { 8 }).Hits.Single().Value);
        Assert.Equal("none", Eval(streaming, facts, country: "US", services: new HashSet<int> { 8 }).Verdict);
        Assert.Equal("review", Eval(streaming, facts with { Providers = null }, country: "GB", services: new HashSet<int> { 8 }).Verdict);

        // Precedence: deny > review (incl. unknown) > approve > none.
        var all = new HouseholdRoleRules
        {
            Rating = new HouseholdRatingRule { Max = "R", Country = "US", Match = "approve" },
            Genre = new HouseholdGenreRule { Ids = new[] { 27 }, Match = "review" },
            Language = new HouseholdLanguageRule { Codes = new[] { "ko" }, Match = "deny" },
        };
        Assert.Equal("deny", Eval(all, facts).Verdict);
        Assert.Equal("review", Eval(all with { Language = null }, facts).Verdict);
        Assert.Equal("approve", Eval(all with { Language = null, Genre = null }, facts).Verdict);
        Assert.Equal(3, Eval(all, facts).Hits.Count);
    }

    [Fact]
    public void RuleSetsAreValidatedAndStoredCanonically()
    {
        Assert.Null(HouseholdRules.Validate(new HouseholdRuleSet()));
        HouseholdRuleSet Set(string role, HouseholdRoleRules rules) => new() { Roles = new(StringComparer.OrdinalIgnoreCase) { [role] = rules } };
        Assert.Equal("invalid_role", HouseholdRules.Validate(Set("manager", new HouseholdRoleRules())));
        Assert.Equal("invalid_role", HouseholdRules.Validate(Set("admin", new HouseholdRoleRules())));
        Assert.Equal("invalid_action", HouseholdRules.Validate(Set("kid", new HouseholdRoleRules { Size = new HouseholdSizeRule { MaxGb = 5, Match = "allow" } })));
        Assert.Equal("invalid_rating", HouseholdRules.Validate(Set("kid", new HouseholdRoleRules { Rating = new HouseholdRatingRule { Max = "", Match = "deny" } })));
        Assert.Equal("invalid_rating", HouseholdRules.Validate(Set("kid", new HouseholdRoleRules { Rating = new HouseholdRatingRule { Max = "PG", Country = "usa", Match = "deny" } })));
        Assert.Equal("invalid_genre", HouseholdRules.Validate(Set("kid", new HouseholdRoleRules { Genre = new HouseholdGenreRule { Ids = new[] { 999999 }, Match = "deny" } })));
        Assert.Equal("invalid_genre", HouseholdRules.Validate(Set("kid", new HouseholdRoleRules { Genre = new HouseholdGenreRule { Ids = Array.Empty<int>(), Match = "deny" } })));
        Assert.Equal("invalid_language", HouseholdRules.Validate(Set("kid", new HouseholdRoleRules { Language = new HouseholdLanguageRule { Codes = new[] { "EN" }, Match = "deny" } })));
        Assert.Equal("invalid_size", HouseholdRules.Validate(Set("kid", new HouseholdRoleRules { Size = new HouseholdSizeRule { MaxGb = 0, Match = "deny" } })));
        var valid = Set("Member", new HouseholdRoleRules { Genre = new HouseholdGenreRule { Ids = new[] { 53, 27, 27 }, Match = "review" }, Rating = new HouseholdRatingRule { Max = " PG ", Country = "US", Match = "approve" } });
        Assert.Null(HouseholdRules.Validate(valid));
        var stored = HouseholdRules.Store(valid);
        Assert.Contains("\"member\"", stored);
        var parsed = HouseholdRules.Parse(stored);
        Assert.Equal(new[] { 27, 53 }, parsed.For("Member")!.Genre!.Ids);
        Assert.Equal("PG", parsed.For("member")!.Rating!.Max);
        Assert.Null(parsed.For("Manager"));
        // Unreadable or invalid stored rules apply as none (never a guess).
        Assert.Empty(HouseholdRules.Parse("{not json").Roles);
        Assert.Empty(HouseholdRules.Parse("{\"roles\":{\"admin\":{}}}").Roles);
    }

    [Fact]
    public void TmdbFactsAreReadAsCertificationsGenresLanguageAndServices()
    {
        var certs = HouseholdRuleFacts.Certifications("{\"results\":[{\"iso_3166_1\":\"US\",\"release_dates\":[{\"type\":1,\"certification\":\"PG\"},{\"type\":3,\"certification\":\"R\"}]},{\"iso_3166_1\":\"GB\",\"release_dates\":[{\"type\":3,\"certification\":\"\"}]}]}", true)!;
        Assert.Equal("R", certs["US"]);           // the theatrical certification first
        Assert.False(certs.ContainsKey("GB"));    // unrated there
        Assert.Equal("TV-14", HouseholdRuleFacts.Certifications("{\"results\":[{\"iso_3166_1\":\"US\",\"rating\":\"TV-14\"}]}", false)!["US"]);
        Assert.Null(HouseholdRuleFacts.Certifications("not json", true));
        var (genres, language) = HouseholdRuleFacts.Details("{\"original_language\":\"JA\",\"genres\":[{\"id\":16},{\"id\":10751}]}");
        Assert.Equal(new[] { 16, 10751 }, genres);
        Assert.Equal("ja", language);
        var providers = HouseholdRuleFacts.Providers("{\"results\":{\"GB\":{\"flatrate\":[{\"provider_id\":8,\"provider_name\":\"Netflix\"}],\"rent\":[{\"provider_id\":2,\"provider_name\":\"Apple\"}],\"free\":[{\"provider_id\":8,\"provider_name\":\"Netflix\"}]}}}")!;
        Assert.Equal(new[] { 8 }, providers["GB"].Select(p => p.Id));   // rentals aren't "already on a service"
    }

    [Fact]
    public async Task FactsAreCachedAndAfterTheirWindowAFailedRefreshLeavesThemUnknownUntilARefreshSucceeds()
    {
        var tmdb = new FakeTmdb();
        tmdb.Movie(603, "en", new[] { 28 }, R);
        var now = new DateTimeOffset(2026, 10, 17, 0, 0, 0, TimeSpan.Zero);
        var facts = new HouseholdRuleFacts((t, _) => Task.FromResult(t.NumericId), tmdb.Get, Score, () => now);
        var key = TitleKey.Parse("movie:tmdb:603")!;
        await facts.PrepareAsync(key, default);
        var first = facts.Peek(key)!;
        Assert.Equal("R", first.Certification("us"));
        var reads = tmdb.Reads;
        await facts.PrepareAsync(key, default);
        Assert.Equal(reads, tmdb.Reads);                         // fresh: no second read
        now = now.Add(HouseholdRuleFacts.FreshFor).AddMinutes(-1);
        Assert.Equal(first.Version, facts.Peek(key)!.Version);   // still within the window
        now = now.AddMinutes(2);
        Assert.Null(facts.Peek(key));                            // past it: not known to the rules, whatever was read
        tmdb.Down = true;
        await facts.PrepareAsync(key, default);
        Assert.Null(facts.Peek(key));                            // a failed refresh never makes the old facts count again
        reads = tmdb.Reads;
        now = now.AddMinutes(1);
        await facts.PrepareAsync(key, default);
        Assert.Equal(reads, tmdb.Reads);                         // retried only after the failure wait
        Assert.Null(facts.Peek(key));
        now = now.Add(HouseholdRuleFacts.FailedFor);
        await facts.PrepareAsync(key, default);
        Assert.True(tmdb.Reads > reads);
        Assert.Null(facts.Peek(key));
        tmdb.Down = false;
        tmdb.Movie(603, "en", new[] { 28 }, Pg13);
        now = now.Add(HouseholdRuleFacts.FailedFor).AddSeconds(1);
        await facts.PrepareAsync(key, default);
        Assert.Equal("PG-13", facts.Peek(key)!.Certification("US")); // a successful read counts again
        now = now.Add(HouseholdRuleFacts.FreshFor).AddMinutes(1);
        tmdb.Down = true;
        // A title never read with TMDB down: unknown, tried again after the short failure wait.
        var other = TitleKey.Parse("movie:tmdb:604")!;
        await facts.PrepareAsync(other, default);
        Assert.True(facts.Peek(other)!.Failed);
        tmdb.Down = false;
        tmdb.Movie(604, "fr", new[] { 18 }, Pg13);
        await facts.PrepareAsync(other, default);
        Assert.True(facts.Peek(other)!.Failed);
        now = now.Add(HouseholdRuleFacts.FailedFor).AddSeconds(1);
        await facts.PrepareAsync(other, default);
        Assert.Equal("fr", facts.Peek(other)!.OriginalLanguage);
    }

    [Fact]
    public async Task ARuleDenyRefusesWithItsRationaleAndWritesNothing()
    {
        using var r = new Rules();
        r.Tmdb.Movie(603, "en", new[] { 27 }, R);
        r.Set(new { roles = new { member = new { rating = new { max = "PG-13", country = "US", match = "none", otherwise = "deny" } } } });
        var refused = await r.Ask(r.Member);
        Assert.Equal((403, "household_rule", "denied"), (refused.HttpStatus, refused.Reason, refused.Outcome));
        Assert.Equal("deny", refused.Rules!.Verdict);
        Assert.Equal(("R", "PG-13"), (refused.Rules.Hits.Single().Value, refused.Rules.Hits.Single().Limit));
        Assert.Contains("rating R", refused.Message);
        Assert.Empty(r.Rig.Ledger.ForTitle("movie:tmdb:603"));
        // A Manager is not ruled; once someone asked, the denied role can't follow it either (pending or on its way).
        var manager = await r.Ask(r.Manager);
        Assert.Equal(201, manager.HttpStatus);
        Assert.Equal("household_rule", (await r.Ask(r.Member)).Reason);
        var kid = r.View.AddUser(false);
        r.Set(new { roles = new { member = new { rating = new { max = "PG-13", country = "US", match = "none", otherwise = "review" } }, kid = new { rating = new { max = "PG", country = "US", match = "none", otherwise = "deny" } } } });
        r.Config.ArrRequestUsers = JsonSerializer.Serialize(new Dictionary<string, object> { [kid.UserId.ToString("N")] = new { Role = "Kid" }, [r.Manager.UserId.ToString("N")] = new { Role = "Manager" } });
        r.Tmdb.Movie(610, "en", new[] { 27 }, R);
        Assert.Equal("rule_review", r.Want(await r.Ask(r.Member, 610)).Reason);
        Assert.Equal("household_rule", (await r.Ask(kid, 610)).Reason);   // not a free follower of the pending ask
        Assert.Single(r.Rig.Ledger.ForTitle("movie:tmdb:610"));
    }

    [Fact]
    public async Task AReviewWaitsForAnOkWithItsRationaleAndAnApprovalSendsIt()
    {
        using var r = new Rules();
        r.Tmdb.Movie(603, "en", new[] { 27 }, R);
        r.Set(new { roles = new { trusted = new { genre = new { ids = new[] { 27 }, match = "review", otherwise = "none" } } } });
        var ask = await r.Ask(r.Trusted);
        var want = r.Want(ask);
        Assert.Equal(("pending", "rule_review"), (want.Status, want.Reason));
        Assert.Equal("review", ask.Rules!.Verdict);
        Assert.Equal("review", want.Rules!.Verdict);
        Assert.Equal("27", want.Rules.Hits.Single().Value);
        Assert.Empty(r.Rig.Ledger.Due(r.Now));
        var ok = await r.Service.ApproveAsync(want.Id, r.Admin.UserId, null, default);
        Assert.Equal(200, ok.HttpStatus);
        Assert.Single(r.Rig.Ledger.Due(r.Now));
    }

    [Fact]
    public async Task UnknownFactsAreALookNeverAGuessedMatch()
    {
        using var r = new Rules();
        r.Tmdb.Down = true;
        r.Set(new { roles = new { member = new { rating = new { max = "PG-13", country = "US", match = "approve", otherwise = "deny" } } } });
        var ask = await r.Ask(r.Member);
        Assert.Equal(("pending", "rule_review"), (r.Want(ask).Status, r.Want(ask).Reason));
        Assert.Null(ask.Rules!.Hits.Single().Matched);
    }

    [Fact]
    public async Task AnApproveLiftsOnlyAMembersBlanketPresetNeverAKidsOkQuotaOrPool()
    {
        using var r = new Rules();
        r.Config.ArrRequestPreset = "approve_everything";
        r.Tmdb.Movie(603, "en", new[] { 16 }, new() { ["US"] = "G" });
        r.Tmdb.Movie(604, "en", new[] { 16 }, R);
        r.Set(new { roles = new { member = new { rating = new { max = "PG", country = "US", match = "approve", otherwise = "none" } }, kid = new { rating = new { max = "PG", country = "US", match = "approve", otherwise = "none" } } } });
        Assert.Equal("queued", r.Want(await r.Ask(r.Member, 603)).Status);
        var held = r.Want(await r.Ask(r.Member, 604));
        Assert.Equal(("pending", "awaiting_approval"), (held.Status, held.Reason));
        r.Tmdb.Movie(607, "en", new[] { 16 }, new() { ["US"] = "G" });
        Assert.Equal("pending", r.Want(await r.Ask(r.Kid, 607)).Status);   // Kids always wait (D15)
        // Over the person's own allowance an approve doesn't skip the OK either.
        r.Config.ArrRequestPreset = "ask_first";
        r.Config.ArrRequestQuotaLimit = 1;
        r.Tmdb.Movie(605, "en", new[] { 16 }, new() { ["US"] = "G" });
        var over = await r.Ask(r.Member, 605);
        Assert.Equal(("pending", "over_quota"), (r.Want(over).Status, r.Want(over).Reason));
    }

    [Fact]
    public async Task RulesNeverApplyInSeerrModeOrForManagersAndAdmins()
    {
        using var r = new Rules();
        r.Tmdb.Movie(603, "en", new[] { 27 }, R);
        r.Set(new { roles = new { member = new { genre = new { ids = new[] { 27 }, match = "deny", otherwise = "none" } } } });
        Assert.NotNull(r.Policy.Evaluate(r.Member.UserId, new MutationInput { Key = "movie:tmdb:603" }).Rules);
        Assert.Null(r.Policy.Evaluate(r.Manager.UserId, new MutationInput { Key = "movie:tmdb:603" }).Rules);
        Assert.Null(r.Policy.Evaluate(r.Admin.UserId, new MutationInput { Key = "movie:tmdb:603" }).Rules);
        r.Config.ArrRequestBackend = "seerr";
        Assert.Null(r.Policy.Evaluate(r.Member.UserId, new MutationInput { Key = "movie:tmdb:603" }).Rules);
        r.Config.ArrRequestBackend = "je";
        r.Config.ArrPhase4HouseholdRulesEnabled = false;
        Assert.Null(r.Policy.Evaluate(r.Member.UserId, new MutationInput { Key = "movie:tmdb:603" }).Rules);
        // Off: exactly the presets (an ask goes ahead in Ask first), and no facts are read.
        var reads = r.Tmdb.Reads;
        Assert.Equal("queued", r.Want(await r.Ask(r.Member)).Status);
        Assert.Equal(reads, r.Tmdb.Reads);
    }

    [Fact]
    public async Task ARuleOrRatingChangedBetweenQueueAndSendHoldsTheRequestForAnOk()
    {
        using var r = new Rules();
        r.Tmdb.Movie(603, "en", new[] { 27 }, R);
        r.Set(new { roles = new { member = new { size = new { maxGb = 100, match = "approve", otherwise = "review" } } } });
        var ask = await r.Ask(r.Member);
        Assert.Equal("queued", r.Want(ask).Status);
        // Before it goes out the household now denies horror: it is held with that reason, nothing sent.
        r.Set(new { roles = new { member = new { genre = new { ids = new[] { 27 }, match = "deny", otherwise = "none" } } } });
        await r.Runner().TickAsync(default);
        Assert.Equal(0, r.Rig.Backend.Sends);
        var held = r.Want(ask);
        Assert.Equal(("pending", "household_rule"), (held.Status, held.Reason));
        // An approval is a person's decision: it overrides the soft rules (never the mandatory gates) and it goes.
        Assert.Equal(200, (await r.Service.ApproveAsync(held.Id, r.Admin.UserId, null, default)).HttpStatus);
        var job = Assert.Single(r.Rig.Ledger.Due(r.Now));
        Assert.Null(r.Rig.Ledger.ApprovalNeededAtSend(job, r.Policy.Evaluate(r.Member.UserId, job.Input), r.Policy, r.Now));
        // A queued request whose title's rating changed (read again once the facts expired) waits for a look.
        r.Set(new { roles = new { member = new { rating = new { max = "PG-13", country = "US", match = "approve", otherwise = "review" } } } });
        r.Tmdb.Movie(606, "en", new[] { 18 }, Pg13);
        var second = await r.Ask(r.Member, 606);
        Assert.Equal("queued", r.Want(second).Status);
        var secondJob = r.Rig.Ledger.ForWant(second.RequestId!).Single();
        r.Tmdb.Movie(606, "en", new[] { 18 }, R);
        r.Now = r.Now.Add(HouseholdRuleFacts.FreshFor).AddMinutes(1);
        await r.Facts.PrepareAsync(TitleKey.Parse("movie:tmdb:606")!, default);
        Assert.Equal("R", r.Facts.Peek(TitleKey.Parse("movie:tmdb:606")!)!.Certification("US"));
        Assert.Equal("rule_review", r.Rig.Ledger.ApprovalNeededAtSend(secondJob, r.Policy.Evaluate(r.Member.UserId, secondJob.Input), r.Policy, r.Now));
    }

    [Fact]
    public async Task ExpiredPermissiveFactsAreNotKnownDuringATmdbOutageAtTheAskAndAtTheSendGuard()
    {
        using var r = new Rules();
        r.Config.ArrRequestPreset = "approve_everything";
        // A Member's blanket preset is lifted only by an approve rule; a Trusted person is refused above PG-13.
        r.Set(new
        {
            roles = new
            {
                member = new { rating = new { max = "PG-13", country = "US", match = "approve", otherwise = "review" } },
                trusted = new { rating = new { max = "PG-13", country = "US", match = "none", otherwise = "deny" } },
            },
        });
        r.Tmdb.Movie(606, "en", new[] { 18 }, Pg13);
        r.Tmdb.Movie(607, "en", new[] { 18 }, Pg13);
        r.Tmdb.Movie(608, "en", new[] { 18 }, Pg13);
        r.Tmdb.Movie(609, "en", new[] { 18 }, Pg13);
        var queued = await r.Ask(r.Member, 606);
        Assert.Equal("queued", r.Want(queued).Status);
        Assert.Equal("queued", r.Want(await r.Ask(r.Trusted, 607)).Status);
        Assert.Equal(0, r.Rig.Backend.Sends);
        // Two more titles are read as PG-13 (shown in a sheet, say) but not asked for yet.
        await r.Facts.PrepareAsync(TitleKey.Parse("movie:tmdb:608")!, default);
        await r.Facts.PrepareAsync(TitleKey.Parse("movie:tmdb:609")!, default);
        // TMDB goes down (the titles' answers would now be R) and the facts' window passes before anything is sent.
        foreach (var id in new[] { 606, 607, 608, 609 }) r.Tmdb.Movie(id, "en", new[] { 18 }, R);
        r.Tmdb.Down = true;
        r.Now = r.Now.Add(HouseholdRuleFacts.FreshFor).AddMinutes(1);
        // The send guard reads again, fails and holds both for a look instead of trusting the old PG-13.
        await r.Runner().TickAsync(default);
        Assert.Equal(0, r.Rig.Backend.Sends);
        Assert.Equal(("pending", "rule_review"), (r.Want(queued).Status, r.Want(queued).Reason));
        Assert.All(r.Rig.Ledger.List(r.Trusted.UserId, false), w => Assert.Equal(("pending", "rule_review"), (w.Status, w.Reason)));
        // The card says why: the rating isn't known now (not the PG-13 it was asked with), after a restart too.
        var directory = new IntegrationRequestHouseholdTests.FakeDirectory();
        directory.People[r.Member.UserId] = new HouseholdPerson { Id = r.Member.UserId, Name = "Sam", IsAdmin = false };
        async Task<JsonNode> HeldCard(RequestService service)
        {
            var projection = new RequestHubProjection(service, directory, null, (_, _, _) => Task.FromResult<HubTitleMeta?>(null), () => r.Now);
            return JsonNode.Parse((await projection.MineAsync(r.View.Viewer(r.Member.UserId)!, default)).Json)!["items"]!.AsArray().Single(i => (string)i!["key"]! == "movie:tmdb:606")!;
        }
        Assert.Null((bool?)(await HeldCard(r.Service))["rules"]!["hits"]![0]!["matched"]);
        var fresh = new HouseholdRuleFacts((t, _) => Task.FromResult(t.NumericId), (_, _) => Task.FromResult<string?>(null), Score, () => r.Now);
        var restarted = new RequestService(r.Rig.Ledger, new RequestPolicy(r.View, r.Lab.Store, new ArrInstanceLibraries(r.Lab.Store, new FakeLibraryAccess()), new TitleAliases(r.Lab.Store, null), null!, r.Lab.Arr.Factory, new UnavailableRequestBackend(), fresh), r.View, r.Rig.Feed, () => r.Now);
        var afterRestart = await HeldCard(restarted);
        Assert.Equal("review", (string)afterRestart["rules"]!["verdict"]!);
        Assert.Null((bool?)afterRestart["rules"]!["hits"]![0]!["matched"]);
        // A new ask for a title last read as PG-13 waits too (Member and Trusted alike), with the rating unknown.
        var member = await r.Ask(r.Member, 608);
        var trusted = await r.Ask(r.Trusted, 609);
        Assert.Equal(("pending", "rule_review"), (r.Want(member).Status, r.Want(member).Reason));
        Assert.Equal(("pending", "rule_review"), (r.Want(trusted).Status, r.Want(trusted).Reason));
        Assert.Null(member.Rules!.Hits.Single().Matched);
        // TMDB back: the next read decides on the real answer (R: a Trusted ask for it is refused).
        r.Tmdb.Down = false;
        r.Now = r.Now.Add(HouseholdRuleFacts.FailedFor).AddSeconds(1);
        var refused = await r.Ask(r.Trusted, 608);
        Assert.Equal((403, "household_rule"), (refused.HttpStatus, refused.Reason));
        Assert.Equal("R", r.Facts.Peek(TitleKey.Parse("movie:tmdb:608")!)!.Certification("US"));
    }

    [Fact]
    public async Task ALaterApprovedExcessNeverHoldsAnEarlierAskThatWasWithinTheAllowance()
    {
        using var r = new Rules();
        r.Config.ArrPhase4HouseholdRulesEnabled = false;
        r.Config.ArrRequestQuotaLimit = 2;
        var first = await r.Ask(r.Member, 1);
        r.Now = r.Now.AddMinutes(1);
        var second = await r.Ask(r.Member, 2);
        r.Now = r.Now.AddMinutes(1);
        var third = await r.Ask(r.Member, 3);
        Assert.Equal(("queued", "queued", "pending"), (r.Want(first).Status, r.Want(second).Status, r.Want(third).Status));
        r.Now = r.Now.AddMinutes(1);
        Assert.Equal(200, (await r.Service.ApproveAsync(third.RequestId!, r.Admin.UserId, null, default)).HttpStatus);
        Assert.Equal(3, r.Service.Quota(r.Member.UserId).Used);
        foreach (var id in new[] { first.RequestId!, second.RequestId!, third.RequestId! })
        {
            var job = r.Rig.Ledger.ForWant(id).Single();
            Assert.Null(r.Rig.Ledger.ApprovalNeededAtSend(job, r.Policy.Evaluate(r.Member.UserId, job.Input), r.Policy, r.Now));
        }
        await r.Runner().TickAsync(default);
        Assert.Equal(3, r.Rig.Backend.Sends);
    }

    [Fact]
    public async Task TheHardGbCapStaysHardWhateverTheRulesSay()
    {
        using var r = new Rules();
        r.Config.ArrRequestQuotaGb = 10;
        r.Tmdb.Movie(603, "en", new[] { 16 }, new() { ["US"] = "G" });
        r.Tmdb.Movie(604, "en", new[] { 16 }, new() { ["US"] = "G" });
        r.Set(new { roles = new { trusted = new { rating = new { max = "PG", country = "US", match = "approve", otherwise = "none" } } } });
        Assert.Equal("queued", r.Want(await r.Ask(r.Trusted, 603)).Status);   // 8 GB estimate
        var over = await r.Ask(r.Trusted, 604);
        Assert.Equal((429, "quota_exceeded"), (over.HttpStatus, over.Reason));
        r.Config.ArrRequestQuotaGb = 0;
    }

    // ------------------------------------------------------------------ group pools

    private static void Pools(Rules r, params object[] pools)
    {
        r.Config.ArrPhase4GroupQuotasEnabled = true;
        r.Config.ArrGroupQuotaPools = JsonSerializer.Serialize(pools);
    }

    [Fact]
    public void PoolMembershipIsPersonFirstThenRoleAndAdminsAreNeverPooled()
    {
        var a = Guid.NewGuid();
        var pools = GroupQuotaPolicy.Parse(JsonSerializer.Serialize(new object[]
        {
            new { id = "kids", name = "Kids", limit = 3, roles = new[] { "Kid" }, users = Array.Empty<string>() },
            new { id = "house", name = "House", limit = 10, roles = new[] { "*" }, users = new[] { a.ToString("N") } },
        }));
        Assert.Equal("kids", GroupQuotaPolicy.For(pools, Guid.NewGuid(), "Kid", 7)!.Id);
        Assert.Equal("house", GroupQuotaPolicy.For(pools, Guid.NewGuid(), "Member", 7)!.Id);
        Assert.Equal("house", GroupQuotaPolicy.For(pools, a, "Kid", 7)!.Id);    // named beats role
        Assert.Null(GroupQuotaPolicy.For(pools, a, "Admin", 7));
        Assert.Equal("invalid_pool_id", GroupQuotaPolicy.Validate(new[] { new GroupQuotaPool { Id = "a", Name = "A", Limit = 1, Roles = new[] { "*" } }, new GroupQuotaPool { Id = "A", Name = "B", Limit = 1, Roles = new[] { "*" } } }));
        Assert.Equal("invalid_pool_limit", GroupQuotaPolicy.Validate(new[] { new GroupQuotaPool { Id = "a", Name = "A", Limit = 0, Roles = new[] { "*" } } }));
        Assert.Equal("invalid_pool_role", GroupQuotaPolicy.Validate(new[] { new GroupQuotaPool { Id = "a", Name = "A", Limit = 1, Roles = new[] { "Admin" } } }));
        Assert.Equal("invalid_pool_members", GroupQuotaPolicy.Validate(new[] { new GroupQuotaPool { Id = "a", Name = "A", Limit = 1 } }));
        Assert.Empty(GroupQuotaPolicy.Parse("[{\"id\":\"x\"}]"));
    }

    [Fact]
    public async Task APoolSharesAnAllowanceAndTheAskOverItWaitsForAnOkThatMayGrantIt()
    {
        using var r = new Rules();
        var second = r.View.AddUser(false);
        Pools(r, new { id = "fam", name = "Family", limit = 2, roles = new[] { "Member", "Trusted" }, users = Array.Empty<string>() });
        Assert.Equal("queued", r.Want(await r.Ask(r.Member, 1)).Status);
        Assert.Equal("queued", r.Want(await r.Ask(r.Trusted, 2)).Status);   // Trusted asks without an OK, but draws on the pool
        var over = await r.Ask(r.Member, 3);
        Assert.Equal(("pending", "group_quota"), (r.Want(over).Status, r.Want(over).Reason));
        var pool = r.Service.Pool(second.UserId)!.Value;
        Assert.Equal(("Family", 2, 2), (pool.Pool.Name, pool.Use.Used, pool.Use.Limit));
        // The person's own allowance is unchanged by the pool (each counted separately).
        Assert.Equal(1, r.Service.Quota(r.Member.UserId).Used);
        // An approval grants the soft excess; the charge is bound to the pool it was made in.
        Assert.Equal(200, (await r.Service.ApproveAsync(over.RequestId!, r.Admin.UserId, null, default)).HttpStatus);
        Assert.Equal(3, r.Service.Pool(second.UserId)!.Value.Use.Used);
        // Admins and Managers outside the pool's roles never draw on it.
        Assert.Equal("queued", r.Want(await r.Ask(r.Manager, 4)).Status);
        Assert.Equal(3, r.Service.Pool(second.UserId)!.Value.Use.Used);
    }

    [Fact]
    public async Task TwoPeopleContestingTheFinalPoolSlotGetExactlyOne()
    {
        using var r = new Rules();
        var people = Enumerable.Range(0, 8).Select(_ => r.View.AddUser(false)).ToArray();
        Pools(r, new { id = "house", name = "House", limit = 3, roles = new[] { "*" }, users = Array.Empty<string>() });
        var outcomes = await Task.WhenAll(people.Select((p, i) => Task.Run(() => r.Ask(p, 700 + i))));
        var statuses = outcomes.Select(o => r.Want(o).Status).ToList();
        Assert.Equal(3, statuses.Count(s => s == "queued"));
        Assert.Equal(5, statuses.Count(s => s == "pending"));
        Assert.Equal(3, r.Service.Pool(people[0].UserId)!.Value.Use.Used);
    }

    [Fact]
    public async Task FollowersAreFreeRefundsFreeTheSlotAndSpendNeverMovesBetweenPools()
    {
        using var r = new Rules();
        Pools(r, new { id = "fam", name = "Family", limit = 1, roles = new[] { "Member", "Trusted" }, users = Array.Empty<string>() },
            new { id = "kids", name = "Kids", limit = 5, roles = new[] { "Kid" }, users = Array.Empty<string>() });
        var first = await r.Ask(r.Member, 1);
        Assert.Equal("queued", r.Want(first).Status);
        // Following the same title costs nothing and needs no pool room.
        var follow = await r.Ask(r.Trusted, 1);
        Assert.True(r.Want(follow).Follower);
        Assert.Equal(1, r.Service.Pool(r.Member.UserId)!.Value.Use.Used);
        // The Member becomes a Kid: their charge stays in Family; the Kids pool is untouched.
        r.Config.ArrRequestUsers = JsonSerializer.Serialize(new Dictionary<string, object>
        {
            [r.Member.UserId.ToString("N")] = new { Role = "Kid" },
            [r.Kid.UserId.ToString("N")] = new { Role = "Kid" },
            [r.Trusted.UserId.ToString("N")] = new { Role = "Trusted" },
        });
        Assert.Equal(("kids", 0), (r.Service.Pool(r.Member.UserId)!.Value.Pool.Id, r.Service.Pool(r.Member.UserId)!.Value.Use.Used));
        Assert.Equal(1, r.Service.Pool(r.Trusted.UserId)!.Value.Use.Used);
        // A cancel before it is sent refunds the bound pool's slot.
        Assert.Equal(200, r.Service.Close(first.RequestId!, r.Member.UserId, null).HttpStatus);
        Assert.Equal(0, r.Service.Pool(r.Trusted.UserId)!.Value.Use.Used);
        Assert.Equal("queued", r.Want(await r.Ask(r.Trusted, 2)).Status);
    }

    [Fact]
    public async Task LaterChargesOfAWantAreBoundToItsPool()
    {
        using var r = new Rules();
        Pools(r, new { id = "fam", name = "Family", limit = 10, roles = new[] { "Member" }, users = Array.Empty<string>() });
        r.Config.ArrRequestChargeFutureSeasons = true;
        var ask = await r.Service.CreateAsync(r.Member.UserId, new CreateRequest("keep", new MutationInput { Key = "tv:tvdb:78874", Scope = "future", Seasons = new[] { 1 } }), default);
        Assert.Equal(201, ask.HttpStatus);
        await r.Runner().TickAsync(default);
        Assert.Equal("sent", r.Want(ask).Status);
        Assert.True(r.Rig.Ledger.ChargeFutureSeason(ask.RequestId!, 2, r.Policy, r.Now));
        var pools = r.Rig.Db.Read(c =>
        {
            using var cmd = c.CreateCommand();
            cmd.CommandText = "SELECT scope, pool_id FROM reservations WHERE want_id=$w ORDER BY rowid";
            cmd.Parameters.AddWithValue("$w", ask.RequestId);
            using var reader = cmd.ExecuteReader();
            var list = new List<(string, string?)>();
            while (reader.Read()) list.Add((reader.GetString(0), reader.IsDBNull(1) ? null : reader.GetString(1)));
            return list;
        });
        Assert.Equal(new[] { ("initial", (string?)"fam"), ("s2", "fam") }, pools);
        Assert.Equal(2, r.Service.Pool(r.Member.UserId)!.Value.Use.Used);
    }

    [Fact]
    public async Task APoolLimitLoweredBeforeSendHoldsTheRequestAndWithoutPoolsNothingChanges()
    {
        using var r = new Rules();
        Pools(r, new { id = "fam", name = "Family", limit = 3, roles = new[] { "Member" }, users = Array.Empty<string>() });
        var a = await r.Ask(r.Member, 1);
        var b = await r.Ask(r.Member, 2);
        Pools(r, new { id = "fam", name = "Family", limit = 1, roles = new[] { "Member" }, users = Array.Empty<string>() });
        var jobs = r.Rig.Ledger.Due(r.Now).ToList();
        Assert.All(jobs, j => Assert.Equal("group_quota", r.Rig.Ledger.ApprovalNeededAtSend(j, r.Policy.Evaluate(r.Member.UserId, j.Input), r.Policy, r.Now)));
        r.Config.ArrPhase4GroupQuotasEnabled = false;
        Assert.All(jobs, j => Assert.Null(r.Rig.Ledger.ApprovalNeededAtSend(j, r.Policy.Evaluate(r.Member.UserId, j.Input), r.Policy, r.Now)));
        Assert.Null(r.Policy.Evaluate(r.Member.UserId, new MutationInput { Key = "movie:tmdb:9" }).Pool);
        await Task.CompletedTask;
        _ = (a, b);
    }

    [Fact]
    public async Task ALaterApprovedPoolExcessNeverHoldsEarlierAsksThatWereWithinThePool()
    {
        using var r = new Rules();
        Pools(r, new { id = "fam", name = "Family", limit = 2, roles = new[] { "Member", "Trusted" }, users = Array.Empty<string>() });
        var first = await r.Ask(r.Member, 1);
        r.Now = r.Now.AddMinutes(1);
        var second = await r.Ask(r.Trusted, 2);
        r.Now = r.Now.AddMinutes(1);
        var third = await r.Ask(r.Member, 3);
        Assert.Equal(("queued", "queued", "pending", "group_quota"), (r.Want(first).Status, r.Want(second).Status, r.Want(third).Status, r.Want(third).Reason));
        r.Now = r.Now.AddMinutes(1);
        Assert.Equal(200, (await r.Service.ApproveAsync(third.RequestId!, r.Admin.UserId, null, default)).HttpStatus);
        Assert.Equal(3, r.Service.Pool(r.Member.UserId)!.Value.Use.Used);
        foreach (var (id, who) in new[] { (first.RequestId!, r.Member), (second.RequestId!, r.Trusted), (third.RequestId!, r.Member) })
        {
            var job = r.Rig.Ledger.ForWant(id).Single();
            Assert.Null(r.Rig.Ledger.ApprovalNeededAtSend(job, r.Policy.Evaluate(who.UserId, job.Input), r.Policy, r.Now));
        }
        await r.Runner().TickAsync(default);
        Assert.Equal(3, r.Rig.Backend.Sends);
        // The pool's current limit and window still count, in reservation order: raised to 5, two more go in; lowered
        // to 4 before they are sent, the fourth (4 used up to it) still goes and the fifth waits.
        Pools(r, new { id = "fam", name = "Family", limit = 5, roles = new[] { "Member", "Trusted" }, users = Array.Empty<string>() });
        r.Now = r.Now.AddMinutes(1);
        var fourth = await r.Ask(r.Member, 4);
        r.Now = r.Now.AddMinutes(1);
        var fifth = await r.Ask(r.Trusted, 5);
        Assert.Equal(("queued", "queued"), (r.Want(fourth).Status, r.Want(fifth).Status));
        Pools(r, new { id = "fam", name = "Family", limit = 4, roles = new[] { "Member", "Trusted" }, users = Array.Empty<string>() });
        var fourthJob = r.Rig.Ledger.ForWant(fourth.RequestId!).Single();
        var fifthJob = r.Rig.Ledger.ForWant(fifth.RequestId!).Single();
        Assert.Null(r.Rig.Ledger.ApprovalNeededAtSend(fourthJob, r.Policy.Evaluate(r.Member.UserId, fourthJob.Input), r.Policy, r.Now));
        Assert.Equal("group_quota", r.Rig.Ledger.ApprovalNeededAtSend(fifthJob, r.Policy.Evaluate(r.Trusted.UserId, fifthJob.Input), r.Policy, r.Now));
        // Once the first three age out of the window, the fifth fits again.
        r.Now = r.Now.AddDays(r.Config.ArrRequestQuotaWindowDays).AddSeconds(-90);
        Assert.Null(r.Rig.Ledger.ApprovalNeededAtSend(fifthJob, r.Policy.Evaluate(r.Trusted.UserId, fifthJob.Input), r.Policy, r.Now));
    }

    // ------------------------------------------------------------------ batch preview (S03 seam)

    [Fact]
    public async Task ABatchPreviewAddsUpAcrossTheBatchAndWritesNothing()
    {
        using var r = new Rules();
        r.Config.ArrRequestQuotaLimit = 2;
        var asks = Enumerable.Range(0, 3).Select(i => (CreateRequest?)new CreateRequest("p" + i, new MutationInput { Key = "movie:tmdb:" + (800 + i) })).ToList();
        asks.Add(null);
        var previews = await r.Service.PreviewBatchAsync(r.Member.UserId, asks, default);
        Assert.Equal(new[] { "queued", "queued", "pending", null }, previews.Select(p => p.Status));
        Assert.Equal("over_quota", previews[2].Reason);
        Assert.Equal("invalid_input", previews[3].Outcome.Reason);
        Assert.Empty(r.Rig.Ledger.List(r.Member.UserId, false));
        Assert.Equal(0, r.Service.Quota(r.Member.UserId).Used);
        Assert.Equal(0, r.Rig.Db.Read(c => { using var cmd = c.CreateCommand(); cmd.CommandText = "SELECT COUNT(*) FROM reservations"; return Convert.ToInt32(cmd.ExecuteScalar()); }));
        // Pools add up too, and the preview matches what the real asks then do.
        Pools(r, new { id = "fam", name = "Family", limit = 1, roles = new[] { "Member" }, users = Array.Empty<string>() });
        r.Config.ArrRequestQuotaLimit = 7;
        previews = await r.Service.PreviewBatchAsync(r.Member.UserId, asks.Take(2).ToList(), default);
        Assert.Equal(new[] { ("queued", "queued_outage"), ("pending", "group_quota") }, previews.Select(p => (p.Status!, p.Reason!)));
        var real = new List<string>();
        foreach (var ask in asks.Take(2)) real.Add(r.Want(await r.Service.CreateAsync(r.Member.UserId, ask, default)).Status);
        Assert.Equal(new[] { "queued", "pending" }, real);
        Assert.Equal("batch_too_large", (await r.Service.PreviewBatchAsync(r.Member.UserId, Enumerable.Repeat(asks[0], 21).ToList(), default))[0].Outcome.Reason);
    }

    [Fact]
    public async Task ThePreviewRouteSummarisesAndRefusesWatchersApiKeysAndPhase4Off()
    {
        using var r = new Rules();
        r.Tmdb.Movie(603, "en", new[] { 27 }, R);
        r.Tmdb.Movie(604, "en", new[] { 35 }, Pg13);
        r.Set(new { roles = new { member = new { genre = new { ids = new[] { 27 }, match = "review", otherwise = "none" } } } });
        var controller = Controller(r, r.Member);
        var body = new RequestPreviewBody { Items = new() { new RequestPreviewItem { Input = new MutationInput { Key = "movie:tmdb:603" } }, new RequestPreviewItem { Input = new MutationInput { Key = "movie:tmdb:604" } } } };
        var ok = Assert.IsType<OkObjectResult>(await controller.Preview(body));
        var json = JsonSerializer.SerializeToNode(ok.Value)!;
        Assert.Equal(1, (int)json["summary"]!["now"]!);
        Assert.Equal(1, (int)json["summary"]!["needOk"]!);
        Assert.Equal("rule_review", (string)json["items"]![0]!["reason"]!);
        Assert.Equal("review", (string)json["items"]![0]!["rules"]!["verdict"]!);
        Assert.Equal("private, no-store", controller.Response.Headers.CacheControl.ToString());
        Assert.Empty(r.Rig.Ledger.List(r.Member.UserId, false));
        var watcher = r.View.AddUser(false);
        r.Config.ArrRequestUsers = JsonSerializer.Serialize(new Dictionary<string, object> { [watcher.UserId.ToString("N")] = new { Role = "Watcher" } });
        Assert.Equal(403, Status(await Controller(r, watcher).Preview(body)));
        Assert.Equal(403, Status(await Controller(r, null).Preview(body)));
        r.Config.ArrPhase4Enabled = false;
        Assert.Equal(403, Status(await Controller(r, r.Member).Preview(body)));
        r.Config.ArrPhase4Enabled = true;
        body = new RequestPreviewBody { Items = Enumerable.Repeat(new RequestPreviewItem { Input = new MutationInput { Key = "movie:tmdb:1" } }, 21).ToList()! };
        Assert.Equal(400, Status(await Controller(r, r.Member).Preview(body)));
    }

    // ------------------------------------------------------------------ rules editor routes

    private static AcquireRulesController Controller(Rules r, StatusViewer? who, Func<CancellationToken, Task<SeerrRulesView>>? seerr = null, List<PluginConfiguration>? saves = null)
    {
        var service = new HouseholdRulesService(r.Service, r.Rig.Feed, c => saves?.Add(c),
            (country, _) => Task.FromResult<IReadOnlyList<RuleProvider>?>(country == "GB" ? new[] { new RuleProvider(8, "Netflix") } : null),
            seerr ?? (_ => Task.FromResult(new SeerrRulesView(false, null, null, null, null))));
        var controller = new AcquireRulesController(service) { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
        controller.HttpContext.User = who == null ? TestCallers.ApiKey() : TestCallers.Principal(who.UserId, who.IsAdmin);
        return controller;
    }

    private static int Status(IActionResult result) => result switch
    {
        ObjectResult o => o.StatusCode ?? 200,
        FileContentResult => 200,
        StatusCodeResult s => s.StatusCode,
        _ => -1,
    };

    [Fact]
    public async Task OnlyAdministratorsReadAndSaveRulesAndEveryValueIsValidatedFirst()
    {
        using var r = new Rules();
        var saves = new List<PluginConfiguration>();
        Assert.Equal(403, Status(await Controller(r, r.Member).Rules()));
        Assert.Equal(403, Status(await Controller(r, r.Manager).Rules()));
        Assert.Equal(403, Status(await Controller(r, null).Rules()));
        var admin = Controller(r, r.Admin, saves: saves);
        var read = Assert.IsType<FileContentResult>(await admin.Rules());
        var json = JsonNode.Parse(read.FileContents)!;
        Assert.True((bool)json["editable"]!);
        Assert.Equal("private, no-store", admin.Response.Headers.CacheControl.ToString());
        Assert.Contains(json["choices"]!["genres"]!.AsArray(), g => (int)g!["id"]! == 27);

        var save = new HouseholdRulesSave
        {
            Rules = new HouseholdRuleSet { Roles = new(StringComparer.OrdinalIgnoreCase) { ["kid"] = new HouseholdRoleRules { Rating = new HouseholdRatingRule { Max = "PG", Country = "us", Match = "none", Otherwise = "deny" } } } },
            StreamingCountry = "gb",
            StreamingServices = new[] { 8, 8, 337 },
        };
        Assert.Equal(200, Status(Controller(r, r.Admin, saves: saves).SaveRules(save)));
        Assert.Single(saves);
        Assert.Equal(("GB", "8,337"), (r.Config.ArrHouseholdStreamingCountry, r.Config.ArrHouseholdStreamingServices));
        Assert.Equal("US", HouseholdRules.Parse(r.Config.ArrHouseholdRules).For("Kid")!.Rating!.Country);
        // Invalid parts refuse the whole save; nothing written.
        var before = r.Config.ArrHouseholdRules;
        Assert.Equal(400, Status(Controller(r, r.Admin, saves: saves).SaveRules(save with { StreamingCountry = "Britain" })));
        Assert.Equal(400, Status(Controller(r, r.Admin, saves: saves).SaveRules(new HouseholdRulesSave { Rules = new HouseholdRuleSet { Roles = new() { ["manager"] = new HouseholdRoleRules() } } })));
        Assert.Equal(before, r.Config.ArrHouseholdRules);
        Assert.Single(saves);
        // Pools need the group-quota switch.
        var pools = new HouseholdRulesSave { Pools = new() { new GroupQuotaPool { Id = "kids", Name = "Kids", Limit = 3, Roles = new[] { "kid" } } } };
        Assert.Equal(403, Status(Controller(r, r.Admin, saves: saves).SaveRules(pools)));
        r.Config.ArrPhase4GroupQuotasEnabled = true;
        Assert.Equal(200, Status(Controller(r, r.Admin, saves: saves).SaveRules(pools)));
        Assert.Equal("Kid", GroupQuotaPolicy.Parse(r.Config.ArrGroupQuotaPools).Single().Roles.Single());
        Assert.Equal(403, Status(Controller(r, r.Member).SaveRules(pools)));
        // Streaming services for a country (administrators).
        Assert.Equal(200, Status(await Controller(r, r.Admin).StreamingServices("gb")));
        Assert.Equal(400, Status(await Controller(r, r.Admin).StreamingServices("gbr")));
        Assert.Equal(503, Status(await Controller(r, r.Admin).StreamingServices("US")));
        Assert.Equal(403, Status(await Controller(r, r.Member).StreamingServices("GB")));
        // Rules off: every route refuses.
        r.Config.ArrPhase4HouseholdRulesEnabled = false;
        Assert.Equal(403, Status(await Controller(r, r.Admin).Rules()));
        Assert.Equal(403, Status(Controller(r, r.Admin).SaveRules(save)));
    }

    [Fact]
    public async Task SeerrModeShowsSeerrsOwnRulesReadOnlyAndRefusesJeRulesAndPools()
    {
        using var r = new Rules();
        r.Config.ArrRequestBackend = "seerr";
        r.Config.ArrPhase4GroupQuotasEnabled = true;
        var rule = JsonDocument.Parse("{\"id\":1,\"genre\":\"16\",\"rootFolder\":\"/data/anime\"}").RootElement.Clone();
        var controller = Controller(r, r.Admin, _ => Task.FromResult(new SeerrRulesView(true, new[] { rule }, true, new { limit = 5, days = 7 }, null)));
        var json = JsonNode.Parse(Assert.IsType<FileContentResult>(await controller.Rules()).FileContents)!;
        Assert.False((bool)json["editable"]!);
        Assert.False((bool)json["conditions"]!);
        Assert.Equal("16", (string)json["seerr"]!["overrideRules"]![0]!["genre"]!);
        Assert.True((bool)json["seerr"]!["autoApprove"]!);
        // Seerr can't describe its rules: said as unknown (null), not made up.
        var unknown = Controller(r, r.Admin, _ => Task.FromResult(new SeerrRulesView(true, null, null, null, null)));
        Assert.Null(JsonNode.Parse(Assert.IsType<FileContentResult>(await unknown.Rules()).FileContents)!["seerr"]!["overrideRules"]);
        var refused = Assert.IsType<ObjectResult>(Controller(r, r.Admin).SaveRules(new HouseholdRulesSave { StreamingCountry = "GB" }));
        Assert.Equal(409, refused.StatusCode);
        Assert.Equal("rules_seerr_owned", ((RequestOutcome)refused.Value!).Reason);
    }

    // ------------------------------------------------------------------ the household tab and Trusted

    [Fact]
    public void TheHouseholdTabGivesTrustedOnlyWhileRulesAreOnAndNeverAsARoleLimit()
    {
        using var r = new Rules();
        var directory = new IntegrationRequestHouseholdTests.FakeDirectory();
        directory.People[r.Admin.UserId] = new HouseholdPerson { Id = r.Admin.UserId, Name = "Admin", IsAdmin = true };
        directory.People[r.Member.UserId] = new HouseholdPerson { Id = r.Member.UserId, Name = "Emma", IsAdmin = false };
        var projection = new RequestHubProjection(r.Service, directory, null, (_, _, _) => Task.FromResult<HubTitleMeta?>(null), () => r.Now);
        var household = new HouseholdService(projection, r.Rig.Feed, _ => { });
        var admin = r.View.Viewer(r.Admin.UserId)!;
        Assert.Equal(200, household.Save(admin, new HouseholdSave { Users = new() { [r.Member.UserId.ToString("N")] = new HouseholdUserSave { Role = "trusted" } } }).HttpStatus);
        Assert.Equal("Trusted", r.Service.Identity(r.Member.UserId).Role);
        Assert.Equal("invalid_role", household.Save(admin, new HouseholdSave { Roles = new() { ["trusted"] = new HouseholdRoleSave { QuotaLimit = 3 } } }).Reason);
        Assert.Equal(200, household.Save(admin, new HouseholdSave { DefaultRole = "Trusted" }).HttpStatus);
        r.Config.ArrPhase4HouseholdRulesEnabled = false;
        Assert.Equal("invalid_role", household.Save(admin, new HouseholdSave { DefaultRole = "Trusted" }).Reason);
        Assert.Equal("invalid_role", household.Save(admin, new HouseholdSave { Users = new() { [r.Member.UserId.ToString("N")] = new HouseholdUserSave { Role = "Trusted" } } }).Reason);
        // Stored Trusted reads as Member while off (nobody keeps the new privilege).
        Assert.Equal("Member", r.Service.Identity(r.Member.UserId).Role);
    }

    [Fact]
    public async Task ApprovalCardsAndOwnRequestsCarryTheRationaleAndPoolButNoOneElsesAccounting()
    {
        using var r = new Rules();
        r.Tmdb.Movie(603, "en", new[] { 27 }, R);
        r.Set(new { roles = new { kid = new { genre = new { ids = new[] { 27 }, match = "review", otherwise = "none" } } } });
        Pools(r, new { id = "kids", name = "Kids", limit = 4, roles = new[] { "Kid" }, users = Array.Empty<string>() });
        var ask = await r.Ask(r.Kid);
        var directory = new IntegrationRequestHouseholdTests.FakeDirectory();
        directory.People[r.Admin.UserId] = new HouseholdPerson { Id = r.Admin.UserId, Name = "Admin", IsAdmin = true };
        directory.People[r.Kid.UserId] = new HouseholdPerson { Id = r.Kid.UserId, Name = "Leo", IsAdmin = false };
        var projection = new RequestHubProjection(r.Service, directory, null, (_, _, _) => Task.FromResult<HubTitleMeta?>(null), () => r.Now);
        var approvals = JsonNode.Parse((await projection.ApprovalsAsync(r.View.Viewer(r.Admin.UserId)!, default)).Json)!;
        var card = approvals["items"]![0]!;
        Assert.Equal("rule_review", (string)card["reason"]!);
        Assert.Equal("review", (string)card["rules"]!["verdict"]!);
        Assert.Equal("Kids", (string)card["requester"]!["pool"]!["name"]!);
        var mine = JsonNode.Parse((await projection.MineAsync(r.View.Viewer(r.Kid.UserId)!, default)).Json)!;
        var row = mine["items"]![0]!;
        Assert.Equal("genre", (string)row["rules"]!["hits"]![0]!["condition"]!);
        Assert.DoesNotContain("quota", row.ToJsonString());
        // After a restart nothing has read the title's facts yet: the card keeps the verdict the request was made with
        // (never "not known" for facts the household knew).
        var fresh = new HouseholdRuleFacts((t, _) => Task.FromResult(t.NumericId), (_, _) => Task.FromResult<string?>(null), Score, () => r.Now);
        var restarted = new RequestService(r.Rig.Ledger, new RequestPolicy(r.View, r.Lab.Store, new ArrInstanceLibraries(r.Lab.Store, new FakeLibraryAccess()), new TitleAliases(r.Lab.Store, null), null!, r.Lab.Arr.Factory, new UnavailableRequestBackend(), fresh), r.View, r.Rig.Feed, () => r.Now);
        var again = new RequestHubProjection(restarted, directory, null, (_, _, _) => Task.FromResult<HubTitleMeta?>(null), () => r.Now);
        var hit = JsonNode.Parse((await again.ApprovalsAsync(r.View.Viewer(r.Admin.UserId)!, default)).Json)!["items"]![0]!["rules"]!["hits"]![0]!;
        Assert.True((bool)hit["matched"]!);
        _ = ask;
    }

    // ------------------------------------------------------------------ schema 4

    [Fact]
    public void ASchemaThreeDatabaseGetsTheRuleAndPoolColumnsOnce()
    {
        var root = Path.Combine(Path.GetTempPath(), "je-4b-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var path = Path.Combine(root, "acquire.db");
            using (var db = new AcquireDatabase(path)) Assert.Equal(AcquireDatabase.Migrations.Count, db.Version);
            using (var c = new SqliteConnection("Data Source=" + path + ";Pooling=False"))
            {
                c.Open();
                using var cmd = c.CreateCommand();
                cmd.CommandText = "DROP INDEX reservations_pool; ALTER TABLE wants DROP COLUMN rule_detail; ALTER TABLE reservations DROP COLUMN pool_id; PRAGMA user_version=3;";
                cmd.ExecuteNonQuery();
            }
            using (var db = new AcquireDatabase(path))
            {
                Assert.True(db.Available);
                Assert.Equal(4, db.Version);
                Assert.Equal(2L, db.Read(c =>
                {
                    using var cmd = c.CreateCommand();
                    cmd.CommandText = "SELECT (SELECT COUNT(*) FROM pragma_table_info('wants') WHERE name='rule_detail')+(SELECT COUNT(*) FROM pragma_table_info('reservations') WHERE name='pool_id')";
                    return (long)cmd.ExecuteScalar()!;
                }));
            }
            using (var again = new AcquireDatabase(path)) Assert.Equal(4, again.Version);
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(root, true);
        }
    }
}
