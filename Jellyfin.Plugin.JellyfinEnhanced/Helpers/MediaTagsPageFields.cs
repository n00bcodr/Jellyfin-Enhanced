using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// The configuration fields the Media Tags settings page owns, which its field patch
    /// (<see cref="PluginConfigurationPatch"/>) may write: every field its section modules
    /// (js/enhanced/admintags/sections/*.js) declare, an ordered field's <c>orderKey</c>, and the fields a
    /// section's own editors write (<c>writes: ['Field', …]</c>). The page collects the same list from the same
    /// declarations (<c>JE.adminTags.pageFields</c>); everything else, API keys included, stays with the main
    /// configuration page.
    /// </summary>
    public static class MediaTagsPageFields
    {
        // The section modules are embedded under this resource prefix (WhatsNewService reads them too).
        private const string SectionPrefix = "Jellyfin.Plugin.JellyfinEnhanced.js.enhanced.admintags.sections.";

        // A one-line field declaration: { id: '<control id>', key: '<Field>', …, orderKey: '<Field>' …
        private static readonly Regex FieldRegex = new Regex(
            "^\\s*\\{ id: '\\w+', key: '(\\w+)'(?:.*?orderKey: '(\\w+)')?",
            RegexOptions.Multiline | RegexOptions.Compiled);

        // A section's own writes: `writes: ['TagLayouts', 'TagGroupOrder'],`.
        private static readonly Regex WritesRegex = new Regex(
            "^\\s*writes: \\[([^\\]]*)\\]",
            RegexOptions.Multiline | RegexOptions.Compiled);

        private static readonly Regex QuotedRegex = new Regex("'(\\w+)'", RegexOptions.Compiled);

        private static readonly Lazy<IReadOnlySet<string>> Embedded = new Lazy<IReadOnlySet<string>>(() => Parse(ReadSectionModules()));

        /// <summary>Gets the fields the page owns, read from the embedded section modules.</summary>
        public static IReadOnlySet<string> Allowed => Embedded.Value;

        /// <summary>The fields some section modules declare.</summary>
        /// <param name="modules">The modules' sources.</param>
        /// <returns>The field names.</returns>
        public static IReadOnlySet<string> Parse(IEnumerable<string> modules)
        {
            var fields = new HashSet<string>(StringComparer.Ordinal);
            foreach (var text in modules)
            {
                foreach (Match field in FieldRegex.Matches(text))
                {
                    fields.Add(field.Groups[1].Value);
                    if (field.Groups[2].Success) fields.Add(field.Groups[2].Value);
                }

                foreach (Match writes in WritesRegex.Matches(text))
                {
                    foreach (Match name in QuotedRegex.Matches(writes.Groups[1].Value)) fields.Add(name.Groups[1].Value);
                }
            }

            return fields;
        }

        private static IEnumerable<string> ReadSectionModules()
        {
            var assembly = typeof(MediaTagsPageFields).Assembly;
            foreach (var name in assembly.GetManifestResourceNames()
                .Where(n => n.StartsWith(SectionPrefix, StringComparison.Ordinal) && n.EndsWith(".js", StringComparison.Ordinal)))
            {
                using var stream = assembly.GetManifestResourceStream(name);
                if (stream == null) continue;
                using var reader = new StreamReader(stream);
                yield return reader.ReadToEnd();
            }
        }
    }
}
