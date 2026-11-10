using System.Collections.Generic;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinEnhanced.Transport;

// JSON text deliberately retains numbers outside JavaScript's numeric range. Clients
// display a parsed view; mutations never send this document back to the server.
public sealed class BookmarkDocumentResponse
{
    public required string Revision { get; init; }
    public required string Document { get; init; }
}
public sealed class BookmarkMutationRequest
{
    public required string Revision { get; init; }
    public required IReadOnlyList<BookmarkOperation> Operations { get; init; }
}
public sealed class BookmarkOperation
{
    public required string Kind { get; init; }
    public string? Id { get; init; }
    public string? SourceId { get; init; }
    public string? ExpectedItemId { get; init; }
    public double? Offset { get; init; }
    // Explicitly requested record fields, never a replacement document or copied record.
    [OpaqueBootstrapJson]
    public JsonElement? Fields { get; init; }
}
public sealed class BookmarkSaveReceipt
{
    public required string Revision { get; init; }
}
