namespace JE.Tests;

/// <summary>
/// The test assembly's entry point. Test runners never call it; a harness whose code must not share the test process (it
/// loads a second copy of the plugin, which tests that look the plugin up by name would then see twice) runs itself in a
/// child process through it.
/// </summary>
internal static class TestProgram
{
    public static int Main(string[] args) => args switch
    {
        ["--suite-manifest", var output] => SuiteManifest.Write(output),
        [LegacyCollageHost.ChildCommand, var output] => LegacyCollageHost.RunChild(output),
        _ => 2,
    };
}
