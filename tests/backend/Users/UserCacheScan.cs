using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace JE.Tests;

/// <summary>
/// Every cache the plugin keeps, found in its own source by syntax and symbols (<see cref="WriteGateWalk"/>'s compilation):
/// every field and every auto-property without a public setter, static or not, in any type, whose type holds state across
/// calls (a dictionary, set, list, queue, MemoryCache, ConditionalWeakTable or Lazy memo, a tuple, nullable or array of one,
/// a type deriving from one, a held Jellyfin user, or the access-stamp helper), and every mutable field named for a user or
/// viewer. Left out only: a read-only table that nothing writes after it is made (no mutating call, no element assignment,
/// never handed to a parameter that could change it), which can't hold anything a request computed.
/// <para>
/// Whether a cache is keyed by a user isn't guessed from its key type: every cache found must be listed in
/// tests/fixtures/user-caches.tsv, either <c>stamped</c> (declared as the access-stamp helper,
/// Helpers/UserAccessCache.cs) or <c>independent</c> with the reason it doesn't depend on a user's access.
/// </para>
/// </summary>
internal static class UserCacheScan
{
    /// <summary>One cache: "Type.member" (nested types dotted), its declared type, where.</summary>
    internal sealed record Cache(string Member, string Type, string Where, bool Stamped);

    private static readonly string[] Containers =
    [
        "System.Collections.Concurrent.",
        "System.Collections.Generic.Dictionary<",
        "System.Collections.Generic.SortedDictionary<",
        "System.Collections.Generic.SortedList<",
        "System.Collections.Generic.HashSet<",
        "System.Collections.Generic.SortedSet<",
        "System.Collections.Generic.List<",
        "System.Collections.Generic.LinkedList<",
        "System.Collections.Generic.Queue<",
        "System.Collections.Generic.Stack<",
        "System.Collections.Generic.PriorityQueue<",
        "System.Collections.Generic.IDictionary<",
        "System.Collections.Generic.IReadOnlyDictionary<",
        "System.Collections.Generic.ISet<",
        "System.Collections.Generic.IReadOnlySet<",
        "System.Collections.Generic.IList<",
        "System.Collections.Generic.IReadOnlyList<",
        "System.Collections.Generic.ICollection<",
        "System.Collections.Generic.IReadOnlyCollection<",
        "System.Collections.Generic.IEnumerable<",
        "System.Collections.Immutable.",
        "System.Collections.Frozen.",
        "System.Collections.Hashtable",
        "System.Collections.ArrayList",
        "System.Collections.Specialized.",
        "System.Runtime.CompilerServices.ConditionalWeakTable<",
        "System.Lazy<",
        "Microsoft.Extensions.Caching.Memory.",
    ];

    // Always state, whatever the declaration says: made to be written at run time.
    private static readonly string[] Mutable =
    [
        "System.Collections.Concurrent.",
        "System.Runtime.CompilerServices.ConditionalWeakTable<",
        "System.Lazy<",
        "Microsoft.Extensions.Caching.Memory.",
    ];

    // Read-only views: a readonly field of one of these can't be written through.
    private static readonly string[] ReadOnlyViews =
    [
        "System.Collections.Generic.IReadOnlyDictionary<",
        "System.Collections.Generic.IReadOnlySet<",
        "System.Collections.Generic.IReadOnlyList<",
        "System.Collections.Generic.IReadOnlyCollection<",
        "System.Collections.Generic.IEnumerable<",
        "System.Collections.Immutable.",
        "System.Collections.Frozen.",
    ];

    private static readonly HashSet<string> Mutators = new(StringComparer.Ordinal)
    {
        "Add", "AddOrUpdate", "TryAdd", "GetOrAdd", "TryUpdate", "Remove", "TryRemove", "Clear", "Set", "CreateEntry",
        "GetOrCreate", "GetOrCreateAsync", "Compact", "Enqueue", "TryEnqueue", "Dequeue", "TryDequeue", "Push", "Pop", "TryPop",
        "TryTake", "Take", "Insert", "InsertRange", "AddRange", "RemoveAll", "RemoveAt", "RemoveRange", "RemoveWhere", "Sort",
        "Reverse", "AddFirst", "AddLast", "AddBefore", "AddAfter", "RemoveFirst", "RemoveLast", "UnionWith", "ExceptWith",
        "IntersectWith", "SymmetricExceptWith", "TrimExcess", "EnsureCapacity", "AddOrUpdateRange", "CopyTo",
    };

    internal const string Helper = "Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserAccessCache<";

