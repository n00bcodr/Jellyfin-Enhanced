using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net;
using System.Text;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify
{
    /// <summary>A rendered message for phone and e-mail.</summary>
    /// <param name="Title">Headline (push title, e-mail subject).</param>
    /// <param name="Body">One or more plain lines.</param>
    public sealed record NotifyMessage(string Title, string Body);

    /// <summary>
    /// The English texts of phone pushes and e-mails (the in-app inbox renders the same kinds and
    /// parameters from the locale files in the browser). Episode texts carry numbers only — never an
    /// episode's name, synopsis or still — so an arrival never spoils what happens in it. With
    /// "hide titles" a user's pushes and e-mails don't name any title at all (administrators' alerts
    /// included: a request, a reminder and the stuck digest say how many, not what).
    /// </summary>
    public static class NotifyTexts
    {
        /// <summary>Renders a notification for phone and e-mail.</summary>
        public static NotifyMessage Render(string kind, IReadOnlyDictionary<string, string> p, bool hideTitles)
        {
            string P(string name) => p.TryGetValue(name, out var v) ? v : string.Empty;
            var title = hideTitles ? string.Empty : P("title");
            var named = title.Length > 0;
            var contact = P("contact").Length > 0 ? P("contact") : "The server owner";
            switch (kind)
            {
                case NotifyKind.Ready:
                    return named
                        ? new NotifyMessage($"{title} is ready to watch", P("year").Length > 0 ? $"{title} ({P("year")}) is in the library." : $"{title} is in the library.")
                        : new NotifyMessage("Something you're waiting for is ready", "A title you asked for or follow is in the library.");
                case NotifyKind.Episodes:
                {
                    var mode = P("mode");
                    var count = P("count");
                    var headline = mode switch
                    {
                        "single" => named ? $"{title}: episode {P("episode")} is ready" : "A new episode is ready",
                        "season" => named ? $"{title}: Season {P("season")} is ready" : "A new season is ready",
                        _ => named ? $"{title}: {count} new episodes ready" : $"{count} new episodes ready",
                    };
                    var body = mode switch
                    {
                        "single" => $"Season {P("season")}, episode {P("episode")}.",
                        "season" => $"All {count} episodes of season {P("season")}.",
                        _ => P("seasons").Contains(',', StringComparison.Ordinal) ? $"Seasons {P("seasons")}." : $"Season {P("seasons")}.",
                    };
                    return new NotifyMessage(headline, body);
                }
                case NotifyKind.Declined:
                {
                    // The decline reason is free text that may name the title: never with "hide titles".
                    var reason = named ? P("reason") : string.Empty;
                    var headline = named ? $"{contact} said no to {title}" : $"{contact} said no to a request";
                    return new NotifyMessage(headline, reason.Length > 0 ? $"“{reason}”" : "You can still follow it to hear if it comes later.");
                }
                case NotifyKind.Approved:
                {
                    var scope = Scope(P("scope"));
                    if (P("shared") == "1")
                        return new NotifyMessage(named ? $"{title}{scope} is on its way" : "Something you asked for is on its way", "Someone else in your household asked for it too. You'll hear when it's ready.");
                    return new NotifyMessage(named ? $"{contact} OK'd {title}{scope}" : $"{contact} OK'd a request", "It's on its way. You'll hear when it's ready.");
                }
                case NotifyKind.Approval:
                    return new NotifyMessage($"{Who(P("user"))} asked for {Fallback(title, "a title")}", "It is waiting for your OK.");
                case NotifyKind.InstanceDown:
                    return new NotifyMessage($"{P("instance")} isn't answering", $"No answer for {P("minutes")} minutes. Downloads and statuses from it are on hold until it is back.");
                case NotifyKind.InstanceUp:
                    return new NotifyMessage($"{P("instance")} is back", "It answers again.");
                case NotifyKind.LowDisk:
                    return new NotifyMessage($"Low disk space on {P("instance")}", $"{P("path")} has {P("percent")}% free ({P("free")}).");
                case NotifyKind.StuckDigest:
                    return new NotifyMessage(P("count") == "1" ? "1 download needs attention" : $"{P("count")} downloads need attention", hideTitles ? $"Stuck for over {P("hours")} hours. Open Jellyfin to see which." : $"Stuck for over {P("hours")} hours: {P("items")}");
                case NotifyKind.Remind:
                    return new NotifyMessage($"{Who(P("user"))} is waiting for {Fallback(title, "a title")}", "It is taking longer than usual and they asked you to have a look.");
                case NotifyKind.Attention:
                    return P("code") switch
                    {
                        AttentionCode.ImportBlocked => new NotifyMessage(
                            named ? $"{title}{Scope(P("scope"))} needs a manual import" : "A download needs a manual import",
                            (P("instance").Length > 0 ? $"{P("instance")} can't import it on its own." : "Sonarr/Radarr can't import it on its own.") + (!hideTitles && P("message").Length > 0 ? $" It says: {P("message")}" : string.Empty)),
                        AttentionCode.ApprovedNotInArr => new NotifyMessage(
                            named ? $"{title} was OK'd in Seerr, but none of the {(P("variant") == "4k" ? "4K " : string.Empty)}Sonarr/Radarr Jellyfin Enhanced watches has it" : "A request OK'd in Seerr reached no Sonarr/Radarr",
                            (P("user").Length > 0 && !hideTitles ? $"Asked for by {P("user")}. " : string.Empty) + "Check Seerr's Sonarr/Radarr settings."),
                        Requests.EpisodeIdentity.Unresolved => new NotifyMessage(
                            named ? $"{title}{Scope(P("scope"))} is held: it can't be matched to Sonarr's episodes" : "A request is held: its episode can't be matched to Sonarr's",
                            (P("user").Length > 0 && !hideTitles ? $"Asked for by {P("user")}. " : string.Empty) + "TMDB and Sonarr number this series differently and the episode couldn't be matched by its id, so it wasn't searched for. Check it in Requests."),
                        _ => new NotifyMessage("Something needs attention", "Open the Requests page to see what."),
                    };
                case NotifyKind.Test:
                    return new NotifyMessage("Test from Jellyfin Enhanced", "Alerts work. This is how you'll hear when something is ready.");
                default:
                    return new NotifyMessage("Jellyfin Enhanced", "Something changed.");
            }
        }

        /// <summary>
        /// One message for several alerts that went out together (a backlog after quiet hours or notifications being
        /// off): how many, never which titles.
        /// </summary>
        /// <param name="count">How many alerts it stands for.</param>
        public static NotifyMessage Summary(int count)
            => new(count.ToString(CultureInfo.InvariantCulture) + " new notifications", "They are in the bell in Jellyfin. Open it to see them.");

        /// <summary>The e-mail bodies (plain and HTML) with the deep link and the unsubscribe line.</summary>
        public static (string Text, string Html) Email(NotifyMessage message, string? link, string? settingsLink, string serverName)
        {
            var text = new StringBuilder();
            text.AppendLine(message.Title).AppendLine().AppendLine(message.Body);
            if (!string.IsNullOrEmpty(link)) text.AppendLine().Append("Open: ").AppendLine(link);
            text.AppendLine().AppendLine("--");
            text.Append("Sent by Jellyfin Enhanced on ").Append(serverName).AppendLine(".");
            if (!string.IsNullOrEmpty(settingsLink)) text.Append("Stop these e-mails or choose what you hear about: ").AppendLine(settingsLink);

            var html = new StringBuilder();
            html.Append("<!doctype html><html><body style=\"font-family:sans-serif;line-height:1.4;color:#222\">");
            html.Append("<h2 style=\"font-size:18px;margin:0 0 8px\">").Append(WebUtility.HtmlEncode(message.Title)).Append("</h2>");
            html.Append("<p style=\"margin:0 0 12px\">").Append(WebUtility.HtmlEncode(message.Body)).Append("</p>");
            if (!string.IsNullOrEmpty(link))
                html.Append("<p><a href=\"").Append(WebUtility.HtmlEncode(link)).Append("\" style=\"display:inline-block;padding:8px 14px;background:#5c52d6;color:#fff;border-radius:6px;text-decoration:none\">Open in Jellyfin</a></p>");
            html.Append("<hr style=\"border:none;border-top:1px solid #ddd;margin:16px 0\"><p style=\"font-size:12px;color:#666\">Sent by Jellyfin Enhanced on ").Append(WebUtility.HtmlEncode(serverName)).Append('.');
            if (!string.IsNullOrEmpty(settingsLink))
                html.Append(" <a href=\"").Append(WebUtility.HtmlEncode(settingsLink)).Append("\">Unsubscribe or choose what you hear about</a>.");
            html.Append("</p></body></html>");
            return (text.ToString(), html.ToString());
        }

        private static string Scope(string scope) => scope.Length > 0 ? " " + scope : string.Empty;

        private static string Who(string name) => name.Length > 0 ? name : "Someone in your household";

        private static string Fallback(string value, string fallback) => value.Length > 0 ? value : fallback;

        /// <summary>A byte count in plain words ("1.2 TB", "640 GB").</summary>
        public static string Size(long bytes)
        {
            const double Gb = 1024d * 1024 * 1024;
            return bytes >= 1024 * Gb
                ? (bytes / (1024 * Gb)).ToString("0.0", CultureInfo.InvariantCulture) + " TB"
                : (bytes / Gb).ToString(bytes >= 10 * Gb ? "0" : "0.0", CultureInfo.InvariantCulture) + " GB";
        }
    }
}
