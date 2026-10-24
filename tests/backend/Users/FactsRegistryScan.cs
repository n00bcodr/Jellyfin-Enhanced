using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace JE.Tests;

internal static class FactsRegistryScan
{
    internal static Dictionary<string, HashSet<string>> Producers(WriteGateWalk plugin, IReadOnlyList<UserCacheScan.Cache> caches, bool writesOnly = true)
    {
        var roots = caches.ToDictionary(c => c.Member, _ => new HashSet<string>(StringComparer.Ordinal));
        var symbols = caches.GroupBy(c => c.Symbol!, SymbolEqualityComparer.Default)
            .ToDictionary(g => g.Key, g => g.First(), SymbolEqualityComparer.Default);
        var names = caches.Select(c => c.Symbol!.Name).ToHashSet(StringComparer.Ordinal);
        foreach (var (tree, model) in plugin.Sources())
        {
            foreach (var id in tree.GetRoot().DescendantNodes().OfType<IdentifierNameSyntax>().Where(n => names.Contains(n.Identifier.ValueText)))
            {
                if (model.GetSymbolInfo(id).Symbol?.OriginalDefinition is not { } symbol || !symbols.TryGetValue(symbol, out var cache)) continue;
                if (writesOnly && !MayStore(id, model)) continue;
                var node = id.Ancestors().FirstOrDefault(n => n is BaseMethodDeclarationSyntax or AccessorDeclarationSyntax or PropertyDeclarationSyntax);
                var method = node == null ? null : model.GetDeclaredSymbol(node) switch { IMethodSymbol m => m, IPropertySymbol p => p.GetMethod, _ => null };
                if (method != null) roots[cache.Member].Add(UserCacheScan.Name(method.ContainingType) + "." + method.MetadataName + "#" + method.Parameters.Length);
            }
        }
        foreach (var cache in caches)
        {
            // Initializers execute in constructors, including generated static initializers.
            if (cache.Symbol is IFieldSymbol field && !EmptyContainerInitializer(field))
                roots[cache.Member].Add(UserCacheScan.Name(field.ContainingType) + (field.IsStatic ? "..cctor" : "..ctor") + "#*");
            if (cache.Symbol is IPropertySymbol property && property.DeclaringSyntaxReferences.Select(r => r.GetSyntax()).OfType<PropertyDeclarationSyntax>().Any(p => p.Initializer != null))
                roots[cache.Member].Add(UserCacheScan.Name(property.ContainingType) + (property.IsStatic ? "..cctor" : "..ctor") + "#*");
        }
        return roots;
    }
    private static bool EmptyContainerInitializer(IFieldSymbol field)
    {
        var expression = field.DeclaringSyntaxReferences.Select(r => r.GetSyntax()).OfType<VariableDeclaratorSyntax>().FirstOrDefault()?.Initializer?.Value;
        if (expression is LiteralExpressionSyntax or DefaultExpressionSyntax) return true;
        if (expression == null) return true; // Default/null is independent; explicit constructor stores are collected above.
        if (!field.Type.ToDisplayString().StartsWith("System.Collections.", StringComparison.Ordinal)) return false;
        var args = expression switch { ObjectCreationExpressionSyntax x => x.ArgumentList?.Arguments, ImplicitObjectCreationExpressionSyntax x => x.ArgumentList.Arguments, _ => null };
        return args is { } arguments && arguments.All(a => a.Expression is LiteralExpressionSyntax || a.Expression.ToString().StartsWith("StringComparer.", StringComparison.Ordinal));
    }

