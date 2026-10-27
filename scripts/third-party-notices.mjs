import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const output = join(root, 'public', 'THIRD_PARTY_NOTICES.txt');
const npmLock = readFileSync(join(root, 'package-lock.json'), 'utf8').replace(/\r\n/g, '\n');
const cargoLock = readFileSync(join(root, 'src-tauri', 'Cargo.lock'), 'utf8').replace(/\r\n/g, '\n');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const header = `Mesa third-party notices\nGenerated from installed, locked dependencies. Mesa's own MIT license is separate.\npackage-lock-sha256: ${sha(npmLock)}\nCargo-lock-sha256: ${sha(cargoLock)}\n`;

function licenseFiles(dir, extra = []) {
  if (!existsSync(dir)) throw new Error(`Installed dependency missing: ${dir}`);
  const files = readdirSync(dir).filter(name => /^(LICENSE|LICENCE|COPYING|NOTICE)([.\-_]|$)/i.test(name))
    .map(name => join(dir, name));
  for (const sub of extra) {
    const subdir = join(dir, sub);
    if (existsSync(subdir)) files.push(...readdirSync(subdir)
      .filter(name => /^(LICENSE|LICENCE|COPYING|NOTICE)([.\-_]|$)/i.test(name))
      .map(name => join(subdir, name)));
  }
  return files.sort();
}
function notice(name, version, license, files, base, fallback) {
  if (!license) throw new Error(`No license metadata: ${name}@${version}`);
  if (!files.length && !fallback) throw new Error(`No required license material: ${name}@${version}`);
  let value = `\n${'='.repeat(72)}\n${name}@${version}\nLicense: ${license}\n`;
  if (!files.length) value += `Upstream package did not include a license file; consult the SPDX identifier above.\n`;
  for (const file of files) {
    const body = readFileSync(file, 'utf8');
    if (!body.trim()) throw new Error(`Empty license material: ${file}`);
    value += `\n--- ${file.slice(base.length + 1).replace(/\\/g, '/')} ---\n${body.trimEnd()}\n`;
  }
  return value;
}
function npmNotices() {
  const lock = JSON.parse(npmLock);
  const entries = Object.entries(lock.packages).filter(([path, meta]) =>
    path.startsWith('node_modules/') && !meta.dev && !meta.optional);
  return entries.sort(([a], [b]) => a.localeCompare(b)).map(([path, meta]) => {
    const dir = join(root, path);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json')));
    if (pkg.version !== meta.version) throw new Error(`Installed version differs from lock: ${path}`);
    const files = licenseFiles(dir, pkg.name === 'pdfjs-dist' ? ['cmaps', 'standard_fonts'] : []);
    return notice(pkg.name, meta.version, meta.license ?? pkg.license, files, dir, false);
  }).join('');
}
function cargoMetadata(triple) {
  const localCargo = join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  const cargo = process.env.CARGO || (existsSync(localCargo) ? localCargo : 'cargo');
  const result = spawnSync(cargo, ['metadata', '--locked', '--offline', '--format-version', '1', '--filter-platform', triple], {
    cwd: join(root, 'src-tauri'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Cargo metadata failed for ${triple}: ${result.stderr || result.error}`);
  return JSON.parse(result.stdout);
}
function cargoNotices() {
  const triples = ['x86_64-apple-darwin', 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu'];
  const selected = new Map();
  for (const triple of triples) {
    const metadata = cargoMetadata(triple);
    const packages = new Map(metadata.packages.map(pkg => [pkg.id, pkg]));
    const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
    const seen = new Set([metadata.resolve.root]);
    const queue = [metadata.resolve.root];
    while (queue.length) {
      const id = queue.pop();
      for (const dep of nodes.get(id).deps) {
        if (!dep.dep_kinds.some(kind => kind.kind === null) || seen.has(dep.pkg)) continue;
        seen.add(dep.pkg); queue.push(dep.pkg);
      }
    }
    for (const id of seen) {
      if (id === metadata.resolve.root) continue;
      const pkg = packages.get(id);
      const key = `${pkg.name}@${pkg.version}`;
      const prior = selected.get(key);
      selected.set(key, { pkg, platforms: new Set([...(prior?.platforms ?? []), triple]) });
    }
  }
  const known = /\b(MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC|Zlib|Unicode-3\.0|MPL-2\.0|Unlicense|0BSD)\b/i;
  return [...selected].sort(([a], [b]) => a.localeCompare(b)).map(([, {pkg, platforms}]) => {
    const dir = dirname(pkg.manifest_path);
    const files = licenseFiles(dir);
    if (pkg.license_file) {
      const named = resolve(dir, pkg.license_file);
      if (!existsSync(named)) throw new Error(`Declared license file missing: ${pkg.name}@${pkg.version}`);
      if (!files.includes(named)) files.push(named);
    }
    const part = notice(pkg.name, pkg.version, pkg.license, [...new Set(files)].sort(), dir, known.test(pkg.license ?? ''));
    return part.replace(`License: ${pkg.license}\n`, `License: ${pkg.license}\nDesktop targets: ${[...platforms].sort().join(', ')}\n`);
  }).join('');
}

const frontendMarker = '\nFrontend runtime dependencies (package-lock.json)\n';
const nativeMarker = '\nNative runtime dependencies (Cargo.lock; desktop target union)\n';
function checkedArtifact() {
  if (!existsSync(output)) throw new Error('THIRD_PARTY_NOTICES.txt is missing; run npm run notices:generate');
  const existing = readFileSync(output, 'utf8');
  if (!existing.startsWith(header)) throw new Error('Notice lockfile hashes differ; regenerate notices');
  const boundary = existing.indexOf(nativeMarker);
  if (boundary < 0) throw new Error('Native notice section is missing');
  const native = existing.slice(boundary + nativeMarker.length);
  const checksum = `native-notices-sha256: ${sha(native)}\n`;
  if (!existing.startsWith(header + checksum)) throw new Error('Native notice checksum differs; regenerate notices');
  return { existing, native, checksum, boundary };
}
if (process.argv.includes('--check')) {
  const { existing, checksum, boundary } = checkedArtifact();
  const expected = header + checksum + frontendMarker + npmNotices();
  if (existing.slice(0, boundary) !== expected) throw new Error('Frontend notices differ from installed, locked dependencies; regenerate them');
  if (!existing.includes('pdfjs-dist@') || !existing.includes('Apache License') || !existing.includes('standard_fonts/LICENSE_'))
    throw new Error('PDF.js license or upstream font notices are missing');
  console.log('Notice lockfile hashes, native checksum and installed frontend licenses passed.');
} else if (process.argv.includes('--check-native')) {
  const { native } = checkedArtifact();
  if (native !== cargoNotices()) throw new Error('Native notices differ from locked desktop inventories; regenerate them');
  console.log('Native notices match the complete locked desktop target inventories.');
} else if (process.argv.includes('--generate')) {
  const native = cargoNotices();
  const notices = header + `native-notices-sha256: ${sha(native)}\n` + frontendMarker + npmNotices() + nativeMarker + native;
  writeFileSync(output, notices);
  console.log(`Wrote ${output} (${notices.length} characters)`);
} else {
  throw new Error('Use --generate, --check or --check-native');
}
