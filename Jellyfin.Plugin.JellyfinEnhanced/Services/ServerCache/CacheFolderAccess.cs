using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache
{
    /// <summary>
    /// The server-side cache's only way to touch its folder, confined to one validated folder (its real path).
    /// Every operation starts again from that folder: the folder is opened without following a link and its handle is
    /// checked to be the validated folder (<c>/proc/self/fd</c>), then everything the operation does goes through
    /// that one handle (a <see cref="CacheFolder"/>): each step down (<c>&lt;namespace&gt;/&lt;shard&gt;/&lt;name&gt;</c>,
    /// or a file of the folder itself) is opened from the previous step's handle with <c>O_NOFOLLOW</c> (<c>openat</c>,
    /// <c>mkdirat</c>, <c>renameat</c>, <c>unlinkat</c>, <c>statx</c>), and a listing reads each folder through its own
    /// open handle. A link anywhere, or the folder replaced by one, makes the operation fail instead of reaching
    /// outside, and nothing can be swapped between a check and its use. Anything that changes the folder (a write,
    /// a removal, a sweep, Clear, the marker's time) first proves through that same handle that it is the cache's
    /// own (its marker, <see cref="Owned"/>), so a folder moved in under the path after it was checked is never
    /// written to or cleaned. This needs Linux (x64, x86, Arm or Arm64); elsewhere <see cref="For"/> answers null and
    /// the cache stays off.
    /// </summary>
    internal abstract class CacheFolderAccess
    {
        private volatile bool _lost;
        private volatile bool _unavailable;

        protected CacheFolderAccess(string root)
        {
            Root = root;
        }

        /// <summary>The validated folder (its real path).</summary>
        internal string Root { get; }

        /// <summary>True once an operation found the folder gone or no longer the cache's (no marker): it is prepared again before the next use.</summary>
        internal bool Lost => _lost;

        /// <summary>
        /// True once a call the confinement needs (<c>statx</c>) was refused as unavailable (not implemented, or not permitted
        /// by a sandbox): what the folder holds can't be measured, so the cache can't be used here (also <see cref="Lost"/>).
        /// </summary>
        internal bool Unavailable => _unavailable;

        /// <summary>Marks the folder to be prepared again before its next use.</summary>
        internal void MarkLost() => _lost = true;

        /// <summary>Records that a needed call is unavailable here (see <see cref="Unavailable"/>).</summary>
        protected void MarkUnavailable()
        {
            _unavailable = true;
            _lost = true;
        }

        /// <summary>True when this platform offers the confined calls.</summary>
        internal static bool Supported => LinuxFolderAccess.Supported;

        /// <summary>The access for <paramref name="root"/>; null where the platform can't confine it.</summary>
        /// <param name="root">The validated folder's real path.</param>
        /// <param name="supported">False acts as a platform without the confined calls (tests).</param>
        /// <returns>The access, or null.</returns>
        internal static CacheFolderAccess? For(string root, bool supported = true)
            => supported && LinuxFolderAccess.Supported ? new LinuxFolderAccess(root) : null;

        /// <summary>True when the folder is still the validated directory (not replaced by a link or moved).</summary>
        internal abstract bool Intact();

        /// <summary>Creates the folder (and the missing folders above it) without following a link; true when it is there.</summary>
        internal abstract bool EnsureRoot();

        /// <summary>
        /// Runs <paramref name="use"/> with the folder held open (checked to be the validated directory) and every
        /// step going through that handle; <paramref name="failed"/> when it can't be opened. Not a proof that it is
        /// the cache's own: see <see cref="Owned"/>.
        /// </summary>
        internal abstract T WithFolder<T>(T failed, Func<CacheFolder, T> use);

        /// <summary>
        /// Runs <paramref name="use"/> with the folder held open and proven the cache's own through that very handle
        /// (its marker read from it), so what <paramref name="use"/> changes is in that folder and no other one
        /// moved in under its path. <paramref name="failed"/> when it can't be opened or isn't the cache's (then
        /// <see cref="Lost"/>).
        /// </summary>
        internal T Owned<T>(T failed, Func<CacheFolder, T> use)
        {
            var owned = false;
            var result = WithFolder(failed, folder =>
            {
                if (!folder.HasMarker()) return failed;
                owned = true;
                return use(folder);
            });
            if (!owned) _lost = true;
            return result;
        }

        /// <summary>Opens a regular file for reading; null when missing, a link, not a regular file or outside the folder. A read changes nothing, so it doesn't prove ownership.</summary>
        internal SafeFileHandle? OpenRead(string ns, string shard, string name)
            => WithFolder<SafeFileHandle?>(null, folder => folder.OpenRead(ns, shard, name));

        /// <summary>Creates a new file for writing (and the namespace and shard folders when missing) in the cache's own folder; null when it can't.</summary>
        internal SafeFileHandle? CreateNew(string ns, string shard, string name)
            => Owned<SafeFileHandle?>(null, folder => folder.CreateNew(ns, shard, name));

        /// <summary>Deletes one file of the cache's own folder (never through a link; a link itself is not deleted either).</summary>
        internal bool Delete(string ns, string shard, string name)
            => Owned(false, folder => folder.Delete(ns, shard, name));

        /// <summary>Removes an empty shard folder (or, with no shard, an empty namespace folder) of the cache's own folder.</summary>
        internal void RemoveEmpty(string ns, string? shard)
            => Owned(false, folder =>
            {
                folder.RemoveEmpty(ns, shard);
                return true;
            });

        /// <summary>The real path of <paramref name="path"/> (every link resolved); the part that doesn't exist yet is appended as given.</summary>
        internal static string RealPath(string path)
        {
            var full = Path.GetFullPath(path);
            var missing = new Stack<string>();
            var existing = full;
            while (!Directory.Exists(existing) && !File.Exists(existing) && new FileInfo(existing).LinkTarget == null)
            {
                var parent = Path.GetDirectoryName(existing);
                if (parent == null) break;
                missing.Push(Path.GetFileName(existing));
                existing = parent;
            }

            var real = Resolve(existing, 0);
            while (missing.Count > 0) real = Path.Combine(real, missing.Pop());
            return Trim(real);
        }

        private static string Resolve(string path, int depth)
        {
            if (depth > 32) throw new IOException("Too many links.");
            var root = Path.GetPathRoot(path) ?? string.Empty;
            var result = root;
            foreach (var part in path.Substring(root.Length).Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries))
            {
                var next = Path.Combine(result, part);
                var target = new FileInfo(next).LinkTarget;
                if (target != null)
                {
                    var parent = Path.GetDirectoryName(next) ?? root;
                    next = Resolve(Path.GetFullPath(Path.IsPathRooted(target) ? target : Path.Combine(parent, target)), depth + 1);
                }

                result = next;
            }

            return result;
        }

        internal static string Trim(string path)
        {
            var root = Path.GetPathRoot(path) ?? string.Empty;
            return path.Length > root.Length ? path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) : path;
        }
    }

    /// <summary>A file of the store's shape a listing found: where it is, its length and last write time.</summary>
    internal readonly record struct CacheFile(string Ns, string Shard, string Name, long Length, DateTime Modified);

    /// <summary>
    /// The cache folder held open for one operation (<see cref="CacheFolderAccess.WithFolder"/>): everything here goes
    /// through that handle, never the folder's path again, and is valid only inside that call.
    /// </summary>
    internal abstract class CacheFolder
    {
        /// <summary>Opens a regular file for reading; null when missing, a link or not a regular file.</summary>
        internal abstract SafeFileHandle? OpenRead(string ns, string shard, string name);

        /// <summary>Creates a new file for writing (and the namespace and shard folders when missing); null when it can't.</summary>
        internal abstract SafeFileHandle? CreateNew(string ns, string shard, string name);

        /// <summary>Renames <paramref name="from"/> over <paramref name="to"/> in one shard folder.</summary>
        internal abstract bool Rename(string ns, string shard, string from, string to);

        /// <summary>Deletes one file (never through a link; a link itself is not deleted either).</summary>
        internal abstract bool Delete(string ns, string shard, string name);

        /// <summary>Removes an empty shard folder (or, with no shard, an empty namespace folder).</summary>
        internal abstract void RemoveEmpty(string ns, string? shard);

        /// <summary>
        /// A regular file's length and last write time, read without opening it or following a link: true with
        /// <paramref name="found"/> null when there is none (missing, a link or another type), false when it couldn't be
        /// established (the call failed): never mistake that for "not there".
        /// </summary>
        internal abstract bool TryStat(string ns, string shard, string name, out (long Length, DateTime Modified)? found);

        /// <summary>True when the folder's own files can be measured (the marker, through this handle).</summary>
        internal abstract bool CanMeasure();

        /// <summary>
        /// Adds every file of the store's shape (names the filters accept, regular files only, links never followed)
        /// to <paramref name="into"/>, each namespace and shard folder listed through its own handle. False when a
        /// folder or file couldn't be read: the listing is then incomplete (what could be read is still added).
        /// </summary>
        internal abstract bool List(Func<string, bool> isNamespace, Func<string, bool> isShard, Func<string, bool> isFile, List<CacheFile> into);

        /// <summary>True when the folder holds nothing at all; null when it can't be read.</summary>
        internal abstract bool? IsEmpty();

        /// <summary>Opens a file of the folder itself: for reading (a regular file only), or created new for writing.</summary>
        internal abstract SafeFileHandle? OpenOwnFile(string name, bool create);

        /// <summary>Deletes a file of the folder itself.</summary>
        internal abstract bool DeleteOwnFile(string name);

        /// <summary>True when the folder holds the cache's marker: a regular file (not a link) with the marker's text.</summary>
        internal bool HasMarker()
        {
            using var handle = OpenOwnFile(ServerCacheLocation.MarkerName, create: false);
            if (handle == null) return false;
            try
            {
                var expected = Encoding.UTF8.GetBytes(ServerCacheLocation.MarkerText);
                if (RandomAccess.GetLength(handle) != expected.Length) return false;
                var actual = new byte[expected.Length];
                var read = 0;
                while (read < actual.Length)
                {
                    var n = RandomAccess.Read(handle, actual.AsSpan(read), read);
                    if (n <= 0) return false;
                    read += n;
                }

                return actual.AsSpan().SequenceEqual(expected);
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>Writes the cache's marker as a new file of the folder; false when it can't (one already there included).</summary>
        internal bool CreateMarker()
        {
            using var handle = OpenOwnFile(ServerCacheLocation.MarkerName, create: true);
            if (handle == null) return false;
            try
            {
                RandomAccess.Write(handle, Encoding.UTF8.GetBytes(ServerCacheLocation.MarkerText), 0);
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>True when a new file can be written to the folder (written and removed again).</summary>
        internal bool Writable()
        {
            var name = ".je-write-check-" + Guid.NewGuid().ToString("N") + ".tmp";
            using (var handle = OpenOwnFile(name, create: true))
            {
                if (handle == null) return false;
            }

            DeleteOwnFile(name);
            return true;
        }

        /// <summary>Sets the marker's last write time (never through a link): the sweeps keep it fresh.</summary>
        internal void TouchMarker(DateTime when)
        {
            try
            {
                using var handle = OpenOwnFile(ServerCacheLocation.MarkerName, create: false);
                if (handle != null) File.SetLastWriteTimeUtc(handle, when);
            }
            catch (Exception)
            {
                // Only the dedicated-folder check reads it.
            }
        }
    }

    /// <summary>Anchored operations through libc on Linux (x64, x86, Arm, Arm64).</summary>
    internal sealed class LinuxFolderAccess : CacheFolderAccess
    {
        private const int EPERM = 1;
        private const int ENOENT = 2;
        private const int EEXIST = 17;
        private const int ENOSYS = 38;
        private const int ENOTDIR = 20;
        private const int ELOOP = 40;
        private const int AtRemoveDir = 0x200;
        private const int AtSymlinkNoFollow = 0x100;
        // statx: STATX_TYPE | STATX_MODE | STATX_MTIME | STATX_SIZE; the result's layout is the same on every architecture.
        private const uint StatxWanted = 0x1 | 0x2 | 0x40 | 0x200;
        private const int StatxBytes = 256;
        private const int SIfMt = 0xF000, SIfReg = 0x8000;
        private const int ORdOnly = 0, OWrOnly = 1, OCreat = 0x40, OExcl = 0x80, ONonBlock = 0x800, OCloExec = 0x80000;
        private static readonly int ODirectory, ONoFollow;
        private static readonly Native? Lib;

        static LinuxFolderAccess()
        {
            if (!OperatingSystem.IsLinux()) return;
            switch (RuntimeInformation.ProcessArchitecture)
            {
                case Architecture.X64:
                case Architecture.X86:
                    ODirectory = 0x10000;
                    ONoFollow = 0x20000;
                    break;
                case Architecture.Arm:
                case Architecture.Arm64:
                    ODirectory = 0x4000;
                    ONoFollow = 0x8000;
                    break;
                default:
                    return;
            }

            Lib = Native.Load();
        }

        internal LinuxFolderAccess(string root)
            : base(root)
        {
        }

        /// <summary>True when the anchored calls are available here.</summary>
        internal static new bool Supported => Lib != null && Directory.Exists("/proc/self/fd");

        internal override bool Intact()
        {
            var fd = OpenChecked(Root);
            if (fd < 0) return false;
            Lib!.Close(fd);
            return true;
        }

        /// <summary>Opens <paramref name="path"/> as a directory without following a final link, checked to be exactly that directory; -1 otherwise.</summary>
        private static int OpenChecked(string path)
        {
            var fd = Lib!.Open(path, ORdOnly | ODirectory | ONoFollow | OCloExec, 0);
            if (fd < 0) return -1;
            if (string.Equals(FdPath(fd), path, StringComparison.Ordinal)) return fd;
            Lib.Close(fd);
            return -1;
        }

        private static string? FdPath(int fd)
        {
            try
            {
                var target = new FileInfo(FdLink(fd)).LinkTarget;
                return target == null ? null : Trim(target);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static string FdLink(int fd) => "/proc/self/fd/" + fd.ToString(System.Globalization.CultureInfo.InvariantCulture);

        internal override bool EnsureRoot()
        {
            if (Intact()) return true;
            // Down from the nearest folder that exists (each step a real directory, never a link), creating the rest.
            var parts = new List<string>();
            var existing = Root;
            int fd;
            while (true)
            {
                fd = Lib!.Open(existing, ORdOnly | ODirectory | ONoFollow | OCloExec, 0);
                if (fd >= 0) break;
                if (Marshal.GetLastPInvokeError() != ENOENT) return false;
                var parent = Path.GetDirectoryName(existing);
                if (parent == null) return false;
                parts.Insert(0, Path.GetFileName(existing));
                existing = parent;
            }

            if (!string.Equals(FdPath(fd), Trim(existing), StringComparison.Ordinal))
            {
                Lib.Close(fd);
                return false;
            }

            foreach (var part in parts)
            {
                var next = OpenDir(fd, part, create: true);
                Lib.Close(fd);
                if (next < 0) return false;
                fd = next;
            }

            Lib.Close(fd);
            return Intact();
        }

        /// <summary>Opens <paramref name="name"/> as a directory under <paramref name="parent"/> without following a link, creating it when asked.</summary>
        private static int OpenDir(int parent, string name, bool create)
        {
            var fd = Lib!.OpenAt(parent, name, ORdOnly | ODirectory | ONoFollow | OCloExec, 0);
            if (fd >= 0 || !create || Marshal.GetLastPInvokeError() != ENOENT) return fd;
            if (Lib.MkdirAt(parent, name, Convert.ToInt32("755", 8)) != 0 && Marshal.GetLastPInvokeError() != EEXIST) return -1;
            return Lib.OpenAt(parent, name, ORdOnly | ODirectory | ONoFollow | OCloExec, 0);
        }

        /// <summary>Runs <paramref name="use"/> with the folder's own handle.</summary>
        private T WithRoot<T>(T failed, Func<int, T> use)
        {
            var root = OpenChecked(Root);
            if (root < 0) return failed;
            try
            {
                return use(root);
            }
            finally
            {
                Lib!.Close(root);
            }
        }

        internal override T WithFolder<T>(T failed, Func<CacheFolder, T> use)
        {
            var root = OpenChecked(Root);
            if (root < 0) return failed;
            try
            {
                return use(new LinuxFolder(this, root));
            }
            finally
            {
                Lib!.Close(root);
            }
        }

        /// <summary>Opens a regular file under <paramref name="dir"/> for reading, never through a link (non-blocking, so a FIFO can't hang).</summary>
        private static SafeFileHandle? OpenFile(int dir, string name)
        {
            var fd = Lib!.OpenAt(dir, name, ORdOnly | ONoFollow | OCloExec | ONonBlock, 0);
            if (fd < 0) return null;
            var handle = new SafeFileHandle((IntPtr)fd, ownsHandle: true);
            try
            {
                if (File.GetAttributes(handle).HasFlag(FileAttributes.Directory)) throw new IOException();
                _ = RandomAccess.GetLength(handle);
                return handle;
            }
            catch (Exception)
            {
                handle.Dispose();
                return null;
            }
        }

        private static SafeFileHandle? CreateFile(int dir, string name)
        {
            var fd = Lib!.OpenAt(dir, name, OWrOnly | OCreat | OExcl | ONoFollow | OCloExec, Convert.ToInt32("644", 8));
            return fd < 0 ? null : new SafeFileHandle((IntPtr)fd, ownsHandle: true);
        }

        /// <summary>
        /// A file's type, length and last write time under <paramref name="dir"/>, never following a link: 1 a regular file,
        /// 0 none (missing, a link or another type), -1 unreadable. A call refused as unavailable (not implemented, or not
        /// permitted by a sandbox) also marks the access <see cref="CacheFolderAccess.Unavailable"/>.
        /// </summary>
        private int StatAt(int dir, string name, out long length, out DateTime modified)
        {
            length = 0;
            modified = default;
            var buffer = new byte[StatxBytes];
            if (Lib!.Statx(dir, name, AtSymlinkNoFollow, StatxWanted, buffer) != 0)
            {
                var error = Marshal.GetLastPInvokeError();
                if (error is ENOENT or ENOTDIR) return 0;
                if (error is ENOSYS or EPERM) MarkUnavailable();
                return -1;
            }

            if ((BinaryPrimitives.ReadUInt16LittleEndian(buffer.AsSpan(28)) & SIfMt) != SIfReg) return 0;
            length = BinaryPrimitives.ReadInt64LittleEndian(buffer.AsSpan(40));
            var seconds = BinaryPrimitives.ReadInt64LittleEndian(buffer.AsSpan(112));
            var nanoseconds = BinaryPrimitives.ReadUInt32LittleEndian(buffer.AsSpan(120));
            try
            {
                modified = DateTime.UnixEpoch.AddTicks((seconds * TimeSpan.TicksPerSecond) + (nanoseconds / 100));
            }
            catch (ArgumentOutOfRangeException)
            {
                modified = seconds < 0 ? DateTime.UnixEpoch : DateTime.MaxValue;
            }

            return 1;
        }

        /// <summary>The names in an open folder that <paramref name="wanted"/> accepts (read through its handle); <paramref name="complete"/> false when it couldn't be read.</summary>
        private static List<string> Names(int dir, Func<string, bool> wanted, ref bool complete)
        {
            try
            {
                return Directory.EnumerateFileSystemEntries(FdLink(dir)).Select(Path.GetFileName).Where(n => !string.IsNullOrEmpty(n) && wanted(n!)).ToList()!;
            }
            catch (Exception)
            {
                complete = false;
                return new List<string>();
            }
        }

        /// <summary>Opens a listed folder from its parent's handle without following a link; -1 when it is gone, a link or not a folder (skipped), or can't be read (<paramref name="complete"/> false).</summary>
        private static int OpenListed(int parent, string name, ref bool complete)
        {
            var fd = Lib!.OpenAt(parent, name, ORdOnly | ODirectory | ONoFollow | OCloExec, 0);
            if (fd < 0 && Marshal.GetLastPInvokeError() is not (ENOENT or ENOTDIR or ELOOP)) complete = false;
            return fd;
        }

        /// <summary>The folder held open by one operation; every call is relative to its handle.</summary>
        private sealed class LinuxFolder : CacheFolder
        {
            private readonly LinuxFolderAccess _access;
            private readonly int _root;

            internal LinuxFolder(LinuxFolderAccess access, int root)
            {
                _access = access;
                _root = root;
            }

            /// <summary>Runs <paramref name="use"/> with the shard (or, with no shard, the namespace) folder's handle.</summary>
            private T InDir<T>(string ns, string? shard, bool create, T failed, Func<int, T> use)
            {
                var nsFd = OpenDir(_root, ns, create);
                if (nsFd < 0) return failed;
                var shardFd = -1;
                try
                {
                    if (shard == null) return use(nsFd);
                    shardFd = OpenDir(nsFd, shard, create);
                    return shardFd < 0 ? failed : use(shardFd);
                }
                finally
                {
                    if (shardFd >= 0) Lib!.Close(shardFd);
                    Lib!.Close(nsFd);
                }
            }

            internal override SafeFileHandle? OpenRead(string ns, string shard, string name)
                => InDir<SafeFileHandle?>(ns, shard, false, null, dir => OpenFile(dir, name));

            internal override SafeFileHandle? CreateNew(string ns, string shard, string name)
                => InDir<SafeFileHandle?>(ns, shard, true, null, dir => CreateFile(dir, name));

            internal override bool Rename(string ns, string shard, string from, string to)
                => InDir(ns, shard, false, false, dir => Lib!.RenameAt(dir, from, dir, to) == 0);

            internal override bool Delete(string ns, string shard, string name)
                => InDir(ns, shard, false, false, dir => Lib!.UnlinkAt(dir, name, 0) == 0);

            internal override void RemoveEmpty(string ns, string? shard)
            {
                if (shard == null) Lib!.UnlinkAt(_root, ns, AtRemoveDir);
                else InDir(ns, null, false, false, dir => Lib!.UnlinkAt(dir, shard, AtRemoveDir) == 0);
            }

            internal override bool TryStat(string ns, string shard, string name, out (long Length, DateTime Modified)? found)
            {
                found = null;
                // A namespace or shard folder that is gone (or a link) holds no such file; one that can't be opened is unknown.
                static bool Gone() => Marshal.GetLastPInvokeError() is ENOENT or ENOTDIR or ELOOP;
                var nsFd = Lib!.OpenAt(_root, ns, ORdOnly | ODirectory | ONoFollow | OCloExec, 0);
                if (nsFd < 0) return Gone();
                try
                {
                    var shardFd = Lib.OpenAt(nsFd, shard, ORdOnly | ODirectory | ONoFollow | OCloExec, 0);
                    if (shardFd < 0) return Gone();
                    try
                    {
                        switch (_access.StatAt(shardFd, name, out var length, out var modified))
                        {
                            case 1:
                                found = (length, modified);
                                return true;
                            case 0:
                                return true;
                            default:
                                return false;
                        }
                    }
                    finally
                    {
                        Lib.Close(shardFd);
                    }
                }
                finally
                {
                    Lib.Close(nsFd);
                }
            }

            internal override bool CanMeasure() => _access.StatAt(_root, ServerCacheLocation.MarkerName, out _, out _) >= 0;

            internal override bool List(Func<string, bool> isNamespace, Func<string, bool> isShard, Func<string, bool> isFile, List<CacheFile> into)
            {
                var complete = true;
                foreach (var ns in Names(_root, isNamespace, ref complete))
                {
                    var nsFd = OpenListed(_root, ns, ref complete);
                    if (nsFd < 0) continue;
                    try
                    {
                        foreach (var shard in Names(nsFd, isShard, ref complete))
                        {
                            var shardFd = OpenListed(nsFd, shard, ref complete);
                            if (shardFd < 0) continue;
                            try
                            {
                                foreach (var name in Names(shardFd, isFile, ref complete))
                                {
                                    switch (_access.StatAt(shardFd, name, out var length, out var modified))
                                    {
                                        case 1:
                                            into.Add(new CacheFile(ns, shard, name, length, modified));
                                            break;
                                        case -1:
                                            complete = false;
                                            break;
                                    }
                                }
                            }
                            finally
                            {
                                Lib!.Close(shardFd);
                            }
                        }
                    }
                    finally
                    {
                        Lib!.Close(nsFd);
                    }
                }

                return complete;
            }

            internal override bool? IsEmpty()
            {
                try
                {
                    using var entries = Directory.EnumerateFileSystemEntries(FdLink(_root)).GetEnumerator();
                    return !entries.MoveNext();
                }
                catch (Exception)
                {
                    return null;
                }
            }

            internal override SafeFileHandle? OpenOwnFile(string name, bool create)
                => create ? CreateFile(_root, name) : OpenFile(_root, name);

            internal override bool DeleteOwnFile(string name) => Lib!.UnlinkAt(_root, name, 0) == 0;
        }

        /// <summary>The libc entry points, bound once (no import resolver for the plugin's assembly is needed).</summary>
        private sealed class Native
        {
            [UnmanagedFunctionPointer(CallingConvention.Cdecl, SetLastError = true)]
            private delegate int OpenFn([MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags, int mode);

            [UnmanagedFunctionPointer(CallingConvention.Cdecl, SetLastError = true)]
            private delegate int OpenAtFn(int dir, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags, int mode);

            [UnmanagedFunctionPointer(CallingConvention.Cdecl, SetLastError = true)]
            private delegate int MkdirAtFn(int dir, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int mode);

            [UnmanagedFunctionPointer(CallingConvention.Cdecl, SetLastError = true)]
            private delegate int RenameAtFn(int fromDir, [MarshalAs(UnmanagedType.LPUTF8Str)] string from, int toDir, [MarshalAs(UnmanagedType.LPUTF8Str)] string to);

            [UnmanagedFunctionPointer(CallingConvention.Cdecl, SetLastError = true)]
            private delegate int UnlinkAtFn(int dir, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);

            [UnmanagedFunctionPointer(CallingConvention.Cdecl, SetLastError = true)]
            private delegate int CloseFn(int fd);

            [UnmanagedFunctionPointer(CallingConvention.Cdecl, SetLastError = true)]
            private delegate int StatxFn(int dir, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags, uint mask, [Out] byte[] buffer);

            private OpenFn _open = null!;
            private OpenAtFn _openAt = null!;
            private MkdirAtFn _mkdirAt = null!;
            private RenameAtFn _renameAt = null!;
            private UnlinkAtFn _unlinkAt = null!;
            private CloseFn _close = null!;
            private StatxFn _statx = null!;

            internal static Native? Load()
            {
                foreach (var name in new[] { "libc.so.6", "libc.so", "libc" })
                {
                    if (!NativeLibrary.TryLoad(name, out var lib)) continue;
                    try
                    {
                        return new Native
                        {
                            _open = Bind<OpenFn>(lib, "open"),
                            _openAt = Bind<OpenAtFn>(lib, "openat"),
                            _mkdirAt = Bind<MkdirAtFn>(lib, "mkdirat"),
                            _renameAt = Bind<RenameAtFn>(lib, "renameat"),
                            _unlinkAt = Bind<UnlinkAtFn>(lib, "unlinkat"),
                            _close = Bind<CloseFn>(lib, "close"),
                            _statx = Bind<StatxFn>(lib, "statx"),
                        };
                    }
                    catch (Exception)
                    {
                        // Try the next name.
                    }
                }

                return null;
            }

            private static TDelegate Bind<TDelegate>(IntPtr lib, string name)
                where TDelegate : Delegate
                => Marshal.GetDelegateForFunctionPointer<TDelegate>(NativeLibrary.GetExport(lib, name));

            internal int Open(string path, int flags, int mode) => _open(path, flags, mode);

            internal int OpenAt(int dir, string path, int flags, int mode) => _openAt(dir, path, flags, mode);

            internal int MkdirAt(int dir, string path, int mode) => _mkdirAt(dir, path, mode);

            internal int RenameAt(int fromDir, string from, int toDir, string to) => _renameAt(fromDir, from, toDir, to);

            internal int UnlinkAt(int dir, string path, int flags) => _unlinkAt(dir, path, flags);

            internal void Close(int fd) => _close(fd);

            internal int Statx(int dir, string path, int flags, uint mask, byte[] buffer) => _statx(dir, path, flags, mask, buffer);
        }
    }
}
