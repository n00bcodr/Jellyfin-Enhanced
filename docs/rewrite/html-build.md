# Typed inline HTML pages

Production HTML keeps its existing paths, resources and inline `<script>` delivery, but
every script body comes from strict TypeScript. This is the HTML half of
[frontend build](frontend-build.md): all of that document's commands, freshness rules
and direct .NET build checks apply here too. There are no new commands.

## Adding a page

A page needs a template, a manifest entry and one TypeScript entry per script.

`client/html/<owner>/page.html` holds the markup, with a marker wherever a script goes:

```html
<div class="page" data-role="page">
    <div data-role="content">…</div>
    <!-- JE_TYPED_SCRIPT:main -->
</div>
```

`client/html-entries/<owner>.json` maps each production path to its template and scripts:

```json
{
  "PluginPages/CalendarPage.html": {
    "template": "client/html/bootstrap-pages/CalendarPage.html",
    "scripts": { "main": "client/src/pages/calendar-page.ts" }
  }
}
```

Output keys are relative to `Jellyfin.Plugin.JellyfinEnhanced/`; the other paths are
relative to the repository. The schema is `client/html-entry-manifest.schema.json`.

Publish the template, manifest, TypeScript and generated HTML together, under
`/home/jake/projects/je-v12-client-build.lock` on the Lenovo. Until then, stage work
outside `client/html` and `client/html-entries`: the builder rejects any file under
`client/html` that no manifest references.

`npm run client:build` replaces each marker with `<script>…</script>`. The rest of the
template is copied byte for byte. `npm run client:check` rebuilds in memory, writes
nothing, and fails if anything differs. MSBuild runs that check.

## Generated scripts

Each script is one classic IIFE compiled by the same wrapper and strict policy as a
`.js` entry, so `any`, suppressions, type errors and non-TypeScript bundle inputs fail
the same way. Three things differ because of where the text ends up.

| Build choice | Reason |
| --- | --- |
| Template literals lowered to `.concat` | Jellyfin 12's `ServerContentPage` runs `globalize.translateHtml` over the entire fetched page, rewriting every `${…}`. In a script that changes the code. `.concat` keeps `ToString` semantics, and esbuild's `__template` helper keeps `raw` for tagged templates |
| ASCII output, escaped per token | Keeps the script independent of how the page is decoded and removes characters the HTML parser would change (NUL, CR). esbuild's `ascii` charset leaves raw characters in regular expressions, C0 controls in strings, and everything in comments, so these are escaped afterwards |
| Inline `data:` source map | There is no separate file to link to. base64 cannot contain `<`, `$` or `{`, so embedded TypeScript never reaches the parser or `translateHtml` |

### What is rewritten

Inside inline script text, `</script` ends the element, `<!--` followed by `<script` hides
the real end tag, and `${` is rewritten by `translateHtml`. esbuild handles some of these
and not others: `</script` stays raw in a regular expression class, and `<!--` and `${`
stay raw in strings. So the builder parses its own output and works token by token.

| Token | Action |
| --- | --- |
| String | Escape with `\xHH`/`\uHHHH`. Proven unchanged by comparing cooked values |
| Regular expression | Same escapes, which are valid in every context and flag mode. Proven by comparing normal forms and compiling. A raw character after a backslash (`/\–/`) replaces the backslash too, because `\\u2013` would be a literal backslash |
| Comment | Escaped; meaning is unaffected |
| Template literal | Build failure: lowering should have removed it |
| Code, or spanning tokens | Build failure: no equivalent rewrite is proven |

`(?<!--` is also a build failure. Write it as `(?<!-{2})`.

### Source maps

Maps are relative to the script text, not the HTML file. The dashboard never loads these
pages as documents: it fetches them as text, and jQuery re-runs each script by copying its
text into a new element, so the browser only ever sees that text. Chromium's debugger
reports `startLine: 0` for these scripts. The Plugin Pages plugin's own loader has not been
inspected, so that path is unverified.

Script text starts with a newline, so a document parser would differ only by whole lines,
never columns. The map composes esbuild's map, the wrapper line, that leading newline and
every column shift from escaping. Moving a marker in its template changes neither the
script nor the map. `sources` are repository-relative `client/src` paths and `file` is
`Production/page.html#marker`.

## Template rules

Templates are checked with jsdom, parsing both as a document and as `div.innerHTML`,
which is what Jellyfin does. Both parses must agree.

