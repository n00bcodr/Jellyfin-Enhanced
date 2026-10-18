using System.Text.RegularExpressions;

namespace JE.Tests;

/// <summary>
/// 4a review round 9 (4a-security-r9-1 and the coordinator's deny-by-default note): EVERY Jellyfin action that can create,
/// delete, change, lock or authenticate a user runs inside the Jellyfin user bracket, which the automatic-write check's
/// administrator fact is versioned by. Round 8 bracketed four named actions; Jellyfin 12.2's UpdateUserPassword and
/// UpdateUserPasswordLegacy also authenticate the person (a failed check can lock them out), and weren't among them.
/// <para>
/// This drives the production filter with every controller action of Jellyfin's own Jellyfin.Api.dll (the pinned 12.2
/// or 10.11.11 release; Support/JellyfinApiAssembly.cs), as MVC would run it, and compares the version that moved with
/// the reviewed list below. The list was made from the decompiled 12.2 and 10.11.11 sources: every action that calls
/// IUserManager's changes (UpdatePolicyAsync, UpdateUserAsync, CreateUserAsync, DeleteUserAsync, ChangePassword,
/// ResetPassword, RenameUser, UpdateConfigurationAsync, ClearProfileImageAsync, InitializeAsync, the password-reset
/// pin), signs a person in (AuthenticateUser, ISessionManager.AuthenticateNewSession, Quick Connect), or sits on the
/// user, Quick Connect or start-up controllers. It FAILS CLOSED on a Jellyfin update: an action the filter brackets that
/// isn't reviewed, a reviewed one that is gone or renamed, and any non-GET action whose name or controller looks like it
/// touches users but isn't reviewed.
/// </para>
/// </summary>
[Collection("Jellyfin user versions")]
public class IntegrationJellyfinApiUserActionTests
{
    // "user": the person of the action's userId argument (else the signed-in person); "global": every person (the
    // person isn't known before the action runs).
    private static readonly Dictionary<string, string> Common = new(StringComparer.Ordinal)
    {
        ["UserController.DeleteUser"] = "user",
        ["UserController.AuthenticateUser"] = "user",
        ["UserController.AuthenticateUserByName"] = "global",
        ["UserController.AuthenticateWithQuickConnect"] = "global",
        ["UserController.UpdateUserPassword"] = "user",
        ["UserController.UpdateUserPasswordLegacy"] = "user",
        ["UserController.UpdateUser"] = "user",
        ["UserController.UpdateUserLegacy"] = "user",
        ["UserController.UpdateUserPolicy"] = "user",
        ["UserController.UpdateUserConfiguration"] = "user",
        ["UserController.UpdateUserConfigurationLegacy"] = "user",
        ["UserController.CreateUserByName"] = "global",
        ["UserController.ForgotPassword"] = "global",
        ["UserController.ForgotPasswordPin"] = "global",
        ["QuickConnectController.InitiateQuickConnect"] = "global",
        ["QuickConnectController.AuthorizeQuickConnect"] = "user",
        ["StartupController.CompleteWizard"] = "global",
        ["StartupController.UpdateInitialConfiguration"] = "global",
        ["StartupController.SetRemoteAccess"] = "global",
        ["StartupController.UpdateStartupUser"] = "global",
        // The first user is created on its first call (IUserManager.InitializeAsync).
        ["StartupController.GetFirstUser"] = "global",
        ["ImageController.PostUserImage"] = "user",
        ["ImageController.PostUserImageLegacy"] = "user",
        ["ImageController.PostUserImageByIndexLegacy"] = "user",
        ["ImageController.DeleteUserImage"] = "user",
        ["ImageController.DeleteUserImageLegacy"] = "user",
        ["ImageController.DeleteUserImageByIndexLegacy"] = "user",
    };

