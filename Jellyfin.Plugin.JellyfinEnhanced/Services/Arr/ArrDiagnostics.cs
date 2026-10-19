using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>Result of testing one instance. Admin-only; never carries the API key.</summary>
    public sealed class ArrDiagnosticsResult
    {
        /// <summary>True when the URL is the expected app, the key works and the version is supported.</summary>
        [JsonPropertyName("ok")] public bool Ok { get; init; }

        /// <summary>Instance id ("" for unsaved values).</summary>
        [JsonPropertyName("instanceId")] public string InstanceId { get; init; } = string.Empty;

        /// <summary>Expected kind.</summary>
        [JsonPropertyName("kind")] public ArrKind Kind { get; init; }

        /// <summary>Reported appName.</summary>
        [JsonPropertyName("appName")] public string? AppName { get; init; }

        /// <summary>Reported instance name.</summary>
        [JsonPropertyName("instanceName")] public string? InstanceName { get; init; }

        /// <summary>Reported version.</summary>
        [JsonPropertyName("version")] public string? Version { get; init; }

        /// <summary>False for builds JE does not support.</summary>
        [JsonPropertyName("supported")] public bool Supported { get; init; }

        /// <summary>API dialect in use.</summary>
        [JsonPropertyName("dialect")] public string? Dialect { get; init; }

        /// <summary>Feature gates.</summary>
        [JsonPropertyName("features")] public IReadOnlyDictionary<string, bool>? Features { get; init; }

        /// <summary>Notes about the build.</summary>
        [JsonPropertyName("warnings")] public IReadOnlyList<string> Warnings { get; init; } = Array.Empty<string>();

        /// <summary>The arr's own health checks (up to 10).</summary>
        [JsonPropertyName("health")] public IReadOnlyList<ArrHealthItem> Health { get; init; } = Array.Empty<ArrHealthItem>();

        /// <summary>Round trip of the status call.</summary>
        [JsonPropertyName("latencyMs")] public long LatencyMs { get; init; }

        /// <summary>Why it failed.</summary>
        [JsonPropertyName("error")] public ArrDiagnosticsError? Error { get; init; }
    }

    /// <summary>A failure in <see cref="ArrDiagnosticsResult"/>.</summary>
    public sealed class ArrDiagnosticsError
    {
        /// <summary>Error kind.</summary>
        [JsonPropertyName("kind")] public ArrErrorKind Kind { get; init; }

        /// <summary>Admin-facing message.</summary>
        [JsonPropertyName("message")] public string Message { get; init; } = string.Empty;

        /// <summary>HTTP status (0 when none).</summary>
        [JsonPropertyName("httpStatus")] public int HttpStatus { get; init; }
    }

    /// <summary>One entry of the arr's <c>/health</c>.</summary>
    public sealed class ArrHealthItem
    {
        /// <summary>Check name.</summary>
        [JsonPropertyName("source")] public string Source { get; init; } = string.Empty;

        /// <summary>ok / notice / warning / error.</summary>
        [JsonPropertyName("type")] public string Type { get; init; } = string.Empty;

        /// <summary>The arr's message.</summary>
        [JsonPropertyName("message")] public string Message { get; init; } = string.Empty;
    }

    /// <summary>Connection test for one instance: status, appName, version gates and health.</summary>
    public static class ArrDiagnostics
    {
        /// <summary>Tests the instance behind <paramref name="client"/>.</summary>
        public static async Task<ArrDiagnosticsResult> TestAsync(ArrClient client, CancellationToken cancellationToken)
        {
            var watch = Stopwatch.StartNew();
            var status = await client.GetSystemStatusAsync(refresh: true, cancellationToken).ConfigureAwait(false);
            var latency = watch.ElapsedMilliseconds;
            if (!status.Ok)
            {
                return new ArrDiagnosticsResult
                {
                    Ok = false,
                    InstanceId = client.Connection.Id,
                    Kind = client.Connection.Kind,
                    LatencyMs = latency,
                    Error = new ArrDiagnosticsError { Kind = status.Error!.Kind, Message = status.Error.Message, HttpStatus = status.Error.HttpStatus },
                };
            }

            var (info, caps) = status.Value;
            var health = new List<ArrHealthItem>();
            var healthResult = await client.GetAsync<JsonElement>("health", null, ArrCallClass.Status, cancellationToken).ConfigureAwait(false);
            if (healthResult.Ok && healthResult.Value.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in healthResult.Value.EnumerateArray().Take(10))
                {
                    if (item.ValueKind != JsonValueKind.Object) continue;
                    health.Add(new ArrHealthItem
                    {
                        Source = Str(item, "source"),
                        Type = Str(item, "type"),
                        Message = Str(item, "message"),
                    });
                }
            }

            return new ArrDiagnosticsResult
            {
                Ok = caps.Supported,
                InstanceId = client.Connection.Id,
                Kind = client.Connection.Kind,
                AppName = info.AppName,
                InstanceName = info.InstanceName,
                Version = info.Version,
                Supported = caps.Supported,
                Dialect = caps.Dialect,
                Features = caps.Features,
                Warnings = caps.Warnings,
                Health = health,
                LatencyMs = latency,
                Error = caps.Supported ? null : new ArrDiagnosticsError { Kind = ArrErrorKind.UnsupportedVersion, Message = caps.Warnings.FirstOrDefault() ?? "Unsupported version." },
            };
        }

        private static string Str(JsonElement e, string name)
            => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? string.Empty) : string.Empty;
    }
}
