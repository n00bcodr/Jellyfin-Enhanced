using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Security.Cryptography;
using Jellyfin.Data.Enums;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Playlists;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// What a library tile was composed from. On both Jellyfin versions the host composes every playlist and collection
    /// library tile (and every other dynamic folder image) through its one <see cref="IImageProcessor"/>
    /// (<c>CreateImageCollage</c>, called by <c>BaseDynamicImageProvider</c> with the image paths of the lists it picked).
    /// JE wraps that processor. While there is anything to withhold, a composition that reads a list's image is given
    /// copies JE made and judged first (the host reads exactly the bytes JE judged, whatever happens to the originals
    /// meanwhile), and the composed file's content is recorded with each source's hash and verdict in
    /// <see cref="LegacyCollageTiles"/>: clean when every source is proven clean, contaminated when one is a collage (or a
    /// tile built from one), unresolved otherwise. Everything else the host asks of its processor passes straight through.
    /// No image or marker is ever written or deleted; the copies are JE's own and go when the composition is done.
    /// </summary>
    public class LegacyCollageCompositions : DispatchProxy
    {
        /// <summary>How many sources are copied before the host reads them (it reads the first few it can decode); later
        /// ones are read where they are and count as clean only when their content is proven clean before and after.</summary>
        internal const int CopiedSources = 16;

        private IImageProcessor _inner = null!;
        private Func<LegacyCollageWithhold> _withhold = null!;
        private Func<string> _temp = null!;

        /// <summary>Wraps the host's <see cref="IImageProcessor"/> registration (the host registers its services before the
        /// plugins'). The processor JE wraps is still built and disposed by the host's container. Returns false when there is
        /// none to wrap.</summary>
        /// <param name="services">The service collection the host and the plugins register into.</param>
        /// <returns>Whether the processor was wrapped.</returns>
        public static bool Decorate(IServiceCollection services)
        {
            var index = -1;
            for (var i = 0; i < services.Count; i++)
            {
                if (services[i].ServiceType == typeof(IImageProcessor) && !services[i].IsKeyedService)
                {
                    index = i;
                }
            }

            if (index < 0)
            {
                return false;
            }

            var inner = services[index];
            Func<IServiceProvider, IImageProcessor> create;
            if (inner.ImplementationInstance is IImageProcessor instance)
            {
                create = _ => instance;
            }
            else
            {
                // The host's own processor, built (and disposed) by its container as before, behind a holder of JE's.
                Func<IServiceProvider, object> build = inner.ImplementationFactory ?? (provider => ActivatorUtilities.CreateInstance(provider, inner.ImplementationType!));
                services.Add(ServiceDescriptor.Describe(typeof(Host), provider => new Host((IImageProcessor)build(provider)), inner.Lifetime));
                create = provider => provider.GetRequiredService<Host>().Processor;
            }

            // The library (which JE's owner reads) is built with the image processor, so both are resolved on first use.
            services[index] = ServiceDescriptor.Describe(
                typeof(IImageProcessor),
                provider => Wrap(create(provider), () => provider.GetRequiredService<LegacyCollageWithhold>(), () => provider.GetRequiredService<IApplicationPaths>().TempDirectory),
                inner.Lifetime);
            return true;
        }

        /// <summary>The host's processor, owned by the host's container (disposed with it).</summary>
        internal sealed class Host : IDisposable, IAsyncDisposable
        {
            public Host(IImageProcessor processor)
            {
                Processor = processor;
            }

            public IImageProcessor Processor { get; }

            public void Dispose() => (Processor as IDisposable)?.Dispose();

            public ValueTask DisposeAsync()
            {
                if (Processor is IAsyncDisposable asynchronous)
                {
                    return asynchronous.DisposeAsync();
                }

                Dispose();
                return ValueTask.CompletedTask;
            }
        }

        /// <summary>The wrapped processor.</summary>
        /// <param name="inner">The host's processor.</param>
        /// <param name="withhold">The owner of the legacy collage verdicts (resolved on first composition).</param>
        /// <param name="temp">Where JE's copies of the sources go (a folder of its own is made under it).</param>
        /// <returns>The processor every host service gets.</returns>
        internal static IImageProcessor Wrap(IImageProcessor inner, Func<LegacyCollageWithhold> withhold, Func<string> temp)
        {
            var proxy = Create<IImageProcessor, LegacyCollageCompositions>();
            var self = (LegacyCollageCompositions)(object)proxy;
            self._inner = inner;
            self._withhold = withhold;
            self._temp = temp;
            return proxy;
        }

        /// <inheritdoc />
        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            if (targetMethod == null)
            {
                return null;
            }

            if (targetMethod.Name == nameof(IImageProcessor.CreateImageCollage) && args is [ImageCollageOptions options, var name])
            {
                Compose(options, name as string);
                return null;
            }

            try
            {
                return targetMethod.Invoke(_inner, args);
            }
            catch (TargetInvocationException ex) when (ex.InnerException != null)
            {
                ExceptionDispatchInfo.Capture(ex.InnerException).Throw();
                throw;
            }
        }

        private void Compose(ImageCollageOptions options, string? name)
        {
            var inputs = options.InputPaths ?? Array.Empty<string>();
            LegacyCollageWithhold withhold;
            Dictionary<string, Guid>? lists;
            (HashSet<string> Hashes, HashSet<Guid> Unreadable)? collages;
            try
            {
                withhold = _withhold();
                var view = withhold.Begin();
                lists = view.Idle || inputs.Count == 0 ? null : ListImages(withhold);
                // Null when the markers can't be listed: every source is then unresolved.
                collages = lists != null && inputs.Any(lists.ContainsKey) ? view.Collages() : null;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // JE couldn't look: the host composes as it would without JE, and nothing proves the result clean.
                _inner.CreateImageCollage(options, name);
                return;
            }

            if (lists == null || !inputs.Any(lists.ContainsKey))
            {
                // Nothing to withhold, or not composed from list images (no library tile of a kind JE judges).
                _inner.CreateImageCollage(options, name);
                return;
            }

            var folder = Path.Combine(_temp(), "jellyfin-enhanced-collage-sources", Guid.NewGuid().ToString("N"));
            var given = new string[inputs.Count];
            var sources = new (string? Sha, LegacyCollageSource Verdict)[inputs.Count];
            try
            {
                Directory.CreateDirectory(folder);
                for (var i = 0; i < inputs.Count; i++)
                {
                    given[i] = inputs[i];
                    if (i < CopiedSources)
                    {
                        // The host reads JE's copy: the bytes JE judged.
                        var copy = Path.Combine(folder, i.ToString(System.Globalization.CultureInfo.InvariantCulture) + Path.GetExtension(inputs[i]));
                        var sha = Copy(inputs[i], copy);
                        if (sha != null)
                        {
                            given[i] = copy;
                        }

                        sources[i] = (sha, Judge(sha, inputs[i], collages, lists, withhold));
                    }
                    else
                    {
                        var sha = Hash(inputs[i]);
                        sources[i] = (sha, Judge(sha, inputs[i], collages, lists, withhold));
                    }
                }

                _inner.CreateImageCollage(new ImageCollageOptions { InputPaths = given, OutputPath = options.OutputPath, Width = options.Width, Height = options.Height }, name);

                // A source read where it is counts only if it is what JE judged, after the host has read it too.
                for (var i = CopiedSources; i < inputs.Count; i++)
                {
                    if (sources[i].Sha is { } before && Hash(inputs[i]) != before)
                    {
                        sources[i] = (before, LegacyCollageSource.Unresolved);
                    }
                }
            }
            finally
            {
                try
                {
                    Directory.Delete(folder, recursive: true);
                }
                catch (Exception ex) when (LegacyCollageWithhold.IsFileError(ex))
                {
                    // JE's own copies; the host's temporary folder is cleaned on its own.
                }
            }

            if (Hash(options.OutputPath) is { } output)
            {
                withhold.Tiles.Composed(output, sources);
            }
        }

        // A source's verdict: a collage some marker recorded (or a tile built from one) is contaminated; one that can't be
        // read, the image of a list whose marker can't be read, or any source while the markers can't be listed is
        // unresolved; anything else is clean.
        private static LegacyCollageSource Judge(string? sha, string path, (HashSet<string> Hashes, HashSet<Guid> Unreadable)? collages, Dictionary<string, Guid> lists, LegacyCollageWithhold withhold)
        {
            if (sha == null || collages is not { } known)
            {
                return LegacyCollageSource.Unresolved;
            }

            if (known.Hashes.Contains(sha) || withhold.Tiles.Contaminated(sha))
            {
                return LegacyCollageSource.Contaminated;
            }

            return lists.TryGetValue(path, out var list) && known.Unreadable.Contains(list) ? LegacyCollageSource.Unresolved : LegacyCollageSource.Clean;
        }

        // Every local image of every playlist and collection (the sources of their library tiles), by path; null when the
        // library can't say (then the composition is the host's alone, and proves nothing clean).
        private static Dictionary<string, Guid>? ListImages(LegacyCollageWithhold withhold)
        {
            var lists = new Dictionary<string, Guid>(StringComparer.Ordinal);
            void Add(BaseItem item)
            {
                foreach (var image in item.ImageInfos ?? Array.Empty<ItemImageInfo>())
                {
                    if (image.IsLocalFile && !string.IsNullOrEmpty(image.Path))
                    {
                        lists.TryAdd(image.Path, item.Id);
                    }
                }
            }

            IReadOnlyList<BaseItem>? all;
            try
            {
                all = withhold.Library.GetItemList(new InternalItemsQuery { IncludeItemTypes = new[] { BaseItemKind.Playlist, BaseItemKind.BoxSet }, Recursive = true });
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // Can't tell which compositions are library tiles: none is recorded, so none is proven clean.
                return null;
            }

            foreach (var item in all ?? Array.Empty<BaseItem>())
            {
                if (item is Playlist or BoxSet)
                {
                    Add(item);
                }
            }

            foreach (var id in withhold.Listing()?.Keys ?? Enumerable.Empty<Guid>())
            {
                if (withhold.Library.GetItemById(id) is { } marked and (Playlist or BoxSet))
                {
                    Add(marked);
                }
            }

            return lists;
        }

        private static string? Copy(string source, string copy)
        {
            try
            {
                using var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var output = new FileStream(copy, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                var buffer = new byte[81920];
                int read;
                while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    sha.AppendData(buffer, 0, read);
                    output.Write(buffer, 0, read);
                }

                return Convert.ToHexString(sha.GetHashAndReset()).ToLowerInvariant();
            }
            catch (Exception ex) when (LegacyCollageWithhold.IsFileError(ex))
            {
                return null;
            }
        }

        private static string? Hash(string path)
        {
            try
            {
                return LegacyCollageWithhold.HashFile(path);
            }
            catch (Exception ex) when (LegacyCollageWithhold.IsFileError(ex))
            {
                return null;
            }
        }
    }
}
