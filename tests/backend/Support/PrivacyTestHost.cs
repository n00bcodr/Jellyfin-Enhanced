using System.Reflection;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Moq;

namespace JE.Tests;

/// <summary>
/// Host services the privacy projection asks (the host's own closed lists: languages, ratings, countries, the labels a
/// media stream's display title uses), as a stand-in that answers like the host's LocalizationManager for a few entries;
/// and a constructor that fills whatever services a type's widest constructor takes, so a test compiles against builds
/// whose constructors differ.
/// </summary>
internal static class PrivacyTestHost
{
    /// <summary>A slice of the host's iso6392 list (three-letter codes, two-letter code, display name).</summary>
    private static readonly CultureDto[] Cultures =
    [
        new("en", "English", "en", ["eng"]),
        new("fr", "French", "fr", ["fra", "fre"]),
        new("de", "German", "de", ["deu", "ger"]),
        new("es", "Spanish; Castilian", "es", ["spa"]),
        new("ja", "Japanese", "ja", ["jpn"]),
        new("pt-br", "Portuguese (Brazil)", "pt-br", ["por"]),
        new("Undetermined", "Undetermined", "", ["und"]),
    ];

    private static readonly Dictionary<string, string> Labels = new(StringComparer.Ordinal)
    {
        ["Default"] = "Default", ["External"] = "External", ["Original"] = "Original", ["Undefined"] = "Undefined",
        ["Forced"] = "Forced", ["HearingImpaired"] = "Hearing Impaired",
    };

    private static readonly string[] Ratings = ["G", "PG", "PG-13", "R", "NC-17", "TV-14", "TV-MA", "NR", "FSK-16"];

    /// <summary>The host's localization manager, as far as the privacy projection asks it.</summary>
    public static ILocalizationManager Localization()
    {
        var mock = new Mock<ILocalizationManager>();
        // The host matches a display name, a culture name, any three-letter code or the two-letter code, ignoring case.
        mock.Setup(l => l.FindLanguageInfo(It.IsAny<string>())).Returns((string language) => string.IsNullOrEmpty(language) ? null
            : Cultures.FirstOrDefault(c => language.Equals(c.DisplayName, StringComparison.OrdinalIgnoreCase) || language.Equals(c.Name, StringComparison.OrdinalIgnoreCase)
                || c.ThreeLetterISOLanguageNames.Contains(language, StringComparer.OrdinalIgnoreCase) || language.Equals(c.TwoLetterISOLanguageName, StringComparison.OrdinalIgnoreCase)));
        mock.Setup(l => l.GetCultures()).Returns(Cultures);
        mock.Setup(l => l.GetLocalizedString(It.IsAny<string>())).Returns((string phrase) => Labels.GetValueOrDefault(phrase, phrase));
        mock.Setup(l => l.GetRatingScore(It.IsAny<string>(), It.IsAny<string?>()))
            .Returns((string rating, string? _) => Ratings.Contains(rating, StringComparer.OrdinalIgnoreCase) ? new ParentalRatingScore(Array.IndexOf(Ratings, rating) + 1, null) : null);
        mock.Setup(l => l.GetCountries()).Returns(new[] { ("US", "United States"), ("GB", "United Kingdom"), ("FR", "France"), ("DE", "Germany"), ("JP", "Japan") }
            .Select(c => new CountryInfo { Name = c.Item1, TwoLetterISORegionName = c.Item1, DisplayName = c.Item2, ThreeLetterISORegionName = c.Item1 + "A" }).ToArray());
        return mock.Object;
    }

    /// <summary>
    /// An instance from the type's widest public constructor: each parameter takes the first service assignable to it,
    /// else its default value (optional) or null.
    /// </summary>
    public static T Create<T>(params object?[] services)
    {
        var constructor = typeof(T).GetConstructors(BindingFlags.Public | BindingFlags.Instance).OrderByDescending(c => c.GetParameters().Length).First();
        var arguments = constructor.GetParameters()
            .Select(p => services.FirstOrDefault(s => s != null && p.ParameterType.IsInstanceOfType(s)) ?? (p.HasDefaultValue ? p.DefaultValue : null))
            .ToArray();
        return (T)constructor.Invoke(arguments);
    }
}
