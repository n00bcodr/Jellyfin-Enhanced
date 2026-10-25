using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace JE.Tests;

/// <summary>
/// Every cache the plugin keeps, found in its own source by syntax and symbols (<see cref="WriteGateWalk"/>'s compilation):
/// every field and every auto-property without a public setter, static or not, in any type, whose type holds state across
/// calls (a dictionary, set, list, queue, MemoryCache, ConditionalWeakTable or Lazy memo, a tuple, nullable or array of one,
/// a type deriving from one, a held Jellyfin user, or the access-stamp helper), every mutable field of one of the plugin's
/// own types that holds a collection (a snapshot swapped whole), and every mutable field named for a user or viewer. Left out only: a read-only table that nothing writes after it is made (no mutating call, no element assignment,
/// never handed to a parameter that could change it), which can't hold anything a request computed.
/// <para>
/// Whether a cache is keyed by a user isn't guessed from its key type: every cache found must be listed in
/// tests/fixtures/user-caches.tsv, either <c>stamped</c> (declared as the access-stamp helper,
/// Helpers/UserAccessCache.cs) or <c>independent</c> with the reason it doesn't depend on a user's access.
/// </para>
/// </summary>
internal static partial class UserCacheScan
{
    /// <summary>One cache: "Type.member" (nested types dotted), its declared type, where; stamped: the access-stamp
    /// helper; ticketed: one of the two helpers on the ticket protocol (stamped, or the written-state cache).</summary>
    internal sealed record Cache(string Member, string Type, string Where, bool Stamped)
    {
        internal bool Ticketed { get; init; }

        internal ISymbol? Symbol { get; init; }
    }

