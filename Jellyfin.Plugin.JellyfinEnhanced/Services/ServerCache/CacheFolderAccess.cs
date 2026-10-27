using System;
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
    /// checked to be the validated folder (<c>/proc/self/fd</c>), then each step down
    /// (<c>&lt;namespace&gt;/&lt;shard&gt;/&lt;name&gt;</c>, or a file of the folder itself) is opened from the previous
    /// step's handle with <c>O_NOFOLLOW</c> (<c>openat</c>, <c>mkdirat</c>, <c>renameat</c>, <c>unlinkat</c>), and a
    /// listing reads the folder through its open handle. A link anywhere, or the folder replaced by one, makes the
    /// operation fail instead of reaching outside, and nothing can be swapped between a check and its use. This
    /// needs Linux (x64, x86, Arm or Arm64); elsewhere <see cref="For"/> answers null and the cache stays off.
    /// </summary>
    internal abstract class CacheFolderAccess
    {
        protected CacheFolderAccess(string root)
        {
            Root = root;
        }

        /// <summary>The validated folder (its real path).</summary>
        internal string Root { get; }

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

        /// <summary>Runs <paramref name="use"/> with a path that reads the open folder itself (null when it can't be opened).</summary>
        internal abstract T WithRootPath<T>(Func<string?, T> use);

        /// <summary>Opens a regular file for reading; null when missing, a link, not a regular file or outside the folder.</summary>
        internal abstract SafeFileHandle? OpenRead(string ns, string shard, string name);

        /// <summary>Creates a new file for writing (and the namespace and shard folders when missing); null when it can't.</summary>
        internal abstract SafeFileHandle? CreateNew(string ns, string shard, string name);

        /// <summary>Renames <paramref name="from"/> over <paramref name="to"/> in one shard folder.</summary>
        internal abstract bool Rename(string ns, string shard, string from, string to);

        /// <summary>Deletes one file (never through a link; a link itself is not deleted either).</summary>
        internal abstract bool Delete(string ns, string shard, string name);

        /// <summary>Removes an empty shard folder (or, with no shard, an empty namespace folder).</summary>
        internal abstract void RemoveEmpty(string ns, string? shard);

        /// <summary>Opens a file of the folder itself: for reading (a regular file only), or created new for writing.</summary>
        internal abstract SafeFileHandle? OpenRootFile(string name, bool create);

        /// <summary>Deletes a file of the folder itself.</summary>
        internal abstract bool DeleteRootFile(string name);

        /// <summary>A file's length and last write time; null when it can't be opened as above.</summary>
        internal (long Length, DateTime Modified)? Stat(string ns, string shard, string name)
        {
            using var handle = OpenRead(ns, shard, name);
            if (handle == null) return null;
            try
            {
                return (RandomAccess.GetLength(handle), File.GetLastWriteTimeUtc(handle));
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>True when the folder holds nothing at all.</summary>
        internal bool IsEmpty() => WithRootPath(path =>
        {
            if (path == null) return false;
            using var entries = Directory.EnumerateFileSystemEntries(path).GetEnumerator();
            return !entries.MoveNext();
        });

        /// <summary>True when the folder holds the cache's marker: a regular file (not a link) with the marker's text.</summary>
        internal bool HasMarker()
        {
            using var handle = OpenRootFile(ServerCacheLocation.MarkerName, create: false);
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
            using var handle = OpenRootFile(ServerCacheLocation.MarkerName, create: true);
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
            using (var handle = OpenRootFile(name, create: true))
            {
                if (handle == null) return false;
            }

            DeleteRootFile(name);
            return true;
        }

        /// <summary>Sets a regular file of the folder's last write time (the marker), never through a link.</summary>
        internal void TouchRootFile(string name, DateTime when)
        {
            try
            {
                using var handle = OpenRootFile(name, create: false);
                if (handle != null) File.SetLastWriteTimeUtc(handle, when);
            }
            catch (Exception)
            {
                // Only the dedicated-folder check reads it.
            }
        }

        /// <summary>The real path of <paramref name="path"/> (every link resolved); the part that doesn't exist yet is appended as given.</summary>
        internal static string RealPath(string path)
        {
            var full = Path.GetFullPath(path);
            var missing = new System.Collections.Generic.Stack<string>();
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

    /// <summary>Anchored operations through libc on Linux (x64, x86, Arm, Arm64).</summary>
    internal sealed class LinuxFolderAccess : CacheFolderAccess
    {
        private const int ENOENT = 2;
        private const int EEXIST = 17;
        private const int AtRemoveDir = 0x200;
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
            var parts = new System.Collections.Generic.List<string>();
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

        /// <summary>Runs <paramref name="use"/> with the shard (or, with no shard, the namespace) folder's handle.</summary>
        private T WithDir<T>(string ns, string? shard, bool create, T failed, Func<int, T> use)
            => WithRoot(failed, root =>
            {
                var nsFd = OpenDir(root, ns, create);
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
            });

        internal override T WithRootPath<T>(Func<string?, T> use)
        {
            var root = OpenChecked(Root);
            if (root < 0) return use(null);
            try
            {
                // The open handle's /proc path reads exactly this folder, wherever its name points meanwhile.
                return use(FdLink(root));
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

        internal override SafeFileHandle? OpenRead(string ns, string shard, string name)
            => WithDir<SafeFileHandle?>(ns, shard, false, null, dir => OpenFile(dir, name));

        internal override SafeFileHandle? CreateNew(string ns, string shard, string name)
            => WithDir<SafeFileHandle?>(ns, shard, true, null, dir => CreateFile(dir, name));

        internal override bool Rename(string ns, string shard, string from, string to)
            => WithDir(ns, shard, false, false, dir => Lib!.RenameAt(dir, from, dir, to) == 0);

        internal override bool Delete(string ns, string shard, string name)
            => WithDir(ns, shard, false, false, dir => Lib!.UnlinkAt(dir, name, 0) == 0);

        internal override void RemoveEmpty(string ns, string? shard)
        {
            if (shard == null) WithRoot(false, root => Lib!.UnlinkAt(root, ns, AtRemoveDir) == 0);
            else WithDir(ns, null, false, false, dir => Lib!.UnlinkAt(dir, shard, AtRemoveDir) == 0);
        }

        internal override SafeFileHandle? OpenRootFile(string name, bool create)
            => WithRoot<SafeFileHandle?>(null, root => create ? CreateFile(root, name) : OpenFile(root, name));

        internal override bool DeleteRootFile(string name)
            => WithRoot(false, root => Lib!.UnlinkAt(root, name, 0) == 0);

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

            private OpenFn _open = null!;
            private OpenAtFn _openAt = null!;
            private MkdirAtFn _mkdirAt = null!;
            private RenameAtFn _renameAt = null!;
            private UnlinkAtFn _unlinkAt = null!;
            private CloseFn _close = null!;

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
        }
    }
}
