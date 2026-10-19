using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>Body of POST acquire/notify/read.</summary>
    public class NotifyReadRequest
    {
        /// <summary>Notification ids to mark read.</summary>
        [JsonPropertyName("ids")] public List<long>? Ids { get; set; }

        /// <summary>Mark everything read.</summary>
        [JsonPropertyName("all")] public bool All { get; set; }
    }

    /// <summary>Body of PUT acquire/notify/prefs (only the fields sent change).</summary>
    public class NotifyPrefsRequest
    {
        /// <summary>Toasts on open pages.</summary>
        [JsonPropertyName("toasts")] public bool? Toasts { get; set; }

        /// <summary>Ready alerts.</summary>
        [JsonPropertyName("ready")] public bool? Ready { get; set; }

        /// <summary>New-episode alerts.</summary>
        [JsonPropertyName("episodes")] public bool? Episodes { get; set; }

        /// <summary>Declined alerts.</summary>
        [JsonPropertyName("declined")] public bool? Declined { get; set; }

        /// <summary>OK'd alerts (requests Jellyfin Enhanced handles).</summary>
        [JsonPropertyName("approved")] public bool? Approved { get; set; }

        /// <summary>Administrators: admin alerts to phone/e-mail.</summary>
        [JsonPropertyName("adminAlerts")] public bool? AdminAlerts { get; set; }

        /// <summary>Follow what I request.</summary>
        [JsonPropertyName("autoFollowRequests")] public bool? AutoFollowRequests { get; set; }

        /// <summary>Phone alerts on/off.</summary>
        [JsonPropertyName("ntfy")] public bool? Ntfy { get; set; }

        /// <summary>E-mail alerts on/off (needs a verified address).</summary>
        [JsonPropertyName("email")] public bool? Email { get; set; }

        /// <summary>Don't name titles in phone and e-mail texts.</summary>
        [JsonPropertyName("hideTitles")] public bool? HideTitles { get; set; }

        /// <summary>Quiet hours on/off.</summary>
        [JsonPropertyName("quietHours")] public bool? QuietHours { get; set; }

        /// <summary>Quiet hours start (HH:mm).</summary>
        [JsonPropertyName("quietFrom")] public string? QuietFrom { get; set; }

        /// <summary>Quiet hours end (HH:mm).</summary>
        [JsonPropertyName("quietTo")] public string? QuietTo { get; set; }

        /// <summary>The browser's time zone (IANA).</summary>
        [JsonPropertyName("timeZone")] public string? TimeZone { get; set; }

        /// <summary>The browser's UTC offset in minutes.</summary>
        [JsonPropertyName("utcOffsetMinutes")] public int? UtcOffsetMinutes { get; set; }
    }

    /// <summary>Body of POST acquire/notify/ntfy/topic and PUT arr/admin/notify/users/{id}.</summary>
    public class NotifyTopicRequest
    {
        /// <summary>A topic name (8-64 of A-Z, a-z, 0-9, '-' and '_'), or empty to clear.</summary>
        [JsonPropertyName("topic")] public string? Topic { get; set; }

        /// <summary>Make up a random topic instead.</summary>
        [JsonPropertyName("generate")] public bool Generate { get; set; }
    }

    /// <summary>Body of POST acquire/notify/email and acquire/notify/email/verify.</summary>
    public class NotifyEmailRequest
    {
        /// <summary>The address to verify.</summary>
        [JsonPropertyName("address")] public string? Address { get; set; }

        /// <summary>The code from the e-mail.</summary>
        [JsonPropertyName("code")] public string? Code { get; set; }
    }

    /// <summary>Body of PUT acquire/follows.</summary>
    public class FollowRequest
    {
        /// <summary>Title key (movie, series or season).</summary>
        [JsonPropertyName("key")] public string? Key { get; set; }

        /// <summary>Follow (true) or stop following (false).</summary>
        [JsonPropertyName("on")] public bool On { get; set; }
    }

    /// <summary>Body of POST acquire/remind.</summary>
    public class RemindRequest
    {
        /// <summary>Title key the page shows.</summary>
        [JsonPropertyName("key")] public string? Key { get; set; }

        /// <summary>The Jellyfin item the page shows, when there is one.</summary>
        [JsonPropertyName("itemId")] public string? ItemId { get; set; }
    }

    /// <summary>Body of POST arr/admin/notify/test.</summary>
    public class NotifyAdminTestRequest
    {
        /// <summary>ntfy or email.</summary>
        [JsonPropertyName("channel")] public string? Channel { get; set; }

        /// <summary>For ntfy: the topic to send to (default: the administrator's own).</summary>
        [JsonPropertyName("topic")] public string? Topic { get; set; }

        /// <summary>For e-mail: the address to send to (default: the administrator's verified one).</summary>
        [JsonPropertyName("address")] public string? Address { get; set; }
    }

    /// <summary>
    /// Notifications and follows ("Requests &amp; downloads", phase 2). Every route needs a signed-in
    /// user and the phase-2 notifications switch; each user only ever reads and changes their own
    /// inbox, follows and settings. Users never give an address the server would contact: they pick
    /// an ntfy topic on the administrator's server and verify their own e-mail address with a code.
    /// The <c>arr/admin/notify*</c> routes are for administrators only and never return a secret.
    /// </summary>
    [ApiController]
    [Route("JellyfinEnhanced")]
    public class NotifyController : ControllerBase
    {
        private const int MaxPage = 50;
        /// <summary>Largest mark-read body (500 ids).</summary>
        public const int MaxReadBodyBytes = 64 * 1024;
        private static readonly TimeSpan EmailCodeLifetime = TimeSpan.FromMinutes(30);
        private static readonly TimeSpan EmailResendAfter = TimeSpan.FromSeconds(60);
        private const int EmailSendsPerDay = 5;
        private const int EmailCodeAttempts = 5;

        private readonly NotificationService _service;
        private readonly NotifyDispatcher _dispatcher;
        private readonly NtfySender _ntfy;
        private readonly EmailSender _email;
        private readonly INotifyUsers _users;

        /// <summary>Creates the controller.</summary>
        public NotifyController(NotificationService service, NotifyDispatcher dispatcher, NtfySender ntfy, EmailSender email, INotifyUsers users)
        {
            _service = service;
            _dispatcher = dispatcher;
            _ntfy = ntfy;
            _email = email;
            _users = users;
        }

        /// <summary>The configuration (tests replace it).</summary>
        internal Func<PluginConfiguration?> Config { get; set; } = () => JellyfinEnhanced.Instance?.Configuration;

        /// <summary>The clock (tests replace it).</summary>
        internal Func<DateTimeOffset> Now { get; set; } = () => DateTimeOffset.UtcNow;

        private NotifyStore Store => _service.Store;

        // ================================================================== inbox

        /// <summary>The caller's notifications, newest first (<paramref name="before"/> pages back), and the unread count.</summary>
        [HttpGet("acquire/notify/inbox")]
        [Authorize]
        public IActionResult GetInbox([FromQuery] long? before, [FromQuery] int? limit)
        {
            if (Gate() is { } denied) return denied;
            var user = UserId()!.Value;
            var take = Math.Clamp(limit ?? 20, 1, MaxPage);
            // Administrators' alerts (paths, instance names, queue titles) only while the caller is one.
            var admin = IsAdmin();
            var rows = Store.InboxRows(user, before, take + 1, adminKinds: admin);
            var viewer = _service.Status.View.Viewer(user);
            // The caller's Hidden Content is read once for the whole page.
            var check = viewer == null ? null : _dispatcher.Check(user, viewer);
            Response.Headers["Cache-Control"] = "private, no-store";
            return Ok(new
            {
                unread = Store.Unread(user, adminKinds: admin),
                more = rows.Count > take,
                items = rows.Take(take).Select(r =>
                {
                    // A Ready or new-episodes row, or a request's outcome, as the caller may be told about it now, decided as
                    // every channel sends it (NotifyDispatcher.AlertCheck): a title they can open and haven't hidden, a batch
                    // narrowed to the episodes they can open and haven't hidden, counted and worded again; an outcome of a title
                    // they haven't hidden.
                    var payload = new Dictionary<string, string>(NotifyDispatcher.Payload(r.Payload), StringComparer.Ordinal);
                    var itemId = r.ItemId;
                    var verdict = r.Kind is NotifyKind.Ready or NotifyKind.Episodes or NotifyKind.Declined or NotifyKind.Approved && check != null
                        ? check.Decide(r.Kind, r.Key, payload, ref itemId, r.EventKey)
                        : default;
                    var untold = r.Kind is NotifyKind.Ready or NotifyKind.Episodes or NotifyKind.Declined or NotifyKind.Approved && (check == null || verdict.Why != null);
                    // An outcome whose evidence isn't prepared yet (an absent title's rating not verified for the caller's
                    // parental limits): withheld on this read, and prepared for the next one (never decided on missing evidence).
                    if (verdict.Wait && r.Kind is NotifyKind.Declined or NotifyKind.Approved && TitleKey.Parse(r.Key) is { } outcomeKey
                        && _dispatcher.OutcomeInput(outcomeKey, r.EventKey, payload) is { } input)
                        _service.PrepareLater(user, input);
                    // Episode file ids are retained only for server-side delivery checks.
                    var parameters = payload.Where(p => p.Key != "episodeItems").ToDictionary(p => p.Key, p => p.Value, StringComparer.Ordinal);
                    // Such a row (or one whose Hidden Content can't be read now), or an ask waiting for an OK (or a reminder)
                    // whose title they can no longer see (library access or parental limits changed since): kept, but without
                    // what names the title.
                    var hidden = untold
                        || (r.Kind is NotifyKind.Approval or NotifyKind.Remind && !NotificationService.MaySeeAsk(_service.Policy, user, r.Key, parameters, _service.Ledger, r.EventKey));
                    return new InboxItem
                    {
                        Id = r.Id,
                        Kind = r.Kind,
                        Key = hidden ? null : r.Key,
                        ItemId = hidden ? null : itemId,
                        CreatedAt = r.At,
                        Read = r.Read,
                        Params = hidden ? Withheld(r.Kind, parameters) : parameters,
                        Link = NotifyDispatcher.InAppLink(hidden ? null : itemId, r.Kind),
                    };
                }).ToList(),
            });
        }

        /// <summary>
        /// A withheld row's parameters (4f round 6): an allowlisted generic shape, never the stored payload minus a few keys. Only
        /// what picks the generic wording is kept, each value checked against its fixed form: <c>variant</c> "4k",
        /// <c>shared</c> "1", and for new episodes a plain <c>count</c>. No title, key, artwork, scope, people or free text (a
        /// decline reason) ever leaves the server for a row the recipient may not be told about.
        /// </summary>
        internal static Dictionary<string, string> Withheld(string kind, IReadOnlyDictionary<string, string> p)
        {
            var kept = new Dictionary<string, string>(StringComparer.Ordinal);
            if (p.TryGetValue("variant", out var variant) && variant == "4k") kept["variant"] = "4k";
            if (p.TryGetValue("shared", out var shared) && shared == "1") kept["shared"] = "1";
            if (kind == NotifyKind.Episodes && p.TryGetValue("count", out var count) && count.Length is > 0 and <= 4 && count.All(char.IsAsciiDigit)) kept["count"] = count;
            return kept;
        }

        /// <summary>Marks some (or all) of the caller's notifications read.</summary>
        [HttpPost("acquire/notify/read")]
        [Authorize]
        [BodyLimit(MaxReadBodyBytes)]
        public IActionResult MarkRead([FromBody] NotifyReadRequest? request)
        {
            if (Gate() is { } denied) return denied;
            var user = UserId()!.Value;
            if (request == null || (!request.All && (request.Ids == null || request.Ids.Count == 0))) return BadRequest(new { code = "nothing_to_mark" });
            if (request.Ids is { Count: > 500 }) return BadRequest(new { code = "too_many" });
            var changed = Store.MarkRead(user, request.All ? null : request.Ids, Now());
            if (changed > 0) FeedBump(user);
            return Ok(new { changed, unread = Store.Unread(user, adminKinds: IsAdmin()) });
        }

        // ================================================================== preferences

        /// <summary>The caller's notification settings and which channels the administrator offers.</summary>
        [HttpGet("acquire/notify/prefs")]
        [Authorize]
        public IActionResult GetPrefs()
        {
            if (Gate() is { } denied) return denied;
            return Ok(PrefsBody(UserId()!.Value));
        }

        /// <summary>Changes the caller's notification settings (only the fields sent).</summary>
        [HttpPut("acquire/notify/prefs")]
        [Authorize]
        [BodyLimit]
        public IActionResult PutPrefs([FromBody] NotifyPrefsRequest? request)
        {
            if (Gate() is { } denied) return denied;
            if (request == null) return BadRequest(new { code = "invalid_request" });
            var user = UserId()!.Value;
            if (request.QuietFrom != null && !QuietHours.TryTime(request.QuietFrom, out _)) return BadRequest(new { code = "invalid_time" });
            if (request.QuietTo != null && !QuietHours.TryTime(request.QuietTo, out _)) return BadRequest(new { code = "invalid_time" });
            if (request.TimeZone != null && (request.TimeZone.Length > 64 || request.TimeZone.Any(ch => !(char.IsLetterOrDigit(ch) || ch is '/' or '_' or '-' or '+')))) return BadRequest(new { code = "invalid_time_zone" });
            // Only the fields sent change, in one transaction, checked against the settings as they are in it: a change made
            // meanwhile elsewhere (another tab, an administrator's topic, the Ready settings' native-message consent, an
            // address removed) is kept, and e-mail or phone alerts never go on without a confirmed address or a topic.
            var (_, error) = Store.TryUpdatePrefs(user, p =>
            {
                if (request.Email == true && string.IsNullOrEmpty(p.EmailAddress)) return "email_not_verified";
                if (request.Ntfy == true && !NotifyEndpoints.IsTopic(p.NtfyTopic)) return "ntfy_topic_missing";
                p.Toasts = request.Toasts ?? p.Toasts;
                p.Ready = request.Ready ?? p.Ready;
                p.Episodes = request.Episodes ?? p.Episodes;
                p.Declined = request.Declined ?? p.Declined;
                p.Approved = request.Approved ?? p.Approved;
                p.AdminAlerts = request.AdminAlerts ?? p.AdminAlerts;
                p.AutoFollowRequests = request.AutoFollowRequests ?? p.AutoFollowRequests;
                p.Ntfy = request.Ntfy ?? p.Ntfy;
                p.Email = request.Email ?? p.Email;
                p.HideTitles = request.HideTitles ?? p.HideTitles;
                p.QuietHours = request.QuietHours ?? p.QuietHours;
                p.QuietFrom = request.QuietFrom ?? p.QuietFrom;
                p.QuietTo = request.QuietTo ?? p.QuietTo;
                if (request.TimeZone != null) p.TimeZone = request.TimeZone.Length == 0 ? null : request.TimeZone;
                if (request.UtcOffsetMinutes.HasValue) p.UtcOffsetMinutes = Math.Clamp(request.UtcOffsetMinutes.Value, -14 * 60, 14 * 60);
                return null;
            }, Now());
            if (error != null) return BadRequest(new { code = error });
            return Ok(PrefsBody(user));
        }

        /// <summary>Sets (or makes up, or clears) the caller's ntfy topic on the administrator's server.</summary>
        [HttpPost("acquire/notify/ntfy/topic")]
        [Authorize]
        [BodyLimit]
        public IActionResult SetTopic([FromBody] NotifyTopicRequest? request)
        {
            if (Gate() is { } denied) return denied;
            if (request == null) return BadRequest(new { code = "invalid_request" });
            var user = UserId()!.Value;
            if (!request.Generate && !string.IsNullOrEmpty(request.Topic) && !NotifyEndpoints.IsTopic(request.Topic)) return BadRequest(new { code = "invalid_topic" });
            var topic = request.Generate ? NotifyEndpoints.NewTopic() : string.IsNullOrEmpty(request.Topic) ? null : request.Topic;
            // The topic fields only, in one transaction (a consent or address changed meanwhile stays).
            Store.UpdatePrefs(user, p =>
            {
                p.NtfyTopic = topic;
                p.NtfyTopicByAdmin = false;
                if (topic == null) p.Ntfy = false;
                else if (request.Generate) p.Ntfy = true;
            }, Now());
            return Ok(PrefsBody(user));
        }

        /// <summary>Starts verifying an e-mail address: sends a 6-digit code to it (rate-limited).</summary>
        [HttpPost("acquire/notify/email")]
        [Authorize]
        [BodyLimit]
        public async Task<IActionResult> StartEmail([FromBody] NotifyEmailRequest? request, CancellationToken cancellationToken)
        {
            if (Gate() is { } denied) return denied;
            var config = Config();
            if (!NotifyEndpoints.EmailReady(config)) return StatusCode(409, new { code = "email_not_set_up" });
            var address = NotifyEndpoints.EmailAddress(request?.Address);
            if (address == null) return BadRequest(new { code = "invalid_address" });
            var user = UserId()!.Value;
            var now = Now();
            var code = RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6", CultureInfo.InvariantCulture);
            // Checked and counted in one transaction: requests at once can't send more than the limits allow.
            var (outcome, retryAfter) = Store.ReserveEmailCode(user, address, Hash(user, code), now + EmailCodeLifetime, now, EmailResendAfter, EmailSendsPerDay);
            if (outcome == "too_soon")
            {
                Response.Headers.RetryAfter = Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds)).ToString(CultureInfo.InvariantCulture);
                return StatusCode(429, new { code = "too_soon" });
            }
            if (outcome != "ok") return StatusCode(429, new { code = outcome });
            var message = new NotifyMessage("Your Jellyfin Enhanced code: " + code, $"Enter {code} in Jellyfin (Jellyfin Enhanced settings, \"Requests & alerts\") to get alerts at this address. The code is valid for 30 minutes. If you didn't ask for it, ignore this e-mail.");
            var result = await _email.SendAsync(config!, address, message, null, null, cancellationToken).ConfigureAwait(false);
            if (!result.Ok) return StatusCode(502, new { code = "send_failed", message = IsAdmin() ? result.Error : null });
            return Ok(new { sent = true, expiresAt = now + EmailCodeLifetime });
        }

        /// <summary>Finishes verifying the e-mail address with the code; e-mail alerts are then on.</summary>
        [HttpPost("acquire/notify/email/verify")]
        [Authorize]
        [BodyLimit]
        public IActionResult VerifyEmail([FromBody] NotifyEmailRequest? request)
        {
            if (Gate() is { } denied) return denied;
            var user = UserId()!.Value;
            var now = Now();
            // The attempt is counted before the code is compared, in one transaction: requests at once
            // get no more than the allowed tries between them.
            var (outcome, address, codeHash) = Store.TryEmailCode(user, now, EmailCodeAttempts);
            if (outcome == "no_pending_code") return BadRequest(new { code = outcome });
            if (outcome != "ok") return StatusCode(429, new { code = outcome });
            var code = (request?.Code ?? string.Empty).Trim();
            if (code.Length != 6 || !CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(Hash(user, code)), Encoding.ASCII.GetBytes(codeHash!)))
            {
                return BadRequest(new { code = "wrong_code" });
            }
            Store.ClearEmailCode(user);
            // The address fields only, in one transaction.
            Store.UpdatePrefs(user, p =>
            {
                p.EmailAddress = address;
                p.Email = true;
            }, now);
            return Ok(PrefsBody(user));
        }

        /// <summary>Forgets the caller's e-mail address (e-mail alerts off).</summary>
        [HttpDelete("acquire/notify/email")]
        [Authorize]
        public IActionResult RemoveEmail()
        {
            if (Gate() is { } denied) return denied;
            var user = UserId()!.Value;
            Store.UpdatePrefs(user, p =>
            {
                p.EmailAddress = null;
                p.Email = false;
            }, Now());
            return Ok(PrefsBody(user));
        }

        /// <summary>Sends the caller a test notification (in-app and every channel they have on); once per 30 seconds.</summary>
        [HttpPost("acquire/notify/test")]
        [Authorize]
        public IActionResult SendTest()
        {
            if (Gate() is { } denied) return denied;
            var user = UserId()!.Value;
            // The 30-second slot is claimed with the test itself (many requests at once send one).
            if (!_service.TrySendTest(user, TimeSpan.FromSeconds(30))) return StatusCode(429, new { code = "too_soon" });
            return Ok(new { sent = true });
        }

        // ================================================================== follows

        /// <summary>The caller's follows, mutes and the titles followed because they asked for them.</summary>
        [HttpGet("acquire/follows")]
        [Authorize]
        public IActionResult GetFollows()
        {
            if (Gate() is { } denied) return denied;
            var (follows, requested) = _service.FollowsOf(UserId()!.Value);
            Response.Headers["Cache-Control"] = "private, no-store";
            return Ok(new
            {
                follows = follows.Where(f => !f.Muted).Select(f => new { key = f.Key, kind = f.Kind, since = f.CreatedAt }).ToList(),
                muted = follows.Where(f => f.Muted).Select(f => f.Key).ToList(),
                requested,
            });
        }

        /// <summary>"Notify me" (or stop): follow or unfollow a movie, series ("new episodes") or season.</summary>
        [HttpPut("acquire/follows")]
        [Authorize]
        [BodyLimit]
        public async Task<IActionResult> PutFollow([FromBody] FollowRequest? request, CancellationToken cancellationToken)
        {
            if (Gate() is { } denied) return denied;
            if (TitleKey.Parse(request?.Key) is not { } key || key.Episode.HasValue) return BadRequest(new { code = "invalid_key" });
            if (_service.Status.View.Viewer(UserId()!.Value) is not { } viewer) return StatusCode(403, new { code = "user_required" });
            var outcome = await _service.SetFollowAsync(viewer, key, request!.On, cancellationToken).ConfigureAwait(false);
            return outcome switch
            {
                "ok" => Ok(new { key = key.ToString(), following = request.On }),
                "not_allowed" => StatusCode(403, new { code = "not_allowed" }),
                "too_many" => StatusCode(409, new { code = "too_many", max = NotifyStore.MaxFollowsPerUser }),
                "disabled" => StatusCode(403, new { code = "feature_disabled" }),
                _ => BadRequest(new { code = outcome }),
            };
        }

        /// <summary>"Remind {contact}" about a title that is taking longer than usual (at most once per 24 hours per title).</summary>
        [HttpPost("acquire/remind")]
        [Authorize]
        [BodyLimit]
        public async Task<IActionResult> Remind([FromBody] RemindRequest? request, CancellationToken cancellationToken)
        {
            if (Gate() is { } denied) return denied;
            if (TitleKey.Parse(request?.Key) is not { } key) return BadRequest(new { code = "invalid_key" });
            Guid? itemId = null;
            if (!string.IsNullOrEmpty(request!.ItemId))
            {
                if (!Guid.TryParse(request.ItemId, out var id)) return BadRequest(new { code = "invalid_id" });
                itemId = id;
            }
            if (_service.Status.View.Viewer(UserId()!.Value) is not { } viewer) return StatusCode(403, new { code = "user_required" });
            var outcome = await _service.RemindAsync(viewer, key, itemId, cancellationToken).ConfigureAwait(false);
            return outcome.Code switch
            {
                "ok" => Ok(new { reminded = true, nextAt = outcome.NextAt }),
                "too_soon" => StatusCode(429, new { code = "too_soon", nextAt = outcome.NextAt }),
                "not_stuck" => StatusCode(409, new { code = "not_stuck" }),
                "admin" => StatusCode(409, new { code = "admin" }),
                "disabled" => StatusCode(403, new { code = "feature_disabled" }),
                _ => NotFound(new { code = "not_found" }),
            };
        }

        // ================================================================== administrators

        /// <summary>Notification health for administrators: channels (masked), database, deliveries and every user's channel state.</summary>
        [HttpGet("arr/admin/notify")]
        [Authorize]
        [PrivateResponse]
        public IActionResult GetAdmin()
        {
            if (!IsAdmin()) return Forbid();
            var config = Config();
            var db = Store.Database;
            if (!db.Available)
            {
                return Ok(new { enabled = NotifyFlags.Enabled(config), database = new { available = false, reason = db.UnavailableReason } });
            }
            var now = Now();
            var stats = Store.DeliveryStats(now);
            var prefs = Store.AllPrefs();
            return Ok(new
            {
                enabled = NotifyFlags.Enabled(config),
                database = new { available = true, version = db.Version, sizeBytes = SafeSize(db.FilePath) },
                channels = new
                {
                    ntfy = new { ready = NotifyEndpoints.NtfyReady(config), server = NotifyEndpoints.NtfyServer(config?.ArrNtfyServerUrl), tokenSet = !string.IsNullOrEmpty(config?.ArrNtfyToken) },
                    email = new { ready = NotifyEndpoints.EmailReady(config), host = NotifyEndpoints.SmtpHost(config?.ArrSmtpHost), port = config?.ArrSmtpPort, startTls = config?.ArrSmtpStartTls, from = config?.ArrSmtpFrom, passwordSet = !string.IsNullOrEmpty(config?.ArrSmtpPassword) },
                    householdUrl = NotifyEndpoints.HouseholdUrl(config),
                },
                deliveries = new
                {
                    pending = stats.Pending,
                    sent24h = stats.Sent24h,
                    failed24h = stats.Failed24h,
                    problems = stats.Problems.Select(x => new DeliveryFailure { UserId = NotifyValues.Id(x.User), User = _users.Name(x.User), Channel = x.Channel, Kind = x.Kind, Attempts = x.Attempts, Error = x.Error, Final = x.Final, At = x.At }).ToList(),
                    sentSinceStart = _dispatcher.SentCount,
                    failedAttemptsSinceStart = _dispatcher.FailedCount,
                },
                created = _service.Created,
                users = prefs.Select(kv => new
                {
                    id = NotifyValues.Id(kv.Key),
                    name = _users.Name(kv.Key),
                    ntfy = kv.Value.Ntfy,
                    topic = kv.Value.NtfyTopic,
                    topicByAdmin = kv.Value.NtfyTopicByAdmin,
                    email = kv.Value.Email,
                    emailVerified = !string.IsNullOrEmpty(kv.Value.EmailAddress),
                    quietHours = kv.Value.QuietHours ? kv.Value.QuietFrom + "–" + kv.Value.QuietTo : null,
                }).ToList(),
            });
        }

        /// <summary>Assigns (or clears) a user's ntfy topic (administrators only); the user's phone alerts go on with it.</summary>
        [HttpPut("arr/admin/notify/users/{userId}")]
        [Authorize]
        [PrivateResponse]
        [BodyLimit]
        public IActionResult AssignTopic([FromRoute] string userId, [FromBody] NotifyTopicRequest? request)
        {
            if (!IsAdmin()) return Forbid();
            if (!Store.Available) return StatusCode(503, new { code = "database_unavailable" });
            if (!Guid.TryParse(userId, out var target) || !_users.Exists(target)) return NotFound(new { code = "user_not_found" });
            if (request == null) return BadRequest(new { code = "invalid_request" });
            if (!request.Generate && !string.IsNullOrEmpty(request.Topic) && !NotifyEndpoints.IsTopic(request.Topic)) return BadRequest(new { code = "invalid_topic" });
            var topic = request.Generate ? NotifyEndpoints.NewTopic() : string.IsNullOrEmpty(request.Topic) ? null : request.Topic;
            // The topic fields only, in one transaction: the person's consents, address and quiet hours stay as they are now.
            var prefs = Store.UpdatePrefs(target, p =>
            {
                p.NtfyTopic = topic;
                p.NtfyTopicByAdmin = topic != null;
                p.Ntfy = topic != null;
            }, Now());
            return Ok(new { id = NotifyValues.Id(target), topic = prefs.NtfyTopic, ntfy = prefs.Ntfy });
        }

        /// <summary>
        /// Sends one test message straight through a channel with the saved settings and returns the
        /// outcome (administrators only): ntfy to a topic (default: the administrator's own), e-mail to
        /// an address (default: the administrator's verified one).
        /// </summary>
        [HttpPost("arr/admin/notify/test")]
        [Authorize]
        [PrivateResponse]
        [BodyLimit]
        public async Task<IActionResult> AdminTest([FromBody] NotifyAdminTestRequest? request, CancellationToken cancellationToken)
        {
            if (!IsAdmin()) return Forbid();
            var config = Config();
            if (config == null || request == null) return BadRequest(new { code = "invalid_request" });
            var me = UserId()!.Value;
            var prefs = Store.Available ? Store.Prefs(me) : new NotifyPrefs();
            var message = NotifyTexts.Render(NotifyKind.Test, new Dictionary<string, string>(), false);
            SendResult result;
            switch (request.Channel)
            {
                case NotifyChannel.Ntfy:
                {
                    var topic = string.IsNullOrEmpty(request.Topic) ? prefs.NtfyTopic : request.Topic;
                    if (!NotifyEndpoints.IsTopic(topic)) return BadRequest(new { code = "invalid_topic" });
                    if (NotifyEndpoints.NtfyServer(config.ArrNtfyServerUrl) == null) return BadRequest(new { code = "invalid_server" });
                    result = await _ntfy.SendAsync(config.ArrNtfyServerUrl, config.GetSecret(nameof(PluginConfiguration.ArrNtfyToken)), topic!, message, NotifyDispatcher.SettingsLink(config), new[] { "jellyfish" }, 3, cancellationToken).ConfigureAwait(false);
                    break;
                }
                case NotifyChannel.Email:
                {
                    var address = string.IsNullOrEmpty(request.Address) ? prefs.EmailAddress : NotifyEndpoints.EmailAddress(request.Address);
                    if (address == null) return BadRequest(new { code = "invalid_address" });
                    if (!NotifyEndpoints.EmailReady(config)) return BadRequest(new { code = "email_not_set_up" });
                    result = await _email.SendAsync(config, address, message, null, NotifyDispatcher.SettingsLink(config), cancellationToken).ConfigureAwait(false);
                    break;
                }
                default:
                    return BadRequest(new { code = "invalid_channel" });
            }
            return Ok(new { ok = result.Ok, error = result.Error });
        }

        // ================================================================== helpers

        private object PrefsBody(Guid user)
        {
            var config = Config();
            var prefs = Store.Prefs(user);
            var pending = Store.EmailCode(user);
            return new
            {
                prefs = new
                {
                    toasts = prefs.Toasts,
                    ready = prefs.Ready,
                    episodes = prefs.Episodes,
                    declined = prefs.Declined,
                    // Only while requests go through Jellyfin Enhanced's own ledger (phase 3): null hides the switch.
                    approved = Services.Acquire.Requests.SharedRequestFacts.Active(config) ? prefs.Approved : (bool?)null,
                    adminAlerts = IsAdmin() ? prefs.AdminAlerts : (bool?)null,
                    autoFollowRequests = prefs.AutoFollowRequests,
                    ntfy = prefs.Ntfy,
                    ntfyTopic = prefs.NtfyTopic,
                    ntfyTopicByAdmin = prefs.NtfyTopicByAdmin,
                    email = prefs.Email,
                    emailAddress = prefs.EmailAddress,
                    emailPending = pending is { } p && !string.IsNullOrEmpty(p.CodeHash) && p.Expires > Now() ? p.Address : null,
                    hideTitles = prefs.HideTitles,
                    quietHours = prefs.QuietHours,
                    quietFrom = prefs.QuietFrom,
                    quietTo = prefs.QuietTo,
                    timeZone = prefs.TimeZone,
                },
                channels = new
                {
                    // The ntfy server is what the user subscribes to in the ntfy app, so it is shown;
                    // the access token never is.
                    ntfy = NotifyEndpoints.NtfyReady(config) ? new { available = true, server = NotifyEndpoints.NtfyServer(config!.ArrNtfyServerUrl) } : new { available = false, server = (string?)null },
                    email = new { available = NotifyEndpoints.EmailReady(config) },
                },
                contact = (config?.ArrHouseholdContactName ?? string.Empty).Trim() is { Length: > 0 and <= 40 } name ? name : string.Empty,
                admin = IsAdmin(),
            };
        }

        // Every per-user route: the switch, then a person (an API key, the empty GUID or a user
        // Jellyfin doesn't know gets 403 user_required and nothing is stored for them).
        private IActionResult? Gate()
        {
            if (!NotifyFlags.Enabled(Config())) return StatusCode(403, new { code = "feature_disabled" });
            if (ArrCaller.Human(User, _service.Status.View) is null) return StatusCode(403, new { code = "user_required" });
            if (!Store.Available) return StatusCode(503, new { code = "database_unavailable" });
            return null;
        }

        // The caller's own id (never an API key's empty GUID).
        private Guid? UserId() => ArrCaller.PersonId(User);

        private bool IsAdmin() => ArrCaller.Admin(User, _service.Status.View) != null;

        private void FeedBump(Guid user) => _service.BumpInbox(user);

        // The code is stored hashed with the user id (a leaked row tells nothing).
        private static string Hash(Guid user, string code)
            => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(NotifyValues.Id(user) + ":" + code)));

        private static long? SafeSize(string path)
        {
            try
            {
                return new System.IO.FileInfo(path).Length;
            }
            catch (Exception)
            {
                return null;
            }
        }
    }
}
