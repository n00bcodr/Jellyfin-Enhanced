using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Secrets
{
    /// <summary>
    /// Keeps credentials out of the plugin configuration.
    /// <list type="bullet">
    /// <item><description><see cref="MigrateStored"/> runs at start-up: every raw credential in the
    /// loaded configuration (including per-instance arr keys and the legacy single Sonarr/Radarr keys)
    /// moves to the <see cref="SecretsStore"/> and is replaced by a placeholder; arr rows get stable
    /// ids (registry v2). Idempotent: a second run changes nothing.</description></item>
    /// <item><description><see cref="ApplyIncoming"/> runs on every configuration save: placeholders and
    /// blanks keep the stored value (unless the credential's server address changed), the clear token
    /// removes it, an import handle or a newly typed value replaces it.</description></item>
    /// <item><description><see cref="Rollback"/> writes the real values back into the configuration
    /// (before downgrading JE); the store keeps its copy, so the next start-up of this version simply
    /// migrates again.</description></item>
    /// </list>
    /// Every run works out all store changes first and writes them in one go. When the store can't be
    /// read or written nothing is lost: values that are not in the store stay in the configuration
    /// as they were (the pre-store layout), and a placeholder whose stored value can't be found is
    /// kept, never blanked, so restoring the file brings the credential back.
    /// </summary>
    public static class SecretsMigration
    {
        /// <summary>
        /// Stored in place of an unreadable instance list once its text has moved to the store (it may
        /// hold API keys). Not JSON, so every reader still treats the list as corrupt.
        /// </summary>
        public const string CorruptListMarker = "#unreadable: the original value was moved to secrets.json";

        /// <summary>Store name holding the original text of an unreadable instance list.</summary>
        public static string CorruptListStoreName(string listProperty) => listProperty + ".corrupt";

        /// <summary>What a migration or save changed (names only, never values).</summary>
        public sealed class Report
        {
            /// <summary>True when the configuration object was modified and should be saved.</summary>
            public bool ConfigChanged { get; set; }

            /// <summary>Credentials moved from the configuration into the store.</summary>
            public List<string> Moved { get; } = new();

            /// <summary>Placeholders whose stored value could not be found (kept, but unusable until restored or re-entered).</summary>
            public List<string> Missing { get; } = new();

            /// <summary>Credentials that were not kept by a save and must be entered again (server address changed, import expired).</summary>
            public List<string> NeedsReentry { get; } = new();

            /// <summary>True when the store could not be written: new values stayed in the configuration.</summary>
            public bool StoreUnavailable { get; set; }

            /// <summary>Other notes for the log.</summary>
            public List<string> Notes { get; } = new();
        }

        private enum Kind { Sonarr, Radarr }

        // One credential (a configuration property or an instance row's key) while a run is worked out.
        private sealed class Slot
        {
            public Slot(string storeName) => StoreName = storeName;

            public string StoreName { get; }

            // The value the store should hold afterwards ("" = none).
            public string Real { get; set; } = string.Empty;

            // When set, the field keeps exactly this text (a placeholder whose stored value is missing).
            public string? Keep { get; set; }

            // True when the value arrived in plain text (typed, imported, or not migrated yet).
            public bool New { get; set; }
        }

        private sealed class Work
        {
            private readonly List<Slot> _slots = new();

            public Work(SecretsStore store) => Store = store;

            public SecretsStore Store { get; }

            public Report Report { get; } = new();

            // Store entries to remove (keys of deleted instances, a replaced corrupt list).
            public HashSet<string> Prune { get; } = new(StringComparer.Ordinal);

            // Other entries to store (the text of an unreadable instance list).
            public Dictionary<string, string> Extra { get; } = new(StringComparer.Ordinal);

            public Slot Add(string storeName)
            {
                var slot = new Slot(storeName);
                _slots.Add(slot);
                return slot;
            }

            // Writes every change at once. False (and the store untouched) when it can't be written.
            public bool Commit(bool allowRemovals)
            {
                var changes = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var slot in _slots.Where(s => s.Keep == null))
                {
                    if (slot.Real.Length == 0 && !allowRemovals) continue;
                    if (!string.Equals(Store.Get(slot.StoreName) ?? string.Empty, slot.Real, StringComparison.Ordinal)) changes[slot.StoreName] = slot.Real;
                }
                if (allowRemovals)
                {
                    foreach (var name in Prune.Where(n => !changes.ContainsKey(n) && Store.Get(n) != null)) changes[name] = string.Empty;
                }
                foreach (var (name, value) in Extra) changes[name] = value;
                if (changes.Count == 0) return true;

                var newOnes = _slots.Where(s => s.New && s.Keep == null && s.Real.Length > 0 && changes.ContainsKey(s.StoreName)).Select(s => Describe(s.StoreName)).ToList();
                try
                {
                    Store.Apply(changes);
                }
                catch (SecretsStoreUnavailableException ex)
                {
                    Report.StoreUnavailable = true;
                    Report.Notes.Add(ex.Message + " Credentials stay in the plugin configuration as they are until it works again.");
                    return false;
                }

                Report.Moved.AddRange(newOnes);
                var removed = changes.Count(c => c.Value.Length == 0);
                if (removed > 0) Report.Notes.Add($"Removed {removed} stored credential(s) the configuration no longer uses.");
                return true;
            }

            // The text a slot's field holds afterwards: a placeholder when the store has the value; the
            // value itself when the store could not take it (nothing is lost); a kept placeholder as is.
            public string Text(Slot slot, bool committed)
            {
                if (slot.Keep != null) return slot.Keep;
                if (slot.Real.Length == 0) return string.Empty;
                return committed || string.Equals(Store.Get(slot.StoreName), slot.Real, StringComparison.Ordinal)
                    ? SecretValue.Mask(slot.Real)
                    : slot.Real;
            }
        }

        /// <summary>
        /// Start-up migration of the loaded configuration. Mutates <paramref name="config"/>; the caller
        /// saves it when <see cref="Report.ConfigChanged"/> is true. The store is written before the
        /// configuration, so a crash in between leaves the raw value in the XML and the next start-up
        /// repeats the move.
        /// </summary>
        public static Report MigrateStored(PluginConfiguration config, SecretsStore store)
        {
            var work = new Work(store);
            var report = work.Report;
            var fields = PluginConfiguration.StoredSecretFields.ToDictionary(f => f, f => MigrateSlot(work, f, config.ReadField(f)), StringComparer.Ordinal);

            var used = new HashSet<string>(StringComparer.Ordinal);
            var keep = new HashSet<string>(StringComparer.Ordinal);
            var listsReadable = true;
            var lists = new List<(Kind Kind, string Json, List<ArrInstance>? Rows, Dictionary<ArrInstance, Slot>? Slots)>();
            foreach (var kind in new[] { Kind.Sonarr, Kind.Radarr })
            {
                var json = InstancesJson(config, kind);
                var rows = ArrRegistryMigration.Parse(json);
                if (rows == null)
                {
                    listsReadable = false;
                    if (!string.Equals(json, CorruptListMarker, StringComparison.Ordinal))
                    {
                        // It may hold API keys: keep the text in the store (recoverable by hand) and
                        // leave a marker that every reader still treats as corrupt.
                        work.Extra[CorruptListStoreName(ListProperty(kind))] = json;
                        report.Notes.Add($"{ListProperty(kind)} is unreadable JSON; its text was moved to {SecretsStore.FileName} as {CorruptListStoreName(ListProperty(kind))}. Reset the list on the configuration page.");
                    }
                    lists.Add((kind, json, null, null));
                    continue;
                }

                rows = ArrRegistryMigration.Normalize(rows, null, kind.ToString(), used);
                var slots = new Dictionary<ArrInstance, Slot>(ReferenceEqualityComparer.Instance);
                foreach (var row in rows) slots[row] = MigrateSlot(work, SecretsStore.ArrKeyName(row.Id), row.ApiKey);
                FoldLegacy(work, config, kind, rows, slots, fields[LegacyKeyField(kind)]);
                rows.ForEach(r => keep.Add(SecretsStore.ArrKeyName(r.Id)));
                lists.Add((kind, json, rows, slots));
            }

            if (listsReadable)
            {
                // Keys of instances that no longer exist (removed while JE was not running the save
                // path, e.g. hand-edited XML) have no owner left.
                foreach (var orphan in store.Names().Where(n => n.StartsWith(SecretsStore.ArrKeyPrefix, StringComparison.Ordinal) && !keep.Contains(n))) work.Prune.Add(orphan);
            }

            // A placeholder whose value is missing means the store is not what this configuration
            // was saved with (restored backup, edited or replaced file): remove nothing until it is.
            var committed = work.Commit(allowRemovals: report.Missing.Count == 0);

            foreach (var (field, slot) in fields)
            {
                var text = work.Text(slot, committed);
                if (!string.Equals(text, config.ReadField(field), StringComparison.Ordinal))
                {
                    config.WriteField(field, text);
                    report.ConfigChanged = true;
                }
            }

            foreach (var (kind, json, rows, slots) in lists)
            {
                string next;
                if (rows == null)
                {
                    next = committed ? CorruptListMarker : json;
                }
                else
                {
                    foreach (var row in rows) row.ApiKey = work.Text(slots![row], committed);
                    next = ArrRegistryMigration.Serialize(rows);
                }
                if (!string.Equals(next, json, StringComparison.Ordinal))
                {
                    SetInstancesJson(config, kind, next);
                    report.ConfigChanged = true;
                }
            }

            return report;
        }

        /// <summary>
        /// Merges an incoming configuration (a dashboard save) with the current one. Mutates
        /// <paramref name="incoming"/> so it carries only placeholders, and updates the store. A saved
        /// key is only carried over to the server it was saved for: when a credential's address
        /// changes (another host, port or scheme), a placeholder or blank no longer keeps it.
        /// </summary>
        public static Report ApplyIncoming(PluginConfiguration incoming, PluginConfiguration current, SecretsStore store)
        {
            var work = new Work(store);
            var report = work.Report;
            var fields = new Dictionary<string, Slot>(StringComparer.Ordinal);
            foreach (var field in PluginConfiguration.StoredSecretFields)
            {
                // The config page mirrors the first instance (an import handle included) into the
                // legacy Sonarr/Radarr fields; the handle is bound to that instance's address.
                var address = Address(field);
                var target = address == null ? null : SplitUrls(address(incoming)).FirstOrDefault();
                fields[field] = MergeSlot(work, field, incoming.ReadField(field), current.ReadField(field), FlatServerChanged(field, incoming, current), target);
            }

            var used = new HashSet<string>(StringComparer.Ordinal);
            var keptIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var previousIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var lists = new List<(Kind Kind, List<ArrInstance> Rows, Dictionary<ArrInstance, Slot> Slots)>();
            foreach (var kind in new[] { Kind.Sonarr, Kind.Radarr })
            {
                var currentJson = InstancesJson(current, kind);
                var currentRows = ArrRegistryMigration.Parse(currentJson);
                var rows = ArrRegistryMigration.Parse(InstancesJson(incoming, kind));
                if (rows == null)
                {
                    // Never persist an unreadable list from a save (it may carry keys in plain text):
                    // keep the stored one. The config page never sends one; a broken API client might.
                    report.Notes.Add($"{ListProperty(kind)} in the saved configuration is unreadable JSON; the stored list was kept instead.");
                    SetInstancesJson(incoming, kind, currentJson);
                    if (currentRows == null) continue;
                    rows = ArrRegistryMigration.Parse(currentJson)!;
                }
                else if (currentRows == null)
                {
                    // The admin replaced an unreadable list: its stored text is no longer needed.
                    work.Prune.Add(CorruptListStoreName(ListProperty(kind)));
                }

                rows = ArrRegistryMigration.Normalize(rows, currentRows, kind.ToString(), used);
                var currentById = (currentRows ?? new List<ArrInstance>())
                    .Where(r => ArrRegistryMigration.IsValidId(r.Id))
                    .GroupBy(r => r.Id, StringComparer.OrdinalIgnoreCase)
                    .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);

                var slots = new Dictionary<ArrInstance, Slot>(ReferenceEqualityComparer.Instance);
                foreach (var row in rows)
                {
                    currentById.TryGetValue(row.Id, out var before);
                    var serverChanged = before != null && !SameServerOrUrl(before.Url, row.Url);
                    slots[row] = MergeSlot(work, SecretsStore.ArrKeyName(row.Id), row.ApiKey, before?.ApiKey, serverChanged, row.Url);
                }
                FoldLegacy(work, incoming, kind, rows, slots, fields[LegacyKeyField(kind)]);

                if (currentRows != null) previousIds.UnionWith(currentById.Keys);
                keptIds.UnionWith(rows.Select(r => r.Id));
                lists.Add((kind, rows, slots));
            }

            // Ids are unique across both lists, so a key is pruned only when no list keeps its id.
            foreach (var removed in previousIds.Where(id => !keptIds.Contains(id))) work.Prune.Add(SecretsStore.ArrKeyName(removed));

            var committed = work.Commit(allowRemovals: true);
            foreach (var (field, slot) in fields) incoming.WriteField(field, work.Text(slot, committed));
            foreach (var (kind, rows, slots) in lists)
            {
                foreach (var row in rows) row.ApiKey = work.Text(slots[row], committed);
                SetInstancesJson(incoming, kind, ArrRegistryMigration.Serialize(rows));
            }

            return report;
        }

        /// <summary>
        /// The save rule's server check for a restored configuration (a JE backup), run before
        /// <see cref="MigrateStored"/>. A placeholder in a backup refers to whatever this install stores
        /// under that name, and that key belongs to the address the <em>current</em> configuration
        /// points at. So a placeholder whose address differs from the current one (another host, port
        /// or scheme, or an instance id this install doesn't have) is blanked and listed for re-entry,
        /// unless its value came from the backup's own encrypted credentials
        /// (<paramref name="restoredNames"/>), which belong to the restored addresses. Mutates
        /// <paramref name="restored"/>; returns the credentials it blanked (names only).
        /// </summary>
        public static List<string> DetachMovedCredentials(PluginConfiguration restored, PluginConfiguration current, IReadOnlyCollection<string> restoredNames)
        {
            var trusted = new HashSet<string>(restoredNames, StringComparer.Ordinal);
            var dropped = new List<string>();
            foreach (var field in PluginConfiguration.StoredSecretFields)
            {
                if (!IsDangling(restored.ReadField(field)) || trusted.Contains(field) || !FlatServerChanged(field, restored, current)) continue;
                restored.WriteField(field, string.Empty);
                dropped.Add(Describe(field));
            }

            foreach (var kind in new[] { Kind.Sonarr, Kind.Radarr })
            {
                var rows = ArrRegistryMigration.Parse(InstancesJson(restored, kind));
                if (rows == null) continue;
                var currentById = (ArrRegistryMigration.Parse(InstancesJson(current, kind)) ?? new List<ArrInstance>())
                    .Where(r => ArrRegistryMigration.IsValidId(r.Id))
                    .GroupBy(r => r.Id, StringComparer.OrdinalIgnoreCase)
                    .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);
                var changed = false;
                foreach (var row in rows)
                {
                    if (!ArrRegistryMigration.IsValidId(row.Id) || !IsDangling(row.ApiKey)) continue;
                    var name = SecretsStore.ArrKeyName(row.Id);
                    if (trusted.Contains(name)) continue;
                    if (currentById.TryGetValue(row.Id, out var before) && SameServerOrUrl(before.Url, row.Url)) continue;
                    row.ApiKey = string.Empty;
                    dropped.Add(Describe(name));
                    changed = true;
                }
                if (changed) SetInstancesJson(restored, kind, ArrRegistryMigration.Serialize(rows));
            }
            return dropped;
        }

        /// <summary>
        /// Writes every stored credential back into <paramref name="config"/> as plain text (the
        /// pre-migration layout, including the legacy Sonarr/Radarr key mirrors of the first instance)
        /// so an older JE version can read it. The store is left intact. Returns how many values were
        /// restored. The caller saves the configuration. Throws
        /// <see cref="SecretsStoreUnavailableException"/> when the store can't be read (writing the
        /// configuration then would replace every placeholder with nothing).
        /// </summary>
        public static int Rollback(PluginConfiguration config, SecretsStore store)
        {
            if (!store.IsAvailable)
                throw new SecretsStoreUnavailableException($"{SecretsStore.FileName} can't be read ({store.UnavailableReason}); fix or restore it first.");

            var restored = 0;
            foreach (var field in PluginConfiguration.StoredSecretFields)
            {
                var text = config.ReadField(field);
                var real = Resolve(text, field, store);
                if (real.Length == 0 && IsDangling(text)) continue;   // keep it: restoring the file brings it back
                if (!string.Equals(real, text, StringComparison.Ordinal))
                {
                    config.WriteField(field, real);
                    if (!string.IsNullOrEmpty(real)) restored++;
                }
            }

            foreach (var kind in new[] { Kind.Sonarr, Kind.Radarr })
            {
                var json = InstancesJson(config, kind);
                var rows = ArrRegistryMigration.Parse(json);
                if (rows == null)
                {
                    var original = string.Equals(json, CorruptListMarker, StringComparison.Ordinal) ? store.Get(CorruptListStoreName(ListProperty(kind))) : null;
                    if (original != null) SetInstancesJson(config, kind, original);
                    continue;
                }
                foreach (var row in rows)
                {
                    var real = Resolve(row.ApiKey, ArrRegistryMigration.IsValidId(row.Id) ? SecretsStore.ArrKeyName(row.Id) : null, store);
                    if (real.Length == 0 && IsDangling(row.ApiKey)) continue;
                    if (!string.IsNullOrEmpty(real) && real != row.ApiKey) restored++;
                    row.ApiKey = real;
                }
                SetInstancesJson(config, kind, ArrRegistryMigration.Serialize(rows));

                // Older versions mirror the first instance into the legacy single-instance fields.
                var first = rows.FirstOrDefault(r => !string.IsNullOrEmpty(r.ApiKey) && !SecretValue.IsPlaceholder(r.ApiKey));
                if (first != null)
                {
                    if (kind == Kind.Sonarr) { config.SonarrUrl = first.Url; config.SonarrApiKey = first.ApiKey; }
                    else { config.RadarrUrl = first.Url; config.RadarrApiKey = first.ApiKey; }
                }
            }

            return restored;
        }

        // Start-up rule for one stored value: raw -> store + mask; mask -> re-mask from the store (kept
        // as is and reported when the store doesn't have it); empty, handles and clear tokens -> none.
        private static Slot MigrateSlot(Work work, string storeName, string? value)
        {
            var slot = work.Add(storeName);
            if (string.IsNullOrEmpty(value) || SecretValue.IsClear(value) || SecretValue.IsHandle(value))
            {
                // The configuration is the authority on whether a credential is set at all.
                return slot;
            }

            if (SecretValue.IsPlaceholder(value))
            {
                var stored = work.Store.Get(storeName);
                if (stored == null)
                {
                    work.Report.Missing.Add(Describe(storeName));
                    slot.Keep = value;
                }
                else
                {
                    slot.Real = stored;
                }
                return slot;
            }

            slot.Real = value.Trim();
            slot.New = true;
            return slot;
        }

        // Save rule: blank/placeholder = unchanged (unless the server changed), clear token = remove,
        // handle = resolve (or unchanged when it can't be), anything else = the new value.
        private static Slot MergeSlot(Work work, string storeName, string? incoming, string? currentText, bool serverChanged, string? targetUrl)
        {
            var slot = work.Add(storeName);
            incoming = SecretValue.FromWire(incoming);
            if (SecretValue.IsClear(incoming))
            {
                return slot;
            }

            if (SecretValue.IsHandle(incoming))
            {
                var imported = work.Store.ResolvePending(incoming, targetUrl);
                if (imported != null)
                {
                    slot.Real = imported;
                    slot.New = true;
                    return slot;
                }
                work.Report.NeedsReentry.Add(Describe(storeName));
                work.Report.Notes.Add($"The key imported from Seerr for {Describe(storeName)} could not be used (the import expired, or the address no longer matches the server it was imported for); enter the key and save again.");
            }
            else if (!string.IsNullOrWhiteSpace(incoming) && !SecretValue.IsPlaceholder(incoming))
            {
                slot.Real = incoming.Trim();
                slot.New = true;
                return slot;
            }

            // Unchanged: keep what is saved, but only for the server it was saved for.
            var currentReal = Resolve(currentText, storeName, work.Store);
            var dangling = currentReal.Length == 0 && IsDangling(currentText);
            if (serverChanged && (currentReal.Length > 0 || dangling))
            {
                work.Report.NeedsReentry.Add(Describe(storeName));
                work.Report.Notes.Add($"The saved {Describe(storeName)} was not kept because its server address changed; enter the key for the new address.");
            }
            else if (dangling)
            {
                slot.Keep = currentText;
            }
            else
            {
                slot.Real = currentReal;
            }
            return slot;
        }

        // Legacy single-instance fields. The old reader ignores rows without a URL and key, and when
        // none is left it uses the legacy URL + key pair. Same here: without a usable row, the legacy
        // pair fills the key-less row for that address or becomes a new row (exactly what the old
        // fallback synthesised). Once a row holds a usable key the legacy key is never read, so it is
        // not stored at all; until then it is kept.
        private static void FoldLegacy(Work work, PluginConfiguration config, Kind kind, List<ArrInstance> rows, Dictionary<ArrInstance, Slot> slots, Slot legacy)
        {
            bool Usable(ArrInstance r) => !string.IsNullOrWhiteSpace(r.Url) && slots[r].Keep == null && slots[r].Real.Length > 0;
            var legacyUrl = ((kind == Kind.Sonarr ? config.SonarrUrl : config.RadarrUrl) ?? string.Empty).Trim();
            var legacyKey = legacy.Keep == null ? legacy.Real.Trim() : string.Empty;

            if (!rows.Any(Usable) && legacyUrl.Length > 0 && legacyKey.Length > 0)
            {
                var target = rows.FirstOrDefault(r => ArrRegistryMigration.SameUrl(r.Url, legacyUrl));
                if (target != null)
                {
                    var slot = slots[target];
                    slot.Keep = null;
                    slot.Real = legacyKey;
                    slot.New = legacy.New;
                    if (string.IsNullOrEmpty(target.UrlMappings)) target.UrlMappings = (kind == Kind.Sonarr ? config.SonarrUrlMappings : config.RadarrUrlMappings) ?? string.Empty;
                    work.Report.Notes.Add($"The {kind} instance at the legacy address had no usable key; it now uses the legacy {LegacyKeyField(kind)}.");
                }
                else
                {
                    var row = new ArrInstance
                    {
                        Id = ArrRegistryMigration.NewId(),
                        Name = kind.ToString(),
                        Url = legacyUrl,
                        UrlMappings = (kind == Kind.Sonarr ? config.SonarrUrlMappings : config.RadarrUrlMappings) ?? string.Empty,
                    };
                    var slot = work.Add(SecretsStore.ArrKeyName(row.Id));
                    slot.Real = legacyKey;
                    slot.New = legacy.New;
                    rows.Add(row);
                    slots[row] = slot;
                    work.Report.Notes.Add($"Moved the legacy single {kind} connection into the instance list.");
                }
            }

            if (rows.Any(Usable) && (legacy.Keep != null || legacy.Real.Length > 0 || work.Store.Get(legacy.StoreName) != null))
            {
                legacy.Keep = null;
                legacy.Real = string.Empty;
                legacy.New = false;
                work.Report.Notes.Add($"Dropped the legacy {LegacyKeyField(kind)} copy: the {kind} instance list holds the key.");
            }
        }

        // True when an unchanged credential would now go to another server than the one it was saved
        // for. Credentials without an address (TMDB, MDBList, analytics) never change server.
        private static bool FlatServerChanged(string field, PluginConfiguration incoming, PluginConfiguration current)
        {
            var address = Address(field);
            if (address == null) return false;
            var saved = SplitUrls(address(current));
            return SplitUrls(address(incoming)).Any(url => !saved.Any(s => SameServerOrUrl(s, url)));
        }

        // The address setting a flat credential belongs to, or null (TMDB, MDBList, analytics).
        private static Func<PluginConfiguration, string?>? Address(string field) => field switch
        {
            nameof(PluginConfiguration.JellyseerrApiKey) => c => c.JellyseerrUrls,
            nameof(PluginConfiguration.ShokoApiKey) => c => c.ShokoUrl,
            nameof(PluginConfiguration.SonarrApiKey) => c => c.SonarrUrl,
            nameof(PluginConfiguration.RadarrApiKey) => c => c.RadarrUrl,
            _ => null,
        };

        private static List<string> SplitUrls(string? urls)
            => (urls ?? string.Empty).Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();

        private static bool SameServerOrUrl(string? a, string? b) => ArrRegistryMigration.SameUrl(a, b) || SecretsStore.SameServer(a, b);

        // A mask (not a handle) whose value the store does not have.
        private static bool IsDangling(string? text) => SecretValue.IsPlaceholder(text) && !SecretValue.IsHandle(text);

        // ResolveStoredValue against an explicit store (the plugin singleton may not be wired yet).
        private static string Resolve(string? value, string? storeName, SecretsStore store)
        {
            if (string.IsNullOrEmpty(value) || SecretValue.IsClear(value) || SecretValue.IsHandle(value)) return string.Empty;
            if (!SecretValue.IsPlaceholder(value)) return value;
            return storeName == null ? string.Empty : store.Get(storeName) ?? string.Empty;
        }

        private static string LegacyKeyField(Kind kind)
            => kind == Kind.Sonarr ? nameof(PluginConfiguration.SonarrApiKey) : nameof(PluginConfiguration.RadarrApiKey);

        private static string ListProperty(Kind kind)
            => kind == Kind.Sonarr ? nameof(PluginConfiguration.SonarrInstances) : nameof(PluginConfiguration.RadarrInstances);

        private static string InstancesJson(PluginConfiguration config, Kind kind)
            => (kind == Kind.Sonarr ? config.SonarrInstances : config.RadarrInstances) ?? string.Empty;

        private static void SetInstancesJson(PluginConfiguration config, Kind kind, string json)
        {
            if (kind == Kind.Sonarr) config.SonarrInstances = json;
            else config.RadarrInstances = json;
        }

        private static string Describe(string storeName)
            => storeName.StartsWith(SecretsStore.ArrKeyPrefix, StringComparison.Ordinal) ? "arr instance key " + storeName.Substring(SecretsStore.ArrKeyPrefix.Length) : storeName;
    }
}
