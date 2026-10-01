using System;
using System.Collections.Generic;
using System.Globalization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering
{
    /// <summary>
    /// Where every tag goes on one image, in CSS px of the logical card (the web's layout), before scaling to pixels.
    /// Built by <see cref="PosterTagPlanner"/>; drawn by <see cref="PosterTagRenderer"/>.
    /// </summary>
    internal sealed class PosterTagPlan
    {
        public PosterTagPlan(int imageWidth, int imageHeight, PosterTagCss css, IReadOnlyList<PlannedGroup> groups)
        {
            ImageWidth = imageWidth;
            ImageHeight = imageHeight;
            Css = css;
            Scale = imageWidth / css.CardWidth;
            CardHeight = imageHeight / Scale;
            Groups = groups;
        }

        public int ImageWidth { get; }

        public int ImageHeight { get; }

        public PosterTagCss Css { get; }

        /// <summary>Image pixels per CSS px.</summary>
        public float Scale { get; }

        public float CardWidth => Css.CardWidth;

        public float CardHeight { get; }

        /// <summary>Groups in paint order (later groups paint over earlier ones).</summary>
        public IReadOnlyList<PlannedGroup> Groups { get; }
    }

    /// <summary>One tag container: its box after corner stacking, whether it clips (overflow: hidden), and its tags.</summary>
    internal sealed class PlannedGroup
    {
        public PlannedGroup(PosterTagGroup group, PosterTagCorner corner, float width, float height, float gap, bool clips, IReadOnlyList<PlannedItem> items)
        {
            Group = group;
            Corner = corner;
            Width = width;
            Height = height;
            Gap = gap;
            Clips = clips;
            Items = items;
        }

        public PosterTagGroup Group { get; }

        public PosterTagCorner Corner { get; }

        public float X { get; set; }

        public float Y { get; set; }

        /// <summary>
        /// Top before corner stacking. The web moves stacked containers with a CSS transform, which Blink applies after
        /// pixel-snapping the container's own position; the renderer reproduces that when placing content.
        /// </summary>
        public float NaturalY { get; set; }

        public float Width { get; }

        public float Height { get; }

        /// <summary>Flex gap between the container's items.</summary>
        public float Gap { get; }

        public bool Clips { get; }

        public IReadOnlyList<PlannedItem> Items { get; }

        public bool IsTop => Corner is PosterTagCorner.TopLeft or PosterTagCorner.TopRight;

        public bool IsLeft => Corner is PosterTagCorner.TopLeft or PosterTagCorner.BottomLeft;
    }

    /// <summary>One chip, circle or flag: its border box in card CSS px plus what was measured to size it.</summary>
    internal sealed class PlannedItem
    {
        public PlannedItem(PosterTagTileKind kind, PosterTag tag, string text, string style, float width, float height)
        {
            Kind = kind;
            Tag = tag;
            Text = text;
            Style = style;
            Width = width;
            Height = height;
        }

        public PosterTagTileKind Kind { get; }

        public PosterTag Tag { get; }

        /// <summary>The text drawn (quality label, rating value, upper-cased age rating), icon name or flag code.</summary>
        public string Text { get; }

        /// <summary>Everything else the tile's pixels depend on (colours, icon variant, partial).</summary>
        public string Style { get; }

        public float X { get; set; }

        public float Y { get; set; }

        public float Width { get; }

        public float Height { get; }

        public PosterTagTextLayout? TextLayout { get; init; }

        /// <summary>Icon inline box (rating chips): width and height in CSS px.</summary>
        public float IconWidth { get; init; }

        public float IconHeight { get; init; }
    }

    /// <summary>
    /// Lays the groups out like the web does: flex columns at 6px from their corner, sized by the card-width CSS,
    /// LayoutUnit-rounded, stacked away from a shared corner with a 4px gap, top-right pushed down 30px when the card
    /// shows an indicator.
    /// </summary>
    internal sealed class PosterTagPlanner
    {
        /// <summary>
        /// Longest tag text measured, in UTF-16 units. Far more than fits on a card (the web's chips overflow it
        /// unwrapped), so it never changes a visible pixel; it bounds shaping work and tile sizes for absurd metadata.
        /// </summary>
        internal const int MaxTextLength = 256;

        private readonly PosterTagAssets _assets;
        private readonly PosterTagText _text;

        public PosterTagPlanner(PosterTagAssets assets, PosterTagText text)
        {
            _assets = assets;
            _text = text;
        }

        public PosterTagPlan Plan(int imageWidth, int imageHeight, PosterTagLayout layout)
        {
            var css = new PosterTagCss(layout.Landscape ? PosterTagCss.LandscapeCardWidth : PosterTagCss.PortraitCardWidth);
            float scale = imageWidth / css.CardWidth;
            float cardHeight = imageHeight / scale;
            var groups = new List<PlannedGroup>();
            foreach (var g in layout.Groups)
            {
                var planned = PlanGroup(g, css, cardHeight);
                if (planned is not null)
                {
                    groups.Add(planned);
                }
            }

            Place(groups, css, cardHeight, layout.TopRightOffset);
            return new PosterTagPlan(imageWidth, imageHeight, css, groups);
        }

        private PlannedGroup? PlanGroup(PosterTagGroupLayout group, PosterTagCss css, float cardHeight)
        {
            var items = new List<PlannedItem>();
            // Right-corner chips are right-aligned, so an overflowing one shows the end of its text.
            bool keepEnd = group.Corner is PosterTagCorner.TopRight or PosterTagCorner.BottomRight;
            foreach (var tag in group.Tags)
            {
                var item = tag switch
                {
                    QualityTag q when group.Group == PosterTagGroup.Quality => MeasureQuality(q, css, keepEnd),
                    GenreTag g when group.Group == PosterTagGroup.Genre => MeasureGenre(g, css),
                    RatingTag r when group.Group == PosterTagGroup.Rating => MeasureRating(r, css, keepEnd),
                    AgeRatingTag a when group.Group == PosterTagGroup.AgeRating => MeasureAge(a, css, keepEnd),
                    LanguageTag l when group.Group == PosterTagGroup.Language => MeasureFlag(l, css),
                    _ => null,
                };
                if (item is not null)
                {
                    items.Add(item);
                }
            }

            if (items.Count == 0)
            {
                return null;
            }

            float gap = group.Group switch
            {
                PosterTagGroup.Quality => PosterTagCss.Lu(css.QualityGap),
                PosterTagGroup.Genre => PosterTagCss.Lu(css.GenreGap),
                PosterTagGroup.Rating => PosterTagCss.Lu(css.RatingGap),
                PosterTagGroup.Language => PosterTagCss.Lu(css.LanguageGap),
                _ => 0f, // the age-rating container has no gap
            };

            float contentWidth = 0f;
            float contentHeight = 0f;
            for (int i = 0; i < items.Count; i++)
            {
                contentWidth = Math.Max(contentWidth, items[i].Width);
                contentHeight += items[i].Height + (i > 0 ? gap : 0f);
            }

            // max-height: 90% (quality, genre, language); max-width: calc(100% - 12px) (quality, rating, age).
            float maxHeight = PosterTagCss.Lu(0.9f * cardHeight);
            float maxWidth = PosterTagCss.Lu(css.CardWidth - (2 * PosterTagCss.CornerInset));
            bool hasMaxHeight = group.Group is PosterTagGroup.Quality or PosterTagGroup.Genre or PosterTagGroup.Language;
            bool hasMaxWidth = group.Group is PosterTagGroup.Quality or PosterTagGroup.Rating or PosterTagGroup.AgeRating;
            float width = hasMaxWidth ? Math.Min(contentWidth, maxWidth) : contentWidth;
            float height = hasMaxHeight ? Math.Min(contentHeight, maxHeight) : contentHeight;
            bool clips = group.Group is PosterTagGroup.Quality or PosterTagGroup.Language;

            return new PlannedGroup(group.Group, group.Corner, width, height, gap, clips, items);
        }

        private static void Place(List<PlannedGroup> groups, PosterTagCss css, float cardHeight, bool topRightOffset)
        {
            var boundary = new Dictionary<PosterTagCorner, float>();
            foreach (var g in groups)
            {
                g.X = g.IsLeft ? PosterTagCss.CornerInset : css.CardWidth - PosterTagCss.CornerInset - g.Width;
                float top = PosterTagCss.CornerInset + (topRightOffset && g.Corner == PosterTagCorner.TopRight ? PosterTagCss.TopRightIndicatorOffset : 0f);
                g.Y = g.IsTop ? top : cardHeight - PosterTagCss.CornerInset - g.Height;
                g.NaturalY = g.Y;

                // applyCornerStacking (tag-renderer-base.js): each later container in a corner moves away from it just
                // enough to leave CORNER_STACK_GAP after the previous one.
                if (boundary.TryGetValue(g.Corner, out var edge))
                {
                    float delta = g.IsTop
                        ? edge + PosterTagCss.CornerStackGap - g.Y
                        : (g.Y + g.Height) - (edge - PosterTagCss.CornerStackGap);
                    if (delta > 0)
                    {
                        g.Y += g.IsTop ? delta : -delta;
                    }
                }

                boundary[g.Corner] = g.IsTop ? g.Y + g.Height : g.Y;

                // Flex column from the container's top; items align to the corner's side (flex-start / flex-end).
                float y = g.Y;
                foreach (var item in g.Items)
                {
                    item.X = g.IsLeft ? g.X : g.X + g.Width - item.Width;
                    item.Y = y;
                    y += item.Height + g.Gap;
                }
            }
        }

        /// <summary>Caps <paramref name="text"/> at <see cref="MaxTextLength"/>, never splitting a surrogate pair.</summary>
        internal static string ClampText(string? text, bool keepEnd)
        {
            text ??= string.Empty;
            if (text.Length <= MaxTextLength)
            {
                return text;
            }

            if (keepEnd)
            {
                int start = text.Length - MaxTextLength;
                return text[(char.IsLowSurrogate(text[start]) ? start + 1 : start)..];
            }

            int end = MaxTextLength;
            return text[..(char.IsHighSurrogate(text[end - 1]) ? end - 1 : end)];
        }

        private PlannedItem MeasureQuality(QualityTag tag, PosterTagCss css, bool keepEnd)
        {
            var label = ClampText(tag.Label, keepEnd);
            var layout = _text.Layout(label, css.QualityFontSize, smallCaps: true, letterSpacing: 0f);
            float width = PosterTagCss.LuCeil(layout.Width) + (2 * PosterTagCss.Lu(css.QualityPaddingH)) + 2f;
            float height = PosterTagCss.Lu(1.2f * css.QualityFontSize) + (2 * PosterTagCss.Lu(css.QualityPaddingV)) + 2f;
            return new PlannedItem(PosterTagTileKind.Quality, tag, label, string.Empty, width, height) { TextLayout = layout };
        }

        private PlannedItem MeasureGenre(GenreTag tag, PosterTagCss css)
        {
            var icon = _assets.GetIcon(tag.Icon ?? string.Empty) is null ? "theaters" : tag.Icon!;
            float size = PosterTagCss.Lu(css.GenreSize) + 2f;
            return new PlannedItem(PosterTagTileKind.Genre, tag, icon, string.Empty, size, size);
        }

        private PlannedItem MeasureRating(RatingTag tag, PosterTagCss css, bool keepEnd)
        {
            var text = ClampText(tag.Text, keepEnd);
            var layout = _text.Layout(text, css.ChipFontSize, smallCaps: false, letterSpacing: 0f);
            float iconWidth;
            float iconHeight;
            switch (tag.Source)
            {
                case PosterRatingSource.Critic:
                    iconWidth = iconHeight = PosterTagCss.Lu(css.RatingIconSize);
                    break;
                case PosterRatingSource.UserReview:
                    iconWidth = GlyphBoxWidth(PosterTagRenderer.UserReviewIconKey, PosterTagCss.UserReviewIconSize);
                    iconHeight = PosterTagCss.Lu(PosterTagCss.UserReviewIconSize);
                    break;
                default:
                    iconWidth = GlyphBoxWidth(PosterTagRenderer.StarIconKey, css.RatingIconSize);
                    iconHeight = PosterTagCss.Lu(css.RatingIconSize);
                    break;
            }

            float textHeight = PosterTagCss.Lu(css.ChipFontSize);
            float width = (2 * PosterTagCss.Lu(css.ChipPaddingH)) + iconWidth + PosterTagCss.Lu(css.RatingInnerGap) + PosterTagCss.LuCeil(layout.Width);
            float height = Math.Max(iconHeight, textHeight) + (2 * PosterTagCss.Lu(css.ChipPaddingV));
            var style = tag.Source == PosterRatingSource.Critic
                ? (tag.Fresh ? "critic-fresh" : "critic-rotten")
                : tag.Source.ToString();
            return new PlannedItem(PosterTagTileKind.Rating, tag, text, style, width, height)
            {
                TextLayout = layout,
                IconWidth = iconWidth,
                IconHeight = iconHeight,
            };
        }

        private PlannedItem MeasureAge(AgeRatingTag tag, PosterTagCss css, bool keepEnd)
        {
            // text-transform: uppercase; the colour key stays case-sensitive (CSS attribute selector).
            var text = ClampText(tag.Text, keepEnd).ToUpperInvariant();
            float fontSize = css.ChipFontSize;
            var layout = _text.Layout(text, fontSize, smallCaps: false, letterSpacing: 0.02f * fontSize);
            float width = PosterTagCss.LuCeil(layout.Width) + (2 * PosterTagCss.Lu(css.ChipPaddingH)) + 2f;
            float height = PosterTagCss.Lu(fontSize) + (2 * PosterTagCss.Lu(css.ChipPaddingV)) + 2f;
            // Only a known colour key reaches the tile key: every unknown one paints the default style, so they share
            // one key instead of each retaining an arbitrary metadata string in the tile cache.
            var style = tag.ColorKey is { } key && _assets.AgeRatingStyles.ContainsKey(key) ? key : string.Empty;
            return new PlannedItem(PosterTagTileKind.AgeRating, tag, text, style, width, height) { TextLayout = layout };
        }

        private PlannedItem? MeasureFlag(LanguageTag tag, PosterTagCss css)
        {
            var code = PosterTagRenderer.FlagAssetCode(tag.FlagCode);
            if (code is null || !_assets.HasFlag(code))
            {
                // The web drops a flag whose image fails to load.
                return null;
            }

            float width = PosterTagCss.Lu(css.FlagWidth);
            float height = PosterTagCss.Lu(width * 0.75f);
            return new PlannedItem(PosterTagTileKind.Flag, tag, code, tag.Partial ? "partial" : string.Empty, width, height);
        }

        /// <summary>An icon glyph's inline box width: its advance, rounded to whole px like any hinted advance.</summary>
        private float GlyphBoxWidth(string iconKey, float size)
        {
            var icon = _assets.GetIcon(iconKey);
            return icon is null ? size : PosterTagCss.RoundHalfUp(icon.Advance / icon.Metrics.UnitsPerEm * size);
        }
    }

    internal static class PosterTagPlanExtensions
    {
        /// <summary>Human-readable plan dump (used by the harness and in debugging).</summary>
        public static string Describe(this PosterTagPlan plan)
        {
            var sb = new System.Text.StringBuilder();
            sb.Append(CultureInfo.InvariantCulture, $"card {plan.CardWidth}x{plan.CardHeight:0.###} scale {plan.Scale:0.####}\n");
            foreach (var g in plan.Groups)
            {
                sb.Append(CultureInfo.InvariantCulture, $"{g.Group} {g.Corner} [{g.X:0.######}, {g.Y:0.######}, {g.Width:0.######} x {g.Height:0.######}]{(g.Clips ? " clip" : string.Empty)}\n");
                foreach (var i in g.Items)
                {
                    sb.Append(CultureInfo.InvariantCulture, $"  {i.Kind} '{i.Text}' {i.Style} [{i.X:0.######}, {i.Y:0.######}, {i.Width:0.######} x {i.Height:0.######}]\n");
                }
            }

            return sb.ToString();
        }
    }
}
