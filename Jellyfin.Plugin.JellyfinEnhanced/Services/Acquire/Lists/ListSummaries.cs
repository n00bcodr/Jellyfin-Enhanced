using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// Which of the lists on the Playlists page have entries that aren't in the library, for the person looking (phase
    /// 4c3a). Jellyfin gives a playlist with nothing playable in it its "played" check; the page shows such lists as
    /// incomplete instead. Cheap on purpose: no statuses, no metadata, no reconciliation, just each list's entries as
    /// the caller may see them, through the list gate (rights and parental limits read again right before the answer).
    /// A list the caller can't see, or with no entry they can see, is left out: a count never reveals a hidden entry.
    /// </summary>
    public sealed class ListSummaryService
    {
        /// <summary>Most lists one call may ask about (the Playlists page shows 100 per page).</summary>
        public const int MaxIds = 200;

        /// <summary>Time one call may take before the lists not worked out yet are answered as pending.</summary>
        public static readonly TimeSpan DefaultBudget = TimeSpan.FromSeconds(10);

        private const int Concurrency = 4;

        private readonly ListStore _store;
        private readonly ListAccessService _access;
        private readonly IListPagePreferences? _preferences;
        private readonly Logger _logger;

        /// <summary>Creates the service (DI).</summary>
        /// <param name="store">List documents.</param>
        /// <param name="access">Rights and the list gate.</param>
        /// <param name="logger">JE logger.</param>
        /// <param name="preferences">Each person's list page preferences.</param>
        public ListSummaryService(ListStore store, ListAccessService access, Logger logger, IListPagePreferences? preferences = null)
        {
            _store = store;
            _access = access;
            _logger = logger;
            _preferences = preferences;
        }

        /// <summary>Time one call may take (tests shorten it).</summary>
        internal TimeSpan Budget { get; set; } = DefaultBudget;

        private static PluginConfiguration? Config => JellyfinEnhanced.Instance?.Configuration;

        /// <summary>
        /// Whether a person sees the entries drawn on playlist pages and collection pages (the administrator's switches,
        /// then their own preferences: null follows the administrator, false hides).
        /// </summary>
        /// <param name="user">The person.</param>
        /// <param name="config">Configuration.</param>
        /// <returns>(playlists, collections).</returns>
        public (bool Playlists, bool Collections) PagesShown(Guid user, PluginConfiguration? config)
        {
            var (placeholders, playlists, collections) = _preferences?.PagesFor(user) ?? (null, null, null);
            var entries = placeholders != false;
            return (entries && ListFlags.Display(ListFlags.PlaylistUi(config), playlists), entries && ListFlags.Display(ListFlags.CollectionUi(config), collections));
        }

        /// <summary>The lists among <paramref name="listIds"/> that have entries the caller can see, in the order asked.</summary>
        /// <param name="user">The caller (a person, already checked).</param>
        /// <param name="listIds">The lists on screen.</param>
        /// <param name="cancellationToken">Request aborted.</param>
        /// <returns>The summaries.</returns>
        public async Task<ListSummariesDto> SummariesAsync(User user, IReadOnlyList<Guid> listIds, CancellationToken cancellationToken)
        {
            var result = new ListSummariesDto();
            var (playlists, collections) = PagesShown(user.Id, Config);
            if (!playlists && !collections)
            {
                return result;
            }

            var ids = listIds.Where(id => id != Guid.Empty).Distinct().Take(MaxIds).ToList();
            var answers = new Projection?[ids.Count];
            var pending = new bool[ids.Count];
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            budget.CancelAfter(Budget);
            using var gate = new SemaphoreSlim(Concurrency);
            await Task.WhenAll(ids.Select(async (id, index) =>
            {
                try
                {
                    await gate.WaitAsync(budget.Token).ConfigureAwait(false);
                    try
                    {
                        answers[index] = await SummaryAsync(user, id, playlists, collections, budget.Token).ConfigureAwait(false);
                    }
                    finally
                    {
                        gate.Release();
                    }
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    pending[index] = true;
                }
            })).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            // No await below: each completed projection is checked against the access and parental policy NOW,
            // after every other list's asynchronous work. A stale projection is omitted rather than leaked.
            (playlists, collections) = PagesShown(user.Id, Config);
            for (var i = 0; i < ids.Count; i++)
            {
                if (pending[i])
                {
                    result.Pending.Add(ids[i].ToString("N", System.Globalization.CultureInfo.InvariantCulture));
                }
                else if (answers[i] is { } answer
                    && _access.Gate.Current(answer.Grant.Access) is { } current
                    && answer.Grant.Visibility.Matches(_access.ParentalStamp(current.User))
                    && (current.List.Kind == ListKinds.Playlist ? playlists : collections))
                {
                    result.Lists.Add(answer.Summary);
                }
            }

            return result;
        }

        private sealed record Projection(ListSummaryDto Summary, ListGrant Grant);

        // One list: null when the caller can't see it, its kind's page is off for them, or they see none of its entries.
        private async Task<Projection?> SummaryAsync(User user, Guid listId, bool playlists, bool collections, CancellationToken cancellationToken)
        {
            var access = _access.Resolve(listId, user);
            if (access == null || !access.Permissions.CanView || !(access.List.Kind == ListKinds.Playlist ? playlists : collections))
            {
                return null;
            }

            ListDoc? doc;
            try
            {
                doc = _store.Load(access.ListIdN);
            }
            catch (InvalidDataException ex)
            {
                _logger.Debug($"[Lists] Summary of list {access.ListIdN} skipped: {ex.Message}");
                return null;
            }

            if (doc == null || doc.Items.Count == 0)
            {
                return null;
            }

            var items = doc.Items;
            var summary = await _access.Gate.ProjectAsync(access, items, null, grant =>
            {
                var missing = items.Count(grant.Visibility.IsVisible);
                return new Projection(new ListSummaryDto { ListId = grant.Access.ListIdN, ListKind = grant.Access.List.Kind, Missing = missing }, grant);
            }, cancellationToken).ConfigureAwait(false);
            return summary is { Summary.Missing: > 0 } ? summary : null;
        }
    }
}