    /// <summary>Every cache in <paramref name="plugin"/> (see the class summary).</summary>
    internal static List<Cache> Caches(WriteGateWalk plugin)
    {
        var found = new List<Cache>();
        foreach (var (tree, model) in plugin.Sources())
        {
            foreach (var declaration in tree.GetRoot().DescendantNodes().OfType<MemberDeclarationSyntax>())
            {
                switch (declaration)
                {
                    case FieldDeclarationSyntax field when !field.Modifiers.Any(SyntaxKind.ConstKeyword):
                        foreach (var variable in field.Declaration.Variables)
                        {
                            if (model.GetDeclaredSymbol(variable) is IFieldSymbol symbol && Holds(plugin, symbol, symbol.Type, symbol.IsReadOnly, variable.Initializer?.Value))
                                found.Add(Of(symbol, symbol.Type, variable));
                        }

                        break;
                    case PropertyDeclarationSyntax property when model.GetDeclaredSymbol(property) is IPropertySymbol symbol && Auto(property)
                        && symbol.SetMethod is not { DeclaredAccessibility: Accessibility.Public or Accessibility.Internal } && symbol.SetMethod is not { IsInitOnly: true }:
                        if (Holds(plugin, symbol, symbol.Type, symbol.SetMethod == null, property.Initializer?.Value)) found.Add(Of(symbol, symbol.Type, property));
                        break;
                }
            }
        }

        return found.OrderBy(c => c.Member, StringComparer.Ordinal).ToList();
    }

    private static bool Auto(PropertyDeclarationSyntax property)
        => property.AccessorList != null && property.AccessorList.Accessors.All(a => a.Body == null && a.ExpressionBody == null);

    private static Cache Of(ISymbol symbol, ITypeSymbol type, SyntaxNode at)
    {
        var span = at.GetLocation().GetLineSpan();
        var root = IntegrationAutoRequestLedgerTests.Root();
        var file = Path.GetRelativePath(Path.Combine(root, "Jellyfin.Plugin.JellyfinEnhanced"), span.Path).Replace(Path.DirectorySeparatorChar, '/');
        return new Cache(Name(symbol), type.ToDisplayString(), file + ":" + (span.StartLinePosition.Line + 1).ToString(System.Globalization.CultureInfo.InvariantCulture), Is(type, Helper));
    }

    /// <summary>"Outer.Inner.member".</summary>
    internal static string Name(ISymbol symbol)
    {
        var parts = new List<string> { symbol.Name };
        for (var type = symbol.ContainingType; type != null; type = type.ContainingType) parts.Insert(0, type.Name);
        return string.Join('.', parts);
    }

    private static bool Holds(WriteGateWalk plugin, ISymbol member, ITypeSymbol type, bool readOnly, ExpressionSyntax? initializer)
    {
        if (member.IsImplicitlyDeclared) return false;
        if (Contains(type, Helper) || HoldsUser(type, new HashSet<ITypeSymbol>(SymbolEqualityComparer.Default))) return true;
        var state = Contains(type, Containers);
        // A mutable field named for a user or viewer is per-user state, whatever its type (an interface or delegate is a
        // service, not state).
        if (!state && !readOnly && type.TypeKind is not (TypeKind.Interface or TypeKind.Delegate) && Named(member.Name)) return true;
        if (!state) return type is IArrayTypeSymbol && !readOnly && Written(plugin, member);
        if (Contains(type, Mutable)) return true;
        if (!readOnly) return true;
        if (Only(type, ReadOnlyViews)) return false;
        return Written(plugin, member);
    }

    private static bool Named(string name)
        => name.Contains("user", StringComparison.OrdinalIgnoreCase) || name.Contains("viewer", StringComparison.OrdinalIgnoreCase);

    // Holds a Jellyfin user (the entity), directly or in a type argument, tuple element, array or nullable.
    private static bool HoldsUser(ITypeSymbol type, HashSet<ITypeSymbol> seen)
    {
        if (!seen.Add(type)) return false;
        if (type.ToDisplayString() == "Jellyfin.Database.Implementations.Entities.User") return true;
        return type switch
        {
            IArrayTypeSymbol array => HoldsUser(array.ElementType, seen),
            INamedTypeSymbol named => named.TypeArguments.Any(t => HoldsUser(t, seen)) || (named.IsTupleType && named.TupleElements.Any(e => HoldsUser(e.Type, seen))),
            _ => false,
        };
    }

    private static Dictionary<string, List<(SimpleNameSyntax Name, SemanticModel Model)>>? _names;
    private static WriteGateWalk? _namesOf;

    // Every place the member is named, by symbol.
    private static IEnumerable<(SimpleNameSyntax Name, SemanticModel Model)> Names(WriteGateWalk plugin, ISymbol member)
    {
        if (_names == null || !ReferenceEquals(_namesOf, plugin))
        {
            _names = plugin.Sources().SelectMany(s => s.Tree.GetRoot().DescendantNodes().OfType<SimpleNameSyntax>().Select(n => (Name: n, s.Model)))
                .GroupBy(n => n.Name.Identifier.ValueText, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);
            _namesOf = plugin;
        }

        if (!_names.TryGetValue(member.Name, out var names)) yield break;
        foreach (var (name, model) in names)
        {
            var symbol = model.GetSymbolInfo(name).Symbol;
            if (symbol != null && SymbolEqualityComparer.Default.Equals(symbol.OriginalDefinition, member.OriginalDefinition)) yield return (name, model);
        }
    }

