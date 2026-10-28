using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import
{
    /// <summary>
    /// The effective import and list-source switches (all off by default). Import needs list authoring
    /// (<see cref="ListFlags.Authoring"/>); From URL needs import; each provider needs From URL and its own switch. Routes
    /// and fetchers check these at execution, not only the client: a switched-off provider is never contacted.
    /// </summary>
    public static class ListImportFlags
    {
        /// <summary>Import review (paste, file, URL) is on.</summary>
        /// <param name="config">Configuration.</param>
        /// <returns>Whether import is on.</returns>
        public static bool Import(PluginConfiguration? config) => ListFlags.Authoring(config) && config!.ArrPhase4ListImportEnabled;

        /// <summary>From URL is on.</summary>
        /// <param name="config">Configuration.</param>
        /// <returns>Whether list sources are on.</returns>
        public static bool Sources(PluginConfiguration? config) => Import(config) && config!.ArrPhase4ListSourcesEnabled;

        /// <summary>A list source kind's own switch (with its parents). Letterboxd is never fetched, so never "on".</summary>
        /// <param name="config">Configuration.</param>
        /// <param name="kind">One of <see cref="SourceKinds"/>.</param>
        /// <returns>Whether that site may be read.</returns>
        public static bool Provider(PluginConfiguration? config, string kind) => Sources(config) && kind switch
        {
            SourceKinds.Mdblist => config!.ArrPhase4ListMdblistEnabled,
            SourceKinds.Tmdb => config!.ArrPhase4ListTmdbEnabled,
            SourceKinds.Chronolists => config!.ArrPhase4ListChronolistsEnabled,
            SourceKinds.Trakt => config!.ArrPhase4ListTraktEnabled,
            SourceKinds.Imdb => config!.ArrPhase4ListImdbEnabled,
            _ => false,
        };

        /// <summary>The administrators' deliberate MDBList API read is allowed (switch on; the key is checked by the fetcher).</summary>
        /// <param name="config">Configuration.</param>
        /// <returns>Whether the MDBList API path may be used.</returns>
        public static bool MdblistApi(PluginConfiguration? config) => Provider(config, SourceKinds.Mdblist) && config!.ArrPhase4ListMdblistApiEnabled;

        /// <summary>JE lists always use TMDB title details; the legacy opt-in remains for other backends.</summary>
        /// <param name="config">Configuration.</param>
        /// <returns>Whether the JE-only metadata path is on.</returns>
        public static bool JeMetadata(PluginConfiguration? config) => ListFlags.Lists(config)
            && (SeerrAddresses.IsJe(config) || config!.ArrPhase4ListJeMetadataEnabled);
    }
}
