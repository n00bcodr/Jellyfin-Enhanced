#!/usr/bin/env python3
"""
Build the embedded assets of the native poster tag renderer (issue #590).

The renderer (Services/PosterTags/Rendering) draws JE's card tags into poster
images with SkiaSharp. It needs jellyfin-web's own font, the Material icon
glyphs, the flag-icons flags and JE's colour tables. This script regenerates all
of them, reproducibly, into Jellyfin.Plugin.JellyfinEnhanced/Assets/PosterTags/.
The outputs are committed; nothing here runs during `dotnet build`.

Outputs (relative to the output directory):
  fonts/NotoSans-Bold.ttf.br  jellyfin-web's Noto Sans 700 (@fontsource 5.3.0, the
                              files jellyfin-web 12.1 serves): latin, latin-ext,
                              cyrillic and greek woff2 subsets converted to TTF,
                              merged and Brotli-compressed. Every tag text is
                              bold (CSS 600 resolves to the 700 face).
  icons.json                  Material Symbols Outlined genre glyphs (the names in
                              js/tags/genretags.js), Material Symbols Rounded
                              person_heart and Material Icons star, as SVG path data
                              in font units (y down from hhea.ascent) plus metrics.
  vector-icons.json           jellyfin-web's Rotten Tomatoes fresh/rotten SVGs as
                              path data + fills.
  flags/<code>.webp           flag-icons 4x3 for every code js/core/media-language.js
                              can emit (+ its inline "zxx" no-dialogue artwork),
                              rasterised by headless Chromium at 160x120, lossless WebP.
  age-rating-colours.json     [rating=...] colours from css/ratings.css, resolved
                              with the CSS cascade exactly as ageratingtags.js scopes them.
  quality-colours.json        qualityColors (+ the LOW-RES rule and the composite
                              audio bases) from js/tags/qualitytags.js.
  THIRD_PARTY_NOTICES.md      Provenance of every asset plus the full licence texts
                              taken from the pinned upstream packages.
  manifest.json               Pins, tool versions, options and sha256 of every output.
                              Not embedded in the plugin.

Pinned inputs are downloaded once into the cache directory and verified by sha256;
in-repo inputs (genretags.js, media-language.js, qualitytags.js, css/ratings.css,
js/fonts/materialsymbols*.woff2) are versioned by git.

Requirements (output is byte-reproducible with these versions; manifest.json
records the ones that produced the committed files):
  - Python >= 3.10 with fonttools 4.63.0, brotli 1.2.0 and Pillow 12.2.0
      pip install 'fonttools==4.63.0' 'brotli==1.2.0' 'pillow==12.2.0'
  - Node >= 18 and the pinned Playwright in scripts/poster-assets/ (1.58.2, which
    pins its Chromium build). The script runs `npm ci` there whenever node_modules
    does not match package-lock.json, and makes sure that Playwright's Chromium
    headless shell is installed. Only needed to (re)rasterise flags.

Usage:
  python3 scripts/build_poster_assets.py            regenerate everything
  python3 scripts/build_poster_assets.py --check    fast CI check: in-repo inputs still
                                                     match the committed outputs, and
                                                     every output matches manifest.json.
                                                     Needs only the Python standard library.
  python3 scripts/build_poster_assets.py --check --full
                                                     regenerate into a temp dir and
                                                     compare every byte (needs all tools).
Options: --out DIR, --cache DIR, --keep-tmp.
"""
import argparse
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PLUGIN = REPO / "Jellyfin.Plugin.JellyfinEnhanced"
DEFAULT_OUT = PLUGIN / "Assets" / "PosterTags"
NODE_DIR = REPO / "scripts" / "poster-assets"

JELLYFIN_WEB_COMMIT = "fae41f33eb7cd636a9ef68984adb82bb247a6e1b"  # jellyfin-web tag v12.1

