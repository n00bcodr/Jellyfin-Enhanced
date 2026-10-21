using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace JE.Tests;

/// <summary>
/// Review round 4: two more ways a cache can keep an answer from before a change, found in the plugin's own source.
/// <list type="bullet">
/// <item><description><see cref="Invalidations"/>: a cache dropped on a write outside the code that fills it (an
/// invalidate-only cache). A reader that read the old state before the write's remove puts it back after; only the ticket
/// protocol (Helpers/InvalidationLedger.cs, behind both helpers) refuses that store. Every such cache must be one of the
/// helpers or be listed with why the race can't happen.</description></item>
/// <item><description><see cref="ReReads"/>: a keyed computation that reads the user (or their policy) by id again after
/// its key was taken from a read of them: a change landing between the two files a decision made for one policy under
/// the key of another.</description></item>
/// </list>
/// </summary>
internal static partial class UserCacheScan
{
    private static readonly HashSet<string> Removals = new(StringComparer.Ordinal) { "Remove", "TryRemove", "Clear", "RemoveAll", "RemoveWhere", "RemoveRange" };

    private static readonly HashSet<string> Stores = new(StringComparer.Ordinal)
    {
        "Add", "AddOrUpdate", "TryAdd", "GetOrAdd", "TryUpdate", "Set", "AddRange", "Insert", "InsertRange", "Push", "Enqueue", "TryEnqueue",
        "UnionWith", "AddFirst", "AddLast", "CreateEntry", "GetOrCreate", "GetOrCreateAsync", "SetItem", "SetItems",
    };

    private enum Use
    {
        None,
        Store,
        Remove,
    }

    /// <summary>A cache dropped outside the code that fills it: where it is dropped, and where it is stored.</summary>
    internal sealed record Drops(string Cache, IReadOnlyList<(ISymbol? Member, SyntaxNode Use, string Where)> Dropped, IReadOnlyList<(ISymbol? Member, SyntaxNode Use)> Stored)
    {
        public string Sites => string.Join(", ", Dropped.Select(d => (d.Member == null ? "?" : Name(d.Member)) + " (" + d.Where + ")").Distinct(StringComparer.Ordinal));
    }

    /// <summary>
    /// For each cache that isn't one of the helpers: where it is dropped outside the code that fills it (a removal, a
    /// clear or a reset to null in a member that stores nothing into it and isn't only called from one that does). A
    /// removal next to the store it makes room for is an eviction, not an invalidation.
    /// </summary>
    internal static Dictionary<string, Drops> Invalidations(WriteGateWalk plugin, IEnumerable<Cache> caches)
    {
        var found = new Dictionary<string, Drops>(StringComparer.Ordinal);
        foreach (var cache in caches)
        {
            if (cache.Symbol is not { } symbol || cache.Ticketed) continue;
            var uses = new List<(Use Kind, ISymbol? Member, SyntaxNode Use, string Where)>();
            foreach (var (name, model) in Names(plugin, symbol))
            {
                var member = Enclosing(name, model);
                var kind = Classify(name, model, symbol);
                if (kind == Use.Remove && member is IMethodSymbol { MethodKind: MethodKind.Constructor or MethodKind.StaticConstructor }) kind = Use.None;
                if (kind != Use.None) uses.Add((kind, member, name, Where(name)));
            }

            var storing = uses.Where(u => u.Kind == Use.Store && u.Member != null).Select(u => u.Member!).ToHashSet(SymbolEqualityComparer.Default);
            var dropped = uses.Where(u => u.Kind == Use.Remove && (u.Member == null || (!storing.Contains(u.Member) && !OnlyCalledFrom(plugin, u.Member, storing))))
                .Select(u => (u.Member, u.Use, u.Where)).ToList();
            if (dropped.Count > 0) found[cache.Member] = new Drops(cache.Member, dropped, uses.Where(u => u.Kind == Use.Store).Select(u => (u.Member, u.Use)).ToList());
        }

        return found;
    }

    /// <summary>The write dispositions a cache dropped outside its fill code may have (see the registry's README).</summary>
    internal static readonly string[] WriteClasses = ["fenced", "locked", "self-keyed", "own-state", "per-call", "disposal", "evicts"];

