#!/usr/bin/env python3
"""
Derives docs/advanced/config-flag-groups.json from configPage.html's own
fieldset/legend/label structure, so the Community Analytics dashboard's
setting groupings and display labels stay in sync automatically. A new
setting is grouped and labeled correctly the moment it's added to the right
fieldset with a real label on the config page, which already has to happen
for the admin to see the toggle at all, with nothing extra to maintain here
or in the docs page's JS.

Also derives a "defaults" map from PluginConfiguration.cs's field
initializers and constructor (a straight regex scan of simple
`PropertyName = literal;`/`{ get; set; } = literal;` assignments, not a
real C# parser; a bool touched by neither defaults to false, same as C#
itself; a non-literal value like Shortcuts' list initializer just doesn't
match and is skipped).

Also derives each tab's icon (Material Icons ligature, or the real public
jsDelivr URL for an <img data-je-cdn="..."> like Seerr's -- the docs site is
static and has no plugin backend to proxy CdnAssetService.cs's route through).

Output shape: {"groups": {...}, "labels": {...}, "tabs": {...}, "tabIcons": {TabLabel: {...}}, "defaults": {PropertyName: value}}

Run manually with: python scripts/generate_config_flag_groups.py
CI (.github/workflows/docs.yml) runs this before every docs build.
"""
import json
import re
from html.parser import HTMLParser
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PAGE = REPO_ROOT / "Jellyfin.Plugin.JellyfinEnhanced" / "Configuration" / "configPage.html"
PLUGIN_CONFIG_CS = REPO_ROOT / "Jellyfin.Plugin.JellyfinEnhanced" / "Configuration" / "PluginConfiguration.cs"
OUTPUT = REPO_ROOT / "docs" / "advanced" / "config-flag-groups.json"

# "overview-*" fieldsets are read-only dashboard status widgets, not admin
# settings: their ids (e.g. "overview-quick-actions-section") don't
# correspond to any PluginConfiguration property, so they're skipped rather
# than polluting the map with entries nothing will ever look up.
SKIP_FIELDSET_ID_PREFIX = "overview-"

# Mirrors CdnAssetService.cs's SourceMap, but only the prefixes actually used
# by a tab icon's data-je-cdn today (just "selfhst", for Seerr). Add an entry
# here only if a future tab icon uses a different source prefix.
CDN_SOURCE_URLS = {
    "selfhst": "https://cdn.jsdelivr.net/gh/selfhst/icons",
}


def resolve_cdn_path(cdn_path):
    source, _, rest = cdn_path.partition("/")
    base = CDN_SOURCE_URLS.get(source)
    return f"{base}/{rest}" if base and rest else None

# Legend/label icons (Material Symbols ligatures) live in a paired <i>...</i>
# and must be skipped for their whole subtree, or their ligature name (e.g.
# "bolt") would get concatenated into the captured text.
SKIP_TEXT_INSIDE_TAGS = {"i", "script", "style"}

# A logo <img> (e.g. MDBList's legend) is a void element. HTML never emits
# a closing </img>, so it can't use the same enter/exit depth tracking as
# SKIP_TEXT_INSIDE_TAGS above (the depth would never come back down). It has
# no text content of its own anyway, so it's simply a no-op here.
VOID_TAGS_IN_TEXT_CAPTURE = {"img", "br", "hr"}

INPUT_TAGS = {"input", "select", "textarea"}

# The default id -> property heuristic is "capitalize the first letter"
# (e.g. "bookmarksEnabled" -> "BookmarksEnabled"), which holds for the vast
# majority of controls. These are the known exceptions: a mid-string
# casing quirk ("4k" vs "4K") or the id using different wording than the
# property it drives. Only needs a new line when a *mismatched* id is
# introduced; a normally-cased new setting needs nothing here at all.
ID_TO_PROPERTY_OVERRIDES = {
    "jellyseerrEnable4kRequests": "JellyseerrEnable4KRequests",
    "jellyseerrEnable4kTvRequests": "JellyseerrEnable4KTvRequests",
    "showReleaseDate": "ShowReleaseDates",
    "loginImageEnabled": "EnableLoginImage",
    "autoMovieRequestServer": "AutoMovieRequestCustomServerId",
    "autoMovieRequestProfile": "AutoMovieRequestCustomProfileId",
    "autoMovieRequestRootFolder": "AutoMovieRequestCustomRootFolder",
}

