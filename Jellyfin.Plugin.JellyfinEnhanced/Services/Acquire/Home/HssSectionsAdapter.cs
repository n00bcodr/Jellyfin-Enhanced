using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Home
{
    /// <summary>
    /// The home rows as Home Screen Sections (HSS) sections. HSS has no package to reference: it publishes a static
    /// <c>Jellyfin.Plugin.HomeScreenSections.PluginInterface.RegisterSection(JObject)</c> that other plugins find by
    /// reflection, and calls back a results method by assembly, class and method name (in process, inside its own
    /// <c>GET HomeScreen/Section/{id}</c> request). With HSS absent nothing here does anything; the rows are added to the
    /// home screen by the browser instead. Registration happens at start-up and again whenever the switch is turned on
    /// (HSS keeps it until Jellyfin restarts; with the switch off the sections answer nothing and HSS hides them).
    /// </summary>
    public sealed class HssSectionsAdapter : IHostedService
    {
        /// <summary>HSS's plugin-interface type.</summary>
        internal const string InterfaceType = "Jellyfin.Plugin.HomeScreenSections.PluginInterface";

        /// <summary>The three sections: id (also the CSS class HSS gives the section), row, title.</summary>
        internal static readonly (string Id, string Row, string Title)[] Sections =
        {
            ("JellyfinEnhancedYourRequests", "requests", "Your requests"),
            ("JellyfinEnhancedComingSoon", "soon", "Coming soon for you"),
            ("JellyfinEnhancedJustArrived", "arrived", "Just arrived for you"),
        };

        private readonly Logger? _logger;
        private readonly Func<Configuration.PluginConfiguration?> _config;
        private readonly Func<Action<JObject>?> _registration;
        private static int _ready;
        private int _registered;

        /// <summary>Creates the adapter (DI).</summary>
        /// <param name="logger">Logger.</param>
        public HssSectionsAdapter(Logger logger)
            : this(logger, () => JellyfinEnhanced.Instance?.Configuration, () => RegisterMethod() is { } method ? payload => method.Invoke(null, new object?[] { payload }) : null)
        {
        }

        internal HssSectionsAdapter(Logger? logger, Func<Configuration.PluginConfiguration?> config, Func<Action<JObject>?> registration)
        {
            _logger = logger;
            _config = config;
            _registration = registration;
        }

        internal bool Registered => Volatile.Read(ref _registered) == 1;

        /// <summary>All three rows successfully registered with HSS; otherwise use native injection.</summary>
        public static bool Present => Volatile.Read(ref _ready) == 1;

        /// <summary>The payloads JE registers (one per row; the results method is <see cref="HssSectionResults.GetResults"/>).</summary>
        /// <returns>The payloads.</returns>
        internal static IReadOnlyList<JObject> Payloads() => Sections.Select(s => new JObject
        {
            ["id"] = s.Id,
            ["displayText"] = s.Title,
            ["limit"] = 1,
            ["additionalData"] = s.Row,
            ["resultsAssembly"] = typeof(HssSectionResults).Assembly.FullName,
            ["resultsClass"] = typeof(HssSectionResults).FullName,
            ["resultsMethod"] = nameof(HssSectionResults.GetResults),
        }).ToList();

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            RegisterIfOn();
            if (JellyfinEnhanced.Instance is { } plugin) plugin.ConfigurationChanged += OnConfigurationChanged;
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public Task StopAsync(CancellationToken cancellationToken)
        {
            if (JellyfinEnhanced.Instance is { } plugin) plugin.ConfigurationChanged -= OnConfigurationChanged;
            Interlocked.Exchange(ref _ready, 0);
            return Task.CompletedTask;
        }

        private void OnConfigurationChanged(object? sender, MediaBrowser.Model.Plugins.BasePluginConfiguration e) => RegisterIfOn();

        /// <summary>Registers the sections once, when the switch is on and HSS is installed.</summary>
        internal void RegisterIfOn()
        {
            if (!HomeFlags.HssSections(_config()) || Volatile.Read(ref _registered) == 1) return;
            var register = _registration();
            if (register == null) return;
            try
            {
                foreach (var payload in Payloads()) register(payload);
                Interlocked.Exchange(ref _registered, 1);
                Interlocked.Exchange(ref _ready, 1);
                _logger?.Info("[Home] Registered the home rows as Home Screen Sections sections (turn them on and place them in that plugin's settings).");
            }
            catch (Exception ex)
            {
                _logger?.Warning("[Home] Home Screen Sections refused the home rows' sections: " + (ex.InnerException ?? ex).Message);
            }
        }

        private static MethodInfo? RegisterMethod()
        {
            try
            {
                var assembly = AssemblyLoadContext.All.SelectMany(c => c.Assemblies)
                    .FirstOrDefault(a => a.GetName().Name == "Jellyfin.Plugin.HomeScreenSections");
                var method = assembly?.GetType(InterfaceType)?.GetMethod("RegisterSection", BindingFlags.Public | BindingFlags.Static, new[] { typeof(JObject) });
                return method;
            }
            catch (Exception)
            {
                return null;
            }
        }
    }

    /// <summary>What HSS passes a section's results method (its <c>HomeScreenSectionPayload</c>, converted by name).</summary>
    public sealed class HssSectionPayload
    {
        /// <summary>The user HSS asks for (taken from its query string: checked against the signed-in caller).</summary>
        public Guid UserId { get; set; }

        /// <summary>The row (<c>requests</c>, <c>soon</c>, <c>arrived</c>).</summary>
        public string? AdditionalData { get; set; }
    }

    /// <summary>
    /// A section's cards for HSS: the caller's own home row, as Jellyfin items they can open and, for titles not in the
    /// library, the native page of the title (an id and a poster grant the native pages serve; Jellyfin 12 only). HSS
    /// takes the user from its query string without checking it, so the answer is empty unless that user is the
    /// signed-in person making the request. HSS creates this class per call with the server's services.
    /// </summary>
    public sealed class HssSectionResults
    {
        private readonly IServiceProvider _services;

        /// <summary>Created by HSS (ActivatorUtilities with the server's service provider).</summary>
        /// <param name="services">The server's services.</param>
        public HssSectionResults(IServiceProvider services) { _services = services; }

        /// <summary>The section's cards (empty when the switch is off, the caller isn't the user asked for, or the row is off for them).</summary>
        /// <param name="payload">HSS's payload.</param>
        /// <returns>The cards.</returns>
        public QueryResult<BaseItemDto> GetResults(HssSectionPayload payload)
        {
            try
            {
                return GetResultsAsync(payload, CancellationToken.None).GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                _services.GetService<Logger>()?.Warning("[Home] A Home Screen Sections row failed: " + ex.Message);
                return Empty();
            }
        }

        private async Task<QueryResult<BaseItemDto>> GetResultsAsync(HssSectionPayload payload, CancellationToken ct)
        {
            var config = JellyfinEnhanced.Instance?.Configuration;
            if (!HomeFlags.HssSections(config)) return Empty();
            var row = HssSectionsAdapter.Sections.FirstOrDefault(s => s.Row == payload.AdditionalData).Row;
            if (row == null) return Empty();
            var home = _services.GetRequiredService<HomeProjection>();
            var principal = _services.GetService<IHttpContextAccessor>()?.HttpContext?.User;
            if (principal == null || ArrCaller.Human(principal, home.Status.View) is not { } viewer || viewer.UserId != payload.UserId) return Empty();
            var body = await home.ForViewerAsync(viewer, hss: true, ct).ConfigureAwait(false);
            if (body == null || HomeProjection.Read(body) is not { } answer) return Empty();
            var cards = row switch
            {
                "requests" => answer.Requests,
                "soon" => answer.Soon,
                _ => answer.Arrived,
            };
            if (cards == null || cards.Count == 0) return Empty();
            var dtos = Dtos(cards, viewer.UserId);
            return new QueryResult<BaseItemDto>(0, dtos.Count, dtos);
        }

        private List<BaseItemDto> Dtos(IReadOnlyList<HomeCard> cards, Guid userId)
        {
            var users = _services.GetRequiredService<IUserManager>();
            var library = _services.GetRequiredService<ILibraryManager>();
            var dto = _services.GetRequiredService<IDtoService>();
            var user = users.GetUserById(userId);
            var result = new List<BaseItemDto>();
            if (user == null) return result;
            var options = new DtoOptions(true);
            foreach (var card in cards)
            {
                if (card.ItemId != null && Guid.TryParse(card.ItemId, out var itemId))
                {
                    // Only an item the person can open (the projection already chose one; checked again here).
                    if (library.GetItemById<MediaBrowser.Controller.Entities.BaseItem>(itemId, user) is { } item) result.Add(dto.GetBaseItemDto(item, options, user));
                    continue;
                }
                if (Absent(card, userId) is { } absent) result.Add(absent);
            }
            return result;
        }

        /// <summary>A card for a title not in the library: its native page (id, name, year, poster grant), or null without one.</summary>
        private BaseItemDto? Absent(HomeCard card, Guid userId)
        {
#if JF12
            if (_services.GetRequiredService<IUserManager>().GetUserById(userId) is not { } user) return null;
            if (card.HssId == null || !Guid.TryParse(card.HssId, out var id) || !HomeFlags.NativePages(JellyfinEnhanced.Instance?.Configuration)) return null;
            var host = _services.GetRequiredService<IServerApplicationHost>();
            if (!NativeDetails.SyntheticId.TryParse(id, host.SystemId, out var synthetic) || !synthetic.IsTitle) return null;
            var artwork = _services.GetRequiredService<NativeDetails.NativeDetailsArtwork>();
            var policy = _services.GetRequiredService<NativeDetails.NativeDetailsPolicy>();
            var movie = card.Kind == "movie";
            var dto = new BaseItemDto
            {
                Id = id,
                ServerId = host.SystemId,
                Name = string.IsNullOrWhiteSpace(card.Title) ? null : card.Title,
                Type = movie ? BaseItemKind.Movie : BaseItemKind.Series,
                IsFolder = !movie,
                MediaType = movie ? MediaType.Video : MediaType.Unknown,
                LocationType = LocationType.Virtual,
                ProductionYear = card.Year,
                ImageTags = new Dictionary<ImageType, string>(),
                BackdropImageTags = Array.Empty<string>(),
                PrimaryImageAspectRatio = 2.0 / 3.0,
                ProviderIds = card.TmdbId is int tmdb ? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Tmdb"] = tmdb.ToString(CultureInfo.InvariantCulture) } : null,
            };
            if (artwork.Mint(id, ImageType.Primary, 0, card.Poster, user.Id, policy.Revision(user)) is { } poster) dto.ImageTags[ImageType.Primary] = poster;
            return dto;
#else
            return null;
#endif
        }

        private static QueryResult<BaseItemDto> Empty() => new(0, 0, Array.Empty<BaseItemDto>());
    }
}
