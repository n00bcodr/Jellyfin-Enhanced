// The loader's own translator and document key conversions (client/src/bootstrap/loader/translate.ts and keys.ts),
// compiled from source, for fixtures that build window.JellyfinEnhanced themselves. plugin.js is esbuild output, so
// slicing its text breaks whenever the loader moves; this compiles the same modules plugin.js is built from.
const { buildSync } = require('esbuild');
const { resolve } = require('node:path');

const root = resolve(__dirname, '../../..');
let expression;

/**
 * Script text that evaluates (indirect eval, in the page) to `{ createTranslator, toCamelCase, toPascalCase }`
 * without defining any global.
 */
function loaderSource() {
  expression ??= `(() => { ${buildSync({
    absWorkingDir: root, bundle: true, write: false, format: 'iife', globalName: 'jeLoader', target: 'es2020', logLevel: 'silent',
    stdin: {
      resolveDir: root, sourcefile: 'je-test-loader-source.ts', loader: 'ts',
      contents: "export { createTranslator } from './client/src/bootstrap/loader/translate';\n"
        + "export { toCamelCase, toPascalCase } from './client/src/bootstrap/loader/keys';\n",
    },
  }).outputFiles[0].text}; return jeLoader; })()`;
  return expression;
}

module.exports = { loaderSource };
