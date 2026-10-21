using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

// Stage 1 fix round 4 (Q-REBUILD1FIX3-1): the display languages JE ships are the locale files the build embeds, read at run
// time. The server takes them from its embedded resources and hands them to the client inside the translations script it
// serves; nothing is generated or committed, so a locale file Weblate adds (js/locales/xx.json) is a language JE stores and
// the browser writes with no other step.
[Collection("Plugin singleton")]
public class ApiShippedLocalesTests
{
    private const string Prefix = "Jellyfin.Plugin.JellyfinEnhanced.js.locales.";

    private static string Js => Path.Combine(IntegrationAutoRequestLedgerTests.Root(), "Jellyfin.Plugin.JellyfinEnhanced", "js");

    private static List<string> Embedded(Assembly assembly) => assembly.GetManifestResourceNames()
        .Where(n => n.StartsWith(Prefix, StringComparison.Ordinal) && n.EndsWith(".json", StringComparison.Ordinal))
        .Select(n => n[Prefix.Length..^".json".Length]).OrderBy(c => c, StringComparer.OrdinalIgnoreCase).ToList();

    // The policy the served script carries: `const LANGUAGE_POLICY = {…};` on one line, written by the server.
    private static JsonElement ServedPolicy(string script)
    {
        var match = Regex.Match(script, @"^\s*const LANGUAGE_POLICY = (\{.*\});\s*$", RegexOptions.Multiline);
        Assert.True(match.Success, "the served translations script carries no one-line LANGUAGE_POLICY");
        return JsonDocument.Parse(match.Groups[1].Value).RootElement.Clone();
    }

    private static string Served(string path)
    {
        using var f = new ApiPluginFixture();
        var result = Assert.IsType<FileStreamResult>(ApiAssetTests.Controller(f.Core, f.Core.Manager).GetScript(path));
        using var reader = new StreamReader(result.FileStream, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    [Fact]
    public void TheShippedLanguagesAreTheLocaleResourcesTheBuildEmbedsAndTheLocaleFiles()
    {
        var files = Directory.GetFiles(Path.Combine(Js, "locales"), "*.json")
            .Select(p => Path.GetFileNameWithoutExtension(p)!).OrderBy(c => c, StringComparer.OrdinalIgnoreCase).ToList();
        Assert.Equal(files, Embedded(typeof(LanguageTags).Assembly));
        Assert.Equal(files, LanguageTags.Bundled);
    }

    [Fact]
    public void TheServedTranslationsScriptCarriesTheRuleAndTheEmbeddedLocales()
    {
        var served = Served("enhanced/translations.js");
        var policy = ServedPolicy(served);
        Assert.Equal(LanguageTags.Bundled, policy.GetProperty("shipped").EnumerateArray().Select(e => e.GetString()!).ToList());
        Assert.Equal(Embedded(typeof(LanguageTags).Assembly), policy.GetProperty("shipped").EnumerateArray().Select(e => e.GetString()!).ToList());
        // The rest of the rule is the one the server applies (js/language-policy.json).
        using var rule = JsonDocument.Parse(File.ReadAllText(Path.Combine(Js, "language-policy.json")));
        Assert.Equal(rule.RootElement.GetProperty("space").GetString(), policy.GetProperty("space").GetString());
        Assert.Equal(rule.RootElement.GetProperty("tag").GetString(), policy.GetProperty("tag").GetString());
        Assert.Equal(rule.RootElement.GetProperty("reserved").EnumerateArray().Select(e => e.GetString()), policy.GetProperty("reserved").EnumerateArray().Select(e => e.GetString()));

        // Only the policy line differs from the file; every other script is served as it is.
        var source = File.ReadAllText(Path.Combine(Js, "enhanced", "translations.js"));
        Assert.Equal(source.Split('\n').Length, served.Split('\n').Length);
        Assert.Single(source.Split('\n').Zip(served.Split('\n')), pair => pair.First != pair.Second);
        Assert.Equal(File.ReadAllText(Path.Combine(Js, "enhanced", "config.js")), Served("enhanced/config.js"));
    }

    [Fact]
    public void NoGeneratedLanguageListOrGeneratorIsCommitted()
    {
        var root = IntegrationAutoRequestLedgerTests.Root();
        using var rule = JsonDocument.Parse(File.ReadAllText(Path.Combine(Js, "language-policy.json")));
        Assert.False(rule.RootElement.TryGetProperty("shipped", out _), "js/language-policy.json still lists the shipped locales");
        var source = File.ReadAllText(Path.Combine(Js, "enhanced", "translations.js"));
        Assert.DoesNotContain("\"shipped\"", source, StringComparison.Ordinal);
        Assert.DoesNotContain("BEGIN language-policy", source, StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(root, "scripts", "generate_language_policy.py")));
        Assert.False(File.Exists(Path.Combine(root, "tests", "runner", "tests", "test_language_policy.py")));
    }

    private static string Dotnet()
    {
        var host = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH");
        return !string.IsNullOrEmpty(host) && File.Exists(host) ? host : "dotnet";
    }

    private static (int Code, string Output) Run(string file, string arguments, string? workingDirectory = null, int minutes = 10)
    {
        var start = new ProcessStartInfo(file, arguments)
        {
            RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false,
            WorkingDirectory = workingDirectory ?? Path.GetTempPath(),
        };
        // No build servers left behind by this test.
        start.Environment["MSBUILDDISABLENODEREUSE"] = "1";
        start.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(TimeSpan.FromMinutes(minutes)))
        {
            process.Kill(entireProcessTree: true);
            return (-1, "timed out");
        }

        return (process.ExitCode, output.Result + error.Result);
    }

