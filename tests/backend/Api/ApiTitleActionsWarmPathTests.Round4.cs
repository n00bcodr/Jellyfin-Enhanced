// Round 4 (M21 hold): a stable person whose every read carries newer activity facts still confirms at once.
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;

namespace JE.Tests;

public partial class ApiTitleActionsWarmPathTests
{
    [Fact]
    public async Task ActivityUpdatesOnEveryReadNeverStopAStablePersonFromConfirming()
    {
        using var rig = new Rig();
        var reads = 0;
        // Jellyfin reads a new User object each time, and its own activity tracking moves these on every request; none
        // of them decides access, so the authorization stamp (and the copy-sharing key) never sees them.
        rig.Lookup = id =>
        {
            if (id != rig.Viewer.Id) return null;
            var user = Rig.Person(id);
            var n = Interlocked.Increment(ref reads);
            user.LastActivityDate = new DateTime(2026, 10, 29, 0, 0, 0, DateTimeKind.Utc).AddSeconds(n);
            user.LastLoginDate = user.LastActivityDate;
            user.InvalidLoginAttemptCount = n % 3;
            return user;
        };
        Assert.Equal(200, (await rig.Read()).Status);
        await rig.Settle();
        var before = rig.Reads;
        var scans = rig.Scans;
        var (status, body) = await rig.Read();
        Assert.Equal(200, status);
        Assert.Equal("{\"allowed\":true,\"itemId\":null}", body);
        // Confirmed on the first read in every phase: the same six reads and one shared scan as an unchanging person.
        Assert.Equal(6, rig.Reads - before);
        Assert.Equal(1, rig.Scans - scans);
        var held = rig.Viewer;
        held.LastActivityDate = new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        Assert.Equal(NativeDetailsPolicy.Access.Allowed, await rig.Policy.SeeDetailsAsync(held, Title, CancellationToken.None));
        Assert.True(rig.Policy.MayListAbsent(held, Title));
        Assert.Equal(NativeDetailsPolicy.ListedTitle.Absent, rig.Policy.Listed(held, true, TmdbId));
    }
}
