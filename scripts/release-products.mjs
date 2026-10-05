import { mkdirSync, readdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
const platform = process.argv[2];
if (!['macos', 'windows', 'linux'].includes(platform)) throw new Error('Specify macos, windows, or linux.');
const base = platform === 'macos' ? 'src-tauri/target/universal-apple-darwin/release/bundle' : 'src-tauri/target/release/bundle';
const extensions = { macos: ['.dmg'], windows: ['.msi', '.exe'], linux: ['.AppImage', '.deb'] }[platform];
const products = [];
function walk(dir) { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.isFile() && extensions.some(ext => p.endsWith(ext))) products.push(p); } }
walk(base);
for (const ext of extensions) if (products.filter(p => p.endsWith(ext)).length !== 1) throw new Error(`Expected exactly one ${ext} release product.`);
const output = `output/release-${platform}`;
mkdirSync(output, { recursive: true });
if (readdirSync(output).length) throw new Error('Release product folder must be empty.');
const hashes = products.map(p => { const name = basename(p); copyFileSync(p, join(output, name)); return `${createHash('sha256').update(readFileSync(p)).digest('hex')}  ${name}`; }).sort();
writeFileSync(join(output, `checksums-${platform}.txt`), hashes.join('\n') + '\n');
writeFileSync(join(output, `candidate-${platform}.json`), JSON.stringify({ schema: 1, platform, commit: process.env.MESA_RELEASE_SHA, tag: process.env.MESA_RELEASE_TAG }, null, 2) + '\n');
