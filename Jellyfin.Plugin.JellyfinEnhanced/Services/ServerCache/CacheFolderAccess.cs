using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache
{
    /// <summary>
    /// The server-side cache's only way to open, create, rename and delete its files, confined to one validated
    /// folder (its real path). Every operation starts again from that folder and goes down
    /// <c>&lt;namespace&gt;/&lt;shard&gt;/&lt;name&gt;</c> without following a symbolic link at any step, so a link put
    /// anywhere in the tree, or the folder itself replaced by one, makes the operation fail instead of reaching
    /// outside. On Linux this is anchored: each step opens the next directory from the previous one's handle with
    /// <c>O_NOFOLLOW</c> (<c>openat</c>, <c>mkdirat</c>, <c>renameat</c>, <c>unlinkat</c>), and the folder's handle is
    /// checked to be the validated folder (<c>/proc/self/fd</c>), so nothing can be swapped between a check and its
    /// use. Elsewhere each step is checked for links and the folder for its real path right before a path-based
    /// call (a narrow check-then-use window remains there).
    /// </summary>
    internal abstract class CacheFolderAccess
    {
        protected CacheFolderAccess(string root)
        {
            Root = root;
        }

        /// <summary>The validated folder (its real path).</summary>
        internal string Root { get; }

        /// <summary>Whether the anchored (Linux) implementation is used.</summary>
        internal abstract bool Anchored { get; }

        /// <summary>The access for <paramref name="root"/>: anchored where the platform allows, else checked paths.</summary>
        /// <param name="root">The validated folder's real path.</param>
        /// <param name="anchored">False forces checked paths (tests).</param>
        /// <returns>The access.</returns>
        internal static CacheFolderAccess For(string root, bool anchored = true)
            => anchored && LinuxFolderAccess.Supported ? new LinuxFolderAccess(root) : new PathFolderAccess(root);

        /// <summary>True when the folder is still the validated directory (not replaced by a link or moved).</summary>
        internal abstract bool Intact();

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

    /// <summary>Checked path operations (platforms without the anchored calls).</summary>
    internal sealed class PathFolderAccess : CacheFolderAccess
    {
        internal PathFolderAccess(string root)
            : base(root)
        {
        }

        internal override bool Anchored => false;

        internal override bool Intact()
        {
            try
            {
                var info = new DirectoryInfo(Root);
                return info.Exists && info.LinkTarget == null && string.Equals(RealPath(Root), Root, StringComparison.Ordinal);
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>The directory <paramref name="ns"/>/<paramref name="shard"/> when every step is a real directory; else null.</summary>
        private string? Directory(string ns, string? shard, bool create)
        {
            if (!Intact()) return null;
            var current = Root;
            foreach (var part in shard == null ? new[] { ns } : new[] { ns, shard })
            {
                current = Path.Combine(current, part);
                var info = new DirectoryInfo(current);
                if (info.LinkTarget != null) return null;
                if (!info.Exists)
                {
                    if (!create || File.Exists(current)) return null;
                    System.IO.Directory.CreateDirectory(current);
                    if (new DirectoryInfo(current).LinkTarget != null) return null;
                }
            }

            return current;
        }

        internal override SafeFileHandle? OpenRead(string ns, string shard, string name)
        {
            try
            {
                if (Directory(ns, shard, false) is not { } dir) return null;
                var path = Path.Combine(dir, name);
                var info = new FileInfo(path);
                if (!info.Exists || info.LinkTarget != null) return null;
                return File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            }
            catch (Exception)
            {
                return null;
            }
        }

        internal override SafeFileHandle? CreateNew(string ns, string shard, string name)
        {
            try
            {
                if (Directory(ns, shard, true) is not { } dir) return null;
                return File.OpenHandle(Path.Combine(dir, name), FileMode.CreateNew, FileAccess.Write, FileShare.None);
            }
            catch (Exception)
            {
                return null;
            }
        }

        internal override bool Rename(string ns, string shard, string from, string to)
        {
            try
            {
                if (Directory(ns, shard, false) is not { } dir || new FileInfo(Path.Combine(dir, from)).LinkTarget != null) return false;
                File.Move(Path.Combine(dir, from), Path.Combine(dir, to), overwrite: true);
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        internal override bool Delete(string ns, string shard, string name)
        {
            try
            {
                if (Directory(ns, shard, false) is not { } dir) return false;
                var path = Path.Combine(dir, name);
                var info = new FileInfo(path);
                if (!info.Exists || info.LinkTarget != null) return false;
                File.Delete(path);
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        internal override void RemoveEmpty(string ns, string? shard)
        {
            try
            {
                if (Directory(ns, shard, false) is { } dir && !System.IO.Directory.EnumerateFileSystemEntries(dir).GetEnumerator().MoveNext())
                    System.IO.Directory.Delete(dir);
            }
            catch (Exception)
            {
                // Something else is in there; it stays.
            }
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
        internal static bool Supported => Lib != null && Directory.Exists("/proc/self/fd");

        internal override bool Anchored => true;

        internal override bool Intact()
        {
            var fd = OpenRoot();
            if (fd < 0) return false;
            Lib!.Close(fd);
            return true;
        }

        /// <summary>The folder's handle, checked to be the validated folder itself; -1 otherwise.</summary>
        private int OpenRoot()
        {
            var fd = Lib!.Open(Root, ORdOnly | ODirectory | ONoFollow | OCloExec, 0);
            if (fd < 0) return -1;
            string? opened;
            try
            {
                opened = new FileInfo("/proc/self/fd/" + fd.ToString(System.Globalization.CultureInfo.InvariantCulture)).LinkTarget;
            }
            catch (Exception)
            {
                opened = null;
            }

            if (opened != null && string.Equals(Trim(opened), Root, StringComparison.Ordinal)) return fd;
            Lib.Close(fd);
            return -1;
        }

        /// <summary>Opens <paramref name="name"/> as a directory under <paramref name="parent"/> without following a link, creating it when asked.</summary>
        private static int OpenDir(int parent, string name, bool create)
        {
            var fd = Lib!.OpenAt(parent, name, ORdOnly | ODirectory | ONoFollow | OCloExec, 0);
            if (fd >= 0 || !create || Marshal.GetLastPInvokeError() != ENOENT) return fd;
            if (Lib.MkdirAt(parent, name, Convert.ToInt32("755", 8)) != 0 && Marshal.GetLastPInvokeError() != EEXIST) return -1;
            return Lib.OpenAt(parent, name, ORdOnly | ODirectory | ONoFollow | OCloExec, 0);
        }

        /// <summary>Runs <paramref name="use"/> with the shard (or, with no shard, the namespace) folder's handle.</summary>
        private T WithDir<T>(string ns, string? shard, bool create, T failed, Func<int, T> use)
        {
            var root = OpenRoot();
            if (root < 0) return failed;
            var nsFd = -1;
            var shardFd = -1;
            try
            {
                nsFd = OpenDir(root, ns, create);
                if (nsFd < 0) return failed;
                if (shard == null) return use(nsFd);
                shardFd = OpenDir(nsFd, shard, create);
                return shardFd < 0 ? failed : use(shardFd);
            }
            finally
            {
                if (shardFd >= 0) Lib!.Close(shardFd);
                if (nsFd >= 0) Lib!.Close(nsFd);
                Lib!.Close(root);
            }
        }

        internal override SafeFileHandle? OpenRead(string ns, string shard, string name)
            => WithDir<SafeFileHandle?>(ns, shard, false, null, dir =>
            {
                // Non-blocking: a FIFO planted under the name can't hang the open; only a regular (seekable) file is kept.
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
            });

        internal override SafeFileHandle? CreateNew(string ns, string shard, string name)
            => WithDir<SafeFileHandle?>(ns, shard, true, null, dir =>
            {
                var fd = Lib!.OpenAt(dir, name, OWrOnly | OCreat | OExcl | ONoFollow | OCloExec, Convert.ToInt32("644", 8));
                return fd < 0 ? null : new SafeFileHandle((IntPtr)fd, ownsHandle: true);
            });

        internal override bool Rename(string ns, string shard, string from, string to)
            => WithDir(ns, shard, false, false, dir => Lib!.RenameAt(dir, from, dir, to) == 0);

        internal override bool Delete(string ns, string shard, string name)
            => WithDir(ns, shard, false, false, dir => Lib!.UnlinkAt(dir, name, 0) == 0);

        internal override void RemoveEmpty(string ns, string? shard)
        {
            if (shard == null)
            {
                var root = OpenRoot();
                if (root < 0) return;
                Lib!.UnlinkAt(root, ns, AtRemoveDir);
                Lib.Close(root);
                return;
            }

            WithDir(ns, null, false, false, dir => Lib!.UnlinkAt(dir, shard, AtRemoveDir) == 0);
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
