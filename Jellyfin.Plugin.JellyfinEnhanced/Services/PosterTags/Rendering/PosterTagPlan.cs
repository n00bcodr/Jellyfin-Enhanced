using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Resolution;

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

        public IReadOnlyList<PlannedItem> Items { get; private set; }

        internal void AppendItem(PlannedItem item) => Items = Items.Append(item).ToArray();

        public bool IsTop => Corner is PosterTagCorner.TopLeft or PosterTagCorner.TopRight;

        public bool IsLeft => Corner is PosterTagCorner.TopLeft or PosterTagCorner.BottomLeft;
    }

    [Flags]
    internal enum FlushEdges { None = 0, Left = 1, Top = 2, Right = 4, Bottom = 8 }

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
        public string Text { get; set; }

        /// <summary>Everything else the tile's pixels depend on (colours, icon variant, partial).</summary>
        public string Style { get; }

        public float X { get; set; }

        public float Y { get; set; }

        public float Width { get; set; }

        public float Height { get; }

        public PosterTagTextLayout? TextLayout { get; set; }

        /// <summary>Icon inline box (rating chips): width and height in CSS px.</summary>
        public float IconWidth { get; init; }

        public float IconHeight { get; init; }

        /// <summary>A whole chip omitted when a centre anchor has no room.</summary>
        public bool Hidden { get; set; }

        public FlushEdges FlushEdges { get; set; }
    }

    /// <summary>
    /// Lays the groups out like the web does: flex columns at 6px from their corner, sized by the card-width CSS,
    /// LayoutUnit-rounded, stacked away from a shared corner with a 4px gap, top-right pushed down 30px when the card
    /// shows an indicator.
    /// </summary>
    internal sealed class PosterTagPlanner
    {
        /// <summary>Exact zero denotes an empty row or Flush edge policy; never use a tolerance.</summary>
        private static bool IsExactlyZero(float value) => value.Equals(0f);

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
            var css = new PosterTagCss(layout.Landscape ? PosterTagCss.LandscapeCardWidth : PosterTagCss.PortraitCardWidth, layout.TagScale, layout.TagGap);
            float scale = imageWidth / css.CardWidth;
            float cardHeight = imageHeight / scale;
            var groups = new List<PlannedGroup>();
            foreach (var g in layout.Groups)
            {
                var planned = PlanGroup(g, css, cardHeight, layout.Styles ?? TagStyleSet.Empty, layout.EdgeInset);
                if (planned is not null)
                {
                    groups.Add(planned);
                }
            }

            if (layout.Bands)
            {
                var (bandGroups, bands) = PlaceBands(groups, css, cardHeight, layout.TopRightOffset, layout.EdgeInset);
                return new PosterTagPlan(imageWidth, imageHeight, css, bandGroups, bands);
            }
            Place(groups, css, cardHeight, layout.TopRightOffset, layout.EdgeInset);
            PlaceCentres(groups, css, cardHeight, layout.EdgeInset, layout.TopRightOffset, layout.ProgressBarHeight);
            if (IsExactlyZero(layout.EdgeInset)) ApplyFlushEdges(groups, css.CardWidth, cardHeight - Math.Clamp(layout.ProgressBarHeight, 0, cardHeight));
            return new PosterTagPlan(imageWidth, imageHeight, css, groups);
        }

        private PlannedGroup? PlanGroup(PosterTagGroupLayout group, PosterTagCss css, float cardHeight, TagStyleSet styles, float inset)
        {
            var items = new List<PlannedItem>();
            // Right-corner chips are right-aligned, so an overflowing one shows the end of its text.
            bool keepEnd = group.Corner is PosterTagCorner.TopRight or PosterTagCorner.BottomRight;
            foreach (var tag in group.Tags)
            {
                var item = tag switch
                {
                    OverflowTag more => MeasureOverflow(more.Count, css),
                    QualityTag q when group.Group == PosterTagGroup.Quality => MeasureQuality(q, css, keepEnd, styles),
                    GenreTag g when group.Group == PosterTagGroup.Genre => MeasureGenre(g, css, styles),
                    RatingTag r when group.Group == PosterTagGroup.Rating => MeasureRating(r, css, keepEnd, styles),
                    AwardTag a when group.Group == PosterTagGroup.Awards => MeasureAward(a, css, keepEnd, styles),
                    AgeRatingTag a when group.Group == PosterTagGroup.AgeRating => MeasureAge(a, css, keepEnd, styles),
                    StatusTag status when group.Group == PosterTagGroup.Status => MeasureStatus(status, css, styles),
                    LanguageTag l when group.Group == PosterTagGroup.Language => MeasureFlag(l, css, styles),
                    LogoTag l when group.Group == PosterTagGroup.Logos => MeasureLogo(l, css, styles),
                    CustomTag c when group.Group == PosterTagGroup.Custom => MeasureCustom(c, css, keepEnd, styles),
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
                PosterTagGroup.Awards => PosterTagCss.Lu(css.StackGap),
                PosterTagGroup.Language => PosterTagCss.Lu(css.LanguageGap),
                PosterTagGroup.Logos => PosterTagCss.Lu(PosterTagCss.LogoGap * css.Scale * css.Gap),
                PosterTagGroup.Custom => PosterTagCss.Lu(PosterTagCss.CustomGap * css.Scale * css.Gap),
                _ => 0f, // the age-rating container has no gap
            };

            float contentWidth = 0f;
            float contentHeight = 0f;
            for (int i = 0; i < items.Count; i++)
            {
                contentWidth = Math.Max(contentWidth, items[i].Width);
                contentHeight += items[i].Height + (i > 0 ? gap : 0f);
            }

            // max-height: 90% (quality, genre, language); max-width: the corner slot's width, calc(100% - 2 × inset)
            // (quality, rating, age).
            float maxHeight = PosterTagCss.Lu(0.9f * cardHeight);
            float maxWidth = PosterTagCss.Lu(css.CardWidth - (2 * inset));
            bool hasMaxHeight = group.Group is PosterTagGroup.Quality or PosterTagGroup.Genre or PosterTagGroup.Language;
            bool hasMaxWidth = group.Group is PosterTagGroup.Quality or PosterTagGroup.Rating or PosterTagGroup.AgeRating or PosterTagGroup.Status or PosterTagGroup.Logos or PosterTagGroup.Custom;
            float width = hasMaxWidth ? Math.Min(contentWidth, maxWidth) : contentWidth;
            float height = hasMaxHeight ? Math.Min(contentHeight, maxHeight) : contentHeight;
            bool clips = group.Group is PosterTagGroup.Quality or PosterTagGroup.Language;

            return new PlannedGroup(group.Group, group.Corner, width, height, gap, clips, items);
        }

        /// <summary>
        /// The web chipsThatFit policy, with +N space reserved on the final row: chips in priority order until
        /// the first one with no room, which ends the rows (what is shown is a prefix, so removing a chip only
        /// lets more of the others in). A chip that can never be shown (wider than a whole row; in a single
        /// row, too wide to sit beside +N) is skipped on its own.
        /// </summary>
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
            bool Usable(float width) => Fits(width, maxRows == 1 ? Room(1) : available);
            int current = 1;
            x = 0;
            bool ended = false;
            return widths.Select(width =>
            {
                if (maxRows <= 0 || ended || !Usable(width)) return false;
                if (Fits(IsExactlyZero(x) ? width : x + gap + width, Room(current)))
                {
                    x = IsExactlyZero(x) ? width : x + gap + width;
                    return true;
                }
                if (current < maxRows && x > 0 && Fits(width, Room(current + 1)))
                {
                    current++;
                    x = width;
                    return true;
                }
                ended = true;
                return false;
            }).ToArray();
        }

        /// <summary>
        /// The web rowBudget: the most rows (at most two) whose height fits even if they hold the r tallest
        /// chips (+N included), so the budget does not depend on which chips share a row.
        /// </summary>
        internal static int RowBudget(IEnumerable<float> heights, float moreHeight, float limit, float rowGap)
        {
            var tallest = heights.Append(moreHeight).Where(h => h > 0).OrderByDescending(h => h).ToArray();
            if (tallest.Length == 0) return 2;
            for (int rows = 2; rows >= 1; rows--)
            {
                if (tallest.Take(rows).Sum() + rowGap * (rows - 1) <= limit + 0.01f) return rows;
            }
            return 0;
        }

        /// <summary>Fit whole bottom-band chips in the rows the height has room for (RowBudget).</summary>
        internal static List<PlannedItem> FitBandChips(IReadOnlyList<PlannedItem> items, float width, float maxHeight, float gap, Func<int, PlannedItem> overflow, float inset = 6f)
        {
            // Web prepareFit measures +<total count> before selecting chips.
            // Keep that reservation even when the actual omitted count is shorter.
            var reservedChip = overflow(items.Count);
            int budget = RowBudget(items.Select(i => i.Height), reservedChip.Height, maxHeight, gap);
            for (int rows = budget; rows >= 1; rows--)
            {
                var reserved = reservedChip.Width;
                var fit = BandChipsThatFit(items.Select(i => i.Width).ToArray(), width, gap, rows, reserved);
                var shown = items.Where((_, i) => fit[i]).ToList();
                var hidden = items.Count - shown.Count;
                if (hidden > 0) shown.Add(overflow(hidden));
                float x = 0, y = 0, rowHeight = 0;
                foreach (var chip in shown)
                {
                    if (x > 0 && x + chip.Width > width + 0.01f) { y += rowHeight + gap; x = rowHeight = 0; }
                    chip.X = inset + x;
                    chip.Y = y;
                    x += chip.Width + gap;
                    rowHeight = Math.Max(rowHeight, chip.Height);
                }
                if (shown.All(i => i.Width <= width + 0.01f) && y + rowHeight <= maxHeight + 0.01f) return shown;
            }
            return new List<PlannedItem>();
        }

        /// <summary>Static band rows keep priority order, reserve indicator room, and count every omitted chip as +N.</summary>
        private (List<PlannedGroup> Groups, List<PlannedBand> Bands) PlaceBands(List<PlannedGroup> source, PosterTagCss css, float cardHeight, bool indicator, float inset)
        {
            var groups = new List<PlannedGroup>();
            var bands = new List<PlannedBand>();
            float gap = PosterTagCss.Lu(3 * css.Scale * css.Gap);
            foreach (var top in new[] { true, false })
            {
                var members = source.Where(g => g.IsTop == top).ToList();
                var items = members.SelectMany(g => g.Items).ToList();
                if (items.Count == 0) continue;
                var width = Math.Max(0, css.CardWidth - 2 * inset - (top && indicator ? 4 + css.IndicatorOffset : 0));
                var maxHeight = Math.Max(0, (cardHeight * 0.4f) - inset);
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
                        chip.X = inset + x; chip.Y = y;
                        x += chip.Width + gap;
                        rowHeight = Math.Max(rowHeight, chip.Height);
                    }
                    height = y + rowHeight;
                    return true;
                }

                List<PlannedItem> shown;
                if (!top)
                {
                    shown = FitBandChips(items, width, maxHeight, gap, count => MeasureOverflow(count, css), inset);
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
                            var more = MeasureOverflow(hidden, css);
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
                        float shift = inset + width - (trailing[^1].X + trailing[^1].Width);
                        foreach (var item in trailing) item.X += shift;
                    }
                }
                float y = top ? inset : cardHeight - inset - height;
                foreach (var item in shown) item.Y += y;
                var band = new PlannedGroup(members[0].Group, top ? PosterTagCorner.TopLeft : PosterTagCorner.BottomLeft,
                    width, height, gap, false, shown) { X = inset, Y = y, NaturalY = y };
                groups.Add(band);
                bands.Add(new PlannedBand(top, top ? 0 : Math.Max(0, y - 16), Math.Min(cardHeight, height + 16 + inset)));
            }
            return (groups, bands);
        }

        /// <summary>Measure the web's size-scaled .je-tag-more, without Status letter spacing or padding.</summary>
        private PlannedItem MeasureOverflow(int count, PosterTagCss css)
        {
            var text = "+" + count.ToString(CultureInfo.InvariantCulture);
            // TextTypeface is the embedded Noto Sans Bold (font-weight: 700).
            var layout = _text.Layout(text, css.OverflowFontSize, smallCaps: false, letterSpacing: 0);
            float width = PosterTagCss.LuCeil(layout.Width) + 2 * PosterTagCss.Lu(css.OverflowPaddingH) + 2;
            float height = css.OverflowLineHeight + 2 * PosterTagCss.Lu(css.OverflowPaddingV) + 2;
            // Its own tile kind separates these overflow metrics/colours from every Status tile.
            return new PlannedItem(PosterTagTileKind.Overflow, new OverflowTag(count), text, string.Empty, width, height) { TextLayout = layout };
        }

        /// <summary>Localized status chips use the same dimensions and label-specific Tag Styles as the web.</summary>
        private PlannedItem MeasureStatus(StatusTag tag, PosterTagCss css, TagStyleSet styles)
        {
            var text = ClampText(tag.Text, false);
            float fontSize = css.ChipFontSize;
            var layout = _text.Layout(text, fontSize, smallCaps: false, letterSpacing: 0.01f * fontSize);
            float width = PosterTagCss.LuCeil(layout.Width) + 2 * PosterTagCss.Lu(Math.Clamp(css.CardWidth * 0.05f, 5, 10) * css.Scale) + 2;
            float height = PosterTagCss.Lu(fontSize * 1.15f) + 2 * PosterTagCss.Lu(css.ChipPaddingV) + 2;
            var colors = styles.Resolve(TagStyleKeys.Status, tag.StyleKey);
            // Identity includes the status family as well as all effective colours and text.
            return new PlannedItem(PosterTagTileKind.Status, tag, text, tag.StyleKey + "\n" + colors.Encode(), width, height) { TextLayout = layout };
        }

        private static void Place(List<PlannedGroup> groups, PosterTagCss css, float cardHeight, bool topRightOffset, float inset)
        {
            var boundary = new Dictionary<PosterTagCorner, float>();
            foreach (var g in groups.Where(g => !IsCentre(g.Corner)))
            {
                g.X = g.IsLeft ? inset : css.CardWidth - inset - g.Width;
                float top = inset + (topRightOffset && g.Corner == PosterTagCorner.TopRight ? css.IndicatorOffset : 0f);
                g.Y = g.IsTop ? top : cardHeight - inset - g.Height;
                g.NaturalY = g.Y;

                // applyCornerStacking (tag-renderer-base.js): each later container in a corner moves away from it just
                // enough to leave CORNER_STACK_GAP after the previous one.
                if (boundary.TryGetValue(g.Corner, out var edge))
                {
                    float delta = g.IsTop
                        ? edge + css.StackGap - g.Y
                        : (g.Y + g.Height) - (edge - css.StackGap);
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
        private void PlaceCentres(List<PlannedGroup> groups, PosterTagCss css, float cardHeight, float inset, bool indicators, float progressHeight)
        {
            float gap = css.StackGap;
            // Snapshot intrinsic widths before placing either side, so paint order
            // and a previously fitted width cannot affect the opposite budget.
            var sides = groups.Where(g => g.Corner is PosterTagCorner.CenterLeft or PosterTagCorner.CenterRight)
                .GroupBy(g => g.Corner).ToDictionary(g => g.Key, g => g.SelectMany(v => v.Items).Max(i => i.Width));
            foreach (var anchor in groups.Where(g => IsCentre(g.Corner)).GroupBy(g => g.Corner))
            {
                var corner = anchor.Key;
                bool vertical = corner is PosterTagCorner.CenterLeft or PosterTagCorner.CenterRight;
                bool right = corner == PosterTagCorner.CenterRight;
                var neighbours = groups.Where(g => !IsCentre(g.Corner) && (vertical
                    ? g.IsLeft == !right
                    : corner == PosterTagCorner.TopCenter ? g.IsTop : corner == PosterTagCorner.BottomCenter && !g.IsTop)).ToList();
                float reserve = neighbours.Select(g => vertical
                    ? g.IsTop ? g.Y + g.Height + gap : cardHeight - g.Y + gap
                    : g.IsLeft ? g.X + g.Width + gap : css.CardWidth - g.X + gap).DefaultIfEmpty(inset).Max();
                float top = inset;
                float bottom = Math.Max(inset, Math.Clamp(progressHeight, 0, cardHeight) + (IsExactlyZero(inset) ? 0 : gap));
                if (progressHeight <= 0) bottom = inset;
                if (IsExactlyZero(inset) && corner == PosterTagCorner.TopCenter)
                {
                    // The native indicator occupies the top-right corner. Try
                    // the symmetric gap first, then move below it if needed.
                    if (indicators) reserve = Math.Max(reserve, css.IndicatorOffset + gap);
                    var first = anchor.SelectMany(g => g.Items).FirstOrDefault();
                    if (first != null && first.Width > css.CardWidth - 2 * reserve)
                    {
                        top = Math.Max(indicators ? css.IndicatorOffset + gap : 0, neighbours.Select(g => g.Y + g.Height + gap).DefaultIfEmpty(0).Max());
                        reserve = 0;
                    }
                }
                float inner = Math.Max(0, css.CardWidth - 2 * inset);
                float half = Math.Max(0, (inner - gap) / 2);
                bool occupied = sides.TryGetValue(right ? PosterTagCorner.CenterLeft : PosterTagCorner.CenterRight, out var opposite);
                float sideWidth = Math.Max(0, Math.Min(occupied ? half : inner, inner - Math.Min(half, opposite) - gap));
                float width = vertical ? sideWidth : Math.Max(0, css.CardWidth - (2 * reserve));
                float maxHeight = Math.Max(0, vertical ? cardHeight - (2 * reserve) : cardHeight / 3);
                var items = anchor.SelectMany(g => g.Items).ToList();
                // The first fact is useful even when a whole chip cannot fit.
                // Constrain its text instead of replacing the slot with a count.
                if (items.Count > 0 && items[0].Width > width) EllipsizeFirst(items[0], width);
                var rows = new List<List<PlannedItem>>();
                float used = 0, rowHeight = 0, height = 0;
                foreach (var item in items)
                {
                    if (vertical)
                    {
                        if (item != items[0] && (item.Width > width || height + item.Height > maxHeight)) { item.Hidden = true; continue; }
                        item.Y = height;
                        height += item.Height + gap;
                    }
                    else
                    {
                        if (item.Width > width) { item.Hidden = true; continue; }
                        bool wrap = rows.Count == 0 || used + gap + item.Width > width;
                        if (wrap)
                        {
                            if (item != items[0] && (rows.Count == 2 || height + (rows.Count > 0 ? rowHeight + gap : 0) + item.Height > maxHeight)) { item.Hidden = true; continue; }
                            if (rows.Count > 0) height += rowHeight + gap;
                            rows.Add(new List<PlannedItem>());
                            used = rowHeight = 0;
                        }
                        if (item != items[0] && height + Math.Max(rowHeight, item.Height) > maxHeight) { item.Hidden = true; continue; }
                        item.X = used + (used > 0 ? gap : 0);
                        item.Y = height;
                        used = item.X + item.Width;
                        rowHeight = Math.Max(rowHeight, item.Height);
                        rows[^1].Add(item);
                    }
                }
                if (items.Any(i => i.Hidden))
                {
                    // Centre slots expose every omitted fact through one slot-level +N,
                    // reserving its box before selecting a prefix/skip-and-continue fit.
                    var original = items.ToArray();
                    var reserved = MeasureOverflow(original.Length, css);
                    PlannedItem? more = null;
                    if (vertical)
                    {
                        var fit = BandChipsThatFit(original.Select(i => i.Width <= width + 0.01f ? i.Height : float.PositiveInfinity).ToArray(), maxHeight, gap, 1, reserved.Height);
                        if (!fit[0]) fit = original.Select((_, i) => i == 0).ToArray();
                        height = 0;
                        for (int i = 0; i < original.Length; i++)
                        {
                            original[i].Hidden = !fit[i];
                            if (!fit[i]) continue;
                            original[i].Y = height;
                            height += original[i].Height + gap;
                        }
                        var hidden = fit.Count(shown => !shown);
                        if (hidden > 0 && width >= reserved.Width && height + reserved.Height <= maxHeight + 0.01f)
                        {
                            more = MeasureOverflow(hidden, css);
                            more.Y = height;
                            height += more.Height + gap;
                        }
                    }
                    else
                    {
                        var fitted = FitBandChips(original, width, maxHeight, gap, count => MeasureOverflow(count, css), 0);
                        if (!fitted.Contains(original[0]))
                        {
                            fitted = new List<PlannedItem> { original[0] };
                            original[0].X = original[0].Y = 0;
                            if (width >= reserved.Width && original[0].Height + gap + reserved.Height <= maxHeight + 0.01f)
                            {
                                var fallback = MeasureOverflow(original.Length - 1, css);
                                fallback.Y = original[0].Height + gap;
                                fitted.Add(fallback);
                            }
                        }
                        foreach (var item in original) item.Hidden = !fitted.Contains(item);
                        more = fitted.FirstOrDefault(i => !original.Contains(i));
                        rows = fitted.GroupBy(i => i.Y).OrderBy(r => r.Key).Select(r => r.ToList()).ToList();
                        height = rows.Take(Math.Max(0, rows.Count - 1)).Sum(r => r.Max(i => i.Height) + gap);
                        rowHeight = rows.LastOrDefault()?.Max(i => i.Height) ?? 0;
                    }
                    if (more is not null)
                    {
                        anchor.Last().AppendItem(more);
                        items.Add(more);
                    }
                }
                if (vertical) height = Math.Max(0, height - gap);
                else
                {
                    height += rowHeight;
                    foreach (var row in rows)
                    {
                        float rowWidth = row.Count > 0 ? row[^1].X + row[^1].Width : 0;
                        float tallest = row.Select(i => i.Height).DefaultIfEmpty(0).Max();
                        foreach (var item in row)
                        {
                            item.X += (width - rowWidth) / 2;
                            item.Y += IsExactlyZero(inset) && corner == PosterTagCorner.TopCenter ? 0
                                : IsExactlyZero(inset) && corner == PosterTagCorner.BottomCenter ? tallest - item.Height
                                : (tallest - item.Height) / 2;
                        }
                    }
                }
                float x = vertical ? right ? css.CardWidth - inset - width : inset : (css.CardWidth - width) / 2;
                float y = corner == PosterTagCorner.TopCenter ? top : corner == PosterTagCorner.BottomCenter ? cardHeight - bottom - height : (cardHeight - height) / 2;
                foreach (var g in anchor)
                {
                    g.X = x; g.Y = g.NaturalY = y; g.Width = width; g.Height = height; g.Clips = !IsExactlyZero(inset);
                    foreach (var item in g.Items)
                    {
                        item.X = x + (vertical ? right ? width - item.Width : 0 : item.X);
                        item.Y += y;
                    }
                }
            }
        }

        /// <summary>Keep the first centre chip within its budget with a shaped ellipsis, preserving its label/style identity.</summary>
        private void EllipsizeFirst(PlannedItem item, float width)
        {
            if (item.TextLayout is { } original)
            {
                // Reuse the builder's shaping parameters for every tile kind,
                // including text logos whose font and tracking differ from chips.
                float fontSize = original.FontSize;
                bool smallCaps = original.SmallCaps;
                float spacing = original.LetterSpacing;
                float available = Math.Max(0, width - (item.Width - PosterTagCss.LuCeil(original.Width)));
                var boundaries = StringInfo.ParseCombiningCharacters(item.Text);
                int low = 0, high = boundaries.Length;
                while (low < high)
                {
                    int mid = (low + high + 1) / 2;
                    string trial = item.Text[..(mid < boundaries.Length ? boundaries[mid] : item.Text.Length)] + "…";
                    if (_text.Layout(trial, fontSize, smallCaps, spacing).Width <= available) low = mid;
                    else high = mid - 1;
                }
                item.Text = item.Text[..(low < boundaries.Length ? boundaries[low] : item.Text.Length)] + "…";
                item.TextLayout = _text.Layout(item.Text, fontSize, smallCaps, spacing);
            }
            item.Width = width;
        }

        /// <summary>Only sides actually meeting artwork or a known progress edge lose their seam.</summary>
        private static void ApplyFlushEdges(List<PlannedGroup> groups, float cardWidth, float bottom)
        {
            foreach (var group in groups)
            foreach (var item in group.Items.Where(i => !i.Hidden))
            {
                if (item.Kind == PosterTagTileKind.Flag) continue;
                if (item.X <= 0.01f) item.FlushEdges |= FlushEdges.Left;
                if (item.Y <= 0.01f) item.FlushEdges |= FlushEdges.Top;
                if (item.X + item.Width >= cardWidth - 0.01f) item.FlushEdges |= FlushEdges.Right;
                if (item.Y + item.Height >= bottom - 0.01f) item.FlushEdges |= FlushEdges.Bottom;
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
            return new PlannedItem(PosterTagTileKind.Quality, tag, label, StyleKey(styles.ResolveQuality(tag.Category is "runtime" or "aspectRatio" or "frameRate" ? tag.Category : tag.Label)), width, height) { TextLayout = layout };
        }

        private PlannedItem MeasureGenre(GenreTag tag, PosterTagCss css, TagStyleSet styles)
        {
            var icon = _assets.GetIcon(tag.Icon ?? string.Empty) is null ? "theaters" : tag.Icon!;
            float size = PosterTagCss.Lu(css.GenreSize) + 2f;
            // Each genre takes its own label's colours: the canonical genre of the glyph the web draws, else Other.
            var label = GenreIcons.LabelOfIcon(tag.Icon ?? string.Empty);
            return new PlannedItem(PosterTagTileKind.Genre, tag, icon, StyleKey(styles.Resolve(TagStyleKeys.Genre, label)), size, size);
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
                    iconWidth = GlyphBoxWidth(PosterTagRenderer.UserReviewIconKey, PosterTagCss.UserReviewIconSize * css.Scale);
                    iconHeight = PosterTagCss.Lu(PosterTagCss.UserReviewIconSize * css.Scale);
                    break;
                default:
                    iconWidth = GlyphBoxWidth(PosterTagRenderer.StarIconKey, css.RatingIconSize);
                    iconHeight = PosterTagCss.Lu(css.RatingIconSize);
                    break;
            }

            if (tag.IsSource) iconWidth = iconHeight = 14 * css.Scale; // Bundled source logos match the web's fixed 14px box.
            if (tag.Compact) iconWidth = iconHeight = 2 * css.Scale;
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

        private PlannedItem MeasureAward(AwardTag tag, PosterTagCss css, bool keepEnd, TagStyleSet styles)
        {
            var text = ClampText(tag.Text, keepEnd);
            var layout = _text.Layout(text, css.ChipFontSize, smallCaps: false, letterSpacing: 0f);
            var colours = styles.Resolve(TagStyleKeys.Awards, tag.Id);
            var style = tag.Id + (colours.IsEmpty ? "" : "\n" + colours.Encode());
            var iconSize = 14 * css.Scale;
            var width = 2 * PosterTagCss.Lu(css.ChipPaddingH) + iconSize + PosterTagCss.Lu(css.RatingInnerGap) + PosterTagCss.LuCeil(layout.Width);
            var height = Math.Max(iconSize, PosterTagCss.Lu(css.ChipFontSize)) + 2 * PosterTagCss.Lu(css.ChipPaddingV);
            return new PlannedItem(PosterTagTileKind.Award, tag, text, style, width, height) { TextLayout = layout, IconWidth = iconSize, IconHeight = iconSize };
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

        /// <summary>
        /// customtags.js chip: the label (line-height 1.15) after an optional 1.2em genre-set icon and a
        /// 0.3em gap, the age chip's padding and a 1px border. The style key is the icon, then the Tag
        /// Styles colours of the label.
        /// </summary>
        private PlannedItem MeasureCustom(CustomTag tag, PosterTagCss css, bool keepEnd, TagStyleSet styles)
        {
            var text = ClampText(tag.Label, keepEnd);
            float fontSize = css.ChipFontSize;
            var layout = _text.Layout(text, fontSize, smallCaps: false, letterSpacing: 0.01f * fontSize);
            var icon = tag.Icon is { } name && _assets.GetIcon(name) is not null ? name : null;
            float iconSize = PosterTagCss.CustomIconScale * fontSize;
            float iconWidth = icon is null ? 0f : GlyphBoxWidth(icon, iconSize);
            float iconHeight = icon is null ? 0f : PosterTagCss.Lu(iconSize);
            float gap = icon is null ? 0f : PosterTagCss.Lu(PosterTagCss.CustomIconGapEm * fontSize);
            float textHeight = PosterTagCss.Lu(PosterTagCss.CustomLineHeight * fontSize);
            float width = PosterTagCss.LuCeil(layout.Width) + iconWidth + gap + (2 * PosterTagCss.Lu(css.ChipPaddingH)) + 2f;
            float height = Math.Max(iconHeight, textHeight) + (2 * PosterTagCss.Lu(css.ChipPaddingV)) + 2f;
            var colors = styles.Resolve(TagStyleKeys.Custom, tag.Label);
            var style = (icon ?? string.Empty) + (colors.IsEmpty ? string.Empty : "\n" + colors.Encode());
            return new PlannedItem(PosterTagTileKind.Custom, tag, text, style, width, height)
            {
                TextLayout = layout,
                IconWidth = iconWidth,
                IconHeight = iconHeight,
            };
        }

        /// <summary>A resolved style as a tile-key fragment; empty when nothing is overridden.</summary>
        private static string StyleKey(TagColors colors) => colors.IsEmpty ? string.Empty : colors.Encode();

        private PlannedItem? MeasureFlag(LanguageTag tag, PosterTagCss css, TagStyleSet styles)
        {
            if (tag.Code is not null || tag.CountBadge is not null || tag.Subtitle)
            {
                var text = tag.CountBadgeText ?? tag.CountBadge ?? (tag.Subtitle ? tag.Sdh ? "SDH " : "CC " : string.Empty) + (tag.Code ?? string.Empty);
                var layout = _text.Layout(text, css.QualityFontSize, smallCaps: true, letterSpacing: 0f);
                float flagWidth = tag.Code is null && tag.CountBadge is null ? PosterTagCss.Lu(css.FlagWidth) : 0;
                var flagCode = PosterTagRenderer.FlagAssetCode(tag.FlagCode);
                if (flagWidth > 0 && (flagCode is null || !_assets.HasFlag(flagCode))) return null;
                var kind = tag.CountBadge is not null ? "countBadge" : tag.Subtitle ? "subtitles" : "code";
                var label = tag.CountBadge?.ToLowerInvariant() ?? tag.StyleLabel ?? tag.Code?.ToLowerInvariant() ?? kind;
                var colors = styles.ResolveLanguageChip(label, kind);
                float gap = flagWidth > 0 ? 3f * css.Scale : 0;
                float chipWidth = PosterTagCss.LuCeil(layout.Width) + flagWidth + gap + (2 * PosterTagCss.Lu(css.LanguagePaddingH(tag))) + 2f;
                float chipHeight = Math.Max(PosterTagCss.Lu(1.2f * css.QualityFontSize), flagWidth * 0.75f) + (2 * PosterTagCss.Lu(css.QualityPaddingV)) + 2f;
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

        /// <summary>
        /// A Logos chip (logotags.js): a fixed-height pill holding the cached logo image at its aspect ratio
        /// (at most 72px wide, provider logos with 2px padding, network and studio logos with 3px 6px), or,
        /// without a cached image, the name chip with the shortened name.
        /// </summary>
        private PlannedItem MeasureLogo(LogoTag tag, PosterTagCss css, TagStyleSet styles)
        {
            float height = PosterTagCss.Lu(css.LogoHeight);
            var image = tag.Logo is null ? null : _assets.GetLogo(tag.Logo);
            if (image is not null)
            {
                bool provider = tag.ImageStyle == "provider";
                float padV = (provider ? PosterTagCss.LogoProviderPadding : PosterTagCss.LogoPaddingV) * css.Scale;
                float padH = (provider ? PosterTagCss.LogoProviderPadding : PosterTagCss.LogoPaddingH) * css.Scale;
                float imageHeight = Math.Max(0f, height - 2f - (2 * padV));
                float imageWidth = PosterTagCss.Lu(Math.Min(imageHeight * image.Width / image.Height, PosterTagCss.LogoMaxImageWidth * css.Scale));
                var colors = styles.Resolve(TagStyleKeys.Logos, tag.ImageStyle);
                return new PlannedItem(PosterTagTileKind.Logo, tag, tag.Logo!, tag.ImageStyle + "|" + colors.Encode(), imageWidth + (2 * padH) + 2f, height)
                {
                    IconWidth = imageWidth,
                    IconHeight = imageHeight,
                };
            }

            var text = LogoRules.ShortName(tag.Name);
            float fontSize = css.LogoFontSize;
            var layout = _text.Layout(text, fontSize, smallCaps: false, letterSpacing: 0.02f * fontSize);
            float width = PosterTagCss.LuCeil(layout.Width) + (2 * PosterTagCss.LogoPaddingH * css.Scale) + 2f;
            var textColors = styles.Resolve(TagStyleKeys.Logos, "text");
            return new PlannedItem(PosterTagTileKind.Logo, tag, text, "text|" + textColors.Encode(), width, height) { TextLayout = layout };
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
