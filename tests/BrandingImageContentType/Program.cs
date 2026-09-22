using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;

var directory = Directory.CreateTempSubdirectory("je-branding-tests-");
var checks = 0;
const string svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"64\" height=\"64\"><rect width=\"64\" height=\"64\" fill=\"orange\"/></svg>";

void Check(string name, string fileName, byte[] bytes, string expected)
{
    var path = Path.Combine(directory.FullName, fileName);
    File.WriteAllBytes(path, bytes);
    var actual = BrandingImageContentType.Get(path);
    if (actual != expected)
    {
        throw new Exception($"{name}: expected {expected}, got {actual}");
    }

    if (!File.ReadAllBytes(path).SequenceEqual(bytes))
    {
        throw new Exception($"{name}: image bytes changed");
    }

    // Resolution must release its handle so uploads and deletion still work.
    using (File.Open(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
    checks++;
}

try
{
    foreach (var fileName in new[] { "icon-transparent.png", "banner-light.png", "banner-dark.png", "favicon.ico", "apple-touch-icon.png" })
    {
        Check($"SVG under {fileName}", fileName, Encoding.UTF8.GetBytes(svg), "image/svg+xml");
    }

    Check("XML declaration and comment", "icon-transparent.png",
        Encoding.UTF8.GetBytes("<?xml version=\"1.0\" encoding=\"UTF-8\"?><!-- logo -->" + svg), "image/svg+xml");
    Check("UTF-8 BOM", "icon-transparent.png",
        Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes(svg)).ToArray(), "image/svg+xml");
    Check("UTF-16 BOM", "icon-transparent.png",
        Encoding.Unicode.GetPreamble().Concat(Encoding.Unicode.GetBytes(svg)).ToArray(), "image/svg+xml");
    Check("Leading whitespace", "icon-transparent.png", Encoding.UTF8.GetBytes("\n \t" + svg), "image/svg+xml");
    Check("External DTD is not resolved", "icon-transparent.png",
        Encoding.UTF8.GetBytes("<!DOCTYPE svg SYSTEM \"file:///does-not-exist/branding.dtd\">" + svg), "image/svg+xml");
    Check("PNG stays PNG", "icon-transparent.png",
        Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=="), "image/png");
    Check("ICO stays ICO", "favicon.ico", new byte[] { 0, 0, 1, 0, 0, 0 }, "image/x-icon");
    Check("Empty upload", "icon-transparent.png", Array.Empty<byte>(), "image/png");
    Check("Malformed XML", "icon-transparent.png", Encoding.UTF8.GetBytes("<svg broken"), "image/png");
    Check("HTML with nested SVG is not SVG", "icon-transparent.png",
        Encoding.UTF8.GetBytes("<html>" + svg + "</html>"), "image/png");
    Check("Wrong namespace", "icon-transparent.png",
        Encoding.UTF8.GetBytes("<svg xmlns=\"urn:not-svg\"/>"), "image/png");
    Check("Unknown extension fallback", "image.unknown", new byte[] { 0, 1, 2 }, "application/octet-stream");
    Console.WriteLine($"PASS: {checks} branding content-type checks");
}
finally
{
    directory.Delete(recursive: true);
}