    private static bool Is(ITypeSymbol type, string prefix)
    {
        for (var t = type; t != null; t = t.BaseType)
            if (t.OriginalDefinition.ToDisplayString().StartsWith(prefix, StringComparison.Ordinal) || t.ToDisplayString().StartsWith(prefix, StringComparison.Ordinal)) return true;
        return false;
    }

    private static bool Contains(ITypeSymbol type, params string[] prefixes) => Contains(type, prefixes, new HashSet<ITypeSymbol>(SymbolEqualityComparer.Default));

    // The type, a base type, an interface it implements, or (through tuples, nullables and arrays) an element of it.
    private static bool Contains(ITypeSymbol type, string[] prefixes, HashSet<ITypeSymbol> seen)
    {
        if (!seen.Add(type)) return false;
        if (prefixes.Any(p => Is(type, p))) return true;
        return type switch
        {
            IArrayTypeSymbol array => Contains(array.ElementType, prefixes, seen),
            INamedTypeSymbol { IsTupleType: true } tuple => tuple.TupleElements.Any(e => Contains(e.Type, prefixes, seen)),
            INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } nullable => Contains(nullable.TypeArguments[0], prefixes, seen),
            _ => false,
        };
    }

    // Only read-only views (and their tuples / nullables): nothing can be written through them.
    private static bool Only(ITypeSymbol type, string[] prefixes)
        => prefixes.Any(p => Is(type, p))
            || (type is INamedTypeSymbol { IsTupleType: true } tuple && tuple.TupleElements.All(e => !Contains(e.Type, Containers) || Only(e.Type, prefixes)))
            || (type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } nullable && Only(nullable.TypeArguments[0], prefixes));

    // Written anywhere after it is made: a mutating call on it or on one of its elements, an element assignment, an
    // assignment to it outside a constructor, handed by ref, or handed to a parameter of a type that could change it.
    private static bool Written(WriteGateWalk plugin, ISymbol member)
    {
        foreach (var (name, model) in Names(plugin, member))
        {
            // The member itself: "_x", "this._x" or "owner._x".
            SyntaxNode node = name.Parent switch
            {
                MemberAccessExpressionSyntax { Name: var accessed } qualified when accessed == name => qualified,
                MemberBindingExpressionSyntax { Parent: ConditionalAccessExpressionSyntax conditional } bound when conditional.WhenNotNull == bound => conditional,
                _ => name,
            };
            var parent = node.Parent;
            if (parent is MemberAccessExpressionSyntax access && access.Expression == node && Mutators.Contains(access.Name.Identifier.ValueText)) return true;
            if (parent is ConditionalAccessExpressionSyntax { WhenNotNull: InvocationExpressionSyntax { Expression: MemberBindingExpressionSyntax binding } } && Mutators.Contains(binding.Name.Identifier.ValueText)) return true;
            if (parent is ElementAccessExpressionSyntax element && element.Expression == node && element.Parent is AssignmentExpressionSyntax assigned && assigned.Left == element) return true;
            if (parent is ElementAccessExpressionSyntax inner && inner.Expression == node && inner.Parent is MemberAccessExpressionSyntax onElement
                && onElement.Expression == inner && Mutators.Contains(onElement.Name.Identifier.ValueText)) return true;
            if (parent is AssignmentExpressionSyntax assignment && assignment.Left == node)
            {
                // A readonly field is only assigned in a constructor (where it is made); anything else assigned later is state.
                if (node.FirstAncestorOrSelf<ConstructorDeclarationSyntax>() == null) return true;
                continue;
            }

            // Handed on (a local alias, an assignment elsewhere, a return) as something that could be written through.
            if (parent is EqualsValueClauseSyntax { Parent: VariableDeclaratorSyntax } or ReturnStatementSyntax or ArrowExpressionClauseSyntax
                || (parent is AssignmentExpressionSyntax { Right: var right } && right == node))
            {
                var handed = model.GetTypeInfo(node).ConvertedType;
                if (handed != null && Contains(handed, Containers) && !Only(handed, ReadOnlyViews)) return true;
            }

            if (parent is ArgumentSyntax argument)
            {
                if (!argument.RefKindKeyword.IsKind(SyntaxKind.None)) return true;
                if (argument.Parent?.Parent is { } call && model.GetSymbolInfo(call).Symbol is IMethodSymbol method)
                {
                    var parameter = argument.NameColon != null
                        ? method.Parameters.FirstOrDefault(p => p.Name == argument.NameColon.Name.Identifier.ValueText)
                        : method.Parameters.ElementAtOrDefault(((ArgumentListSyntax)argument.Parent).Arguments.IndexOf(argument));
                    if (parameter != null && !Only(parameter.Type, ReadOnlyViews) && Contains(parameter.Type, Containers)) return true;
                }
            }
        }

        return false;
    }
}
