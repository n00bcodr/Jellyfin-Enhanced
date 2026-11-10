(() => {
"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared = core.core?.featureContext;
    if (typeof shared !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared(feature, core, slots);
  }
  function publishSharedModules(modules) {
    const JE = window.JellyfinEnhanced;
    if (!JE) return;
    const core = JE.core ?? (JE.core = {});
    let registry = core.sharedModules;
    if (!registry) {
      registry = /* @__PURE__ */ Object.create(null);
      Object.defineProperty(core, "sharedModules", { value: registry, configurable: true, writable: true, enumerable: false });
    }
    for (const [id, namespace] of Object.entries(modules)) registry[id] ?? (registry[id] = namespace);
  }

  // client/src/contracts/schema.ts
  var schema_exports = {};
  __export(schema_exports, {
    bootstrapSchema: () => bootstrapSchema
  });
  var bootstrapSchema = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$ref": "#/$defs/BootstrapResponse",
    "$defs": {
      "SpoilerBlurCollectionEntry": {
        "type": "object",
        "properties": {
          "CollectionId": {
            "type": "string"
          },
          "CollectionName": {
            "type": "string"
          },
          "EnabledAt": {
            "type": "string"
          }
        },
        "required": [
          "CollectionId",
          "CollectionName",
          "EnabledAt"
        ],
        "additionalProperties": false
      },
      "SpoilerBlurMovieEntry": {
        "type": "object",
        "properties": {
          "EnabledAt": {
            "type": "string"
          },
          "MovieId": {
            "type": "string"
          },
          "MovieName": {
            "type": "string"
          }
        },
        "required": [
          "EnabledAt",
          "MovieId",
          "MovieName"
        ],
        "additionalProperties": false
      },
      "SpoilerBlurPendingEntry": {
        "type": "object",
        "properties": {
          "DisplayName": {
            "type": "string"
          },
          "MediaType": {
            "type": "string"
          },
          "RequestedAt": {
            "type": "string"
          },
          "TmdbId": {
            "type": "string"
          }
        },
        "required": [
          "DisplayName",
          "MediaType",
          "RequestedAt",
          "TmdbId"
        ],
        "additionalProperties": false
      },
      "SpoilerBlurUserPrefs": {
        "type": "object",
        "properties": {
          "HideAirDate": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "HideCast": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "HideChapterNames": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "HideEpisodeDescriptions": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "HideRatings": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "HideReviews": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "HideSeriesDescriptions": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "HideTaglines": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "HideTags": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "HideTrickplay": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "ReplaceEpisodeTitles": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "SkipDisableConfirm": {
            "type": "boolean"
          },
          "UseAdvancedCategories": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "HideAirDate",
          "HideCast",
          "HideChapterNames",
          "HideEpisodeDescriptions",
          "HideRatings",
          "HideReviews",
          "HideSeriesDescriptions",
          "HideTaglines",
          "HideTags",
          "HideTrickplay",
          "ReplaceEpisodeTitles",
          "SkipDisableConfirm",
          "UseAdvancedCategories"
        ],
        "additionalProperties": false
      },
      "SpoilerBlurSeriesEntry": {
        "type": "object",
        "properties": {
          "EnabledAt": {
            "type": "string"
          },
          "SeriesId": {
            "type": "string"
          },
          "SeriesName": {
            "type": "string"
          }
        },
        "required": [
          "EnabledAt",
          "SeriesId",
          "SeriesName"
        ],
        "additionalProperties": false
      },
      "UserSpoilerBlur": {
        "type": "object",
        "properties": {
          "Collections": {
            "type": "object",
            "additionalProperties": {
              "$ref": "#/$defs/SpoilerBlurCollectionEntry"
            }
          },
          "Movies": {
            "type": "object",
            "additionalProperties": {
              "$ref": "#/$defs/SpoilerBlurMovieEntry"
            }
          },
          "PendingTmdb": {
            "type": "object",
            "additionalProperties": {
              "$ref": "#/$defs/SpoilerBlurPendingEntry"
            }
          },
          "Prefs": {
            "$ref": "#/$defs/SpoilerBlurUserPrefs"
          },
          "Series": {
            "type": "object",
            "additionalProperties": {
              "$ref": "#/$defs/SpoilerBlurSeriesEntry"
            }
          }
        },
        "required": [
          "Collections",
          "Movies",
          "PendingTmdb",
          "Prefs",
          "Series"
        ],
        "additionalProperties": false
      },
      "BootstrapPrefetched": {
        "type": "object",
        "properties": {
          "ActiveStreamSessions": {
            "anyOf": [
              {
                "type": "array",
                "items": true
              },
              {
                "type": "null"
              }
            ]
          },
          "SeerrStatus": true,
          "SeerrUserStatus": true,
          "SpoilerBlurSeries": {
            "anyOf": [
              {
                "$ref": "#/$defs/UserSpoilerBlur"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagStripRevision": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "ActiveStreamSessions",
          "SeerrStatus",
          "SeerrUserStatus",
          "SpoilerBlurSeries",
          "TagStripRevision"
        ],
        "additionalProperties": false
      },
      "BootstrapCustomTagSource": {
        "type": "object",
        "properties": {
          "Id": {
            "type": "string"
          },
          "Match": {
            "type": "string"
          },
          "Value": {
            "type": "string"
          }
        },
        "required": [
          "Id",
          "Match",
          "Value"
        ],
        "additionalProperties": false
      },
      "BootstrapArrInstance": {
        "type": "object",
        "properties": {
          "Enabled": {
            "type": "boolean"
          },
          "Name": {
            "type": "string"
          },
          "Url": {
            "type": "string"
          },
          "UrlMappings": {
            "type": "string"
          }
        },
        "required": [
          "Enabled",
          "Name",
          "Url",
          "UrlMappings"
        ],
        "additionalProperties": false
      },
      "BootstrapPrivateConfig": {
        "type": "object",
        "properties": {
          "BazarrUrl": {
            "type": "string"
          },
          "BazarrUrlMappings": {
            "type": "string"
          },
          "CustomTagRuleSources": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BootstrapCustomTagSource"
            }
          },
          "RadarrInstances": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BootstrapArrInstance"
            }
          },
          "RadarrInstancesCorrupt": {
            "type": "boolean"
          },
          "RadarrUrl": {
            "type": "string"
          },
          "RadarrUrlMappings": {
            "type": "string"
          },
          "ShokoUrl": {
            "type": "string"
          },
          "ShokoUrlMappings": {
            "type": "string"
          },
          "SonarrInstances": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BootstrapArrInstance"
            }
          },
          "SonarrInstancesCorrupt": {
            "type": "boolean"
          },
          "SonarrUrl": {
            "type": "string"
          },
          "SonarrUrlMappings": {
            "type": "string"
          }
        },
        "required": [
          "BazarrUrl",
          "BazarrUrlMappings",
          "CustomTagRuleSources",
          "RadarrInstances",
          "RadarrInstancesCorrupt",
          "RadarrUrl",
          "RadarrUrlMappings",
          "ShokoUrl",
          "ShokoUrlMappings",
          "SonarrInstances",
          "SonarrInstancesCorrupt",
          "SonarrUrl",
          "SonarrUrlMappings"
        ],
        "additionalProperties": false
      },
      "BootstrapCustomTagRule": {
        "type": "object",
        "properties": {
          "Icon": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "Id": {
            "type": "string"
          },
          "Label": {
            "type": "string"
          }
        },
        "required": [
          "Icon",
          "Id",
          "Label"
        ],
        "additionalProperties": false
      },
      "Shortcut": {
        "type": "object",
        "properties": {
          "Category": {
            "type": "string"
          },
          "Key": {
            "type": "string"
          },
          "Label": {
            "type": "string"
          },
          "Name": {
            "type": "string"
          }
        },
        "required": [
          "Category",
          "Key",
          "Label",
          "Name"
        ],
        "additionalProperties": false
      },
      "TagGroupCaps": {
        "type": "object",
        "properties": {
          "AgeRating": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "Awards": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "Custom": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "Genre": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "Language": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "Logos": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "Quality": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "Rating": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "Status": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "AgeRating",
          "Awards",
          "Custom",
          "Genre",
          "Language",
          "Logos",
          "Quality",
          "Rating",
          "Status"
        ],
        "additionalProperties": false
      },
      "TagScopeSet": {
        "type": "object",
        "properties": {
          "ContinueWatching": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "Episodes": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "Movies": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "NextUp": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "Seasons": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "Series": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "ContinueWatching",
          "Episodes",
          "Movies",
          "NextUp",
          "Seasons",
          "Series"
        ],
        "additionalProperties": false
      },
      "TagGroupScopes": {
        "type": "object",
        "properties": {
          "AgeRating": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagScopeSet"
              },
              {
                "type": "null"
              }
            ]
          },
          "Awards": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagScopeSet"
              },
              {
                "type": "null"
              }
            ]
          },
          "Custom": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagScopeSet"
              },
              {
                "type": "null"
              }
            ]
          },
          "Genre": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagScopeSet"
              },
              {
                "type": "null"
              }
            ]
          },
          "Language": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagScopeSet"
              },
              {
                "type": "null"
              }
            ]
          },
          "Logos": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagScopeSet"
              },
              {
                "type": "null"
              }
            ]
          },
          "Quality": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagScopeSet"
              },
              {
                "type": "null"
              }
            ]
          },
          "Rating": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagScopeSet"
              },
              {
                "type": "null"
              }
            ]
          },
          "Status": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagScopeSet"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "AgeRating",
          "Awards",
          "Custom",
          "Genre",
          "Language",
          "Logos",
          "Quality",
          "Rating",
          "Status"
        ],
        "additionalProperties": false
      },
      "TagLayoutGroupSlot": {
        "type": "object",
        "properties": {
          "Group": {
            "type": "string"
          },
          "Slot": {
            "type": "string"
          }
        },
        "required": [
          "Group",
          "Slot"
        ],
        "additionalProperties": false
      },
      "TagLayoutProfile": {
        "type": "object",
        "properties": {
          "Groups": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/TagLayoutGroupSlot"
            }
          }
        },
        "required": [
          "Groups"
        ],
        "additionalProperties": false
      },
      "TagLayoutProfiles": {
        "type": "object",
        "properties": {
          "Bands": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagLayoutProfile"
              },
              {
                "type": "null"
              }
            ]
          },
          "Caption": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagLayoutProfile"
              },
              {
                "type": "null"
              }
            ]
          },
          "Corners": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagLayoutProfile"
              },
              {
                "type": "null"
              }
            ]
          },
          "Minimal": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagLayoutProfile"
              },
              {
                "type": "null"
              }
            ]
          },
          "Summary": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagLayoutProfile"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "Bands",
          "Caption",
          "Corners",
          "Minimal",
          "Summary"
        ],
        "additionalProperties": false
      },
      "TagShapeLook": {
        "type": "object",
        "properties": {
          "Caps": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagGroupCaps"
              },
              {
                "type": "null"
              }
            ]
          },
          "Density": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "Layout": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "Slots": {
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/TagLayoutGroupSlot"
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "TagGap": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagScale": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "Caps",
          "Density",
          "Layout",
          "Slots",
          "TagGap",
          "TagScale"
        ],
        "additionalProperties": false
      },
      "TagShapeOverrides": {
        "type": "object",
        "properties": {
          "Landscape": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagShapeLook"
              },
              {
                "type": "null"
              }
            ]
          },
          "List": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagShapeLook"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "Landscape",
          "List"
        ],
        "additionalProperties": false
      },
      "TagLookItemOverride": {
        "type": "object",
        "properties": {
          "Caps": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagGroupCaps"
              },
              {
                "type": "null"
              }
            ]
          },
          "ColourPreset": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "Density": {
            "type": "string"
          },
          "EdgeSpacing": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "ItemId": {
            "type": "string"
          },
          "Layout": {
            "type": "string"
          },
          "LockedAt": {
            "type": "integer"
          },
          "Scope": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "Shapes": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagShapeOverrides"
              },
              {
                "type": "null"
              }
            ]
          },
          "Slots": {
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/TagLayoutGroupSlot"
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "TagGap": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagScale": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "Caps",
          "ColourPreset",
          "Density",
          "EdgeSpacing",
          "ItemId",
          "Layout",
          "LockedAt",
          "Scope",
          "Shapes",
          "Slots",
          "TagGap",
          "TagScale"
        ],
        "additionalProperties": false
      },
      "TagLookCondition": {
        "type": "object",
        "properties": {
          "Field": {
            "type": "string"
          },
          "Value": {
            "type": "string"
          }
        },
        "required": [
          "Field",
          "Value"
        ],
        "additionalProperties": false
      },
      "TagLookRule": {
        "type": "object",
        "properties": {
          "ColourPreset": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "Density": {
            "type": "string"
          },
          "Enabled": {
            "type": "boolean"
          },
          "Id": {
            "type": "string"
          },
          "Layout": {
            "type": "string"
          },
          "Shapes": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagShapeOverrides"
              },
              {
                "type": "null"
              }
            ]
          },
          "Slots": {
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/TagLayoutGroupSlot"
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "When": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/TagLookCondition"
            }
          }
        },
        "required": [
          "ColourPreset",
          "Density",
          "Enabled",
          "Id",
          "Layout",
          "Shapes",
          "Slots",
          "When"
        ],
        "additionalProperties": false
      },
      "BootstrapPublicConfig": {
        "type": "object",
        "properties": {
          "ActiveStreamsAllUsers": {
            "type": "boolean"
          },
          "ActiveStreamsEnabled": {
            "type": "boolean"
          },
          "ActivityFeedEnabled": {
            "type": "boolean"
          },
          "ActivityFeedShowActiveStreams": {
            "type": "boolean"
          },
          "ActivityFeedShowFavorited": {
            "type": "boolean"
          },
          "ActivityFeedShowReviewed": {
            "type": "boolean"
          },
          "ActivityFeedShowWatched": {
            "type": "boolean"
          },
          "ActivityFeedUseCustomTabs": {
            "type": "boolean"
          },
          "ActivityFeedUseNativeTab": {
            "type": "boolean"
          },
          "AddRequestedMediaToWatchlist": {
            "type": "boolean"
          },
          "AgeRatingTagsEnabled": {
            "type": "boolean"
          },
          "AgeRatingTagsPosition": {
            "type": "string"
          },
          "AnalyticsEnabled": {
            "type": "boolean"
          },
          "AnalyticsShareUsageCounts": {
            "type": "boolean"
          },
          "ArrLinksEnabled": {
            "type": "boolean"
          },
          "ArrLinksShowStatusSingle": {
            "type": "boolean"
          },
          "ArrTagsLinksFilter": {
            "type": "string"
          },
          "ArrTagsLinksHideFilter": {
            "type": "string"
          },
          "ArrTagsPrefix": {
            "type": "string"
          },
          "ArrTagsShowAsLinks": {
            "type": "boolean"
          },
          "ArrTagsSyncEnabled": {
            "type": "boolean"
          },
          "AspectRatioTagOrder": {
            "type": "integer"
          },
          "AudioInfoTagOrder": {
            "type": "integer"
          },
          "AudioLanguageTagPrefix": {
            "type": "string"
          },
          "AudioLanguageTagShowAsLinks": {
            "type": "boolean"
          },
          "AudioLanguageTagSyncEnabled": {
            "type": "boolean"
          },
          "AutoPauseEnabled": {
            "type": "boolean"
          },
          "AutoPipEnabled": {
            "type": "boolean"
          },
          "AutoResumeEnabled": {
            "type": "boolean"
          },
          "AutoSkipIntro": {
            "type": "boolean"
          },
          "AutoSkipOutro": {
            "type": "boolean"
          },
          "AwardsTagsCertifiedFresh": {
            "type": "boolean"
          },
          "AwardsTagsEmmy": {
            "type": "boolean"
          },
          "AwardsTagsEnabled": {
            "type": "boolean"
          },
          "AwardsTagsImdb": {
            "type": "boolean"
          },
          "AwardsTagsLetterboxd": {
            "type": "boolean"
          },
          "AwardsTagsOscar": {
            "type": "boolean"
          },
          "AwardsTagsPosition": {
            "type": "string"
          },
          "BookmarksEnabled": {
            "type": "boolean"
          },
          "BookmarksUseCustomTabs": {
            "type": "boolean"
          },
          "BookmarksUseNativeTab": {
            "type": "boolean"
          },
          "BookmarksUsePluginPages": {
            "type": "boolean"
          },
          "CalendarFilterByLibraryAccess": {
            "type": "boolean"
          },
          "CalendarFirstDayOfWeek": {
            "type": "string"
          },
          "CalendarForceOnlyRequested": {
            "type": "boolean"
          },
          "CalendarHighlightFavorites": {
            "type": "boolean"
          },
          "CalendarHighlightWatchedSeries": {
            "type": "boolean"
          },
          "CalendarPageEnabled": {
            "type": "boolean"
          },
          "CalendarShowOnlyRequested": {
            "type": "boolean"
          },
          "CalendarTimeFormat": {
            "type": "string"
          },
          "CalendarUseCustomTabs": {
            "type": "boolean"
          },
          "CalendarUseNativeTab": {
            "type": "boolean"
          },
          "CalendarUsePluginPages": {
            "type": "boolean"
          },
          "CatchUpEnabled": {
            "type": "boolean"
          },
          "CatchUpUseCustomTabs": {
            "type": "boolean"
          },
          "CatchUpUseNativeTab": {
            "type": "boolean"
          },
          "CatchUpUsePluginPages": {
            "type": "boolean"
          },
          "ClearLocalStorageTimestamp": {
            "type": "integer"
          },
          "ClearTranslationCacheTimestamp": {
            "type": "integer"
          },
          "ColoredActivityIconsEnabled": {
            "type": "boolean"
          },
          "ColoredRatingsEnabled": {
            "type": "boolean"
          },
          "CustomTagRules": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BootstrapCustomTagRule"
            }
          },
          "CustomTagsEnabled": {
            "type": "boolean"
          },
          "CustomTagsPosition": {
            "type": "string"
          },
          "DEFAULT_PROVIDERS": {
            "type": "string"
          },
          "DEFAULT_REGION": {
            "type": "string"
          },
          "DefaultLanguage": {
            "type": "string"
          },
          "DefaultSubtitleFont": {
            "type": "integer"
          },
          "DefaultSubtitleSize": {
            "type": "integer"
          },
          "DefaultSubtitleStyle": {
            "type": "integer"
          },
          "DefaultSubtitleTextEffect": {
            "type": "integer"
          },
          "DisableAllShortcuts": {
            "type": "boolean"
          },
          "DisableCustomSubtitleStyles": {
            "type": "boolean"
          },
          "DisableTagsOnSearchPage": {
            "type": "boolean"
          },
          "DoesTheDogDieEnabled": {
            "type": "boolean"
          },
          "DownloadsFilterByUserRequests": {
            "type": "boolean"
          },
          "DownloadsHistoryAdminOnly": {
            "type": "boolean"
          },
          "DownloadsPageEnabled": {
            "type": "boolean"
          },
          "DownloadsPagePollingEnabled": {
            "type": "boolean"
          },
          "DownloadsPageShowIssues": {
            "type": "boolean"
          },
          "DownloadsPollIntervalSeconds": {
            "type": "integer"
          },
          "DownloadsShowHistory": {
            "type": "boolean"
          },
          "DownloadsUseCustomTabs": {
            "type": "boolean"
          },
          "DownloadsUseNativeTab": {
            "type": "boolean"
          },
          "DownloadsUsePluginPages": {
            "type": "boolean"
          },
          "DynamicRangeTagOrder": {
            "type": "integer"
          },
          "EditionTagOrder": {
            "type": "integer"
          },
          "ElsewhereCustomBrandingImageUrl": {
            "type": "string"
          },
          "ElsewhereCustomBrandingText": {
            "type": "string"
          },
          "ElsewhereEnabled": {
            "type": "boolean"
          },
          "ElsewhereSeasonProviders": {
            "type": "boolean"
          },
          "EnableCustomSplashScreen": {
            "type": "boolean"
          },
          "EnableLoginImage": {
            "type": "boolean"
          },
          "EnableTagsLocalStorageFallback": {
            "type": "boolean"
          },
          "FrameRateTagOrder": {
            "type": "integer"
          },
          "GenreTagsEnabled": {
            "type": "boolean"
          },
          "GenreTagsPosition": {
            "type": "string"
          },
          "HelpPanelAutocloseDelay": {
            "type": "integer"
          },
          "HiddenContentAdmin": {
            "type": "boolean"
          },
          "HiddenContentEnabled": {
            "type": "boolean"
          },
          "HiddenContentUseCustomTabs": {
            "type": "boolean"
          },
          "HiddenContentUseNativeTab": {
            "type": "boolean"
          },
          "HiddenContentUsePluginPages": {
            "type": "boolean"
          },
          "HideReviewsFromDisabledUsers": {
            "type": "boolean"
          },
          "HideReviewsFromHiddenUsers": {
            "type": "boolean"
          },
          "IGNORE_PROVIDERS": {
            "type": "string"
          },
          "IconStyle": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "JellyseerrAutoImportUsers": {
            "type": "boolean"
          },
          "JellyseerrAvailablePosterLinksToJellyfin": {
            "type": "boolean"
          },
          "JellyseerrBaseUrl": {
            "type": "string"
          },
          "JellyseerrDisableCache": {
            "type": "boolean"
          },
          "JellyseerrEnable4KRequests": {
            "type": "boolean"
          },
          "JellyseerrEnable4KTvRequests": {
            "type": "boolean"
          },
          "JellyseerrEnabled": {
            "type": "boolean"
          },
          "JellyseerrExcludeBlocklistedItems": {
            "type": "boolean"
          },
          "JellyseerrExcludeLibraryItems": {
            "type": "boolean"
          },
          "JellyseerrSearchExcludeLibraryItems": {
            "type": "boolean"
          },
          "JellyseerrShowAdvanced": {
            "type": "boolean"
          },
          "JellyseerrShowCollectionDiscovery": {
            "type": "boolean"
          },
          "JellyseerrShowDetailPageLink": {
            "type": "boolean"
          },
          "JellyseerrShowDetailPageLinkAsText": {
            "type": "boolean"
          },
          "JellyseerrShowGenreDiscovery": {
            "type": "boolean"
          },
          "JellyseerrShowIssueIndicator": {
            "type": "boolean"
          },
          "JellyseerrShowNetworkDiscovery": {
            "type": "boolean"
          },
          "JellyseerrShowPersonDiscovery": {
            "type": "boolean"
          },
          "JellyseerrShowQuotaInfo": {
            "type": "boolean"
          },
          "JellyseerrShowRecommended": {
            "type": "boolean"
          },
          "JellyseerrShowReportButton": {
            "type": "boolean"
          },
          "JellyseerrShowRequestMoreOnSeries": {
            "type": "boolean"
          },
          "JellyseerrShowSearchResults": {
            "type": "boolean"
          },
          "JellyseerrShowSimilar": {
            "type": "boolean"
          },
          "JellyseerrShowTagDiscovery": {
            "type": "boolean"
          },
          "JellyseerrSingleSeasonRequestOnly": {
            "type": "boolean"
          },
          "JellyseerrUrlMappings": {
            "type": "string"
          },
          "JellyseerrUseMoreInfoModal": {
            "type": "boolean"
          },
          "LanguageTagsCountBadge": {
            "type": "string"
          },
          "LanguageTagsEnabled": {
            "type": "boolean"
          },
          "LanguageTagsMergeRegions": {
            "type": "boolean"
          },
          "LanguageTagsPosition": {
            "type": "string"
          },
          "LanguageTagsPriority": {
            "type": "string"
          },
          "LanguageTagsPriorityStrict": {
            "type": "boolean"
          },
          "LanguageTagsShowAudio": {
            "type": "boolean"
          },
          "LanguageTagsShowSubtitles": {
            "type": "boolean"
          },
          "LanguageTagsStyle": {
            "type": "string"
          },
          "LeavingSoonAvailable": {
            "type": "boolean"
          },
          "LetterboxdEnabled": {
            "type": "boolean"
          },
          "LogoTagsEnabled": {
            "type": "boolean"
          },
          "LogoTagsMaxLogos": {
            "type": "integer"
          },
          "LogoTagsMovieMode": {
            "type": "string"
          },
          "LogoTagsPosition": {
            "type": "string"
          },
          "LogoTagsSeriesMode": {
            "type": "string"
          },
          "LongPress2xEnabled": {
            "type": "boolean"
          },
          "MaintenanceModeAction": {
            "type": "string"
          },
          "MaintenanceModeAffectedUsers": {
            "type": "string"
          },
          "MaintenanceModeEnabled": {
            "type": "boolean"
          },
          "MaintenanceModeEndsAt": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "MaintenanceModeMessage": {
            "type": "string"
          },
          "MdblistEnabled": {
            "type": "boolean"
          },
          "MdblistRatingsEnabled": {
            "type": "boolean"
          },
          "MdblistRatingsShowOnItemDetails": {
            "type": "boolean"
          },
          "MdblistRatingsShowPercentSymbol": {
            "type": "boolean"
          },
          "MdblistRatingsSources": {
            "type": "string"
          },
          "MetadataIconsEnabled": {
            "type": "boolean"
          },
          "NativePosterTagsEnabled": {
            "type": "boolean"
          },
          "PauseScreenDelaySeconds": {
            "type": "integer"
          },
          "PauseScreenEnabled": {
            "type": "boolean"
          },
          "PeopleTagsEnabled": {
            "type": "boolean"
          },
          "PluginIconsEnabled": {
            "type": "boolean"
          },
          "QualityAudioDisplayMode": {
            "type": "string"
          },
          "QualityHdrDisplayMode": {
            "type": "string"
          },
          "QualityHideSdr": {
            "type": "boolean"
          },
          "QualityMinimumResolution": {
            "type": "string"
          },
          "QualityTagsAudioLanguageFromUser": {
            "type": "boolean"
          },
          "QualityTagsEnabled": {
            "type": "boolean"
          },
          "QualityTagsPosition": {
            "type": "string"
          },
          "QualityTagsPreferredAudioLanguage": {
            "type": "string"
          },
          "QualityVideoCodecDisplayMode": {
            "type": "string"
          },
          "RandomButtonEnabled": {
            "type": "boolean"
          },
          "RandomIncludeMovies": {
            "type": "boolean"
          },
          "RandomIncludeShows": {
            "type": "boolean"
          },
          "RandomScopeCurrentContainer": {
            "type": "boolean"
          },
          "RandomUnwatchedOnly": {
            "type": "boolean"
          },
          "RatingTagsColorByScore": {
            "type": "boolean"
          },
          "RatingTagsEnabled": {
            "type": "boolean"
          },
          "RatingTagsMinScore": {
            "type": "number"
          },
          "RatingTagsOnContinueWatching": {
            "type": "boolean"
          },
          "RatingTagsOnEpisodes": {
            "type": "boolean"
          },
          "RatingTagsOnMovies": {
            "type": "boolean"
          },
          "RatingTagsOnNextUp": {
            "type": "boolean"
          },
          "RatingTagsOnSeasons": {
            "type": "boolean"
          },
          "RatingTagsOnSeries": {
            "type": "boolean"
          },
          "RatingTagsPosition": {
            "type": "string"
          },
          "RatingTagsShowCommunity": {
            "type": "boolean"
          },
          "RatingTagsShowCritic": {
            "type": "boolean"
          },
          "RatingTagsSources": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "RecommendationsPageEnabled": {
            "type": "boolean"
          },
          "RecommendationsUseCustomTabs": {
            "type": "boolean"
          },
          "RecommendationsUseNativeTab": {
            "type": "boolean"
          },
          "RemoveContinueWatchingEnabled": {
            "type": "boolean"
          },
          "ResolutionTagOrder": {
            "type": "integer"
          },
          "ReviewTranslationEnabled": {
            "type": "boolean"
          },
          "ReviewTranslationServer": {
            "type": "boolean"
          },
          "ReviewsExpandedByDefault": {
            "type": "boolean"
          },
          "RuntimeTagOrder": {
            "type": "integer"
          },
          "SeriesQualityAggregation": {
            "type": "string"
          },
          "ShokoConfigured": {
            "type": "boolean"
          },
          "Shortcuts": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/Shortcut"
            }
          },
          "ShowAnilistReviews": {
            "type": "boolean"
          },
          "ShowArrLinksAsText": {
            "type": "boolean"
          },
          "ShowAspectRatioTag": {
            "type": "boolean"
          },
          "ShowAudioInfoTag": {
            "type": "boolean"
          },
          "ShowAudioLanguages": {
            "type": "boolean"
          },
          "ShowAwards": {
            "type": "boolean"
          },
          "ShowCollectionsInSearch": {
            "type": "boolean"
          },
          "ShowDownloadsInRequests": {
            "type": "boolean"
          },
          "ShowDynamicRangeTag": {
            "type": "boolean"
          },
          "ShowEditionTag": {
            "type": "boolean"
          },
          "ShowElsewhereOnJellyseerr": {
            "type": "boolean"
          },
          "ShowFileSizes": {
            "type": "boolean"
          },
          "ShowFrameRateTag": {
            "type": "boolean"
          },
          "ShowLetterboxdLinkAsText": {
            "type": "boolean"
          },
          "ShowLowQualitySourceTag": {
            "type": "boolean"
          },
          "ShowPlaybackRatingBadge": {
            "type": "boolean"
          },
          "ShowRatingInPlayer": {
            "type": "boolean"
          },
          "ShowReleaseDates": {
            "type": "boolean"
          },
          "ShowResolutionTag": {
            "type": "boolean"
          },
          "ShowReviews": {
            "type": "boolean"
          },
          "ShowRuntimeTag": {
            "type": "boolean"
          },
          "ShowSourceTag": {
            "type": "boolean"
          },
          "ShowSpecialFormatTag": {
            "type": "boolean"
          },
          "ShowUserRatingDash": {
            "type": "boolean"
          },
          "ShowUserRatingOnPosters": {
            "type": "boolean"
          },
          "ShowUserReviews": {
            "type": "boolean"
          },
          "ShowVersionsTag": {
            "type": "boolean"
          },
          "ShowVideoCodecTag": {
            "type": "boolean"
          },
          "ShowWatchProgress": {
            "type": "boolean"
          },
          "SourceTagOrder": {
            "type": "integer"
          },
          "SpecialFormatTagOrder": {
            "type": "integer"
          },
          "SplashScreenImageUrl": {
            "type": "string"
          },
          "SpoilerAdvancedMode": {
            "type": "boolean"
          },
          "SpoilerBlurEnabled": {
            "type": "boolean"
          },
          "SpoilerBlurIntensity": {
            "type": "integer"
          },
          "SpoilerBlurStrictRefresh": {
            "type": "boolean"
          },
          "SpoilerBlurTrickplay": {
            "type": "boolean"
          },
          "SpoilerReplaceTitle": {
            "type": "boolean"
          },
          "SpoilerStripCast": {
            "type": "boolean"
          },
          "SpoilerStripChapters": {
            "type": "boolean"
          },
          "SpoilerStripOverview": {
            "type": "boolean"
          },
          "SpoilerStripPremiereDate": {
            "type": "boolean"
          },
          "SpoilerStripRatings": {
            "type": "boolean"
          },
          "SpoilerStripReviews": {
            "type": "boolean"
          },
          "SpoilerStripSeriesOverview": {
            "type": "boolean"
          },
          "SpoilerStripTaglines": {
            "type": "boolean"
          },
          "SpoilerStripTags": {
            "type": "boolean"
          },
          "StatusTagsDirectPlay": {
            "type": "boolean"
          },
          "StatusTagsEnabled": {
            "type": "boolean"
          },
          "StatusTagsJustAdded": {
            "type": "boolean"
          },
          "StatusTagsJustAddedDays": {
            "type": "integer"
          },
          "StatusTagsLeaving": {
            "type": "boolean"
          },
          "StatusTagsMilestones": {
            "type": "boolean"
          },
          "StatusTagsNewRelease": {
            "type": "boolean"
          },
          "StatusTagsNewReleaseDays": {
            "type": "integer"
          },
          "StatusTagsPosition": {
            "type": "string"
          },
          "StatusTagsScenes": {
            "type": "boolean"
          },
          "StatusTagsSchedule": {
            "type": "boolean"
          },
          "StatusTagsSeriesStatus": {
            "type": "boolean"
          },
          "StatusTagsTrending": {
            "type": "boolean"
          },
          "SyncJellyseerrWatchlist": {
            "type": "boolean"
          },
          "TagCacheServerMode": {
            "type": "boolean"
          },
          "TagEdgeSpacing": {
            "type": "string"
          },
          "TagGap": {
            "type": "string"
          },
          "TagGroupCaps": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagGroupCaps"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagGroupOrder": {
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "TagGroupScopes": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagGroupScopes"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagLabelDensity": {
            "type": "string"
          },
          "TagLayout": {
            "type": "string"
          },
          "TagLayouts": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagLayoutProfiles"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagLookItemOverrides": {
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/TagLookItemOverride"
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "TagLookRules": {
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/TagLookRule"
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "TagScale": {
            "type": "string"
          },
          "TagShapeOverrides": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagShapeOverrides"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagStylePreset": {
            "type": "string"
          },
          "TagStyleWebActive": {
            "type": "boolean"
          },
          "TagStylesAllowUserPreset": {
            "type": "boolean"
          },
          "TagsCacheTtlDays": {
            "type": "integer"
          },
          "TagsHideOnHover": {
            "type": "boolean"
          },
          "ThemeSelectorEnabled": {
            "type": "boolean"
          },
          "TmdbEnabled": {
            "type": "boolean"
          },
          "ToastDuration": {
            "type": "integer"
          },
          "UseIcons": {
            "type": "boolean"
          },
          "VersionsTagOrder": {
            "type": "integer"
          },
          "VideoCodecTagOrder": {
            "type": "integer"
          },
          "WatchProgressDefaultMode": {
            "type": "string"
          },
          "WatchProgressTimeFormat": {
            "type": "string"
          }
        },
        "required": [
          "ActiveStreamsAllUsers",
          "ActiveStreamsEnabled",
          "ActivityFeedEnabled",
          "ActivityFeedShowActiveStreams",
          "ActivityFeedShowFavorited",
          "ActivityFeedShowReviewed",
          "ActivityFeedShowWatched",
          "ActivityFeedUseCustomTabs",
          "ActivityFeedUseNativeTab",
          "AddRequestedMediaToWatchlist",
          "AgeRatingTagsEnabled",
          "AgeRatingTagsPosition",
          "AnalyticsEnabled",
          "AnalyticsShareUsageCounts",
          "ArrLinksEnabled",
          "ArrLinksShowStatusSingle",
          "ArrTagsLinksFilter",
          "ArrTagsLinksHideFilter",
          "ArrTagsPrefix",
          "ArrTagsShowAsLinks",
          "ArrTagsSyncEnabled",
          "AspectRatioTagOrder",
          "AudioInfoTagOrder",
          "AudioLanguageTagPrefix",
          "AudioLanguageTagShowAsLinks",
          "AudioLanguageTagSyncEnabled",
          "AutoPauseEnabled",
          "AutoPipEnabled",
          "AutoResumeEnabled",
          "AutoSkipIntro",
          "AutoSkipOutro",
          "AwardsTagsCertifiedFresh",
          "AwardsTagsEmmy",
          "AwardsTagsEnabled",
          "AwardsTagsImdb",
          "AwardsTagsLetterboxd",
          "AwardsTagsOscar",
          "AwardsTagsPosition",
          "BookmarksEnabled",
          "BookmarksUseCustomTabs",
          "BookmarksUseNativeTab",
          "BookmarksUsePluginPages",
          "CalendarFilterByLibraryAccess",
          "CalendarFirstDayOfWeek",
          "CalendarForceOnlyRequested",
          "CalendarHighlightFavorites",
          "CalendarHighlightWatchedSeries",
          "CalendarPageEnabled",
          "CalendarShowOnlyRequested",
          "CalendarTimeFormat",
          "CalendarUseCustomTabs",
          "CalendarUseNativeTab",
          "CalendarUsePluginPages",
          "CatchUpEnabled",
          "CatchUpUseCustomTabs",
          "CatchUpUseNativeTab",
          "CatchUpUsePluginPages",
          "ClearLocalStorageTimestamp",
          "ClearTranslationCacheTimestamp",
          "ColoredActivityIconsEnabled",
          "ColoredRatingsEnabled",
          "CustomTagRules",
          "CustomTagsEnabled",
          "CustomTagsPosition",
          "DEFAULT_PROVIDERS",
          "DEFAULT_REGION",
          "DefaultLanguage",
          "DefaultSubtitleFont",
          "DefaultSubtitleSize",
          "DefaultSubtitleStyle",
          "DefaultSubtitleTextEffect",
          "DisableAllShortcuts",
          "DisableCustomSubtitleStyles",
          "DisableTagsOnSearchPage",
          "DoesTheDogDieEnabled",
          "DownloadsFilterByUserRequests",
          "DownloadsHistoryAdminOnly",
          "DownloadsPageEnabled",
          "DownloadsPagePollingEnabled",
          "DownloadsPageShowIssues",
          "DownloadsPollIntervalSeconds",
          "DownloadsShowHistory",
          "DownloadsUseCustomTabs",
          "DownloadsUseNativeTab",
          "DownloadsUsePluginPages",
          "DynamicRangeTagOrder",
          "EditionTagOrder",
          "ElsewhereCustomBrandingImageUrl",
          "ElsewhereCustomBrandingText",
          "ElsewhereEnabled",
          "ElsewhereSeasonProviders",
          "EnableCustomSplashScreen",
          "EnableLoginImage",
          "EnableTagsLocalStorageFallback",
          "FrameRateTagOrder",
          "GenreTagsEnabled",
          "GenreTagsPosition",
          "HelpPanelAutocloseDelay",
          "HiddenContentAdmin",
          "HiddenContentEnabled",
          "HiddenContentUseCustomTabs",
          "HiddenContentUseNativeTab",
          "HiddenContentUsePluginPages",
          "HideReviewsFromDisabledUsers",
          "HideReviewsFromHiddenUsers",
          "IGNORE_PROVIDERS",
          "IconStyle",
          "JellyseerrAutoImportUsers",
          "JellyseerrAvailablePosterLinksToJellyfin",
          "JellyseerrBaseUrl",
          "JellyseerrDisableCache",
          "JellyseerrEnable4KRequests",
          "JellyseerrEnable4KTvRequests",
          "JellyseerrEnabled",
          "JellyseerrExcludeBlocklistedItems",
          "JellyseerrExcludeLibraryItems",
          "JellyseerrSearchExcludeLibraryItems",
          "JellyseerrShowAdvanced",
          "JellyseerrShowCollectionDiscovery",
          "JellyseerrShowDetailPageLink",
          "JellyseerrShowDetailPageLinkAsText",
          "JellyseerrShowGenreDiscovery",
          "JellyseerrShowIssueIndicator",
          "JellyseerrShowNetworkDiscovery",
          "JellyseerrShowPersonDiscovery",
          "JellyseerrShowQuotaInfo",
          "JellyseerrShowRecommended",
          "JellyseerrShowReportButton",
          "JellyseerrShowRequestMoreOnSeries",
          "JellyseerrShowSearchResults",
          "JellyseerrShowSimilar",
          "JellyseerrShowTagDiscovery",
          "JellyseerrSingleSeasonRequestOnly",
          "JellyseerrUrlMappings",
          "JellyseerrUseMoreInfoModal",
          "LanguageTagsCountBadge",
          "LanguageTagsEnabled",
          "LanguageTagsMergeRegions",
          "LanguageTagsPosition",
          "LanguageTagsPriority",
          "LanguageTagsPriorityStrict",
          "LanguageTagsShowAudio",
          "LanguageTagsShowSubtitles",
          "LanguageTagsStyle",
          "LeavingSoonAvailable",
          "LetterboxdEnabled",
          "LogoTagsEnabled",
          "LogoTagsMaxLogos",
          "LogoTagsMovieMode",
          "LogoTagsPosition",
          "LogoTagsSeriesMode",
          "LongPress2xEnabled",
          "MaintenanceModeAction",
          "MaintenanceModeAffectedUsers",
          "MaintenanceModeEnabled",
          "MaintenanceModeEndsAt",
          "MaintenanceModeMessage",
          "MdblistEnabled",
          "MdblistRatingsEnabled",
          "MdblistRatingsShowOnItemDetails",
          "MdblistRatingsShowPercentSymbol",
          "MdblistRatingsSources",
          "MetadataIconsEnabled",
          "NativePosterTagsEnabled",
          "PauseScreenDelaySeconds",
          "PauseScreenEnabled",
          "PeopleTagsEnabled",
          "PluginIconsEnabled",
          "QualityAudioDisplayMode",
          "QualityHdrDisplayMode",
          "QualityHideSdr",
          "QualityMinimumResolution",
          "QualityTagsAudioLanguageFromUser",
          "QualityTagsEnabled",
          "QualityTagsPosition",
          "QualityTagsPreferredAudioLanguage",
          "QualityVideoCodecDisplayMode",
          "RandomButtonEnabled",
          "RandomIncludeMovies",
          "RandomIncludeShows",
          "RandomScopeCurrentContainer",
          "RandomUnwatchedOnly",
          "RatingTagsColorByScore",
          "RatingTagsEnabled",
          "RatingTagsMinScore",
          "RatingTagsOnContinueWatching",
          "RatingTagsOnEpisodes",
          "RatingTagsOnMovies",
          "RatingTagsOnNextUp",
          "RatingTagsOnSeasons",
          "RatingTagsOnSeries",
          "RatingTagsPosition",
          "RatingTagsShowCommunity",
          "RatingTagsShowCritic",
          "RatingTagsSources",
          "RecommendationsPageEnabled",
          "RecommendationsUseCustomTabs",
          "RecommendationsUseNativeTab",
          "RemoveContinueWatchingEnabled",
          "ResolutionTagOrder",
          "ReviewTranslationEnabled",
          "ReviewTranslationServer",
          "ReviewsExpandedByDefault",
          "RuntimeTagOrder",
          "SeriesQualityAggregation",
          "ShokoConfigured",
          "Shortcuts",
          "ShowAnilistReviews",
          "ShowArrLinksAsText",
          "ShowAspectRatioTag",
          "ShowAudioInfoTag",
          "ShowAudioLanguages",
          "ShowAwards",
          "ShowCollectionsInSearch",
          "ShowDownloadsInRequests",
          "ShowDynamicRangeTag",
          "ShowEditionTag",
          "ShowElsewhereOnJellyseerr",
          "ShowFileSizes",
          "ShowFrameRateTag",
          "ShowLetterboxdLinkAsText",
          "ShowLowQualitySourceTag",
          "ShowPlaybackRatingBadge",
          "ShowRatingInPlayer",
          "ShowReleaseDates",
          "ShowResolutionTag",
          "ShowReviews",
          "ShowRuntimeTag",
          "ShowSourceTag",
          "ShowSpecialFormatTag",
          "ShowUserRatingDash",
          "ShowUserRatingOnPosters",
          "ShowUserReviews",
          "ShowVersionsTag",
          "ShowVideoCodecTag",
          "ShowWatchProgress",
          "SourceTagOrder",
          "SpecialFormatTagOrder",
          "SplashScreenImageUrl",
          "SpoilerAdvancedMode",
          "SpoilerBlurEnabled",
          "SpoilerBlurIntensity",
          "SpoilerBlurStrictRefresh",
          "SpoilerBlurTrickplay",
          "SpoilerReplaceTitle",
          "SpoilerStripCast",
          "SpoilerStripChapters",
          "SpoilerStripOverview",
          "SpoilerStripPremiereDate",
          "SpoilerStripRatings",
          "SpoilerStripReviews",
          "SpoilerStripSeriesOverview",
          "SpoilerStripTaglines",
          "SpoilerStripTags",
          "StatusTagsDirectPlay",
          "StatusTagsEnabled",
          "StatusTagsJustAdded",
          "StatusTagsJustAddedDays",
          "StatusTagsLeaving",
          "StatusTagsMilestones",
          "StatusTagsNewRelease",
          "StatusTagsNewReleaseDays",
          "StatusTagsPosition",
          "StatusTagsScenes",
          "StatusTagsSchedule",
          "StatusTagsSeriesStatus",
          "StatusTagsTrending",
          "SyncJellyseerrWatchlist",
          "TagCacheServerMode",
          "TagEdgeSpacing",
          "TagGap",
          "TagGroupCaps",
          "TagGroupOrder",
          "TagGroupScopes",
          "TagLabelDensity",
          "TagLayout",
          "TagLayouts",
          "TagLookItemOverrides",
          "TagLookRules",
          "TagScale",
          "TagShapeOverrides",
          "TagStylePreset",
          "TagStyleWebActive",
          "TagStylesAllowUserPreset",
          "TagsCacheTtlDays",
          "TagsHideOnHover",
          "ThemeSelectorEnabled",
          "TmdbEnabled",
          "ToastDuration",
          "UseIcons",
          "VersionsTagOrder",
          "VideoCodecTagOrder",
          "WatchProgressDefaultMode",
          "WatchProgressTimeFormat"
        ],
        "additionalProperties": false
      },
      "BookmarkItem": {
        "type": "object",
        "properties": {
          "CreatedAt": {
            "type": "string"
          },
          "EpisodeNumber": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "ItemId": {
            "type": "string"
          },
          "Label": {
            "type": "string"
          },
          "MediaType": {
            "type": "string"
          },
          "Name": {
            "type": "string"
          },
          "SeasonNumber": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "SyncedFrom": {
            "type": "string"
          },
          "Timestamp": {
            "type": "number"
          },
          "TmdbId": {
            "type": "string"
          },
          "TvdbId": {
            "type": "string"
          },
          "UpdatedAt": {
            "type": "string"
          }
        },
        "required": [
          "CreatedAt",
          "EpisodeNumber",
          "ItemId",
          "Label",
          "MediaType",
          "Name",
          "SeasonNumber",
          "SyncedFrom",
          "Timestamp",
          "TmdbId",
          "TvdbId",
          "UpdatedAt"
        ],
        "additionalProperties": false
      },
      "UserBookmark": {
        "type": "object",
        "properties": {
          "Bookmarks": {
            "type": "object",
            "additionalProperties": {
              "$ref": "#/$defs/BookmarkItem"
            }
          }
        },
        "required": [
          "Bookmarks"
        ],
        "additionalProperties": false
      },
      "BookmarkDocumentResponse": {
        "type": "object",
        "properties": {
          "Document": {
            "type": "string"
          },
          "Revision": {
            "type": "string"
          }
        },
        "required": [
          "Document",
          "Revision"
        ],
        "additionalProperties": false
      },
      "ElsewhereSettings": {
        "type": "object",
        "properties": {
          "Region": {
            "type": "string"
          },
          "Regions": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "SeasonProviders": {
            "type": "boolean"
          },
          "Services": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "Region",
          "Regions",
          "SeasonProviders",
          "Services"
        ],
        "additionalProperties": false
      },
      "HiddenContentItem": {
        "type": "object",
        "properties": {
          "EpisodeNumber": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "HiddenAt": {
            "type": "string"
          },
          "HideScope": {
            "type": "string"
          },
          "ItemId": {
            "type": "string"
          },
          "Name": {
            "type": "string"
          },
          "PosterPath": {
            "type": "string"
          },
          "SeasonNumber": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "SeriesId": {
            "type": "string"
          },
          "SeriesName": {
            "type": "string"
          },
          "TmdbId": {
            "type": "string"
          },
          "Type": {
            "type": "string"
          }
        },
        "required": [
          "EpisodeNumber",
          "HiddenAt",
          "HideScope",
          "ItemId",
          "Name",
          "PosterPath",
          "SeasonNumber",
          "SeriesId",
          "SeriesName",
          "TmdbId",
          "Type"
        ],
        "additionalProperties": false
      },
      "HiddenContentSettings": {
        "type": "object",
        "properties": {
          "Enabled": {
            "type": "boolean"
          },
          "ExperimentalHideCollections": {
            "type": "boolean"
          },
          "FilterCalendar": {
            "type": "boolean"
          },
          "FilterContinueWatching": {
            "type": "boolean"
          },
          "FilterDiscovery": {
            "type": "boolean"
          },
          "FilterLibrary": {
            "type": "boolean"
          },
          "FilterNextUp": {
            "type": "boolean"
          },
          "FilterRecommendations": {
            "type": "boolean"
          },
          "FilterRequests": {
            "type": "boolean"
          },
          "FilterSearch": {
            "type": "boolean"
          },
          "FilterUpcoming": {
            "type": "boolean"
          },
          "ShowButtonCast": {
            "type": "boolean"
          },
          "ShowButtonDetails": {
            "type": "boolean"
          },
          "ShowButtonJellyseerr": {
            "type": "boolean"
          },
          "ShowButtonLibrary": {
            "type": "boolean"
          },
          "ShowHideButtons": {
            "type": "boolean"
          },
          "ShowHideConfirmation": {
            "type": "boolean"
          }
        },
        "required": [
          "Enabled",
          "ExperimentalHideCollections",
          "FilterCalendar",
          "FilterContinueWatching",
          "FilterDiscovery",
          "FilterLibrary",
          "FilterNextUp",
          "FilterRecommendations",
          "FilterRequests",
          "FilterSearch",
          "FilterUpcoming",
          "ShowButtonCast",
          "ShowButtonDetails",
          "ShowButtonJellyseerr",
          "ShowButtonLibrary",
          "ShowHideButtons",
          "ShowHideConfirmation"
        ],
        "additionalProperties": false
      },
      "UserHiddenContent": {
        "type": "object",
        "properties": {
          "Items": {
            "type": "object",
            "additionalProperties": {
              "$ref": "#/$defs/HiddenContentItem"
            }
          },
          "Settings": {
            "$ref": "#/$defs/HiddenContentSettings"
          }
        },
        "required": [
          "Items",
          "Settings"
        ],
        "additionalProperties": false
      },
      "TagLayoutLock": {
        "type": "object",
        "properties": {
          "Caps": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagGroupCaps"
              },
              {
                "type": "null"
              }
            ]
          },
          "ColourPreset": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "Density": {
            "type": "string"
          },
          "EdgeSpacing": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "Layout": {
            "type": "string"
          },
          "LockedAt": {
            "type": "integer"
          },
          "Scope": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "Shapes": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagShapeOverrides"
              },
              {
                "type": "null"
              }
            ]
          },
          "Slots": {
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/TagLayoutGroupSlot"
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "TagGap": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagScale": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "Caps",
          "ColourPreset",
          "Density",
          "EdgeSpacing",
          "Layout",
          "LockedAt",
          "Scope",
          "Shapes",
          "Slots",
          "TagGap",
          "TagScale"
        ],
        "additionalProperties": false
      },
      "BootstrapSettings": {
        "type": "object",
        "properties": {
          "AgeRatingTagsEnabled": {
            "type": "boolean"
          },
          "AgeRatingTagsPosition": {
            "type": "string"
          },
          "AspectRatioTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "AudioInfoTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "AutoPauseEnabled": {
            "type": "boolean"
          },
          "AutoPipEnabled": {
            "type": "boolean"
          },
          "AutoResumeEnabled": {
            "type": "boolean"
          },
          "AutoSkipIntro": {
            "type": "boolean"
          },
          "AutoSkipOutro": {
            "type": "boolean"
          },
          "AwardsTagsEnabled": {
            "type": "boolean"
          },
          "AwardsTagsPosition": {
            "type": "string"
          },
          "CalendarDefaultViewMode": {
            "type": "string"
          },
          "CalendarDisplayMode": {
            "type": "string"
          },
          "CustomSubtitleBgColor": {
            "type": "string"
          },
          "CustomSubtitleTextColor": {
            "type": "string"
          },
          "CustomTagsEnabled": {
            "type": "boolean"
          },
          "CustomTagsPosition": {
            "type": "string"
          },
          "DisableCustomSubtitleStyles": {
            "type": "boolean"
          },
          "DisplayLanguage": {
            "type": "string"
          },
          "DynamicRangeTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "EditionTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "FrameRateTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "GenreTagsEnabled": {
            "type": "boolean"
          },
          "GenreTagsPosition": {
            "type": "string"
          },
          "IsAdmin": {
            "type": "boolean"
          },
          "LanguageTagsCountBadge": {
            "type": "string"
          },
          "LanguageTagsEnabled": {
            "type": "boolean"
          },
          "LanguageTagsPosition": {
            "type": "string"
          },
          "LanguageTagsPriority": {
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "LanguageTagsPriorityStrict": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "LanguageTagsShowAudio": {
            "type": "boolean"
          },
          "LanguageTagsShowSubtitles": {
            "type": "boolean"
          },
          "LanguageTagsStyle": {
            "type": "string"
          },
          "LastOpenedTab": {
            "type": "string"
          },
          "LogoTagsEnabled": {
            "type": "boolean"
          },
          "LogoTagsPosition": {
            "type": "string"
          },
          "LongPress2xEnabled": {
            "type": "boolean"
          },
          "NativePosterDateLocale": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "NativePosterTimeZone": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "PauseScreenDelaySeconds": {
            "type": "integer"
          },
          "PauseScreenEnabled": {
            "type": "boolean"
          },
          "PeopleTagsEnabled": {
            "type": "boolean"
          },
          "QualityAudioDisplayMode": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "QualityHdrDisplayMode": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "QualityHideSdr": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "QualityMinimumResolution": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "QualityTagsEnabled": {
            "type": "boolean"
          },
          "QualityTagsPosition": {
            "type": "string"
          },
          "QualityTagsPreferredAudioLanguage": {
            "type": "string"
          },
          "QualityVideoCodecDisplayMode": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "RandomButtonEnabled": {
            "type": "boolean"
          },
          "RandomIncludeMovies": {
            "type": "boolean"
          },
          "RandomIncludeShows": {
            "type": "boolean"
          },
          "RandomScopeCurrentContainer": {
            "type": "boolean"
          },
          "RandomSourceId": {
            "type": "string"
          },
          "RandomUnwatchedOnly": {
            "type": "boolean"
          },
          "RatingTagsColorByScore": {
            "type": "boolean"
          },
          "RatingTagsEnabled": {
            "type": "boolean"
          },
          "RatingTagsMinScore": {
            "type": "number"
          },
          "RatingTagsOnContinueWatching": {
            "type": "boolean"
          },
          "RatingTagsOnEpisodes": {
            "type": "boolean"
          },
          "RatingTagsOnMovies": {
            "type": "boolean"
          },
          "RatingTagsOnNextUp": {
            "type": "boolean"
          },
          "RatingTagsOnSeasons": {
            "type": "boolean"
          },
          "RatingTagsOnSeries": {
            "type": "boolean"
          },
          "RatingTagsPosition": {
            "type": "string"
          },
          "RatingTagsShowCommunity": {
            "type": "boolean"
          },
          "RatingTagsShowCritic": {
            "type": "boolean"
          },
          "RatingTagsSources": {
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "RemoveContinueWatchingEnabled": {
            "type": "boolean"
          },
          "ResolutionTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "ReviewsExpandedByDefault": {
            "type": "boolean"
          },
          "RuntimeTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "SelectedFontFamilyPresetIndex": {
            "type": "integer"
          },
          "SelectedFontSizePresetIndex": {
            "type": "integer"
          },
          "SelectedStylePresetIndex": {
            "type": "integer"
          },
          "SelectedTextEffectPresetIndex": {
            "type": "integer"
          },
          "SeriesQualityAggregation": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "ShowAspectRatioTag": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "ShowAudioInfoTag": {
            "type": "boolean"
          },
          "ShowAudioLanguages": {
            "type": "boolean"
          },
          "ShowDynamicRangeTag": {
            "type": "boolean"
          },
          "ShowEditionTag": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "ShowFileSizes": {
            "type": "boolean"
          },
          "ShowFrameRateTag": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "ShowLowQualitySourceTag": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "ShowRatingInPlayer": {
            "type": "boolean"
          },
          "ShowResolutionTag": {
            "type": "boolean"
          },
          "ShowRuntimeTag": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "ShowSourceTag": {
            "type": "boolean"
          },
          "ShowSpecialFormatTag": {
            "type": "boolean"
          },
          "ShowVersionsTag": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "ShowVideoCodecTag": {
            "type": "boolean"
          },
          "ShowWatchProgress": {
            "type": "boolean"
          },
          "SourceTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "SpecialFormatTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "StatusTagsDirectPlay": {
            "type": "boolean"
          },
          "StatusTagsEnabled": {
            "type": "boolean"
          },
          "StatusTagsJustAdded": {
            "type": "boolean"
          },
          "StatusTagsLeaving": {
            "type": "boolean"
          },
          "StatusTagsMilestones": {
            "type": "boolean"
          },
          "StatusTagsNewRelease": {
            "type": "boolean"
          },
          "StatusTagsPosition": {
            "type": "string"
          },
          "StatusTagsScenes": {
            "type": "boolean"
          },
          "StatusTagsSchedule": {
            "type": "boolean"
          },
          "StatusTagsSeriesStatus": {
            "type": "boolean"
          },
          "StatusTagsTrending": {
            "type": "boolean"
          },
          "SubtitleHorizontalPosition": {
            "type": "integer"
          },
          "SubtitleVerticalPosition": {
            "type": "integer"
          },
          "TagEdgeSpacing": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagGap": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagGroupCaps": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagGroupCaps"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagGroupOrder": {
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "TagGroupScopes": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagGroupScopes"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagLabelDensity": {
            "type": "string"
          },
          "TagLayout": {
            "type": "string"
          },
          "TagLayoutLocks": {
            "anyOf": [
              {
                "type": "object",
                "additionalProperties": {
                  "$ref": "#/$defs/TagLayoutLock"
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "TagLayoutSettingsVersion": {
            "type": "integer"
          },
          "TagLayouts": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagLayoutProfiles"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagLookRules": {
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/TagLookRule"
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "TagScale": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagShapeOverrides": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagShapeOverrides"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagStylePreset": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagsHideOnHover": {
            "type": "boolean"
          },
          "UseNativePosterTags": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "UsingCustomColors": {
            "type": "boolean"
          },
          "VersionsTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "VideoCodecTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "WatchProgressMode": {
            "type": "string"
          },
          "WatchProgressTimeFormat": {
            "type": "string"
          }
        },
        "required": [
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
          "CalendarDefaultViewMode",
          "CalendarDisplayMode",
          "CustomSubtitleBgColor",
          "CustomSubtitleTextColor",
          "CustomTagsEnabled",
          "CustomTagsPosition",
          "DisableCustomSubtitleStyles",
          "DisplayLanguage",
          "DynamicRangeTagOrder",
          "EditionTagOrder",
          "FrameRateTagOrder",
          "GenreTagsEnabled",
          "GenreTagsPosition",
          "IsAdmin",
          "LanguageTagsCountBadge",
          "LanguageTagsEnabled",
          "LanguageTagsPosition",
          "LanguageTagsPriority",
          "LanguageTagsPriorityStrict",
          "LanguageTagsShowAudio",
          "LanguageTagsShowSubtitles",
          "LanguageTagsStyle",
          "LastOpenedTab",
          "LogoTagsEnabled",
          "LogoTagsPosition",
          "LongPress2xEnabled",
          "NativePosterDateLocale",
          "NativePosterTimeZone",
          "PauseScreenDelaySeconds",
          "PauseScreenEnabled",
          "PeopleTagsEnabled",
          "QualityAudioDisplayMode",
          "QualityHdrDisplayMode",
          "QualityHideSdr",
          "QualityMinimumResolution",
          "QualityTagsEnabled",
          "QualityTagsPosition",
          "QualityTagsPreferredAudioLanguage",
          "QualityVideoCodecDisplayMode",
          "RandomButtonEnabled",
          "RandomIncludeMovies",
          "RandomIncludeShows",
          "RandomScopeCurrentContainer",
          "RandomSourceId",
          "RandomUnwatchedOnly",
          "RatingTagsColorByScore",
          "RatingTagsEnabled",
          "RatingTagsMinScore",
          "RatingTagsOnContinueWatching",
          "RatingTagsOnEpisodes",
          "RatingTagsOnMovies",
          "RatingTagsOnNextUp",
          "RatingTagsOnSeasons",
          "RatingTagsOnSeries",
          "RatingTagsPosition",
          "RatingTagsShowCommunity",
          "RatingTagsShowCritic",
          "RatingTagsSources",
          "RemoveContinueWatchingEnabled",
          "ResolutionTagOrder",
          "ReviewsExpandedByDefault",
          "RuntimeTagOrder",
          "SelectedFontFamilyPresetIndex",
          "SelectedFontSizePresetIndex",
          "SelectedStylePresetIndex",
          "SelectedTextEffectPresetIndex",
          "SeriesQualityAggregation",
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
          "SubtitleHorizontalPosition",
          "SubtitleVerticalPosition",
          "TagEdgeSpacing",
          "TagGap",
          "TagGroupCaps",
          "TagGroupOrder",
          "TagGroupScopes",
          "TagLabelDensity",
          "TagLayout",
          "TagLayoutLocks",
          "TagLayoutSettingsVersion",
          "TagLayouts",
          "TagLookRules",
          "TagScale",
          "TagShapeOverrides",
          "TagStylePreset",
          "TagsHideOnHover",
          "UseNativePosterTags",
          "UsingCustomColors",
          "VersionsTagOrder",
          "VideoCodecTagOrder",
          "WatchProgressMode",
          "WatchProgressTimeFormat"
        ],
        "additionalProperties": false
      },
      "UserShortcuts": {
        "type": "object",
        "properties": {
          "Shortcuts": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/Shortcut"
            }
          }
        },
        "required": [
          "Shortcuts"
        ],
        "additionalProperties": false
      },
      "BootstrapUserDocuments": {
        "type": "object",
        "properties": {
          "Bookmark": {
            "anyOf": [
              {
                "$ref": "#/$defs/UserBookmark"
              },
              {
                "type": "null"
              }
            ]
          },
          "BookmarkSnapshot": {
            "anyOf": [
              {
                "$ref": "#/$defs/BookmarkDocumentResponse"
              },
              {
                "type": "null"
              }
            ]
          },
          "Elsewhere": {
            "anyOf": [
              {
                "$ref": "#/$defs/ElsewhereSettings"
              },
              {
                "type": "null"
              }
            ]
          },
          "HiddenContent": {
            "anyOf": [
              {
                "$ref": "#/$defs/UserHiddenContent"
              },
              {
                "type": "null"
              }
            ]
          },
          "Settings": {
            "anyOf": [
              {
                "$ref": "#/$defs/BootstrapSettings"
              },
              {
                "type": "null"
              }
            ]
          },
          "SettingsRevision": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "Shortcuts": {
            "anyOf": [
              {
                "$ref": "#/$defs/UserShortcuts"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "Bookmark",
          "Elsewhere",
          "HiddenContent",
          "Settings",
          "SettingsRevision",
          "Shortcuts"
        ],
        "additionalProperties": false
      },
      "BootstrapResponse": {
        "type": "object",
        "properties": {
          "ComponentScripts": {
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "HasCustomTabs": {
            "type": "boolean"
          },
          "HasPluginPages": {
            "type": "boolean"
          },
          "Prefetched": {
            "$ref": "#/$defs/BootstrapPrefetched"
          },
          "PrivateConfig": {
            "anyOf": [
              {
                "$ref": "#/$defs/BootstrapPrivateConfig"
              },
              {
                "type": "null"
              }
            ]
          },
          "PublicConfig": {
            "$ref": "#/$defs/BootstrapPublicConfig"
          },
          "UserId": {
            "type": "string"
          },
          "UserSettings": {
            "$ref": "#/$defs/BootstrapUserDocuments"
          },
          "Version": {
            "type": "string"
          }
        },
        "required": [
          "ComponentScripts",
          "HasCustomTabs",
          "HasPluginPages",
          "Prefetched",
          "PrivateConfig",
          "PublicConfig",
          "UserId",
          "UserSettings",
          "Version"
        ],
        "additionalProperties": false
      },
      "RevisionedSettingsResponse": {
        "type": "object",
        "properties": {
          "Revision": {
            "type": "string"
          },
          "Settings": {
            "$ref": "#/$defs/BootstrapSettings"
          }
        },
        "required": [
          "Revision",
          "Settings"
        ],
        "additionalProperties": false
      },
      "JellyfinEnhancedUserSettings": {
        "type": "object",
        "properties": {
          "AgeRatingTagsEnabled": {
            "type": "boolean"
          },
          "AgeRatingTagsPosition": {
            "type": "string"
          },
          "AspectRatioTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "AudioInfoTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "AutoPauseEnabled": {
            "type": "boolean"
          },
          "AutoPipEnabled": {
            "type": "boolean"
          },
          "AutoResumeEnabled": {
            "type": "boolean"
          },
          "AutoSkipIntro": {
            "type": "boolean"
          },
          "AutoSkipOutro": {
            "type": "boolean"
          },
          "AwardsTagsEnabled": {
            "type": "boolean"
          },
          "AwardsTagsPosition": {
            "type": "string"
          },
          "CalendarDefaultViewMode": {
            "type": "string"
          },
          "CalendarDisplayMode": {
            "type": "string"
          },
          "CustomSubtitleBgColor": {
            "type": "string"
          },
          "CustomSubtitleTextColor": {
            "type": "string"
          },
          "CustomTagsEnabled": {
            "type": "boolean"
          },
          "CustomTagsPosition": {
            "type": "string"
          },
          "DisableCustomSubtitleStyles": {
            "type": "boolean"
          },
          "DisplayLanguage": {
            "type": "string"
          },
          "DynamicRangeTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "EditionTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "FrameRateTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "GenreTagsEnabled": {
            "type": "boolean"
          },
          "GenreTagsPosition": {
            "type": "string"
          },
          "LanguageTagsCountBadge": {
            "type": "string"
          },
          "LanguageTagsEnabled": {
            "type": "boolean"
          },
          "LanguageTagsPosition": {
            "type": "string"
          },
          "LanguageTagsPriority": {
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "LanguageTagsPriorityStrict": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "LanguageTagsShowAudio": {
            "type": "boolean"
          },
          "LanguageTagsShowSubtitles": {
            "type": "boolean"
          },
          "LanguageTagsStyle": {
            "type": "string"
          },
          "LastOpenedTab": {
            "type": "string"
          },
          "LogoTagsEnabled": {
            "type": "boolean"
          },
          "LogoTagsPosition": {
            "type": "string"
          },
          "LongPress2xEnabled": {
            "type": "boolean"
          },
          "NativePosterDateLocale": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "NativePosterTimeZone": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "PauseScreenDelaySeconds": {
            "type": "integer"
          },
          "PauseScreenEnabled": {
            "type": "boolean"
          },
          "PeopleTagsEnabled": {
            "type": "boolean"
          },
          "QualityAudioDisplayMode": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "QualityHdrDisplayMode": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "QualityHideSdr": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "QualityMinimumResolution": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "QualityTagsEnabled": {
            "type": "boolean"
          },
          "QualityTagsPosition": {
            "type": "string"
          },
          "QualityTagsPreferredAudioLanguage": {
            "type": "string"
          },
          "QualityVideoCodecDisplayMode": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "RandomButtonEnabled": {
            "type": "boolean"
          },
          "RandomIncludeMovies": {
            "type": "boolean"
          },
          "RandomIncludeShows": {
            "type": "boolean"
          },
          "RandomScopeCurrentContainer": {
            "type": "boolean"
          },
          "RandomSourceId": {
            "type": "string"
          },
          "RandomUnwatchedOnly": {
            "type": "boolean"
          },
          "RatingTagsColorByScore": {
            "type": "boolean"
          },
          "RatingTagsEnabled": {
            "type": "boolean"
          },
          "RatingTagsMinScore": {
            "type": "number"
          },
          "RatingTagsOnContinueWatching": {
            "type": "boolean"
          },
          "RatingTagsOnEpisodes": {
            "type": "boolean"
          },
          "RatingTagsOnMovies": {
            "type": "boolean"
          },
          "RatingTagsOnNextUp": {
            "type": "boolean"
          },
          "RatingTagsOnSeasons": {
            "type": "boolean"
          },
          "RatingTagsOnSeries": {
            "type": "boolean"
          },
          "RatingTagsPosition": {
            "type": "string"
          },
          "RatingTagsShowCommunity": {
            "type": "boolean"
          },
          "RatingTagsShowCritic": {
            "type": "boolean"
          },
          "RatingTagsSources": {
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "RemoveContinueWatchingEnabled": {
            "type": "boolean"
          },
          "ResolutionTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "ReviewsExpandedByDefault": {
            "type": "boolean"
          },
          "RuntimeTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "SelectedFontFamilyPresetIndex": {
            "type": "integer"
          },
          "SelectedFontSizePresetIndex": {
            "type": "integer"
          },
          "SelectedStylePresetIndex": {
            "type": "integer"
          },
          "SelectedTextEffectPresetIndex": {
            "type": "integer"
          },
          "SeriesQualityAggregation": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "ShowAspectRatioTag": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "ShowAudioInfoTag": {
            "type": "boolean"
          },
          "ShowAudioLanguages": {
            "type": "boolean"
          },
          "ShowDynamicRangeTag": {
            "type": "boolean"
          },
          "ShowEditionTag": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "ShowFileSizes": {
            "type": "boolean"
          },
          "ShowFrameRateTag": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "ShowLowQualitySourceTag": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "ShowRatingInPlayer": {
            "type": "boolean"
          },
          "ShowResolutionTag": {
            "type": "boolean"
          },
          "ShowRuntimeTag": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "ShowSourceTag": {
            "type": "boolean"
          },
          "ShowSpecialFormatTag": {
            "type": "boolean"
          },
          "ShowVersionsTag": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "ShowVideoCodecTag": {
            "type": "boolean"
          },
          "ShowWatchProgress": {
            "type": "boolean"
          },
          "SourceTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "SpecialFormatTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "StatusTagsDirectPlay": {
            "type": "boolean"
          },
          "StatusTagsEnabled": {
            "type": "boolean"
          },
          "StatusTagsJustAdded": {
            "type": "boolean"
          },
          "StatusTagsLeaving": {
            "type": "boolean"
          },
          "StatusTagsMilestones": {
            "type": "boolean"
          },
          "StatusTagsNewRelease": {
            "type": "boolean"
          },
          "StatusTagsPosition": {
            "type": "string"
          },
          "StatusTagsScenes": {
            "type": "boolean"
          },
          "StatusTagsSchedule": {
            "type": "boolean"
          },
          "StatusTagsSeriesStatus": {
            "type": "boolean"
          },
          "StatusTagsTrending": {
            "type": "boolean"
          },
          "SubtitleHorizontalPosition": {
            "type": "integer"
          },
          "SubtitleVerticalPosition": {
            "type": "integer"
          },
          "TagEdgeSpacing": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagGap": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagGroupCaps": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagGroupCaps"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagGroupOrder": {
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "TagGroupScopes": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagGroupScopes"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagLabelDensity": {
            "type": "string"
          },
          "TagLayout": {
            "type": "string"
          },
          "TagLayoutLocks": {
            "anyOf": [
              {
                "type": "object",
                "additionalProperties": {
                  "$ref": "#/$defs/TagLayoutLock"
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "TagLayoutSettingsVersion": {
            "type": "integer"
          },
          "TagLayouts": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagLayoutProfiles"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagLookRules": {
            "anyOf": [
              {
                "type": "array",
                "items": {
                  "$ref": "#/$defs/TagLookRule"
                }
              },
              {
                "type": "null"
              }
            ]
          },
          "TagScale": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagShapeOverrides": {
            "anyOf": [
              {
                "$ref": "#/$defs/TagShapeOverrides"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagStylePreset": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "TagsHideOnHover": {
            "type": "boolean"
          },
          "UseNativePosterTags": {
            "anyOf": [
              {
                "type": "boolean"
              },
              {
                "type": "null"
              }
            ]
          },
          "UsingCustomColors": {
            "type": "boolean"
          },
          "VersionsTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "VideoCodecTagOrder": {
            "anyOf": [
              {
                "type": "integer"
              },
              {
                "type": "null"
              }
            ]
          },
          "WatchProgressMode": {
            "type": "string"
          },
          "WatchProgressTimeFormat": {
            "type": "string"
          }
        },
        "required": [
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
          "CalendarDefaultViewMode",
          "CalendarDisplayMode",
          "CustomSubtitleBgColor",
          "CustomSubtitleTextColor",
          "CustomTagsEnabled",
          "CustomTagsPosition",
          "DisableCustomSubtitleStyles",
          "DisplayLanguage",
          "DynamicRangeTagOrder",
          "EditionTagOrder",
          "FrameRateTagOrder",
          "GenreTagsEnabled",
          "GenreTagsPosition",
          "LanguageTagsCountBadge",
          "LanguageTagsEnabled",
          "LanguageTagsPosition",
          "LanguageTagsPriority",
          "LanguageTagsPriorityStrict",
          "LanguageTagsShowAudio",
          "LanguageTagsShowSubtitles",
          "LanguageTagsStyle",
          "LastOpenedTab",
          "LogoTagsEnabled",
          "LogoTagsPosition",
          "LongPress2xEnabled",
          "NativePosterDateLocale",
          "NativePosterTimeZone",
          "PauseScreenDelaySeconds",
          "PauseScreenEnabled",
          "PeopleTagsEnabled",
          "QualityAudioDisplayMode",
          "QualityHdrDisplayMode",
          "QualityHideSdr",
          "QualityMinimumResolution",
          "QualityTagsEnabled",
          "QualityTagsPosition",
          "QualityTagsPreferredAudioLanguage",
          "QualityVideoCodecDisplayMode",
          "RandomButtonEnabled",
          "RandomIncludeMovies",
          "RandomIncludeShows",
          "RandomScopeCurrentContainer",
          "RandomSourceId",
          "RandomUnwatchedOnly",
          "RatingTagsColorByScore",
          "RatingTagsEnabled",
          "RatingTagsMinScore",
          "RatingTagsOnContinueWatching",
          "RatingTagsOnEpisodes",
          "RatingTagsOnMovies",
          "RatingTagsOnNextUp",
          "RatingTagsOnSeasons",
          "RatingTagsOnSeries",
          "RatingTagsPosition",
          "RatingTagsShowCommunity",
          "RatingTagsShowCritic",
          "RatingTagsSources",
          "RemoveContinueWatchingEnabled",
          "ResolutionTagOrder",
          "ReviewsExpandedByDefault",
          "RuntimeTagOrder",
          "SelectedFontFamilyPresetIndex",
          "SelectedFontSizePresetIndex",
          "SelectedStylePresetIndex",
          "SelectedTextEffectPresetIndex",
          "SeriesQualityAggregation",
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
          "SubtitleHorizontalPosition",
          "SubtitleVerticalPosition",
          "TagEdgeSpacing",
          "TagGap",
          "TagGroupCaps",
          "TagGroupOrder",
          "TagGroupScopes",
          "TagLabelDensity",
          "TagLayout",
          "TagLayoutLocks",
          "TagLayoutSettingsVersion",
          "TagLayouts",
          "TagLookRules",
          "TagScale",
          "TagShapeOverrides",
          "TagStylePreset",
          "TagsHideOnHover",
          "UseNativePosterTags",
          "UsingCustomColors",
          "VersionsTagOrder",
          "VideoCodecTagOrder",
          "WatchProgressMode",
          "WatchProgressTimeFormat"
        ],
        "additionalProperties": false
      },
      "RevisionedSettingsRequest": {
        "type": "object",
        "properties": {
          "Revision": {
            "type": "string"
          },
          "Settings": {
            "$ref": "#/$defs/JellyfinEnhancedUserSettings"
          }
        },
        "required": [
          "Revision",
          "Settings"
        ],
        "additionalProperties": false
      },
      "SettingsSaveReceipt": {
        "type": "object",
        "properties": {
          "Revision": {
            "type": "string"
          }
        },
        "required": [
          "Revision"
        ],
        "additionalProperties": false
      },
      "BookmarkOperation": {
        "type": "object",
        "properties": {
          "ExpectedItemId": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "Fields": true,
          "Id": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          },
          "Kind": {
            "type": "string"
          },
          "Offset": {
            "anyOf": [
              {
                "type": "number"
              },
              {
                "type": "null"
              }
            ]
          },
          "SourceId": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "ExpectedItemId",
          "Fields",
          "Id",
          "Kind",
          "Offset",
          "SourceId"
        ],
        "additionalProperties": false
      },
      "BookmarkMutationRequest": {
        "type": "object",
        "properties": {
          "Operations": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BookmarkOperation"
            }
          },
          "Revision": {
            "type": "string"
          }
        },
        "required": [
          "Operations",
          "Revision"
        ],
        "additionalProperties": false
      },
      "BookmarkSaveReceipt": {
        "type": "object",
        "properties": {
          "Revision": {
            "type": "string"
          }
        },
        "required": [
          "Revision"
        ],
        "additionalProperties": false
      }
    }
  };

  // client/src/contracts/validate.ts
  var validate_exports = {};
  __export(validate_exports, {
    validateSchema: () => validateSchema
  });
  function validateSchema(value, schema, definitions) {
    const ancestors = /* @__PURE__ */ new Set();
    function json(value2, depth) {
      if (depth > 100) return false;
      if (value2 === null || typeof value2 === "string" || typeof value2 === "boolean") return true;
      if (typeof value2 === "number") return Number.isFinite(value2);
      if (typeof value2 !== "object" || ancestors.has(value2)) return false;
      ancestors.add(value2);
      const valid = Array.isArray(value2) ? value2.every((child) => json(child, depth + 1)) : Object.prototype.toString.call(value2) === "[object Object]" && Object.values(value2).every((child) => json(child, depth + 1));
      ancestors.delete(value2);
      return valid;
    }
    function matches(value2, rule, depth) {
      if (depth > 100) return false;
      if (typeof rule === "boolean") return rule;
      if (rule.$ref !== void 0) {
        const prefix = "#/$defs/";
        const target = rule.$ref.startsWith(prefix) ? definitions[rule.$ref.slice(prefix.length)] : void 0;
        return target !== void 0 && matches(value2, target, depth + 1);
      }
      if (rule.anyOf !== void 0) return rule.anyOf.some((option) => matches(value2, option, depth + 1));
      switch (rule.type) {
        case "null":
          return value2 === null;
        case "string":
          return typeof value2 === "string";
        case "boolean":
          return typeof value2 === "boolean";
        case "number":
          return typeof value2 === "number" && Number.isFinite(value2);
        case "integer":
          return typeof value2 === "number" && Number.isInteger(value2);
        case "array":
          return Array.isArray(value2) && rule.items !== void 0 && value2.every((item) => matches(item, rule.items, depth + 1));
        case "object": {
          if (value2 === null || typeof value2 !== "object" || Array.isArray(value2)) return false;
          if (rule.required?.some((key) => !Object.prototype.hasOwnProperty.call(value2, key))) return false;
          return Object.entries(value2).every(([key, child]) => {
            const property = rule.properties && Object.prototype.hasOwnProperty.call(rule.properties, key) ? rule.properties[key] : void 0;
            return matches(child, property ?? rule.additionalProperties ?? true, depth + 1);
          });
        }
        default:
          return false;
      }
    }
    return json(value, 0) && matches(value, schema, 0);
  }

  // client/generated-shared/publish/js/enhanced/config.js.ts
  publishSharedModules({ "contracts/schema": schema_exports, "contracts/validate": validate_exports });

  // client/src/features/settings/host.ts
  function settingsHost() {
    const host = window;
    const JE = host.JellyfinEnhanced;
    if (!JE) throw new Error("Settings require Jellyfin Enhanced");
    const ctx2 = featureContext("settings", JE, {});
    return { JE, ctx: ctx2, apiClient: () => host.ApiClient };
  }

  // client/src/features/settings/state.ts
  function installState(JE) {
    JE.CONFIG = {
      // Use getters so values always reflect the latest pluginConfig even if assigned later
      get TOAST_DURATION() {
        return JE.pluginConfig && JE.pluginConfig.ToastDuration || 1500;
      },
      get HELP_PANEL_AUTOCLOSE_DELAY() {
        return JE.pluginConfig && JE.pluginConfig.HelpPanelAutocloseDelay || 15e3;
      }
    };
    JE.state = JE.state || {
      activeShortcuts: {},
      // { itemId, surface: 'continuewatching'|'nextup'|null, ts } captured on a menu trigger.
      removeContext: null,
      pauseScreenClickTimer: null
    };
    JE.keyCombo = function(e) {
      const key = e.key;
      const isLetter = /^[a-zA-Z]$/.test(key);
      const isShiftedSymbol = key.length === 1 && key !== " " && !isLetter;
      return (e.metaKey ? "Meta+" : "") + (e.ctrlKey ? "Ctrl+" : "") + (e.altKey ? "Alt+" : "") + (e.shiftKey && !isShiftedSymbol ? "Shift+" : "") + (isLetter ? key.toUpperCase() : key);
    };
    JE.normalizeShortcutKey = function(key) {
      if (typeof key !== "string") return key;
      return key.replace(/Shift\+([^A-Za-z0-9\s,./;'\[\]\\=`-])$/, "$1");
    };
    JE.initializeShortcuts = function() {
      const pluginDefaults = JE.pluginConfig || {};
      const userShortcutsConfig = JE.userConfig?.shortcuts || {};
      const defaultShortcuts = Array.isArray(pluginDefaults.Shortcuts) ? pluginDefaults.Shortcuts.reduce((acc, s) => {
        if (s && s.Name && s.Key !== void 0) acc[s.Name] = s.Key;
        return acc;
      }, {}) : {};
      const userShortcuts = Array.isArray(userShortcutsConfig.Shortcuts) ? userShortcutsConfig.Shortcuts.reduce((acc, s) => {
        if (s && s.Name && s.Key !== void 0) acc[s.Name] = s.Key;
        return acc;
      }, {}) : {};
      JE.state.activeShortcuts = JE.state.activeShortcuts || {};
      Object.assign(JE.state.activeShortcuts, defaultShortcuts, userShortcuts);
      Object.keys(JE.state.activeShortcuts).forEach(function(name) {
        JE.state.activeShortcuts[name] = JE.normalizeShortcutKey(JE.state.activeShortcuts[name] ?? "");
      });
    };
  }

  // client/src/features/settings/inheritance.ts
  var INHERITED_KEYS = [
    "showEditionTag",
    "editionTagOrder",
    "showLowQualitySourceTag",
    "resolutionTagOrder",
    "sourceTagOrder",
    "dynamicRangeTagOrder",
    "specialFormatTagOrder",
    "videoCodecTagOrder",
    "audioInfoTagOrder",
    "seriesQualityAggregation",
    "showRuntimeTag",
    "showAspectRatioTag",
    "showFrameRateTag",
    "showVersionsTag",
    "runtimeTagOrder",
    "aspectRatioTagOrder",
    "frameRateTagOrder",
    "versionsTagOrder",
    "qualityAudioDisplayMode",
    "qualityVideoCodecDisplayMode",
    "qualityHdrDisplayMode",
    "qualityMinimumResolution",
    "qualityHideSdr"
  ];
  var inheritance = /* @__PURE__ */ new WeakMap();
  function installInheritance(JE) {
    JE.inheritedSettingKeys = Object.freeze(INHERITED_KEYS.slice());
    JE.isSettingInherited = (settings, key) => {
      const state = inheritance.get(settings);
      return !!state && state.inherited.has(key) && settings[key] === state.defaults[key];
    };
    JE.setSettingInherited = (settings, key, inherit) => {
      const state = inheritance.get(settings);
      if (!state || !INHERITED_KEYS.includes(key)) return false;
      if (inherit) {
        state.inherited.add(key);
        settings[key] = state.defaults[key];
      } else {
        state.inherited.delete(key);
      }
      return true;
    };
    JE.inheritedSettingDefault = (settings, key) => inheritance.get(settings)?.defaults[key];
  }
  var withInheritance = (settings, source) => {
    const state = inheritance.get(settings);
    if (!state) return source;
    let out = source;
    for (const key of [...state.inherited]) {
      if (settings[key] !== state.defaults[key]) {
        state.inherited.delete(key);
        continue;
      }
      if (out === source) out = { ...source };
      out[key] = null;
    }
    return out;
  };

  // client/src/features/settings/defaults.ts
  function loadSettings(JE) {
    const userSettings = JE.userConfig?.settings || {};
    const pluginDefaults = JE.pluginConfig || {};
    const hardcodedDefaults = {
      autoPauseEnabled: true,
      autoResumeEnabled: false,
      autoPipEnabled: false,
      autoSkipIntro: false,
      autoSkipOutro: false,
      selectedStylePresetIndex: 0,
      selectedFontSizePresetIndex: 2,
      selectedFontFamilyPresetIndex: 0,
      selectedTextEffectPresetIndex: 0,
      customSubtitleTextColor: "#FFFFFFFF",
      customSubtitleBgColor: "#00000000",
      usingCustomColors: false,
      disableCustomSubtitleStyles: false,
      subtitleVerticalPosition: 95,
      subtitleHorizontalPosition: 50,
      randomButtonEnabled: true,
      randomIncludeMovies: true,
      randomIncludeShows: true,
      randomUnwatchedOnly: false,
      randomScopeCurrentContainer: false,
      randomSourceId: "",
      showWatchProgress: false,
      showFileSizes: false,
      showAudioLanguages: true,
      removeContinueWatchingEnabled: false,
      watchProgressMode: "percentage",
      watchProgressTimeFormat: "hours",
      pauseScreenEnabled: true,
      pauseScreenDelaySeconds: 5,
      useNativePosterTags: true,
      qualityTagsEnabled: false,
      genreTagsEnabled: false,
      languageTagsEnabled: false,
      ratingTagsEnabled: false,
      ageRatingTagsEnabled: false,
      statusTagsEnabled: false,
      logoTagsEnabled: false,
      awardsTagsEnabled: false,
      awardsTagsPosition: "top-left",
      peopleTagsEnabled: false,
      tagsHideOnHover: false,
      showResolutionTag: true,
      showSourceTag: true,
      showDynamicRangeTag: true,
      showSpecialFormatTag: true,
      showVideoCodecTag: true,
      showAudioInfoTag: true,
      // Source and edition preferences.
      showEditionTag: true,
      editionTagOrder: 7,
      showRuntimeTag: false,
      runtimeTagOrder: 8,
      showAspectRatioTag: false,
      aspectRatioTagOrder: 9,
      showFrameRateTag: false,
      frameRateTagOrder: 10,
      showVersionsTag: false,
      versionsTagOrder: 11,
      showLowQualitySourceTag: false,
      resolutionTagOrder: 1,
      sourceTagOrder: 2,
      dynamicRangeTagOrder: 3,
      specialFormatTagOrder: 4,
      videoCodecTagOrder: 5,
      audioInfoTagOrder: 6,
      qualityTagsPosition: "top-left",
      genreTagsPosition: "top-right",
      languageTagsPosition: "bottom-left",
      ratingTagsPosition: "bottom-right",
      ageRatingTagsPosition: "bottom-right",
      logoTagsPosition: "bottom-left",
      statusTagsPosition: "top-right",
      ratingTagsOnMovies: true,
      ratingTagsOnSeries: true,
      ratingTagsOnSeasons: true,
      ratingTagsOnEpisodes: true,
      ratingTagsOnContinueWatching: true,
      ratingTagsOnNextUp: true,
      ratingTagsShowCommunity: true,
      ratingTagsShowCritic: true,
      statusTagsJustAdded: true,
      statusTagsNewRelease: true,
      statusTagsTrending: true,
      statusTagsSchedule: true,
      statusTagsMilestones: true,
      statusTagsSeriesStatus: false,
      statusTagsScenes: false,
      statusTagsLeaving: false,
      statusTagsDirectPlay: false,
      // Custom tag group (the administrator's tag/collection rules, tags/customtags.js).
      customTagsEnabled: false,
      customTagsPosition: "top-left",
      // Language Tags display (normalized in tags/languagetags.js).
      languageTagsShowAudio: true,
      languageTagsShowSubtitles: false,
      languageTagsStyle: "flags",
      languageTagsCountBadge: "off",
      // Poster tag layout scalars (0 = a document from before layouts; see core/tag-layout.js).
      tagLayout: "corners",
      tagLabelDensity: "full",
      tagLayoutSettingsVersion: 0,
      tagScale: "default",
      tagGap: "default",
      qualityAudioDisplayMode: "highest",
      qualityVideoCodecDisplayMode: "highest",
      qualityHdrDisplayMode: "highest",
      qualityMinimumResolution: "off",
      qualityHideSdr: false,
      qualityTagsPreferredAudioLanguage: "",
      // Series/season quality aggregation policy.
      seriesQualityAggregation: "representative",
      showRatingInPlayer: true,
      reviewsExpandedByDefault: false,
      displayLanguage: "",
      calendarDisplayMode: "list",
      calendarDefaultViewMode: "agenda",
      disableAllShortcuts: false,
      longPress2xEnabled: false,
      lastOpenedTab: "shortcuts"
    };
    const pluginDefaultAliases = {
      selectedStylePresetIndex: ["DefaultSubtitleStyle", "SelectedStylePresetIndex"],
      selectedFontSizePresetIndex: ["DefaultSubtitleSize", "SelectedFontSizePresetIndex"],
      selectedFontFamilyPresetIndex: ["DefaultSubtitleFont", "SelectedFontFamilyPresetIndex"],
      displayLanguage: ["DefaultLanguage", "DisplayLanguage"],
      watchProgressMode: ["WatchProgressDefaultMode", "WatchProgressMode"],
      watchProgressTimeFormat: ["WatchProgressTimeFormat"],
      pauseScreenDelaySeconds: ["PauseScreenDelaySeconds"]
    };
    const getPluginDefault = (key) => {
      const aliases = pluginDefaultAliases[key] || [];
      const candidates = [
        key,
        key.charAt(0).toUpperCase() + key.slice(1),
        ...aliases
      ];
      for (const candidate of candidates) {
        const value = pluginDefaults[candidate];
        if (value !== null && value !== void 0) {
          return value;
        }
      }
      return void 0;
    };
    const mergedSettings = {};
    for (const key in userSettings) {
      mergedSettings[key] = userSettings[key];
    }
    for (const key in hardcodedDefaults) {
      if (Object.prototype.hasOwnProperty.call(userSettings, key) && userSettings[key] !== null && userSettings[key] !== void 0) {
        if (typeof userSettings[key] === "object" && Array.isArray(userSettings[key]) && userSettings[key].length === 0) {
          const fallback = getPluginDefault(key);
          mergedSettings[key] = fallback !== void 0 ? fallback : hardcodedDefaults[key];
        } else if (typeof userSettings[key] === "object" && userSettings[key] !== null && !Array.isArray(userSettings[key])) {
          const fallback = getPluginDefault(key);
          mergedSettings[key] = fallback !== void 0 ? fallback : hardcodedDefaults[key];
        } else {
          mergedSettings[key] = userSettings[key];
        }
      } else {
        const pluginVal = getPluginDefault(key);
        if (pluginVal !== void 0) {
          mergedSettings[key] = pluginVal;
        } else {
          mergedSettings[key] = hardcodedDefaults[key];
        }
      }
    }
    mergedSettings.languageTagsPriority = JE.core?.mediaLanguage?.priorityList(userSettings.languageTagsPriority) ?? null;
    mergedSettings.languageTagsPriorityStrict = typeof userSettings.languageTagsPriorityStrict === "boolean" ? userSettings.languageTagsPriorityStrict : null;
    mergedSettings.ratingTagsSources = JE.ratingSources?.normalizeSources(userSettings.ratingTagsSources) ?? null;
    mergedSettings.ratingTagsMinScore = JE.ratingSources?.settings(userSettings, JE.pluginConfig).minimum ?? 0;
    mergedSettings.ratingTagsColorByScore = JE.ratingSources?.settings(userSettings, JE.pluginConfig).color ?? false;
    for (const key of ["tagLayouts", "tagGroupCaps", "tagGroupScopes"]) {
      const value = userSettings[key];
      mergedSettings[key] = value && typeof value === "object" && !Array.isArray(value) ? value : null;
    }
    mergedSettings.tagEdgeSpacing = typeof userSettings.tagEdgeSpacing === "string" && userSettings.tagEdgeSpacing ? userSettings.tagEdgeSpacing : null;
    mergedSettings.tagStylePreset = typeof userSettings.tagStylePreset === "string" && userSettings.tagStylePreset ? userSettings.tagStylePreset : null;
    mergedSettings.tagGroupOrder = Array.isArray(userSettings.tagGroupOrder) ? userSettings.tagGroupOrder : null;
    mergedSettings.tagLookRules = Array.isArray(userSettings.tagLookRules) ? userSettings.tagLookRules : null;
    mergedSettings.tagLayoutLocks = userSettings.tagLayoutLocks && typeof userSettings.tagLayoutLocks === "object" && !Array.isArray(userSettings.tagLayoutLocks) ? userSettings.tagLayoutLocks : null;
    mergedSettings.tagScale = userSettings.tagScale ?? null;
    mergedSettings.tagGap = userSettings.tagGap ?? null;
    mergedSettings.tagShapeOverrides = userSettings.tagShapeOverrides && typeof userSettings.tagShapeOverrides === "object" && !Array.isArray(userSettings.tagShapeOverrides) ? userSettings.tagShapeOverrides : null;
    mergedSettings.displayLanguage = Object.prototype.hasOwnProperty.call(userSettings, "displayLanguage") && userSettings.displayLanguage !== null && userSettings.displayLanguage !== void 0 ? userSettings.displayLanguage : getPluginDefault("displayLanguage") || "";
    mergedSettings.lastOpenedTab = userSettings.lastOpenedTab || "shortcuts";
    if (!Object.prototype.hasOwnProperty.call(userSettings, "removeContinueWatchingEnabled") && pluginDefaults.RemoveContinueWatchingEnabled === true) {
      mergedSettings.removeContinueWatchingEnabled = true;
    }
    mergedSettings.languageTagsStyle = String(mergedSettings.languageTagsStyle).trim().toLowerCase() === "codes" ? "codes" : "flags";
    const languageBadge = String(mergedSettings.languageTagsCountBadge).trim().toLowerCase();
    mergedSettings.languageTagsCountBadge = ["only", "both"].includes(languageBadge) ? languageBadge : "off";
    const defaults = {};
    const inherited = /* @__PURE__ */ new Set();
    for (const key of INHERITED_KEYS) {
      const fallback = getPluginDefault(key);
      defaults[key] = fallback !== void 0 ? fallback : hardcodedDefaults[key];
      if (userSettings[key] === null || userSettings[key] === void 0) inherited.add(key);
    }
    inheritance.set(mergedSettings, { defaults, inherited });
    return mergedSettings;
  }

  // client/src/features/settings/save.ts
  function isReceipt(value) {
    return validateSchema(value, bootstrapSchema.$defs.SettingsSaveReceipt, bootstrapSchema.$defs);
  }
  function installSave(JE, getClient, ctx2) {
    const _lastSavedJson = {};
    const acknowledgedSettings = /* @__PURE__ */ new WeakMap();
    const _saveChain = {};
    let epoch = 0;
    const loaded = /* @__PURE__ */ new WeakMap();
    const identityOf = () => {
      const client = getClient();
      return `${client?.getUrl("/")}|${client?.getCurrentUserId()}|${client?.accessToken?.() || ""}|${typeof client?.serverId === "function" ? client.serverId() : client?.serverId}|${epoch}`;
    };
    const load = JE.loadSettings;
    JE.loadSettings = () => {
      const settings = load();
      const binding = { identity: identityOf(), origin: JE.userConfig };
      loaded.set(settings, binding);
      for (const doc of [JE.userConfig?.shortcuts, JE.userConfig?.bookmark, JE.userConfig?.elsewhere, JE.userConfig?.hiddenContent]) {
        if (doc) loaded.set(doc, binding);
      }
      return settings;
    };
    if (typeof document !== "undefined") document.addEventListener("je:user-changed", () => {
      epoch++;
    });
    const saveUserSettings = async (fileName, settings, options = {}) => {
      const isCurrentSettings = settings === JE.currentSettings;
      const throwOnError = options?.throwOnError === true;
      let failureCurrent = () => !options.isCurrent || options.isCurrent();
      const handleError = async (e) => {
        if (!failureCurrent()) {
          if (throwOnError) throw e;
          return;
        }
        await options.onError?.(e);
        if (fileName === "settings.json" && failureCurrent() && (!options.notifyOnError || options.notifyOnError())) JE.toast?.("Settings could not be saved. They may have changed in another tab or on the server. Reload before trying again.");
        if (throwOnError) throw e;
        console.error(`🪼 Jellyfin Enhanced: Failed to save ${fileName}:`, e);
      };
      try {
        const ApiClient = getClient();
        if (!ApiClient) {
          throw new Error("ApiClient not available");
        }
        const userId = ApiClient.getCurrentUserId();
        if (!userId) {
          throw new Error("User ID not available");
        }
        const identity = identityOf();
        const origin = JE.userConfig;
        const binding = loaded.get(settings);
        if (binding && (binding.identity !== identity || binding.origin !== origin)) return;
        const current = () => getClient() === ApiClient && identity === identityOf() && origin === JE.userConfig && (!options.isCurrent || options.isCurrent());
        failureCurrent = current;
        const serialize = () => {
          let source = settings;
          const getStatusDateContext = fileName === "settings.json" && isCurrentSettings && settings.statusTagsEnabled ? ctx2.peer("getStatusDateContext") : void 0;
          if (typeof getStatusDateContext === "function") {
            const context = getStatusDateContext();
            source = { ...settings, nativePosterDateLocale: context.locale, nativePosterTimeZone: context.timeZone };
          }
          let dataToSave = source;
          if (fileName === "settings.json" && isCurrentSettings && JE.userConfig?.settings?.useNativePosterTags == null) {
            dataToSave = { ...source, useNativePosterTags: null };
          }
          if (fileName === "settings.json") dataToSave = withInheritance(settings, dataToSave);
          if ((fileName === "bookmark.json" || fileName === "settings.json") && typeof JE.toPascalCase === "function") {
            dataToSave = JE.toPascalCase(dataToSave);
          }
          return JSON.stringify(dataToSave);
        };
        const snapshot = fileName === "settings.json" ? null : serialize();
        const cacheKey = `${identity}:${fileName}`;
        const post = async () => {
          if (!current()) return;
          options.beforeSave?.();
          if (!current()) return;
          const serialized = fileName === "settings.json" ? serialize() : snapshot;
          const revision = origin?.settingsRevision;
          if (fileName === "settings.json") {
            if (!revision) throw new Error("Settings were not loaded with a revision. Reload before saving.");
            const saved = acknowledgedSettings.get(settings);
            if (saved && saved.json === serialized && saved.revision === revision && saved.identity === identity && saved.origin === origin) return;
          } else if (_lastSavedJson[cacheKey] === serialized) return;
          const response = await ApiClient.ajax({
            type: "POST",
            url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/${fileName === "settings.json" ? "settings-document" : fileName}`),
            data: fileName === "settings.json" ? JSON.stringify({ Revision: revision, Settings: JSON.parse(serialized || "{}") }) : serialized || "{}",
            ...fileName === "settings.json" ? { dataType: "json" } : {},
            contentType: "application/json"
          });
          if (!current()) return;
          if (fileName === "settings.json") {
            if (!isReceipt(response) || !response.Revision)
              throw new Error("Invalid settings save response. Reload before saving again.");
            if (origin) origin.settingsRevision = response.Revision;
            acknowledgedSettings.set(settings, { json: serialized, revision: response.Revision, identity, origin });
          } else {
            _lastSavedJson[cacheKey] = serialized;
          }
        };
        const save = (_saveChain[cacheKey] || Promise.resolve()).then(post).catch((e) => {
          if (current()) return handleError(e);
          if (throwOnError) throw e;
        });
        _saveChain[cacheKey] = save.catch(() => {
        });
        return save;
      } catch (e) {
        return handleError(e);
      }
    };
    const saveStates = /* @__PURE__ */ new WeakMap();
    JE.getSettingsSaveState = () => {
      const state = JE.currentSettings && saveStates.get(JE.currentSettings);
      return state ? { ...state } : { version: 0, pending: 0 };
    };
    JE.saveUserSettings = async (fileName, settings, options) => {
      if (fileName !== "settings.json") return saveUserSettings(fileName, settings, options);
      let state = saveStates.get(settings);
      if (!state) {
        state = { version: 0, pending: 0 };
        saveStates.set(settings, state);
      }
      state.version++;
      state.pending++;
      try {
        await saveUserSettings(fileName, settings, options);
      } finally {
        state.pending--;
      }
    };
  }

  // client/src/features/settings/entry.ts
  var { JE: je, ctx, apiClient } = settingsHost();
  installState(je);
  installInheritance(je);
  je.loadSettings = () => loadSettings(je);
  installSave(je, apiClient, ctx);
})();
})();
//# sourceMappingURL=config.js.map
