// The Media Tags section modules (js/enhanced/admintags/sections/*.js) are read as text by three
// consumers besides the browser: the server's field-patch allowlist (Shared/MediaTags/MediaTagsPageFields.cs),
// What's New (Features/Admin/Services/WhatsNewService.cs ParseSectionModule and the setting id list) and the docs
// generator (scripts/generate_config_flag_groups.py). Their patterns are ported here verbatim, so a
// test can read a generated module exactly as they do.

// Shared/MediaTags/MediaTagsPageFields.cs
const FIELD = /^\s*\{ id: '\w+', key: '(\w+)'(?:.*?orderKey: '(\w+)')?/gm;
const WRITES = /^\s*writes: \[([^\]]*)\]/gm;
const QUOTED = /'(\w+)'/g;
// Features/Admin/Services/WhatsNewService.cs
const SECTION_FIELD_ID = /^\s*\{ id: '(\w+)', key: '\w+'/gm;
const SECTION_TAB = /^\s*tab: '(\w+)'/m;
const SECTION_GROUP = /^\s*group: \{\s*id: '(\w+)'/m;
const SECTION_CONSTANT = /const (\w+) = \[(.*?)\n\s*\];/gs;
const SECTION_FIELDS_CONSTANT = /^\s*fields: (\w+),/m;
// scripts/generate_config_flag_groups.py (re.M; Python's \b and the JS one agree on these ASCII names)
const PY_TITLE = /^\s*title: '((?:[^'\\]|\\.)*)',/gm;
const PY_FIELD = /^\s*\{ id: '(\w+)', key: '(\w+)', type: '(\w+)'.*?\blabel: '((?:[^'\\]|\\.)*)'/gm;

/** MediaTagsPageFields.Parse: the fields the server lets the page write. */
export function allowedFields(texts) {
  const fields = new Set();
  for (const text of texts) {
    for (const m of text.matchAll(FIELD)) { fields.add(m[1]); if (m[2] !== undefined) fields.add(m[2]); }
    for (const m of text.matchAll(WRITES)) for (const q of m[1].matchAll(QUOTED)) fields.add(q[1]);
  }
  return [...fields].sort();
}

/** WhatsNewService.ParseSectionModule: setting id → { tab, group } in declaration order. */
export function sectionLocations(text) {
  const parts = text.split('registerSection(');
  const constants = new Map([...parts[0].matchAll(SECTION_CONSTANT)].map(m => [m[1], [...m[2].matchAll(SECTION_FIELD_ID)].map(f => f[1])]));
  const located = new Set();
  const out = [];
  let first = null;
  for (const section of parts.slice(1)) {
    const tab = SECTION_TAB.exec(section);
    if (!tab) continue;
    const group = SECTION_GROUP.exec(section);
    const location = { tab: tab[1], group: group ? group[1] : null };
    first ??= location;
    const named = SECTION_FIELDS_CONSTANT.exec(section);
    const ids = [...section.matchAll(SECTION_FIELD_ID)].map(m => m[1]).concat(named && constants.has(named[1]) ? constants.get(named[1]) : []);
    for (const id of ids) if (!located.has(id)) { located.add(id); out.push([id, location]); }
  }
  if (first) for (const m of parts[0].matchAll(SECTION_FIELD_ID)) if (!located.has(m[1])) { located.add(m[1]); out.push([m[1], first]); }
  return out;
}

/** WhatsNewService's setting ids from the section modules (in resource-name order). */
export function settingIds(texts) {
  return texts.flatMap(text => [...text.matchAll(SECTION_FIELD_ID)].map(m => m[1]));
}

/** generate_config_flag_groups.py media_tags_fields (before its label lookup): [property, title, label]. */
export function docsFields(text, fallbackTitle = '<tab>') {
  const titles = [...text.matchAll(PY_TITLE)].map(m => [m.index, m[1].replaceAll("\\'", "'")]);
  return [...text.matchAll(PY_FIELD)].map(m => {
    const title = [...titles].reverse().find(([start]) => start < m.index)?.[1] ?? fallbackTitle;
    return [m[2], title, m[4].replaceAll("\\'", "'")];
  });
}

/** Everything the three consumers read from a set of section modules ({ file: text }, files sorted). */
export function readAll(files) {
  const names = Object.keys(files).sort();
  const texts = names.map(name => files[name]);
  return {
    allowed: allowedFields(texts),
    settingIds: settingIds(texts),
    locations: Object.fromEntries(names.map(name => [name, sectionLocations(files[name])])),
    docs: Object.fromEntries(names.map(name => [name, docsFields(files[name])])),
  };
}
