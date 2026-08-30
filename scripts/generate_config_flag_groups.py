#!/usr/bin/env python3
"""
Derives docs/advanced/config-flag-groups.json from configPage.html's own
fieldset/legend/label structure, so the Community Analytics dashboard's
setting groupings and display labels stay in sync automatically. A new
setting is grouped and labeled correctly the moment it's added to the right
fieldset with a real label on the config page, which already has to happen
for the admin to see the toggle at all, with nothing extra to maintain here
or in the docs page's JS.

Output shape: {"groups": {PropertyName: "Section Title"}, "labels": {PropertyName: "Real label text"}}

Run manually with: python scripts/generate_config_flag_groups.py
CI (.github/workflows/docs.yml) runs this before every docs build.
"""
import json
import re
from html.parser import HTMLParser
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PAGE = REPO_ROOT / "Jellyfin.Plugin.JellyfinEnhanced" / "Configuration" / "configPage.html"
OUTPUT = REPO_ROOT / "docs" / "advanced" / "config-flag-groups.json"

# "overview-*" fieldsets are read-only dashboard status widgets, not admin
# settings: their ids (e.g. "overview-quick-actions-section") don't
# correspond to any PluginConfiguration property, so they're skipped rather
# than polluting the map with entries nothing will ever look up.
SKIP_FIELDSET_ID_PREFIX = "overview-"

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


def id_to_property(input_id):
    return ID_TO_PROPERTY_OVERRIDES.get(input_id, input_id[0].upper() + input_id[1:])


class ConfigPageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.groups = {}  # PascalCase property name -> section title
        self.labels = {}  # PascalCase property name -> real label text

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

    def handle_starttag(self, tag, attrs):
        attr_dict = dict(attrs)

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
                if title:
                    for input_id in self._current_ids:
                        self.groups[id_to_property(input_id)] = title
            self._fieldset_depth = max(0, self._fieldset_depth - 1)

    def handle_data(self, data):
        if self._label_stack:
            top = self._label_stack[-1]
            if top["icon_skip_depth"] == 0:
                top["text_parts"].append(data)

        if self._in_legend and self._legend_skip_depth == 0:
            self._current_title_parts.append(data)

def main():
    markup = CONFIG_PAGE.read_text(encoding="utf-8")
    parser = ConfigPageParser()
    parser.feed(markup)

    output = {
        "groups": dict(sorted(parser.groups.items())),
        "labels": dict(sorted(parser.labels.items())),
    }
    OUTPUT.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(
        f"Wrote {len(output['groups'])} group mappings and {len(output['labels'])} "
        f"label mappings to {OUTPUT.relative_to(REPO_ROOT)}"
    )


if __name__ == "__main__":
    main()
