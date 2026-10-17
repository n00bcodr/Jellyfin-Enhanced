using System.Reflection;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;

namespace JE.Tests;

// Review round 2 (4c1, BY DESIGN (f)): no list write to Jellyfin and no answer with list contents can skip the one
// list access gate (ListGate). Jellyfin's writes take a single-use ListWrite only the gate makes, as an inline argument
// (so nothing can be awaited between the check and the write); views are built only from a ListGrant inside the gate's
// projection; the person's asks, document saves and answers come right after a gate call with no await in between.
public class ListsGateSourceTests
{
    private static readonly Assembly Plugin = typeof(ListService).Assembly;

    private static Type Required(string name) =>
        Plugin.GetType("Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists." + name) ?? throw new Xunit.Sdk.XunitException(name + " does not exist");

    [Fact]
    public void EveryJellyfinWriteOfTheListHostTakesAGateGrantFirst()
    {
        var write = Required("ListWrite");
        var writes = typeof(IListHost).GetMethods().Where(m => typeof(Task).IsAssignableFrom(m.ReturnType)).ToList();
        Assert.NotEmpty(writes);
        foreach (var method in writes)
        {
            var first = method.GetParameters().FirstOrDefault();
            Assert.True(first?.ParameterType == write, $"IListHost.{method.Name} writes to Jellyfin without a ListWrite first");
        }

        Assert.Contains(writes, m => m.Name == "AddToPlaylistAsync");
        Assert.Contains(writes, m => m.Name == "MoveInPlaylistAsync");
        Assert.Contains(writes, m => m.Name == "AddToCollectionAsync");
        Assert.Contains(writes, m => m.Name == "CreatePlaylistAsync");
        Assert.Contains(writes, m => m.Name == "CreateCollectionAsync");
        // Who a write runs as comes from the grant, never from a parameter of its own.
        Assert.All(writes, m => Assert.DoesNotContain(m.GetParameters(), p => p.Name is "userId" or "ownerId"));
    }

    [Fact]
    public void OnlyTheGateMakesGrantsAndOnlyAGrantMakesAView()
    {
        foreach (var name in new[] { "ListWrite", "ListGrant" })
        {
            Assert.Empty(Required(name).GetConstructors(BindingFlags.Public | BindingFlags.Instance));
        }

        var grant = Required("ListGrant");
        var builders = typeof(ListService).GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)
            .Where(m => m.ReturnType == typeof(ListViewDto))
            .ToList();
        var build = Assert.Single(builders);
        Assert.Equal("BuildView", build.Name);
        Assert.True(build.IsPrivate);
        Assert.Equal(grant, build.GetParameters()[0].ParameterType);

        // The one public view: the gated projection (the raw GetViewAsync is gone).
        var views = typeof(ListService).GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .Where(m => m.ReturnType.IsGenericType && m.ReturnType.GetGenericArguments()[0] == typeof(ListViewDto))
            .Select(m => m.Name)
            .ToList();
        Assert.Equal(new[] { "ViewAsync" }, views);