    // 4a review round 10: the actions that save the request's person through RequestHelpers.GetSession (its userId
    // argument, else the signed-in person): ISessionManager.LogSessionActivity saves that user whole, with its activity date
    // moved, from the object read at the start of the request (JellyfinUserActions.PersonScoped). Round 9 read
    // Jellyfin.Api alone and stopped at the session manager's interface; following it into Emby.Server.Implementations
    // finds the save. Bracketed for that person only.
    private static readonly string[] SessionActivity =
    {
        "PlaystateController.MarkPlayedItem",
        "PlaystateController.MarkPlayedItemLegacy",
        "PlaystateController.MarkUnplayedItem",
        "PlaystateController.MarkUnplayedItemLegacy",
        "PlaystateController.OnPlaybackProgress",
        "PlaystateController.OnPlaybackProgressLegacy",
        "PlaystateController.OnPlaybackStart",
        "PlaystateController.OnPlaybackStartLegacy",
        "PlaystateController.OnPlaybackStopped",
        "PlaystateController.OnPlaybackStoppedLegacy",
        "PlaystateController.ReportPlaybackProgress",
        "PlaystateController.ReportPlaybackStart",
        "PlaystateController.ReportPlaybackStopped",
        "SessionController.DisplayContent",
        "SessionController.Play",
        "SessionController.PostCapabilities",
        "SessionController.PostFullCapabilities",
        "SessionController.ReportViewing",
        "SessionController.SendFullGeneralCommand",
        "SessionController.SendGeneralCommand",
        "SessionController.SendMessageCommand",
        "SessionController.SendPlaystateCommand",
        "SessionController.SendSystemCommand",
        "SyncPlayController.SyncPlayBuffering",
        "SyncPlayController.SyncPlayCreateGroup",
        "SyncPlayController.SyncPlayGetGroup",
        "SyncPlayController.SyncPlayGetGroups",
        "SyncPlayController.SyncPlayJoinGroup",
        "SyncPlayController.SyncPlayLeaveGroup",
        "SyncPlayController.SyncPlayMovePlaylistItem",
        "SyncPlayController.SyncPlayNextItem",
        "SyncPlayController.SyncPlayPause",
        "SyncPlayController.SyncPlayPing",
        "SyncPlayController.SyncPlayPreviousItem",
        "SyncPlayController.SyncPlayQueue",
        "SyncPlayController.SyncPlayReady",
        "SyncPlayController.SyncPlayRemoveFromPlaylist",
        "SyncPlayController.SyncPlaySeek",
        "SyncPlayController.SyncPlaySetIgnoreWait",
        "SyncPlayController.SyncPlaySetNewQueue",
        "SyncPlayController.SyncPlaySetPlaylistItem",
        "SyncPlayController.SyncPlaySetRepeatMode",
        "SyncPlayController.SyncPlaySetShuffleMode",
        "SyncPlayController.SyncPlayStop",
        "SyncPlayController.SyncPlayUnpause",
    };

