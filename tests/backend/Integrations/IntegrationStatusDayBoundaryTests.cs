using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;

namespace JE.Tests;

/// <summary>
/// The date-only day rule at both ends of the calendar (UX2R6-1, ported from the review clone): a clock before
/// 0001-01-02 12:00 must not throw, and ordinary dates keep the strict 36-hour boundary.
/// </summary>
public class IntegrationStatusDayBoundaryTests
{
    [Fact]
    public void OrdinaryDatesRetainTheStrictThirtySixHourBoundary()
    {
        foreach (var day in new[] { new DateTime(1901, 1, 1), new DateTime(2026, 10, 13), new DateTime(2099, 12, 31) })
        foreach (var kind in new[] { DateTimeKind.Unspecified, DateTimeKind.Utc, DateTimeKind.Local })
        foreach (var delta in new[] { -1L, 0L, 1L })
        {
            var input = DateTime.SpecifyKind(day.AddHours(21), kind);
            var now = DateTime.SpecifyKind(day.AddHours(36).AddTicks(delta), kind);
            Assert.Equal(input.Date + StatusComposer.DayLasts > now, StatusComposer.DayStillAhead(input, now));
        }
    }

    [Theory]
    [InlineData(0L)]
    [InlineData(1L)]
    [InlineData(1295999999999L)]
    [InlineData(1296000000000L)]
    [InlineData(3155378975999999998L)]
    [InlineData(3155378975999999999L)]
    public void BothClockExtremesAreSafe(long nowTicks)
    {
        var now = new DateTime(nowTicks, DateTimeKind.Utc);
        foreach (var day in new[] { new DateTime(2026, 10, 13), DateTime.MinValue, DateTime.MaxValue })
        {
            // Subtracting two in-range tick counts fits Int64 and avoids shifting either DateTime past its bounds.
            var expected = day.Date.Ticks - now.Ticks > -StatusComposer.DayLasts.Ticks;
            Assert.Equal(expected, StatusComposer.DayStillAhead(day, now));
        }
    }
}
