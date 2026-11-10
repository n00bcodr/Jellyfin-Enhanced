(() => {
"use strict";
(() => {
  // client/src/host/admin-config-host.ts
  function globals() {
    return window;
  }
  function engine() {
    return globals().JEAdmin;
  }
  function requireEngine() {
    const value = engine();
    if (!value) throw new Error("The Jellyfin Enhanced settings engine has not loaded");
    return value;
  }

  // client/src/admin/config/per-user-props.ts
  var PER_USER_PROPS = [
    "AgeRatingTagsEnabled",
    "AgeRatingTagsPosition",
    "AspectRatioTagOrder",
    "AudioInfoTagOrder",
    "AutoPauseEnabled",
    "AutoPipEnabled",
    "AutoResumeEnabled",
    "AutoSkipIntro",
    "AutoSkipOutro",
    "AwardsTagsEnabled",
    "AwardsTagsPosition",
    "CustomTagsEnabled",
    "CustomTagsPosition",
    "DefaultLanguage",
    "DefaultSubtitleFont",
    "DefaultSubtitleSize",
    "DefaultSubtitleStyle",
    "DefaultSubtitleTextEffect",
    "DisableCustomSubtitleStyles",
    "DynamicRangeTagOrder",
    "EditionTagOrder",
    "FrameRateTagOrder",
    "GenreTagsEnabled",
    "GenreTagsPosition",
    "HiddenContentDefaultEnabled",
    "HiddenContentDefaultExperimentalHideCollections",
    "HiddenContentDefaultFilterCalendar",
    "HiddenContentDefaultFilterContinueWatching",
    "HiddenContentDefaultFilterDiscovery",
    "HiddenContentDefaultFilterLibrary",
    "HiddenContentDefaultFilterNextUp",
    "HiddenContentDefaultFilterRecommendations",
    "HiddenContentDefaultFilterRequests",
    "HiddenContentDefaultFilterSearch",
    "HiddenContentDefaultFilterUpcoming",
    "HiddenContentDefaultShowButtonCast",
    "HiddenContentDefaultShowButtonDetails",
    "HiddenContentDefaultShowButtonJellyseerr",
    "HiddenContentDefaultShowButtonLibrary",
    "HiddenContentDefaultShowHideButtons",
    "HiddenContentDefaultShowHideConfirmation",
    "LanguageTagsEnabled",
    "LanguageTagsPosition",
    "LogoTagsEnabled",
    "LogoTagsPosition",
    "LongPress2xEnabled",
    "PauseScreenDelaySeconds",
    "PauseScreenEnabled",
    "PeopleTagsEnabled",
    "QualityHideSdr",
    "QualityTagsEnabled",
    "QualityTagsPosition",
    "RandomButtonEnabled",
    "RandomIncludeMovies",
    "RandomIncludeShows",
    "RandomScopeCurrentContainer",
    "RandomUnwatchedOnly",
    "RatingTagsColorByScore",
    "RatingTagsEnabled",
    "RatingTagsPosition",
    "RatingTagsShowCommunity",
    "RatingTagsShowCritic",
    "RemoveContinueWatchingEnabled",
    "ResolutionTagOrder",
    "ReviewsExpandedByDefault",
    "RuntimeTagOrder",
    "ShowAspectRatioTag",
    "ShowAudioInfoTag",
    "ShowAudioLanguages",
    "ShowDynamicRangeTag",
    "ShowEditionTag",
    "ShowFileSizes",
    "ShowFrameRateTag",
    "ShowLowQualitySourceTag",
    "ShowRatingInPlayer",
    "ShowResolutionTag",
    "ShowRuntimeTag",
    "ShowSourceTag",
    "ShowSpecialFormatTag",
    "ShowVersionsTag",
    "ShowVideoCodecTag",
    "ShowWatchProgress",
    "SourceTagOrder",
    "SpecialFormatTagOrder",
    "StatusTagsDirectPlay",
    "StatusTagsEnabled",
    "StatusTagsJustAdded",
    "StatusTagsLeaving",
    "StatusTagsMilestones",
    "StatusTagsNewRelease",
    "StatusTagsPosition",
    "StatusTagsScenes",
    "StatusTagsSchedule",
    "StatusTagsSeriesStatus",
    "StatusTagsTrending",
    "TagsHideOnHover",
    "VersionsTagOrder",
    "VideoCodecTagOrder"
  ];

  // client/src/admin/config/per-user-entry.ts
  var JEAdmin = requireEngine();
  JEAdmin.setPerUser(PER_USER_PROPS);
})();
})();
//# sourceMappingURL=per-user.js.map
