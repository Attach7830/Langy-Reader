import { readdir, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
async function files(dir, prefix) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(join(dir, entry.name), `${prefix}/${entry.name}`) : `${prefix}/${entry.name}`))).flat();
}
const urls = ['/', '/manifest.webmanifest', '/app-icon.png', '/offline-range.js', '/service-worker.js', ...await files('dist/assets', '/assets')];
for (const name of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) urls.push(...await files(`node_modules/pdfjs-dist/${name}`, `/pdf-assets/${name}`));
await copyFile('src/assets/langy-icon.png', 'dist/app-icon.png');
await writeFile('dist/offline-assets.json', JSON.stringify({ version: createHash('sha256').update(JSON.stringify(urls)).digest('hex'), assets: urls }));