PINS = {
    "noto-sans": {
        "url": "https://registry.npmjs.org/@fontsource/noto-sans/-/noto-sans-5.3.0.tgz",
        "sha256": "f62f8ed40e378f15134e32bed2fd5718d81e9ec7a5603d1022d7b385e2297abc",
        "version": "@fontsource/noto-sans 5.3.0 (pinned by jellyfin-web 12.1; Noto Sans 2.015)",
        "license": "OFL-1.1",
    },
    "material-icons": {
        "url": "https://registry.npmjs.org/material-design-icons-iconfont/-/material-design-icons-iconfont-6.7.0.tgz",
        "sha256": "854966e187be57bbbd4d7681b5ff19d7b695efa1a6823800ee4dce474e0e4853",
        "version": "material-design-icons-iconfont 6.7.0 (pinned by jellyfin-web 12.1)",
        "license": "Apache-2.0",
    },
    "flag-icons": {
        "url": "https://registry.npmjs.org/flag-icons/-/flag-icons-7.2.1.tgz",
        "sha256": "e6f2ea715099c3196f2eda680a5c0966a5a4f366d9f643e11ceabfd6b3be4f87",
        "version": "flag-icons 7.2.1 (the version CdnAssetService proxies for the web tags)",
        "license": "MIT",
    },
    "rt-fresh": {
        "url": f"https://raw.githubusercontent.com/jellyfin/jellyfin-web/{JELLYFIN_WEB_COMMIT}/src/assets/img/fresh.svg",
        "sha256": "18be7bcf50f3c1cca86e8d82c5a5603aafba92443748cac659620ed1d2425f2a",
        "version": "jellyfin-web v12.1 src/assets/img/fresh.svg",
        "license": "GPL-2.0-or-later (jellyfin-web); Rotten Tomatoes marks are trademarks of Fandango",
    },
    "rt-rotten": {
        "url": f"https://raw.githubusercontent.com/jellyfin/jellyfin-web/{JELLYFIN_WEB_COMMIT}/src/assets/img/rotten.svg",
        "sha256": "510d0f9fb77d72190ebf03208f04215a4e86f71e165488518ac75aa49cf4a79d",
        "version": "jellyfin-web v12.1 src/assets/img/rotten.svg",
        "license": "GPL-2.0-or-later (jellyfin-web); Rotten Tomatoes marks are trademarks of Fandango",
    },
}

IN_REPO = {
    "genretags": PLUGIN / "js/tags/genretags.js",
    "media-language": PLUGIN / "js/core/media-language.js",
    "qualitytags": PLUGIN / "js/tags/qualitytags.js",
    "ratings-css": REPO / "css/ratings.css",
    "symbols-outlined": PLUGIN / "js/fonts/materialsymbolsoutlined.woff2",
    "symbols-rounded": PLUGIN / "js/fonts/materialsymbolsrounded.woff2",
}

NOTO_SUBSETS = ["latin", "latin-ext", "cyrillic", "greek"]
FLAG_WIDTH, FLAG_HEIGHT = 160, 120

# Icons outside genretags.js's map; the genre icons are read from the module itself.
EXTRA_ICONS = {
    "MaterialSymbolsRounded": ["person_heart"],  # userreviewtags.js
    "MaterialIcons": ["star"],                   # ratingtags.js (TMDB chip, jellyfin-web's Material Icons)
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, str):
        data = data.encode("utf-8")
    path.write_bytes(data)


def to_json(obj) -> str:
    """Compact, sorted, newline-terminated JSON: small to embed and stable to diff."""
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n"


# ── Inputs ───────────────────────────────────────────────────────────────────

def fetch(name: str, cache: Path) -> bytes:
    pin = PINS[name]
    path = cache / Path(pin["url"]).name
    if not path.exists():
        cache.mkdir(parents=True, exist_ok=True)
        print(f"downloading {pin['url']}")
        with urllib.request.urlopen(pin["url"], timeout=60) as r:
            data = r.read()
        tmp = path.with_suffix(path.suffix + ".part")
        tmp.write_bytes(data)
        tmp.replace(path)
    data = path.read_bytes()
    if sha256(data) != pin["sha256"]:
        sys.exit(f"sha256 mismatch for {name} ({path}); expected {pin['sha256']}")
    return data


