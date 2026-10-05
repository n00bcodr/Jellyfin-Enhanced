// Unit-style checks for the Native Poster Tags pipeline. See the .csproj for how to run.
using System.Collections.Concurrent;
using System.Diagnostics;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using SkiaSharp;

var failures = 0;
var passes = 0;
void Check(string name, bool ok, string? detail = null)
{
    if (ok) passes++;
    else failures++;
    Console.WriteLine((ok ? "PASS " : "FAIL ") + name + (!ok && detail != null ? "  -- " + detail : string.Empty));
}

var tmp = Path.Combine(Path.GetTempPath(), "pt-harness-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(tmp);
try
{
    TagDecoration();
    Tokens();
    ClientPolicy();
    UserPreference();
    await CacheAsync();
    Completeness();
    await FileSettleAsync();
}
finally
{
    Directory.Delete(tmp, true);
}

Console.WriteLine($"\n{passes}/{passes + failures} passed");
return failures == 0 ? 0 : 1;

// ---------------------------------------------------------------------------
void TagDecoration()
{
    const string baseTag = "858d69cd25511481095b6268e28cc3c4";
    const string sb = "d1475199";
    const string jet = "1a1b2c3d4e5f60718293a4b";   // 23 hex
    const string jet2 = "0ffffff0123456789abcdef";
    const string jeu = "56258bc9b6e0";               // 12 hex
    const string jeu2 = "0123456789ab";

    // Parse every permutation of the optional parts and round-trip it.
    foreach (var cb in new[] { null, sb })
    foreach (var v in new[] { null, jet })
    foreach (var m in new[] { null, jeu })
    {
        var parts = new ImageTagParts(cb, baseTag, v, m);
        var composed = ImageTagDecoration.Compose(parts);
        var parsed = ImageTagDecoration.Parse(composed);
        Check($"parse/compose round trip [{(cb != null ? "sb " : "")}{(v != null ? "jet " : "")}{(m != null ? "jeu" : "")}]", parsed == parts, $"{composed} -> {parsed}");
        Check($"StripAll -> base [{composed}]", ImageTagDecoration.StripAll(composed) == baseTag);

        // Spoiler Guard's own readers keep working on the composed shape:
        // trailing marker parse, idempotent append, "sb-" prefix test, and the
        // identity filter's prefix strip used for blurhash fallback.
        var hasMarker = SpoilerIdentityService.TryParseMarker(composed, out var withoutMarker, out var marker);
        Check($"TryParseMarker [{composed}]", hasMarker == (m != null) && (!hasMarker || (marker == m && !withoutMarker.EndsWith(m!))));
        if (m != null)
        {
            Check($"AppendMarker idempotent [{composed}]", ReferenceEquals(SpoilerIdentityService.AppendMarker(composed, jeu2), composed));
        }

        Check($"sb- prefix detection [{composed}]", composed.StartsWith("sb-", StringComparison.Ordinal) == (cb != null));
        if (cb != null)
        {
            Check($"identity filter prefix strip [{composed}]", SpoilerTryStripCacheBustPrefix(composed) == ImageTagDecoration.Compose(parts with { CacheBust = null }));
        }
    }

    // WithVariant: insert, idempotent, replace, keep prefix, -jet lands before -jeu.
    var plain = ImageTagDecoration.WithVariant(baseTag, jet, jeu);
    Check("WithVariant on a plain tag", plain == $"{baseTag}-jet{jet}-jeu{jeu}", plain);
    Check("WithVariant idempotent (same instance)", ReferenceEquals(ImageTagDecoration.WithVariant(plain, jet, jeu), plain));
    var replaced = ImageTagDecoration.WithVariant(plain, jet2, jeu);
    Check("WithVariant replaces an existing token", replaced == $"{baseTag}-jet{jet2}-jeu{jeu}", replaced);
    var withSpoilerMarker = $"sb-{sb}-{baseTag}-jeu{jeu}";
    var inserted = ImageTagDecoration.WithVariant(withSpoilerMarker, jet, jeu);
    Check("WithVariant inserts before an existing -jeu and keeps sb-", inserted == $"sb-{sb}-{baseTag}-jet{jet}-jeu{jeu}", inserted);
    var remarked = ImageTagDecoration.WithVariant(inserted, jet, jeu2);
    Check("WithVariant replaces the marker, never duplicates it", remarked == $"sb-{sb}-{baseTag}-jet{jet}-jeu{jeu2}", remarked);
    Check("field-strip prefixing after stamping still parses", ImageTagDecoration.Parse("sb-" + sb + "-" + plain) == new ImageTagParts(sb, baseTag, jet, jeu));

    // Malformed inputs are never mistaken for decoration.
    Check("GetVariant: none", ImageTagDecoration.GetVariant(baseTag) == null);
    Check("GetVariant: found", ImageTagDecoration.GetVariant(plain) == jet);
    Check("GetVariant: uppercase hex rejected", ImageTagDecoration.GetVariant($"{baseTag}-jet{jet.ToUpperInvariant()}-jeu{jeu}") == null);
    Check("GetVariant: short token rejected", ImageTagDecoration.GetVariant($"{baseTag}-jet{jet[..22]}-jeu{jeu}") == null);
    Check("GetVariant: token not before -jeu rejected", ImageTagDecoration.GetVariant($"{baseTag}-jet{jet}x-jeu{jeu}") == null);
    Check("Parse: token alone is not a tag", ImageTagDecoration.Parse("-jet" + jet).Variant == null);
    Check("Parse: null/empty", ImageTagDecoration.Parse(null).Base == string.Empty && ImageTagDecoration.Parse(string.Empty).Base == string.Empty);
    Check("Parse: non-hex sb- token is base", ImageTagDecoration.Parse($"sb-zzzzzzzz-{baseTag}").CacheBust == null);
}

// Mirror of SpoilerIdentityTagFilter.TryStripCacheBustPrefix (private there).
static string? SpoilerTryStripCacheBustPrefix(string tag)
{
    const int prefixLen = 12;
    if (tag.Length <= prefixLen) return null;
    if (!tag.StartsWith("sb-", StringComparison.Ordinal)) return null;
    if (tag[prefixLen - 1] != '-') return null;
    return tag.Substring(prefixLen);
}

// ---------------------------------------------------------------------------
void Tokens()
{
    var warnings = new List<string>();
    var secretPath = Path.Combine(tmp, "native-poster-tags.key");
    var tokens = PosterTagVariantToken.CreateForPath(secretPath, warnings.Add);
    var user = Guid.NewGuid();
    var otherUser = Guid.NewGuid();
    var item = Guid.NewGuid();
    var otherItem = Guid.NewGuid();
    const string digest = "0123456789abcdef";
    const string version = "1";

    var token = tokens.Mint(user, item, digest, version, PosterTagVariantFlags.TopRightOffset, "a1b2c3");
    Check("token is 23 lowercase hex", token.Length == ImageTagDecoration.VariantHexLength && token.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f'), token);
    Check("secret created with 32 bytes", File.Exists(secretPath) && new FileInfo(secretPath).Length == 32);
    if (!OperatingSystem.IsWindows())
    {
        var mode = File.GetUnixFileMode(secretPath);
        Check("secret mode 0600", mode == (UnixFileMode.UserRead | UnixFileMode.UserWrite), mode.ToString());
    }

    Check("verify: valid", tokens.Verify(token, user, item, digest, version, out var parsed) && parsed.Flags == PosterTagVariantFlags.TopRightOffset && parsed.DataHash == "a1b2c3" && !parsed.IsWeak);
    Check("verify: other user", !tokens.Verify(token, otherUser, item, digest, version, out _));
    Check("verify: other item", !tokens.Verify(token, user, otherItem, digest, version, out _));
    Check("verify: settings changed", !tokens.Verify(token, user, item, "fedcba9876543210", version, out _));
    Check("verify: renderer version changed", !tokens.Verify(token, user, item, digest, "2", out _));
    // The live pipeline mints and verifies against PosterTagComposer.PixelVersion, which carries both the
    // renderer and the composition version, so bumping either retires issued URLs.
    Check("PixelVersion = renderer version + composition version",
        PosterTagComposer.PixelVersion == Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering.PosterTagRenderer.Version + "." + PosterTagComposer.CompositionVersion,
        PosterTagComposer.PixelVersion);
    var pixelToken = tokens.Mint(user, item, digest, PosterTagComposer.PixelVersion, PosterTagVariantFlags.None, "a1b2c3");
    Check("verify: composition version bump rejects the token",
        tokens.Verify(pixelToken, user, item, digest, PosterTagComposer.PixelVersion, out _)
        && !tokens.Verify(pixelToken, user, item, digest, Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering.PosterTagRenderer.Version + ".999", out _));
    Check("verify: flags tampered", !tokens.Verify("3" + token[1..], user, item, digest, version, out _) && !tokens.Verify("0" + token[1..], user, item, digest, version, out _));
    Check("verify: data hash tampered", !tokens.Verify(token[..1] + "a1b2c4" + token[7..], user, item, digest, version, out _));
    for (var i = 7; i < token.Length; i++)
    {
        var flipped = token[..i] + (token[i] == '0' ? '1' : '0') + token[(i + 1)..];
        if (tokens.Verify(flipped, user, item, digest, version, out _))
        {
            Check($"verify: MAC char {i} tampered", false);
        }
    }
    Check("verify: every single-char MAC tamper rejected", true);
    Check("parse: unknown flag bits rejected", !PosterTagVariantToken.TryParse("4" + token[1..], out _) && !PosterTagVariantToken.TryParse("8" + token[1..], out _));
    Check("parse: wrong length / uppercase rejected", !PosterTagVariantToken.TryParse(token[..22], out _) && !PosterTagVariantToken.TryParse(token.ToUpperInvariant(), out _) && !PosterTagVariantToken.TryParse(null, out _));
    var weak = tokens.Mint(user, item, digest, version, PosterTagVariantFlags.None, PosterTagVariantToken.WeakDataHash);
    Check("weak token parses as weak", PosterTagVariantToken.TryParse(weak, out var weakParsed) && weakParsed.IsWeak);
    var threw = false;
    try { tokens.Mint(user, item, digest, version, PosterTagVariantFlags.None, "ABCDEF"); }
    catch (ArgumentException) { threw = true; }
    Check("mint rejects a malformed data hash", threw);

    // A new instance (restart) reads the same secret: issued URLs stay valid.
    var restarted = PosterTagVariantToken.CreateForPath(secretPath, warnings.Add);
    Check("secret persists across instances", restarted.Verify(token, user, item, digest, version, out _));
    // A damaged secret is replaced (old URLs then fail closed), with a warning.
    File.WriteAllBytes(secretPath, new byte[5]);
    var replaced = PosterTagVariantToken.CreateForPath(secretPath, warnings.Add);
    Check("damaged secret replaced; old tokens rejected", !replaced.Verify(token, user, item, digest, version, out _) && new FileInfo(secretPath).Length == 32 && warnings.Count > 0);
    // Pure MAC function is deterministic and secret-dependent.
    var s1 = new byte[32];
    var s2 = new byte[32];
    s2[0] = 1;
    Check("ComputeMac deterministic and keyed",
        PosterTagVariantToken.ComputeMac(s1, user, item, digest, version, "0", "000000") == PosterTagVariantToken.ComputeMac(s1, user, item, digest, version, "0", "000000")
        && PosterTagVariantToken.ComputeMac(s1, user, item, digest, version, "0", "000000") != PosterTagVariantToken.ComputeMac(s2, user, item, digest, version, "0", "000000"));

    // Concurrent first use creates exactly one secret.
    var racePath = Path.Combine(tmp, "race.key");
    var racers = Enumerable.Range(0, 16).Select(_ => PosterTagVariantToken.CreateForPath(racePath, warnings.Add)).ToArray();
    var minted = new ConcurrentBag<string>();
    Parallel.ForEach(racers, r => minted.Add(r.Mint(user, item, digest, version, PosterTagVariantFlags.None, "abcdef")));
    var survivor = PosterTagVariantToken.CreateForPath(racePath, warnings.Add);
    Check("racing instances: on-disk secret verifies a token from the winner", minted.Any(t => survivor.Verify(t, user, item, digest, version, out _)));
    Check("racing instances: no temp files left", Directory.GetFiles(tmp, "race.key.tmp.*").Length == 0);
}

// ---------------------------------------------------------------------------
void ClientPolicy()
{
    var builtIn = NativeClientPolicy.ParseWebClientNames(null);
    foreach (var web in NativeClientPolicy.BuiltInWebClients)
    {
        Check($"web client skipped: {web}", !NativeClientPolicy.IsNativeClient(web, builtIn));
    }

    foreach (var native in new[] { "Jellyfin for Android TV", "Jellyfin for Tizen", "Swiftfin", "Findroid", "Streamyfin", "Jellyfin Roku", "Kodi" })
    {
        Check($"native client stamped: {native}", NativeClientPolicy.IsNativeClient(native, builtIn));
    }

    Check("exact match, not prefix: 'Jellyfin Web Beta' is native", NativeClientPolicy.IsNativeClient("Jellyfin Web Beta", builtIn));
    Check("case-insensitive exact match", !NativeClientPolicy.IsNativeClient("jellyfin web", builtIn));
    Check("surrounding whitespace ignored", !NativeClientPolicy.IsNativeClient("  Jellyfin Web ", builtIn));
    Check("empty/unknown client name is never stamped", !NativeClientPolicy.IsNativeClient(null, builtIn) && !NativeClientPolicy.IsNativeClient("  ", builtIn));
    var extras = NativeClientPolicy.ParseWebClientNames("My Shell\r\n Fork Desktop ,, Kiosk\n");
    Check("admin extras: newline/comma separated, trimmed", !NativeClientPolicy.IsNativeClient("My Shell", extras) && !NativeClientPolicy.IsNativeClient("Fork Desktop", extras) && !NativeClientPolicy.IsNativeClient("Kiosk", extras));
    Check("admin extras keep built-ins", !NativeClientPolicy.IsNativeClient("Jellyfin Web", extras) && NativeClientPolicy.IsNativeClient("Jellyfin for Android TV", extras));
}

// ---------------------------------------------------------------------------
void UserPreference()
{
    // Master switch on: every user is on unless they switched it off (null/missing = on).
    var on = new PluginConfiguration { NativePosterTagsEnabled = true };
    var off = new PluginConfiguration { NativePosterTagsEnabled = false };
    bool Native(string? json, PluginConfiguration cfg) => PosterTagSettings.FromSettingsJson(json, cfg).NativeEnabled;
    Check("preference: no settings.json = on", Native(null, on));
    Check("preference: key missing = on", Native("{\"QualityTagsEnabled\":true}", on));
    Check("preference: null = on", Native("{\"UseNativePosterTags\":null}", on));
    Check("preference: true = on", Native("{\"UseNativePosterTags\":true}", on));
    Check("preference: false = off", !Native("{\"UseNativePosterTags\":false}", on));
    Check("preference: camelCase false = off", !Native("{\"useNativePosterTags\":false}", on));
    Check("preference: unreadable file = on", Native(string.Empty, on));
    Check("master switch off wins over true", !Native("{\"UseNativePosterTags\":true}", off) && !Native(null, off));
    Check("preference not in the digest",
        PosterTagSettings.FromSettingsJson("{\"UseNativePosterTags\":true}", on).Digest == PosterTagSettings.FromSettingsJson("{\"UseNativePosterTags\":null}", on).Digest);
}

// ---------------------------------------------------------------------------
async Task CacheAsync()
{
    var warnings = new ConcurrentBag<string>();

    // LRU by bytes (each entry costs its length + a fixed overhead, 256 bytes).
    const int entryOverhead = 256;
    var lru = CompositeImageCache.Create(null, 3 * (1000 + entryOverhead), 0, 2, TimeSpan.FromSeconds(5), warnings.Add);
    foreach (var k in new[] { "aa1", "aa2", "aa3" })
    {
        await lru.GetOrCreateAsync(k, ".jpg", () => Task.FromResult(new byte[1000]), CancellationToken.None);
    }

    Check("LRU holds up to budget", lru.MemoryCount == 3 && lru.MemoryBytes == 3 * (1000 + entryOverhead), $"{lru.MemoryCount}/{lru.MemoryBytes}");
    lru.TryGetMemory("aa1", out _); // aa1 becomes most recent
    await lru.GetOrCreateAsync("aa4", ".jpg", () => Task.FromResult(new byte[1000]), CancellationToken.None);
    Check("LRU evicts least recently used", lru.TryGetMemory("aa1", out _) && !lru.TryGetMemory("aa2", out _) && lru.TryGetMemory("aa4", out _));
    await lru.GetOrCreateAsync("big", ".jpg", () => Task.FromResult(new byte[10_000]), CancellationToken.None);
    Check("oversize value served but not cached", !lru.TryGetMemory("big", out _) && lru.MemoryCount == 3);
    var passthrough = await lru.GetOrCreateAsync("pt1", ".jpg", () => Task.FromResult(CompositeImageCache.Passthrough), CancellationToken.None);
    Check("passthrough (empty) cached as such", passthrough.Length == 0 && lru.TryGetMemory("pt1", out var ptHit) && ptHit.Length == 0);

    // A flood of distinct passthrough keys is bounded by the memory budget
    // (each costs the fixed overhead) and never reaches the disk tier.
    var floodDir = Path.Combine(tmp, "flood");
    var flood = CompositeImageCache.Create(floodDir, 3 * (1000 + entryOverhead), 1 << 20, 2, TimeSpan.FromSeconds(5), warnings.Add);
    for (var i = 0; i < 1000; i++)
    {
        await flood.GetOrCreateAsync(i.ToString("x4") + new string('d', 60), ".jpg", () => Task.FromResult(CompositeImageCache.Passthrough), CancellationToken.None);
    }

    Check("passthrough flood bounded in memory", flood.MemoryCount <= 3 * (1000 + entryOverhead) / entryOverhead && flood.MemoryBytes <= 3 * (1000 + entryOverhead), $"{flood.MemoryCount}/{flood.MemoryBytes}");
    Check("1000 passthrough keys create no disk files", !Directory.Exists(floodDir) || Directory.GetFiles(floodDir, "*", SearchOption.AllDirectories).Length == 0);

    // Coalescing: identical concurrent misses share one render.
    var calls = 0;
    var gate = new TaskCompletionSource();
    var coalesce = CompositeImageCache.Create(null, 1 << 20, 0, 4, TimeSpan.FromSeconds(5), warnings.Add);
    async Task<byte[]> SlowRender()
    {
        Interlocked.Increment(ref calls);
        await gate.Task;
        return new byte[] { 1, 2, 3 };
    }

    var waiters = Enumerable.Range(0, 32).Select(_ => coalesce.GetOrCreateAsync("same", ".jpg", SlowRender, CancellationToken.None)).ToArray();
    gate.SetResult();
    var all = await Task.WhenAll(waiters);
    Check("32 concurrent misses -> 1 render, same bytes", calls == 1 && all.All(b => b.SequenceEqual(new byte[] { 1, 2, 3 })), $"calls={calls}");

    // A waiter giving up does not cancel the render the others wait for.
    var gate2 = new TaskCompletionSource();
    var calls2 = 0;
    async Task<byte[]> SlowRender2()
    {
        Interlocked.Increment(ref calls2);
        await gate2.Task;
        return new byte[] { 9 };
    }

    using var leaving = new CancellationTokenSource();
    var leaver = coalesce.GetOrCreateAsync("abandon", ".jpg", SlowRender2, leaving.Token);
    var stayer = coalesce.GetOrCreateAsync("abandon", ".jpg", SlowRender2, CancellationToken.None);
    leaving.Cancel();
    var leaverCancelled = false;
    try { await leaver; }
    catch (OperationCanceledException) { leaverCancelled = true; }
    gate2.SetResult();
    var stayed = await stayer;
    Check("cancelled waiter leaves; render completes for the rest", leaverCancelled && stayed.SequenceEqual(new byte[] { 9 }) && calls2 == 1);

    // Failures propagate to every waiter and are NOT cached.
    var failCalls = 0;
    var failureGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    async Task<byte[]> Failing()
    {
        Interlocked.Increment(ref failCalls);
        await failureGate.Task;
        throw new InvalidOperationException("boom");
    }

    var failedWaiters = Enumerable.Range(0, 8).Select(_ => coalesce.GetOrCreateAsync("fails", ".jpg", Failing, CancellationToken.None)).ToArray();
    failureGate.SetResult();
    var allFailed = 0;
    foreach (var w in failedWaiters)
    {
        try { await w; }
        catch (InvalidOperationException) { allFailed++; }
    }

    var retried = await coalesce.GetOrCreateAsync("fails", ".jpg", () => Task.FromResult(new byte[] { 7 }), CancellationToken.None);
    Check("failure reaches all waiters, one attempt", allFailed == 8 && failCalls == 1, $"failed={allFailed} calls={failCalls}");
    Check("failure not cached: next request re-renders", retried.SequenceEqual(new byte[] { 7 }));

    // Render concurrency is bounded.
    var bounded = CompositeImageCache.Create(null, 1 << 20, 0, 2, TimeSpan.FromSeconds(10), warnings.Add);
    var running = 0;
    var maxRunning = 0;
    var twoStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var renderGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    async Task<byte[]> Tracked()
    {
        var now = Interlocked.Increment(ref running);
        int seen;
        while ((seen = Volatile.Read(ref maxRunning)) < now && Interlocked.CompareExchange(ref maxRunning, now, seen) != seen) { }
        if (now >= 2) twoStarted.TrySetResult();
        await renderGate.Task;
        Interlocked.Decrement(ref running);
        return new byte[] { 1 };
    }

    var boundedTasks = Enumerable.Range(0, 12).Select(i => bounded.GetOrCreateAsync("k" + i, ".jpg", Tracked, CancellationToken.None)).ToArray();
    try { await twoStarted.Task.WaitAsync(TimeSpan.FromSeconds(10)); }
    finally { renderGate.TrySetResult(); }
    await Task.WhenAll(boundedTasks);
    Check("at most N renders at once", maxRunning == 2, $"max={maxRunning}");

    // A render slot that never frees up times out (caller then serves the original).
    var starved = CompositeImageCache.Create(null, 1 << 20, 0, 1, TimeSpan.FromMilliseconds(100), warnings.Add);
    var hold = new TaskCompletionSource();
    var holder = starved.GetOrCreateAsync("holder", ".jpg", async () => { await hold.Task; return new byte[] { 1 }; }, CancellationToken.None);
    var timedOut = false;
    try { await starved.GetOrCreateAsync("starved", ".jpg", () => Task.FromResult(new byte[] { 2 }), CancellationToken.None); }
    catch (TimeoutException) { timedOut = true; }
    hold.SetResult();
    await holder;
    Check("render slot wait times out", timedOut);

    // Disk tier: composites survive a "restart", passthrough stays memory-only
    // (re-decided after a restart), no temp files.
    var diskDir = Path.Combine(tmp, "poster-tags");
    var disk1 = CompositeImageCache.Create(diskDir, 1 << 20, 1 << 20, 2, TimeSpan.FromSeconds(5), warnings.Add);
    var keyA = new string('a', 64);
    var keyP = new string('b', 64);
    await disk1.GetOrCreateAsync(keyA, ".png", () => Task.FromResult(new byte[] { 5, 6, 7 }), CancellationToken.None);
    await disk1.GetOrCreateAsync(keyP, ".png", () => Task.FromResult(CompositeImageCache.Passthrough), CancellationToken.None);
    await WaitUntil(() => File.Exists(Path.Combine(diskDir, "aa", keyA + ".png")));
    Check("disk file written under {k[0..2]}/{k}{ext}", File.Exists(Path.Combine(diskDir, "aa", keyA + ".png")));
    Check("passthrough not written to disk", !File.Exists(Path.Combine(diskDir, "bb", keyP + ".png")));
    var disk2 = CompositeImageCache.Create(diskDir, 1 << 20, 1 << 20, 2, TimeSpan.FromSeconds(5), warnings.Add);
    var factoryRanA = false;
    var factoryRanP = false;
    var fromDisk = await disk2.GetOrCreateAsync(keyA, ".png", () => { factoryRanA = true; return Task.FromResult(new byte[] { 0 }); }, CancellationToken.None);
    var ptAgain = await disk2.GetOrCreateAsync(keyP, ".png", () => { factoryRanP = true; return Task.FromResult(CompositeImageCache.Passthrough); }, CancellationToken.None);
    Check("disk hit after restart (no render)", !factoryRanA && fromDisk.SequenceEqual(new byte[] { 5, 6, 7 }));
    Check("passthrough re-decided after restart", factoryRanP && ptAgain.Length == 0);
    // An existing zero-length file (older layout) still reads as passthrough.
    Directory.CreateDirectory(Path.Combine(diskDir, "bb"));
    File.WriteAllBytes(Path.Combine(diskDir, "bb", keyP + ".png"), Array.Empty<byte>());
    var disk3 = CompositeImageCache.Create(diskDir, 1 << 20, 1 << 20, 2, TimeSpan.FromSeconds(5), warnings.Add);
    var legacyRan = false;
    var legacy = await disk3.GetOrCreateAsync(keyP, ".png", () => { legacyRan = true; return Task.FromResult(new byte[] { 1 }); }, CancellationToken.None);
    Check("legacy zero-length disk file reads as passthrough", !legacyRan && legacy.Length == 0);
    Check("no temp files left in the disk tier", Directory.GetFiles(diskDir, "*.tmp.*", SearchOption.AllDirectories).Length == 0);

    // Disk cap: every file is charged at least one 4096-byte block, so 30
    // small files blow a 10-block budget and the oldest are trimmed to 80% of
    // it (8 blocks). Without the per-file charge 30 x 1000 bytes would fit.
    const long diskBlock = 4096;
    var capDir = Path.Combine(tmp, "capped");
    var capped = CompositeImageCache.Create(capDir, 1 << 20, 10 * diskBlock, 4, TimeSpan.FromSeconds(5), warnings.Add);
    for (var i = 0; i < 30; i++)
    {
        var k = i.ToString("x2") + new string('c', 62);
        await capped.GetOrCreateAsync(k, ".jpg", () => Task.FromResult(new byte[1000]), CancellationToken.None);
        await WaitUntil(() => File.Exists(Path.Combine(capDir, k[..2], k + ".jpg")));
    }

    await WaitUntil(() => Directory.GetFiles(capDir, "*.jpg", SearchOption.AllDirectories).Length <= 12);
    var remainingFiles = Directory.GetFiles(capDir, "*.jpg", SearchOption.AllDirectories).Length;
    Check("disk tier trimmed under its cap (per-file charge)", remainingFiles <= 12 && remainingFiles >= 1, $"{remainingFiles} files");
    Check("trim kept the newest file", File.Exists(Path.Combine(capDir, "1d", "1d" + new string('c', 62) + ".jpg")));
    Check("no cache warnings", warnings.IsEmpty, string.Join(" | ", warnings));
}

// ---------------------------------------------------------------------------
void Completeness()
{
    using var bitmap = new SKBitmap(64, 96);
    using (var canvas = new SKCanvas(bitmap))
    {
        canvas.Clear(SKColors.CornflowerBlue);
    }

    using var image = SKImage.FromBitmap(bitmap);
    foreach (var (format, contentType) in new[] { (SKEncodedImageFormat.Jpeg, "image/jpeg"), (SKEncodedImageFormat.Png, "image/png"), (SKEncodedImageFormat.Webp, "image/webp") })
    {
        using var data = image.Encode(format, 90);
        var bytes = data.ToArray();
        Check($"complete {contentType} accepted", PosterTagComposer.IsStructurallyComplete(bytes, contentType));
        Check($"truncated {contentType} rejected", !PosterTagComposer.IsStructurallyComplete(bytes.AsSpan(0, bytes.Length * 2 / 3), contentType));
        Check($"wrong type rejected for {contentType}", !PosterTagComposer.IsStructurallyComplete(bytes, contentType == "image/png" ? "image/jpeg" : "image/png"));
    }

    var jpeg = image.Encode(SKEncodedImageFormat.Jpeg, 90).ToArray();
    Check("JPEG with small trailing padding accepted", PosterTagComposer.IsStructurallyComplete(jpeg.Concat(new byte[16]).ToArray(), "image/jpeg"));
    Check("GIF never treated as composable", !PosterTagComposer.IsStructurallyComplete(new byte[] { 0x47, 0x49, 0x46, 0x38 }, "image/gif"));
}

// The settle wait before keying a composite on a cache file is bounded by a
// monotonic clock whatever the file timestamps say.
async Task FileSettleAsync()
{
    var path = Path.Combine(tmp, "settle.jpg");
    await File.WriteAllBytesAsync(path, new byte[] { 1, 2, 3 });

    async Task<(TimeSpan Elapsed, Exception? Error)> TimeWait(CancellationToken token = default)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            await PosterTagImageFilter.WaitForSettledFileAsync(path, token);
            return (sw.Elapsed, null);
        }
        catch (Exception ex)
        {
            return (sw.Elapsed, ex);
        }
    }

    File.SetLastWriteTimeUtc(path, DateTime.UtcNow.AddMinutes(-5));
    var settled = await TimeWait();
    Check("settle: an old file returns at once", settled.Error == null && settled.Elapsed < TimeSpan.FromMilliseconds(100), $"{settled.Elapsed} {settled.Error?.GetType().Name}");

    File.SetLastWriteTimeUtc(path, DateTime.UtcNow.AddHours(1));
    var future = await TimeWait();
    Check("settle: a future-dated file is accepted after one stable interval", future.Error == null && future.Elapsed < TimeSpan.FromSeconds(1), $"{future.Elapsed} {future.Error?.GetType().Name}");

    // A file that keeps changing gives up within the 3 s budget (plus slack).
    using var stop = new CancellationTokenSource();
    var toucher = Task.Run(async () =>
    {
        var i = 0;
        while (!stop.IsCancellationRequested)
        {
            File.SetLastWriteTimeUtc(path, DateTime.UtcNow.AddSeconds(++i % 2 == 0 ? 0 : 3600));
            await Task.Delay(10);
        }
    });
    var churning = await TimeWait();
    stop.Cancel();
    await toucher;
    Check("settle: a changing file fails within the budget", churning.Error is IOException && churning.Elapsed < TimeSpan.FromSeconds(3.5), $"{churning.Elapsed} {churning.Error?.GetType().Name}");

    File.SetLastWriteTimeUtc(path, DateTime.UtcNow.AddHours(1));
    using var aborted = new CancellationTokenSource(TimeSpan.FromMilliseconds(30));
    var cancelled = await TimeWait(aborted.Token);
    Check("settle: request abort cancels the wait", cancelled.Error is OperationCanceledException && cancelled.Elapsed < TimeSpan.FromMilliseconds(500), $"{cancelled.Elapsed} {cancelled.Error?.GetType().Name}");
}

// Bounded condition polling for asynchronous disk writes; no success is inferred from elapsed time.
static async Task WaitUntil(Func<bool> condition)
{
    var deadline = Stopwatch.StartNew();
    while (!condition())
    {
        if (deadline.Elapsed > TimeSpan.FromSeconds(10)) throw new TimeoutException("Poster pipeline disk operation did not settle");
        await Task.Delay(10);
    }
}