    /// <summary>
    /// What is wrong with a dropped cache's disposition: <c>fenced=&lt;generation&gt;</c> needs every member that drops
    /// it to use that generation (the drop bumps it) and the code that stores into it to compare it (at least one storing
    /// member; the reason says why any other store can't keep a stale answer); <c>locked=&lt;lock&gt;</c> needs every store
    /// and every drop inside <c>lock (&lt;lock&gt;)</c>, or in a member only ever called inside it.
    /// </summary>
    internal static List<string> CheckWrite(WriteGateWalk plugin, Drops drops, string write)
    {
        var problems = new List<string>();
        var (kind, arg) = (write.Split('=')[0], write.Contains('=') ? write[(write.IndexOf('=') + 1)..] : string.Empty);
        if (!WriteClasses.Contains(kind))
        {
            problems.Add(drops.Cache + ": unknown write disposition " + write);
            return problems;
        }

        static string Text(ISymbol? member) => member?.DeclaringSyntaxReferences.Select(r => r.GetSyntax().ToString()).FirstOrDefault() ?? string.Empty;
        if (kind == "fenced")
        {
            foreach (var member in drops.Dropped.Select(d => d.Member).Distinct(SymbolEqualityComparer.Default))
            {
                if (arg.Length == 0 || !Text(member).Contains(arg, StringComparison.Ordinal))
                    problems.Add(drops.Cache + ": fenced by " + arg + ", but " + (member == null ? "?" : Name(member)) + " drops it without it");
            }

            // The comparison: in a member that stores it, or (an answer written into a slot it holds) in another member of
            // its type that doesn't drop it.
            var dropping = drops.Dropped.Select(d => d.Member).Where(m => m != null).ToHashSet(SymbolEqualityComparer.Default);
            var owner = drops.Dropped.Select(d => d.Member?.ContainingType).FirstOrDefault(t => t != null);
            var compared = drops.Stored.Any(s => Text(s.Member).Contains(arg, StringComparison.Ordinal))
                || (owner?.GetMembers().Any(m => !dropping.Contains(m) && Text(m).Contains(arg, StringComparison.Ordinal) && !m.Name.Equals(arg, StringComparison.Ordinal)) ?? false);
            if (arg.Length > 0 && !compared) problems.Add(drops.Cache + ": fenced by " + arg + ", but nothing compares it");
        }

        if (kind == "locked")
        {
            // Inside the lock, or in a helper only ever called (through helpers, a few levels) inside it.
            bool Inside(SyntaxNode node, int depth)
            {
                if (node.Ancestors().OfType<LockStatementSyntax>().Any(l => l.Expression.ToString() == arg)) return true;
                if (depth == 0) return false;
                var member = Enclosing(node, plugin.ModelOf(node.SyntaxTree));
                var callers = member is IMethodSymbol ? plugin.References(member).ToList() : [];
                return callers.Count > 0 && callers.All(c => Inside(c.Use, depth - 1));
            }

            foreach (var use in drops.Dropped.Select(d => d.Use).Concat(drops.Stored.Select(s => s.Use)))
            {
                if (arg.Length > 0 && Inside(use, 3)) continue;
                problems.Add(drops.Cache + ": locked by " + arg + ", but " + Where(use) + " drops or stores it outside that lock");
            }
        }

        return problems;
    }

