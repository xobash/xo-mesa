import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { matrixTargets, requiredWorkflows } from './native-acceptance-contract.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
export function validateAcceptance(summary, { commit, tag, products }) {
  if (summary?.schema !== 1 || summary.commit !== commit || summary.tag !== tag) throw new Error('Acceptance does not match the exact candidate.');
  if (JSON.stringify(Object.keys(summary).sort()) !== JSON.stringify(['artifacts', 'commit', 'schema', 'tag', 'targets'])) throw new Error('Unexpected acceptance fields.');
  const expected = products.map(p => `${p.name}:${p.sha256}`).sort();
  const actual = summary.artifacts?.map(p => `${p.name}:${p.sha256}`).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Acceptance artifact hashes do not match.');
  if (summary.targets?.length !== matrixTargets.length) throw new Error('Incomplete native support matrix.');
  for (const target of matrixTargets) {
    const entries = summary.targets.filter(item => item.target === target);
    if (entries.length !== 1) throw new Error(`Missing or duplicate target: ${target}`);
    const entry = entries[0];
    if (!hashPattern.test(entry.recordSha256) || !hashPattern.test(entry.artifactSha256)) throw new Error('Missing native evidence hashes.');
    const platform = target.startsWith('Windows') ? 'windows' : target.startsWith('macOS') ? 'macos' : 'linux';
    if (!products.some(p => p.platform === platform && p.sha256 === entry.artifactSha256)) throw new Error('Native record is for a different platform artifact.');
    if (entry.workflows?.length !== requiredWorkflows.length) throw new Error('Incomplete native workflow matrix.');
    for (const name of requiredWorkflows) {
      const rows = entry.workflows.filter(row => row.name === name);
      if (rows.length !== 1 || rows[0].result !== 'pass' || !hashPattern.test(rows[0].evidenceSha256)) throw new Error(`Native workflow did not pass: ${name}`);
    }
  }
  // Serialize only known public fields; reject private extras at every level.
  const clean = { schema: 1, commit, tag, artifacts: products.map(({ name, sha256 }) => ({ name, sha256 })), targets: summary.targets.map(t => ({ target: t.target, artifactSha256: t.artifactSha256, recordSha256: t.recordSha256, workflows: t.workflows.map(w => ({ name: w.name, result: w.result, evidenceSha256: w.evidenceSha256 })) })) };
  if (JSON.stringify(summary) !== JSON.stringify(clean)) {
    // Property order is irrelevant, extra properties are not.
    const normalize = v => Array.isArray(v) ? v.map(normalize) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, normalize(v[k])])) : v;
    if (JSON.stringify(normalize(summary)) !== JSON.stringify(normalize(clean))) throw new Error('Acceptance contains unexpected or private fields.');
  }
  return clean;
}
export function candidateProducts(dir, commit, tag) {
  const products = [];
  for (const platform of ['macos', 'windows', 'linux']) {
    const candidate = JSON.parse(readFileSync(join(dir, `candidate-${platform}.json`), 'utf8'));
    if (JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(["commit", "platform", "schema", "tag"])) throw new Error("Unexpected candidate metadata fields.");
    if (candidate.schema !== 1 || candidate.commit !== commit || candidate.tag !== tag || candidate.platform !== platform) throw new Error('Mixed candidate revisions.');
    const lines = readFileSync(join(dir, `checksums-${platform}.txt`), 'utf8').trim().split('\n');
    for (const line of lines) {
      const match = /^([a-f0-9]{64})  ([A-Za-z0-9_.+-]+)$/.exec(line);
      if (!match || digest(readFileSync(join(dir, match[2]))) !== match[1]) throw new Error('Invalid candidate product checksum.');
      products.push({ name: match[2], sha256: match[1], platform });
    }
  }
  if (new Set(products.map(p => p.name)).size !== products.length) throw new Error('Duplicate artifact name.');
  const formats = { macos: ['.dmg'], windows: ['.msi', '.exe'], linux: ['.AppImage', '.deb'] };
  for (const [platform, extensions] of Object.entries(formats)) {
    const platformProducts = products.filter(p => p.platform === platform);
    if (platformProducts.length !== extensions.length || platformProducts.some(p => !extensions.some(ext => p.name.endsWith(ext)))) throw new Error('Unexpected release product format.');
    for (const ext of extensions) if (platformProducts.filter(p => p.name.endsWith(ext)).length !== 1) throw new Error('Incomplete release product set.');
  }
  const allowed = new Set([...products.map(p => p.name), ...['macos', 'windows', 'linux'].flatMap(p => [`candidate-${p}.json`, `checksums-${p}.txt`])]);
  for (const name of readdirSync(dir)) if (!allowed.has(name)) throw new Error('Unexpected candidate file.');
  return products;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, dir, ...records] = process.argv.slice(2);
    const commit = process.env.MESA_RELEASE_SHA, tag = process.env.MESA_RELEASE_TAG;
    const products = candidateProducts(dir, commit, tag);
    let summary;
    if (mode === 'create') {
      const targets = records.map(path => {
        const check = spawnSync(process.execPath, [join(import.meta.dirname, 'native-acceptance-check.mjs'), path, '--release'], { encoding: 'utf8' });
        if (check.status !== 0) throw new Error(check.stderr || 'Native acceptance validation failed.');
        const text = readFileSync(path, 'utf8');
        const field = name => new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(text)?.[1]?.trim();
        if (field('Mesa commit') !== commit) throw new Error('Native record commit mismatch.');
        return { target: field('Matrix target'), artifactSha256: field('Artifact SHA-256'), recordSha256: digest(text), workflows: requiredWorkflows.map(name => {
          const row = text.split('\n').find(line => line.startsWith(`| ${name} |`));
          const cells = row.split('|').map(c => c.trim());
          return { name, result: 'pass', evidenceSha256: digest(`${cells[4]}\n${cells[5]}`) };
        }) };
      });
      summary = { schema: 1, commit, tag, artifacts: products.map(({ name, sha256 }) => ({ name, sha256 })), targets };
    } else if (mode === 'verify') summary = JSON.parse(process.env.MESA_NATIVE_ACCEPTANCE_JSON);
    else throw new Error('Usage: release-acceptance.mjs create|verify candidate-directory [local-records...]');
    writeFileSync('output/release-acceptance.json', JSON.stringify(validateAcceptance(summary, { commit, tag, products }), null, 2) + '\n');
    console.log('Exact candidate native acceptance and product hashes verified.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
