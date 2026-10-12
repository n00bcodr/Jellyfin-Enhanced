using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>What went wrong talking to an arr. Stable names: they are serialized for admins.</summary>
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public enum ArrErrorKind
    {
        /// <summary>The URL is not allowed (scheme, metadata endpoint, blocked address).</summary>
        BlockedUrl,
        /// <summary>No connection could be made (DNS, refused, TLS). Nothing reached the arr.</summary>
        Unreachable,
        /// <summary>The call took longer than its budget. A write may or may not have happened.</summary>
        Timeout,
        /// <summary>The connection dropped after the request was sent. A write may or may not have happened.</summary>
        ConnectionLost,
        /// <summary>The server answered with a redirect, which JE never follows.</summary>
        Redirect,
        /// <summary>401/403: wrong or missing API key.</summary>
        Unauthorized,
        /// <summary>404: no such resource (or wrong URL base).</summary>
        NotFound,
        /// <summary>409: conflict (for example an expired release-search cache entry).</summary>
        Conflict,
        /// <summary>400 with validation messages.</summary>
        Validation,
        /// <summary>429 after retries.</summary>
        RateLimited,
        /// <summary>5xx from the arr.</summary>
        Server,
        /// <summary>A success status but not the expected JSON (HTML login page, wrong shape).</summary>
        InvalidResponse,
        /// <summary>The response exceeded the size cap for its call class.</summary>
        TooLarge,
        /// <summary>The URL answers, but it is not the expected app (a Radarr URL in a Sonarr slot).</summary>
        WrongApp,
        /// <summary>The app is right but its version is not supported (Sonarr v3, Radarr before v4).</summary>
        UnsupportedVersion,
        /// <summary>The instance has no usable API key, or is unknown/disabled.</summary>
        NotConfigured,
        /// <summary>A bug in JE (an exception that is not a transport error).</summary>
        Internal,
    }

    /// <summary>One FluentValidation message from a 400 response (attempted values are dropped).</summary>
    public sealed class ArrValidationMessage
    {
        /// <summary>The field the arr complained about.</summary>
        public string Property { get; init; } = string.Empty;

        /// <summary>The arr's message.</summary>
        public string Message { get; init; } = string.Empty;
    }

    /// <summary>
    /// A normalised arr error. The three upstream error shapes (FluentValidation arrays,
    /// ProblemDetails, <c>{message, description}</c>) all end up here; the <c>description</c> stack
    /// trace is never kept. Messages are meant for admins only.
    /// </summary>
    public sealed class ArrError
    {
        /// <summary>Creates an error.</summary>
        public ArrError(ArrErrorKind kind, string message, int httpStatus = 0)
        {
            Kind = kind;
            Message = message;
            HttpStatus = httpStatus;
        }

        /// <summary>The category.</summary>
        public ArrErrorKind Kind { get; }

        /// <summary>A short admin-facing explanation (may include the arr's own message).</summary>
        public string Message { get; }

        /// <summary>HTTP status, 0 when none was received.</summary>
        public int HttpStatus { get; }

        /// <summary>Validation messages for <see cref="ArrErrorKind.Validation"/>.</summary>
        public IReadOnlyList<ArrValidationMessage> Validation { get; init; } = Array.Empty<ArrValidationMessage>();

        /// <summary>Server-suggested wait for <see cref="ArrErrorKind.RateLimited"/>.</summary>
        [JsonIgnore]
        public TimeSpan? RetryAfter { get; init; }

        /// <summary>
        /// True when the arr answered with a success status but JE could not use the reply (empty,
        /// unreadable or too large): the request was accepted, so for a write the change happened.
        /// </summary>
        public bool Accepted { get; init; }

        /// <summary>
        /// True when the request may have reached the arr and changed something (a timeout or a
        /// dropped connection after sending, or an accepted request whose reply was unusable). Writes
        /// in this state must be read back before anything is retried. (A 5xx is not "maybe": the arr
        /// answered and said it failed.)
        /// </summary>
        public bool MaybeSent => Accepted || Kind is ArrErrorKind.Timeout or ArrErrorKind.ConnectionLost;

        /// <inheritdoc />
        public override string ToString() => HttpStatus > 0 ? $"{Kind} (HTTP {HttpStatus}): {Message}" : $"{Kind}: {Message}";
    }

    /// <summary>Either a value or an <see cref="ArrError"/>.</summary>
    /// <typeparam name="T">The value type.</typeparam>
    public readonly struct ArrResult<T>
    {
        private ArrResult(T? value, ArrError? error)
        {
            Value = value;
            Error = error;
        }

        /// <summary>The value when <see cref="Ok"/>.</summary>
        public T? Value { get; }

        /// <summary>The error when not <see cref="Ok"/>.</summary>
        public ArrError? Error { get; }

        /// <summary>True on success.</summary>
        public bool Ok => Error == null;

        /// <summary>A success.</summary>
        public static ArrResult<T> Success(T value) => new(value, null);

        /// <summary>A failure.</summary>
        public static ArrResult<T> Failure(ArrError error) => new(default, error);

        /// <summary>A failure built from parts.</summary>
        public static ArrResult<T> Failure(ArrErrorKind kind, string message, int httpStatus = 0) => new(default, new ArrError(kind, message, httpStatus));
    }

    /// <summary>All records of a paged arr list.</summary>
    /// <typeparam name="T">Record type.</typeparam>
    public sealed class ArrPagedList<T>
    {
        /// <summary>The records read.</summary>
        public List<T> Records { get; init; } = new();

        /// <summary>The arr's <c>totalRecords</c>.</summary>
        public int TotalRecords { get; init; }

        /// <summary>The number of page requests made.</summary>
        public int Pages { get; init; }

        /// <summary>True when the record cap stopped the traversal before <see cref="TotalRecords"/>.</summary>
        public bool Truncated { get; init; }

        /// <summary>
        /// True when the whole list was walked (no cap) but holds fewer distinct rows than the largest
        /// <see cref="TotalRecords"/> reported: rows moved between pages while they were read, so some
        /// were never seen. Only set when the read counted rows by id. Equal counts do not prove
        /// completeness when more than one page was read.
        /// </summary>
        public bool Short { get; init; }
    }
}
