import https from 'node:https';
import tls from 'node:tls';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function activityCredential(key, fingerprint) {
  if (!/^[a-f0-9]{64}$/.test(key ?? '') || !/^[a-f0-9]{64}$/.test(fingerprint ?? '')) {
    throw new Error('Set MESA_SYNC_KEY and MESA_FINGERPRINT to their 64-character lowercase hexadecimal values.');
  }
  // The sync key is UTF-8 hexadecimal text, not hex-decoded bytes.
  return createHmac('sha256', key).update(`mesa-sync-cert-v1:${fingerprint}`).digest('hex');
}

export async function mesaActivity(body, env = process.env) {
  const endpoint = new URL(env.MESA_URL || 'https://localhost:8787');
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('MESA_URL must be an HTTPS server origin without credentials, path, query or fragment.');
  }
  const fingerprint = env.MESA_FINGERPRINT;
  const token = activityCredential(env.MESA_SYNC_KEY, fingerprint);
  const data = Buffer.from(JSON.stringify(body));
  const agent = new https.Agent();
  // Release the TLS socket to HTTP only after matching the operator-verified pin.
  agent.createConnection = (options, callback) => {
    const socket = tls.connect({ ...options, rejectUnauthorized: false });
    const failed = error => callback(error);
    socket.once('error', failed);
    socket.setTimeout(5000, () => socket.destroy(new Error('Mesa TLS connection timed out.')));
    socket.once('secureConnect', () => {
      const der = socket.getPeerCertificate().raw;
      const actual = der && createHash('sha256').update(der).digest();
      if (!actual || !timingSafeEqual(actual, Buffer.from(fingerprint, 'hex'))) {
        socket.destroy(new Error('Mesa certificate fingerprint mismatch; no activity was sent.'));
        return;
      }
      socket.removeListener('error', failed);
      callback(null, socket);
    });
  };
  try {
    return await new Promise((resolve, reject) => {
      const request = https.request(new URL('/activity', endpoint), {
        agent, method: 'POST', headers: {
          Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': data.length,
        },
      }, response => {
        response.resume();
        response.once('end', () => response.statusCode === 200
          ? resolve()
          : reject(new Error(`Mesa activity returned HTTP ${response.statusCode}${response.statusCode === 409 ? '; retry after vault recovery or the transaction completes' : ''}.`)));
        response.once('error', reject);
      });
      request.setTimeout(5000, () => request.destroy(new Error('Mesa activity request timed out.')));
      request.once('error', reject);
      request.end(data);
    });
  } finally { agent.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let json = '';
    for await (const chunk of process.stdin) json += chunk;
    await mesaActivity(JSON.parse(json));
    console.log('Activity accepted.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
