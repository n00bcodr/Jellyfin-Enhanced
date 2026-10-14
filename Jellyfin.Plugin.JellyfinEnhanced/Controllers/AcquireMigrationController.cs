using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>The commit body: the dry run's digest, and the confirmation that requesting is off in Seerr.</summary>
    /// <param name="Digest">Digest from the preview.</param>
    /// <param name="ConfirmRequestsDisabled">Needed only when Seerr's permissions can't be checked.</param>
    public sealed record SeerrMigrationCommitBody(string? Digest, bool ConfirmRequestsDisabled = false);

    /// <summary>The rollback body.</summary>
    /// <param name="BatchId">The batch to roll back.</param>
    public sealed record SeerrMigrationRollbackBody(string? BatchId);

    /// <summary>
    /// Administrators' Seerr to Jellyfin Enhanced authority transfer: status, dry run, commit and rollback.
    /// Every route signs in and requires a Jellyfin administrator; answers carry counts and codes only.
    /// </summary>
    [ApiController]
    [RequestOutcomeFilter]
    [Route("JellyfinEnhanced")]
    public sealed class AcquireMigrationController : ControllerBase
    {
        private readonly SeerrMigration _migration;
        private readonly IArrJellyfinView _view;

        /// <summary>Creates the controller.</summary>
        public AcquireMigrationController(SeerrMigration migration, IArrJellyfinView view)
        {
            _migration = migration;
            _view = view;
        }

        private IActionResult Reply(SeerrMigrationReply reply)
        {
            Response.Headers["Cache-Control"] = "private, no-store";
            // Refusals use the request outcome contract (the page runs the check again for fresh counts).
            if (reply.HttpStatus >= 400)
                return StatusCode(reply.HttpStatus, new RequestOutcome
                {
                    Outcome = reply.Outcome, Reason = reply.Reason, Message = reply.Message, HttpStatus = reply.HttpStatus,
                    Certainty = reply.HttpStatus == 503 ? Services.Arr.ArrActionStatus.Failed : Services.Arr.ArrActionStatus.Rejected,
                });
            return StatusCode(reply.HttpStatus, reply);
        }

        private IActionResult? Refuse()
        {
            if (ArrCaller.Admin(User, _view) != null) return null;
            Response.Headers["Cache-Control"] = "private, no-store";
            var reason = ArrCaller.Human(User, _view) == null ? "user_required" : "admin_required";
            return StatusCode(403, RequestOutcome.Refused(reason) with { Message = "Only Jellyfin administrators can move requests." });
        }

        /// <summary>Request handling now and the newest import batches with their rollback deadline.</summary>
        [Authorize]
        [HttpGet("acquire/migration/seerr")]
        public IActionResult Status()
            => Refuse() ?? Reply(_migration.Status());

        /// <summary>Dry run: reads every Seerr request and says what a move would do. Changes nothing.</summary>
        [Authorize]
        [HttpPost("acquire/migration/seerr/preview")]
        [BodyLimit]
        public async Task<IActionResult> Preview(CancellationToken ct)
            => Refuse() ?? Reply(await _migration.PreviewAsync(ct).ConfigureAwait(false));

        /// <summary>Moves Seerr's pending and processing requests into JE and switches request handling to JE.</summary>
        [Authorize]
        [HttpPost("acquire/migration/seerr/commit")]
        [BodyLimit]
        public async Task<IActionResult> Commit([FromBody] SeerrMigrationCommitBody? body, CancellationToken ct)
        {
            if (Refuse() is { } refused) return refused;
            var admin = ArrCaller.Admin(User, _view)!;
            return Reply(await _migration.CommitAsync(admin.UserId, body?.Digest, body?.ConfirmRequestsDisabled == true, ct).ConfigureAwait(false));
        }

        /// <summary>Rolls one batch back (14 days) and returns request handling to Seerr; wants changed since are kept.</summary>
        [Authorize]
        [HttpPost("acquire/migration/seerr/rollback")]
        [BodyLimit]
        public IActionResult Rollback([FromBody] SeerrMigrationRollbackBody? body)
            => Refuse() ?? Reply(_migration.Rollback(body?.BatchId));
    }
}