def tar_member(tgz: bytes, member: str) -> bytes:
    with tarfile.open(fileobj=io.BytesIO(tgz), mode="r:gz") as tf:
        f = tf.extractfile(member)
        if f is None:
            sys.exit(f"{member} missing from tarball")
        return f.read()


def tar_members(tgz: bytes, prefix: str):
    with tarfile.open(fileobj=io.BytesIO(tgz), mode="r:gz") as tf:
        for m in tf.getmembers():
            if m.isfile() and m.name.startswith(prefix):
                yield m.name, tf.extractfile(m).read()


def read_repo(name: str) -> str:
    return IN_REPO[name].read_text(encoding="utf-8")


# ── Data derived from the repo's JS/CSS (standard library only: used by --check) ──

def genre_icon_names() -> list:
    js = read_repo("genretags")
    m = re.search(r"const genreIconMap = \{(.*?)\n\s*\};", js, re.S)
    if not m:
        sys.exit("genretags.js: genreIconMap not found")
    names = sorted(set(re.findall(r":\s*'([a-z0-9_]+)'", m.group(1))))
    if "theaters" not in names:
        sys.exit("genretags.js: default icon 'theaters' missing from genreIconMap")
    return names


def flag_codes():
    """Every flag code the language resolver can emit, plus the inline zxx SVG."""
    js = read_repo("media-language")
    m = re.search(r"validRegions = new Set\(\((.*?)\)\.split", js, re.S)
    if not m:
        sys.exit("media-language.js: validRegions not found")
    regions = " ".join(re.findall(r"'([a-z ]+)'", m.group(1))).split()
    base = re.search(r"const baseLanguageFlags = \{(.*?)\n\s*\};", js, re.S)
    if not base:
        sys.exit("media-language.js: baseLanguageFlags not found")
    values = set(re.findall(r":\s*'([a-z-]+)'", base.group(1)))
    script = re.search(r"const chineseScriptFlags = \{(.*?)\};", js, re.S)
    if script:
        values |= set(re.findall(r":\s*'([a-z]+)'", script.group(1)))
    codes = sorted((set(regions) | values) - {"zxx"})
    zm = re.search(r"zxx: 'data:image/svg\+xml,' \+ encodeURIComponent\((.*?)\)\s*\n", js, re.S)
    if not zm:
        sys.exit("media-language.js: specialFlags.zxx not found")
    zxx = "".join(re.findall(r"'(<[^']*>)'", zm.group(1)))
    return codes, zxx


def quality_colours() -> dict:
    js = read_repo("qualitytags")
    m = re.search(r"const qualityColors = \{(.*?)\n\s*\};", js, re.S)
    if not m:
        sys.exit("qualitytags.js: qualityColors not found")
    colours = {}
    for label, bg, text in re.findall(r"'([^']+)':\s*\{\s*bg:\s*'([^']+)',\s*text:\s*'([^']+)'\s*\}", m.group(1)):
        colours[label] = {"background": bg, "color": text}
    # The generic LOW-RES rule lives in the CSS template, not in qualityColors.
    lm = re.search(r'\[data-quality="LOW-RES"\]\s*\{([^}]*)\}', js)
    if not lm:
        sys.exit("qualitytags.js: LOW-RES rule not found")
    decl = dict((k.strip(), v.replace("!important", "").strip())
                for k, v in re.findall(r"([a-z-]+)\s*:\s*([^;]+)", lm.group(1)))
    colours["LOW-RES"] = {"background": decl["background"], "color": decl["color"]}
    bm = re.search(r"const audioBases = \[(.*?)\];", js, re.S)
    if not bm:
        sys.exit("qualitytags.js: audioBases not found")
    bases = re.findall(r"'([^']+)'", bm.group(1))
    if not colours or not bases:
        sys.exit("qualitytags.js: empty colour table")
    return {"labels": colours, "compositeBases": bases}


