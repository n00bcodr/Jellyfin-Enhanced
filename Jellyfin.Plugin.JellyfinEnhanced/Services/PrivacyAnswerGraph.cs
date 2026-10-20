using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Dto;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services;

/// <summary>
/// The one recursive walk over a native answer's object graph. Every title member (a <see cref="BaseItemDto"/>) is found
/// at ANY depth by the host's own declared types, cached per type: a session's NowPlayingItem / NowViewingItem / queue
/// items, a channel's CurrentProgram (on a listed item or on a session's now-playing channel), a timer's ProgramInfo, a
/// sign-in's session, the items of an envelope. The answer's own listed items are walked in place; every other member is
/// handed to the visitor, which returns its replacement (itself, a private copy, a stub, or null to remove it; which
/// members keep a stub comes from <see cref="PrivacyFieldClassification"/>) and walks
/// that replacement's own members. A collection whose member changes is replaced by a private copy (the host may share
/// it); a member that cannot be replaced throws, so the caller withholds instead of delivering it.
/// </summary>
internal static class PrivacyAnswerGraph
{
    /// <summary>Visits one nested title member; returns what the answer carries in its place.</summary>
    public delegate BaseItemDto? Visit(BaseItemDto member, bool keepsControls);

    /// <summary>Deeper than any host answer (sign-in → session → now-playing channel → its programme is 3).</summary>
    private const int MaxDepth = 16;

    private sealed record Member(PropertyInfo Property, bool Dto, bool Sequence, bool KeepsControls);

    private static readonly ConcurrentDictionary<Type, Member[]> _members = new();
    private static readonly ConcurrentDictionary<Type, bool> _reaches = new();

    /// <summary>
    /// Rewrites every title member under <paramref name="node"/> with <paramref name="visit"/>. <paramref name="listed"/>
    /// are the answer's own items: walked in place, never visited. Read-only when <paramref name="mutate"/> is false.
    /// </summary>
    public static void Rewrite(object? node, IReadOnlySet<object>? listed, Visit visit, bool mutate = true)
        => Walk(node, listed, visit, mutate, 0, new HashSet<object>(ReferenceEqualityComparer.Instance));

    /// <summary>Whether a DTO carries any title member of its own (a channel's CurrentProgram).</summary>
    public static bool HasMembers(BaseItemDto dto)
    {
        var any = false;
        Rewrite(dto, null, (member, _) => { any = true; return member; }, mutate: false);
        return any;
    }

    /// <summary>Whether values of this declared type can hold a title member at any depth.</summary>
    public static bool Reaches(Type type) => _reaches.TryGetValue(type, out var known) ? known : Reaches(type, new HashSet<Type>());

    private static void Walk(object? node, IReadOnlySet<object>? listed, Visit visit, bool mutate, int depth, HashSet<object> seen)
    {
        if (node == null || depth > MaxDepth || node is string || node.GetType().IsValueType || !seen.Add(node)) return;
        if (node is IEnumerable sequence)
        {
            // A top-level list answer (sessions, items): its DTOs are the answer's own items.
            foreach (var element in sequence) Walk(element, listed, visit, mutate, depth + 1, seen);
            return;
        }
        foreach (var member in Members(node.GetType()))
        {
            var value = member.Property.GetValue(node);
            if (value == null) continue;
            if (member.Dto)
            {
                var dto = (BaseItemDto)value;
                if (listed?.Contains(dto) == true) { Walk(dto, listed, visit, mutate, depth + 1, seen); continue; }
                var replaced = visit(dto, member.KeepsControls);
                if (mutate && !ReferenceEquals(replaced, dto)) Set(member, node, replaced);
                continue;
            }
            if (member.Sequence && value is IEnumerable elements)
            {
                var items = elements.Cast<object?>().ToArray();
                if (!items.All(i => i is null or BaseItemDto))
                {
                    foreach (var element in items) Walk(element, listed, visit, mutate, depth + 1, seen);
                    continue;
                }
                var kept = new List<BaseItemDto?>(items.Length);
                var changed = false;
                foreach (BaseItemDto? dto in items)
                {
                    if (dto == null || listed?.Contains(dto) == true) { Walk(dto, listed, visit, mutate, depth + 1, seen); kept.Add(dto); continue; }
                    var replaced = visit(dto, member.KeepsControls);
                    changed |= !ReferenceEquals(replaced, dto);
                    if (replaced != null) kept.Add(replaced);
                }
                // A lazy sequence would build fresh (unprojected) DTOs when serialized: it is delivered materialized.
                if (mutate && (changed || items.Length > 0 && value is not (Array or IList))) Set(member, node, kept.ToArray());
                continue;
            }
            Walk(value, listed, visit, mutate, depth + 1, seen);
        }
    }

