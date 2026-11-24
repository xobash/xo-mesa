import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLACEHOLDER_PUBKEY, UPDATE_ENDPOINT, buildFeed, updaterConfig, verifyFeed, verifyPackage } from './release-updater.mjs';

// A throwaway key in the exact formats `tauri signer` writes: base64 of the
// minisign .pub text, and base64 of the minisign signature text.
function testSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = randomBytes(8);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const pub = `untrusted comment: minisign public key ${keyId.toString('hex').toUpperCase()}\n${Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64')}\n`;
  const signFor = (data, version, key = privateKey) => {
    const signature = sign(null, createHash('blake2b512').update(data).digest(), key);
    const trusted = `timestamp:1700000000\tfile:package\tversion:${version}`;
    const global = sign(null, Buffer.concat([signature, Buffer.from(trusted)]), key);
    const text = `untrusted comment: signature from tauri secret key\n${Buffer.concat([Buffer.from('ED'), keyId, signature]).toString('base64')}\ntrusted comment: ${trusted}\n${global.toString('base64')}\n`;
    return Buffer.from(text).toString('base64');
  };
  return { pubkey: Buffer.from(pub).toString('base64'), signFor };
}

const tag = 'v0.2.0', version = '0.2.0';
const names = { macos: 'Mesa.app.tar.gz', windows: 'Mesa_0.2.0_x64-setup.exe', linux: 'Mesa_0.2.0_amd64.AppImage' };

function candidate(signer, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mesa-updater-feed-'));
  for (const [platform, name] of Object.entries(names)) {
    const bytes = Buffer.from(`${platform} package`);
    writeFileSync(join(dir, name), bytes);
    writeFileSync(join(dir, `${name}.sig`), overrides[platform] ?? signer.signFor(bytes, version));
  }
  return dir;
}

it('builds latest.json only from packages signed by the committed key for this version', () => {
  const signer = testSigner();
  const dir = candidate(signer);
  try {
    const feed = buildFeed(dir, { tag, version, pubkey: signer.pubkey });
    assert.equal(feed.version, version);
    assert.deepEqual(Object.keys(feed.platforms).sort(), [
      'darwin-aarch64', 'darwin-aarch64-app', 'darwin-x86_64', 'darwin-x86_64-app',
      'linux-x86_64', 'linux-x86_64-appimage', 'windows-x86_64', 'windows-x86_64-nsis',
    ]);
    assert.equal(feed.platforms['windows-x86_64-nsis'].url, 'https://github.com/xobash/xo-mesa/releases/download/v0.2.0/Mesa_0.2.0_x64-setup.exe');
    assert.equal(feed.platforms['darwin-x86_64'].signature, readFileSync(join(dir, 'Mesa.app.tar.gz.sig'), 'utf8').trim());
    // The feed carries no date, notes or anything that identifies a user.
    assert.deepEqual(Object.keys(feed), ['version', 'platforms']);
    writeFileSync(join(dir, 'latest.json'), JSON.stringify(feed, null, 2) + '\n');
    assert.deepEqual(verifyFeed(dir, { tag, version, pubkey: signer.pubkey }), feed);
    // A feed edited after the build (e.g. a URL swapped) is refused.
    feed.platforms['linux-x86_64'].url = 'https://example.com/other.AppImage';
    writeFileSync(join(dir, 'latest.json'), JSON.stringify(feed));
    assert.throws(() => verifyFeed(dir, { tag, version, pubkey: signer.pubkey }), /does not match/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('refuses changed bytes, another key, another signed version and a mismatched tag', () => {
  const signer = testSigner(), other = testSigner();
  const bytes = Buffer.from('package');
  assert.equal(verifyPackage(bytes, signer.signFor(bytes, version), signer.pubkey), version);
  assert.throws(() => verifyPackage(Buffer.from('packagf'), signer.signFor(bytes, version), signer.pubkey), /does not verify/);
  assert.throws(() => verifyPackage(bytes, other.signFor(bytes, version), signer.pubkey), /different key|does not verify/);
  const older = candidate(signer, { linux: signer.signFor(Buffer.from('linux package'), '0.1.9') });
  try {
    assert.throws(() => buildFeed(older, { tag, version, pubkey: signer.pubkey }), /signed for 0\.1\.9/);
    assert.throws(() => buildFeed(older, { tag: 'v0.2.1', version, pubkey: signer.pubkey }), /tag does not match/);
  } finally { rmSync(older, { recursive: true, force: true }); }
});

it('fails safe until the owner commits a real public key', () => {
  const signer = testSigner();
  const conf = { version, plugins: { updater: { pubkey: PLACEHOLDER_PUBKEY, endpoints: [UPDATE_ENDPOINT], requireSignedVersion: true, windows: { installMode: 'quiet' } } } };
  assert.throws(() => updaterConfig(conf), /placeholder/);
  conf.plugins.updater.pubkey = signer.pubkey;
  assert.deepEqual(updaterConfig(conf), { pubkey: signer.pubkey, version });
  for (const [field, value, message] of [
    ['endpoints', ['https://example.com/latest.json'], /official release feed/],
    ['requireSignedVersion', false, /signed version/],
    ['windows', { installMode: 'passive' }, /quiet/],
    ['dangerousInsecureTransportProtocol', true, /Unsafe/],
    ['pubkey', Buffer.from('untrusted comment: x\nAAAA\n').toString('base64'), /not a minisign/],
  ]) {
    assert.throws(() => updaterConfig({ ...conf, plugins: { updater: { ...conf.plugins.updater, [field]: value } } }), message, field);
  }
  // The committed config is the official feed; only the key may still be pending.
  const committed = JSON.parse(readFileSync(fileURLToPath(new URL('../src-tauri/tauri.conf.json', import.meta.url)), 'utf8'));
  if (committed.plugins.updater.pubkey === PLACEHOLDER_PUBKEY) assert.throws(() => updaterConfig(committed), /placeholder/);
  else assert.equal(updaterConfig(committed).version, committed.version);
});

it('release builds sign updater packages, the gate checks the key and publication re-verifies the feed', () => {
  const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  const candidateWorkflow = read('../.github/workflows/release-candidate.yml');
  const release = read('../.github/workflows/release.yml');
  assert.match(candidateWorkflow, /- run: node scripts\/release-updater\.mjs check\n/);
  assert.equal(candidateWorkflow.match(/TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/g)?.length, 3);
  assert.match(candidateWorkflow, /node scripts\/release-updater\.mjs build output\/products/);
  assert.match(release, /node scripts\/release-updater\.mjs verify output\/products/);
  assert.ok(release.indexOf('release-updater.mjs verify') < release.indexOf('gh release create'));
  assert.deepEqual(JSON.parse(read('../src-tauri/tauri.updater.conf.json')), { bundle: { createUpdaterArtifacts: true } });
  assert.match(read('./release-macos.sh'), /--config src-tauri\/tauri\.updater\.conf\.json/);
  assert.match(read('./release-windows.ps1'), /createUpdaterArtifacts = \$true/);
});