    // What one use of the cache does to it.
    private static Use Classify(SimpleNameSyntax name, SemanticModel model, ISymbol cache)
    {
        SyntaxNode node = name.Parent switch
        {
            MemberAccessExpressionSyntax { Name: var accessed } qualified when accessed == name => qualified,
            MemberBindingExpressionSyntax { Parent: ConditionalAccessExpressionSyntax conditional } bound when conditional.WhenNotNull == bound => conditional,
            _ => name,
        };
        var parent = node.Parent;
        string? called = parent switch
        {
            MemberAccessExpressionSyntax access when access.Expression == node && access.Parent is InvocationExpressionSyntax => access.Name.Identifier.ValueText,
            ConditionalAccessExpressionSyntax { WhenNotNull: InvocationExpressionSyntax { Expression: MemberBindingExpressionSyntax binding } } conditional when conditional.Expression == node => binding.Name.Identifier.ValueText,
            _ => null,
        };
        if (called != null) return Removals.Contains(called) ? Use.Remove : Stores.Contains(called) ? Use.Store : Use.None;
        if (parent is ElementAccessExpressionSyntax element && element.Expression == node)
        {
            if (element.Parent is AssignmentExpressionSyntax assigned && assigned.Left == element) return Use.Store;
            if (element.Parent is MemberAccessExpressionSyntax onElement && onElement.Expression == element && Mutators.Contains(onElement.Name.Identifier.ValueText)) return Use.Store;
            return Use.None;
        }

        if (parent is AssignmentExpressionSyntax assignment && assignment.Left == node)
        {
            if (node.FirstAncestorOrSelf<ConstructorDeclarationSyntax>() != null) return Use.None;
            var right = assignment.Right;
            while (right is ParenthesizedExpressionSyntax inner) right = inner.Expression;
            if (right is LiteralExpressionSyntax { RawKind: (int)SyntaxKind.NullLiteralExpression or (int)SyntaxKind.DefaultLiteralExpression } or DefaultExpressionSyntax) return Use.Remove;
            // `_x = _x.Remove(k)` on an immutable collection: a removal.
            if (right is InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax swapped } && Removals.Contains(swapped.Name.Identifier.ValueText)) return Use.Remove;
            // `_x = SomeType.Empty` / an empty collection: a reset.
            if (right is MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Empty" }) return Use.Remove;
            return Use.Store;
        }

        if (parent is ArgumentSyntax argument && !argument.RefKindKeyword.IsKind(SyntaxKind.None) && argument.Parent is ArgumentListSyntax list)
        {
            var value = list.Arguments.ElementAtOrDefault(list.Arguments.IndexOf(argument) + 1)?.Expression;
            return value is LiteralExpressionSyntax { RawKind: (int)SyntaxKind.NullLiteralExpression } ? Use.Remove : Use.Store;
        }

        return Use.None;
    }

    // The method, constructor, accessor or property a use is in (lambdas and local functions belong to it).
    private static ISymbol? Enclosing(SyntaxNode node, SemanticModel model)
    {
        foreach (var ancestor in node.Ancestors())
        {
            switch (ancestor)
            {
                case BaseMethodDeclarationSyntax method:
                    return model.GetDeclaredSymbol(method);
                case AccessorDeclarationSyntax { Parent.Parent: BasePropertyDeclarationSyntax property }:
                    return model.GetDeclaredSymbol(property);
                case BasePropertyDeclarationSyntax property:
                    return model.GetDeclaredSymbol(property);
                case FieldDeclarationSyntax field:
                    return field.Declaration.Variables.Select(v => model.GetDeclaredSymbol(v)).FirstOrDefault();
            }
        }

        return null;
    }

    // Every call of the member in the plugin is inside one of the given members (an eviction helper of a store).
    private static bool OnlyCalledFrom(WriteGateWalk plugin, ISymbol member, HashSet<ISymbol> storing)
    {
        if (member is not IMethodSymbol || storing.Count == 0) return false;
        var callers = plugin.References(member).Select(r => Enclosing(r.Use, r.Model)).ToList();
        return callers.Count > 0 && callers.All(c => c != null && storing.Contains(c));
    }

    /// <summary>A keyed cache: its member, the types whose code computes what it holds, and the reads by id allowed
    /// ("Type.Member=Reader": where the key's snapshot itself is read, or a gate that re-reads and answers only when
    /// unchanged), each at most once in its member.</summary>
    internal sealed record Keyed(string Cache, IReadOnlyList<string> Types, IReadOnlySet<string> Snapshot);

    /// <summary>One read by id inside a keyed computation: the member it starts from, the path to it, the reader.</summary>
    internal sealed record ReRead(string Cache, string Member, string Via, string Reader, string Where)
    {
        public override string ToString()
            => Cache + ": " + Via + " reads the user by id (" + Reader + ", " + Where + ") inside a keyed computation; decide with the read its key was taken from";
    }

