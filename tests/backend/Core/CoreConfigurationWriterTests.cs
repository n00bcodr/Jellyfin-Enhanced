using System.Reflection;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Plugins;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Moq;

namespace JE.Tests;

/// <summary>
/// Stage 1 fix round 11: every server write of the live configuration is one read-modify-write under the configuration's
/// one lock (the generation lock). A configuration page save (PATCH) copies the configuration held at that moment inside
/// the lock and replaces it; a server writer that changed the live configuration and saved it outside the lock while
/// that save was building its copy had its change put back by it (RBS1-R11-7: maintenance mode turned itself back on
/// after an unrelated PATCH). The server writers run through JellyfinEnhanced.MutateConfiguration (or, for the request
/// services, their own blocks under the same lock); the scan below fails on a configuration save anywhere else.
/// </summary>
[Collection("Plugin singleton")]
public class CoreConfigurationWriterTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    /// <summary>
    /// Runs a configuration page save (ApplyConfiguration, as PatchConfiguration does) that stops right after taking its
    /// copy of the configuration, runs <paramref name="writer"/> on another thread meanwhile, then lets the save finish.
    /// </summary>
    private static async Task PatchCopiedBefore(ApiPluginFixture f, Action writer)
    {
        using var copied = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        Func<PluginConfiguration?, BasePluginConfiguration> build = current =>
        {
            var next = ConfigurationPatcher.Clone(current!);
            next.ToastDuration = 1600;
            copied.Set();
            if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException();
            return next;
        };
        var apply = typeof(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced).GetMethod("ApplyConfiguration", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var patch = Task.Run(() => apply.Invoke(f.Plugin, new object[] { build, false, false }));
        Assert.True(copied.Wait(TimeSpan.FromSeconds(5)));
        var write = Task.Run(writer);
        // The writer runs while the save holds its copy (it waits for the lock, or, unlocked, writes at once).
        await Task.WhenAny(write, Task.Delay(300));
        release.Set();
        await patch;
        await write;
        Assert.Equal(1600, f.Plugin.Configuration.ToastDuration);
    }

    [Fact]
    public async Task MaintenanceModeClearedByTheServerStaysClearedThroughASaveThatCopiedItEarlier()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.PatchConfiguration(new ConfigurationPatch { Set = new() { ["MaintenanceModeEnabled"] = Json("true") } });
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), f.Core.Paths.Object, f.Core.Logger);
        var clear = typeof(MaintenanceModeService).GetMethod("ClearManualConfigFlag", BindingFlags.Instance | BindingFlags.NonPublic)!;
        await PatchCopiedBefore(f, () => clear.Invoke(maintenance, null));
        Assert.False(f.Plugin.Configuration.MaintenanceModeEnabled);
    }

    [Fact]
    public async Task ATranslationCacheClearStaysThroughASaveThatCopiedTheConfigurationEarlier()
    {
        using var f = new ApiPluginFixture();
        var before = f.Plugin.Configuration.ClearTranslationCacheTimestamp;
        var task = new ClearTranslationCacheTask(f.Core.Logger);
        await PatchCopiedBefore(f, () => task.ExecuteAsync(new Progress<double>(), CancellationToken.None).GetAwaiter().GetResult());
        Assert.NotEqual(before, f.Plugin.Configuration.ClearTranslationCacheTimestamp);
    }

    [Fact]
    public void AServerWriteChangesTheLiveConfigurationAndMovesTheGenerationOn()
    {
        using var f = new ApiPluginFixture();
        var generation = f.Plugin.Configuration.ConfigurationGeneration;
        Assert.True(f.Plugin.MutateConfiguration(c => { c.ToastDuration = 1700; return true; }));
        Assert.Equal(1700, f.Plugin.Configuration.ToastDuration);
        Assert.True(f.Plugin.Configuration.ConfigurationGeneration > generation);
        generation = f.Plugin.Configuration.ConfigurationGeneration;
        Assert.False(f.Plugin.MutateConfiguration(_ => false));
        Assert.Equal(generation, f.Plugin.Configuration.ConfigurationGeneration);
    }

    // ---- The scan: no configuration save outside one read-modify-write under the lock ----

    private static string ProductionRoot([System.Runtime.CompilerServices.CallerFilePath] string file = "")
    {
        var root = new DirectoryInfo(Path.GetDirectoryName(file)!);
        while (root != null && !Directory.Exists(Path.Combine(root.FullName, "Jellyfin.Plugin.JellyfinEnhanced"))) root = root.Parent;
        return Path.Combine(root!.FullName, "Jellyfin.Plugin.JellyfinEnhanced");
    }

    // The request services that change the live configuration in their own block under the configuration lock (with their
    // own read-back and put-back), through an injected save: their saves may run only inside that lock.
    private static readonly string[] LockedServices =
    {
        "HouseholdRulesService.cs", "HouseholdService.cs", "SeerrMigration.cs", "AdminUserSettingsService.cs",
    };

    private static bool IsConfigurationLock(LockStatementSyntax node)
        => node.Expression.ToString().Replace(" ", string.Empty) is "JellyfinEnhanced.ConfigurationLock" or "ConfigurationLock";

    /// <summary>Every configuration write in one source file that isn't one read-modify-write under the configuration lock.</summary>
    internal static List<string> Violations(string fileName, string source)
    {
        var found = new List<string>();
        var root = CSharpSyntaxTree.ParseText(source).GetRoot();
        string Where(SyntaxNode node) => $"{fileName}:{node.GetLocation().GetLineSpan().StartLinePosition.Line + 1} {node}";
        foreach (var call in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            var name = call.Expression switch
            {
                MemberAccessExpressionSyntax member => member.Name.Identifier.Text,
                IdentifierNameSyntax identifier => identifier.Identifier.Text,
                _ => string.Empty,
            };
            if (name is not ("SaveConfiguration" or "UpdateConfiguration")) continue;
            var method = call.Ancestors().OfType<BaseMethodDeclarationSyntax>().FirstOrDefault();
            var methodName = method switch { MethodDeclarationSyntax m => m.Identifier.Text, ConstructorDeclarationSyntax => ".ctor", _ => string.Empty };
            if (fileName == "JellyfinEnhanced.cs")
            {
                // The one mutate, the save every write ends in, and the whole writers' apply (base.UpdateConfiguration).
                var allowed = (name == "SaveConfiguration" && methodName is "MutateConfiguration" or "SaveConfiguration")
                    || (name == "UpdateConfiguration" && methodName == "ApplyConfiguration" && call.Expression.ToString().StartsWith("base.", StringComparison.Ordinal));
                if (!allowed) found.Add(Where(call));
                continue;
            }

            // The configuration effects' Custom Tabs sync writes Custom Tabs' own configuration (`host`, the Custom Tabs plugin
            // found through the plugin manager), never Jellyfin Enhanced's: its ownership flags go through MutateConfiguration.
            if (fileName == "ConfigurationEffects.cs" && name == "UpdateConfiguration" && methodName == "SyncCustomTabs"
                && call.Expression.ToString() == "host.UpdateConfiguration") continue;

            // Elsewhere only the request services' default save delegates (a lambda handed to their constructor chain).
            var inDefaultDelegate = LockedServices.Contains(fileName) && call.Ancestors().OfType<ConstructorInitializerSyntax>().Any()
                && call.Ancestors().OfType<LambdaExpressionSyntax>().Any();
            if (!inDefaultDelegate) found.Add(Where(call));
        }

        if (LockedServices.Contains(fileName))
        {
            foreach (var call in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                if (call.Expression is not IdentifierNameSyntax { Identifier.Text: "_save" }) continue;
                if (!call.Ancestors().OfType<LockStatementSyntax>().Any(IsConfigurationLock)) found.Add(Where(call));
            }
        }

        return found;
    }

    [Fact]
    public void EveryServerConfigurationWriteIsOneReadModifyWriteUnderTheConfigurationLock()
    {
        var found = Directory.GetFiles(ProductionRoot(), "*.cs", SearchOption.AllDirectories)
            .Where(path => !path.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}") && !path.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}"))
            .SelectMany(path => Violations(Path.GetFileName(path), File.ReadAllText(path)))
            .ToList();
        Assert.True(found.Count == 0, "configuration writes outside MutateConfiguration / the configuration lock:\n" + string.Join("\n", found));
    }

    [Fact]
    public void TheCustomTabsExceptionCoversOnlyCustomTabsOwnConfiguration()
    {
        // Stage 1 fix round 12: the server owns the Custom Tabs sync. Its write of Custom Tabs' configuration is allowed; a
        // write of Jellyfin Enhanced's own configuration in the same file (or in another method) is still found.
        Assert.Empty(Violations("ConfigurationEffects.cs", "class A { void SyncCustomTabs(IHasPluginConfiguration host, object next) { host.UpdateConfiguration(next); } }"));
        Assert.Single(Violations("ConfigurationEffects.cs", "class A { void SyncCustomTabs(object next) { JellyfinEnhanced.Instance.UpdateConfiguration(next); } }"));
        Assert.Single(Violations("ConfigurationEffects.cs", "class A { void Reconcile(IHasPluginConfiguration host, object next) { host.UpdateConfiguration(next); } }"));
        Assert.Single(Violations("ConfigurationEffects.cs", "class A { void SyncCustomTabs(PluginConfiguration c) { JellyfinEnhanced.Instance.SaveConfiguration(); } }"));
    }

    [Theory]
    // A server writer that changes the live configuration and saves it outside the lock.
    [InlineData("MaintenanceModeService.cs", "class A { void Clear() { var c = JellyfinEnhanced.Instance.Configuration; c.MaintenanceModeEnabled = false; JellyfinEnhanced.Instance.SaveConfiguration(); } }")]
    // A task that applies a whole configuration of its own.
    [InlineData("ClearTranslationCacheTask.cs", "class A { void Run(PluginConfiguration c) { JellyfinEnhanced.Instance!.UpdateConfiguration(c); } }")]
    // A request service whose save runs outside the configuration lock.
    [InlineData("HouseholdService.cs", "class A { readonly System.Action<PluginConfiguration> _save; void Set(PluginConfiguration c) { c.ArrRequestPreset = \"x\"; _save(c); } }")]
    // A request service whose save runs under another lock.
    [InlineData("HouseholdRulesService.cs", "class A { readonly object _gate = new(); readonly System.Action<PluginConfiguration> _save; void Set(PluginConfiguration c) { lock (_gate) { _save(c); } } }")]
    // The plugin saving from another member than the mutate.
    [InlineData("JellyfinEnhanced.cs", "class A { void Backfill() { Configuration.Shortcuts = null; SaveConfiguration(); } }")]
    public void TheScanFindsAPlantedConfigurationWriteOutsideTheLock(string fileName, string source)
        => Assert.NotEmpty(Violations(fileName, source));

    [Fact]
    public void TheScanAcceptsTheShapesItAllows()
    {
        Assert.Empty(Violations("JellyfinEnhanced.cs", "class A { bool MutateConfiguration(System.Func<PluginConfiguration, bool> f) { lock (ConfigurationLock) { SaveConfiguration(Configuration); return true; } } }"));
        Assert.Empty(Violations("HouseholdService.cs", "class A { A() : this(_ => JellyfinEnhanced.Instance?.SaveConfiguration()) { } readonly System.Action<PluginConfiguration> _save; void Set(PluginConfiguration c) { lock (JellyfinEnhanced.ConfigurationLock) { _save(c); } } }"));
    }
}
