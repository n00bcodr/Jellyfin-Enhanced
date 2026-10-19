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
        int Count(string name, string file) => walk.Checked.Count(c => c.StartsWith(name + " at " + file, StringComparison.Ordinal));
        Assert.True(Count("Notify", Service) >= 8, string.Join(", ", walk.Checked));
        Assert.True(Count("Announce", Service) >= 2 && Count("NotifyAll", Service) >= 1 && Count("Add", Service) >= 2, string.Join(", ", walk.Checked));
        Assert.True(Count("AddAlertWait", Service) >= 2 && Count("RetryAlertWait", Service) >= 1, string.Join(", ", walk.Checked));
        Assert.True(Count("SendAsync", Dispatcher) >= 3 && Count("Settle", Dispatcher) >= 2 && Count("Act", Dispatcher) >= 3, string.Join(", ", walk.Checked));
        Assert.True(Count("Finish", Dispatcher) >= 1 && Count("Suppress", Dispatcher) >= 2, string.Join(", ", walk.Checked));
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
            "private async Task<NotifyVerdict> DeliverAsync(DueDelivery delivery, CancellationToken cancellationToken)",
            "private async Task<NotifyVerdict> DeliverAsync(DueDelivery delivery, CancellationToken cancellationToken, PluginConfiguration? handed = null)");
        Assert.Contains(problems, p => p.Contains("handed in as 'handed' of DeliverAsync", StringComparison.Ordinal));
    }

    [Fact]
    public void AnAwaitBetweenTheGateAndTheSendIsNamed()
    {
        var problems = Planted(Dispatcher,
            "var final = Final(NotifyAlert.Of(delivery));\n            if (!Act(delivery, final)) return final.Verdict;",
            "var final = Final(NotifyAlert.Of(delivery));\n            await PrepareOutcomeAsync(delivery, cancellationToken).ConfigureAwait(false);\n            if (!Act(delivery, final)) return final.Verdict;");
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
            "var final = _dispatcher.Final(Alert(user, NotifyKind.Test, \"test|\" + now.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture), null, null, new Dictionary<string, string>()));\n            return final.Sends && Notify(final, null);",
            "NotifyFinal final = null!;\n            return final.Sends && Notify(final, null);");
        Assert.Contains(problems, p => p.StartsWith("Notify with no Final before it", StringComparison.Ordinal));
    }

    [Fact]
    public void AVerdictMadeOutsideTheGateIsNamed()
    {
        var problems = Planted(Service,
            "internal bool Notify(NotifyFinal final, Func<NotifyTransaction, bool>? first, long? generation = null)",
            "private static NotifyFinal Made() => NotifyFinal.Refuse(new NotifyAlert(Guid.Empty, NotifyKind.Test, null, null, null, new Dictionary<string, string>()), DateTimeOffset.UnixEpoch, \"made\");\n\n        internal bool Notify(NotifyFinal final, Func<NotifyTransaction, bool>? first, long? generation = null)");
        Assert.Contains(problems, p => p.StartsWith("a verdict made outside the gate", StringComparison.Ordinal));
    }

    [Fact]
    public void AConfigurationCapturedByALaterFunctionIsNamed()
    {
        // A configuration read before an await and kept in a delegate run after it.
        var problems = Planted(Dispatcher,
            "await PrepareOutcomeAsync(delivery, cancellationToken).ConfigureAwait(false);\n            var final = Final(NotifyAlert.Of(delivery));",
            "var early = _config();\n            Func<bool> on = () => NotifyFlags.Enabled(early);\n            await PrepareOutcomeAsync(delivery, cancellationToken).ConfigureAwait(false);\n            if (!on()) return NotifyVerdict.Off;\n            var final = Final(NotifyAlert.Of(delivery));");
        Assert.Contains(problems, p => p.Contains("'early' captured by a nested function", StringComparison.Ordinal));
    }
}