    // A producer computes or hands on writable stored state; ordinary consumers are not producers.
    private static bool MayStore(IdentifierNameSyntax id, SemanticModel model)
    {
        SyntaxNode node = id.Parent is MemberAccessExpressionSyntax qualified && qualified.Name == id ? qualified : id;
        if (node.Parent is AssignmentExpressionSyntax assignment && assignment.Left == node) return true;
        if (node.Parent is ElementAccessExpressionSyntax element && element.Expression == node)
        {
            if (element.Parent is AssignmentExpressionSyntax write && write.Left == element) return true;
            if (element.Parent is MemberAccessExpressionSyntax on && on.Parent is InvocationExpressionSyntax) return true;
        }
        if (node.Parent is MemberAccessExpressionSyntax access && access.Expression == node && access.Parent is InvocationExpressionSyntax)
            return access.Name.Identifier.ValueText is "Add" or "TryAdd" or "AddOrUpdate" or "GetOrAdd" or "TryUpdate" or "Set" or "Enqueue" or "Push" or "Insert" or "InsertRange" or "AddRange" or "AddFirst" or "AddLast" or "UnionWith" or "Sort";
        if (node.Parent is ArgumentSyntax argument)
        {
            if (argument.RefKindKeyword.ValueText is "ref" or "out") return true;
            if (argument.Parent?.Parent is { } call && model.GetSymbolInfo(call).Symbol is IMethodSymbol called)
            {
                var index = ((ArgumentListSyntax)argument.Parent).Arguments.IndexOf(argument);
                var parameter = called.Parameters.ElementAtOrDefault(index)?.Type.ToDisplayString() ?? "";
                if (parameter.StartsWith("System.Collections.Generic.IReadOnly", StringComparison.Ordinal)) return false;
                return parameter.Contains("Dictionary<", StringComparison.Ordinal) && !parameter.Contains("IReadOnly", StringComparison.Ordinal)
                    || parameter.Contains("List<", StringComparison.Ordinal) && !parameter.Contains("IReadOnly", StringComparison.Ordinal)
                    || parameter.Contains("HashSet<", StringComparison.Ordinal);
            }
        }
        var type = model.GetTypeInfo(node).Type;
        var immutableRecord = type is INamedTypeSymbol { TypeKind: TypeKind.Class, IsSealed: true } record
            && record.GetMembers().OfType<IPropertySymbol>().All(p => p.SetMethod == null || p.SetMethod.IsInitOnly)
            && record.GetMembers().OfType<IFieldSymbol>().All(f => f.IsReadOnly || f.AssociatedSymbol is IPropertySymbol { SetMethod.IsInitOnly: true })
            && !record.GetMembers().OfType<IFieldSymbol>().Any(f => f.Type.ToDisplayString().StartsWith("System.Collections.", StringComparison.Ordinal) && !f.Type.ToDisplayString().StartsWith("System.Collections.Generic.IReadOnly", StringComparison.Ordinal));
        return type?.IsValueType != true && type?.SpecialType != SpecialType.System_String && !immutableRecord
            && node.Parent is ReturnStatementSyntax or ArrowExpressionClauseSyntax or EqualsValueClauseSyntax;
    }

    internal static string TypeName(Type type)
        => type.DeclaringType == null ? type.Name.Split('`')[0] : TypeName(type.DeclaringType) + "." + type.Name.Split('`')[0];
    internal static Dictionary<string, MethodBase[]> CompiledMethods(Assembly assembly)
        => assembly.GetTypes().SelectMany(t => t.GetMethods(SeerrFreeProducerProof.Declared).Cast<MethodBase>().Concat(t.GetConstructors(SeerrFreeProducerProof.Declared)))
            .GroupBy(m => TypeName(m.DeclaringType!) + "." + m.Name + "#" + m.GetParameters().Length).ToDictionary(g => g.Key, g => g.ToArray(), StringComparer.Ordinal);

    internal static IEnumerable<MethodBase> CompiledRoots(Dictionary<string, MethodBase[]> compiled, string root)
        => root.EndsWith("#*", StringComparison.Ordinal)
            ? compiled.Where(p => p.Key.StartsWith(root[..^1], StringComparison.Ordinal)).SelectMany(p => p.Value)
            : compiled.GetValueOrDefault(root) ?? [];

    private static string MetadataIdentity(ITypeSymbol? type)
    {
        if (type is not INamedTypeSymbol named) return string.Empty;
        var names = new Stack<string>();
        for (INamedTypeSymbol? current = named; current != null; current = current.ContainingType)
            names.Push(current.MetadataName);
        return named.ContainingNamespace.ToDisplayString() + "." + string.Join(".", names);
    }

    private static bool RegistryHandle(ITypeSymbol? type) => MetadataIdentity(type) is
        "Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserAccessCache`2" or
        "Jellyfin.Plugin.JellyfinEnhanced.Helpers.WrittenStateCache`2" or
        "Jellyfin.Plugin.JellyfinEnhanced.Helpers.RegisteredCache`2" or
        "Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State`1" or
        "Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.Cache`1" or
        "Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.PreparedCache`2" or
        "Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.SeerrFacts.Derived`1";

