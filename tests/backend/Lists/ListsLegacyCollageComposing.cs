using System.Security.Cryptography;
using Jellyfin.Plugin.JellyfinEnhanced;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace JE.Tests;

/// <summary>
/// Library tiles composed the way the host's dynamic image providers compose them (both releases'
/// <c>BaseDynamicImageProvider.CreateCollage</c>: the picked items' image paths go to the image processor's
/// <c>CreateImageCollage</c>, then <c>ProviderManager.SaveImage</c> makes the composed file the holder's image), through
/// whatever image processor the plugin's registration leaves in the host's container.
/// </summary>
internal static class LegacyCollageComposing
{
    /// <summary>The host's image processor as far as compositions go: the composed file is a function of the bytes it read
    /// (the same sources give the same bytes, as the host's encoder does).</summary>
    /// <param name="reading">Runs after the sources were read and before the composed file is written.</param>
    /// <returns>The processor.</returns>
    public static Mock<IImageProcessor> Processor(Action<ImageCollageOptions>? reading = null)
    {
        var processor = new Mock<IImageProcessor>();
        processor.SetupGet(p => p.SupportsImageCollageCreation).Returns(true);
        processor.Setup(p => p.CreateImageCollage(It.IsAny<ImageCollageOptions>(), It.IsAny<string?>())).Callback<ImageCollageOptions, string?>((options, _) =>
        {
            var read = options.InputPaths.Select(File.ReadAllBytes).ToList();
            reading?.Invoke(options);
            File.WriteAllBytes(options.OutputPath, Composed(read));
        });
        return processor;
    }

    /// <summary>What the processor above composes from these sources.</summary>
    public static byte[] Composed(IEnumerable<byte[]> sources)
        => "composed:"u8.ToArray().Concat(SHA256.HashData(sources.SelectMany(SHA256.HashData).ToArray())).ToArray();

    /// <summary>Composes the holder's image of that type from the items' Primary images and saves it as the host does.</summary>
    public static void Compose(IImageProcessor processor, BaseItem holder, ImageType type, IEnumerable<BaseItem> from, DateTime written, string temp)
    {
        Directory.CreateDirectory(temp);
        var output = Path.Combine(temp, Guid.NewGuid().ToString("N") + ".png");
        var options = new ImageCollageOptions
        {
            InputPaths = from.Select(i => i.ImageInfos.First(x => x.Type == ImageType.Primary).Path).ToArray(),
            OutputPath = output,
            Width = 960,
            Height = 540,
        };
        Assert.True(processor.SupportsImageCollageCreation);
        processor.CreateImageCollage(options, holder.Name);
        var image = holder.ImageInfos.First(i => i.Type == type);
        File.Copy(output, image.Path, overwrite: true);
        File.SetLastWriteTimeUtc(image.Path, written);
        image.DateModified = written;
        File.Delete(output);
    }

    /// <summary>The library's lists (what the composition record looks list images up in), for a mocked library.</summary>
    public static void Lists(Mock<ILibraryManager> library, IDictionary<Guid, BaseItem> items)
        => library.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Returns(() => items.Values.Where(i => i is Playlist or BoxSet).ToList());

    /// <summary>The plugin's registrations over a host with this image processor and library, as the host makes them: the
    /// image processor every host service gets, and the plugin's owner of the legacy collage verdicts.</summary>
    /// <param name="pluginsPath">The host's plugins folder (JE's markers live under its configurations).</param>
    /// <param name="temp">The host's temporary folder.</param>
    /// <param name="library">The host's library.</param>
    /// <param name="hostProcessor">The host's image processor.</param>
    /// <returns>The processor, the owner, and the container (dispose it).</returns>
    public static (IImageProcessor Processor, LegacyCollageWithhold Withhold, ServiceProvider Provider) Registered(string pluginsPath, string temp, ILibraryManager library, IImageProcessor hostProcessor)
    {
        var services = new ServiceCollection();
        var paths = new Mock<IApplicationPaths>();
        paths.SetupGet(p => p.PluginsPath).Returns(pluginsPath);
        paths.SetupGet(p => p.TempDirectory).Returns(temp);
        paths.SetupGet(p => p.LogDirectoryPath).Returns(temp);
        services.AddSingleton(paths.Object);
        services.AddSingleton(library);
        services.AddSingleton(new Logger(paths.Object, NullLoggerFactory.Instance));
        services.AddSingleton(hostProcessor);
        LegacyCollageWithholdFilter.Register(services);
        var provider = services.BuildServiceProvider();
        return (provider.GetRequiredService<IImageProcessor>(), provider.GetRequiredService<LegacyCollageWithhold>(), provider);
    }

    /// <summary>The plugin's marker folders under a host plugins folder.</summary>
    public static IReadOnlyList<string> MarkerDirectories(string pluginsPath)
        => LegacyCollageWithhold.MarkerDirectories(Path.Combine(pluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced"));
}