    private static void Set(Member member, object node, object? value)
    {
        var type = member.Property.PropertyType;
        if (value is BaseItemDto?[] array && !type.IsAssignableFrom(typeof(BaseItemDto[])))
            value = type.IsAssignableFrom(typeof(List<BaseItemDto>)) ? array.ToList() : throw new InvalidOperationException($"{member.Property.DeclaringType?.Name}.{member.Property.Name} cannot hold a projected copy");
        if (member.Property.SetMethod is not { IsPublic: true })
            throw new InvalidOperationException($"{member.Property.DeclaringType?.Name}.{member.Property.Name} cannot be projected (no setter)");
        member.Property.SetValue(node, value);
    }

    /// <summary>The properties of a type that can hold a title member, cached per type.</summary>
    private static Member[] Members(Type type) => _members.GetOrAdd(type, t => t
        .GetProperties(BindingFlags.Public | BindingFlags.Instance)
        .Where(p => p.GetMethod is { IsPublic: true } && p.GetIndexParameters().Length == 0 && Reaches(p.PropertyType))
        // A member a session's controls hang on (host-required in the one field classification: a session's NowPlayingItem,
        // 10.11's NowPlayingQueueFullItems): a hidden one leaves a stub, not a gap. Any other title member is title-bearing.
        .Select(p => new Member(p, typeof(BaseItemDto).IsAssignableFrom(p.PropertyType), Element(p.PropertyType) != null, PrivacyFieldClassification.KeepsControls(p)))
        .ToArray());

    private static bool Reaches(Type type, HashSet<Type> visiting)
    {
        if (_reaches.TryGetValue(type, out var known)) return known;
        if (typeof(BaseItemDto).IsAssignableFrom(type)) return true;
        type = Nullable.GetUnderlyingType(type) ?? type;
        // Library entities never travel in an answer (only their DTOs); a name/value or framework type holds no title member.
        if (type.IsPrimitive || type.IsEnum || type == typeof(string) || type == typeof(object) || type == typeof(decimal) || type == typeof(Guid)
            || type == typeof(DateTime) || type == typeof(DateTimeOffset) || type == typeof(TimeSpan) || typeof(BaseItem).IsAssignableFrom(type)) return false;
        if (Element(type) is { } element) return Reaches(element, visiting);
        if (type.Namespace?.StartsWith("System", StringComparison.Ordinal) != false || type.Namespace.StartsWith("Microsoft", StringComparison.Ordinal)) return false;
        if (!visiting.Add(type)) return false;
        var reaches = type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Any(p => p.GetMethod is { IsPublic: true } && p.GetIndexParameters().Length == 0 && Reaches(p.PropertyType, visiting));
        visiting.Remove(type);
        // A result computed inside a cycle may be partial; only an outermost answer is cached.
        if (visiting.Count == 0) _reaches[type] = reaches;
        return reaches;
    }

    /// <summary>The element type of an array or sequence type (null for strings and non-sequences).</summary>
    private static Type? Element(Type type)
    {
        if (type == typeof(string)) return null;
        if (type.IsArray) return type.GetElementType();
        var sequence = type.IsGenericType && type.GetGenericTypeDefinition() == typeof(IEnumerable<>) ? type
            : type.GetInterfaces().FirstOrDefault(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IEnumerable<>));
        return sequence?.GetGenericArguments()[0];
    }
}
