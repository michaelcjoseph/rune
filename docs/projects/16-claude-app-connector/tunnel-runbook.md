> **⚠️ OUTDATED (2026-06-30).** This runbook predates the standalone MCP
> daemon. It targets the web process on `127.0.0.1:3847` with the legacy
> `MCP_ISSUER_URL` env. The live setup now funnels `/mcp` + the OAuth
> `.well-known` paths to the **standalone daemon on `127.0.0.1:3848`**
> (launchd label `com.jarvis.rune-mcp`, env `RUNE_MCP_ISSUER_URL`,
> consent-form secret `RUNE_MCP_SECRET`). Read for the surface contract and
> recovery shape, not the exact ports/env/commands.

# Tunnel runbook — exposing `/mcp` for the Claude App connector

Project 16 Phase 2, task **remote-tunnel-exposure**. The tunnel is the ONLY
public surface: it forwards exactly the MCP + OAuth paths to the daemon on
`127.0.0.1:3847`, and no inbound port is ever opened on the host.

**Decision (2026-06-10): Tailscale Funnel first.** Both options are $0 in
service fees; Cloudflare's hidden cost is requiring a domain on Cloudflare
DNS, Funnel's is its long-lived beta label (no support SLA, possible CLI
changes with notice — it ships inside the regular tailscaled releases and is
actively maintained). For a single-user connector already on Tailscale,
Funnel is fewer moving parts: no new account, no domain, no extra daemon,
and TLS terminates on this machine (Tailscale's relays only ever see
ciphertext). The Cloudflare Tunnel path is kept as the documented fallback
in the appendix — switching is an afternoon if Funnel ever breaks.

> Status: this runbook + config are the docs/config deliverable. The live
> standing-up (tailnet admin toggles + the mount commands) is
> operator-interactive and is tracked by the parked work-run.

## What gets exposed (and what never does)

Path mounts proxied to `127.0.0.1:3847`:

| Mount | Why |
| --- | --- |
| `/mcp` | The Streamable HTTP MCP endpoint (bearer-gated per request); subpaths ride along, which covers `/mcp/oauth/*` (DCR + consent form + token) |
| `/.well-known/oauth-authorization-server` | RFC 8414 AS metadata (the `/mcp` path-aware variant is a subpath) |
| `/.well-known/oauth-protected-resource` | RFC 9728 resource metadata (the 401 challenge points here) |

Everything else — `/health`, `/capture-sessions`, `/oauth/whoop`, the entire
webview (`/`, `/api/*`, the WebSocket) — has no mount and is refused by
tailscaled before it ever reaches the daemon. The webview stays
localhost-only.

