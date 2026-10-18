using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace JE.Tests;

/// <summary>
/// 4a review round 9 (4a-security-r9-2/3): where a value in the plugin's code comes from, by the Roslyn semantic model
/// (symbols, not names), for the fact-registry scan and the writer (bracket) scan. An expression's ORIGINS are the
/// members, calls and values it can hold, after following:
/// <list type="bullet">
/// <item><description>parentheses, casts, <c>!</c>, <c>??</c>, <c>?:</c>, <c>await</c>, <c>a?.b</c>, and <c>this.x</c> (bound to the member);</description></item>
/// <item><description>a local: its initializer and every assignment of it in its body (an alias), a foreach variable's collection,
/// a pattern variable's tested value;</description></item>
/// <item><description>a plugin method or property with a body: every value it returns (a helper), its parameters mapped to the
/// call's arguments;</description></item>
/// <item><description>a parameter of a plugin method not entered through a call: the argument at every call of it in the plugin.</description></item>
/// </list>
/// A member or method <c>stop</c> accepts is an origin itself and isn't followed. Unknown expressions are origins too
/// (kind <see cref="OriginKind.Other"/>), so a caller can treat them as "not proven".
/// </summary>
internal sealed class SemanticFlow(WriteGateWalk walk)
{
    private const int MaxDepth = 12;

    internal enum OriginKind { Member, Call, Parameter, Local, Creation, Literal, This, Other }

    /// <summary>One origin: what it is, its symbol (a field, property, method, parameter or local) and where.</summary>
    internal sealed record Origin(OriginKind Kind, ISymbol? Symbol, SyntaxNode Node, SemanticModel Model)
    {
        /// <summary>The followed calls' parameter bindings at this origin (keys built inside a helper map to its caller's).</summary>
        internal object? Frame { get; init; }

        public override string ToString() => Kind + ":" + (Symbol?.ContainingType?.Name + "." + Symbol?.Name).TrimStart('.') + " (" + Node + ")";
    }

    // A call's parameters, mapped to its arguments while its body is followed.
    private sealed record Frame(IMethodSymbol Method, IReadOnlyDictionary<IParameterSymbol, (ExpressionSyntax Argument, SemanticModel Model)> Arguments, Frame? Outer);

    /// <summary>The origins of <paramref name="expression"/>.</summary>
    /// <param name="expression">The expression.</param>
    /// <param name="model">Its semantic model.</param>
    /// <param name="stop">Members and methods that are origins themselves (not followed).</param>
    /// <param name="upward">Follow a parameter not bound by a followed call to every call of its method (false: it is an origin).</param>
    public List<Origin> Origins(ExpressionSyntax expression, SemanticModel model, Func<ISymbol, bool>? stop = null, bool upward = true)
    {
        var found = new List<Origin>();
        Visit(expression, model, stop ?? (_ => false), null, found, new HashSet<(SyntaxNode, Frame?)>(), 0, upward);
        return found;
    }

    /// <summary>
    /// The symbols an expression is built from (for keys): like <see cref="Origins"/>, but a call of a method outside the
    /// plugin (or one <paramref name="stop"/> accepts) contributes its receiver's and arguments' roots too, and literals none.
    /// </summary>
    public HashSet<ISymbol> Roots(ExpressionSyntax expression, SemanticModel model, Func<ISymbol, bool>? stop = null) => Roots(expression, model, stop ?? (_ => false), null);

    /// <summary>The roots of an expression found under an origin (its <see cref="Origin.Frame"/>: inside a followed helper, its parameters are the caller's arguments).</summary>
    public HashSet<ISymbol> RootsAt(ExpressionSyntax expression, SemanticModel model, object? frame) => Roots(expression, model, _ => false, frame as Frame);

