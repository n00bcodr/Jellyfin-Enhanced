namespace JE.Tests;

/// <summary>
/// 4f round 9 (4f-r8-1, D53): the notify path's source scan (<see cref="NotifyGateWalk"/>): one final gate with nothing
/// handed in, nothing a decision reads carried across an await, and no await between the gate and its action. Each planted
/// bypass is one the r1–r8 rounds shipped or nearly shipped; the walk must name it.
/// </summary>
[Collection("Plugin singleton")]
public class NotifyGateWalkTests
{
    private const string Dispatcher = "NotifyDispatcher.cs";
    private const string Service = "NotificationService.cs";

    [Fact]
    public void TheNotifyPathHasOneFinalGateWithNothingHandedInAndNoAwaitBetweenItAndItsActions()
    {
        var walk = NotifyGateWalk.Plugin;
        Assert.Empty(walk.Errors());
        var problems = walk.Problems();
        Assert.True(problems.Count == 0, string.Join("\n", problems));
        // Not vacuous: every kind of action was found and checked, in both files.
        // ScanRequests now gathers Final recipients for one atomic seen/notice
        // transaction: its former Notify site is an Add + post-commit Announce.
        int Count(string name, string file) => walk.Checked.Count(c => c.StartsWith(name + " at " + file, StringComparison.Ordinal));
        Assert.True(Count("Notify", Service) + Count("NotifyCore", Service) >= 7, string.Join(", ", walk.Checked));
        Assert.True(Count("Announce", Service) >= 3 && Count("NotifyAll", Service) >= 1 && Count("Add", Service) >= 3, string.Join(", ", walk.Checked));
        Assert.True(Count("AddAlertWait", Service) >= 2 && Count("RetryAlertWait", Service) >= 1, string.Join(", ", walk.Checked));
        Assert.True(Count("SendAsync", Dispatcher) >= 3 && Count("Settle", Dispatcher) >= 2 && Count("Act", Dispatcher) >= 3, string.Join(", ", walk.Checked));
        Assert.True(Count("Finish", Dispatcher) >= 1 && Count("Suppress", Dispatcher) >= 2, string.Join(", ", walk.Checked));
    }

    [Fact]
    public void EveryVerdictIsActedOnThroughTheOneEffectTableAtEverySite()
    {
        // 4f round 10 (4f-r9-1, D53): one verdict → effect table (Off = leave, Wait = postpone, Refuse = suppress, Send = act),
        // switched over at every action site (the native message's claim included), and every alert carries its origin.
        var walk = NotifyGateWalk.Plugin;
        Assert.Empty(walk.Errors());
        var problems = walk.Problems();
        Assert.True(problems.Count == 0, string.Join("\n", problems));
        int Sites(string method) => walk.EffectSites.Count(s => s.StartsWith(method + " at ", StringComparison.Ordinal));
        var all = string.Join(", ", walk.EffectSites);
        // Not vacuous: each action site of the dispatcher and the service is one of the switches checked.
        Assert.True(Sites("Act") == 1 && Sites("DeliverAsync") + Sites("DeliverSummaryAsync") >= 1 && Sites("DeliverDisplayAsync") >= 2, all);
        Assert.True(Sites("FlushBatch") == 1 && Sites("EvaluateMovieAsync") == 1 && Sites("DeliverRequestNoticesCoreAsync") >= 3 && Sites("RetryAlertWaitsCoreAsync") >= 2, all);
        Assert.True(Sites("ScanRequestsCore") >= 2 && Sites("RemindCoreAsync") >= 1 && Sites("TellAdmins") >= 1 && Sites("AdminChecksCoreAsync") >= 1, all);
        Assert.True(Sites("SendTestCore") >= 1 && Sites("TrySendTestCore") >= 1 && Sites("NotifyCore") >= 1 && Sites("Add") >= 1, all);
    }

    private static List<string> Planted(string file, string find, string replace)
    {
        var walk = NotifyGateWalk.Plugin.With(file, s =>
        {
            Assert.Contains(find, s);
            return s.Replace(find, replace, StringComparison.Ordinal);
        });
        Assert.Empty(walk.Errors());
        return walk.Problems();
    }

