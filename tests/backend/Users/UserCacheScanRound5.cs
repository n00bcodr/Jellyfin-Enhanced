using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace JE.Tests;

/// <summary>
/// Review round 5: a deadline or a fence must be taken before the inputs it covers are read, found in the plugin's own
/// source.
/// <list type="bullet">
/// <item><description><see cref="LateStamps"/>: an answer kept in a cache stamped with the time it CAME IN (a clock read in
/// the store, after an await of its member): it lives longer than its read by however long the read took (a 59-second
/// reply kept a minute lives two). The lifetime starts when the read began, never later.</description></item>
/// <item><description><see cref="LateFences"/>: a cache fenced by a generation that samples it after it has read its inputs
/// (the configuration, or anything it awaited): a drop between that read and the sample is invisible to the store, which
/// then keeps an answer from the configuration before the drop.</description></item>
/// </list>
/// </summary>
internal static partial class UserCacheScan
{
    private static readonly string[] ClockReads = ["DateTime.UtcNow", "DateTimeOffset.UtcNow", "DateTime.Now", "DateTimeOffset.Now", "_now()", "MonotonicClock.Now()"];

    /// <summary>A store that stamps what it keeps with the time it came in: where, and which clock read.</summary>
    internal sealed record LateStamp(string Cache, string Member, string Where, string Clock)
    {
        public override string ToString()
            => Cache + ": " + Member + " (" + Where + ") stamps what it keeps with " + Clock + " after awaiting its read: it lives from when the answer came in, not from when the read began; take the time before the read";
    }

    /// <summary>
    /// For each cache that isn't one of the helpers: every store into it (or into a value it holds: <c>entry.At = …</c> on
    /// its element type) whose statement reads a clock inline after an <c>await</c> of the same function (method, lambda or
    /// local function).
    /// </summary>
    internal static List<LateStamp> LateStamps(WriteGateWalk plugin, IEnumerable<Cache> caches)
    {
        var found = new List<LateStamp>();
        foreach (var cache in caches)
        {
            if (cache.Symbol is not { } symbol || cache.Ticketed) continue;
            var sites = new List<SyntaxNode>();
            foreach (var (name, model) in Names(plugin, symbol))
            {
                if (Classify(name, model, symbol) == Use.Store) sites.Add(name);
            }

            // A value the cache holds, changed in place (entry.At = clock): its element type's members assigned.
            var element = (symbol switch { IFieldSymbol f => f.Type, IPropertySymbol p => p.Type, _ => null }) as INamedTypeSymbol;
            var held = element?.TypeArguments.LastOrDefault() as INamedTypeSymbol;
            if (held != null && held.Locations.Any(l => l.IsInSource))
            {
                foreach (var (tree, model) in plugin.Sources())
                {
                    foreach (var assignment in tree.GetRoot().DescendantNodes().OfType<AssignmentExpressionSyntax>())
                    {
                        if (assignment.Left is MemberAccessExpressionSyntax access
                            && SymbolEqualityComparer.Default.Equals(model.GetTypeInfo(access.Expression).Type, held)
                            && assignment.FirstAncestorOrSelf<ConstructorDeclarationSyntax>() == null)
                            sites.Add(assignment);
                    }
                }
            }

            foreach (var site in sites)
            {
                var statement = site.FirstAncestorOrSelf<StatementSyntax>();
                if (statement == null) continue;
                var text = statement.ToString();
                var clock = ClockReads.FirstOrDefault(c => text.Contains(c, StringComparison.Ordinal));
                if (clock == null) continue;
                var function = site.Ancestors().FirstOrDefault(a => a is BaseMethodDeclarationSyntax or AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax or AccessorDeclarationSyntax);
                if (function == null) continue;
                var awaited = function.DescendantNodes().OfType<AwaitExpressionSyntax>()
                    .Any(a => a.Span.End <= statement.SpanStart && a.Ancestors().FirstOrDefault(x => x is BaseMethodDeclarationSyntax or AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax or AccessorDeclarationSyntax) == function);
                if (!awaited) continue;
                var member = Enclosing(site, plugin.ModelOf(site.SyntaxTree));
                found.Add(new LateStamp(cache.Member, member == null ? "?" : Name(member), Where(site), clock));
            }
        }

        return found;
    }

    // Reads of the plugin's configuration (the inputs a Seerr or TMDB answer is read with).
    private static readonly string[] ConfigurationReads = ["JellyfinEnhanced.Instance", ".Configuration", "_config()", "GetJellyseerrApiKey()"];

    /// <summary>
    /// For a cache fenced by <paramref name="generation"/>: every function that samples it (<c>Interlocked.Read(ref g)</c>,
    /// <c>Volatile.Read(ref g)</c>) must do so before its first <c>await</c> and before its first read of the plugin's
    /// configuration. A function that is handed the sample (a parameter of that name) is checked at its callers.
    /// </summary>
    internal static List<string> LateFences(WriteGateWalk plugin, string cache, string generation)
    {
        var problems = new List<string>();
        foreach (var (tree, model) in plugin.Sources())
        {
            foreach (var invocation in tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>())
            {
                if (invocation.Expression is not MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Read" } read
                    || read.Expression.ToString() is not ("Interlocked" or "Volatile")
                    || invocation.ArgumentList.Arguments.FirstOrDefault() is not { RefKindKeyword.RawKind: (int)SyntaxKind.RefKeyword } argument
                    || !argument.Expression.ToString().EndsWith(generation, StringComparison.Ordinal))
                    continue;
                // A comparison at the store (generation == Interlocked.Read(ref g)) is the check, not the sample.
                if (invocation.Parent is BinaryExpressionSyntax) continue;
                // The cache's own generation (another type's field of the same name is another fence).
                var owner = Enclosing(invocation, model)?.ContainingType;
                if (owner == null || !cache.StartsWith(Name(owner) + ".", StringComparison.Ordinal)) continue;
                var function = invocation.Ancestors().FirstOrDefault(a => a is BaseMethodDeclarationSyntax or AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax);
                if (function == null) continue;
                var before = function.DescendantNodes().Where(n => n.Span.End <= invocation.SpanStart).ToList();
                // Waiting for a slot or a lock reads nothing.
                var late = before.OfType<AwaitExpressionSyntax>().FirstOrDefault(a => !a.ToString().Contains("WaitAsync(", StringComparison.Ordinal) && !a.ToString().Contains("AwaitLock(", StringComparison.Ordinal))?.ToString()
                    ?? before.OfType<ExpressionSyntax>().Select(e => e.ToString()).FirstOrDefault(e => e.Length < 80 && ConfigurationReads.Any(c => e.EndsWith(c, StringComparison.Ordinal)));
                if (late == null) continue;
                var member = Enclosing(invocation, model);
                problems.Add(cache + ": fenced by " + generation + ", but " + (member == null ? "?" : Name(member)) + " (" + Where(invocation) + ") samples it after reading its inputs (" + late
                    + "): a drop in between is missed and the answer of the old configuration is kept; sample it first");
            }
        }

        return problems;
    }
}