    private HashSet<ISymbol> Roots(ExpressionSyntax expression, SemanticModel model, Func<ISymbol, bool> stop, Frame? frame)
    {
        var roots = new HashSet<ISymbol>(SymbolEqualityComparer.Default);
        var origins = new List<Origin>();
        Visit(expression, model, stop, frame, origins, new HashSet<(SyntaxNode, Frame?)>(), 0, upward: false);
        foreach (var origin in origins)
        {
            var at = origin.Frame as Frame;
            // x.Member: x's roots too (another object's member isn't this one's).
            if (origin is { Kind: OriginKind.Member, Node: MemberAccessExpressionSyntax { Expression: var owner } } && owner is not (ThisExpressionSyntax or BaseExpressionSyntax)
                && origin.Model.GetSymbolInfo(owner).Symbol is not INamedTypeSymbol and not INamespaceSymbol)
                roots.UnionWith(Roots(owner, origin.Model, stop, at));
            if (origin is { Kind: OriginKind.Call, Node: InvocationExpressionSyntax call })
            {
                if (call.Expression is MemberAccessExpressionSyntax { Expression: var receiver } && origin.Model.GetSymbolInfo(receiver).Symbol is not INamedTypeSymbol)
                    roots.UnionWith(Roots(receiver, origin.Model, stop, at));
                foreach (var argument in call.ArgumentList.Arguments) roots.UnionWith(Roots(argument.Expression, origin.Model, stop, at));
            }
            else if (origin.Kind is not (OriginKind.Literal or OriginKind.Creation or OriginKind.Other) && origin.Symbol != null)
            {
                roots.Add(origin.Symbol.OriginalDefinition);
            }
        }

        return roots;
    }

    private void Visit(ExpressionSyntax e, SemanticModel model, Func<ISymbol, bool> stop, Frame? frame, List<Origin> found, HashSet<(SyntaxNode, Frame?)> seen, int depth, bool upward)
    {
        if (depth > MaxDepth || !seen.Add((e, frame)))
        {
            found.Add(new Origin(OriginKind.Other, null, e, model) with { Frame = frame });
            return;
        }

        switch (e)
        {
            case ParenthesizedExpressionSyntax p:
                Visit(p.Expression, model, stop, frame, found, seen, depth + 1, upward);
                return;
            case CastExpressionSyntax c:
                Visit(c.Expression, model, stop, frame, found, seen, depth + 1, upward);
                return;
            case PostfixUnaryExpressionSyntax { RawKind: (int)SyntaxKind.SuppressNullableWarningExpression } bang:
                Visit(bang.Operand, model, stop, frame, found, seen, depth + 1, upward);
                return;
            case AwaitExpressionSyntax a:
                Visit(a.Expression, model, stop, frame, found, seen, depth + 1, upward);
                return;
            case BinaryExpressionSyntax { RawKind: (int)SyntaxKind.CoalesceExpression } co:
                Visit(co.Left, model, stop, frame, found, seen, depth + 1, upward);
                Visit(co.Right, model, stop, frame, found, seen, depth + 1, upward);
                return;
            case BinaryExpressionSyntax { RawKind: (int)SyntaxKind.AsExpression } asCast:
                Visit(asCast.Left, model, stop, frame, found, seen, depth + 1, upward);
                return;
            case ConditionalExpressionSyntax q:
                Visit(q.WhenTrue, model, stop, frame, found, seen, depth + 1, upward);
                Visit(q.WhenFalse, model, stop, frame, found, seen, depth + 1, upward);
                return;
            case ConditionalAccessExpressionSyntax ca:
                // a?.b: the value of b, read on a.
                Visit(ca.WhenNotNull, model, stop, frame, found, seen, depth + 1, upward);
                return;
            case LiteralExpressionSyntax or InterpolatedStringExpressionSyntax:
                found.Add(new Origin(OriginKind.Literal, null, e, model) with { Frame = frame });
                return;
            case ThisExpressionSyntax or BaseExpressionSyntax:
                found.Add(new Origin(OriginKind.This, null, e, model) with { Frame = frame });
                return;
            case BaseObjectCreationExpressionSyntax creation:
                found.Add(new Origin(OriginKind.Creation, model.GetTypeInfo(creation).Type, e, model) with { Frame = frame });
                return;
            case InvocationExpressionSyntax call:
                Call(call, model, stop, frame, found, seen, depth, upward);
                return;
        }

        var symbol = model.GetSymbolInfo(e).Symbol ?? model.GetSymbolInfo(e).CandidateSymbols.FirstOrDefault();
        switch (symbol)
        {
            case null:
                found.Add(new Origin(OriginKind.Other, null, e, model) with { Frame = frame });
                return;
            case ILocalSymbol local:
                Local(local, e, model, stop, frame, found, seen, depth, upward);
                return;
            case IParameterSymbol parameter:
                Parameter(parameter, e, model, stop, frame, found, seen, depth, upward);
                return;
            case IPropertySymbol property when !stop(property) && Body(property.GetMethod) is { } getter:
                // A helper property with a body: what its getter returns.
                foreach (var (value, valueModel) in Returns(getter))
                    Visit(value, valueModel, stop, new Frame(property.GetMethod!, new Dictionary<IParameterSymbol, (ExpressionSyntax, SemanticModel)>(SymbolEqualityComparer.Default), frame), found, seen, depth + 1, upward);
                return;
            default:
                found.Add(new Origin(symbol is IMethodSymbol ? OriginKind.Call : OriginKind.Member, symbol, e, model) with { Frame = frame });
                return;
        }
    }