Funnel exposes the mounts to the **public internet** (that is the point —
Anthropic's servers, not your devices, call the connector). Your tailnet
ACLs do not protect these paths; the OAuth gate is the access control.

## One-time setup (operator, interactive)

1. Tailnet admin console — two toggles:
   - Enable **HTTPS certificates** (DNS → HTTPS Certificates → Enable).
     MagicDNS must be on (it is by default).
   - Grant the **funnel node attribute** in the tailnet policy file:
     1. Open https://login.tailscale.com/admin/acls (Access Controls) — the
        editor shows the whole-tailnet policy file (HuJSON: comments and
        trailing commas allowed).
     2. Get this machine's Tailscale IP: `tailscale ip -4` on the Mac mini
        (a `100.x.y.z` address). Scoping the grant to the one machine is
        tighter than `autogroup:member` (all owned devices) — Funnel is
        public-internet exposure.
     3. ADD a `nodeAttrs` key alongside the existing sections (or append an
        entry if a `nodeAttrs` array already exists — never a second key):
        ```jsonc
        "nodeAttrs": [
          // Allow the Mac mini (Rune daemon) to use Tailscale Funnel
          { "target": ["100.x.y.z"], "attr": ["funnel"] },
        ],
        ```
     4. Save — the console validates syntax before accepting. The grant
        takes effect within seconds, no tailscaled restart needed.
     5. If the attribute is missing/wiped (e.g. the policy file is later
        reset to defaults), the mount command in step 3 fails loudly with
        `Funnel not available; "funnel" node attribute not set`.
2. Confirm the machine's public name: `tailscale status` →
   `<machine>.<tailnet>.ts.net`. This is the stable HTTPS hostname.
3. Mount the three paths and expose them (persisted across reboots by
   tailscaled; `--bg` keeps it running detached from the shell):
   ```bash
   tailscale funnel --bg --set-path /mcp http://127.0.0.1:3847/mcp
   tailscale funnel --bg --set-path /.well-known/oauth-authorization-server \
     http://127.0.0.1:3847/.well-known/oauth-authorization-server
   tailscale funnel --bg --set-path /.well-known/oauth-protected-resource \
     http://127.0.0.1:3847/.well-known/oauth-protected-resource
   ```
   Check with `tailscale funnel status` — all three mounts should show as
   funnel (public), on port 443.
4. Update Rune env (`.env.local`) and restart the daemon:
   - `MCP_ISSUER_URL=https://<machine>.<tailnet>.ts.net` — pins the OAuth
     issuer so the metadata never trusts the caller-controlled Host header.
   - `RUNE_ALLOWED_HOSTS=localhost,127.0.0.1,<machine>.<tailnet>.ts.net` —
     the /mcp host-allowlist gate must accept the public hostname or every
     funneled request 403s.
   - `RUNE_HTTP_SECRET` must be set (the /mcp surface is not mounted
     without it; it is also the consent-form approval secret).

## Secret handling

- No new credentials are introduced: Funnel rides the existing tailscaled
  node identity, and the Let's Encrypt cert for the ts.net name is
  provisioned and rotated by Tailscale automatically.
- `RUNE_HTTP_SECRET` stays in `.env.local` (gitignored). The human types
  it into the consent form over HTTPS — it never appears in a URL, and the
  OAuth module never echoes it into a redirect.
- Access tokens are **persisted and never-expire** (`logs/mcp-oauth-store.json`,
  0600): the App authenticates ONCE and survives every restart. To revoke all
  access, delete that file and restart the daemon — the next request 401s and
  the App re-runs the handshake.

## Verifying the exposure (after standing up)

```bash
HOST=https://<machine>.<tailnet>.ts.net

# 1. Metadata is reachable over the funnel:
curl -s $HOST/.well-known/oauth-authorization-server | jq .issuer
#    → "https://<machine>.<tailnet>.ts.net"   (proves MCP_ISSUER_URL is pinned)

# 2. /mcp without a token is refused BEFORE the transport:
curl -s -o /dev/null -w '%{http_code}' -X POST $HOST/mcp
#    → 401

# 3. The webview is NOT exposed (no mount — refused by tailscaled):
curl -s -o /dev/null -w '%{http_code}' $HOST/api/state    # → 404
curl -s -o /dev/null -w '%{http_code}' $HOST/health       # → 404
```

## Recovery runbook

| Symptom | Action |
| --- | --- |
| App connector reports unreachable | `tailscale funnel status`; if empty, re-run the three mount commands. Check `tailscale status` for tailnet connectivity. Never open an inbound host port as a fallback. |
| 403 on every funneled request | The ts.net hostname is missing from `RUNE_ALLOWED_HOSTS` — fix env, restart Rune. |
| 401 loop in the App after a Rune restart | Expected: tokens are in-memory. The App re-runs the OAuth handshake; approve via the consent form. |
| Issuer in metadata shows the wrong host | `MCP_ISSUER_URL` unset or stale — fix env, restart Rune. |
| Funnel CLI syntax changed after a Tailscale upgrade (beta caveat) | `tailscale funnel status` / `tailscale serve status` to inspect; re-create the mounts per the current `tailscale funnel --help`. The surface definition above (three mounts, nothing else) is the contract. |
| Revoke all App tokens | `rm logs/mcp-oauth-store.json` then restart the daemon — every issued token dies; the App re-runs the OAuth handshake on its next call. |
| Suspected compromise | `tailscale serve reset` (drops all mounts — surface offline), `rm logs/mcp-oauth-store.json`, rotate `RUNE_HTTP_SECRET`, restart Rune (revokes all tokens). |
| Take the surface offline NOW | `tailscale serve reset` — kills all mounts immediately. The daemon keeps running locally; nothing else exposes it. |

---

## Appendix: Cloudflare Tunnel fallback

Use when Funnel's beta limitations bite (CLI breakage, throughput cap) or if
you prefer a GA-grade product. Requires a domain whose DNS is managed by
Cloudflare (~$10/yr if you don't have one); the tunnel itself is free on
every plan. Note TLS terminates at Cloudflare's edge — the edge sees
plaintext, unlike Funnel.

1. `brew install cloudflared`
2. `cloudflared tunnel login` (browser; writes `~/.cloudflared/cert.pem`)
3. `cloudflared tunnel create rune-mcp` → writes credentials
   `~/.cloudflared/<TUNNEL_UUID>.json` (both files live outside every repo,
   never committed; rotation = delete + re-create the tunnel)
4. `cloudflared tunnel route dns rune-mcp rune-mcp.<your-domain>`
5. `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: rune-mcp
   credentials-file: /Users/<user>/.cloudflared/<TUNNEL_UUID>.json

   ingress:
     - hostname: rune-mcp.<your-domain>
       path: ^/mcp(/.*)?$
       service: http://127.0.0.1:3847
     - hostname: rune-mcp.<your-domain>
       path: ^/\.well-known/oauth-(authorization-server|protected-resource)(/.*)?$
       service: http://127.0.0.1:3847
     # Required hostname-less catch-all; keeps the webview unreachable.
     - service: http_status:404
   ```
6. Env: `MCP_ISSUER_URL=https://rune-mcp.<your-domain>`, add the hostname
   to `RUNE_ALLOWED_HOSTS`, restart Rune.
7. `sudo cloudflared service install` to run as a LaunchDaemon; verify with
   the same three curls as above against the Cloudflare hostname.
8. Recovery: `cloudflared tunnel info rune-mcp`; restart via
   `sudo launchctl kickstart -k system/com.cloudflare.cloudflared`; offline
   NOW via `sudo launchctl bootout system/com.cloudflare.cloudflared`.