def age_rating_colours() -> dict:
    """[rating=...] declarations from css/ratings.css, later rules winning, exactly as
    ageratingtags.js's scopeRatingColours() injects them (comments dropped, block regex,
    selectors kept only when they start with .mediaInfoOfficialRating[rating=, !important
    dropped)."""
    css = re.sub(r"/\*.*?\*/", "", read_repo("ratings-css"), flags=re.S)
    colours = {}
    for sel, body in re.findall(r"([^{}]+)\{([^{}]*)\}", css):
        selectors = [s.strip() for s in sel.split(",")]
        ratings = []
        for s in selectors:
            if not s.startswith(".mediaInfoOfficialRating[rating="):
                continue
            mm = re.fullmatch(r"\.mediaInfoOfficialRating\[rating=(['\"])(.*?)\1\]", s)
            if not mm:
                sys.exit(f"ratings.css: unsupported selector {s!r}")
            ratings.append(mm.group(2))
        if not ratings:
            continue
        decl = {}
        for k, v in re.findall(r"([a-z-]+)\s*:\s*([^;]+)", body):
            decl[k.strip()] = re.sub(r"\s*!important", "", v).strip()
        unknown = set(decl) - {"background-color", "border-color", "color", "text-shadow"}
        if unknown:
            sys.exit(f"ratings.css: rating rule uses unsupported properties {sorted(unknown)}")
        for r in ratings:
            colours.setdefault(r, {}).update(decl)
    if not colours:
        sys.exit("ratings.css: no [rating=] rules found")
    # Many ratings share a style: store each distinct style once and index it.
    styles = sorted({json.dumps(v, sort_keys=True) for v in colours.values()})
    index = {s: i for i, s in enumerate(styles)}
    return {"styles": [json.loads(s) for s in styles],
            "ratings": {r: index[json.dumps(v, sort_keys=True)] for r, v in colours.items()}}


def derived_json() -> dict:
    """Outputs computed purely from in-repo inputs."""
    return {
        "age-rating-colours.json": to_json(age_rating_colours()),
        "quality-colours.json": to_json(quality_colours()),
    }


# ── Fonts and icons ──────────────────────────────────────────────────────────

def deterministic_bytes(font) -> bytes:
    if "head" in font:
        font["head"].created = font["head"].modified = 0
    font.recalcTimestamp = False
    b = io.BytesIO()
    font.save(b)
    return b.getvalue()


def build_noto(out: Path, tmp: Path, cache: Path) -> None:
    import brotli
    from fontTools.merge import Merger
    from fontTools.ttLib import TTFont

    tgz = fetch("noto-sans", cache)
    parts = []
    for s in NOTO_SUBSETS:
        f = TTFont(io.BytesIO(tar_member(tgz, f"package/files/noto-sans-{s}-700-normal.woff2")))
        f.flavor = None
        p = tmp / f"noto-{s}-700.ttf"
        f.save(p)
        parts.append(str(p))
    merged = Merger().merge(parts)
    ttf = deterministic_bytes(merged)
    write(out / "fonts" / "NotoSans-Bold.ttf.br", brotli.compress(ttf, quality=11, mode=brotli.MODE_FONT))


