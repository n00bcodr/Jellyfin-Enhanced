// C1 (config-control coverage), adapted from Jellyfin Canopy's
// Jellyfin.Plugin.JellyfinCanopy.Tests/Configuration/ConfigControlCoverageTests.cs (GPL-3.0).
//
// Every settable PluginConfiguration property should be writable from the admin configuration page: otherwise
// admins can never change it from its hard-coded default. The C# side is read, never compiled: the public
// `{ get; set; }` properties declared directly in `class PluginConfiguration` of
// Jellyfin.Plugin.JellyfinEnhanced/Configuration/PluginConfiguration.cs (a text scan of the class body, since the
// TypeScript parser cannot read C#). The page side comes from the TypeScript AST of the admin page sources
// (client/src/admin/** and client/src/features/*/admin/**): a property counts as having a control when one of them
//   - names it in a string literal (a field spec `prop: 'X'` / `key: 'X'`, a key list, `config['X']`), or
//   - writes it: `config.X = …` (any object), or `{ X: … }` in an object literal (a patch or Object.assign).
import { lastName, ts, walk } from './lib.mjs';

export const CONFIG_FILE = 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/PluginConfiguration.cs';

/** Is a client/src file part of the admin configuration page? */
export const isAdminSource = file => file.startsWith('client/src/admin/') || /^client\/src\/features\/[^/]+\/(.+\/)?admin\//.test(file);

/** Settable public properties declared directly in `class <className>` of a C# source (comments ignored). */
export function settableProperties(csharp, className = 'PluginConfiguration') {
  const text = csharp.replace(/\/\*[^]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
  const start = new RegExp(`\\bclass\\s+${className}\\b[^{]*\\{`).exec(text);
  if (!start) throw new Error(`config-control: class ${className} not found`);
  // Method, constructor and nested-type bodies are blanked (fullBodyText), so only member declarations match.
  const out = [];
  const property = /\bpublic\s+(?!static\b|const\b|class\b|override\b|abstract\b)[\w<>,.?\[\]\s]+?\s+(\w+)\s*\{\s*get;\s*(?:public\s+|internal\s+|private\s+)?set;\s*\}/g;
  let m;
  while ((m = property.exec(fullBodyText(text, start))) !== null) out.push(m[1]);
  return [...new Set(out)].sort();
}

/** The class body with nested blocks (methods, constructors, nested types) blanked, so only members remain. */
function fullBodyText(text, start) {
  let depth = 1;
  let out = '';
  for (let i = start.index + start[0].length; i < text.length && depth > 0; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    const insideNested = depth > 2 || (depth === 2 && c !== '{' && !isAccessorBlock(text, i));
    out += insideNested ? (c === '\n' ? '\n' : ' ') : c;
  }
  return out;
}

/** Inside `{ get; set; }`: keep the accessor list so the property pattern can match it. */
function isAccessorBlock(text, i) {
  const open = text.lastIndexOf('{', i);
  const close = text.indexOf('}', i);
  return /^\{\s*(?:(?:public|internal|private|protected|init)\s+)*get;\s*(?:(?:public|internal|private|protected)\s+)?(?:set|init);\s*$/.test(text.slice(open, close));
}

/** Property names the admin page sources name or write. */
export function adminWrittenNames(project) {
  const names = new Set();
  for (const sf of project.files) {
    if (!isAdminSource(sf.fileName)) continue;
    walk(sf, node => {
      if (ts.isStringLiteralLike(node)) names.add(node.text);
      else if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        const name = lastName(node.left);
        if (name) names.add(name);
      } else if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name && !ts.isComputedPropertyName(node.name)) {
        names.add(node.name.text);
      }
    });
  }
  return names;
}

export function scanConfigControls(project, csharp = project.read(CONFIG_FILE)) {
  if (csharp == null) throw new Error(`config-control: cannot read ${CONFIG_FILE}`);
  const written = adminWrittenNames(project);
  return settableProperties(csharp)
    .filter(name => !written.has(name))
    .map(name => ({ rule: 'C1', file: CONFIG_FILE, key: `C1-no-control ${name}`, line: 0, text: name }));
}
