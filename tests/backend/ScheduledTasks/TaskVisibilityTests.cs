using System.Reflection;
using System.Runtime.CompilerServices;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using MediaBrowser.Model.Tasks;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class TaskVisibilityTests
{
    private static readonly (Type Task, Action<PluginConfiguration, bool> Set)[] FeatureTasks =
    [
        (typeof(ArrTagsSyncTask), (c, on) => c.ArrTagsSyncEnabled = on),
        (typeof(AudioLanguageTagsSyncTask), (c, on) => c.AudioLanguageTagSyncEnabled = on),
        (typeof(JellyfinToSeerrWatchlistSyncTask), (c, on) => { c.JellyseerrEnabled = on; c.SyncJellyfinWatchlistToSeerr = on; }),
        (typeof(JellyseerrWatchlistSyncTask), (c, on) => { c.JellyseerrEnabled = on; c.SyncJellyseerrWatchlist = on; }),
        (typeof(JellyseerrUserImportTask), (c, on) => { c.JellyseerrEnabled = on; c.JellyseerrAutoImportUsers = on; }),
        (typeof(MdblistRatingsFetchTask), (c, on) => { c.MdblistRatingsEnabled = on; c.MdblistRatingsFetchEnabled = on; }),
        (typeof(MdblistRatingsSyncTask), (c, on) => { c.MdblistRatingsEnabled = on; c.MdblistRatingsAutoSyncEnabled = on; }),
        (typeof(BuildTagCacheTask), (c, on) => c.TagCacheServerMode = on),
        (typeof(SpoilerApplyExistingTitlesTask), (c, on) => c.SpoilerBlurEnabled = on),
        (typeof(AnalyticsReportTask), (c, on) => c.AnalyticsEnabled = on),
    ];

    public static IEnumerable<object[]> Cases() => FeatureTasks.Select(t => new object[] { t.Task });

    [Theory]
    [MemberData(nameof(Cases))]
    public void FeatureTaskIsHiddenUntilItsFeatureIsOnAndFollowsTheSetting(Type taskType)
    {
        using var f = new ApiPluginFixture();
        var set = FeatureTasks.Single(t => t.Task == taskType).Set;
        var task = (IConfigurableScheduledTask)RuntimeHelpers.GetUninitializedObject(taskType);

        set(f.Plugin.Configuration, false);
        Assert.True(task.IsHidden);
        set(f.Plugin.Configuration, true);
        Assert.False(task.IsHidden);
        set(f.Plugin.Configuration, false);
        Assert.True(task.IsHidden);
        Assert.True(task.IsEnabled);
        Assert.True(task.IsLogged);
    }

    [Fact]
    public void EveryTaskEitherFollowsAFeatureOrIsListedAsAlwaysVisible()
    {
        var alwaysVisible = new[] { typeof(ClearTranslationCacheTask), typeof(RefreshCdnAssetsTask) };
        var tasks = typeof(BuildTagCacheTask).Assembly.GetTypes()
            .Where(t => typeof(IScheduledTask).IsAssignableFrom(t) && t is { IsClass: true, IsAbstract: false } && t.Namespace == typeof(BuildTagCacheTask).Namespace);
        foreach (var task in tasks)
        {
            var known = FeatureTasks.Any(t => t.Task == task) || alwaysVisible.Contains(task);
            Assert.True(known, $"{task.Name} must hide with its feature or be listed as always visible");
        }
    }
}