**Markers** must be exactly `<!-- JE_TYPED_SCRIPT:name -->`, with a lowercase name, and
appear once each. Every manifest script needs a marker and every marker needs a manifest
script. Any other spelling of `JE_TYPED_SCRIPT`, in any case, is an error. A marker must be
a real markup comment, so not in an attribute, raw text, `<template>` or another comment.
If the page has a `div[data-role="page"]`, the marker must be inside the first one, because
Jellyfin discards everything outside it.

**Not allowed in markup**, including inside `<template>`:

- any `<script>`, including `src`, `type="module"` and data scripts
- `<noscript>`, `<object>`, `<embed>`, `<applet>`, `<frame>`, `<frameset>`, `<base>`,
  `<portal>`, `<svg>` and `<math>`
- `<meta http-equiv>`, and `<link>` other than `rel="stylesheet"`
- `on*` event attributes and `srcdoc`
- `javascript:`, `vbscript:` and non-image `data:` URLs in URL attributes, after the same
  whitespace removal a browser performs
- script tags inside comments, because jellyfin-web's `parseHtml` turns
  `<!--<script>…</script>-->` into a live script
- `${` anywhere, because `translateHtml` would read from it up to the next `}`, which may
  be inside a generated script

No baseline page's markup uses any of these, and a test runs the policy over every
shipped page. Baseline `<iframe>` and `<style>` remain allowed.

**Files** must be valid UTF-8 with no byte order mark or NUL. Paths follow the rules for
`.js` entries: no traversal, aliases or symlinks anywhere, including under `client/html`
paths no manifest names. A template maps to one output, and outputs must not collide
by case or flattened resource name.

The finished page is then parsed again. It must contain exactly the generated scripts, as
plain HTML elements with no attributes and the expected text, in both parses, and none of
the sequences `parseHtml` or `translateHtml` would rewrite.

## Embedding

Unlike `js\**`, the project has no glob for HTML. Each page has an explicit
`<EmbeddedResource Include="…"/>`, and the C# plugin page registrations name those
resources. The builder therefore requires an unconditional, non-renamed
`EmbeddedResource` for every output, and output names must round-trip through
resource lookup like `.js` outputs do. All nine current pages are listed. A new page
needs a line in `JellyfinEnhanced.csproj` and a plugin page registration.

The static project check accepts one plain explicit Include in a top-level unconditional ItemGroup. It rejects metadata children/attributes, conditional ancestors, duplicate declarations, defaults and matching Remove/Update operations. Item-spec matching is conservative; dynamic or escaped specs need separate evaluated evidence. This checks the project file, not arbitrary imported MSBuild targets. The compiled-resource and real-host gates remain required.

The inventory recognizes all sixteen JavaScript MIME aliases and legacy language attributes. MIME matching trims ASCII whitespace only; data blocks, invalid type parameters and whitespace around module are not counted as executable scripts. This follows the HTML script preparation rules, independently of the builder requiring plain generated script elements.

## Provenance

`client/generated-manifest.json` gains an `html` array only when typed pages exist, so
JavaScript-only trees keep their existing bytes. Each element records the output, manifest,
template and output hashes, and each script's name, position, source, text hash and the
hash of every bundled TypeScript input. Output paths also appear in the existing `outputs`
map, so retiring a page follows the orphan rules in
[frontend build](frontend-build.md).

## Migration inventory

`scripts/rewrite-inventory.mjs` counts a script as `typed-generated` only if its text
hash matches the ledger at that position. A hand-edited or stale script remains
`inline-runtime-unmigrated`, and also fails the command through `unresolvedTypedHtml`, as
does a mapped page missing from the ledger. Scripts in `<template>` and commented scripts
Jellyfin would activate are counted too.

`baselineInlineScripts` records each baseline page's script count. A page with baseline
inline scripts that is removed (`missingBaselineHtml`) or left with none
(`emptiedBaselineHtml`) fails the command. These additive fields appear once a typed page
exists, so regenerate the inventory when publishing the first one.

## Testing

```sh
npm run test:client-build
node tests/client-build/browser/inline-html.browser.mjs results.json
```

The browser journey needs Playwright browsers and a jQuery file (`JE_JQUERY_PATH`), so it is
separate from the suite CI runs. It loads a generated page through jellyfin-web's loader
steps and `$(view).appendTo`, and directly as a document, in Chromium and Firefox.
