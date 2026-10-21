using System;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// The signed-in person's revisions, as one value every answer of JE's API carries (<see cref="Header"/>): their access
    /// (a digest of every access-deciding fact of their Jellyfin user, <see cref="UserAuthority.Fingerprint"/>) and the
    /// revisions of the documents a browser tab mirrors (Hidden Content, Spoiler Guard; see
    /// <see cref="UserConfigurationManager.DocumentRevision"/>). Taken BEFORE the request reads anything (the request's own
    /// read of the user, shared with the action), so an answer is never newer than the revision it carries: a client that
    /// sees the revision move knows every answer it kept from before may be for an access, or a document, it no longer
    /// has. Independent of any feature (poster tags off, every JE feature off: still on every answer, and on
    /// <c>GET /JellyfinEnhanced/revision</c>).
    /// </summary>
    internal static class AccessRevision
    {
        /// <summary>The response header (and the bootstrap's <c>Revision</c>): <c>a=&lt;access&gt;;hc=&lt;hidden content&gt;;sg=&lt;spoiler guard&gt;</c>.</summary>
        public const string Header = "X-JE-Revision";

        /// <summary>The Hidden Content document.</summary>
        public const string HiddenContentFile = "hidden-content.json";

        /// <summary>The person's revisions now, read through the request's one read of them (null: no such user).</summary>
        /// <param name="users">Jellyfin's users.</param>
        /// <param name="userId">The signed-in person.</param>
        /// <returns>The value of <see cref="Header"/>, or null.</returns>
        public static string? For(IUserManager users, Guid userId)
        {
            if (userId == Guid.Empty) return null;
            // Documents first: a write landing after this sample shows as a newer revision at the next answer.
            var documents = Documents(userId);
            var (user, _) = UserAuthority.ReadOncePerRequest(userId, id => users.GetUserById(id));
            return user == null ? null : "a=" + Access(user) + ";" + documents;
        }

        /// <summary>A digest of the access-deciding facts of <paramref name="user"/> as just read.</summary>
        /// <param name="user">The user.</param>
        /// <returns>12 hex characters.</returns>
        public static string Access(JUser user)
            => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(UserAuthority.Fingerprint(user))), 0, 6).ToLowerInvariant();

        /// <summary>The document part: <c>hc=…;sg=…</c>.</summary>
        /// <param name="userId">The person.</param>
        /// <returns>The text.</returns>
        public static string Documents(Guid userId)
        {
            var id = userId.ToString("N");
            return "hc=" + UserConfigurationManager.DocumentRevision(id, HiddenContentFile)
                + ";sg=" + UserConfigurationManager.DocumentRevision(id, SpoilerBlurImageFilter.SpoilerBlurFileName);
        }
    }

    /// <summary>
    /// Puts <see cref="AccessRevision.Header"/> on every answer of JE's own API (<c>/JellyfinEnhanced/…</c>) to a signed-in
    /// person, taken before the action runs (a resource filter: before model binding, before any read of the action).
    /// </summary>
    public sealed class AccessRevisionFilter : IAsyncResourceFilter
    {
        private readonly IUserManager _users;

        /// <summary>Creates the filter (DI).</summary>
        /// <param name="users">Jellyfin's users.</param>
        public AccessRevisionFilter(IUserManager users)
        {
            _users = users;
        }

        /// <inheritdoc />
        public async Task OnResourceExecutionAsync(ResourceExecutingContext context, ResourceExecutionDelegate next)
        {
            var http = context.HttpContext;
            if (http.Request.Path.StartsWithSegments("/JellyfinEnhanced", StringComparison.OrdinalIgnoreCase)
                && UserHelper.GetCurrentUserId(http.User) is Guid user)
            {
                try
                {
                    if (AccessRevision.For(_users, user) is { } revision) http.Response.Headers[AccessRevision.Header] = revision;
                }
                catch (Exception ex) when (ex is InvalidOperationException or System.Data.Common.DbException)
                {
                    // No revision on this answer (the next one carries it); the request itself goes on.
                }
            }

            await next().ConfigureAwait(false);
        }
    }
}
