using System;
using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Net.Mail;
using System.Net.Mime;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Security.Authentication;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify
{
    /// <summary>The outcome of one send.</summary>
    /// <param name="Ok">Delivered to the channel's server.</param>
    /// <param name="Error">Why not (administrator wording; never a secret).</param>
    public sealed record SendResult(bool Ok, string? Error = null)
    {
        /// <summary>Success.</summary>
        public static readonly SendResult Sent = new(true);
    }

    /// <summary>
    /// Checks for the administrator's endpoints. Only administrators configure where notifications
    /// go (the ntfy server, the SMTP server); users only ever pick a topic name or their own address,
    /// so no user can make the server contact a host of their choosing.
    /// </summary>
    public static class NotifyEndpoints
    {
        /// <summary>The HTTP client for ntfy (no redirects, no proxy, guarded connect).</summary>
        public const string ClientName = "JellyfinEnhanced.Notify";

        /// <summary>
        /// A usable ntfy server URL: absolute http(s), no credentials, query or fragment, not a cloud
        /// metadata or link-local address. Returns it without a trailing slash, or null.
        /// </summary>
        public static string? NtfyServer(string? url)
        {
            if (string.IsNullOrWhiteSpace(url)) return null;
            var trimmed = url.Trim().TrimEnd('/');
            if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri)) return null;
            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return null;
            if (!string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment)) return null;
            return ArrUrlGuard.PassesStaticChecks(trimmed) ? trimmed : null;
        }

        /// <summary>A topic name a user may pick: 8-64 letters, digits, '-' or '_' (no slashes, so it can't change the path).</summary>
        public static bool IsTopic(string? topic)
        {
            if (topic is not { Length: >= 8 and <= 64 }) return false;
            foreach (var c in topic)
            {
                if (!(c is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or '_' or '-' || Helpers.AsciiGrammar.IsDigit(c))) return false;
            }
            return true;
        }

        /// <summary>A random topic that nobody can guess (128 bits).</summary>
        public static string NewTopic()
        {
            const string Alphabet = "abcdefghijklmnopqrstuvwxyz234567";
            var bytes = System.Security.Cryptography.RandomNumberGenerator.GetBytes(16);
            var sb = new StringBuilder("je-", 32);
            var buffer = 0;
            var bits = 0;
            foreach (var b in bytes)
            {
                buffer = (buffer << 8) | b;
                bits += 8;
                while (bits >= 5)
                {
                    sb.Append(Alphabet[(buffer >> (bits - 5)) & 31]);
                    bits -= 5;
                }
            }
            if (bits > 0) sb.Append(Alphabet[(buffer << (5 - bits)) & 31]);
            return sb.ToString();
        }

        /// <summary>A plausible single e-mail address (no display name, no line breaks), normalised, or null.</summary>
        public static string? EmailAddress(string? address)
        {
            if (string.IsNullOrWhiteSpace(address)) return null;
            var trimmed = address.Trim();
            if (trimmed.Length > 254 || trimmed.IndexOfAny(new[] { '\r', '\n', ',', ';', '<', '>', ' ', '"' }) >= 0) return null;
            try
            {
                var parsed = new MailAddress(trimmed);
                return parsed.Address == trimmed && parsed.Host.Contains('.', StringComparison.Ordinal) ? parsed.Address : null;
            }
            catch (FormatException)
            {
                return null;
            }
        }

        /// <summary>The household's Jellyfin address for links in pushes and e-mails, without a trailing slash, or null.</summary>
        public static string? HouseholdUrl(PluginConfiguration? config)
        {
            var url = config?.ArrNotifyHouseholdUrl?.Trim().TrimEnd('/');
            if (string.IsNullOrEmpty(url)) return null;
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)) return null;
            if (!string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment)) return null;
            if (url.EndsWith("/web", StringComparison.OrdinalIgnoreCase)) url = url[..^4];
            return url;
        }

        /// <summary>ntfy is switched on and has a valid server.</summary>
        public static bool NtfyReady(PluginConfiguration? c) => c is { ArrNtfyEnabled: true } && NtfyServer(c.ArrNtfyServerUrl) != null;

        /// <summary>E-mail is switched on and has an SMTP host and a sender.</summary>
        public static bool EmailReady(PluginConfiguration? c)
            => c is { ArrEmailEnabled: true } && SmtpHost(c.ArrSmtpHost) != null && EmailAddress(c.ArrSmtpFrom) != null && c.ArrSmtpPort is > 0 and <= 65535;

        /// <summary>An SMTP host name or address (no scheme, port or path), or null.</summary>
        public static string? SmtpHost(string? host)
        {
            var h = host?.Trim();
            if (string.IsNullOrEmpty(h) || h.Length > 253) return null;
            return Uri.CheckHostName(h) == UriHostNameType.Unknown ? null : h;
        }
    }

    /// <summary>Publishes to ntfy (JSON publish to the server root; the token as a bearer header).</summary>
    public sealed class NtfySender
    {
        private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(15);
        private readonly IHttpClientFactory _http;

        /// <summary>Creates the sender (DI).</summary>
        public NtfySender(IHttpClientFactory http)
        {
            _http = http;
        }

        /// <summary>Sends one message to <paramref name="topic"/> on <paramref name="server"/>.</summary>
        public async Task<SendResult> SendAsync(string server, string? token, string topic, NotifyMessage message, string? click, string[]? tags, int priority, CancellationToken cancellationToken)
        {
            var baseUrl = NotifyEndpoints.NtfyServer(server);
            if (baseUrl == null) return new SendResult(false, "The ntfy server address is not valid.");
            if (!NotifyEndpoints.IsTopic(topic)) return new SendResult(false, "The ntfy topic is not valid.");
            var payload = new System.Collections.Generic.Dictionary<string, object>
            {
                ["topic"] = topic,
                ["title"] = message.Title,
                ["message"] = message.Body,
                ["priority"] = Math.Clamp(priority, 1, 5),
            };
            if (!string.IsNullOrEmpty(click)) payload["click"] = click;
            if (tags is { Length: > 0 }) payload["tags"] = tags;
            using var request = new HttpRequestMessage(HttpMethod.Post, baseUrl + "/")
            {
                Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json"),
            };
            if (!string.IsNullOrEmpty(token)) request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cts.CancelAfter(Timeout);
            try
            {
                using var client = _http.CreateClient(NotifyEndpoints.ClientName);
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cts.Token).ConfigureAwait(false);
                if (response.IsSuccessStatusCode) return SendResult.Sent;
                var code = (int)response.StatusCode;
                return new SendResult(false, code switch
                {
                    401 or 403 => $"ntfy refused the message (HTTP {code}): check the access token and that it may publish to this topic.",
                    429 => "ntfy rate-limited the message (HTTP 429).",
                    >= 300 and < 400 => $"ntfy answered with a redirect (HTTP {code}); redirects are not followed. Use the server's final address.",
                    _ => $"ntfy answered HTTP {code}.",
                });
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                return new SendResult(false, "ntfy did not answer within 15 seconds.");
            }
            catch (HttpRequestException ex)
            {
                return new SendResult(false, "Could not reach the ntfy server: " + Scrub(ex.Message));
            }
            catch (Arr.ArrBlockedAddressException ex)
            {
                return new SendResult(false, ex.Message);
            }
        }

        private static string Scrub(string message) => message.Length > 200 ? message[..200] : message;
    }

    /// <summary>Sends one e-mail (an abstraction so tests need no SMTP server).</summary>
    public interface IMailTransport
    {
        /// <summary>Sends <paramref name="message"/> through the administrator's SMTP server.</summary>
        Task SendAsync(PluginConfiguration config, string password, MailMessage message, CancellationToken cancellationToken);
    }

    /// <summary>
    /// SMTP through <see cref="SmtpClient"/> (STARTTLS when the administrator turns it on). A send
    /// (name lookup included) is given up after <see cref="Timeout"/> on every runtime: the client's
    /// own timeout does not bound <c>SendMailAsync</c> everywhere, and a server that never answers
    /// (implicit-TLS port 465 with STARTTLS) must not hold every later delivery back.
    /// </summary>
    public sealed class SmtpMailTransport : IMailTransport
    {
        /// <summary>How long one send may take (tests shorten it).</summary>
        internal TimeSpan Timeout { get; init; } = TimeSpan.FromSeconds(30);

        /// <inheritdoc />
        public async Task SendAsync(PluginConfiguration config, string password, MailMessage message, CancellationToken cancellationToken)
        {
            var host = NotifyEndpoints.SmtpHost(config.ArrSmtpHost) ?? throw new InvalidOperationException("No SMTP server is set up.");
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cts.CancelAfter(Timeout);
            // The administrator's host, checked like every outbound address (no cloud metadata or link-local range).
            var addresses = IPAddress.TryParse(host, out var literal) ? new[] { literal } : await Dns.GetHostAddressesAsync(host, cts.Token).ConfigureAwait(false);
            if (!ArrUrlGuard.AreAddressesAllowed(host, addresses)) throw new InvalidOperationException($"The address of {host} is not allowed (cloud metadata or link-local range).");
            using var client = new SmtpClient(host, config.ArrSmtpPort)
            {
                EnableSsl = config.ArrSmtpStartTls,
                DeliveryMethod = SmtpDeliveryMethod.Network,
                Timeout = (int)Math.Clamp(Timeout.TotalMilliseconds, 1, int.MaxValue),
                UseDefaultCredentials = false,
            };
            if (!string.IsNullOrEmpty(config.ArrSmtpUsername)) client.Credentials = new NetworkCredential(config.ArrSmtpUsername, password);
            await client.SendMailAsync(message, cts.Token).ConfigureAwait(false);
        }
    }

    /// <summary>Builds and sends notification e-mails (plain + HTML, unsubscribe link and header).</summary>
    public sealed class EmailSender
    {
        private readonly IMailTransport _transport;

        /// <summary>Creates the sender (DI).</summary>
        public EmailSender(IMailTransport transport)
        {
            _transport = transport;
        }

        /// <summary>Sends one message to <paramref name="to"/>.</summary>
        public async Task<SendResult> SendAsync(PluginConfiguration config, string to, NotifyMessage message, string? link, string? settingsLink, CancellationToken cancellationToken)
        {
            if (!NotifyEndpoints.EmailReady(config)) return new SendResult(false, "E-mail is not set up (SMTP server and sender).");
            var address = NotifyEndpoints.EmailAddress(to);
            if (address == null) return new SendResult(false, "The recipient address is not valid.");
            var from = NotifyEndpoints.EmailAddress(config.ArrSmtpFrom)!;
            var serverName = string.IsNullOrWhiteSpace(config.ArrSmtpFromName) ? "Jellyfin" : OneLine(config.ArrSmtpFromName);
            var (text, html) = NotifyTexts.Email(message, link, settingsLink, serverName);
            using var mail = new MailMessage
            {
                From = new MailAddress(from, serverName, Encoding.UTF8),
                Subject = OneLine(message.Title),
                SubjectEncoding = Encoding.UTF8,
                Body = text,
                BodyEncoding = Encoding.UTF8,
                IsBodyHtml = false,
            };
            mail.To.Add(new MailAddress(address));
            using var htmlView = AlternateView.CreateAlternateViewFromString(html, Encoding.UTF8, MediaTypeNames.Text.Html);
            mail.AlternateViews.Add(htmlView);
            if (!string.IsNullOrEmpty(settingsLink)) mail.Headers.Add("List-Unsubscribe", "<" + OneLine(settingsLink) + ">");
            mail.Headers.Add("Auto-Submitted", "auto-generated");
            try
            {
                await _transport.SendAsync(config, config.GetSecret(nameof(PluginConfiguration.ArrSmtpPassword)), mail, cancellationToken).ConfigureAwait(false);
                return SendResult.Sent;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (OperationCanceledException)
            {
                return new SendResult(false, "E-mail could not be sent: the mail server did not answer in time.");
            }
            catch (Exception ex) when (ex is SmtpException or SocketException or InvalidOperationException or IOException or OperationCanceledException or AuthenticationException)
            {
                return new SendResult(false, "E-mail could not be sent: " + OneLine(ex.Message));
            }
        }

        private static string OneLine(string text)
        {
            var single = text.Replace('\r', ' ').Replace('\n', ' ');
            return single.Length > 200 ? single[..200] : single;
        }
    }

    /// <summary>When a user's quiet hours end (their own clock).</summary>
    public static class QuietHours
    {
        /// <summary>
        /// Null when <paramref name="now"/> is outside the user's quiet hours (or they have none);
        /// otherwise the moment they end.
        /// </summary>
        public static DateTimeOffset? EndsAt(NotifyPrefs prefs, DateTimeOffset now)
        {
            if (!prefs.QuietHours || !TryTime(prefs.QuietFrom, out var from) || !TryTime(prefs.QuietTo, out var to) || from == to) return null;
            var offset = Offset(prefs, now);
            var local = now.ToOffset(offset);
            var t = local.TimeOfDay;
            bool inside = from < to ? t >= from && t < to : t >= from || t < to;
            if (!inside) return null;
            var endDate = local.Date;
            if (t >= to) endDate = endDate.AddDays(1);
            var end = new DateTimeOffset(endDate + to, offset);
            // Recompute the offset at the end (a DST change overnight).
            var endOffset = Offset(prefs, end);
            return new DateTimeOffset(endDate + to, endOffset);
        }

        private static TimeSpan Offset(NotifyPrefs prefs, DateTimeOffset at)
        {
            if (!string.IsNullOrWhiteSpace(prefs.TimeZone))
            {
                try
                {
                    return TimeZoneInfo.FindSystemTimeZoneById(prefs.TimeZone).GetUtcOffset(at);
                }
                catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException or ArgumentException)
                {
                    // fall back to the offset the browser reported
                }
            }
            return TimeSpan.FromMinutes(Math.Clamp(prefs.UtcOffsetMinutes ?? 0, -14 * 60, 14 * 60));
        }

        /// <summary>Parses "HH:mm".</summary>
        public static bool TryTime(string? text, out TimeSpan time)
        {
            time = default;
            return !string.IsNullOrEmpty(text) && text.Length == 5
                && TimeSpan.TryParseExact(text, "hh\\:mm", CultureInfo.InvariantCulture, out time)
                && time >= TimeSpan.Zero && time < TimeSpan.FromDays(1);
        }
    }
}
