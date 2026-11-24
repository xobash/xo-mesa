// Update feed for a signed release (docs/updates.md, docs/release.md).
//
//   check            the committed updater config is the official feed with a
//                    real public key (release gate; the placeholder fails)
//   build <dir>      verify each platform's updater package in <dir> against
//                    that key and write output/release-updater/latest.json
//   verify <dir>     re-verify a downloaded candidate's latest.json before
//                    publication
//
// Verification is minisign as the Tauri updater does it: Ed25519 over the
// package (its BLAKE2b-512 for prehashed signatures), then the global signature over the signature
// and its trusted comment, whose `version:` must equal the release version.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const UPDATE_ENDPOINT = 'https://github.com/xobash/xo-mesa/releases/latest/download/latest.json';
export const PLACEHOLDER_PUBKEY = 'MESA_UPDATER_PUBLIC_KEY_NOT_SET';
const DOWNLOAD_BASE = 'https://github.com/xobash/xo-mesa/releases/download';
// Updater package per platform, the feed targets it serves and the installer
// suffix the plugin tries first (`{target}-{installer}`, then `{target}`).
// The macOS package is universal; MSI and deb installs read the plain target
// only to report a new version (they never install it silently).
export const UPDATER_PACKAGES = {
  macos: { suffix: '.app.tar.gz', targets: ['darwin-aarch64', 'darwin-x86_64'], installer: 'app' },
  windows: { suffix: '-setup.exe', targets: ['windows-x86_64'], installer: 'nsis' },
  linux: { suffix: '.AppImage', targets: ['linux-x86_64'], installer: 'appimage' },
};
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const ASSET_NAME = /^[A-Za-z0-9_.+-]+$/;

/** The committed updater settings; throws unless they are release-ready. */
export function updaterConfig(conf) {
  const updater = conf?.plugins?.updater;
  if (!updater) throw new Error('tauri.conf.json has no updater configuration.');
  if (JSON.stringify(updater.endpoints) !== JSON.stringify([UPDATE_ENDPOINT])) throw new Error('The updater endpoint must be the official release feed only.');
  if (updater.requireSignedVersion !== true) throw new Error('The updater must require a signed version.');
  if (updater.windows?.installMode !== 'quiet') throw new Error('Windows updates must install in quiet mode.');
  for (const key of ['dangerousInsecureTransportProtocol', 'dangerousAcceptInvalidCerts', 'dangerousAcceptInvalidHostnames', 'allowDowngrades']) {
    if (key in updater) throw new Error(`Unsafe updater option: ${key}`);
  }
  if (updater.pubkey === PLACEHOLDER_PUBKEY) throw new Error('Replace the placeholder updater public key before a release (docs/updates.md, "Release signing key").');
  decodePublicKey(updater.pubkey);
  if (typeof conf.version !== 'string' || !conf.version) throw new Error('tauri.conf.json has no version.');
  return { pubkey: updater.pubkey, version: conf.version };
}

const base64Lines = (text, what) => {
  const lines = Buffer.from(String(text).trim(), 'base64').toString('utf8').replace(/\r\n/g, '\n').trim().split('\n');
  if (!lines.length) throw new Error(`Unreadable ${what}.`);
  return lines;
};

/** A `tauri signer generate` public key (base64 of the minisign .pub text). */
export function decodePublicKey(pubkey) {
  const lines = base64Lines(pubkey ?? '', 'updater public key');
  const raw = Buffer.from(lines[1] ?? '', 'base64');
  if (!/^untrusted comment: /.test(lines[0]) || raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') {
    throw new Error('The updater public key is not a minisign public key.');
  }
  return { keyId: raw.subarray(2, 10), key: createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw.subarray(10)]), format: 'der', type: 'spki' }) };
}

