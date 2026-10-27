# Mesa activity API

Make the living graph react when an **AI agent or any external tool** touches a
markdown note — the node flickers and a live preview card pops up over it
showing the operation, a status face, and the file's current content.

Filesystem watchers can already see edits/writes Mesa itself makes, but they
**cannot see reads**. So agents report what they're doing by POSTing to a tiny
endpoint on Mesa's built-in server.

## The embedded Pi agent reports automatically

You do **not** need any of the setup below to see the graph react to Mesa's
own Pi agent. When Mesa launches Pi in the embedded terminal it:

1. starts a second, **loopback-only** activity server (bound to `127.0.0.1`,
   never the LAN) with a fresh per-run bearer token, and
2. loads a bundled Pi extension (`src-tauri/resources/mesa-activity.ts`) via
   `--extension`, passing it the port and token through `MESA_ACTIVITY_PORT` /
   `MESA_ACTIVITY_TOKEN`.

The extension hooks Pi's `tool_call` event, which fires for every built-in
`read` / `edit` / `write` **before it runs, identically across every model and
provider Pi can drive** (GPT, Gemini, local models, and others). Each call
is reported to the loopback server, which re-emits the same `activity` event
described below — so agent **reads** light up the graph and float a preview card
just like edits and writes, with zero configuration and nothing leaving the
machine. The extension is inert (a silent no-op) whenever those env vars are
absent, so running `pi` outside Mesa is unaffected.

The rest of this document describes the **public** activity API on the LAN sync
server, for wiring up *other* external tools.

## 1. Enable receiving and verify the identity

In Mesa, open **Sync**, generate or configure a **sync key**, and enable
**Receive**. The HTTPS listener defaults to loopback on port **8787**. A LAN
listener requires selecting its literal IP explicitly. The activity API shares
this listener and its authorization; it does not grant a narrower activity-only
permission. Only give the key to a trusted tool.

Copy the receiving device's **certificate fingerprint** from its Sync panel.
For another device, compare this fingerprint through a trusted channel before
sending anything. Do not obtain the expected pin from the same unverified
network connection. The fingerprint is lowercase SHA-256 of the leaf
certificate's DER bytes. It is public; the sync key is private. Use the native
key reveal dialog when configuring an external tool, and keep both values in
that tool's private environment. Never copy `sync-identity/identity.json` to an
external tool: it also contains the device's private TLS key.

Set `MESA_URL` to the HTTPS origin (default `https://localhost:8787`),
`MESA_FINGERPRINT` to the verified 64-character fingerprint, and `MESA_SYNC_KEY`
to the 64-character sync key. Certificate/key changes require reconfiguration.

The bearer is **not the raw sync key**. It is lowercase hexadecimal
`HMAC-SHA256(UTF8(syncKey), UTF8("mesa-sync-cert-v1:" + fingerprint))`.
Do not hex-decode the key. Both clients below verify the exact certificate
before sending this derived credential. A self-signed certificate is accepted
only through this explicit pin; redirects are never followed.

## 2. Report activity

```text
POST https://localhost:8787/activity
Authorization: Bearer <certificate-scoped HMAC>
Content-Type: application/json

{"path":"Notes/ideas.md","op":"read","status":"summarizing...","detail":"topic line","added":0,"removed":0}
```

- `path`: vault-relative or absolute path of the Markdown note.
- `op`: `read`, `edit`, `write`, or `create`.
- `status` and `detail`: optional status text and the chunk to highlight.
- `added` and `removed`: optional line counts for the change counter.

Responses: `200` means accepted; `401` means invalid scoped credentials;
`429` means authentication is rate-limited; `413` means the body exceeds
1 MiB; `400` means invalid UTF-8 or a body read failure. `409` means vault
access is unavailable during a transaction or pending recovery. Activity is
admitted under the same vault-access guard as sync so it does not claim normal
vault activity while recovery blocks access. Retry a `409` after completing
recovery or after the transaction finishes. Do not silently discard failures.

## 3. Runnable clients

### Node and shell

The source checkout includes [activity-client.mjs](../scripts/activity-client.mjs).
It needs Node 22 and no external packages. From the checkout root:

```bash
printf '%s' '{"path":"Notes/ideas.md","op":"read"}' | node scripts/activity-client.mjs
```

```js
import { mesaActivity } from './scripts/activity-client.mjs';
await mesaActivity({ path: 'Notes/ideas.md', op: 'edit', detail: 'New paragraph', added: 1, removed: 0 });
```

Pass structured objects or JSON so quotes and newlines in paths or details
remain valid. The client reports HTTP errors and fails on a certificate mismatch
before sending any request. For shell integrations, check its exit status.

### Python

Save this as `mesa_activity.py`. It uses Python's standard library and the same
private environment values. Run it with a JSON body on stdin, or import its
`mesa_activity` function.

```python
import hashlib, hmac, http.client, json, os, re, ssl, sys
from urllib.parse import urlsplit

def mesa_activity(body):
    endpoint = urlsplit(os.environ.get("MESA_URL", "https://localhost:8787"))
    if endpoint.scheme != "https" or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.path not in ("", "/") or endpoint.query or endpoint.fragment:
        raise ValueError("MESA_URL must be an HTTPS server origin")
    key, pin = os.environ["MESA_SYNC_KEY"], os.environ["MESA_FINGERPRINT"]
    if not all(re.fullmatch(r"[a-f0-9]{64}", value) for value in (key, pin)):
        raise ValueError("Expected 64-character lowercase hexadecimal key and fingerprint")
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE  # Exact pin below replaces CA/hostname trust.
    conn = http.client.HTTPSConnection(endpoint.hostname, endpoint.port or 443, timeout=5, context=context)
    try:
        conn.connect()
        actual = hashlib.sha256(conn.sock.getpeercert(binary_form=True)).hexdigest()
        if not hmac.compare_digest(actual, pin):
            raise ValueError("Mesa certificate fingerprint mismatch; no activity was sent")
        token = hmac.new(key.encode(), ("mesa-sync-cert-v1:" + pin).encode(), hashlib.sha256).hexdigest()
        conn.request("POST", "/activity", json.dumps(body).encode(), {
            "Authorization": "Bearer " + token, "Content-Type": "application/json",
        })
        response = conn.getresponse()
        response.read()
        if response.status != 200:
            raise RuntimeError("Mesa activity returned HTTP " + str(response.status))
    finally:
        conn.close()

if __name__ == "__main__":
    mesa_activity(json.load(sys.stdin))
```

These clients are exercised against a synthetic TLS listener by
`npm run test:activity-api`, including wrong-pin rejection before HTTP,
scoped credentials, quoted/newline payloads, and HTTP failure reporting. A
Receive-mode packaged app on each supported platform remains a separate native
acceptance check.
