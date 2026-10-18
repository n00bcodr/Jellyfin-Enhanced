using System.Runtime.CompilerServices;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;

namespace JE.Tests;

/// <summary>
/// The import and source-preview services over the list core harness (<see cref="ListsHarness"/>: in-memory Jellyfin,
/// real parental filter behind a synthetic Seerr/TMDB): an in-memory title lookup (<see cref="Lookup"/>), library
/// matches (<see cref="Library"/>, or the real resolver over <see cref="Host"/>), a scripted list source
/// (<see cref="Fetcher"/>) and a per-viewer Hidden Content / Spoiler Guard state (<see cref="Viewer"/>). Turns on the
/// import switches and every provider.
/// </summary>
internal sealed class ImportHarness : IDisposable
{
    public ListsHarness Lists { get; }
    public FakeImportLookup Lookup { get; } = new();
    public FakeLibraryLookup Library { get; } = new();
    public FakeSourceFetcher Fetcher { get; } = new();
    public FakeImportViewerPolicy Viewer { get; } = new();
    public FakePhysicalTitles Physical { get; } = new();
    public MetadataCallLimiter Limiter { get; } = new(4, TimeSpan.Zero, TimeProvider.System);
    public ListImportResolver ImportResolver { get; }
    public ListSourcePreview Sources { get; }

    /// <param name="seerr">Configure a (synthetic) Seerr.</param>
    /// <param name="realLibrary">Library matches come from the production lookup over <see cref="Host"/> instead of <see cref="Library"/>.</param>
    /// <param name="physical">The physical-title reader to use instead of <see cref="Physical"/> (e.g. the production one).</param>
    public ImportHarness(bool seerr = false, bool realLibrary = false, Func<ImportHarness, IImportPhysicalTitles>? physical = null)
    {
        Lists = new ListsHarness(seerr);
        ImportTestFlags.AllOn(Plugin.Plugin.Configuration);
        IListLibraryLookup library = realLibrary ? new ResolverListLibraryLookup(Lists.Resolver, Host) : Library;
        var reader = physical?.Invoke(this) ?? Physical;
        ImportResolver = new ListImportResolver(Lookup, library, Access, Limiter, Plugin.Core.Logger, Viewer, reader);
        Sources = new ListSourcePreview(Fetcher, ImportResolver, Access, Plugin.Core.Logger, Viewer, reader);
    }

    public ApiPluginFixture Plugin => Lists.Plugin;
    public FakeListHost Host => Lists.Host;
    public ListAccessService Access => Lists.Access;
    public Dictionary<int, string> MovieCertifications => Lists.MovieCertifications;
    public Dictionary<string, string> Tmdb => Lists.Tmdb;
    public List<string> SeerrCalls => Lists.SeerrCalls;

    /// <summary>A user with Jellyfin's default policy (access to every library, as a new Jellyfin user gets).</summary>
    public User NewUser(string name, bool admin = false, bool collections = false, int? maxRating = null)
    {
        var user = Lists.NewUser(name, admin, collections, maxRating);
        user.SetPermission(PermissionKind.EnableAllFolders, true);
        return user;
    }

    public ListAccess AccessFor(FakeListHost.FakeList list, User user) => Lists.AccessFor(list, user);

    public static T Ok<T>(ListOutcome outcome) => ListsHarness.Ok<T>(outcome);

    public static ListErrorDto Error(ListOutcome outcome, int status, string code) => ListsHarness.Error(outcome, status, code);

    public void Dispose() => Lists.Dispose();
}

/// <summary>Shorthands of the import tests.</summary>
internal static class ImportTestExtensions
{
    /// <summary>A URL review of <paramref name="url"/> as <paramref name="caller"/>.</summary>
    public static Task<ListOutcome> FetchAsync(this ListSourcePreview preview, User caller, string url, CancellationToken cancellationToken, IReadOnlyList<User>? libraryUsers = null) =>
        preview.FetchAsync(caller, new SourceFetchRequest { Url = url }, cancellationToken, libraryUsers);
}

/// <summary>Switch sets for the import tests.</summary>
internal static class ImportTestFlags
{
    /// <summary>Import, From URL and every provider on (the list chain itself is the list harness's).</summary>
    public static void AllOn(Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration config)
    {
        config.ArrIntegrationEnabled = true;
        config.ArrPhase1Enabled = true;
        config.ArrPhase3Enabled = true;
        config.ArrPhase4Enabled = true;
        config.ArrPhase4ListPlaceholdersEnabled = true;
        config.ArrPhase4ListAuthoringEnabled = true;
        config.ArrPhase4ListImportEnabled = true;
        config.ArrPhase4ListSourcesEnabled = true;
        config.ArrPhase4ListMdblistEnabled = true;
        config.ArrPhase4ListTmdbEnabled = true;
        config.ArrPhase4ListChronolistsEnabled = true;
        config.ArrPhase4ListTraktEnabled = true;
        config.ArrPhase4ListImdbEnabled = true;
    }
}

/// <summary>Hidden Content and Spoiler Guard state per viewer, as the import projection reads it.</summary>
internal sealed class FakeImportViewerPolicy : IImportViewerPolicy
{
    /// <summary>Hidden title keys (<c>movie:tmdb:N</c>, <c>tv:tmdb:N</c>) per viewer.</summary>
    public Dictionary<Guid, HashSet<string>> Hidden { get; } = new();

    /// <summary>Spoiler-guarded title keys per viewer.</summary>
    public Dictionary<Guid, HashSet<string>> Guarded { get; } = new();

    public void Hide(User viewer, string mediaType, int tmdbId) => Set(Hidden, viewer).Add(mediaType + ":tmdb:" + tmdbId);

    public void Guard(User viewer, string mediaType, int tmdbId) => Set(Guarded, viewer).Add(mediaType + ":tmdb:" + tmdbId);

    public ImportViewer For(User viewer)
    {
        var hidden = Hidden.TryGetValue(viewer.Id, out var h) ? h : new HashSet<string>();
        var guarded = Guarded.TryGetValue(viewer.Id, out var g) ? g : new HashSet<string>();
        return new ImportViewer(hidden, (mediaType, tmdbId) => guarded.Contains(mediaType + ":tmdb:" + tmdbId));
    }

    private static HashSet<string> Set(Dictionary<Guid, HashSet<string>> map, User viewer)
    {
        if (!map.TryGetValue(viewer.Id, out var set))
        {
            map[viewer.Id] = set = new HashSet<string>(StringComparer.Ordinal);
        }

        return set;
    }
}

/// <summary>The import test fixtures (read from the source tree, so the test project needs no copy rule).</summary>
internal static class ImportFixtures
{
    public static string Path(string name, [CallerFilePath] string caller = "") =>
        System.IO.Path.Combine(System.IO.Path.GetDirectoryName(caller)!, "Fixtures", name);

    public static string Read(string name, [CallerFilePath] string caller = "") => File.ReadAllText(Path(name, caller));
}
