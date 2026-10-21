using Microsoft.CodeAnalysis;

namespace JE.Tests;

/// <summary>
/// Review round 6: what a cache holds, read from its declared type.
/// <list type="bullet">
/// <item><description><see cref="HoldsAuthority"/>: a cache whose answers depend on the person's Seerr account keeps the
/// account authority it was read under (Helpers/Jellyseerr/SeerrAccountAuthority.cs) with what it holds, so it can serve
/// only under that authority (or keys by it: checked through its key builder).</description></item>
/// <item><description><see cref="WallInstants"/>: an instant a cache keeps for its own lifetime (a member of its held value
/// named like a deadline or read time) on the wall clock (DateTime / DateTimeOffset) while the cache's lifetimes are on
/// the monotonic clock: a wall-clock step makes the inner deadline outlive (or end before) the outer one.</description></item>
/// </list>
/// </summary>
internal static partial class UserCacheScan
{
    private const string AuthorityTicket = "Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr.SeerrAccountAuthority.Ticket";

    /// <summary>Whether the cache's declared type holds a Seerr account authority ticket (in what it keeps).</summary>
    internal static bool HoldsAuthority(Cache cache)
        => cache.Symbol is { } symbol && Held(TypeOf(symbol)).Any(m => m.Type.ToDisplayString().TrimEnd('?') == AuthorityTicket);

    /// <summary>The members of the cache's held values that keep an instant on the wall clock, as "Member (Type)".</summary>
    internal static List<string> WallInstants(Cache cache)
    {
        if (cache.Symbol is not { } symbol) return [];
        return Held(TypeOf(symbol))
            .Where(m => m.Type.ToDisplayString().TrimEnd('?') is "System.DateTime" or "System.DateTimeOffset" && Instant(m.Name))
            .Select(m => m.Name + " (" + m.Type.ToDisplayString() + ")")
            .Distinct(StringComparer.Ordinal)
            .ToList();
    }

    private static ITypeSymbol TypeOf(ISymbol symbol) => symbol switch
    {
        IFieldSymbol f => f.Type,
        IPropertySymbol p => p.Type,
        _ => throw new InvalidOperationException(symbol.ToDisplayString()),
    };

    // Named for a read time or a deadline.
    private static bool Instant(string name)
        => name.EndsWith("At", StringComparison.Ordinal) || name.EndsWith("Until", StringComparison.Ordinal)
           || name.Contains("Expire", StringComparison.Ordinal) || name.Contains("Deadline", StringComparison.Ordinal);

    // The members of the values a cache keeps: through its containers' type arguments, tuples, nullables and arrays down to
    // a value of its own (a tuple's elements, a record's or class's own fields and properties, one level).
    private static IEnumerable<(string Name, ITypeSymbol Type)> Held(ITypeSymbol type)
    {
        var seen = new HashSet<ITypeSymbol>(SymbolEqualityComparer.Default);
        var found = new List<(string, ITypeSymbol)>();
        void Walk(ITypeSymbol t, int depth)
        {
            if (depth > 4 || !seen.Add(t)) return;
            switch (t)
            {
                case IArrayTypeSymbol array:
                    Walk(array.ElementType, depth + 1);
                    return;
                case INamedTypeSymbol { IsTupleType: true } tuple:
                    foreach (var element in tuple.TupleElements) found.Add((element.Name, element.Type));
                    return;
                case INamedTypeSymbol { OriginalDefinition.SpecialType: SpecialType.System_Nullable_T } nullable:
                    Walk(nullable.TypeArguments[0], depth + 1);
                    return;
                case INamedTypeSymbol named when named.Locations.Any(l => l.IsInSource) && named.TypeArguments.Length == 0:
                    foreach (var member in named.GetMembers())
                    {
                        if (member.IsStatic || member.IsImplicitlyDeclared) continue;
                        if (member is IFieldSymbol { AssociatedSymbol: null } f) found.Add((f.Name, f.Type));
                        else if (member is IPropertySymbol p) found.Add((p.Name, p.Type));
                    }
                    return;
                case INamedTypeSymbol generic:
                    foreach (var argument in generic.TypeArguments) Walk(argument, depth + 1);
                    return;
            }
        }

        Walk(type, 0);
        return found;
    }
}