        foreach (var (file, source) in Sources())
        {
            if (Path.GetFileName(file) != "ListGate.cs")
            {
                Assert.DoesNotMatch(new Regex(@"new\s+List(Write|Grant)\s*\("), source);
            }

            if (Path.GetFileName(file) != "ListService.cs")
            {
                Assert.DoesNotMatch(new Regex(@"new\s+ListViewDto\b"), source);
            }
        }
    }

    [Fact]
    public void EveryJellyfinWriteGetsItsGrantInlineFromTheGate()
    {
        var calls = 0;
        foreach (var (file, source) in Sources())
        {
            foreach (Match call in Regex.Matches(source, @"\.(AddToPlaylistAsync|MoveInPlaylistAsync|AddToCollectionAsync|CreatePlaylistAsync|CreateCollectionAsync|ClearCreateMarkerAsync)\("))
            {
                var argument = FirstArgument(source, call.Index + call.Length);
                if (Path.GetFileName(file) == "ListHost.cs")
                {
                    // The seam itself: each of Jellyfin's own manager calls spends the grant it was given first.
                    var method = EnclosingMethod(source, call.Index);
                    Assert.True(
                        source[method.Start..call.Index].Contains("write.Spend(", StringComparison.Ordinal),
                        $"ListHost.cs:{Line(source, call.Index)} ({method.Name}) writes to Jellyfin without spending its grant first");
                    continue;
                }

                calls++;
                Assert.True(
                    Regex.IsMatch(argument, @"^\s*(_gate!?\.\w+|write)\(") && !argument.Contains("await", StringComparison.Ordinal),
                    $"{Path.GetFileName(file)}:{Line(source, call.Index)} {call.Groups[1].Value} takes \"{argument.Trim()}\", not a grant made right there by the gate");
            }
        }

        Assert.True(calls >= 6, $"only {calls} Jellyfin writes found");
    }

    [Fact]
    public void ViewsAreBuiltOnlyInsideTheGatesProjection()
    {
        var source = File.ReadAllText(Path.Combine(ListsDir(), "ListService.cs"));
        var builds = 0;
        foreach (Match call in Regex.Matches(source, @"(?<!ListViewDto\s)\bBuildView\("))
        {
            builds++;
            var before = source[Math.Max(0, call.Index - 300)..call.Index];
            var statement = before[(before.LastIndexOf(';') + 1)..];
            Assert.True(
                statement.Contains("ProjectAsync(", StringComparison.Ordinal) && FirstArgument(source, call.Index + call.Length).Trim() == "grant",
                $"ListService.cs:{Line(source, call.Index)} builds a view outside the gate's projection");
        }

        Assert.True(builds >= 5, $"only {builds} view builds found");
    }

    // The person's effects that aren't Jellyfin writes: an ask, and a saved list document. Each comes after a gate call
    // in the same method with no await in between.
    [Theory]
    [InlineData("ListAcquisition.cs", @"_requests\.CreateAsync\(")]
    [InlineData("ListService.cs", @"(?<!private ListDoc\? )\bSaveIfChanged\(|_store\.Save\(")]
    public void EveryOtherEffectComesRightAfterAGateCall(string file, string effect)
    {
        var source = File.ReadAllText(Path.Combine(ListsDir(), file));
        var effects = 0;
        foreach (Match call in Regex.Matches(source, effect))
        {
            var method = EnclosingMethod(source, call.Index);
            if (file == "ListService.cs" && method.Name is "ProjectAsync" or "Reconciled" or "SaveIfChanged")
            {
                continue; // a view's own reconciliation of Jellyfin's order, and the helper itself
            }

            effects++;
            var body = source[method.Start..call.Index];
            // A gate call, or CheckedAsync (ListService: the awaited parental lookups, then the gate as its last step).
            var gate = Math.Max(body.LastIndexOf("_gate.", StringComparison.Ordinal), body.LastIndexOf("CheckedAsync(", StringComparison.Ordinal));
            Assert.True(gate >= 0, $"{file}:{Line(source, call.Index)} ({method.Name}) has no gate call before it");
            // From the gate call to the end of the last statement before the effect's own (which may itself be awaited).
            // A branch that answers and leaves ("return await …") never reaches the effect.
            var between = body[gate..];
            between = Regex.Replace(between[..(between.LastIndexOf(';') + 1)], @"\breturn\s+await\b", "return");
            Assert.False(Regex.IsMatch(between, @"\bawait\b"), $"{file}:{Line(source, call.Index)} ({method.Name}) awaits between the gate and the effect");
        }

        Assert.True(effects > 0, "no effects found");
    }

    // CheckedAsync, which the rule above counts as a gate call: every answer it gives with an access comes right after the
    // gate, with no await in between.
    [Fact]
    public void CheckedAsyncEndsWithTheGate()
    {
        var source = File.ReadAllText(Path.Combine(ListsDir(), "ListService.cs"));
        var start = source.IndexOf("private async Task<CheckedWrite> CheckedAsync(", StringComparison.Ordinal);
        Assert.True(start >= 0);
        var end = source.IndexOf("private sealed record CheckedWrite(", start, StringComparison.Ordinal);
        var body = source[start..end];
        var granted = body.IndexOf("return new CheckedWrite(null, current", StringComparison.Ordinal);
        Assert.True(granted > 0);
        var before = body[..granted];
        var between = before[before.LastIndexOf("_gate.Edit(", StringComparison.Ordinal)..];
        Assert.DoesNotMatch(new Regex(@"\bawait\b"), between);
    }

    private static string ListsDir() => Path.Combine(Root(), "Jellyfin.Plugin.JellyfinEnhanced", "Services", "Acquire", "Lists");

    private static IEnumerable<(string File, string Source)> Sources()
    {
        foreach (var file in Directory.GetFiles(ListsDir(), "*.cs"))
        {
            yield return (file, File.ReadAllText(file));
        }

        var controller = Path.Combine(Root(), "Jellyfin.Plugin.JellyfinEnhanced", "Controllers", "AcquireListsController.cs");
        yield return (controller, File.ReadAllText(controller));
    }

    // The text of a call's first argument, from just after its opening parenthesis to the first top-level comma.
    private static string FirstArgument(string source, int start)
    {
        var depth = 0;
        for (var i = start; i < source.Length; i++)
        {
            var c = source[i];
            if (c is '(' or '[' or '{')
            {
                depth++;
            }
            else if (c is ')' or ']' or '}')
            {
                if (depth == 0)
                {
                    return source[start..i];
                }

                depth--;
            }
            else if (c == ',' && depth == 0)
            {
                return source[start..i];
            }
        }

        return source[start..];
    }

    // The member that contains an index: the last method declaration before it (name and where its body starts).
    private static (string Name, int Start) EnclosingMethod(string source, int index)
    {
        var declarations = Regex.Matches(source[..index], @"\n\s{8}(?:public|private|internal|protected)[^\n;=]*?\s(\w+)(?:<[^>\n]*>)?\([^;]*?\)\s*(?:where[^\n{]*)?\n\s{8}\{");
        Assert.NotEmpty(declarations);
        var last = declarations[^1];
        return (last.Groups[1].Value, last.Index + last.Length);
    }

    private static int Line(string source, int index) => source[..index].Count(c => c == '\n') + 1;

    // The repository: found from this test file's own path (the tests may run from a build folder anywhere).
    private static string Root([System.Runtime.CompilerServices.CallerFilePath] string here = "")
    {
        var root = new DirectoryInfo(Path.GetDirectoryName(here) ?? AppContext.BaseDirectory);
        while (root != null && !Directory.Exists(Path.Combine(root.FullName, "Jellyfin.Plugin.JellyfinEnhanced", "Services")))
        {
            root = root.Parent;
        }

        Assert.NotNull(root);
        return root!.FullName;
    }
}
