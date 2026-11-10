using System.Net;
using System.Reflection;
using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Jellyfin.Extensions.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Newtonsoft.Json.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders;

namespace JE.Tests.Features.DetailsProviders;

// Requests pass through real routing, authentication, authorization, model binding and
// result execution, configured with Jellyfin's JsonDefaults, and reach real files.
[Collection("Plugin singleton")]
public class ElsewhereDocumentTests
{
    private const string FileName = "elsewhere.json";
    private const string User = "abcdefabcdefabcdefabcdefabcdefab";
    private const string OtherUser = "12345678123456781234567812345678";
    private const string FourFields = "{\"Region\":\"DE\",\"Regions\":[\"FR\"],\"Services\":[\"Hulu\"],\"SeasonProviders\":false}";

    // Numbers no CLR type can hold exactly, beside strings a date parser would rewrite.
    private const string ExtensionFields =
        "\"Future\":{\"keep\":\"exact\",\"list\":[1,null,true,{\"deep\":\"2024-01-02T03:04:05+09:30\"}]}," +
        "\"When\":\"2024-01-02T03:04:05Z\"," +
        "\"Huge\":900719925474099312345678901234567890," +
        "\"Over\":1e400," +
        "\"Under\":1e-400," +
        "\"Fine\":0.123456789012345678901234567890123456789";

    private static readonly string[] ExtensionNames = ["Future", "When", "Huge", "Over", "Under", "Fine"];

    private sealed class Activator(ApiPluginFixture fixture) : IControllerActivator
    {
        public object Create(ControllerContext context)
        {
            var controller = ApiAssetTests.Controller(context.ActionDescriptor.ControllerTypeInfo.AsType(), fixture.Core, fixture.Core.Manager);
            controller.ControllerContext = context;
            return controller;
        }

        public void Release(ControllerContext context, object controller) { }
    }

