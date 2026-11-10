/**
 * frontend.md §3 D1: `import css from './x.css'` is the file's text. scripts/client-build.mjs bundles `.css` with
 * esbuild's `text` loader, so the default export is the stylesheet as one string, byte for byte.
 */
declare module '*.css' {
  const css: string;
  export default css;
}
