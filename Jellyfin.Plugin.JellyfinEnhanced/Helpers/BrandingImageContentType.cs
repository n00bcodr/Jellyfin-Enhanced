using System.IO;
using System.Xml;
using Microsoft.AspNetCore.StaticFiles;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// Resolves branding image types without assuming the fixed upload filename
    /// describes the bytes. In particular, browsers cannot decode SVG as image/png.
    /// </summary>
    internal static class BrandingImageContentType
    {
        private static readonly FileExtensionContentTypeProvider ContentTypes = new();

        public static string Get(string filePath)
        {
            // Uploads retain their original bytes under names such as
            // icon-transparent.png and favicon.ico. Detect SVG from the document
            // itself so existing uploads work too, without a re-upload or sidecar.
            using var text = new StreamReader(filePath);
            while (text.Peek() >= 0 && char.IsWhiteSpace((char)text.Peek()))
            {
                text.Read();
            }

            if (text.Peek() == '<')
            {
                try
                {
                    using var xml = XmlReader.Create(text, new XmlReaderSettings
                    {
                        DtdProcessing = DtdProcessing.Ignore,
                        XmlResolver = null,
                        MaxCharactersInDocument = 10 * 1024 * 1024
                    });
                    if (xml.MoveToContent() == XmlNodeType.Element
                        && xml.LocalName == "svg"
                        && xml.NamespaceURI == "http://www.w3.org/2000/svg")
                    {
                        return "image/svg+xml";
                    }
                }
                catch (XmlException)
                {
                    // Malformed XML is not an SVG; retain the existing fallback.
                }
            }

            return ContentTypes.TryGetContentType(filePath, out var contentType)
                ? contentType
                : "application/octet-stream";
        }
    }
}