    [Fact]
    public void AConfigurationHandedToTheSingleDeliveryIsNamed()
    {
        // 4f-r8-1 as it was: the round read the configuration and handed it to the delivery, which awaited its preparation.
        var problems = Planted(Dispatcher,
            "private async Task<NotifyEffect> DeliverAsync(DueDelivery delivery, CancellationToken cancellationToken)",
            "private async Task<NotifyEffect> DeliverAsync(DueDelivery delivery, CancellationToken cancellationToken, PluginConfiguration? handed = null)");
        Assert.Contains(problems, p => p.Contains("handed in as 'handed' of DeliverAsync", StringComparison.Ordinal));
    }

    [Fact]
    public void AnAwaitBetweenTheGateAndTheSendIsNamed()
    {
        var problems = Planted(Dispatcher,
            "var final = Final(NotifyAlert.Of(delivery));\n            var effect = Act(delivery, final);",
            "var final = Final(NotifyAlert.Of(delivery));\n            await PrepareOutcomeAsync(delivery, cancellationToken).ConfigureAwait(false);\n            var effect = Act(delivery, final);");
        Assert.Contains(problems, p => p.StartsWith("Act at NotifyDispatcher.cs", StringComparison.Ordinal) && p.Contains("waits after the Final", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Contains("'final' used after an await", StringComparison.Ordinal));
    }

    [Fact]
    public void PreferencesReadBeforeAnAwaitAndUsedAfterItAreNamed()
    {
        // The r1 class: a value read before an await and not read again. Read and not used after the await: fine.
        const string Prepare = "if (_policy != null && TitleKey.Parse(wait.TitleKey) is { } key && _dispatcher.OutcomeInput(key, wait.EventKey, payload) is { } input)\n                    await _policy.PrepareVisibilityAsync(wait.User, input, cancellationToken).ConfigureAwait(false);";
        Assert.Empty(Planted(Service, Prepare, "var stale = _store.Prefs(wait.User);\n                _ = stale.Declined;\n                " + Prepare));
        var used = Planted(Service, Prepare, "var stale = _store.Prefs(wait.User);\n                " + Prepare + "\n                if (!stale.Declined) continue;");
        Assert.Contains(used, p => p.Contains("'stale' used after an await", StringComparison.Ordinal));
    }

    [Fact]
    public void ABellRowWrittenWithNoGateBeforeItIsNamed()
    {
        var problems = Planted(Service,
            "var final = _dispatcher.Final(Alert(user, NotifyKind.Test, \"test|\" + now.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture), null, null, new Dictionary<string, string>(), now));\n            switch (final.Effect)\n            {\n                case NotifyEffect.Act:\n                    return NotifyCore(final, null);",
            "NotifyFinal final = null!;\n            switch (final.Effect)\n            {\n                case NotifyEffect.Act:\n                    return NotifyCore(final, null);");
        Assert.Contains(problems, p => p.StartsWith("NotifyCore with no Final before it", StringComparison.Ordinal));
    }

    [Fact]
    public void AVerdictMadeOutsideTheGateIsNamed()
    {
        var problems = Planted(Service,
            "internal bool Notify(NotifyFinal final, Func<NotifyTransaction, bool>? first, long? generation = null)",
            "private static NotifyFinal Made() => NotifyFinal.Refuse(new NotifyAlert(Guid.Empty, NotifyKind.Test, null, null, null, new Dictionary<string, string>()), DateTimeOffset.UnixEpoch, \"made\");\n\n        internal bool Notify(NotifyFinal final, Func<NotifyTransaction, bool>? first, long? generation = null)");
        Assert.Contains(problems, p => p.StartsWith("a verdict made outside the gate", StringComparison.Ordinal));
    }

    // ── 4f round 10: one verdict → effect table ─────────────────────────

    [Fact]
    public void AClaimThatSuppressesWhenNotificationsAreOffIsNamed()
    {
        // 4f-r9-1 as it shipped: the claim's Off (switched off during the session re-read) ended the message for good.
        var problems = Planted(Dispatcher,
            "case NotifyEffect.Leave:\n                            // Switched off: nothing is claimed or sent, and none of them is ended.\n                            off = true;",
            "case NotifyEffect.Leave:\n                            _store.Suppress(delivery.Id, \"off\", delivery.Generation);\n                            off = true;");
        Assert.Contains(problems, p => p.StartsWith("Leave at NotifyDispatcher.cs", StringComparison.Ordinal) && p.Contains("Suppress (suppress)", StringComparison.Ordinal));
    }

    [Fact]
    public void AVerdictReadDirectlyInsteadOfThroughTheTableIsNamed()
    {
        // r9's claim read the verdict itself (anything not a send was vetoed and suppressed).
        var problems = Planted(Dispatcher,
            "var final = Final(NotifyAlert.Of(delivery) with { Claimed = true });\n",
            "var final = Final(NotifyAlert.Of(delivery) with { Claimed = true });\n                    if (!final.Sends) continue;\n");
        Assert.Contains(problems, p => p.StartsWith("the verdict read directly", StringComparison.Ordinal) && p.Contains("final.Sends", StringComparison.Ordinal));
    }

    [Fact]
    public void AnEffectLumpedIntoADefaultIsNamed()
    {
        var problems = Planted(Service,
            "                case NotifyEffect.Suppress:\n                    DropBatch(user, key, json, generation);",
            "                default:\n                    DropBatch(user, key, json, generation);");
        Assert.Contains(problems, p => p.StartsWith("a switch over the effect lumps effects in a default", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Contains("(FlushBatch) doesn't name Suppress", StringComparison.Ordinal));
    }

    [Fact]
    public void APostponementThatDropsIsNamed()
    {
        var problems = Planted(Service, "WaitBatch(user, key, json, final.At, generation);", "DropBatch(user, key, json, generation);");
        Assert.Contains(problems, p => p.StartsWith("Postpone at NotificationService.cs", StringComparison.Ordinal) && p.Contains("DropBatch (suppress)", StringComparison.Ordinal));
    }

    [Fact]
    public void ARefusalThatEndsNothingIsNamed()
    {
        var problems = Planted(Service,
            "case NotifyEffect.Suppress:\n                        _store.DropAlertWait(wait, generation);\n                        continue;\n                    case NotifyEffect.Act:",
            "case NotifyEffect.Suppress:\n                        continue;\n                    case NotifyEffect.Act:");
        Assert.Contains(problems, p => p.Contains("(RetryAlertWaitsCoreAsync) suppresses nothing", StringComparison.Ordinal));
    }

    [Fact]
    public void ATableThatMapsAVerdictToAnotherEffectIsNamed()
    {
        var problems = Planted("NotifyFinal.cs", "NotifyVerdict.Off => NotifyEffect.Leave,", "NotifyVerdict.Off => NotifyEffect.Suppress,");
        Assert.Contains("the table maps Off to Suppress, not Leave", problems);
    }

    [Fact]
    public void AnAlertWithNoOriginIsNamed()
    {
        // 4f-r9-2 as it shipped: an alert the gate couldn't hold to the catch-up limit.
        var problems = Planted(Service, "=> new(wait.User, wait.Kind, wait.TitleKey, null, wait.EventKey, payload) { Since = wait.OriginalAt, Queued = wait.OriginalAt };", "=> new(wait.User, wait.Kind, wait.TitleKey, null, wait.EventKey, payload) { Queued = wait.OriginalAt };");
        Assert.Contains(problems, p => p.StartsWith("an alert made with no origin", StringComparison.Ordinal) && p.Contains("(WaitAlert)", StringComparison.Ordinal));
    }

    [Fact]
    public void AConfigurationCapturedByALaterFunctionIsNamed()
    {
        // A configuration read before an await and kept in a delegate run after it.
        var problems = Planted(Dispatcher,
            "await PrepareOutcomeAsync(delivery, cancellationToken).ConfigureAwait(false);\n            var final = Final(NotifyAlert.Of(delivery));",
            "var early = _config();\n            Func<bool> on = () => NotifyFlags.Enabled(early);\n            await PrepareOutcomeAsync(delivery, cancellationToken).ConfigureAwait(false);\n            if (!on()) return NotifyEffect.Leave;\n            var final = Final(NotifyAlert.Of(delivery));");
        Assert.Contains(problems, p => p.Contains("'early' captured by a nested function", StringComparison.Ordinal));
    }
}
