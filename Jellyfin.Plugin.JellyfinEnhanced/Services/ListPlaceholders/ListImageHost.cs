using System;
using System.Buffers.Binary;
using System.IO;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Playlists;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders
{
    /// <summary>The primary image of a list as the poster collage sees it.</summary>
    /// <param name="ListExists">False when the id is no longer a playlist or collection.</param>
    /// <param name="Path">The primary image's path (or URL), null when the list has none.</param>
    /// <param name="IsLocalFile">The image is a file on this server.</param>
    /// <param name="IsGenerated">
    /// The image is a file in the list's internal metadata folder: where Jellyfin's own dynamic image providers write
    /// (and overwrite on every refresh) the collage they build from a list's items. Location alone doesn't prove who
    /// made it: Jellyfin's image saver also falls back to this folder when an upload can't be saved next to the list
    /// (ImageSaver.SaveImageToLocation's retry path).
    /// </param>
    public sealed record ListImageState(bool ListExists, string? Path, bool IsLocalFile, bool IsGenerated)
    {
        /// <summary>A list that doesn't exist (any more).</summary>
        public static ListImageState Missing { get; } = new(false, null, false, false);

        /// <summary>True when the list has a primary image.</summary>
        public bool HasImage => !string.IsNullOrEmpty(Path);
    }

    /// <summary>Reads image headers without decoding the image.</summary>
    public static class ListImageHeader
    {
        /// <summary>Bytes needed by <see cref="PngSize"/>: the PNG signature and the IHDR chunk's width and height.</summary>
        public const int PngHeaderLength = 24;

        private static ReadOnlySpan<byte> PngSignature => new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A };

        private static ReadOnlySpan<byte> IhdrType => "IHDR"u8;

        /// <summary>The pixel size in a PNG header, or null when the bytes don't start a PNG.</summary>
        /// <param name="header">The first <see cref="PngHeaderLength"/> bytes of the file.</param>
        /// <returns>Width and height, or null.</returns>
        public static (int Width, int Height)? PngSize(ReadOnlySpan<byte> header)
        {
            if (header.Length < PngHeaderLength || !header[..8].SequenceEqual(PngSignature) || !header[12..16].SequenceEqual(IhdrType))
            {
                return null;
            }

            var width = BinaryPrimitives.ReadInt32BigEndian(header[16..20]);
            var height = BinaryPrimitives.ReadInt32BigEndian(header[20..24]);
            return width > 0 && height > 0 ? (width, height) : null;
        }
    }

    /// <summary>The image operations of the list poster collage, behind a seam so its rules can be tested without Jellyfin.</summary>
    public interface IListImageHost
    {
        /// <summary>The current primary image of a list.</summary>
        /// <param name="listId">Playlist or collection id.</param>
        /// <returns>The state (<see cref="ListImageState.Missing"/> when the list is gone).</returns>
        ListImageState GetPrimaryImage(Guid listId);

        /// <summary>SHA-256 (lowercase hex) of a local image file, or null when it can't be read.</summary>
        /// <param name="path">File path.</param>
        /// <returns>The hash or null.</returns>
        string? HashFile(string path);

        /// <summary>Pixel size of a local PNG file (read from its header), or null when it isn't a readable PNG.</summary>
        /// <param name="path">File path.</param>
        /// <returns>Width and height, or null.</returns>
        (int Width, int Height)? GetPngSize(string path);

        /// <summary>
        /// Saves a JPEG as the list's primary image in the list's internal metadata folder (where Jellyfin keeps the
        /// collages it generates) and persists the item. Jellyfin removes the previous image when it was in that folder too.
        /// Nothing is saved unless the list's primary image is, right before the write, still the one the caller checked.
        /// </summary>
        /// <param name="listId">Playlist or collection id.</param>
        /// <param name="jpeg">The image.</param>
        /// <param name="expectedPath">The primary image the caller checked (null: the list had none).</param>
        /// <param name="expectedSha256">Its content hash (null: don't compare content).</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The saved image's path, or null when the list is gone or its image changed since the check.</returns>
        Task<string?> SetPrimaryImageAsync(Guid listId, byte[] jpeg, string? expectedPath, string? expectedSha256, CancellationToken cancellationToken);

        /// <summary>
        /// Deletes the list's primary image (file and reference), as Jellyfin's DeleteItemImage does, but only while it
        /// is still the image the caller checked.
        /// </summary>
        /// <param name="listId">Playlist or collection id.</param>
        /// <param name="expectedPath">The primary image the caller checked.</param>
        /// <param name="expectedSha256">Its content hash (null: don't compare content).</param>
        /// <returns>True when that image was deleted; false when the list has another image (or none) now.</returns>
        Task<bool> DeletePrimaryImageAsync(Guid listId, string expectedPath, string? expectedSha256);

        /// <summary>Queues a metadata refresh so Jellyfin builds its own image from the list's items.</summary>
        /// <param name="listId">Playlist or collection id.</param>
        void QueueImageRefresh(Guid listId);
    }

    /// <summary>The production <see cref="IListImageHost"/> over Jellyfin's library and provider managers (same calls on 10.11 and 12).</summary>
    public sealed class JellyfinListImageHost : IListImageHost
    {
        private readonly ILibraryManager _libraryManager;
        private readonly IProviderManager _providerManager;
        private readonly IFileSystem _fileSystem;
        private readonly IApplicationPaths _appPaths;

        /// <summary>Creates the host.</summary>
        /// <param name="libraryManager">Library manager.</param>
        /// <param name="providerManager">Provider manager (image saving and refresh queue).</param>
        /// <param name="fileSystem">File system.</param>
        /// <param name="appPaths">Application paths (temporary directory).</param>
        public JellyfinListImageHost(ILibraryManager libraryManager, IProviderManager providerManager, IFileSystem fileSystem, IApplicationPaths appPaths)
        {
            _libraryManager = libraryManager;
            _providerManager = providerManager;
            _fileSystem = fileSystem;
            _appPaths = appPaths;
        }

        /// <inheritdoc />
        public ListImageState GetPrimaryImage(Guid listId)
        {
            var list = GetList(listId);
            if (list == null)
            {
                return ListImageState.Missing;
            }

            var image = list.GetImageInfo(ImageType.Primary, 0);
            if (image == null || string.IsNullOrEmpty(image.Path))
            {
                return new ListImageState(true, null, false, false);
            }

            var generated = image.IsLocalFile && _fileSystem.ContainsSubPath(list.GetInternalMetadataPath(), image.Path);
            return new ListImageState(true, image.Path, image.IsLocalFile, generated);
        }

        /// <inheritdoc />
        public string? HashFile(string path)
        {
            try
            {
                using var stream = File.OpenRead(path);
                return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return null;
            }
        }

        /// <inheritdoc />
        public (int Width, int Height)? GetPngSize(string path)
        {
            try
            {
                using var stream = File.OpenRead(path);
                Span<byte> header = stackalloc byte[ListImageHeader.PngHeaderLength];
                stream.ReadExactly(header);
                return ListImageHeader.PngSize(header);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return null; // includes EndOfStreamException: too short to be a PNG
            }
        }

        /// <inheritdoc />
        public async Task<string?> SetPrimaryImageAsync(Guid listId, byte[] jpeg, string? expectedPath, string? expectedSha256, CancellationToken cancellationToken)
        {
            if (GetList(listId) == null)
            {
                return null;
            }

            // The file-source overload is the only one that can force the internal metadata folder
            // (saveLocallyWithMedia: false), exactly as Jellyfin's dynamic image providers save; it deletes the source.
            Directory.CreateDirectory(_appPaths.TempDirectory);
            var source = Path.Combine(_appPaths.TempDirectory, "je-list-collage-" + Guid.NewGuid().ToString("N") + ".jpg");
            await File.WriteAllBytesAsync(source, jpeg, cancellationToken).ConfigureAwait(false);
            Folder? list;
            try
            {
                // Re-read right before the write (after the awaited temp file): an image someone set meanwhile wins.
                list = GetList(listId);
                if (list == null || !IsStill(list, expectedPath, expectedSha256))
                {
                    return null;
                }

                await _providerManager.SaveImage(list, source, "image/jpeg", ImageType.Primary, null, false, cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                if (File.Exists(source))
                {
                    try { File.Delete(source); }
                    catch (IOException) { /* Jellyfin normally deletes it; a leftover temp file is harmless */ }
                }
            }

            await list.UpdateToRepositoryAsync(ItemUpdateType.ImageUpdate, cancellationToken).ConfigureAwait(false);
            return list.GetImageInfo(ImageType.Primary, 0)?.Path;
        }

        /// <inheritdoc />
        public async Task<bool> DeletePrimaryImageAsync(Guid listId, string expectedPath, string? expectedSha256)
        {
            var list = GetList(listId);
            if (list?.GetImageInfo(ImageType.Primary, 0) == null || !IsStill(list, expectedPath, expectedSha256))
            {
                return false;
            }

            await list.DeleteImageAsync(ImageType.Primary, 0).ConfigureAwait(false);
            return true;
        }

        /// <inheritdoc />
        public void QueueImageRefresh(Guid listId)
        {
            if (GetList(listId) == null)
            {
                return;
            }

            _providerManager.QueueRefresh(
                listId,
                new MetadataRefreshOptions(new DirectoryService(_fileSystem)) { ForceSave = true },
                RefreshPriority.High);
        }

        // The list's primary image is still the one the caller checked (path, and content when a hash is given).
        private bool IsStill(Folder list, string? expectedPath, string? expectedSha256)
        {
            var current = list.GetImageInfo(ImageType.Primary, 0);
            if (string.IsNullOrEmpty(expectedPath))
            {
                return current == null || string.IsNullOrEmpty(current.Path);
            }

            return current != null
                && string.Equals(current.Path, expectedPath, StringComparison.OrdinalIgnoreCase)
                && (expectedSha256 == null || string.Equals(HashFile(current.Path), expectedSha256, StringComparison.OrdinalIgnoreCase));
        }

        private Folder? GetList(Guid listId) => _libraryManager.GetItemById(listId) is Folder folder and (Playlist or BoxSet) ? folder : null;
    }
}