    // 4a review round 11 (4a-security-r11-2, Q-4AF11-1): the non-GET actions whose code reaches a callback the code read
    // can't resolve, whatever its type: a delegate handed in from outside Jellyfin's assemblies (the first one found per
    // action, each an event a plugin can subscribe to: SubtitleManager.SubtitleDownloadFailure 46, ApplicationHost.HasPendingRestartChanged 15,
    // BaseConfigurationManager.NamedConfigurationUpdating 11, LyricManager.LyricDownloadFailure 6, the Live TV timer
    // events 6, ServerConfigurationManager.ConfigurationUpdating 1, the collection events 3, on 12.2). 88 on 12.2, the same
    // 88 plus LibraryStructureController.RenameVirtualFolder on 10.11.11 (12.2's reaches IUserManager.UpdateUserAsync,
    // above). Among them the hot paths: POST PlaybackInfo and OpenLiveStream, user data, favourites, ratings and the
    // session's end, so they are bracketed for the request's person (16 by their userId argument, the rest the signed-in
    // person), never for everyone.
    private static readonly string[] Callbacks =
    {
        "BackupController.StartRestoreBackup",
        "CollectionController.AddToCollection",
        "CollectionController.CreateCollection",
        "CollectionController.RemoveFromCollection",
        "ConfigurationController.UpdateBrandingConfiguration",
        "ConfigurationController.UpdateConfiguration",
        "ConfigurationController.UpdateNamedConfiguration",
        "DevicesController.DeleteDevice",
        "ImageController.DeleteCustomSplashscreen",
        "ImageController.DeleteItemImage",
        "ImageController.DeleteItemImageByIndex",
        "ImageController.SetItemImage",
        "ImageController.SetItemImageByIndex",
        "ImageController.UpdateItemImageIndex",
        "ImageController.UploadCustomSplashscreen",
        "ItemLookupController.ApplySearchCriteria",
        "ItemLookupController.GetBookRemoteSearchResults",
        "ItemLookupController.GetBoxSetRemoteSearchResults",
        "ItemLookupController.GetMovieRemoteSearchResults",
        "ItemLookupController.GetMusicAlbumRemoteSearchResults",
        "ItemLookupController.GetMusicArtistRemoteSearchResults",
        "ItemLookupController.GetMusicVideoRemoteSearchResults",
        "ItemLookupController.GetPersonRemoteSearchResults",
        "ItemLookupController.GetSeriesRemoteSearchResults",
        "ItemLookupController.GetTrailerRemoteSearchResults",
        "ItemRefreshController.RefreshItem",
        "ItemsController.UpdateItemUserData",
        "ItemsController.UpdateItemUserDataLegacy",
        "ItemUpdateController.UpdateItem",
        "ItemUpdateController.UpdateItemContentType",
        "LibraryController.DeleteItem",
        "LibraryController.DeleteItems",
        "LibraryController.PostUpdatedMedia",
        "LibraryController.PostUpdatedMovies",
        "LibraryController.PostUpdatedSeries",
        "LibraryController.RefreshLibrary",
        "LibraryStructureController.AddMediaPath",
        "LibraryStructureController.AddVirtualFolder",
        "LibraryStructureController.RemoveMediaPath",
        "LibraryStructureController.RemoveVirtualFolder",
        "LibraryStructureController.UpdateLibraryOptions",
        "LibraryStructureController.UpdateMediaPath",
        "LiveTvController.AddListingProvider",
        "LiveTvController.AddTunerHost",
        "LiveTvController.CancelSeriesTimer",
        "LiveTvController.CancelTimer",
        "LiveTvController.CreateSeriesTimer",
        "LiveTvController.CreateTimer",
        "LiveTvController.DeleteListingProvider",
        "LiveTvController.DeleteRecording",
        "LiveTvController.DeleteTunerHost",
        "LiveTvController.GetPrograms",
        "LiveTvController.SetChannelMapping",
        "LiveTvController.UpdateSeriesTimer",
        "LiveTvController.UpdateTimer",
        "LyricsController.DeleteLyrics",
        "LyricsController.DownloadRemoteLyrics",
        "LyricsController.UploadLyrics",
        "MediaInfoController.GetPostedPlaybackInfo",
        "MediaInfoController.OpenLiveStream",
        "PackageController.InstallPackage",
        "PackageController.SetRepositories",
        "PlaylistsController.AddItemToPlaylist",
        "PlaylistsController.CreatePlaylist",
        "PlaylistsController.MoveItem",
        "PlaylistsController.RemoveItemFromPlaylist",
        "PlaylistsController.RemoveUserFromPlaylist",
        "PlaylistsController.UpdatePlaylist",
        "PlaylistsController.UpdatePlaylistUser",
        "PluginsController.UninstallPlugin",
        "PluginsController.UninstallPluginByVersion",
        "RemoteImageController.DownloadRemoteImage",
        "ScheduledTasksController.StartTask",
        "ScheduledTasksController.UpdateTask",
        "SessionController.ReportSessionEnded",
        "SubtitleController.DeleteSubtitle",
        "SubtitleController.DownloadRemoteSubtitles",
        "SubtitleController.UploadSubtitle",
        "UserLibraryController.DeleteUserItemRating",
        "UserLibraryController.DeleteUserItemRatingLegacy",
        "UserLibraryController.MarkFavoriteItem",
        "UserLibraryController.MarkFavoriteItemLegacy",
        "UserLibraryController.UnmarkFavoriteItem",
        "UserLibraryController.UnmarkFavoriteItemLegacy",
        "UserLibraryController.UpdateUserItemRating",
        "UserLibraryController.UpdateUserItemRatingLegacy",
        "VideosController.DeleteAlternateSources",
        "VideosController.MergeVersions",
    };

    private static readonly Dictionary<string, Dictionary<string, string>> Reviewed = new(StringComparer.Ordinal)
    {
        // 12.2: renaming a library rewrites every user's library preferences (IUserManager.UpdateUserAsync); adding a user
        // to a session and removing one log the session's activity too.
        ["jf12"] = With(SessionActivity.Concat(Callbacks).Concat(new[] { "SessionController.AddUserToSession", "SessionController.RemoveUserFromSession" }), ("LibraryStructureController.RenameVirtualFolder", "global")),
        // 10.11: the easy (PIN) password still exists; renaming a library reaches only the callbacks.
        ["jf10"] = With(SessionActivity.Concat(Callbacks).Append("LibraryStructureController.RenameVirtualFolder"), ("UserController.UpdateUserEasyPassword", "user")),
    };