# A handful of PluginConfiguration properties are computed client-side from
# MULTIPLE controls (e.g. MaintenanceModeAction from two checkboxes; see
# configPage.html's save handler) rather than read straight off one
# <input>/<select> with a matching id, so the id->property discovery above
# can never find them -- there's no single id to find. Manually pointed at
# the fieldset/tab their controls actually live in; only used to fill a gap
# (see main()), never overrides something the parser did discover.
MANUAL_TAB_GROUP = {
    "MaintenanceModeAction": ("Admin", "Maintenance Mode"),
    "MaintenanceModeAffectedUsers": ("Admin", "Maintenance Mode"),
}


def id_to_property(input_id):
    return ID_TO_PROPERTY_OVERRIDES.get(input_id, input_id[0].upper() + input_id[1:])


def has_class(attr_dict, class_name):
    return class_name in (attr_dict.get("class") or "").split()


class ConfigPageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.groups = {}  # PascalCase property name -> fieldset/section title
        self.labels = {}  # PascalCase property name -> real label text
        self.tabs = {}  # PascalCase property name -> main config-page tab label

        # Fieldset/legend (grouping) state.
        self._fieldset_depth = 0
        self._current_ids = None
        self._current_title_parts = None
        self._in_legend = False
        self._legend_skip_depth = 0
        self._skip_fieldset = False

        # <label> (display text) state -- a stack since labels can't nest in
        # practice here, but a stack costs nothing and is defensively correct.
        self._label_stack = []

        # Tab button state. Buttons appear before their matching
        # .jellyfin-tab-content div in document order, so _tab_labels is
        # fully populated by the time a fieldset needs to look one up.
        self._tab_labels = {}  # tab id -> label text
        self._tab_icons = {}  # tab id -> {"type": "material", "value": ligature} | {"type": "img", "cdn_path": ...}
        self._in_tab_button = False
        self._tab_button_id = None
        self._tab_button_text_parts = []
        self._tab_button_icon_skip_depth = 0
        self._capturing_tab_icon_ligature = False
        self._tab_icon_ligature_parts = []

        # .jellyfin-tab-content div state -- fieldsets are direct children of
        # one of these, and (unlike fieldsets) they never nest, so a plain
        # depth counter is enough to know when we've left the current one.
        self._current_tab_id = None
        self._tab_content_div_depth = 0

    def handle_starttag(self, tag, attrs):
        attr_dict = dict(attrs)

        # --- Tab button label + icon capture ---
        if tag == "button" and has_class(attr_dict, "jellyfin-tab-button"):
            self._in_tab_button = True
            self._tab_button_id = attr_dict.get("data-tab")
            self._tab_button_text_parts = []
            self._tab_button_icon_skip_depth = 0
        else:
            if self._in_tab_button and tag == "img" and "data-je-cdn" in attr_dict and self._tab_button_id:
                self._tab_icons[self._tab_button_id] = {"type": "img", "cdn_path": attr_dict["data-je-cdn"]}
            if self._in_tab_button and tag == "i" and has_class(attr_dict, "material-icons") and self._tab_button_icon_skip_depth == 0:
                self._capturing_tab_icon_ligature = True
                self._tab_icon_ligature_parts = []
            if self._in_tab_button and tag in SKIP_TEXT_INSIDE_TAGS:
                self._tab_button_icon_skip_depth += 1

        # --- Tab content div tracking ---
        if tag == "div":
            if self._current_tab_id is None and has_class(attr_dict, "jellyfin-tab-content"):
                self._current_tab_id = attr_dict.get("id")
                self._tab_content_div_depth = 1
            elif self._current_tab_id is not None:
                self._tab_content_div_depth += 1

        # --- Label text capture (independent of fieldset state) ---
        if tag == "label":
            self._label_stack.append({
                "for_id": attr_dict.get("for"),
                "found_input_id": None,
                "text_parts": [],
                "icon_skip_depth": 0,
            })
        elif self._label_stack:
            top = self._label_stack[-1]
            if tag in INPUT_TAGS and "id" in attr_dict and top["found_input_id"] is None:
                top["found_input_id"] = attr_dict["id"]
            if tag in SKIP_TEXT_INSIDE_TAGS:
                top["icon_skip_depth"] += 1

        # --- Fieldset/legend grouping (existing behavior) ---
        if tag == "fieldset":
            self._fieldset_depth += 1
            if self._fieldset_depth == 1:
                self._current_ids = []
                self._current_title_parts = []
                self._skip_fieldset = (attr_dict.get("id") or "").startswith(SKIP_FIELDSET_ID_PREFIX)
            return

        if self._fieldset_depth == 0:
            return

        if tag == "legend" and self._fieldset_depth == 1:
            self._in_legend = True
            return

        if self._in_legend and tag in VOID_TAGS_IN_TEXT_CAPTURE:
            return

        if self._in_legend and tag in SKIP_TEXT_INSIDE_TAGS:
            self._legend_skip_depth += 1
            return

        if tag in INPUT_TAGS and "id" in attr_dict:
            self._current_ids.append(attr_dict["id"])

    def handle_startendtag(self, tag, attrs):
        # Self-closed elements like <input .../> never get handle_endtag,
        # so route them through the same start-tag logic.
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag == "button" and self._in_tab_button:
            label = re.sub(r"\s+", " ", "".join(self._tab_button_text_parts)).strip()
            if self._tab_button_id and label:
                self._tab_labels[self._tab_button_id] = label
            self._in_tab_button = False
        else:
            if tag == "i" and self._capturing_tab_icon_ligature:
                ligature = re.sub(r"\s+", " ", "".join(self._tab_icon_ligature_parts)).strip()
                if ligature and self._tab_button_id:
                    self._tab_icons[self._tab_button_id] = {"type": "material", "value": ligature}
                self._capturing_tab_icon_ligature = False
            if self._in_tab_button and tag in SKIP_TEXT_INSIDE_TAGS and self._tab_button_icon_skip_depth > 0:
                self._tab_button_icon_skip_depth -= 1

        if tag == "div" and self._current_tab_id is not None:
            self._tab_content_div_depth -= 1
            if self._tab_content_div_depth == 0:
                self._current_tab_id = None

        if tag == "label" and self._label_stack:
            frame = self._label_stack.pop()
            target_id = frame["for_id"] or frame["found_input_id"]
            if target_id:
                text = re.sub(r"\s+", " ", "".join(frame["text_parts"])).strip()
                # First label wins: the membership test must use the same
                # PascalCase key the store uses, or (for the camelCase id
                # majority) it checks a key that can never exist and a second
                # label for the same input would silently overwrite the first.
                if text and id_to_property(target_id) not in self.labels:
                    self.labels[id_to_property(target_id)] = text
        elif self._label_stack and tag in SKIP_TEXT_INSIDE_TAGS:
            top = self._label_stack[-1]
            if top["icon_skip_depth"] > 0:
                top["icon_skip_depth"] -= 1

        if tag == "legend":
            self._in_legend = False
            return

        if self._in_legend and tag in SKIP_TEXT_INSIDE_TAGS and self._legend_skip_depth > 0:
            self._legend_skip_depth -= 1
            return

        if tag == "fieldset":
            if self._fieldset_depth == 1 and not self._skip_fieldset:
                title = re.sub(r"\s+", " ", "".join(self._current_title_parts)).strip()
                tab_label = self._tab_labels.get(self._current_tab_id, self._current_tab_id)
                if title:
                    for input_id in self._current_ids:
                        prop = id_to_property(input_id)
                        self.groups[prop] = title
                        if tab_label:
                            self.tabs[prop] = tab_label
            self._fieldset_depth = max(0, self._fieldset_depth - 1)

    def handle_data(self, data):
        if self._capturing_tab_icon_ligature:
            self._tab_icon_ligature_parts.append(data)

        if self._in_tab_button and self._tab_button_icon_skip_depth == 0:
            self._tab_button_text_parts.append(data)

        if self._label_stack:
            top = self._label_stack[-1]
            if top["icon_skip_depth"] == 0:
                top["text_parts"].append(data)

        if self._in_legend and self._legend_skip_depth == 0:
            self._current_title_parts.append(data)