    private static readonly string[] Containers =
    [
        "Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.Cache<",
        "Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.PreparedCache<",
        "Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.Derived<",
        "Jellyfin.Plugin.JellyfinEnhanced.Helpers.RegisteredCache<",
        "Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<",
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
        "Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<",
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

    internal const string WrittenState = "Jellyfin.Plugin.JellyfinEnhanced.Helpers.WrittenStateCache<";

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
                    case PropertyDeclarationSyntax property when model.GetDeclaredSymbol(property) is IPropertySymbol { IsAbstract: false } symbol && Auto(property)
                        && symbol.SetMethod is not { DeclaredAccessibility: Accessibility.Public or Accessibility.Internal } && symbol.SetMethod is not { IsInitOnly: true }:
                        if (Holds(plugin, symbol, symbol.Type, symbol.SetMethod == null, property.Initializer?.Value)) found.Add(Of(symbol, symbol.Type, property));
                        break;
                }
            }
        }

        return found.OrderBy(c => c.Member, StringComparer.Ordinal).ToList();
    }

    private const string Authority = "Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserAuthority";
    private const string StampType = Authority + ".Stamp";

    /// <summary>
    /// Where a cache could file a value under a version that isn't the one its input was read under (review round 3:
    /// a value carries the stamp of its inputs). A version is sampled only by the read itself (<c>UserAuthority.Read</c>,
    /// behind <c>ReadOncePerRequest</c>) and by the helper's fingerprint ticket (filed under the fingerprint of the very
    /// user it is computed from; the version there only ends it later); nothing else makes one. A held entry's read
    /// returns its value and version from ONE call, and a held ticket's version is the <c>.Stamp</c> of a read whose
    /// result the value is computed from.
    /// </summary>
    internal static List<string> StampSources(WriteGateWalk plugin)
    {
        var problems = new List<string>();
        foreach (var (tree, model) in plugin.Sources())
        {
            foreach (var node in tree.GetRoot().DescendantNodes())
            {
                var where = Where(node);
                var member = node.Ancestors().OfType<BaseMethodDeclarationSyntax>().Cast<SyntaxNode>().Concat(node.Ancestors().OfType<BasePropertyDeclarationSyntax>()).FirstOrDefault() is { } declared
                    && model.GetDeclaredSymbol(declared) is { ContainingType: { } type } symbol
                    ? Name(type) + "." + symbol.Name
                    : string.Empty;
                switch (node)
                {
                    case InvocationExpressionSyntax call when model.GetSymbolInfo(call).Symbol is IMethodSymbol method:
                        var owner = method.ContainingType.OriginalDefinition.ToDisplayString();
                        if (owner == Authority && method.Name == "Take" && member is not ("UserAuthority.Read" or "UserAccessCache.Begin"))
                            problems.Add(where + ": " + member + " samples the person's version itself (UserAuthority.Take); file the value under the version its user was read under");
                        // (The helper's own forwarding between its overloads aside.)
                        if (member.StartsWith("UserAccessCache.", StringComparison.Ordinal)) break;
                        if (owner.StartsWith(Helper, StringComparison.Ordinal) && method.Name is "GetHeld" or "GetHeldStamped")
                        {
                            var read = call.ArgumentList.Arguments.ElementAtOrDefault(2)?.Expression;
                            if (!OneCall(read))
                                problems.Add(where + ": " + member + " " + method.Name + "'s read must return the value and its version from one call (a read), not put them together");
                        }

                        if (owner.StartsWith(Helper, StringComparison.Ordinal) && method.Name == "BeginHeld" && !FromARead(call.ArgumentList.Arguments.ElementAtOrDefault(1)?.Expression, model))
                            problems.Add(where + ": " + member + " BeginHeld's version must be the .Stamp of the read the value is computed from");
                        break;
                    // The stamp handing itself on with an earlier deadline (Within) keeps its version and read instant.
                    case BaseObjectCreationExpressionSyntax made when member is not ("UserAuthority.Take" or "UserAuthority.Stamp.Within") && model.GetTypeInfo(made).Type?.ToDisplayString() == StampType:
                        problems.Add(where + ": " + member + " makes a version (new Stamp) instead of taking the one its user was read under");
                        break;
                    case LiteralExpressionSyntax { RawKind: (int)SyntaxKind.DefaultLiteralExpression } or DefaultExpressionSyntax or WithExpressionSyntax
                        when model.GetTypeInfo(node).ConvertedType?.ToDisplayString() == StampType:
                        problems.Add(where + ": " + member + " makes a version (default / with) instead of taking the one its user was read under");
                        break;
                }
            }
        }

        return problems;
    }

    /// <summary>
    /// A held read given as one call whose result is the value and its version together: <c>() =&gt; Read()</c>,
    /// <c>() =&gt; { return Read(); }</c> or <c>delegate { return Read(); }</c> (parentheses aside). Anything that builds
    /// the pair from parts is not, nor a method group (its body isn't checked here).
    /// </summary>
    internal static bool OneCall(ExpressionSyntax? read)
    {
        while (read is ParenthesizedExpressionSyntax inner) read = inner.Expression;
        var body = read switch
        {
            LambdaExpressionSyntax { ExpressionBody: { } expression } => expression,
            LambdaExpressionSyntax { Block.Statements: [ReturnStatementSyntax { Expression: { } returned }] } => returned,
            AnonymousMethodExpressionSyntax { Block.Statements: [ReturnStatementSyntax { Expression: { } returned }] } => returned,
            _ => null,
        };
        while (body is ParenthesizedExpressionSyntax inner) body = inner.Expression;
        return body is InvocationExpressionSyntax;
    }

    // "<local>.Stamp" where the local holds the result of a read (a call returning the user and their version).
    private static bool FromARead(ExpressionSyntax? stamp, SemanticModel model)
    {
        if (stamp is not MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Stamp", Expression: IdentifierNameSyntax local }) return false;
        if (model.GetSymbolInfo(local).Symbol is not ILocalSymbol symbol) return false;
        var declaration = symbol.DeclaringSyntaxReferences.Select(r => r.GetSyntax()).OfType<VariableDeclaratorSyntax>().FirstOrDefault();
        return declaration?.Initializer?.Value is InvocationExpressionSyntax read
            && model.GetSymbolInfo(read).Symbol is IMethodSymbol method
            && method.ReturnType is INamedTypeSymbol { IsTupleType: true } tuple
            && tuple.TupleElements.Any(e => e.Type.ToDisplayString() == StampType);
    }

    private static string Where(SyntaxNode node)
    {
        var span = node.GetLocation().GetLineSpan();
        var root = IntegrationAutoRequestLedgerTests.Root();
        return Path.GetRelativePath(Path.Combine(root, "Jellyfin.Plugin.JellyfinEnhanced"), span.Path).Replace(Path.DirectorySeparatorChar, '/')
            + ":" + (span.StartLinePosition.Line + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    private static bool Auto(PropertyDeclarationSyntax property)
        => property.AccessorList != null && property.AccessorList.Accessors.All(a => a.Body == null && a.ExpressionBody == null);

    private static Cache Of(ISymbol symbol, ITypeSymbol type, SyntaxNode at)
    {
        var span = at.GetLocation().GetLineSpan();
        var root = IntegrationAutoRequestLedgerTests.Root();
        var file = Path.GetRelativePath(Path.Combine(root, "Jellyfin.Plugin.JellyfinEnhanced"), span.Path).Replace(Path.DirectorySeparatorChar, '/');
        // The helper itself (a type nested in it, like its own storage, isn't).
        var stamped = Is(type, Helper) && type is not INamedTypeSymbol { ContainingType: not null };
        var written = Is(type, WrittenState) && type is not INamedTypeSymbol { ContainingType: not null }
            || Is(type, "Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.PreparedCache<");
        return new Cache(Name(symbol), type.ToDisplayString(), file + ":" + (span.StartLinePosition.Line + 1).ToString(System.Globalization.CultureInfo.InvariantCulture), stamped)
        {
            Ticketed = stamped || written,
            Symbol = symbol,
        };
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
        if (Contains(type, Helper) || Contains(type, WrittenState) || HoldsUser(type, new HashSet<ITypeSymbol>(SymbolEqualityComparer.Default))) return true;
        var state = Contains(type, Containers);
        // A mutable field named for a user or viewer is per-user state, whatever its type (an interface or delegate is a
        // service, not state).
        if (!state && !readOnly && type.TypeKind is not (TypeKind.Interface or TypeKind.Delegate) && Named(member.Name)) return true;
        // A snapshot swapped whole: a mutable field of one of the plugin's own types that holds a collection.
        if (!state && MemoRecord(type)) return true;
        if (!state && type.SpecialType == SpecialType.System_Object && !readOnly && Written(plugin, member)) return true;
        if (!state && !readOnly && Snapshot(type)) return true;
        // A plain-typed verdict/identity/freshness memo is still stored state. Do not infer provenance from its name.
        if (!state && ScalarMemo(type) && (!readOnly && Written(plugin, member) || readOnly && PreparedScalar(plugin, member))) return true;
        if (!state) return type is IArrayTypeSymbol && !readOnly && Written(plugin, member);
        if (Contains(type, Mutable)) return true;
        if (!readOnly) return true;
        if (Only(type, ReadOnlyViews)) return false;
        return Written(plugin, member);
    }

    private static bool PreparedScalar(WriteGateWalk plugin, ISymbol member)
    {
        if (member is not IFieldSymbol field) return false;
        var syntax = field.DeclaringSyntaxReferences.Select(r => r.GetSyntax()).OfType<VariableDeclaratorSyntax>().FirstOrDefault();
        if (syntax?.Initializer?.Value is { } initial && initial is not (LiteralExpressionSyntax or DefaultExpressionSyntax)) return true;
        return Names(plugin, member).Any(n => n.Name.Ancestors().OfType<AssignmentExpressionSyntax>().Any(a =>
            a.Left.Span.Contains(n.Name.Span) && a.Ancestors().OfType<ConstructorDeclarationSyntax>().Any()));
    }

    private static bool ScalarMemo(ITypeSymbol type)
        => type.IsValueType || type.SpecialType == SpecialType.System_String;

    // A scalar/record memo still retains facts across operations, even if it contains no collection or viewer id.
    private static bool MemoRecord(ITypeSymbol type) => DataValue(type, new HashSet<ITypeSymbol>(SymbolEqualityComparer.Default));

    private static bool DataValue(ITypeSymbol type, HashSet<ITypeSymbol> seen)
    {
        if (type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } nullable) type = nullable.TypeArguments[0];
        if (type is not INamedTypeSymbol { TypeKind: TypeKind.Class or TypeKind.Struct } named || named.DeclaringSyntaxReferences.Length == 0) return false;
        if (named.IsRecord) return true;
        if (!seen.Add(type)) return false;
        // A passive plain-class DTO is a memo too; changing 'record' to 'class' must not remove its fence.
        var fields = named.GetMembers().OfType<IFieldSymbol>().Where(f => !f.IsStatic).ToArray();
        return fields.Length > 0 && fields.All(f => ScalarMemo(f.Type) || f.Type is IArrayTypeSymbol || Contains(f.Type, Containers) || DataValue(f.Type, seen));
    }

    // One of the plugin's own classes, records or structs with a field or auto-property that holds a collection.
    private static bool Snapshot(ITypeSymbol type)
    {
        if (type is INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } nullable) type = nullable.TypeArguments[0];
        if (type is not INamedTypeSymbol { TypeKind: TypeKind.Class or TypeKind.Struct } named || named.DeclaringSyntaxReferences.Length == 0) return false;
        return named.GetMembers().Any(m => m switch
        {
            IFieldSymbol { IsImplicitlyDeclared: false } f => Contains(f.Type, Containers),
            IFieldSymbol { AssociatedSymbol: IPropertySymbol p } => Contains(p.Type, Containers),
            _ => false,
        });
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
            var symbol = plugin.SymbolAt(name, model).Symbol;
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
