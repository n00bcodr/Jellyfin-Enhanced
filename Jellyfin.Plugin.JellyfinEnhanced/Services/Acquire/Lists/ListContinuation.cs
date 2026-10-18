using System;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// The one state machine of a list create or swap pass: everything it does after it started runs as this continuation
    /// (nested list work inherits it, metadata and placement included).
    /// <list type="bullet">
    /// <item>One lifecycle lock (<see cref="Lifecycle"/>) is shared by every synchronous step of a continuation, its
    /// writes (list documents, operations, swap-in events), its final answer, deletion's marks and a restore. It is never
    /// held over an await.</item>
    /// <item>After every await (<see cref="Await{T}"/>), and before every write (<see cref="Write{T}"/>), the operation's
    /// durable state and the caller's current access are read again under that lock. A Jellyfin call is started under it
    /// too, so no deletion falls between its check and its start.</item>
    /// <item>Once refused, the continuation stays refused, even if the list id or the access comes back: only a new
    /// request starts a new one.</item>
    /// </list>
    /// </summary>
    internal sealed class ListContinuation : IDisposable
    {
        /// <summary>The lifecycle lock (one per server).</summary>
        internal static readonly object Lifecycle = new();

        private static readonly AsyncLocal<ListContinuation?> Ambient = new();
        private readonly ListContinuation? _previous;
        private readonly ListStore _store;
        private readonly Func<ListOutcome?> _current;
        private readonly long _restore;
        private ListOutcome? _refused;

        /// <summary>Starts a continuation for the calling flow (and everything it awaits).</summary>
        /// <param name="store">The list store (its restore count and test seam).</param>
        /// <param name="current">Reads the durable state and current access: the refusal, or null to go on.</param>
        internal ListContinuation(ListStore store, Func<ListOutcome?> current)
        {
            _store = store;
            _current = current;
            _restore = store.RestoreVersion;
            _previous = Ambient.Value;
            Ambient.Value = this;
        }

        /// <summary>Gets the continuation the calling flow runs as, if any.</summary>
        internal static ListContinuation? Current => Ambient.Value;

        /// <summary>Gets a value indicating whether the continuation was refused.</summary>
        internal bool Refused => _refused != null;

        /// <summary>The identity-free refusal of a list that is gone or not the caller's.</summary>
        /// <returns>404 not_found.</returns>
        internal static ListOutcome NotFound() => ListOutcome.Error(404, "not_found", "List not found.");

        /// <summary>Reads the durable state and current access again; throws (and stays refused) when they stop it.</summary>
        internal void Check()
        {
            lock (Lifecycle)
            {
                _refused ??= _store.RestoreVersion != _restore ? NotFound() : _current();
                if (_refused != null)
                {
                    throw new ListAccessLostException(_refused, "The list operation or its access changed.");
                }
            }
        }

        /// <summary>Checks the calling flow's continuation (if any) before a write, e.g. a Jellyfin write's grant.</summary>
        internal static void Ensure()
        {
            var execution = Ambient.Value;
            if (execution != null)
            {
                execution.Check();
            }
        }

        /// <summary>A write and the check allowing it, together under the lifecycle lock (also without a continuation).</summary>
        /// <typeparam name="T">Result.</typeparam>
        /// <param name="effect">The write (synchronous).</param>
        /// <returns>Its result.</returns>
        internal static T Write<T>(Func<T> effect)
        {
            lock (Lifecycle)
            {
                Ambient.Value?.Check();
                return effect();
            }
        }

        /// <summary>A write and the check allowing it, together under the lifecycle lock.</summary>
        /// <param name="effect">The write (synchronous).</param>
        internal static void Write(Action effect) => Write(() =>
        {
            effect();
            return true;
        });

        /// <summary>
        /// An await of the continuation: started after a check (under the lock), and checked again once it completed,
        /// failed or not. Outside a continuation it is a plain await.
        /// </summary>
        /// <typeparam name="T">Result.</typeparam>
        /// <param name="action">Starts the work.</param>
        /// <param name="member">Caller (the await's site, for the test seam).</param>
        /// <param name="line">Caller line.</param>
        /// <returns>The result. A result that owns something (a lock) is disposed when the check refuses.</returns>
        internal static async Task<T> Await<T>(Func<Task<T>> action, [CallerMemberName] string member = "", [CallerLineNumber] int line = 0)
        {
            var execution = Ambient.Value;
            if (execution == null)
            {
                return await action().ConfigureAwait(false);
            }

            T value;
            try
            {
                value = await Write(action).ConfigureAwait(false);
            }
            catch
            {
                execution.Completed(member, line);
                throw;
            }

            try
            {
                execution.Completed(member, line);
            }
            catch
            {
                // A lock that arrived with the refused continuation is released once, here.
                (value as IDisposable)?.Dispose();
                throw;
            }

            return value;
        }

        /// <summary>An await of the continuation (see <see cref="Await{T}"/>).</summary>
        /// <param name="action">Starts the work.</param>
        /// <param name="member">Caller.</param>
        /// <param name="line">Caller line.</param>
        /// <param name="observed">Optional synchronous native outcome observer, before continuation checks.</param>
        /// <returns>The work.</returns>
        internal static Task Await(Func<Task> action, [CallerMemberName] string member = "", [CallerLineNumber] int line = 0, Action<bool>? observed = null) =>
            Await(
                async () =>
                {
                    try
                    {
                        await action().ConfigureAwait(false);
                    }
                    catch
                    {
                        observed?.Invoke(false);
                        throw;
                    }

                    // Capture native-save evidence before Completed runs any continuation hook or access check.
                    // Failure of the continuation cannot turn an unacknowledged native write into successful proof.
                    observed?.Invoke(true);
                    return true;
                },
                member,
                line);

        /// <summary>Waits for a lock as an await of the continuation; the handle releases exactly the wait that succeeded.</summary>
        /// <param name="semaphore">The lock.</param>
        /// <param name="token">Cancellation.</param>
        /// <param name="member">Caller.</param>
        /// <param name="line">Caller line.</param>
        /// <returns>The held lock.</returns>
        internal static Task<IDisposable> AwaitLock(SemaphoreSlim semaphore, CancellationToken token, [CallerMemberName] string member = "", [CallerLineNumber] int line = 0) =>
            Await(() => AcquireAsync(semaphore, token), member, line);

        /// <summary>
        /// Leaves the calling flow's continuation for work that isn't part of it: a native event, a deletion's cleanup, a
        /// background worker started on the way (it would otherwise inherit the continuation for good).
        /// </summary>
        /// <returns>Restores the continuation when disposed.</returns>
        internal static IDisposable Detach()
        {
            var previous = Ambient.Value;
            Ambient.Value = null;
            return new Detached(previous);
        }

        /// <inheritdoc />
        public void Dispose() => Ambient.Value = _previous;

        private static async Task<IDisposable> AcquireAsync(SemaphoreSlim semaphore, CancellationToken token)
        {
            await semaphore.WaitAsync(token).ConfigureAwait(false);
            return new Held(semaphore);
        }

        private void Completed(string member, int line)
        {
            lock (Lifecycle)
            {
                var seam = _store.Awaited;
                if (seam != null)
                {
                    // The test seam stands for another request or a native event at this point, not for this operation.
                    Ambient.Value = null;
                    try
                    {
                        seam(member + ":" + line.ToString(System.Globalization.CultureInfo.InvariantCulture));
                    }
                    finally
                    {
                        Ambient.Value = this;
                    }
                }

                Check();
            }
        }

        private sealed class Held : IDisposable
        {
            private SemaphoreSlim? _semaphore;

            internal Held(SemaphoreSlim semaphore)
            {
                _semaphore = semaphore;
            }

            public void Dispose() => Interlocked.Exchange(ref _semaphore, null)?.Release();
        }

        private sealed class Detached : IDisposable
        {
            private readonly ListContinuation? _previous;

            internal Detached(ListContinuation? previous)
            {
                _previous = previous;
            }

            public void Dispose() => Ambient.Value = _previous;
        }
    }
}