ASSIGNMENT_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?);\s*(//.*)?$")


def parse_literal(raw):
    """Classify a single-line C# literal, or None if it isn't a simple one
    (a multi-line initializer like Shortcuts' List<Shortcut> never even
    reaches here, since it has no trailing ';' on its own line to match)."""
    raw = raw.strip()
    if raw == "true":
        return True
    if raw == "false":
        return False
    if raw in ("string.Empty", '""'):
        return ""
    m = re.match(r'^"(.*)"$', raw)
    if m:
        return m.group(1)
    if re.match(r"^-?\d+$", raw):
        return int(raw)
    return None  # not a recognized literal shape (method call, enum, etc.)


def brace_scan(source, open_brace_pos):
    """Given the index of an opening '{', returns the body text up to (not
    including) its matching close, tracking nested braces."""
    i = open_brace_pos + 1
    depth = 1
    while depth > 0:
        if source[i] == "{":
            depth += 1
        elif source[i] == "}":
            depth -= 1
        i += 1
    return source[open_brace_pos + 1:i - 1]


INLINE_DEFAULT_RE = re.compile(
    r"public (?:bool|string|int) (\w+)\s*\{\s*get;\s*set;\s*\}\s*=\s*(.+?);"
)


def extract_defaults(cs_source):
    class_match = re.search(r"class PluginConfiguration\s*:\s*BasePluginConfiguration\s*\{", cs_source)
    if not class_match:
        raise RuntimeError("Could not find the PluginConfiguration class")
    class_body = brace_scan(cs_source, class_match.end() - 1)

    # Field initializers first (public bool X { get; set; } = true;) -- these
    # apply whenever the constructor never touches that property. Real C#
    # runs these before the constructor body, so a constructor assignment
    # for the same property below correctly overrides it here.
    defaults = {}
    for prop_name, raw_value in INLINE_DEFAULT_RE.findall(class_body):
        value = parse_literal(raw_value)
        if value is not None:
            defaults[prop_name] = value

    ctor_match = re.search(r"public PluginConfiguration\(\)\s*\{", class_body)
    if not ctor_match:
        raise RuntimeError("Could not find the PluginConfiguration constructor")
    ctor_body = brace_scan(class_body, ctor_match.end() - 1)

    for line in ctor_body.splitlines():
        assignment = ASSIGNMENT_RE.match(line)
        if not assignment:
            continue
        value = parse_literal(assignment.group(2))
        if value is not None:
            defaults[assignment.group(1)] = value

    # A bool with neither an inline initializer nor a constructor line still
    # has a real default: C#'s implicit false. Fill those in explicitly so
    # the dashboard doesn't need its own "unknown means false" special case.
    for prop_name in re.findall(r"public bool (\w+)\s*\{\s*get;\s*set;\s*\}", class_body):
        defaults.setdefault(prop_name, False)

    return defaults


def main():
    markup = CONFIG_PAGE.read_text(encoding="utf-8")
    parser = ConfigPageParser()
    parser.feed(markup)

    defaults = extract_defaults(PLUGIN_CONFIG_CS.read_text(encoding="utf-8"))

    for prop, (tab_label, group_title) in MANUAL_TAB_GROUP.items():
        parser.tabs.setdefault(prop, tab_label)
        parser.groups.setdefault(prop, group_title)

    # Re-key from tab id to tab label (what self.tabs/the dashboard actually
    # use), resolving an img icon's data-je-cdn path to its real public URL.
    tab_icons = {}
    for tab_id, icon in parser._tab_icons.items():
        label = parser._tab_labels.get(tab_id, tab_id)
        if icon["type"] == "material":
            tab_icons[label] = {"type": "material", "value": icon["value"]}
        elif icon["type"] == "img":
            src = resolve_cdn_path(icon["cdn_path"])
            if src:
                tab_icons[label] = {"type": "img", "src": src}

    output = {
        "groups": dict(sorted(parser.groups.items())),
        "labels": dict(sorted(parser.labels.items())),
        "tabs": dict(sorted(parser.tabs.items())),
        "tabIcons": dict(sorted(tab_icons.items())),
        "defaults": dict(sorted(defaults.items())),
    }
    OUTPUT.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(
        f"Wrote {len(output['groups'])} group mappings, {len(output['labels'])} label mappings, "
        f"{len(output['tabs'])} tab mappings, {len(output['tabIcons'])} tab icons, and "
        f"{len(output['defaults'])} defaults to {OUTPUT.relative_to(REPO_ROOT)}"
    )


if __name__ == "__main__":
    main()