    private static void Copy(string from, string to)
    {
        foreach (var dir in Directory.GetDirectories(from, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(from, dir);
            var top = relative.Split(Path.DirectorySeparatorChar)[0];
            if (top is "bin" or "obj") continue;
            Directory.CreateDirectory(Path.Combine(to, relative));
        }

        foreach (var file in Directory.GetFiles(from, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(from, file);
            var top = relative.Split(Path.DirectorySeparatorChar)[0];
            if (top is "bin" or "obj") continue;
            File.Copy(file, Path.Combine(to, relative));
        }
    }

    // A Weblate-style change: one new file, js/locales/eo.json, and nothing else. A real build of the plugin with it ships
    // Esperanto: the server stores it and hands it to the browser, whose rule (the served script) writes it. The build runs
    // in its own process (a probe app referencing the copied plugin), so this test process never loads a second plugin.
    [Fact]
    public void ALocaleFileAddedToABuildIsAcceptedWithNoOtherStep()
    {
        Assert.Equal("", LanguageTags.Sanitize("eo"));
        var work = Path.Combine(Path.GetTempPath(), "je-locale-build-" + Guid.NewGuid().ToString("N"));
        try
        {
            var project = Path.Combine(work, "Jellyfin.Plugin.JellyfinEnhanced");
            Copy(Path.Combine(IntegrationAutoRequestLedgerTests.Root(), "Jellyfin.Plugin.JellyfinEnhanced"), project);
            File.WriteAllText(Path.Combine(project, "js", "locales", "eo.json"), "{\n  \"panel_title\": \"Jellyfin Enhanced\"\n}\n");
#if JF10
            const string Target = "jf10";
            const string Framework = "net9.0";
#else
            const string Target = "jf12";
            const string Framework = "net10.0";
#endif
            var probe = Directory.CreateDirectory(Path.Combine(work, "probe")).FullName;
            File.WriteAllText(Path.Combine(probe, "probe.csproj"), $$"""
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>{{Framework}}</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
                  <ItemGroup><ProjectReference Include="../Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj" /></ItemGroup>
                </Project>
                """);
            File.WriteAllText(Path.Combine(probe, "Program.cs"), """
                using System.Text.Json;
                using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
                const string Prefix = "Jellyfin.Plugin.JellyfinEnhanced.js.locales.";
                File.WriteAllText(args[0], LanguageTags.TranslationsScript());
                Console.WriteLine(JsonSerializer.Serialize(new Dictionary<string, object>
                {
                    ["embedded"] = typeof(LanguageTags).Assembly.GetManifestResourceNames().Where(n => n.StartsWith(Prefix, StringComparison.Ordinal)).Select(n => n[Prefix.Length..^".json".Length]).ToArray(),
                    ["bundled"] = LanguageTags.Bundled,
                    ["sanitized"] = new[] { "eo", "EO-au", "ja" }.Select(LanguageTags.Sanitize).ToArray(),
                }));
                """);
            var output = Path.Combine(work, "out");
            var (code, log) = Run(Dotnet(), $"build \"{Path.Combine(probe, "probe.csproj")}\" -c Release -p:JellyfinTarget={Target} -p:UseSharedCompilation=false -nodeReuse:false -nologo -v:q -o \"{output}\"", probe);
            Assert.True(code == 0, log);

            var script = Path.Combine(work, "translations.js");
            var (probeCode, answer) = Run(Dotnet(), $"\"{Path.Combine(output, "probe.dll")}\" \"{script}\"", work, 2);
            Assert.True(probeCode == 0, answer);
            using var probed = JsonDocument.Parse(answer);
            Assert.Contains("eo", probed.RootElement.GetProperty("embedded").EnumerateArray().Select(e => e.GetString()));
            Assert.Contains("eo", probed.RootElement.GetProperty("bundled").EnumerateArray().Select(e => e.GetString()));
            Assert.Equal(new[] { "eo", "eo-AU", "" }, probed.RootElement.GetProperty("sanitized").EnumerateArray().Select(e => e.GetString()).ToArray());

            // The translations script that build serves, run as the browser runs it.
            var node = Path.Combine(work, "probe.cjs");
            File.WriteAllText(node, "const vm = require('node:vm'); const fs = require('node:fs');\n"
                + "const window = { JellyfinEnhanced: {} }; vm.runInNewContext(fs.readFileSync(process.argv[2], 'utf8'), { window, console });\n"
                + "const JE = window.JellyfinEnhanced; console.log(JSON.stringify(['eo', 'EO-au', 'ja', 'fr'].map(JE.supportedLanguageCode)));\n");
            var (nodeCode, written) = Run("node", $"\"{node}\" \"{script}\"", work, 2);
            Assert.True(nodeCode == 0, written);
            Assert.Equal("[\"eo\",\"eo-AU\",\"\",\"fr\"]", written.Trim());
        }
        finally
        {
            try { Directory.Delete(work, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