    private static Dictionary<string, string> With(IEnumerable<string> person, params (string Action, string Key)[] more)
    {
        var all = new Dictionary<string, string>(Common, StringComparer.Ordinal);
        foreach (var action in person) all.Add(action, "user");
        foreach (var (action, key) in more) all.Add(action, key);
        return all;
    }

    // A non-GET action whose name or controller suggests it touches users or signs someone in.
    private static readonly Regex LooksLikeAUserAction = new(@"Authenticat|Password|Policy|Login|Logon|Lockout|QuickConnect|Startup|User(?!Data|Item|View|Library|Rating|Played|Favorite)|Account|Permission", RegexOptions.CultureInvariant);

    // Reviewed non-GET actions (12.2 and 10.11.11) whose name matches but that change no user: a playlist's shares
    // (IPlaylistManager; bracketed for the callbacks they reach, round 11), and on 10.11 the extra users of a playback
    // session (ISessionManager's session state; 12.2 also logs the session's activity, so it is bracketed there).
    private static readonly HashSet<string> NotUserChanges = new(StringComparer.Ordinal)
    {
        "PlaylistsController.UpdatePlaylistUser", "PlaylistsController.RemoveUserFromPlaylist",
        "SessionController.AddUserToSession", "SessionController.RemoveUserFromSession",
    };

    [Fact]
    public async Task EveryJellyfinActionThatCanChangeOrAuthenticateAUserRunsInsideItsBracket()
    {
        using var api = JellyfinApiAssembly.Load();
        var reviewed = Reviewed[api.Line];
        var actions = api.Actions();
        Assert.True(actions.Count > 300, "Jellyfin.Api has " + actions.Count + " actions: not the assembly expected");
        var problems = new List<string>();
        foreach (var action in actions)
        {
            var person = Guid.NewGuid();
            var other = Guid.NewGuid();
            var args = new Dictionary<string, object?>();
            if (action.HasUserId) args["userId"] = person;
            // Signed in as someone else when the action names its person (the userId argument decides), else as the person.
            var context = JellyfinUserBracketHarness.Context(action.Controller, action.Method, action.Verbs[0] == "*" ? "POST" : action.Verbs[0], args, action.HasUserId ? Guid.NewGuid() : person);
            var seen = await JellyfinUserBracketHarness.Observe(context, person, other);
            var expected = reviewed.GetValueOrDefault(action.Name, "none");
            if (seen != expected) problems.Add(action.Name + " [" + string.Join(",", action.Verbs) + "]: bracket " + seen + ", reviewed " + expected);
            if (expected == "none" && action.Writes && !NotUserChanges.Contains(action.Name) && LooksLikeAUserAction.Match(action.Name) is { Success: true } match)
                problems.Add(action.Name + ": looks like it touches users (\"" + match.Value + "\") but isn't reviewed: review it, then add it to the bracketed or the not-a-user-change list");
        }

        foreach (var name in reviewed.Keys.Where(n => !actions.Any(a => a.Name == n)))
            problems.Add(name + ": reviewed, but Jellyfin " + api.Version + " has no such action (renamed or removed?): review the new code");
        foreach (var name in NotUserChanges.Where(n => !actions.Any(a => a.Name == n)))
            problems.Add(name + ": on the not-a-user-change list, but Jellyfin " + api.Version + " has no such action");
        if (problems.Count > 0) throw new Xunit.Sdk.XunitException("Jellyfin " + api.Version + " (" + api.Path + "):\n" + string.Join("\n", problems));
    }

    // An action with a userId argument that isn't given (Jellyfin's default: the signed-in person) brackets the signed-in
    // person; with neither, every person.
    [Theory]
    [InlineData("UserController.UpdateUserPassword", true, "user")]
    [InlineData("UserController.UpdateUserPassword", false, "global")]
    [InlineData("QuickConnectController.AuthorizeQuickConnect", true, "user")]
    [InlineData("ImageController.DeleteUserImage", true, "user")]
    public async Task AnOmittedUserIdBracketsTheSignedInPerson(string name, bool signedIn, string expected)
    {
        using var api = JellyfinApiAssembly.Load();
        var action = api.Actions().Single(a => a.Name == name);
        var person = Guid.NewGuid();
        var context = JellyfinUserBracketHarness.Context(action.Controller, action.Method, action.Verbs[0], new Dictionary<string, object?> { ["userId"] = null }, signedIn ? person : null);
        Assert.Equal(expected, await JellyfinUserBracketHarness.Observe(context, person, Guid.NewGuid()));
    }
}