def ligature_map(font) -> dict:
    """icon name -> lowest PUA codepoint, read from the font's own ligature table."""
    cmap = font.getBestCmap()
    glyph_to_cp = {}
    for cp, g in sorted(cmap.items()):
        if cp >= 0xE000:
            glyph_to_cp.setdefault(g, cp)
    ascii_glyph = {g: chr(cp) for cp, g in cmap.items() if cp < 0x80}
    names = {}
    for lookup in font["GSUB"].table.LookupList.Lookup:
        for st in lookup.SubTable:
            if lookup.LookupType == 7:
                st = st.ExtSubTable
            if not hasattr(st, "ligatures"):
                continue
            for first, ligs in st.ligatures.items():
                for lig in ligs:
                    try:
                        name = ascii_glyph[first] + "".join(ascii_glyph[c] for c in lig.Component)
                    except KeyError:
                        continue
                    if lig.LigGlyph in glyph_to_cp:
                        names[name] = glyph_to_cp[lig.LigGlyph]
    return names


def glyph_entry(font, family: str, cp: int) -> dict:
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen

    gs = font.getGlyphSet()
    gname = font.getBestCmap()[cp]
    upm = font["head"].unitsPerEm
    hhea = font["hhea"]
    os2 = font["OS/2"]
    use_typo = bool(os2.fsSelection & (1 << 7))
    asc = os2.sTypoAscender if use_typo else hhea.ascent
    desc = -(os2.sTypoDescender if use_typo else hhea.descent)
    pen = SVGPathPen(gs, ntos=lambda v: ("%.1f" % v).rstrip("0").rstrip("."))
    # (x, asc - y): y down from the ascent, ready for SKPath.ParseSvgPathData.
    gs[gname].draw(TransformPen(pen, (1, 0, 0, -1, 0, asc)))
    return {"font": family, "codepoint": cp, "advance": gs[gname].width, "unitsPerEm": upm,
            "ascent": asc, "descent": desc, "path": pen.getCommands()}


def build_icons(out: Path, cache: Path) -> list:
    from fontTools.ttLib import TTFont

    genre_icons = genre_icon_names()
    wanted = {"MaterialSymbolsOutlined": genre_icons, **EXTRA_ICONS}
    sources = {
        "MaterialSymbolsOutlined": TTFont(IN_REPO["symbols-outlined"]),
        "MaterialSymbolsRounded": TTFont(IN_REPO["symbols-rounded"]),
        "MaterialIcons": TTFont(io.BytesIO(tar_member(fetch("material-icons", cache),
                                                       "package/dist/fonts/MaterialIcons-Regular.ttf"))),
    }
    icons = {}
    for family, names in wanted.items():
        font = sources[family]
        lig = ligature_map(font)
        for n in names:
            if n not in lig:
                sys.exit(f"{family} has no glyph for '{n}'")
            key = n if family == "MaterialSymbolsOutlined" else f"{family}:{n}"
            icons[key] = glyph_entry(font, family, lig[n])
    write(out / "icons.json", to_json(icons))
    return genre_icons


def svg_to_paths(svg: bytes) -> dict:
    ns = "{http://www.w3.org/2000/svg}"
    root = ET.fromstring(svg)
    vb = root.get("viewBox")
    vb = [float(v) for v in vb.split()] if vb else [0, 0, float(root.get("width")), float(root.get("height"))]
    paths = []

    def walk(el, fill):
        fill = el.get("fill", fill)
        style = el.get("style") or ""
        sm = re.search(r"fill:\s*(#[0-9a-fA-F]{3,8})", style)
        if sm:
            fill = sm.group(1)
        if el.get("transform"):
            sys.exit("svg_to_paths: transforms are not supported")
        if el.tag == ns + "path":
            paths.append({"d": " ".join(el.get("d").split()), "fill": fill})
        elif el.tag in (ns + t for t in ("rect", "circle", "ellipse", "polygon", "polyline", "line", "use", "text")):
            sys.exit(f"svg_to_paths: unsupported element {el.tag}")
        for c in el:
            walk(c, fill)

    walk(root, "#000000")
    return {"viewBox": vb, "paths": paths}


def build_vector_icons(out: Path, cache: Path) -> None:
    data = {"rt-fresh": svg_to_paths(fetch("rt-fresh", cache)),
            "rt-rotten": svg_to_paths(fetch("rt-rotten", cache))}
    write(out / "vector-icons.json", to_json(data))


