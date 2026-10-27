import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import https from 'node:https';
import { X509Certificate, createHmac } from 'node:crypto';
import { mesaActivity, activityCredential } from './activity-client.mjs';

const doc = readFileSync('docs/activity-api.md', 'utf8');
test('activity documentation agrees with the TLS server contract', () => {
  assert.doesNotMatch(doc, /http:\/\/localhost:8787|Bearer <your sync key>/);
  for (const term of ['https://localhost:8787', 'mesa-sync-cert-v1:', '409', 'MESA_FINGERPRINT']) assert.ok(doc.includes(term), term);
  const source = readFileSync('src-tauri/src/sync_server.rs', 'utf8');
  assert.ok(source.includes('key.as_bytes()'));
  assert.ok(source.includes('mesa-sync-cert-v1:'));
  assert.ok(source.includes('vaulttransaction::access'));
  assert.ok(doc.includes('1 MiB'));
  assert.match(readFileSync('src-tauri/src/sync.rs', 'utf8'), /MAX_ACTIVITY_BYTES: usize = 1 << 20/);
  assert.equal(activityCredential('0123456789abcdef'.repeat(4), 'a'.repeat(64)), '7f7eb47de4883660fabc22d30deda7a71d5dcaf433e8997f79dde376ca90efb5');
});

test('copied Node and Python clients pin TLS before HTTP and use certificate-scoped auth', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesa-activity-contract-'));
  let server;
  try {
    const keyPath = join(dir, 'key.pem'), certPath = join(dir, 'cert.pem');
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost'], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const cert = readFileSync(certPath), key = readFileSync(keyPath);
    const fingerprint = new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase();
    const syncKey = Array.from({ length: 64 }, (_, index) => (index % 16).toString(16)).join('');
    const token = createHmac('sha256', syncKey).update(`mesa-sync-cert-v1:${fingerprint}`).digest('hex');
    let status = 200;
    const requests = [];
    server = https.createServer({ cert, key }, (req, res) => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => {
        requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(data) });
        res.writeHead(status); res.end('ok');
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const env = { ...process.env, MESA_URL: `https://127.0.0.1:${server.address().port}`, MESA_SYNC_KEY: syncKey, MESA_FINGERPRINT: fingerprint };
    const body = { path: 'Notes/quoted"name.md', op: 'read', detail: 'first\nsecond' };
    await mesaActivity(body, env);
    assert.deepEqual(requests[0], { path: '/activity', auth: `Bearer ${token}`, body });
    assert.notEqual(token, syncKey);
    await assert.rejects(mesaActivity(body, { ...env, MESA_FINGERPRINT: '0'.repeat(64) }), /fingerprint mismatch/);
    assert.equal(requests.length, 1);
    status = 409;
    await assert.rejects(mesaActivity(body, env), /409.*retry/);
    status = 200;
    const python = doc.match(/```python\n([\s\S]*?)\n```/)[1];
    const runPython = pin => new Promise(resolve => {
      const child = spawn('python3', ['-c', python], { env: { ...env, MESA_FINGERPRINT: pin } });
      let stderr = '';
      child.stderr.on('data', data => { stderr += data; });
      child.once('error', error => resolve({ code: -1, stderr: error.message }));
      child.once('exit', code => resolve({ code, stderr }));
      child.stdin.end(JSON.stringify(body));
    });
    const accepted = await runPython(fingerprint);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.deepEqual(requests.at(-1), { path: '/activity', auth: `Bearer ${token}`, body });
    const count = requests.length;
    const rejected = await runPython('0'.repeat(64));
    assert.notEqual(rejected.code, 0); assert.match(rejected.stderr, /fingerprint mismatch/);
    assert.equal(requests.length, count);
    status = 409;
    const conflict = await runPython(fingerprint);
    assert.notEqual(conflict.code, 0); assert.match(conflict.stderr, /409/);
    assert.throws(() => activityCredential('bad', fingerprint), /64-character/);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