    /// <summary>
    /// Every read of a user or their policy by id inside a keyed computation: in the code of the cache's types, and in every
    /// plugin method, constructor or accessor called from there (transitively), except in the members its snapshot is
    /// read in. Calls through an interface or a delegate aren't followed (lambdas written in those types are their code).
    /// </summary>
    internal static List<string> ReReads(WriteGateWalk plugin, IEnumerable<Keyed> keyed)
    {
        var problems = new List<string>();
        foreach (var cache in keyed)
        {
            var found = ReReadsOf(plugin, cache);
            foreach (var read in found)
            {
                // Its snapshot's own read (in the cache's member), or the read of a gate the row names (a member that answers
                // only when the viewer is unchanged, called from the computation): made directly in that gate member.
                var gate = read.Via.Split(" → ")[^1];
                var allowed = (read.Via == read.Member ? cache.Snapshot.Contains(read.Member + "=" + read.Reader) : cache.Snapshot.Contains(gate + "=" + read.Reader))
                    && found.Count(r => r.Via == read.Via && r.Reader == read.Reader) == 1;
                if (!allowed) problems.Add(read.ToString());
            }
        }

        return problems;
    }

    private static List<ReRead> ReReadsOf(WriteGateWalk plugin, Keyed cache)
    {
        var found = new List<ReRead>();
        var declarations = plugin.Sources().SelectMany(s => s.Tree.GetRoot().DescendantNodes().OfType<TypeDeclarationSyntax>().Select(t => (Type: t, s.Model))).ToList();
        {
            var visited = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
            var pending = new Queue<(SyntaxNode Body, SemanticModel Model, string Via)>();
            foreach (var (type, model) in declarations)
            {
                if (model.GetDeclaredSymbol(type) is not { } symbol || !cache.Types.Contains(Name(symbol))) continue;
                foreach (var member in type.Members.Where(m => m is not BaseTypeDeclarationSyntax))
                {
                    var declared = member is FieldDeclarationSyntax field ? field.Declaration.Variables.Select(v => model.GetDeclaredSymbol(v)).FirstOrDefault() : model.GetDeclaredSymbol(member);
                    if (declared == null) continue;
                    visited.Add(declared);
                    pending.Enqueue((member, model, Name(declared)));
                }
            }

            while (pending.Count > 0)
            {
                var (body, model, via) = pending.Dequeue();
                foreach (var call in body.DescendantNodesAndSelf().OfType<InvocationExpressionSyntax>())
                {
                    if (model.GetSymbolInfo(call).Symbol is not IMethodSymbol method) continue;
                    method = method.ReducedFrom ?? method;
                    if (ReadsById(method))
                    {
                        found.Add(new ReRead(cache.Cache, via.Split(" → ")[0], via, Name(method.OriginalDefinition), Where(call)));
                        continue;
                    }

                    var target = method.OriginalDefinition;
                    if (target.DeclaringSyntaxReferences.Length == 0 || !visited.Add(target)) continue;
                    foreach (var reference in target.DeclaringSyntaxReferences)
                    {
                        var declaration = reference.GetSyntax();
                        if (declaration.SyntaxTree.FilePath == "ImplicitUsings.cs") continue;
                        pending.Enqueue((declaration, plugin.ModelOf(declaration.SyntaxTree), via + " → " + Name(target)));
                    }
                }
            }
        }

        return found;
    }

    private const string Services = "Jellyfin.Plugin.JellyfinEnhanced.Services.";

    // A read of the user, or of their policy, by id: the host's lookup, JE's caller lookup and per-request read, the arr
    // view's viewer, the held user caches, and the parental filter's overloads that take a user id.
    private static bool ReadsById(IMethodSymbol method)
    {
        var owner = method.ContainingType.OriginalDefinition.ToDisplayString();
        return (owner, method.Name) switch
        {
            ("MediaBrowser.Controller.Library.IUserManager", "GetUserById") => true,
            ("Jellyfin.Plugin.JellyfinEnhanced.Helpers.ArrCaller", "Find") => true,
            ("Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserAuthority", "ReadOncePerRequest") => true,
            (Services + "Acquire.IArrJellyfinView", "Viewer") => true,
            (Services + "Acquire.ArrJellyfinView", "Viewer") => true,
            (Services + "PosterTags.PosterTagUserCache", "Get" or "GetStamped") => true,
            (Services + "ReviewAuthorCache", "Resolve") => true,
            (Services + "SeerrParentalFilter", _) => method.Parameters.Any(p => p.Type.SpecialType == SpecialType.System_String && p.Name.Contains("user", StringComparison.OrdinalIgnoreCase)),
            _ => false,
        };
    }
}