# ── Flags ────────────────────────────────────────────────────────────────────

def ensure_playwright() -> None:
    """Install the locked Playwright unless node_modules already matches package-lock.json, then its Chromium."""
    lock = json.loads((NODE_DIR / "package-lock.json").read_text(encoding="utf-8"))
    for path, meta in lock["packages"].items():
        if not path.startswith("node_modules/") or meta.get("optional"):
            continue
        pkg = NODE_DIR / path / "package.json"
        if not pkg.is_file() or json.loads(pkg.read_text(encoding="utf-8")).get("version") != meta.get("version"):
            print("installing the pinned Playwright (npm ci) in scripts/poster-assets")
            subprocess.run(["npm", "ci", "--no-audit", "--no-fund"], cwd=NODE_DIR, check=True)
            break
    # Every run: a no-op when this Playwright's Chromium build is installed, and it retries a download that failed.
    subprocess.run(["npx", "--no-install", "playwright", "install", "--only-shell", "chromium"], cwd=NODE_DIR, check=True)


def rasterize(svgs: dict, tmp: Path) -> dict:
    src, dst = tmp / "svg", tmp / "png"
    for d in (src, dst):
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True)
    for code, svg in svgs.items():
        (src / f"{code}.svg").write_bytes(svg)
    ensure_playwright()
    subprocess.run(["node", str(NODE_DIR / "rasterize_flags.mjs"), str(src), str(dst),
                    str(FLAG_WIDTH), str(FLAG_HEIGHT)], check=True)
    return {code: (dst / f"{code}.png").read_bytes() for code in svgs}


def to_webp(png: bytes) -> bytes:
    from PIL import Image

    im = Image.open(io.BytesIO(png)).convert("RGBA")
    if im.getextrema()[3] == (255, 255):
        im = im.convert("RGB")  # flags are opaque; drop the alpha channel
    b = io.BytesIO()
    im.save(b, "WEBP", lossless=True, quality=100, method=6, exact=True)
    return b.getvalue()


def build_flags(out: Path, tmp: Path, cache: Path) -> list:
    codes, zxx = flag_codes()
    tgz = fetch("flag-icons", cache)
    all_svgs = {Path(n).stem: d for n, d in tar_members(tgz, "package/flags/4x3/")}
    missing = [c for c in codes if c not in all_svgs]
    if missing:
        sys.exit(f"flag-icons 4x3 has no SVG for {missing}")
    svgs = {c: all_svgs[c] for c in codes}
    svgs["zxx"] = zxx.encode()
    for code, png in sorted(rasterize(svgs, tmp).items()):
        write(out / "flags" / f"{code}.webp", to_webp(png))
    return codes


# ── Licences, notice, manifest ───────────────────────────────────────────────

