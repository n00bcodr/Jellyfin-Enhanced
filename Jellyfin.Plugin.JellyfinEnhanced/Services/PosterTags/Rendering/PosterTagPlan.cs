using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering
{
    /// <summary>
    /// Where every tag goes on one image, in CSS px of the logical card (the web's layout), before scaling to pixels.
    /// Built by <see cref="PosterTagPlanner"/>; drawn by <see cref="PosterTagRenderer"/>.
    /// </summary>
    internal sealed class PosterTagPlan
    {
        public PosterTagPlan(int imageWidth, int imageHeight, PosterTagCss css, IReadOnlyList<PlannedGroup> groups, IReadOnlyList<PlannedBand>? bands = null)
        {
            ImageWidth = imageWidth;
            ImageHeight = imageHeight;
            Css = css;
            Scale = imageWidth / css.CardWidth;
            CardHeight = imageHeight / Scale;
            Groups = groups;
            Bands = bands ?? Array.Empty<PlannedBand>();
        }

        public IReadOnlyList<PlannedBand> Bands { get; }

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

    internal sealed record PlannedBand(bool Top, float Y, float Height);

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

        public float Width { get; set; }

        public float Height { get; set; }

        /// <summary>Flex gap between the container's items.</summary>
        public float Gap { get; }

        public bool Clips { get; set; }

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

        /// <summary>A whole chip omitted when a centre anchor has no room.</summary>
        public bool Hidden { get; set; }
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

        /// <summary>Flag tile style of a partial dub (dashed outline).</summary>
        internal const string PartialFlagStyle = "partial";

        /// <summary>Flag tile style prefix of a Tag Styles border ring; the encoded colours follow.</summary>
        internal const string RingFlagStyle = "ring\n";

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
                var planned = PlanGroup(g, css, cardHeight, layout.Styles ?? TagStyleSet.Empty);
                if (planned is not null)
                {
                    groups.Add(planned);
                }
            }

            if (layout.Bands)
            {
                var (bandGroups, bands) = PlaceBands(groups, css, cardHeight, layout.TopRightOffset);
                return new PosterTagPlan(imageWidth, imageHeight, css, bandGroups, bands);
            }
            Place(groups, css, cardHeight, layout.TopRightOffset);
            PlaceCentres(groups, css, cardHeight);
            return new PosterTagPlan(imageWidth, imageHeight, css, groups);
        }

        private PlannedGroup? PlanGroup(PosterTagGroupLayout group, PosterTagCss css, float cardHeight, TagStyleSet styles)
        {
            var items = new List<PlannedItem>();
            // Right-corner chips are right-aligned, so an overflowing one shows the end of its text.
            bool keepEnd = group.Corner is PosterTagCorner.TopRight or PosterTagCorner.BottomRight;
            foreach (var tag in group.Tags)
            {
                var item = tag switch
                {
                    QualityTag q when group.Group == PosterTagGroup.Quality => MeasureQuality(q, css, keepEnd, styles),
                    GenreTag g when group.Group == PosterTagGroup.Genre => MeasureGenre(g, css, styles),
                    RatingTag r when group.Group == PosterTagGroup.Rating => MeasureRating(r, css, keepEnd, styles),
                    AgeRatingTag a when group.Group == PosterTagGroup.AgeRating => MeasureAge(a, css, keepEnd, styles),
                    StatusTag status when group.Group == PosterTagGroup.Status => MeasureStatus(status, css, styles),
                    LanguageTag l when group.Group == PosterTagGroup.Language => MeasureFlag(l, css, styles),
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
            bool hasMaxWidth = group.Group is PosterTagGroup.Quality or PosterTagGroup.Rating or PosterTagGroup.AgeRating or PosterTagGroup.Status;
            float width = hasMaxWidth ? Math.Min(contentWidth, maxWidth) : contentWidth;
            float height = hasMaxHeight ? Math.Min(contentHeight, maxHeight) : contentHeight;
            bool clips = group.Group is PosterTagGroup.Quality or PosterTagGroup.Language;

            return new PlannedGroup(group.Group, group.Corner, width, height, gap, clips, items);
        }

        /// <summary>The web chipsThatFit skip-and-continue policy, with +N space reserved on the final row.</summary>
        internal static bool[] BandChipsThatFit(IReadOnlyList<float> widths, float available, float gap, int maxRows, float moreWidth)
        {
            static bool Fits(float need, float room) => need <= room + 0.01f;
            int rows = 0;
            float x = 0;
            foreach (var width in widths)
            {
                if (rows == 0 || !Fits(x + gap + width, available)) { rows++; x = width; }
                else x += gap + width;
            }
            if (rows <= maxRows && widths.All(w => Fits(w, available))) return widths.Select(_ => true).ToArray();
            float Room(int row) => row == maxRows ? available - gap - moreWidth : available;
            int current = 1;
            x = 0;
            return widths.Select(width =>
            {
                if (Fits(x == 0 ? width : x + gap + width, Room(current)))
                {
                    x = x == 0 ? width : x + gap + width;
                    return true;
                }
                if (current < maxRows && x > 0 && Fits(width, Room(current + 1)))
                {
                    current++;
                    x = width;
                    return true;
                }
                return false;
            }).ToArray();
        }

        /// <summary>Fit whole bottom-band chips in two rows, retrying one row when height requires it.</summary>
        internal static List<PlannedItem> FitBandChips(IReadOnlyList<PlannedItem> items, float width, float maxHeight, float gap, Func<int, PlannedItem> overflow)
        {
            for (int rows = 2; rows >= 1; rows--)
            {
                // Web prepareFit measures +<total count> before selecting chips.
                // Keep that reservation even when the actual omitted count is shorter.
                var reserved = overflow(items.Count).Width;
                var fit = BandChipsThatFit(items.Select(i => i.Width).ToArray(), width, gap, rows, reserved);
                var shown = items.Where((_, i) => fit[i]).ToList();
                var hidden = items.Count - shown.Count;
                if (hidden > 0) shown.Add(overflow(hidden));
                float x = 0, y = 0, rowHeight = 0;
                foreach (var chip in shown)
                {
                    if (x > 0 && x + chip.Width > width + 0.01f) { y += rowHeight + gap; x = rowHeight = 0; }
                    chip.X = 6 + x;
                    chip.Y = y;
                    x += chip.Width + gap;
                    rowHeight = Math.Max(rowHeight, chip.Height);
                }
                if (shown.All(i => i.Width <= width + 0.01f) && y + rowHeight <= maxHeight + 0.01f) return shown;
            }
            return new List<PlannedItem>();
        }

        /// <summary>Static band rows keep priority order, reserve indicator room, and count every omitted chip as +N.</summary>
        private (List<PlannedGroup> Groups, List<PlannedBand> Bands) PlaceBands(List<PlannedGroup> source, PosterTagCss css, float cardHeight, bool indicator)
        {
            var groups = new List<PlannedGroup>();
            var bands = new List<PlannedBand>();
            const float gap = 3;
            foreach (var top in new[] { true, false })
            {
                var members = source.Where(g => g.IsTop == top).ToList();
                var items = members.SelectMany(g => g.Items).ToList();
                if (items.Count == 0) continue;
                var width = Math.Max(0, css.CardWidth - 12 - (top && indicator ? 34 : 0));
                var maxHeight = Math.Max(0, (cardHeight * 0.4f) - 6);
                // Lay out a prefix, whole chips only, over at most two rows.
                bool Fit(IReadOnlyList<PlannedItem> chips, out float height)
                {
                    float x = 0, y = 0, rowHeight = 0;
                    int row = 0;
                    foreach (var chip in chips)
                    {
                        if (chip.Width > width) { height = 0; return false; }
                        if (x > 0 && x + chip.Width > width)
                        {
                            y += rowHeight + gap; x = rowHeight = 0; row++;
                        }
                        if (row >= 2 || y + chip.Height > maxHeight) { height = 0; return false; }
                        chip.X = 6 + x; chip.Y = y;
                        x += chip.Width + gap;
                        rowHeight = Math.Max(rowHeight, chip.Height);
                    }
                    height = y + rowHeight;
                    return true;
                }

                List<PlannedItem> shown;
                if (!top)
                {
                    shown = FitBandChips(items, width, maxHeight, gap, hidden =>
                        MeasureStatus(new StatusTag("overflow", "+" + hidden.ToString(CultureInfo.InvariantCulture), ""), css, TagStyleSet.Empty));
                }
                else
                {
                    shown = new List<PlannedItem>();
                    foreach (var item in items)
                    {
                        shown.Add(item);
                        if (!Fit(shown, out _)) { shown.RemoveAt(shown.Count - 1); break; }
                    }
                    if (shown.Count < items.Count)
                    {
                        while (true)
                        {
                            int hidden = items.Count - shown.Count;
                            var more = MeasureStatus(new StatusTag("overflow", "+" + hidden.ToString(CultureInfo.InvariantCulture), ""), css, TagStyleSet.Empty);
                            var trial = shown.Append(more).ToList();
                            if (Fit(trial, out _)) { shown = trial; break; }
                            if (shown.Count == 0) break;
                            shown.RemoveAt(shown.Count - 1);
                        }
                    }
                }
                if (shown.Count == 0 || !Fit(shown, out var height)) continue;
                if (top)
                {
                    // First group's chips stay left, later groups align to the right of each row.
                    var first = members[0].Items.ToHashSet();
                    foreach (var row in shown.GroupBy(i => i.Y))
                    {
                        var trailing = row.Where(i => !first.Contains(i)).ToList();
                        if (trailing.Count == 0) continue;
                        float shift = 6 + width - (trailing[^1].X + trailing[^1].Width);
                        foreach (var item in trailing) item.X += shift;
                    }
                }
                float y = top ? 6 : cardHeight - 6 - height;
                foreach (var item in shown) item.Y += y;
                var band = new PlannedGroup(members[0].Group, top ? PosterTagCorner.TopLeft : PosterTagCorner.BottomLeft,
                    width, height, gap, false, shown) { X = 6, Y = y, NaturalY = y };
                groups.Add(band);
                bands.Add(new PlannedBand(top, top ? 0 : Math.Max(0, y - 16), Math.Min(cardHeight, height + 22)));
            }
            return (groups, bands);
        }

        /// <summary>Localized status chips use the same dimensions and label-specific Tag Styles as the web.</summary>
        private PlannedItem MeasureStatus(StatusTag tag, PosterTagCss css, TagStyleSet styles)
        {
            var text = ClampText(tag.Text, false);
            float fontSize = css.ChipFontSize;
            var layout = _text.Layout(text, fontSize, smallCaps: false, letterSpacing: 0.01f * fontSize);
            float width = PosterTagCss.LuCeil(layout.Width) + 2 * PosterTagCss.Lu(Math.Clamp(css.CardWidth * 0.05f, 5, 10)) + 2;
            float height = PosterTagCss.Lu(fontSize * 1.15f) + 2 * PosterTagCss.Lu(css.ChipPaddingV) + 2;
            var colors = styles.Resolve(TagStyleKeys.Status, tag.StyleKey);
            // Identity includes the status family as well as all effective colours and text.
            return new PlannedItem(PosterTagTileKind.Status, tag, text, tag.StyleKey + "\n" + colors.Encode(), width, height) { TextLayout = layout };
        }

        private static void Place(List<PlannedGroup> groups, PosterTagCss css, float cardHeight, bool topRightOffset)
        {
            var boundary = new Dictionary<PosterTagCorner, float>();
            foreach (var g in groups.Where(g => !IsCentre(g.Corner)))
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

        /// <summary>The extra anchors; the original corner placement above stays unchanged.</summary>
        private static bool IsCentre(PosterTagCorner corner) => corner is PosterTagCorner.TopCenter or PosterTagCorner.BottomCenter or PosterTagCorner.CenterLeft or PosterTagCorner.CenterRight or PosterTagCorner.Center;

        /// <summary>
        /// Centre rows wrap with a 4px gap and centre each line; side anchors
        /// stack between the occupied corner stacks. All dimensions are CSS px.
        /// Static images omit whole chips that have no room (there is no hover tooltip).
        /// </summary>
        private static void PlaceCentres(List<PlannedGroup> groups, PosterTagCss css, float cardHeight)
        {
            float inset = PosterTagCss.CornerInset;
            foreach (var anchor in groups.Where(g => IsCentre(g.Corner)).GroupBy(g => g.Corner))
            {
                var corner = anchor.Key;
                bool vertical = corner is PosterTagCorner.CenterLeft or PosterTagCorner.CenterRight;
                bool right = corner == PosterTagCorner.CenterRight;
                var neighbours = groups.Where(g => !IsCentre(g.Corner) && (vertical
                    ? g.IsLeft == !right
                    : corner == PosterTagCorner.TopCenter ? g.IsTop : corner == PosterTagCorner.BottomCenter && !g.IsTop)).ToList();
                float reserve = neighbours.Select(g => vertical
                    ? g.IsTop ? g.Y + g.Height + 4 : cardHeight - g.Y + 4
                    : g.IsLeft ? g.X + g.Width + 4 : css.CardWidth - g.X + 4).DefaultIfEmpty(inset).Max();
                float width = Math.Max(0, vertical ? (css.CardWidth / 2) - inset : css.CardWidth - (2 * reserve));
                float maxHeight = Math.Max(0, vertical ? cardHeight - (2 * reserve) : cardHeight / 3);
                var items = anchor.SelectMany(g => g.Items).ToList();
                var rows = new List<List<PlannedItem>>();
                float used = 0, rowHeight = 0, height = 0;
                foreach (var item in items)
                {
                    if (vertical)
                    {
                        if (item.Width > width || height + item.Height > maxHeight) { item.Hidden = true; continue; }
                        item.Y = height;
                        height += item.Height + 4;
                    }
                    else
                    {
                        if (item.Width > width) { item.Hidden = true; continue; }
                        bool wrap = rows.Count == 0 || used + 4 + item.Width > width;
                        if (wrap)
                        {
                            if (rows.Count == 2 || height + (rows.Count > 0 ? rowHeight + 4 : 0) + item.Height > maxHeight) { item.Hidden = true; continue; }
                            if (rows.Count > 0) height += rowHeight + 4;
                            rows.Add(new List<PlannedItem>());
                            used = rowHeight = 0;
                        }
                        if (height + Math.Max(rowHeight, item.Height) > maxHeight) { item.Hidden = true; continue; }
                        item.X = used + (used > 0 ? 4 : 0);
                        item.Y = height;
                        used = item.X + item.Width;
                        rowHeight = Math.Max(rowHeight, item.Height);
                        rows[^1].Add(item);
                    }
                }
                if (vertical) height = Math.Max(0, height - 4);
                else
                {
                    height += rowHeight;
                    foreach (var row in rows)
                    {
                        float rowWidth = row.Count > 0 ? row[^1].X + row[^1].Width : 0;
                        float tallest = row.Select(i => i.Height).DefaultIfEmpty(0).Max();
                        foreach (var item in row) { item.X += (width - rowWidth) / 2; item.Y += (tallest - item.Height) / 2; }
                    }
                }
                float x = vertical ? right ? css.CardWidth - inset - width : inset : (css.CardWidth - width) / 2;
                float y = corner == PosterTagCorner.TopCenter ? inset : corner == PosterTagCorner.BottomCenter ? cardHeight - inset - height : (cardHeight - height) / 2;
                foreach (var g in anchor)
                {
                    g.X = x; g.Y = g.NaturalY = y; g.Width = width; g.Height = height; g.Clips = true;
                    foreach (var item in g.Items)
                    {
                        item.X = x + (vertical ? right ? width - item.Width : 0 : item.X);
                        item.Y += y;
                    }
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

        private PlannedItem MeasureQuality(QualityTag tag, PosterTagCss css, bool keepEnd, TagStyleSet styles)
        {
            var label = ClampText(tag.DisplayText ?? tag.Label, keepEnd);
            var layout = _text.Layout(label, css.QualityFontSize, smallCaps: true, letterSpacing: 0f);
            float width = PosterTagCss.LuCeil(layout.Width) + (2 * PosterTagCss.Lu(css.QualityPaddingH)) + 2f;
            float height = PosterTagCss.Lu(1.2f * css.QualityFontSize) + (2 * PosterTagCss.Lu(css.QualityPaddingV)) + 2f;
            return new PlannedItem(PosterTagTileKind.Quality, tag, label, StyleKey(styles.ResolveQuality(tag.Label)), width, height) { TextLayout = layout };
        }

        private PlannedItem MeasureGenre(GenreTag tag, PosterTagCss css, TagStyleSet styles)
        {
            var icon = _assets.GetIcon(tag.Icon ?? string.Empty) is null ? "theaters" : tag.Icon!;
            float size = PosterTagCss.Lu(css.GenreSize) + 2f;
            return new PlannedItem(PosterTagTileKind.Genre, tag, icon, StyleKey(styles.Resolve(TagStyleKeys.Genre, "genre")), size, size);
        }

        private PlannedItem MeasureRating(RatingTag tag, PosterTagCss css, bool keepEnd, TagStyleSet styles)
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

            if (tag.IsSource) iconWidth = iconHeight = 14; // Bundled source logos match the web's fixed 14px box.
            if (tag.Compact) iconWidth = iconHeight = 2;
            float textHeight = PosterTagCss.Lu(css.ChipFontSize);
            float width = (2 * PosterTagCss.Lu(css.ChipPaddingH)) + iconWidth + PosterTagCss.Lu(css.RatingInnerGap) + PosterTagCss.LuCeil(layout.Width);
            float height = Math.Max(iconHeight, textHeight) + (2 * PosterTagCss.Lu(css.ChipPaddingV));
            var style = tag.Source == PosterRatingSource.Critic
                ? (tag.Fresh ? "critic-fresh" : "critic-rotten")
                : tag.Source.ToString();
            style += ":" + tag.ScoreColor + ":" + tag.Compact;
            var chipKey = tag.SourceId;
            var chip = styles.Resolve(TagStyleKeys.Rating, chipKey);
            if (!chip.IsEmpty)
            {
                style += "\n" + chip.Encode();
            }

            return new PlannedItem(PosterTagTileKind.Rating, tag, text, style, width, height)
            {
                TextLayout = layout,
                IconWidth = iconWidth,
                IconHeight = iconHeight,
            };
        }

        private PlannedItem MeasureAge(AgeRatingTag tag, PosterTagCss css, bool keepEnd, TagStyleSet styles)
        {
            // text-transform: uppercase; the colour key stays case-sensitive (CSS attribute selector).
            var text = ClampText(tag.Text, keepEnd).ToUpperInvariant();
            float fontSize = css.ChipFontSize;
            var layout = _text.Layout(text, fontSize, smallCaps: false, letterSpacing: 0.02f * fontSize);
            float width = PosterTagCss.LuCeil(layout.Width) + (2 * PosterTagCss.Lu(css.ChipPaddingH)) + 2f;
            float height = PosterTagCss.Lu(fontSize) + (2 * PosterTagCss.Lu(css.ChipPaddingV)) + 2f;
            // Only a known colour key reaches the tile key: every unknown one paints the default style, so they share
            // one key instead of each retaining an arbitrary metadata string in the tile cache.
            var style = string.Empty;
            var board = TagStyleKeys.AnyLabel;
            if (tag.ColorKey is { } key && _assets.AgeRatingStyles.TryGetValue(key, out var known))
            {
                style = key;
                board = known.Group;
            }

            var over = styles.Resolve(TagStyleKeys.AgeRating, board);
            if (!over.IsEmpty)
            {
                style += "\n" + over.Encode();
            }

            return new PlannedItem(PosterTagTileKind.AgeRating, tag, text, style, width, height) { TextLayout = layout };
        }

        /// <summary>A resolved style as a tile-key fragment; empty when nothing is overridden.</summary>
        private static string StyleKey(TagColors colors) => colors.IsEmpty ? string.Empty : colors.Encode();

        private PlannedItem? MeasureFlag(LanguageTag tag, PosterTagCss css, TagStyleSet styles)
        {
            if (tag.Code is not null || tag.CountBadge is not null || tag.Subtitle)
            {
                var text = tag.CountBadge ?? (tag.Subtitle ? "CC " : string.Empty) + (tag.Code ?? string.Empty);
                var layout = _text.Layout(text, css.ChipFontSize, smallCaps: false, letterSpacing: 0f);
                float flagWidth = tag.Code is null && tag.CountBadge is null ? PosterTagCss.Lu(css.FlagWidth) : 0;
                var flagCode = PosterTagRenderer.FlagAssetCode(tag.FlagCode);
                if (flagWidth > 0 && (flagCode is null || !_assets.HasFlag(flagCode))) return null;
                var label = tag.CountBadge is not null ? "countBadge" : tag.Subtitle ? "subtitles" : "flag";
                var colors = styles.Resolve(TagStyleKeys.Language, label);
                float chipWidth = PosterTagCss.LuCeil(layout.Width) + flagWidth + 10f;
                float chipHeight = Math.Max(PosterTagCss.Lu(css.ChipFontSize), flagWidth * 0.75f) + 6f;
                // The key carries flag identity, partial treatment, and label-specific style.
                return new PlannedItem(PosterTagTileKind.LanguageChip, tag, text, (flagCode ?? string.Empty) + "|" + tag.Partial + "|" + colors.Encode(), chipWidth, chipHeight)
                { TextLayout = layout, IconWidth = flagWidth, IconHeight = flagWidth * 0.75f };
            }

            var code = PosterTagRenderer.FlagAssetCode(tag.FlagCode);
            if (code is null || !_assets.HasFlag(code))
            {
                // The web drops a flag whose image fails to load.
                return null;
            }

            float width = PosterTagCss.Lu(css.FlagWidth);
            float height = PosterTagCss.Lu(width * 0.75f);
            // A partial flag keeps its dashed outline; a full one can take the Tag Styles border ring.
            var ring = styles.Resolve(TagStyleKeys.Language, "flag");
            var style = tag.Partial ? PartialFlagStyle : ring.Border is null ? string.Empty : RingFlagStyle + ring.Encode();
            return new PlannedItem(PosterTagTileKind.Flag, tag, code, style, width, height);
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