    private void Call(InvocationExpressionSyntax call, SemanticModel model, Func<ISymbol, bool> stop, Frame? frame, List<Origin> found, HashSet<(SyntaxNode, Frame?)> seen, int depth, bool upward)
    {
        if (model.GetSymbolInfo(call).Symbol is not IMethodSymbol method)
        {
            found.Add(new Origin(OriginKind.Other, null, call, model) with { Frame = frame });
            return;
        }

        method = method.ReducedFrom ?? method;
        if (stop(method.OriginalDefinition) || Body(method) is not { } body)
        {
            found.Add(new Origin(OriginKind.Call, method.OriginalDefinition, call, model) with { Frame = frame });
            return;
        }

        // A helper: what it returns, its parameters bound to this call's arguments.
        var arguments = new Dictionary<IParameterSymbol, (ExpressionSyntax, SemanticModel)>(SymbolEqualityComparer.Default);
        var args = call.ArgumentList.Arguments;
        for (var i = 0; i < args.Count; i++)
        {
            var parameter = args[i].NameColon is { } named ? method.Parameters.FirstOrDefault(p => p.Name == named.Name.Identifier.ValueText) : i < method.Parameters.Length ? method.Parameters[i] : null;
            if (parameter != null) arguments[parameter.OriginalDefinition] = (args[i].Expression, model);
        }

        foreach (var (value, valueModel) in Returns(body))
            Visit(value, valueModel, stop, new Frame((IMethodSymbol)method.OriginalDefinition, arguments, frame), found, seen, depth + 1, upward);
    }

    private void Local(ILocalSymbol local, ExpressionSyntax use, SemanticModel model, Func<ISymbol, bool> stop, Frame? frame, List<Origin> found, HashSet<(SyntaxNode, Frame?)> seen, int depth, bool upward)
    {
        var declaration = local.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();
        var scope = declaration?.Ancestors().FirstOrDefault(a => a is BaseMethodDeclarationSyntax or AccessorDeclarationSyntax or AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax or PropertyDeclarationSyntax) ?? declaration;
        var any = false;
        switch (declaration)
        {
            case VariableDeclaratorSyntax { Initializer.Value: var value }:
                Visit(value, model, stop, frame, found, seen, depth + 1, upward);
                any = true;
                break;
            case ForEachStatementSyntax each:
                found.Add(new Origin(OriginKind.Local, local, use, model) with { Frame = frame });
                Visit(each.Expression, model, stop, frame, found, seen, depth + 1, upward);
                any = true;
                break;
            case SingleVariableDesignationSyntax designation when designation.Ancestors().OfType<IsPatternExpressionSyntax>().FirstOrDefault() is { } pattern:
                Visit(pattern.Expression, model, stop, frame, found, seen, depth + 1, upward);
                any = true;
                break;
        }

        // Every later assignment of it.
        if (scope != null)
            foreach (var assignment in scope.DescendantNodes().OfType<AssignmentExpressionSyntax>())
                if (SymbolEqualityComparer.Default.Equals(model.GetSymbolInfo(assignment.Left).Symbol, local))
                {
                    Visit(assignment.Right, model, stop, frame, found, seen, depth + 1, upward);
                    any = true;
                }

        if (!any) found.Add(new Origin(OriginKind.Local, local, use, model) with { Frame = frame });
    }