def build_licences(out: Path, cache: Path) -> None:
    licences = [
        ("SIL Open Font License 1.1 (Noto Sans)", tar_member(fetch("noto-sans", cache), "package/LICENSE")),
        ("Apache License 2.0 (Material Symbols, Material Icons)", tar_member(fetch("material-icons", cache), "package/LICENSE")),
        ("MIT License (flag-icons)", tar_member(fetch("flag-icons", cache), "package/LICENSE")),
    ]
    texts = "".join(
        f"\n## {title}\n\n```text\n{text.decode('utf-8').strip()}\n```\n" for title, text in licences)
    write(out / "THIRD_PARTY_NOTICES.md", f"""# Native poster tag assets: third-party notices

Generated by `scripts/build_poster_assets.py`; do not edit by hand. Embedded into the plugin
for the native poster tag renderer (`Services/PosterTags/Rendering`).

| Asset | Source | Licence |
|---|---|---|
| `fonts/NotoSans-Bold.ttf.br` | Noto Sans Bold, {PINS['noto-sans']['version']}: latin, latin-ext, cyrillic and greek subsets merged into one TTF, Brotli-compressed. Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic). | SIL Open Font License 1.1, full text below |
| `icons.json` (genre icons, `person_heart`) | Glyph outlines of Material Symbols Outlined and Material Symbols Rounded, from the fonts JE already bundles (`js/fonts/materialsymbols*.woff2`). Copyright Google LLC. | Apache License 2.0, full text below |
| `icons.json` (`star`) | Glyph outline of Material Icons, {PINS['material-icons']['version']}. Copyright Google LLC. | Apache License 2.0, full text below |
| `flags/*.webp` | flag-icons 4x3 SVGs, {PINS['flag-icons']['version']}, rasterised at {FLAG_WIDTH}x{FLAG_HEIGHT} by headless Chromium. Copyright (c) 2013 Panayiotis Lipiridis. | MIT, full text below |
| `flags/zxx.webp` | JE's own "no dialogue" artwork (`specialFlags.zxx` in `js/core/media-language.js`). | GPL-3.0 (this project) |
| `vector-icons.json` | `fresh.svg` and `rotten.svg` from jellyfin-web v12.1 (`src/assets/img/`, commit `{JELLYFIN_WEB_COMMIT}`), converted to path data unchanged. jellyfin-web ships them for its critic rating indicator (`CriticRatingMediaInfo`); JE's web rating tags load the same files from jellyfin-web. | GPL-2.0-or-later (jellyfin-web). Rotten Tomatoes and the tomato and splat marks are trademarks of Fandango; they are used only to identify the source of a critic rating, as in jellyfin-web. |
| `age-rating-colours.json` | Derived from JE's `css/ratings.css` (the rules `js/tags/ageratingtags.js` applies to the poster badge). | GPL-3.0 (this project) |
| `quality-colours.json` | Derived from JE's `js/tags/qualitytags.js`. | GPL-3.0 (this project) |
{texts}""")


def tool_versions() -> dict:
    import brotli
    import fontTools
    import PIL
    from PIL import features

    v = {"python": sys.version.split()[0], "fonttools": fontTools.version, "pillow": PIL.__version__,
         "libwebp": features.version("webp"), "brotli": getattr(brotli, "__version__", "unknown")}
    pkg = NODE_DIR / "node_modules" / "playwright" / "package.json"
    v["playwright"] = json.loads(pkg.read_text())["version"] if pkg.is_file() else "not installed"
    try:
        v["node"] = subprocess.run(["node", "--version"], capture_output=True, text=True).stdout.strip()
    except OSError:
        v["node"] = "not installed"
    return v


def outputs_of(out: Path) -> dict:
    return {str(p.relative_to(out)).replace(os.sep, "/"): {"bytes": p.stat().st_size, "sha256": sha256(p.read_bytes())}
            for p in sorted(out.rglob("*")) if p.is_file() and p.name != "manifest.json"}


def input_hashes() -> dict:
    return {str(p.relative_to(REPO)).replace(os.sep, "/"): sha256(p.read_bytes()) for p in IN_REPO.values()}


