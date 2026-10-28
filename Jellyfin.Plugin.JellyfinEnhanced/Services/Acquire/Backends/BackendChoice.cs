using System;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends
{
    /// <summary>The persisted choice, parsed without enabling a backend for an unknown value.</summary>
    public enum RequestsBackendMode { Je, Seerr, StatusOnly, Unavailable }
    /// <summary>The purpose of a Seerr operation; the isolation boundary covers every purpose.</summary>
    public enum SeerrUse { Status, Identity, RequestRead, RequestWrite, Metadata, Watchlist, UserImport, Scan, MigrationRead, Diagnostics }
    /// <summary>A configuration-only snapshot. It contains no addresses, credentials or user data.</summary>
    public sealed record EffectiveBackendSnapshot(RequestsBackendMode Mode, int IsolationVersion, bool Isolated,
        long Epoch, bool AllowSeerrTransport, bool AllowDirectRequests, bool RequestsEnabled, string MetadataProvider)
    {
        /// <summary>The stable wire name; status_only and unknown remain non-requesting states.</summary>
        public string Backend => Mode switch { RequestsBackendMode.Je => "je", RequestsBackendMode.Seerr => "seerr", RequestsBackendMode.StatusOnly => "status_only", _ => "unavailable" };
        /// <summary>Local historical JE reads remain authoritative with request switches off.</summary>
        public bool StrictJe => IsolationVersion == 1 && Mode == RequestsBackendMode.Je;
    }
    /// <summary>A typed, safe refusal before dispatch.</summary>
    public sealed record BackendDecision(bool Allowed, string? Reason, long Epoch)
    {
        /// <summary>Throws without including connection information.</summary>
        public void Demand() { if (!Allowed) throw new BackendDisabledException(Reason ?? "backend_disabled"); }
    }
    /// <summary>Isolation or an expired backend generation refused an operation before publication/transport.</summary>
    public sealed class BackendDisabledException : InvalidOperationException
    {
        /// <summary>The stable machine reason.</summary>
        public string Reason { get; }
        /// <summary>Creates a household-safe refusal.</summary>
        public BackendDisabledException(string reason) : base(reason) { Reason = reason; }
    }
}