    private sealed class HeaderAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
        : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
    {
        protected override Task<AuthenticateResult> HandleAuthenticateAsync()
        {
            var user = Request.Headers["X-Test-User"].ToString();
            if (user.Length == 0) return Task.FromResult(AuthenticateResult.NoResult());
            var role = Request.Headers["X-Test-Admin"].Count > 0 ? "Administrator" : "User";
            var identity = new ClaimsIdentity([new Claim("Jellyfin-UserId", user), new Claim(ClaimTypes.Role, role)], Scheme.Name);
            return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), Scheme.Name)));
        }
    }

    private sealed class Host : IDisposable
    {
        private readonly ApiPluginFixture fixture = new();
        private readonly TestServer server;
        public List<(string User, string File)> Saved { get; } = [];
        public string Root => fixture.Core.ConfigRoot;
        public UserConfigurationManager Manager => fixture.Core.Manager;

        public Host()
        {
            Manager.UserConfigurationSaved += (user, file) => { lock (Saved) Saved.Add((user, file)); };
            server = new TestServer(new WebHostBuilder().ConfigureServices(services =>
            {
                services.AddLogging();
                services.AddRouting();
                services.AddAuthentication("test").AddScheme<AuthenticationSchemeOptions, HeaderAuthentication>("test", _ => { });
                services.AddAuthorization();
                services.AddControllers().AddApplicationPart(typeof(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced).Assembly).AddJsonOptions(options =>
                {
                    // Applies the real JsonDefaults package values, whose string converter accepts numbers.
                    // How the host wires them is assumed here; the route's strictness does not depend on it.
                    var host = JsonDefaults.PascalCaseOptions;
                    options.JsonSerializerOptions.ReadCommentHandling = host.ReadCommentHandling;
                    options.JsonSerializerOptions.WriteIndented = host.WriteIndented;
                    options.JsonSerializerOptions.DefaultIgnoreCondition = host.DefaultIgnoreCondition;
                    options.JsonSerializerOptions.NumberHandling = host.NumberHandling;
                    options.JsonSerializerOptions.Encoder = host.Encoder;
                    options.JsonSerializerOptions.PropertyNamingPolicy = host.PropertyNamingPolicy;
                    options.JsonSerializerOptions.Converters.Clear();
                    foreach (var converter in host.Converters) options.JsonSerializerOptions.Converters.Add(converter);
                });
                services.AddSingleton<IControllerActivator>(new Activator(fixture));
            }).Configure(app =>
            {
                app.UseRouting();
                app.UseAuthentication();
                app.UseAuthorization();
                app.UseEndpoints(endpoints => endpoints.MapControllers());
            }));
        }

        public string PathFor(string user) => Path.Combine(Root, user, FileName);

        public void Store(string user, string text) => Store(user, Encoding.UTF8.GetBytes(text));

        public void Store(string user, byte[] bytes)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(PathFor(user))!);
            File.WriteAllBytes(PathFor(user), bytes);
        }

        public byte[] Stored(string user) => File.ReadAllBytes(PathFor(user));

        public string[] Entries(string user) => Directory.GetFileSystemEntries(Path.Combine(Root, user)).Select(Path.GetFileName).Order(StringComparer.Ordinal).ToArray()!;

        private HttpClient Client(string? caller, bool admin)
        {
            var client = server.CreateClient();
            if (caller != null) client.DefaultRequestHeaders.Add("X-Test-User", caller);
            if (admin) client.DefaultRequestHeaders.Add("X-Test-Admin", "1");
            return client;
        }

        public async Task<HttpResponseMessage> Get(string target = User, string? caller = User, bool admin = false)
        {
            using var client = Client(caller, admin);
            return await client.GetAsync($"/JellyfinEnhanced/user-settings/{target}/{FileName}");
        }

        public async Task<HttpResponseMessage> Post(string body, string target = User, string? caller = User, bool admin = false, string mediaType = "application/json")
        {
            using var client = Client(caller, admin);
            return await client.PostAsync($"/JellyfinEnhanced/user-settings/{target}/{FileName}", new StringContent(body, Encoding.UTF8, mediaType));
        }

        public void Dispose()
        {
            server.Dispose();
            fixture.Dispose();
        }
    }

    // Removes only the store's indentation; number literals and string values are kept.
    private static string Compact(JsonElement element) => JsonSerializer.Serialize(element);

    private static void AssertExtensionsAreExact(JsonElement root)
    {
        using var expected = JsonDocument.Parse("{" + ExtensionFields + "}");
        foreach (var name in ExtensionNames)
            Assert.Equal(Compact(expected.RootElement.GetProperty(name)), Compact(root.GetProperty(name)));
        Assert.Equal(JsonValueKind.String, root.GetProperty("When").ValueKind);
    }

    public static TheoryData<string> InvalidStoredDocuments() => new()
    {
        "",
        "   ",
        "{",
        "broken",
        "null",
        "[]",
        "5",
        "\"text\"",
        "{\"Region\":\"GB\",\"Regions\":[\"DE\"],\"Services\":[\"Netflix\"],\"SeasonProviders\":\"invalid-bool\"}",
        "{\"Region\":\"GB\",\"Region\":\"DE\"}",
        "{\"Region\":\"GB\",\"region\":\"DE\"}",
        "{\"Region\":5}",
        "{\"Region\":{}}",
        "{\"Regions\":\"DE\"}",
        "{\"Regions\":{}}",
        "{\"Regions\":[1]}",
        "{\"Regions\":[null]}",
        "{\"Services\":\"Netflix\"}",
        "{\"Services\":[[\"Netflix\"]]}",
        "{\"SeasonProviders\":1}",
        "{\"SeasonProviders\":\"true\"}",
        "{\"SeasonProviders\":[]}",
        "{\"seasonproviders\":\"invalid-bool\"}",
        "{\"Future\":\"\\ud800\"}"
    };

    public static TheoryData<string> InvalidBodies() => new()
    {
        "null",
        "[]",
        "5",
        "\"text\"",
        "true",
        "{}",
        "{\"Future\":{\"only\":\"unknown\"}}",
        "{\"Region\":5}",
        "{\"Region\":true}",
        "{\"Region\":null}",
        "{\"Region\":[\"DE\"]}",
        "{\"Regions\":null}",
        "{\"Regions\":\"DE\"}",
        "{\"Regions\":[1]}",
        "{\"Regions\":[true]}",
        "{\"Regions\":[null]}",
        "{\"Regions\":[\"DE\",{\"a\":1}]}",
        "{\"Services\":null}",
        "{\"Services\":\"Netflix\"}",
        "{\"Services\":[5]}",
        "{\"SeasonProviders\":null}",
        "{\"SeasonProviders\":1}",
        "{\"SeasonProviders\":\"true\"}",
        "{\"Region\":\"A\",\"Region\":\"B\"}",
        "{\"Region\":\"A\",\"region\":\"B\"}",
        "{\"Region\":\"\\ud800\"}",
        "{\"Region\":{\"a\":1,\"a\":2}}",
        "{\"Region\":\"DE\",\"Regions\":[5]}",
        "{\"Region\":",
        "broken",
        ""
    };

    [Fact]
    public async Task AbsentDocumentReturnsDefaultsWithoutWriting()
    {
        using var host = new Host();
        using var response = await host.Get();
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/json", response.Content.Headers.ContentType!.MediaType);
        Assert.True(response.Headers.CacheControl!.NoStore);
        Assert.Equal("{\"Region\":\"\",\"Regions\":[],\"Services\":[],\"SeasonProviders\":true}", await response.Content.ReadAsStringAsync());
        Assert.False(File.Exists(host.PathFor(User)));
        Assert.Empty(host.Saved);
    }

    [Theory]
    [MemberData(nameof(InvalidStoredDocuments))]
    public async Task InvalidExistingDocumentIsRejectedAndPreservedByReadAndSave(string stored)
    {
        using var host = new Host();
        host.Store(User, stored);
        var bytes = host.Stored(User);

        using var read = await host.Get();
        Assert.Equal(HttpStatusCode.InternalServerError, read.StatusCode);
        Assert.True(read.Headers.CacheControl!.NoStore);
        var body = await read.Content.ReadAsStringAsync();
        Assert.DoesNotContain("SeasonProviders", body);
        Assert.DoesNotContain("Regions", body);

        using var save = await host.Post(FourFields);
        Assert.Equal(HttpStatusCode.InternalServerError, save.StatusCode);

        Assert.Equal(bytes, host.Stored(User));
        Assert.Equal([FileName], host.Entries(User));
        Assert.Empty(host.Saved);
    }

    [Fact]
    public async Task InvalidUtf8BytesAreRejectedAndPreserved()
    {
        using var host = new Host();
        byte[] bytes = [.. "{\"Region\":\""u8, 0xc3, 0x28, .. "\"}"u8];
        host.Store(User, bytes);
        using var read = await host.Get();
        using var save = await host.Post(FourFields);
        Assert.Equal(HttpStatusCode.InternalServerError, read.StatusCode);
        Assert.Equal(HttpStatusCode.InternalServerError, save.StatusCode);
        Assert.Equal(bytes, host.Stored(User));
        Assert.Empty(host.Saved);
    }

    [Fact]
    public async Task UnreadableStoreEntriesAreNotTreatedAsAbsent()
    {
        using var host = new Host();
        Directory.CreateDirectory(host.PathFor(User));
        using (var read = await host.Get()) Assert.Equal(HttpStatusCode.InternalServerError, read.StatusCode);
        using (var save = await host.Post(FourFields)) Assert.Equal(HttpStatusCode.InternalServerError, save.StatusCode);
        Assert.True(Directory.Exists(host.PathFor(User)));

        var target = Path.Combine(host.Root, "outside.json");
        File.WriteAllText(target, FourFields);
        Directory.CreateDirectory(Path.Combine(host.Root, OtherUser));
        File.CreateSymbolicLink(host.PathFor(OtherUser), target);
        using (var read = await host.Get(OtherUser, OtherUser)) Assert.Equal(HttpStatusCode.InternalServerError, read.StatusCode);
        using (var save = await host.Post("{\"Region\":\"AU\"}", OtherUser, OtherUser)) Assert.Equal(HttpStatusCode.InternalServerError, save.StatusCode);
        Assert.Equal(FourFields, File.ReadAllText(target));
        Assert.Empty(host.Saved);
    }

    [Fact]
    public async Task ReadReturnsTheStoredDocumentIncludingUnknownFields()
    {
        using var host = new Host();
        host.Store(User, "{\"Region\":\"GB\",\"Regions\":[\"DE\"],\"Services\":[\"Netflix\"],\"SeasonProviders\":false," + ExtensionFields + "}");
        using var response = await host.Get();
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(response.Headers.CacheControl!.NoStore);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        AssertExtensionsAreExact(json.RootElement);
        Assert.Equal("GB", json.RootElement.GetProperty("Region").GetString());
        Assert.Equal("[\"DE\"]", json.RootElement.GetProperty("Regions").GetRawText());
        Assert.Equal("[\"Netflix\"]", json.RootElement.GetProperty("Services").GetRawText());
        Assert.False(json.RootElement.GetProperty("SeasonProviders").GetBoolean());
    }

    [Fact]
    public async Task SaveOfTheFourEditableFieldsKeepsEveryExtraOnDisk()
    {
        using var host = new Host();
        host.Store(User, "{\"Region\":\"GB\",\"Regions\":[],\"Services\":[],\"SeasonProviders\":true," + ExtensionFields + "}");
        using var response = await host.Post(FourFields);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using (var receipt = JsonDocument.Parse(await response.Content.ReadAsStringAsync()))
        {
            Assert.True(receipt.RootElement.GetProperty("success").GetBoolean());
            Assert.Equal(FileName, receipt.RootElement.GetProperty("file").GetString());
        }

        using var stored = JsonDocument.Parse(host.Stored(User));
        AssertExtensionsAreExact(stored.RootElement);
        Assert.Equal("DE", stored.RootElement.GetProperty("Region").GetString());
        Assert.Equal("[\"FR\"]", Compact(stored.RootElement.GetProperty("Regions")));
        Assert.Equal("[\"Hulu\"]", Compact(stored.RootElement.GetProperty("Services")));
        Assert.False(stored.RootElement.GetProperty("SeasonProviders").GetBoolean());
        Assert.Equal([(User, FileName)], host.Saved);
        Assert.Equal([FileName], host.Entries(User));
    }

    [Fact]
    public async Task ClientRoundTripPreservesExtrasAndIgnoresUnknownRequestFields()
    {
        using var host = new Host();
        host.Store(User, "{\"Region\":\"GB\"," + ExtensionFields + "}");
        using var loaded = await host.Get();
        var source = JObject.Parse((await loaded.Content.ReadAsStringAsync()).Replace("1e400", "0").Replace("1e-400", "0"));

        // The form spreads what it loaded beneath its four controls.
        source["Region"] = "DE";
        source["Regions"] = new JArray("FR");
        source["Services"] = new JArray();
        source["SeasonProviders"] = false;
        source["Huge"] = 1;
        source["Added"] = "from-client";
        using var saved = await host.Post(source.ToString());
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);

        using var stored = JsonDocument.Parse(host.Stored(User));
        AssertExtensionsAreExact(stored.RootElement);
        Assert.False(stored.RootElement.TryGetProperty("Added", out _));
        Assert.Equal("DE", stored.RootElement.GetProperty("Region").GetString());
    }

    [Theory]
    [MemberData(nameof(InvalidBodies))]
    public async Task MalformedBodyIsRejectedWithoutWriting(string body)
    {
        using var host = new Host();
        var document = "{\"Region\":\"GB\"," + ExtensionFields + "}";
        host.Store(User, document);
        host.Store(OtherUser, document);
        var bytes = host.Stored(User);
        Directory.Delete(Path.Combine(host.Root, OtherUser), true);

        using var existing = await host.Post(body);
        using var absent = await host.Post(body, OtherUser, OtherUser);
        Assert.Equal(HttpStatusCode.BadRequest, existing.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, absent.StatusCode);
        Assert.Equal(bytes, host.Stored(User));
        Assert.False(File.Exists(host.PathFor(OtherUser)));
        Assert.Empty(host.Saved);
    }

    [Fact]
    public async Task JellyfinOptionsCoerceTypedBindingSoTheRouteReadsTheRawBody()
    {
        // The evidence for binding JsonElement rather than ElsewhereSettings: this value
        // reaches a typed model as "5", which no check in the action can tell from text.
        var options = new JsonSerializerOptions(JsonDefaults.PascalCaseOptions) { PropertyNameCaseInsensitive = true };
        Assert.Equal("5", JsonSerializer.Deserialize<ElsewhereSettings>("{\"Region\":5}", options)!.Region);

        using var host = new Host();
        using var response = await host.Post("{\"Region\":5}");
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.False(File.Exists(host.PathFor(User)));
    }

    [Fact]
    public async Task SaveChangesOnlyTheNamedFields()
    {
        using var host = new Host();
        host.Store(User, "{\"Region\":\"GB\",\"Regions\":[\"DE\"],\"Services\":[\"Netflix\"],\"SeasonProviders\":false}");
        using var response = await host.Post("{\"Region\":\"AU\"}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(JToken.DeepEquals(
            JObject.Parse("{\"Region\":\"AU\",\"Regions\":[\"DE\"],\"Services\":[\"Netflix\"],\"SeasonProviders\":false}"),
            JObject.Parse(Encoding.UTF8.GetString(host.Stored(User)))));
    }

    [Fact]
    public async Task FirstSaveWritesTheEditableFieldsOverDefaults()
    {
        using var host = new Host();
        using var response = await host.Post("{\"Region\":\"AU\"}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(JToken.DeepEquals(
            JObject.Parse("{\"Region\":\"AU\",\"Regions\":[],\"Services\":[],\"SeasonProviders\":true}"),
            JObject.Parse(Encoding.UTF8.GetString(host.Stored(User)))));
        Assert.Equal([(User, FileName)], host.Saved);
    }

    [Fact]
    public async Task ExplicitEmptyValuesAreEditsNotErrors()
    {
        using var host = new Host();
        host.Store(User, "{\"Region\":\"GB\",\"Regions\":[\"DE\"],\"Services\":[\"Netflix\"],\"Keep\":1}");
        using var response = await host.Post("{\"Region\":\"\",\"Regions\":[],\"Services\":[],\"SeasonProviders\":true}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(JToken.DeepEquals(
            JObject.Parse("{\"Region\":\"\",\"Regions\":[],\"Services\":[],\"Keep\":1,\"SeasonProviders\":true}"),
            JObject.Parse(Encoding.UTF8.GetString(host.Stored(User)))));
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"Region\":\"GB\"}")]
    [InlineData("{\"Region\":null,\"Regions\":null,\"Services\":null,\"SeasonProviders\":null}")]
    [InlineData("{\"Region\":\"\",\"Regions\":[],\"Services\":[],\"SeasonProviders\":true}")]
    public async Task OlderUnsetFieldsAreValidAndReturnedAsStored(string stored)
    {
        using var host = new Host();
        host.Store(User, stored);
        var bytes = host.Stored(User);
        using var response = await host.Get();
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(stored, await response.Content.ReadAsStringAsync());
        Assert.Equal(bytes, host.Stored(User));
    }

    [Fact]
    public async Task SaveReplacesStoredNullWithTheEditedValue()
    {
        using var host = new Host();
        host.Store(User, "{\"Region\":null,\"Regions\":null,\"Keep\":true}");
        using var response = await host.Post("{\"Region\":\"GB\"}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(JToken.DeepEquals(
            JObject.Parse("{\"Region\":\"GB\",\"Regions\":null,\"Keep\":true}"),
            JObject.Parse(Encoding.UTF8.GetString(host.Stored(User)))));
    }

    [Fact]
    public async Task OtherCasingReadsCanonicallySavesInPlaceAndCreatesNoDuplicate()
    {
        using var host = new Host();
        host.Store(User, "{\"region\":\"GB\",\"REGIONS\":[\"DE\"],\"seasonProviders\":false,\"services\":[\"Netflix\"],\"future\":1}");
        var bytes = host.Stored(User);
        using (var read = await host.Get())
        {
            Assert.Equal("{\"Region\":\"GB\",\"Regions\":[\"DE\"],\"SeasonProviders\":false,\"Services\":[\"Netflix\"],\"future\":1}", await read.Content.ReadAsStringAsync());
        }
        Assert.Equal(bytes, host.Stored(User));

        using var saved = await host.Post("{\"region\":\"AU\"}");
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        Assert.Equal(
            "{\"Region\":\"AU\",\"Regions\":[\"DE\"],\"SeasonProviders\":false,\"Services\":[\"Netflix\"],\"future\":1}",
            JObject.Parse(Encoding.UTF8.GetString(host.Stored(User))).ToString(Newtonsoft.Json.Formatting.None));
    }

    [Fact]
    public async Task ByteOrderMarkIsAccepted()
    {
        using var host = new Host();
        host.Store(User, [.. new byte[] { 0xef, 0xbb, 0xbf }, .. "{\"Region\":\"GB\",\"Keep\":1}"u8]);
        using var read = await host.Get();
        Assert.Equal("{\"Region\":\"GB\",\"Keep\":1}", await read.Content.ReadAsStringAsync());
        using var saved = await host.Post("{\"Services\":[\"Hulu\"]}");
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        Assert.Equal("{\"Region\":\"GB\",\"Keep\":1,\"Services\":[\"Hulu\"]}", JObject.Parse(Encoding.UTF8.GetString(host.Stored(User))).ToString(Newtonsoft.Json.Formatting.None));
    }

    [Fact]
    public async Task StringsArePreservedExactlyAndNotNormalized()
    {
        using var host = new Host();
        const string body = "{\"Region\":\" gb \",\"Regions\":[\"\",\"de\"],\"Services\":[\"Disney+ \\\"Plus\\\" \\u00e9\"]}";
        using var response = await host.Post(body);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var stored = JObject.Parse(Encoding.UTF8.GetString(host.Stored(User)));
        Assert.Equal(" gb ", (string?)stored["Region"]);
        Assert.Equal(new JArray("", "de"), stored["Regions"]);
        Assert.Equal("Disney+ \"Plus\" é", (string?)stored["Services"]![0]);
    }

    [Fact]
    public async Task CaseInsensitiveHostBindingOfSavedFieldNamesRemains()
    {
        using var host = new Host();
        using var response = await host.Post("{\"region\":\"GB\",\"regions\":[\"DE\"],\"services\":[],\"seasonProviders\":false}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(JToken.DeepEquals(
            JObject.Parse("{\"Region\":\"GB\",\"Regions\":[\"DE\"],\"Services\":[],\"SeasonProviders\":false}"),
            JObject.Parse(Encoding.UTF8.GetString(host.Stored(User)))));
    }

    [Fact]
    public async Task AnonymousCallersCannotReadOrWrite()
    {
        using var host = new Host();
        host.Store(User, FourFields);
        var bytes = host.Stored(User);
        using var read = await host.Get(caller: null);
        using var save = await host.Post("{\"Region\":\"AU\"}", caller: null);
        Assert.Equal(HttpStatusCode.Unauthorized, read.StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, save.StatusCode);
        Assert.Equal(bytes, host.Stored(User));
        Assert.Empty(host.Saved);
    }

    [Fact]
    public async Task UsersCannotReadOrWriteAnotherUsersDocument()
    {
        using var host = new Host();
        host.Store(User, "{\"Region\":\"GB\",\"Secret\":\"mine\"}");
        var bytes = host.Stored(User);
        using var read = await host.Get(User, OtherUser);
        using var save = await host.Post("{\"Region\":\"AU\"}", User, OtherUser);
        Assert.Equal(HttpStatusCode.Forbidden, read.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, save.StatusCode);
        Assert.DoesNotContain("mine", await read.Content.ReadAsStringAsync());
        Assert.Equal(bytes, host.Stored(User));
        Assert.Empty(host.Saved);
    }

    [Fact]
    public async Task AuthorizationPrecedesBodyAndDocumentValidation()
    {
        using var host = new Host();
        host.Store(User, "broken");
        using var read = await host.Get(User, OtherUser);
        using var save = await host.Post("{\"Region\":5}", User, OtherUser);
        Assert.Equal(HttpStatusCode.Forbidden, read.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, save.StatusCode);
    }

    [Fact]
    public async Task AdministratorsActOnOnlyTheRequestedUsersDocument()
    {
        using var host = new Host();
        host.Store(User, "{\"Region\":\"GB\",\"Keep\":1}");
        host.Store(OtherUser, "{\"Region\":\"AU\",\"Keep\":2}");
        var others = host.Stored(OtherUser);
        using (var read = await host.Get(User, OtherUser, admin: true))
            Assert.Equal("{\"Region\":\"GB\",\"Keep\":1}", await read.Content.ReadAsStringAsync());
        using (var save = await host.Post("{\"Region\":\"DE\"}", User, OtherUser, admin: true))
            Assert.Equal(HttpStatusCode.OK, save.StatusCode);
        Assert.Equal("{\"Region\":\"DE\",\"Keep\":1}", JObject.Parse(Encoding.UTF8.GetString(host.Stored(User))).ToString(Newtonsoft.Json.Formatting.None));
        Assert.Equal(others, host.Stored(OtherUser));
        Assert.Equal([(User, FileName)], host.Saved);
    }

    [Theory]
    [InlineData("not-a-guid", HttpStatusCode.BadRequest)]
    [InlineData("abcdefab-cdef-abcd-efab-cdefabcdefab", HttpStatusCode.OK)]
    [InlineData("ABCDEFABCDEFABCDEFABCDEFABCDEFAB", HttpStatusCode.OK)]
    public async Task UserIdFormsResolveToTheSameDocumentOrAreRejected(string target, HttpStatusCode expected)
    {
        using var host = new Host();
        host.Store(User, "{\"Region\":\"GB\"}");
        using var response = await host.Get(target, User);
        Assert.Equal(expected, response.StatusCode);
        if (expected == HttpStatusCode.OK) Assert.Equal("{\"Region\":\"GB\"}", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task LegacyWholeDocumentWritesRemainReadable()
    {
        using var host = new Host();
        host.Manager.SaveUserConfiguration(User, FileName, new ElsewhereSettings { Region = "GB", Regions = ["DE"], Services = ["Netflix"], SeasonProviders = false });
        using var response = await host.Get();
        Assert.Equal("{\"Region\":\"GB\",\"Regions\":[\"DE\"],\"Services\":[\"Netflix\"],\"SeasonProviders\":false}", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task ConcurrentSavesKeepDisjointEditsAndUnknownData()
    {
        using var host = new Host();
        host.Store(User, "{\"Region\":\"GB\",\"Regions\":[],\"Services\":[],\"SeasonProviders\":true," + ExtensionFields + "}");
        var service = new ElsewhereDocumentService(host.Manager);
        using var together = new Barrier(2);

        bool Save(string field, int round)
        {
            using var body = JsonDocument.Parse("{\"" + field + "\":[\"" + round + "\"]}");
            Assert.True(ElsewhereDocumentService.TryParseUpdate(body.RootElement, out var update, out _));
            together.SignalAndWait();
            return service.TrySave(User, update);
        }

        // Each round overlaps both writers and checks both edits, so an update lost to a
        // stale read fails that round rather than being hidden by a later write.
        for (var round = 0; round < 300; round++)
        {
            var current = round;
            var saved = await Task.WhenAll(Task.Run(() => Save("Regions", current)), Task.Run(() => Save("Services", current)));
            Assert.All(saved, Assert.True);
            using var stored = JsonDocument.Parse(host.Stored(User));
            Assert.Equal("[\"" + round + "\"]", Compact(stored.RootElement.GetProperty("Regions")));
            Assert.Equal("[\"" + round + "\"]", Compact(stored.RootElement.GetProperty("Services")));
            AssertExtensionsAreExact(stored.RootElement);
        }

        Assert.Equal([FileName], host.Entries(User));
    }

    [Theory]
    [InlineData("1e400")]
    [InlineData("-1E+400")]
    [InlineData("1.10")]
    [InlineData("123456789012345678901234567890")]
    [InlineData("0.000000000000000000000000000000000001")]
    public async Task NumberLiteralsSurviveReadAndSaveExactly(string literal)
    {
        using var host = new Host();
        host.Store(User, "{\"Region\":\"GB\",\"Number\":" + literal + "}");
        using (var read = await host.Get())
            Assert.Equal("{\"Region\":\"GB\",\"Number\":" + literal + "}", await read.Content.ReadAsStringAsync());
        using var saved = await host.Post("{\"Region\":\"AU\"}");
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        using var stored = JsonDocument.Parse(host.Stored(User));
        Assert.Equal(literal, stored.RootElement.GetProperty("Number").GetRawText());
    }

    // Records the shared store's parsing, which this boundary cannot change: an integral
    // or decimal value keeps its magnitude but not its spelling or the sign of zero.
    [Theory]
    [InlineData("1E2", "100.0")]
    [InlineData("-0", "0")]
    [InlineData("-0.0", "0.0")]
    public async Task SharedStoreRespellsEquivalentNumbers(string literal, string normalized)
    {
        using var host = new Host();
        host.Store(User, "{\"Number\":" + literal + "}");
        using var read = await host.Get();
        Assert.Equal("{\"Number\":" + normalized + "}", await read.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task SaveThatOutlastsItsRetriesReportsConflict()
    {
        using var host = new Host();
        host.Store(User, "{\"Region\":\"GB\"}");
        using var stop = new CancellationTokenSource();

        // An external edit changes the revision outside the store lock, which is the
        // only way to lose every attempt deterministically enough for a route test.
        var editor = Task.Run(() =>
        {
            var temporary = host.PathFor(User) + ".edit";
            for (var i = 0; !stop.IsCancellationRequested; i++)
            {
                File.WriteAllText(temporary, "{\"Region\":\"GB\",\"Edit\":" + i + "}");
                File.Move(temporary, host.PathFor(User), overwrite: true);
            }
        });

        try
        {
            var deadline = DateTime.UtcNow.AddSeconds(30);
            HttpStatusCode status;
            string body;
            do
            {
                using var response = await host.Post("{\"Services\":[\"Hulu\"]}");
                status = response.StatusCode;
                body = await response.Content.ReadAsStringAsync();
                Assert.True(status is HttpStatusCode.OK or HttpStatusCode.Conflict, body);
            }
            while (status != HttpStatusCode.Conflict && DateTime.UtcNow < deadline);

            Assert.Equal(HttpStatusCode.Conflict, status);
            using var json = JsonDocument.Parse(body);
            Assert.False(json.RootElement.GetProperty("success").GetBoolean());
        }
        finally
        {
            await stop.CancelAsync();
            await editor;
        }
    }

    [Fact]
    public void RoutesKeepTheirAuthorizationAndCachePolicies()
    {
        var read = typeof(JeDetailsProvidersController).GetMethod(nameof(JeDetailsProvidersController.GetUserSettingsElsewhere))!;
        var save = typeof(JeDetailsProvidersController).GetMethod(nameof(JeDetailsProvidersController.SaveUserSettingsElsewhere))!;
        Assert.Equal("user-settings/{userId}/elsewhere.json", read.GetCustomAttribute<HttpGetAttribute>()!.Template);
        Assert.Equal("user-settings/{userId}/elsewhere.json", save.GetCustomAttribute<HttpPostAttribute>()!.Template);
        Assert.NotNull(read.GetCustomAttribute<AuthorizeAttribute>());
        Assert.NotNull(save.GetCustomAttribute<AuthorizeAttribute>());
        Assert.True(read.GetCustomAttribute<ResponseCacheAttribute>()!.NoStore);
    }
}