    private void Parameter(IParameterSymbol parameter, ExpressionSyntax use, SemanticModel model, Func<ISymbol, bool> stop, Frame? frame, List<Origin> found, HashSet<(SyntaxNode, Frame?)> seen, int depth, bool upward)
    {
        var original = (IParameterSymbol)parameter.OriginalDefinition;
        for (var f = frame; f != null; f = f.Outer)
            if (SymbolEqualityComparer.Default.Equals(f.Method, original.ContainingSymbol) && f.Arguments.TryGetValue(original, out var bound))
            {
                Visit(bound.Argument, bound.Model, stop, f.Outer, found, seen, depth + 1, upward);
                return;
            }

        // Not entered through a call: every call of its method in the plugin (a lambda's parameters stay parameters).
        if (upward && original.ContainingSymbol is IMethodSymbol { MethodKind: MethodKind.Ordinary or MethodKind.Constructor or MethodKind.LocalFunction } method && !stop(original))
        {
            var calls = walk.References(method).ToList();
            var any = false;
            foreach (var (node, callModel) in calls)
            {
                if (node is not InvocationExpressionSyntax and not BaseObjectCreationExpressionSyntax) continue;
                var args = node is InvocationExpressionSyntax inv ? inv.ArgumentList.Arguments : ((BaseObjectCreationExpressionSyntax)node).ArgumentList?.Arguments ?? default;
                var index = original.Ordinal;
                var argument = args.FirstOrDefault(a => a.NameColon?.Name.Identifier.ValueText == original.Name) ?? (index < args.Count && args[index].NameColon == null ? args[index] : null);
                if (argument == null) continue;
                Visit(argument.Expression, callModel, stop, null, found, seen, depth + 1, upward);
                any = true;
            }

            if (any) return;
        }

        found.Add(new Origin(OriginKind.Parameter, original, use, model) with { Frame = frame });
    }

    // The plugin's own body of a method or accessor (null: outside the plugin, abstract, or an auto-property).
    private static SyntaxNode? Body(IMethodSymbol? method)
    {
        var syntax = method?.DeclaringSyntaxReferences.FirstOrDefault()?.GetSyntax();
        return syntax switch
        {
            MethodDeclarationSyntax m when m.Body != null || m.ExpressionBody != null => m,
            LocalFunctionStatementSyntax l when l.Body != null || l.ExpressionBody != null => l,
            AccessorDeclarationSyntax a when a.Body != null || a.ExpressionBody != null => a,
            ArrowExpressionClauseSyntax arrow => arrow,
            _ => null,
        };
    }

    // What a body returns: its expression body, or each return statement's value (not those of lambdas inside it).
    private IEnumerable<(ExpressionSyntax Value, SemanticModel Model)> Returns(SyntaxNode body)
    {
        var model = walk.ModelOf(body.SyntaxTree);
        var arrow = body switch
        {
            MethodDeclarationSyntax m => m.ExpressionBody,
            LocalFunctionStatementSyntax l => l.ExpressionBody,
            AccessorDeclarationSyntax a => a.ExpressionBody,
            ArrowExpressionClauseSyntax a => a,
            _ => null,
        };
        if (arrow != null)
        {
            yield return (arrow.Expression, model);
            yield break;
        }

        foreach (var ret in body.DescendantNodes(n => n == body || n is not (AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax)).OfType<ReturnStatementSyntax>())
            if (ret.Expression != null) yield return (ret.Expression, model);
    }
}
