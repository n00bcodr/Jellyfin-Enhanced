# Revisioned personal settings slice

The default browser flow loads `Settings` and `SettingsRevision` together from
bootstrap. If bootstrap is unavailable, it loads the generated
`RevisionedSettingsResponse` from `GET user-settings/{userId}/settings-document`.
Both paths validate their transport and caller administrator projection before
assembling the user document. A failed load leaves no usable revision; saving
requires a reload, rather than inventing an empty replacement.

`POST user-settings/{userId}/settings-document` accepts `{ Revision, Settings }`.
Authorization uses the existing user-config access rule. Normalization uses the
existing Media Tags validation. The service applies the known normalized DTO
fields to the raw stored object under the store CAS lock, preserving unknown
stored fields (including lossless numeric literals). Within retained objects,
known fields follow the authoritative serializer type graph and unknown members
stay on disk. A null replaces the entire selected object. Item-lock dictionaries
use exactly the submitted key set, matching retained locks by normalized item ID;
removed keys stay removed. The existing normalizers report source-to-result
correspondence, so repaired IDs, rejected candidates, timestamp clamping and
winner selection also govern preservation. Reads project repaired rule IDs
before client edits; they do not rewrite stored bytes. Rules match those stable
IDs, slots match surviving normalized groups in the old layout context, and
conditions match normalized field/value, so reordering cannot move extension
data to another entry. New entries start without another entry's
extensions. Empty arrays/dictionaries clear their entries; null retains its
inheritance meaning. Future structured collection types require an explicit merge
identity policy. Unknown fields are retained in storage, not exposed or accepted
as additional typed settings. `IsAdmin` is computed from
the caller for reads and removed from stored settings on writes. Missing files
are initialized with CAS; corrupt files are neither quarantined nor replaced.
Success returns generated `SettingsSaveReceipt` (`{ Revision }`); a stale token
returns HTTP 409 without changing content. Ordinary manager writes invalidate
loaded revisions too. Revisions describe content, not write history; identical
bytes and change-away-and-back have the persistence layer's documented semantics.

The old `/settings.json` routes remain deliberate compatibility endpoints. The
old POST still has unconditional whole-document replacement semantics; it cannot
protect a legacy caller from overwriting changes or preserve unknown fields the
legacy caller does not supply. It does invalidate the revision seen by modern
clients. New clients must use `/settings-document`; there is no automatic fallback
from a guarded write to the legacy POST.

`client/src/features/settings` replaces the production config entry with strict
TypeScript modules for defaults, inheritance, state/shortcuts and saves. It keeps
all existing defaults, native-poster null inheritance, browser date context,
nullable layout/language policy and the existing callback/rollback queue semantics.
A successful settings save advances the loaded revision. Conflicts retain the old
revision, invoke the existing error path and show reload guidance, with no fetch
of a fresh revision and no retry. Other document saves retain call-time snapshots.
Queues and deduplication include host identity, token and the account-change epoch;
loaded document bindings and response guards discard stale-account work.

Validation and exact hashes are recorded under `artifacts/rewrite-settings/`.
This slice does not establish whole-rewrite completion or live-host parity.
