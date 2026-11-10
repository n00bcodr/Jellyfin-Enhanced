# Elsewhere document boundary

`Features/DetailsProviders/Services/ElsewhereDocumentService.cs` owns reading and saving `elsewhere.json` for
the `user-settings/{userId}/elsewhere.json` routes. It resolves DETAILS-PROVIDERS-003
and REVIEW-DP-R2-03 on the server. Routes, authorization, user scoping and the
success response are unchanged. It adds no migration, and existing files keep their
name and shape.

## Reading

GET returns the stored document as JSON, with `Cache-Control: no-store`.

| Stored state | Response |
| --- | --- |
| No file | `200` with the `ElsewhereSettings` defaults; nothing is written |
| Valid document | `200` with every stored field, including unknown ones |
| Empty, malformed, non-UTF-8, not an object, or a duplicate key | `500`; the file is untouched |
| An editable field of the wrong type, or two casings of one field | `500`; the file is untouched |
| Unreadable entry, or a symbolic link | `500`; it is never treated as absent |

Only an absent file has defaults. Nothing is quarantined, repaired or replaced, so
an administrator resolves a rejected document by correcting or removing the file.

An editable field that is missing or null is valid and means "unset", because older
documents can contain either. GET returns it as stored and does not fill it in; the
client applies the same defaults. A wrong type is corruption, including values the
old lenient read coerced, such as `"SeasonProviders":"true"` or `"Region":5`.

Editable field names are returned in canonical casing. The client's names are exact
while earlier server versions matched any casing, so a stored `region` would
otherwise display as unset and then be overwritten by the next save.

The endpoint must not use the lenient `GetUserConfiguration`, which returns defaults
for corrupt input.

## Saving

POST merges into the current document through
`TryUpdateUserConfigurationDocument`, so it shares the store's lock and revision
check. The parameter is a raw `JsonElement` rather than `ElsewhereSettings` for two
reasons. Jellyfin's `JsonDefaults` string converter turns `{"Region":5}` into `"5"`
for a typed model, which an action cannot detect. A typed model also cannot tell an
omitted field from a default one, which is how a partial save erased stored choices.

| Request | Result |
| --- | --- |
| Valid editable fields | Those fields change; all others are kept; `200 {"success":true,"file":"elsewhere.json"}` |
| Editable field omitted | The stored value is kept |
| Explicit `""` or `[]` | Stored as an edit |
| Unknown request field | Ignored; the stored copy stays authoritative |
| Not an object, or no editable field | `400` |
| `null` or a wrong type for an editable field | `400` |
| One editable field supplied twice, in any casing | `400` |
| Stored document is invalid | `500`; no write and no save event |
| Writers outlast all three attempts | `409`; nothing is merged |

With no file, a save writes the defaults overlaid with the request's fields. Editable
string values are stored exactly and are not trimmed or checked against any catalog.
Saving rewrites the file as indented JSON through the store, which also drops a BOM.

Unknown fields keep their JSON kinds, so date-shaped text stays text. Numbers outside
exact CLR ranges keep their literal text. The shared store does respell some numbers
it can hold exactly: `1E2` becomes `100.0`, and both `-0` and `-0.0` lose their sign.

## Limits

- **No client revision.** The revision check protects a request from concurrent
  writers on the server, and a retry merges the same edit into the newest document.
  It does not detect a form opened from an older copy. The form sends all four
  fields, so of two open tabs the later save wins for those fields. Unknown fields
  survive either way. Preventing this needs a revision in the route and client.
- **Bootstrap stays lenient.** `GetBootstrap` still reads this document through
  `GetUserConfiguration`, and the fallback loader keeps defaults after a failed GET.
  Provider panels can therefore show defaults for a corrupt document. Neither path
  writes: the settings form loads its own document, and a failed load prevents Save.