/** Verify `data` against a base64 `.sig`; returns the signed version. */
export function verifyPackage(data, signature, pubkey) {
  const { keyId, key } = decodePublicKey(pubkey);
  const [untrusted, sigLine, trustedLine, globalLine] = base64Lines(signature, 'package signature');
  const sig = Buffer.from(sigLine ?? '', 'base64');
  const global = Buffer.from(globalLine ?? '', 'base64');
  if (!/^untrusted comment: /.test(untrusted ?? '') || sig.length !== 74 || global.length !== 64 || !trustedLine?.startsWith('trusted comment: ')) throw new Error('Malformed package signature.');
  // `ED` signs the BLAKE2b-512 digest (current minisign); legacy `Ed` the bytes.
  const algorithm = sig.subarray(0, 2).toString('latin1');
  if (algorithm !== 'ED' && algorithm !== 'Ed') throw new Error('Unknown package signature algorithm.');
  if (!sig.subarray(2, 10).equals(keyId)) throw new Error('Package was signed with a different key.');
  const signatureBytes = sig.subarray(10);
  const message = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  if (!verify(null, message, key, signatureBytes)) throw new Error('Package signature does not verify.');
  const trusted = trustedLine.slice('trusted comment: '.length);
  if (!verify(null, Buffer.concat([signatureBytes, Buffer.from(trusted, 'utf8')]), key, global)) throw new Error('Trusted comment signature does not verify.');
  const version = /(?:^|\t)version:([^\t]+)/.exec(trusted)?.[1];
  if (!version) throw new Error('Package signature carries no signed version.');
  return version.replace(/^v/, '');
}

function packageFor(dir, platform) {
  const { suffix } = UPDATER_PACKAGES[platform];
  const names = readdirSync(dir).filter(name => name.endsWith(suffix));
  if (names.length !== 1) throw new Error(`Expected exactly one ${suffix} updater package.`);
  const name = names[0];
  if (!ASSET_NAME.test(name)) throw new Error(`Unexpected updater package name: ${name}`);
  return { name, bytes: readFileSync(join(dir, name)), signature: readFileSync(join(dir, `${name}.sig`), 'utf8').trim() };
}

/** latest.json for `tag`: every package verified, signed for `version`. */
export function buildFeed(dir, { tag, version, pubkey }) {
  if (tag !== `v${version}`) throw new Error('The release tag does not match the app version the packages are signed for.');
  const platforms = {};
  for (const [platform, { targets, installer }] of Object.entries(UPDATER_PACKAGES)) {
    const pkg = packageFor(dir, platform);
    const signed = verifyPackage(pkg.bytes, pkg.signature, pubkey);
    if (signed !== version) throw new Error(`${pkg.name} is signed for ${signed}, not ${version}.`);
    const entry = { signature: pkg.signature, url: `${DOWNLOAD_BASE}/${encodeURIComponent(tag)}/${encodeURIComponent(pkg.name)}` };
    for (const target of targets) {
      platforms[`${target}-${installer}`] = entry;
      platforms[target] = entry;
    }
  }
  return { version, platforms };
}

/** The published feed must be exactly what `buildFeed` makes from these packages. */
export function verifyFeed(dir, options) {
  const feed = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
  if (JSON.stringify(feed) !== JSON.stringify(buildFeed(dir, options))) throw new Error('latest.json does not match the verified packages.');
  return feed;
}

const readConfig = () => updaterConfig(JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, dir] = process.argv.slice(2);
    const tag = process.env.MESA_RELEASE_TAG, commit = process.env.MESA_RELEASE_SHA;
    if (mode === 'check') {
      const { version } = readConfig();
      console.log(`Updater feed and public key are release-ready for ${version}.`);
    } else if (mode === 'build' && dir) {
      const feed = buildFeed(dir, { tag, ...readConfig() });
      const output = 'output/release-updater';
      mkdirSync(output, { recursive: true });
      if (readdirSync(output).length) throw new Error('Release product folder must be empty.');
      const text = JSON.stringify(feed, null, 2) + '\n';
      writeFileSync(join(output, 'latest.json'), text);
      writeFileSync(join(output, 'checksums-updater.txt'), `${createHash('sha256').update(text).digest('hex')}  latest.json\n`);
      writeFileSync(join(output, 'candidate-updater.json'), JSON.stringify({ schema: 1, platform: 'updater', commit, tag }, null, 2) + '\n');
      console.log('Verified every updater package and wrote latest.json.');
    } else if (mode === 'verify' && dir) {
      verifyFeed(dir, { tag, ...readConfig() });
      console.log('latest.json matches the verified, signed updater packages.');
    } else throw new Error('Usage: release-updater.mjs check | build <dir> | verify <dir>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
