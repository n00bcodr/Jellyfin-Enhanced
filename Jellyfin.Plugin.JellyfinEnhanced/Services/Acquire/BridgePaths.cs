using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>What a targeted refresh would do for one imported file.</summary>
    public static class RefreshOutcome
    {
        /// <summary>Refresh the nearest existing folder.</summary>
        public const string Refresh = "refresh";
        /// <summary>Jellyfin already has the file.</summary>
        public const string Present = "present";
        /// <summary>The nearest existing folder is the root of a library that isn't a movie library (never refreshed by JE).</summary>
        public const string LibraryRoot = "library_root";
        /// <summary>The file is outside every Jellyfin library (after path mapping).</summary>
        public const string OutsideLibrary = "outside_library";
        /// <summary>Jellyfin has no item for any folder above the file inside its library.</summary>
        public const string NoAncestor = "no_ancestor";
    }

    /// <summary>The decision for one imported file.</summary>
    /// <param name="Outcome">One of <see cref="RefreshOutcome"/>.</param>
    /// <param name="File">The file as Jellyfin sees it.</param>
    /// <param name="Ancestor">The nearest folder Jellyfin has (refresh) or the library root it stopped at.</param>
    /// <param name="AncestorId">Its item id.</param>
    /// <param name="AncestorKind">Its kind (season, series, folder, …).</param>
    /// <param name="RefreshPaths">The new file and the new folders between it and the ancestor.</param>
    /// <param name="Library">The library the file belongs to.</param>
    public sealed record RefreshPlan(string Outcome, string File, string? Ancestor, Guid? AncestorId, string? AncestorKind, IReadOnlyList<string> RefreshPaths, JfLibraryRoot? Library);

    /// <summary>
    /// Path rules of the Jellyfin bridge (pure, no I/O of its own): mapping an arr path to Jellyfin's
    /// view with the instance's path mappings, finding the library a path belongs to, and choosing
    /// what to refresh after an import: the nearest folder Jellyfin already has, non-recursively,
    /// with only the new paths looked at — never the root of a TV (or any non-movie) library, whose
    /// series would all be re-validated (spike S2).
    /// </summary>
    public static class BridgePaths
    {
        /// <summary>Normalises separators and drops a trailing slash (a lone "/" stays).</summary>
        public static string Norm(string path)
        {
            var p = path.Trim().Replace('\\', '/');
            while (p.Length > 1 && p.EndsWith('/')) p = p[..^1];
            return p;
        }

        /// <summary>
        /// True for a Windows path (a drive letter or a UNC share, normalised): Windows file systems
        /// ignore case, so "d:/media/movies" and "D:/Media/Movies" are the same folder.
        /// </summary>
        public static bool IsWindows(string path)
        {
            var p = Norm(path);
            return (p.Length >= 2 && p[1] == ':' && char.IsAsciiLetter(p[0])) || p.StartsWith("//", StringComparison.Ordinal);
        }

        /// <summary>How two paths compare: without regard to case when either is a Windows path, exactly otherwise.</summary>
        private static StringComparison Comparison(string a, string b)
            => IsWindows(a) || IsWindows(b) ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

        /// <summary>True when <paramref name="path"/> is <paramref name="folder"/> or inside it (case-insensitive for Windows paths).</summary>
        public static bool IsUnder(string path, string folder)
        {
            var p = Norm(path);
            var f = Norm(folder);
            if (f == "/") return p.StartsWith('/');
            var comparison = Comparison(p, f);
            return string.Equals(p, f, comparison) || p.StartsWith(f + "/", comparison);
        }

        /// <summary>True when both name the same path (case-insensitive for Windows paths).</summary>
        public static bool SamePath(string a, string b)
        {
            var x = Norm(a);
            var y = Norm(b);
            return string.Equals(x, y, Comparison(x, y));
        }

        /// <summary>
        /// A path inside a library with the library folder's part written as Jellyfin has it. Jellyfin
        /// finds items by their exact path, so a Windows arr whose root folder differs only in case
        /// ("d:/media/movies" for Jellyfin's "D:/Media/Movies") would otherwise never match. Other
        /// paths are returned as they are (normalised).
        /// </summary>
        public static string InLibraryCase(string path, IReadOnlyList<JfLibraryRoot> libraries)
        {
            var p = Norm(path);
            if (!IsWindows(p)) return p;
            var (_, location) = LibraryOf(p, libraries);
            return location == null || location == "/" ? p : location + p[location.Length..];
        }

        /// <summary>
        /// The arr path as Jellyfin sees it: the longest configured mapping whose arr side contains it,
        /// else the same path (arr and Jellyfin see the same folders). Returns the mapping used, if any.
        /// </summary>
        public static (string Path, ArrPathMapping? Mapping) Map(string arrPath, IReadOnlyList<ArrPathMapping> mappings)
        {
            var path = Norm(arrPath);
            ArrPathMapping? best = null;
            foreach (var m in mappings)
            {
                if (string.IsNullOrWhiteSpace(m.ArrPath) || string.IsNullOrWhiteSpace(m.JellyfinPath)) continue;
                if (!IsUnder(path, m.ArrPath)) continue;
                if (best == null || Norm(m.ArrPath).Length > Norm(best.ArrPath).Length) best = m;
            }
            if (best == null) return (path, null);
            var from = Norm(best.ArrPath);
            var rest = from == "/" ? path : path[from.Length..];
            var to = Norm(best.JellyfinPath);
            if (rest.Length == 0) return (to, best);
            return ((to == "/" ? string.Empty : to) + (rest.StartsWith('/') ? rest : "/" + rest), best);
        }

        /// <summary>The library (and the folder of it) that contains a Jellyfin path; the deepest folder wins.</summary>
        public static (JfLibraryRoot? Library, string? Location) LibraryOf(string path, IReadOnlyList<JfLibraryRoot> libraries)
        {
            JfLibraryRoot? library = null;
            string? location = null;
            foreach (var lib in libraries)
            {
                foreach (var loc in lib.Locations)
                {
                    if (string.IsNullOrWhiteSpace(loc) || !IsUnder(path, loc)) continue;
                    if (location == null || Norm(loc).Length > location.Length)
                    {
                        library = lib;
                        location = Norm(loc);
                    }
                }
            }
            return (library, location);
        }

        /// <summary>The parent folder of a path, or null at the top.</summary>
        public static string? Parent(string path)
        {
            var p = Norm(path);
            var i = p.LastIndexOf('/');
            if (i < 0) return null;
            if (i == 0) return p.Length > 1 ? "/" : null;
            return p[..i];
        }

        /// <summary>
        /// What to refresh so Jellyfin picks up <paramref name="file"/> (a Jellyfin path): walk up from
        /// the file to the nearest path Jellyfin has an item for, staying inside the file's library.
        /// That folder is refreshed non-recursively with the new paths, unless it is the library's own
        /// folder and the library isn't a movie library (a TV root: never refreshed here).
        /// </summary>
        public static RefreshPlan Plan(string file, IReadOnlyList<JfLibraryRoot> libraries, Func<string, JfPathItem?> find)
        {
            var path = InLibraryCase(file, libraries);
            var (library, location) = LibraryOf(path, libraries);
            if (library == null || location == null) return new RefreshPlan(RefreshOutcome.OutsideLibrary, path, null, null, null, Array.Empty<string>(), null);
            if (find(path) is { } present) return new RefreshPlan(RefreshOutcome.Present, path, path, present.Id, present.Kind, Array.Empty<string>(), library);

            var fresh = new List<string> { path };
            var current = Parent(path);
            while (current != null && IsUnder(current, location))
            {
                var root = SamePath(current, location);
                if (find(current) is { } item)
                {
                    if (root && !string.Equals(library.CollectionType, "movies", StringComparison.OrdinalIgnoreCase))
                        return new RefreshPlan(RefreshOutcome.LibraryRoot, path, current, item.Id, item.Kind, fresh, library);
                    if (!item.IsFolder) break;
                    return new RefreshPlan(RefreshOutcome.Refresh, path, current, item.Id, item.Kind, fresh, library);
                }
                if (root) break;
                fresh.Add(current);
                current = Parent(current);
            }
            return new RefreshPlan(RefreshOutcome.NoAncestor, path, location, null, null, fresh, library);
        }

        /// <summary>
        /// Learns a path mapping from titles both sides have: given (arr folder, Jellyfin folder) pairs
        /// of the same titles, strips their common tail and returns the differing heads when every pair
        /// agrees ("/data/media" → "/rigmedia"); null when they don't agree or nothing differs.
        /// </summary>
        public static (string ArrPath, string JellyfinPath)? LearnMapping(IEnumerable<(string Arr, string Jellyfin)> pairs)
        {
            (string, string)? found = null;
            foreach (var (arr, jf) in pairs)
            {
                var a = Norm(arr).Split('/', StringSplitOptions.RemoveEmptyEntries);
                var j = Norm(jf).Split('/', StringSplitOptions.RemoveEmptyEntries);
                var tail = 0;
                while (tail < a.Length && tail < j.Length && string.Equals(a[a.Length - 1 - tail], j[j.Length - 1 - tail], StringComparison.Ordinal)) tail++;
                if (tail == 0) return null;
                var head = (Head(Norm(arr), tail), Head(Norm(jf), tail));
                if (head.Item1 == head.Item2) continue;
                if (found != null && found != head) return null;
                found = head;
            }
            return found;
        }

        /// <summary>
        /// A normalised path without its last <paramref name="segments"/> segments, keeping the form of
        /// its root: "/data" (POSIX), "D:/Media" (a Windows drive; a bare drive is "D:/"), "//nas/tv" (UNC).
        /// </summary>
        private static string Head(string norm, int segments)
        {
            var p = norm;
            for (var i = 0; i < segments; i++)
            {
                var cut = p.TrimEnd('/').LastIndexOf('/');
                p = cut < 0 ? string.Empty : p[..cut];
            }
            p = p.TrimEnd('/');
            if (p.Length == 0) return "/";
            return p.Length == 2 && p[1] == ':' ? p + "/" : p;
        }

        /// <summary>A movie item's folder: the parent of a video file path; a folder path as it is.</summary>
        public static string ItemFolder(string path)
        {
            var p = Norm(path);
            var name = p[(p.LastIndexOf('/') + 1)..];
            return name.Contains('.', StringComparison.Ordinal) && Parent(p) is { } parent ? parent : p;
        }
    }
}
