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
provider Pi can drive** (Claude, GPT/Codex, Gemini, local models, …). Each call
is reported to the loopback server, which re-emits the same `activity` event
described below — so agent **reads** light up the graph and float a preview card
just like edits and writes, with zero configuration and nothing leaving the
machine. The extension is inert (a silent no-op) whenever those env vars are
absent, so running `pi` outside Mesa is unaffected.

The rest of this document describes the **public** activity API on the LAN sync
server, for wiring up *other* external tools.

## 1. Turn the server on

In Mesa: **Sync** (top bar) → set a **sync key** → **Receive**. The
server now accepts requests on the sync port (default **8787**) using that
sync key as a bearer token. The activity endpoint rides on the same server.

## 2. Report activity

```
POST http://localhost:8787/activity
Authorization: Bearer <your sync key>
Content-Type: application/json

{
  "path": "Notes/ideas.md",
  "op": "read",
  "status": "summarizing...",
  "detail": "The paragraph or line being touched",
  "added": 3,
  "removed": 1
}
```

- `path` — vault-relative (e.g. `Notes/ideas.md`) or absolute; Mesa maps it
  to the matching markdown note node. For `create` / `write` events, Mesa will
  rescan when needed so a newly created `.md` file can become a node as soon as
  it lands.
- `op` — one of `read`, `edit`, `write`, `create`.
- `status` — optional free text shown next to the kaomoji face (e.g.
  `computing...`). If omitted, a default verb is used.
- `detail` — optional text chunk Mesa should highlight in the live preview.
- `added` / `removed` — optional line counts for the live `files changed`
  counter.

Returns `200 ok`. A `401` means the bearer token didn't match.

## 3. Copy-paste snippets

### curl

```bash
curl -s -X POST http://localhost:8787/activity \
  -H "Authorization: Bearer $MESA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"path":"Notes/ideas.md","op":"read","status":"summarizing...","detail":"topic line","added":0,"removed":0}'
```

### bash helper

```bash
# usage: mesa_activity <relpath> <read|edit|write|create> [status] [detail] [added] [removed]
mesa_activity() {
  curl -s -X POST "http://localhost:${MESA_PORT:-8787}/activity" \
    -H "Authorization: Bearer ${MESA_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"path\":\"$1\",\"op\":\"$2\",\"status\":\"${3:-}\",\"detail\":\"${4:-}\",\"added\":${5:-0},\"removed\":${6:-0}}" >/dev/null
}
# mesa_activity "Notes/ideas.md" edit "rewriting..." "new paragraph" 4 1
```

### Python

```python
import os, json, urllib.request

def mesa_activity(path, op, status="", detail="", added=0, removed=0):
    body = json.dumps({
        "path": path,
        "op": op,
        "status": status,
        "detail": detail,
        "added": added,
        "removed": removed,
    }).encode()
    req = urllib.request.Request(
        f"http://localhost:{os.environ.get('MESA_PORT', '8787')}/activity",
        data=body, method="POST",
        headers={
            "Authorization": f"Bearer {os.environ['MESA_TOKEN']}",
            "Content-Type": "application/json",
        },
    )
    try:
        urllib.request.urlopen(req, timeout=1)
    except Exception:
        pass  # never let telemetry break the agent

# mesa_activity("Notes/ideas.md", "edit", "rewriting intro...", "new intro", 6, 2)
```

### Node

```js
async function mesaActivity(path, op, status = "", detail = "", added = 0, removed = 0) {
  try {
    await fetch(`http://localhost:${process.env.MESA_PORT || 8787}/activity`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.MESA_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path, op, status, detail, added, removed }),
    });
  } catch {}
}
// await mesaActivity("Notes/ideas.md", "write", "saving draft...", "new draft", 12, 3);
```

Wrap your agent's read/write helpers so each file access fires one of these and
Mesa's graph becomes a live view of what the agent is doing.
