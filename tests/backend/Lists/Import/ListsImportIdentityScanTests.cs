using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;

namespace JE.Tests;

// Track 4c2a review round 3 (D53 rule 2, made structural): no consumer of a candidate's identity takes a raw TMDB id. The
// completed identity has a private constructor (only its completion step builds one), every consumer's signature takes
// it, and the list-host reads in the import (FindSeries / FindMovies) pass every id of it. The behaviour itself is
// proven by ListsImportIdentityR3Tests (the production resolver, preview, viewer policy and library); this guards the
// structure against a new consumer that asks under the TMDB id alone.
public class ListsImportIdentityScanTests
{
    private static string Root([CallerFilePath] string caller = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(caller)!, "..", "..", "..", "..", "Jellyfin.Plugin.JellyfinEnhanced"));

    private static string Lists => Path.Combine(Root(), "Services", "Acquire", "Lists");

    // The import's identity consumers: Import/** and the source preview's two files.
    private static IEnumerable<(string File, string Code)> Consumers() =>
        Directory.GetFiles(Path.Combine(Lists, "Import"), "*.cs", SearchOption.AllDirectories)
            .Append(Path.Combine(Lists, "Sources", "ListSourcePreview.cs"))
            .Append(Path.Combine(Lists, "Sources", "ListSourceGroups.cs"))
            .Select(f => (Path.GetFileName(f), ListsSourceTransmissionScanTests.Code(File.ReadAllText(f))));

    [Fact]
    public void OnlyTheCompletionStepBuildsACompletedIdentity()
    {
        var constructors = typeof(CompletedIdentity).GetConstructors(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
        Assert.NotEmpty(constructors);
        Assert.All(constructors, c => Assert.True(c.IsPrivate, $"CompletedIdentity has a non-private constructor {c}"));

        var builders = Directory.GetFiles(Root(), "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains(Path.DirectorySeparatorChar + "obj" + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            .Where(f => Regex.IsMatch(ListsSourceTransmissionScanTests.Code(File.ReadAllText(f)), @"new\s+CompletedIdentity\s*\("))
            .Select(Path.GetFileName)
            .ToList();
        Assert.Equal(new[] { "CompletedIdentity.cs" }, builders);
    }

    [Fact]
    public void EveryIdentityConsumerTakesTheCompletedIdentity()
    {
        // "In library": the scope is named only by a completed identity.
        foreach (var constructor in typeof(LibraryScope).GetConstructors().Where(c => !IsCopyConstructor(c)))
        {
            var parameters = constructor.GetParameters();
            Assert.Contains(parameters, p => p.ParameterType == typeof(CompletedIdentity));
            Assert.DoesNotContain(parameters, p => p.Name!.Contains("tmdb", StringComparison.OrdinalIgnoreCase) || p.Name!.Contains("tvdb", StringComparison.OrdinalIgnoreCase) || p.Name!.Contains("imdb", StringComparison.OrdinalIgnoreCase));
        }

        // The physical check.
        Assert.Contains(typeof(IImportPhysicalTitles).GetMethod(nameof(IImportPhysicalTitles.Read))!.GetParameters(), p => p.ParameterType == typeof(CompletedIdentity));
        Assert.Contains(typeof(ImportPhysicalProjection).GetMethod("Read")!.GetParameters(), p => p.ParameterType == typeof(CompletedIdentity));

        // Spoiler Guard.
        Assert.Equal(typeof(Func<CompletedIdentity, bool>), typeof(ImportViewer).GetProperty(nameof(ImportViewer.SpoilerGuarded))!.PropertyType);

        // The candidate carries it (review ids and the placeholder read it); the r2 side channel is gone.
        Assert.Equal(typeof(CompletedIdentity), typeof(ImportCandidateDto).GetProperty("Identity", BindingFlags.Instance | BindingFlags.NonPublic)!.PropertyType);
        Assert.Null(typeof(ImportCandidateDto).GetProperty("EntryIds", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public));

        // The source preview's candidates, scopes, entries and placeholders.
        foreach (var name in new[] { nameof(ListSourceGroups.Candidate), nameof(ListSourceGroups.Scope), nameof(ListSourceGroups.Entry), nameof(ListSourceGroups.Placeholder) })
        {
            Assert.Contains(typeof(ListSourceGroups).GetMethod(name)!.GetParameters(), p => p.ParameterType == typeof(CompletedIdentity));
        }
    }

    [Fact]
    public void ListHostReadsInTheImportPassEveryIdOfTheCompletedIdentity()
    {
        var calls = Consumers()
            .SelectMany(c => Regex.Matches(c.Code, @"\.Find(Series|Movies)\s*\(([^;]*?)\)\s*\.").Select(m => (c.File, Kind: m.Groups[1].Value, Args: Regex.Replace(m.Groups[2].Value, @"\s+", " ").Trim())))
            .ToList();

        Assert.NotEmpty(calls);
        Assert.All(calls, call => Assert.True(
            call.Args == (call.Kind == "Series" ? "identity.Tmdb, identity.Tvdb, identity.Imdb, viewer" : "identity.Tmdb, identity.Imdb, viewer"),
            $"{call.File}: Find{call.Kind}({call.Args}) doesn't ask under every id of the completed identity"));
    }

    [Fact]
    public void TheScanFindsATmdbOnlyListHostRead()
    {
        // Self-test: the shape 4c2-R3-6 had is caught.
        var code = ListsSourceTransmissionScanTests.Code("var x = _host.FindSeries(tmdbId, null, null, viewer).Any(id => true);");
        var match = Regex.Match(code, @"\.Find(Series|Movies)\s*\(([^;]*?)\)\s*\.");
        Assert.True(match.Success);
        Assert.NotEqual("identity.Tmdb, identity.Tvdb, identity.Imdb, viewer", match.Groups[2].Value);
    }

    private static bool IsCopyConstructor(ConstructorInfo constructor) =>
        constructor.GetParameters() is { Length: 1 } p && p[0].ParameterType == constructor.DeclaringType;
}
