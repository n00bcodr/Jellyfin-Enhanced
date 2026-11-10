using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Persistence;

/// <summary>A detached raw JSON document and a revision derived from its exact stored bytes.</summary>
public sealed class UserConfigurationDocument
{
    /// <summary>Token for an absent file; distinct from every existing content hash.</summary>
    public const string MissingRevision = "missing";

    internal UserConfigurationDocument(JToken? document, string revision)
    {
        Document = document;
        Revision = revision;
    }

    /// <summary>The full document, including unknown fields; null only when the file is absent.</summary>
    public JToken? Document { get; }
    public string Revision { get; }
    public bool Exists => Document != null;

    internal static UserConfigurationDocument Missing() => new(null, MissingRevision);
}