def build(out: Path, cache: Path, tmp: Path) -> None:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    build_noto(out, tmp, cache)
    genre_icons = build_icons(out, cache)
    build_vector_icons(out, cache)
    for name, text in derived_json().items():
        write(out / name, text)
    codes = build_flags(out, tmp, cache)
    build_licences(out, cache)
    manifest = {
        "generator": "scripts/build_poster_assets.py",
        "pins": PINS,
        "inputs": input_hashes(),
        "tools": tool_versions(),
        "options": {"flagSize": [FLAG_WIDTH, FLAG_HEIGHT], "notoSubsets": NOTO_SUBSETS, "notoWeights": [700]},
        "genreIcons": genre_icons,
        "flagCodes": codes + ["zxx"],
        "zxxSvgSha256": sha256(flag_codes()[1].encode()),
        "outputs": outputs_of(out),
    }
    write(out / "manifest.json", json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    total = sum(o["bytes"] for o in manifest["outputs"].values())
    flags = sum(o["bytes"] for k, o in manifest["outputs"].items() if k.startswith("flags/"))
    print(f"{out}: {len(manifest['outputs'])} files, {total} bytes (flags {len(codes) + 1} = {flags} bytes)")


# ── Check ────────────────────────────────────────────────────────────────────

def check(out: Path, full: bool, cache: Path, keep_tmp: bool) -> int:
    problems = []
    manifest_path = out / "manifest.json"
    if not manifest_path.is_file():
        print(f"{manifest_path} missing; run scripts/build_poster_assets.py")
        return 1
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    # 1. Committed outputs match the manifest (nothing hand-edited, added or lost).
    actual = outputs_of(out)
    for name in sorted(set(manifest["outputs"]) | set(actual)):
        if manifest["outputs"].get(name) != actual.get(name):
            problems.append(f"{name}: differs from manifest.json")

    # 2. In-repo inputs still produce the committed derived data.
    for name, text in derived_json().items():
        p = out / name
        if not p.is_file() or p.read_text(encoding="utf-8") != text:
            problems.append(f"{name}: stale, its in-repo source (js/css) changed")
    if manifest.get("genreIcons") != genre_icon_names():
        problems.append("genre icon list in js/tags/genretags.js changed: icons.json is stale")
    codes, zxx = flag_codes()
    if manifest.get("flagCodes") != codes + ["zxx"]:
        problems.append("flag codes in js/core/media-language.js changed: flags/ are stale")
    if manifest.get("zxxSvgSha256") != sha256(zxx.encode()):
        problems.append("no-dialogue artwork (specialFlags.zxx in js/core/media-language.js) changed: flags/zxx.webp is stale")
    for rel, digest in input_hashes().items():
        if manifest.get("inputs", {}).get(rel) != digest and not rel.endswith((".js", ".css")):
            problems.append(f"{rel}: changed since the assets were generated")

    # 3. Optional: full byte-for-byte regeneration.
    if full and not problems:
        tmp = Path(tempfile.mkdtemp(prefix="je-poster-assets-"))
        try:
            fresh = tmp / "out"
            work = tmp / "work"
            work.mkdir()
            build(fresh, cache, work)
            fresh_manifest = json.loads((fresh / "manifest.json").read_text(encoding="utf-8"))
            if fresh_manifest["tools"] != manifest["tools"]:
                print(f"note: tool versions differ from the committed run: {fresh_manifest['tools']} vs {manifest['tools']}")
            new = outputs_of(fresh)
            for name in sorted(set(new) | set(actual)):
                if new.get(name) != actual.get(name):
                    problems.append(f"{name}: regenerated bytes differ")
        finally:
            if keep_tmp:
                print(f"kept {tmp}")
            else:
                shutil.rmtree(tmp, ignore_errors=True)

    if problems:
        print("poster tag assets are out of date:")
        for p in problems:
            print(f"  - {p}")
        print("run: python3 scripts/build_poster_assets.py")
        return 1
    print(f"poster tag assets OK ({len(actual)} files{', full regeneration identical' if full else ''})")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--cache", type=Path,
                    default=Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "jellyfin-enhanced" / "poster-assets")
    ap.add_argument("--check", action="store_true", help="verify instead of writing")
    ap.add_argument("--full", action="store_true", help="with --check: regenerate everything and compare bytes")
    ap.add_argument("--keep-tmp", action="store_true")
    a = ap.parse_args()
    if a.full and not a.check:
        ap.error("--full requires --check")
    if a.check:
        return check(a.out, a.full, a.cache, a.keep_tmp)
    tmp = Path(tempfile.mkdtemp(prefix="je-poster-assets-"))
    try:
        build(a.out, a.cache, tmp)
    finally:
        if a.keep_tmp:
            print(f"kept {tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
