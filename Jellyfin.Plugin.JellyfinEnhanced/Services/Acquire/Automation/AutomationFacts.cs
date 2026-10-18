using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Jellyfin.Data.Events.Users;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Controller.Events;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Automation
{
    /// <summary>How the automatic-write check reads a fact.</summary>
    public enum AutomationFactRead
    {
        /// <summary>
        /// Read from memory inside the final decision, with nothing that waits (no lock, no I/O): current as the write
        /// is decided, so there is nothing to version.
        /// </summary>
        Decision,

        /// <summary>
        /// Gathered before the decision (the read may wait), with a version every change moves before it can be seen
        /// (<see cref="FactVersion"/>, or what the stamp compares whole). The check samples the version before it gathers
        /// and again at the decision; a sample that isn't settled, or that moved, means the facts are gathered again.
        /// </summary>
        Versioned,
    }

    /// <summary>One fact the automatic-write check reads.</summary>
    /// <param name="Id">The fact.</param>
    /// <param name="Read">How it is read.</param>
    /// <param name="Readers">The members the check reads it with ("Type.Member"): the only ones it may call for it.</param>
    /// <param name="Version">Versioned: its version source (a key of <see cref="AutomationFacts.Versions"/>); null for a decision read.</param>
    /// <param name="Field">Versioned: the property of the gathered facts it is held in; null for a decision read.</param>
    public sealed record AutomationFact(string Id, AutomationFactRead Read, IReadOnlyList<string> Readers, string? Version = null, string? Field = null);

    /// <summary>
    /// 4a review round 8: the one registry of every fact the automatic-write check (<see cref="AutomationWriteGate"/>) reads.
    /// Each fact is either read in the final decision from memory, or gathered before it with a version that moves before
    /// any change to the fact can be seen. A test walks the check's source and fails on a read that isn't registered here,
    /// a reader used in the wrong step, a version source the stamp doesn't sample, or a fact with neither form; another
    /// scans every writer of the versioned sources for the bracket (<see cref="FactVersion"/>,
    /// <see cref="AcquireDatabase.WriteAutomation{T}"/>). A new fact (a new gate, or the 4b Trusted seam reading storage)
    /// is added here first.
    /// </summary>
    public static class AutomationFacts
    {
        /// <summary>The version sources: what the check's stamp samples for each, and what moves it.</summary>
        public static readonly IReadOnlyDictionary<string, string> Versions = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["configuration"] = "the configuration object and its whole content (a change is its own version; read again at the decision)",
            ["generation"] = "AcquireDatabase.Generation: a restore replaced the database (the write is held at once)",
            ["automation"] = "AcquireDatabase.Automation: every write of automation_budget, automation_breakers and automation_grants (WriteAutomation), and a restore",
            ["person_settings"] = "IAutomationConsents.Version: the person's settings.json put in place or removed, and every person's at once (restore, quarantine, start-up migration)",
            ["jellyfin_user"] = "IRequestPolicy.PermissionVersion, for the requester and for the approver: JellyfinUserVersions (the person's and every person's), bracketed around every Jellyfin action that can change or authenticate a user (JellyfinUserActions) and JE's own user changes, and moved by Jellyfin's user events",
            ["secrets"] = "SecretsStore.Version: every change of the stored credentials (Seerr's API key among them)",
        };

        /// <summary>Calls the gather step may make that read no fact (they only start reads for later).</summary>
        public static readonly IReadOnlyList<string> Effects = new[] { "IRequestPolicy.WarmDisk" };

        /// <summary>Every fact, with how it is read.</summary>
        public static readonly IReadOnlyList<AutomationFact> All = new AutomationFact[]
        {
            new("configuration", AutomationFactRead.Decision, new[] { "AutomationWriteGate._config" }),
            new("clock", AutomationFactRead.Decision, new[] { "AutomationWriteGate._now" }),
            // The published system and library snapshots behind both disk verdicts: one read of each.
            new("disk", AutomationFactRead.Decision, new[] { "IRequestPolicy.Disk" }),
            new("role", AutomationFactRead.Decision, new[] { "IRequestPolicy.RoleOf" }),
            new("trust", AutomationFactRead.Decision, new[] { "AutomationEligibility.Trusted" }),
            // The judgement of the job's gathered budget rows against the live limits.
            new("admission_limits", AutomationFactRead.Decision, new[] { "ISendAdmission.Recheck" }),
            new("seerr_key", AutomationFactRead.Versioned, new[] { "PluginConfiguration.GetJellyseerrApiKey" }, "secrets", "SeerrKey"),
            new("budget", AutomationFactRead.Versioned, new[] { "AutomationBudgets.Rows" }, "automation", "Budget"),
            new("admission", AutomationFactRead.Versioned, new[] { "ISendAdmission.Rows" }, "automation", "Admission"),
            new("breaker", AutomationFactRead.Versioned, new[] { "AutomationStore.Breaker" }, "automation", "Breaker"),
            new("grant", AutomationFactRead.Versioned, new[] { "AutomationEligibility.Granted" }, "automation", "Granted"),
            // Jellyfin reads its database for it (IUserManager.GetUserById has no in-memory cache on 12.2).
            new("jellyfin_admin", AutomationFactRead.Versioned, new[] { "IRequestPolicy.IsAdmin" }, "jellyfin_user", "Admin"),
            new("consent", AutomationFactRead.Versioned, new[] { "AutomationConsent.Allows" }, "person_settings", "Consented"),
            // 4a review round 10: the requester's and the approver's policy facts (whether they are still enabled Jellyfin
            // users, their household role and rights, whether they see the title), as the outbox's checks read them. Jellyfin
            // reads its database for them; each person's Jellyfin user version is stamped.
            new("authority", AutomationFactRead.Versioned, new[] { "IRequestPolicy.Evaluate" }, "jellyfin_user", "Authority"),
        };

        /// <summary>What is wrong with <paramref name="facts"/> as a registry (empty: nothing).</summary>
        /// <param name="facts">The facts.</param>
        public static IReadOnlyList<string> Problems(IEnumerable<AutomationFact> facts)
        {
            var problems = new List<string>();
            var readers = new HashSet<string>(StringComparer.Ordinal);
            foreach (var fact in facts)
            {
                if (fact.Readers.Count == 0) problems.Add(fact.Id + ": no reader");
                foreach (var reader in fact.Readers)
                    if (!readers.Add(reader)) problems.Add(fact.Id + ": " + reader + " reads another fact too");
                switch (fact.Read)
                {
                    case AutomationFactRead.Decision when fact.Version != null || fact.Field != null:
                        problems.Add(fact.Id + ": a decision read has no version");
                        break;
                    case AutomationFactRead.Versioned when fact.Version == null || !Versions.ContainsKey(fact.Version) || fact.Field == null:
                        problems.Add(fact.Id + ": a gathered fact needs a known version source and its field");
                        break;
                    case AutomationFactRead.Decision or AutomationFactRead.Versioned:
                        break;
                    default:
                        problems.Add(fact.Id + ": neither a decision read nor a versioned fact");
                        break;
                }
            }

            return problems;
        }
    }

    /// <summary>
    /// The version of each person's Jellyfin permissions (administrator, disabled, deleted), which the automatic-write check
    /// reads through Jellyfin's database, and one version of every person's at once (a change whose person isn't known
    /// before it runs: a sign-in by name, a new user, the start-up wizard). Jellyfin's own writes can't be bracketed from
    /// inside, so <see cref="JellyfinUserChangeBracket"/> brackets the HTTP actions that make them (odd before the action
    /// runs, even after it returned), JE's own changes run inside <see cref="Mutate"/>, and Jellyfin's user events move it
    /// too (after the change: changes made by other code than these actions).
    /// </summary>
    public static class JellyfinUserVersions
    {
        private static readonly FactVersions Versions = new();
        private static readonly FactVersion Everyone = new();

        /// <summary>
        /// The person's version now, with every person's (one <see cref="FactVersion"/> sample: unsettled while either is,
        /// else their sum, which a change of either moves up).
        /// </summary>
        /// <param name="user">The person.</param>
        public static long Sample(Guid user) => FactVersion.Combine(Versions.Sample(user.ToString("N")), Everyone.Sample());

        /// <summary>Makes a change to the person's Jellyfin user inside their version's bracket.</summary>
        /// <param name="user">The person.</param>
        /// <param name="change">The change (it has completed when its task has).</param>
        public static Task Mutate(Guid user, Func<Task> change) => Versions.For(user.ToString("N")).MutateAsync(change);

        /// <summary>Makes a change whose person isn't known before it runs inside every person's bracket.</summary>
        /// <param name="change">The change (it has completed when its task has).</param>
        public static Task MutateAll(Func<Task> change) => Everyone.MutateAsync(change);

        /// <summary>Moves the person's version after a change Jellyfin reported.</summary>
        /// <param name="user">The person.</param>
        public static void Changed(Guid user) => Versions.For(user.ToString("N")).Mutate(() => { });
    }

    /// <summary>
    /// 4a review round 9: DENY BY DEFAULT. Every controller action that can create, delete, change, lock or authenticate a
    /// Jellyfin user (<see cref="JellyfinUserActions"/>: every non-GET action of Jellyfin's user, Quick Connect and start-up
    /// controllers, and every action whose code reaches a user change or a sign-in, a failed one of which can lock the
    /// account) runs inside a <see cref="JellyfinUserVersions"/> bracket: the person's (the <c>userId</c> argument, else the
    /// signed-in person) or, when the person isn't known before it runs, every person's. The version is odd from before the
    /// action runs until it has returned, so the automatic-write check never decides on a permission read while one was
    /// landing. No lock is held across the action: the bracket is two interlocked adds, and the classification is a lookup.
    /// </summary>
    public sealed class JellyfinUserChangeBracket : IAsyncActionFilter
    {
        /// <summary>Jellyfin's claim for the signed-in person's id.</summary>
        internal const string UserIdClaim = "Jellyfin-UserId";

        /// <summary>Creates the filter (DI): it starts reading Jellyfin's controllers in the background.</summary>
        public JellyfinUserChangeBracket() { JellyfinUserActions.Warm(); }

        /// <inheritdoc />
        public Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            if (context.ActionDescriptor is not ControllerActionDescriptor { MethodInfo: { } method } action) return next();
            switch (JellyfinUserActions.KeyOf(method, action.ControllerTypeInfo.Name, context.HttpContext.Request.Method))
            {
                case JellyfinUserKey.None:
                    return next();
                case JellyfinUserKey.User when Person(context) is { } user:
                    return JellyfinUserVersions.Mutate(user, () => next());
                default:
                    return JellyfinUserVersions.MutateAll(() => next());
            }
        }

        // The person the action is about: the userId argument, else the signed-in person (Jellyfin's default for it).
        private static Guid? Person(ActionExecutingContext context)
        {
            if (context.ActionArguments.TryGetValue("userId", out var id) && id is Guid user && user != Guid.Empty) return user;
            return Guid.TryParse(context.HttpContext.User?.FindFirst(UserIdClaim)?.Value, out var principal) && principal != Guid.Empty ? principal : null;
        }
    }

    /// <summary>Moves a person's <see cref="JellyfinUserVersions"/> on Jellyfin's user events (changes made outside the bracketed actions).</summary>
    public sealed class JellyfinUserChangeVersion : IEventConsumer<UserUpdatedEventArgs>, IEventConsumer<UserDeletedEventArgs>, IEventConsumer<UserLockedOutEventArgs>
    {
        /// <inheritdoc />
        public Task OnEvent(UserUpdatedEventArgs eventArgs) => Moved(eventArgs?.Argument?.Id);

        /// <inheritdoc />
        public Task OnEvent(UserDeletedEventArgs eventArgs) => Moved(eventArgs?.Argument?.Id);

        /// <inheritdoc />
        public Task OnEvent(UserLockedOutEventArgs eventArgs) => Moved(eventArgs?.Argument?.Id);

        private static Task Moved(Guid? user)
        {
            if (user is { } id && id != Guid.Empty) JellyfinUserVersions.Changed(id);
            return Task.CompletedTask;
        }
    }
}