    private static bool ContainsPayload(ITypeSymbol? type, ITypeSymbol payload, HashSet<ITypeSymbol> seen)
    {
        if (type == null || !seen.Add(type)) return false;
        if (SymbolEqualityComparer.Default.Equals(type.OriginalDefinition, payload.OriginalDefinition)) return true;
        return type is IArrayTypeSymbol array && ContainsPayload(array.ElementType, payload, seen)
            || type is INamedTypeSymbol named && named.TypeArguments.Any(t => ContainsPayload(t, payload, seen));
    }

    private static bool HasRegistryEnvelope(ITypeSymbol? type, HashSet<ITypeSymbol> seen)
    {
        if (type == null || !seen.Add(type)) return false;
        if (MetadataIdentity(type) == "Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.Entry`1") return true;
        if (type is not INamedTypeSymbol named) return false;
        if (named.TypeArguments.Any(t => HasRegistryEnvelope(t, seen))) return true;
        return named.DeclaringSyntaxReferences.Length > 0 && named.GetMembers().Any(m => m switch
        {
            IFieldSymbol f => HasRegistryEnvelope(f.Type, seen),
            IPropertySymbol p => HasRegistryEnvelope(p.Type, seen),
            _ => false,
        });
    }

    private static bool StateCall(WriteGateWalk plugin, IPropertySymbol property, IFieldSymbol fence, ISymbol storage, string method)
    {
        var syntax = (PropertyDeclarationSyntax)property.DeclaringSyntaxReferences.Single().GetSyntax();
        var accessor = syntax.AccessorList?.Accessors.SingleOrDefault(a => a.Keyword.ValueText == (method == "Read" ? "get" : "set"));
        ExpressionSyntax? expression = method == "Read" ? syntax.ExpressionBody?.Expression : null;
        expression ??= accessor?.ExpressionBody?.Expression;
        expression ??= method == "Read"
            ? accessor?.Body?.Statements.OfType<ReturnStatementSyntax>().SingleOrDefault()?.Expression
            : accessor?.Body?.Statements.OfType<ExpressionStatementSyntax>().SingleOrDefault()?.Expression;
        if (expression is not InvocationExpressionSyntax call || call.Expression is not MemberAccessExpressionSyntax access || call.ArgumentList.Arguments.Count != 2)
            return false;
        var model = plugin.ModelOf(syntax.SyntaxTree);
        if (model.GetSymbolInfo(call).Symbol is not IMethodSymbol called || called.Name != method
            || MetadataIdentity(called.ContainingType) != "Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State`1"
            || !SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(access.Expression).Symbol, fence)) return false;
        var first = call.ArgumentList.Arguments[0];
        if (first.RefKindKeyword.ValueText != "ref" || !SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(first.Expression).Symbol, storage)) return false;
        return method == "Read" || model.GetSymbolInfo(call.ArgumentList.Arguments[1].Expression).Symbol is IParameterSymbol value
            && value.Name == "value" && SymbolEqualityComparer.Default.Equals(value.ContainingSymbol, property.SetMethod);
    }

    internal static List<string> Problems(WriteGateWalk plugin, IReadOnlyList<UserCacheRegistryTests.Row> registry)
    {
        var caches = UserCacheScan.Caches(plugin);
        var producers = Producers(plugin, caches);
        var references = Producers(plugin, caches, writesOnly: false);
        var compiled = CompiledMethods(PrivacyOutputPathScan.Plugin);
        var rows = registry.ToDictionary(r => r.Member, StringComparer.Ordinal);
        var errors = new List<string>();
        foreach (var cache in caches)
        {
            if (!rows.TryGetValue(cache.Member, out var row)) continue; // The existing inventory guard reports this.
            var policy = row.Rule("facts").SingleOrDefault();
            if (policy == null) { errors.Add(cache.Member + ": no facts-generation disposition"); continue; }
            if (policy.StartsWith("SeerrFree=", StringComparison.Ordinal))
            {
                if (policy.Length == "SeerrFree=".Length) errors.Add(cache.Member + ": no SeerrFree reason");
                var roots = SeerrFreeProducerProof.Producers(producers[cache.Member].SelectMany(n => CompiledRoots(compiled, n)));
                errors.AddRange(SeerrFreeProducerProof.Violations(roots, SeerrFreeProducerProof.Seerr).Select(v => cache.Member + ": SeerrFree producer reaches " + v));
            }
            else if (policy == "fenced=helper")
            {
                var held = cache.Symbol switch { IFieldSymbol f => f.Type, IPropertySymbol p => p.Type, _ => null };
                if (!RegistryHandle(held))
                    errors.Add(cache.Member + ": not a registry cache handle");
            }
            else if (policy == "fenced=state" || policy.StartsWith("fenced=state:", StringComparison.Ordinal))
            {
                var owner = cache.Symbol!.ContainingType;
                var accessor = policy.StartsWith("fenced=state:", StringComparison.Ordinal) ? policy["fenced=state:".Length..] : cache.Symbol.Name + "Facts";
                var property = owner.GetMembers(accessor).OfType<IPropertySymbol>().SingleOrDefault();
                var fenceName = cache.Symbol.Name.EndsWith("Storage", StringComparison.Ordinal) ? cache.Symbol.Name[..^"Storage".Length] + "Owner" : cache.Symbol.Name + "FactsOwner";
                var fence = owner.GetMembers(fenceName).OfType<IFieldSymbol>().SingleOrDefault();
                var storedType = cache.Symbol switch { IFieldSymbol f => f.Type, IPropertySymbol p => p.Type, _ => null };
                if (property == null || fence?.Type is not INamedTypeSymbol state
                    || MetadataIdentity(state) != "Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State`1"
                    || !SymbolEqualityComparer.Default.Equals(state.TypeArguments.Single(), storedType))
                    errors.Add(cache.Member + ": no registry state accessor");
                if (property != null && fence != null)
                {
                    if (!StateCall(plugin, property, fence, cache.Symbol, "Read")) errors.Add(cache.Member + ": accessor bypasses registry lookup");
                    if (property.SetMethod != null && !StateCall(plugin, property, fence, cache.Symbol, "Store")) errors.Add(cache.Member + ": setter bypasses registry store");
                }
                // A direct field read/store would bypass the state envelope: only its generated accessor may name it.
                var permitted = UserCacheScan.Name(owner) + ".get_" + accessor + "#0";
                var setter = UserCacheScan.Name(owner) + ".set_" + accessor + "#1";
                foreach (var root in references[cache.Member].Where(p => !p.Contains("..ctor#", StringComparison.Ordinal) && !p.Contains("..cctor#", StringComparison.Ordinal) && p != permitted && p != setter))
                    errors.Add(cache.Member + ": raw storage escapes the registry through " + root);
            }
            else if (policy == "fenced=storage")
            {
                if (cache.Member is not ("UserAccessCache._entries" or "WrittenStateCache._entries" or "RegisteredCache._entries" or "SeerrFacts.Cache._entries") || !HasRegistryEnvelope(cache.Symbol is IFieldSymbol storage ? storage.Type : null, new HashSet<ITypeSymbol>(SymbolEqualityComparer.Default)))
                    errors.Add(cache.Member + ": not common registry-owned storage");
            }
            else if (policy.StartsWith("fenced=parent:", StringComparison.Ordinal))
            {
                var parent = policy["fenced=parent:".Length..];
                if (!rows.TryGetValue(parent, out var parentRow) || !parentRow.Rule("facts").Any(p => p.StartsWith("fenced=", StringComparison.Ordinal))) errors.Add(cache.Member + ": no fenced parent " + parent);
                var parentCache = caches.SingleOrDefault(c => c.Member == parent);
                var parentType = parentCache?.Symbol switch { IFieldSymbol f => f.Type, IPropertySymbol p => p.Type, _ => null };
                if (cache.Symbol?.ContainingType.DeclaredAccessibility != Accessibility.Private || parentCache == null || !ContainsPayload(parentType, cache.Symbol.ContainingType, new HashSet<ITypeSymbol>(SymbolEqualityComparer.Default)))
                    errors.Add(cache.Member + ": parent does not own this private payload");
            }
            else if (policy.StartsWith("operational=", StringComparison.Ordinal))
            {
                var manifest = Path.Combine(AppContext.BaseDirectory, "fixtures", "user-caches", "facts-non-caches.tsv");
                var allowed = File.ReadAllLines(manifest).Where(l => l.Length > 0 && !l.StartsWith('#')).Select(l => l.Split('\t')).SingleOrDefault(v => v[0] == cache.Member);
                if (allowed == null || allowed[1] != cache.Type || allowed[2] != policy["operational=".Length..] || string.IsNullOrWhiteSpace(allowed[2]))
                    errors.Add(cache.Member + ": unreviewed non-cache control state (an answer cache needs a fence or SeerrFree proof)");
            }
            else errors.Add(cache.Member + ": unknown facts disposition " + policy);
        }
        return errors;
    }
}
