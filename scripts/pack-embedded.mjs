// Packs the client's bulky embedded text assets for the plugin DLL (JellyfinEnhanced.csproj, target
// PackEmbeddedClientAssets; read back by Infrastructure/Assets/PackedResources.cs).
//
//   node scripts/pack-embedded.mjs <plugin directory> <output directory> <list file>
//
// The readable scripts, their source maps, the minified twins and the locales are 23.8 MB of text, which made the DLL
// twice the size of the release it replaces. Each file named in <list file> (one path per line, relative to the
// plugin directory; the project's JePackedAsset items) is written to <output directory>/<same path>.jez: four bytes
// (the original length, little-endian) followed by the file as one brotli stream. A file is packed again only when its
// content changed, so an incremental build finds nothing to do.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants } from 'node:zlib';

const compress = promisify(brotliCompress);
/**
 * Quality 5 packs the 23.8 MB to 6.2 MB. Quality 9 saves another 0.1 MB and quality 11 another 0.6 MB, at ten and
 * thirty times the time, and this runs inside every clean plugin build.
 */
export const QUALITY = 5;

/** The packed form of one file: its length, then its bytes as a brotli stream. */
export async function packBytes(source) {
  const body = await compress(source, { params: { [constants.BROTLI_PARAM_QUALITY]: QUALITY, [constants.BROTLI_PARAM_SIZE_HINT]: source.length } });
  const packed = Buffer.allocUnsafe(4 + body.length);
  packed.writeUInt32LE(source.length, 0);
  body.copy(packed, 4);
  return packed;
}

/**
 * Pack every listed path; returns how many packed files were written. <output>/index.json records the hash of the
 * source each packed file was made from; a file is packed again only when its source's hash differs or it is missing.
 */
export async function pack(pluginDirectory, outputDirectory, paths) {
  const indexPath = join(outputDirectory, 'index.json');
  let previous = {};
  try { previous = JSON.parse(readFileSync(indexPath, 'utf8')); } catch { /* first run, or an unreadable index: pack everything */ }
  const index = {};
  let written = 0;
  await Promise.all(paths.map(async (path) => {
    const source = readFileSync(join(pluginDirectory, path));
    const target = join(outputDirectory, `${path}.jez`);
    index[path] = `${QUALITY}:${createHash('sha256').update(source).digest('hex')}`;
    if (previous[path] === index[path] && existsSync(target)) return;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, await packBytes(source));
    written++;
  }));
  const text = `${JSON.stringify(Object.fromEntries(Object.keys(index).sort().map(key => [key, index[key]])))}\n`;
  if (written || !existsSync(indexPath) || readFileSync(indexPath, 'utf8') !== text) { mkdirSync(outputDirectory, { recursive: true }); writeFileSync(indexPath, text); }
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [pluginDirectory, outputDirectory, listFile] = process.argv.slice(2);
  try {
    if (!pluginDirectory || !outputDirectory || !listFile) throw new Error('Usage: node scripts/pack-embedded.mjs <plugin directory> <output directory> <list file>');
    const paths = readFileSync(listFile, 'utf8').split(/\r?\n/).map(line => line.trim().replaceAll('\\', '/')).filter(Boolean);
    await pack(pluginDirectory, outputDirectory, paths);
  } catch (error) {
    console.error(`Packing embedded client assets failed: ${error.message}`);
    process.exitCode = 1;
  }
}
