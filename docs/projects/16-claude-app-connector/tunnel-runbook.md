# Cloudflare Tunnel runbook — exposing `/mcp` for the Claude App connector

Project 16 Phase 2, task **remote-tunnel-exposure**. The tunnel is the ONLY
public surface: it forwards exactly the MCP + OAuth paths to the daemon on
`127.0.0.1:3847`, TLS terminates at the Cloudflare edge, and no inbound port
is ever opened on the host.

> Status: this runbook + config are the docs/config deliverable. The live
> standing-up (Cloudflare account, `cloudflared tunnel login`, DNS route) is
> operator-interactive and is tracked by the parked work-run that produced
> this document.

## What gets exposed (and what never does)

Forwarded to `127.0.0.1:3847`:

| Path | Why |
| --- | --- |
| `/mcp` | The Streamable HTTP MCP endpoint (bearer-gated per request) |
| `/mcp/oauth/*` | DCR + consent form + token endpoint |
| `/.well-known/oauth-authorization-server*` | RFC 8414 AS metadata (root + `/mcp` path-aware variant) |
| `/.well-known/oauth-protected-resource*` | RFC 9728 resource metadata (the 401 challenge points here) |

Everything else — `/health`, `/capture-sessions`, `/oauth/whoop`, the entire
webview (`/`, `/api/*`, the WebSocket) — is **not** in the ingress rules and
returns the tunnel's 404. The webview stays localhost-only.

## One-time setup (operator, interactive)

1. Install: `brew install cloudflared`
2. Authenticate against the Cloudflare account that owns the zone:
   `cloudflared tunnel login` (opens a browser; writes `~/.cloudflared/cert.pem`)
3. Create the named tunnel:
   `cloudflared tunnel create jarvis-mcp`
   → prints a tunnel UUID and writes the credentials file
   `~/.cloudflared/<TUNNEL_UUID>.json`
4. Route DNS (pick a stable hostname on the zone, e.g. `jarvis-mcp.<your-domain>`):
   `cloudflared tunnel route dns jarvis-mcp jarvis-mcp.<your-domain>`
5. Write the config below to `~/.cloudflared/config.yml`
6. Update Jarvis env (`.env.local`) and restart the daemon:
   - `MCP_ISSUER_URL=https://jarvis-mcp.<your-domain>` — pins the OAuth
     issuer so the metadata never trusts the caller-controlled Host header.
   - `JARVIS_ALLOWED_HOSTS=localhost,127.0.0.1,jarvis-mcp.<your-domain>` —
     the /mcp host-allowlist gate must accept the public hostname or every
     tunneled request 403s.
   - `JARVIS_HTTP_SECRET` must be set (the /mcp surface is not mounted
     without it; it is also the consent-form approval secret).
7. Run as a service so it survives reboots:
   `sudo cloudflared service install` (loads a LaunchDaemon on macOS), or
   run ad hoc with `cloudflared tunnel run jarvis-mcp` while testing.

## `~/.cloudflared/config.yml`

```yaml
tunnel: jarvis-mcp
credentials-file: /Users/<user>/.cloudflared/<TUNNEL_UUID>.json

ingress:
  # MCP endpoint + OAuth sub-paths (DCR, consent, token)
  - hostname: jarvis-mcp.<your-domain>
    path: ^/mcp(/.*)?$
    service: http://127.0.0.1:3847
  # OAuth discovery metadata (RFC 8414 + RFC 9728, root and /mcp variants)
  - hostname: jarvis-mcp.<your-domain>
    path: ^/\.well-known/oauth-(authorization-server|protected-resource)(/.*)?$
    service: http://127.0.0.1:3847
  # Everything else on the hostname is refused at the edge.
  - service: http_status:404
```

Notes:
- `path` rules are regexes anchored per Cloudflare ingress semantics; the
  two rules above are the complete public surface.
- The catch-all `http_status:404` rule is REQUIRED by cloudflared (last rule
  must be hostname-less) and is what keeps the webview unreachable.
- TLS: edge-terminated by Cloudflare; the hop to `127.0.0.1:3847` is plain
  HTTP on the loopback interface only.

## Secret handling

- `~/.cloudflared/cert.pem` and `~/.cloudflared/<TUNNEL_UUID>.json` are the
  tunnel credentials. They live OUTSIDE every repo, are never committed, and
  should be backed up like any other machine credential. Rotating them =
  `cloudflared tunnel delete jarvis-mcp` + re-create (new UUID, update
  config.yml).
- `JARVIS_HTTP_SECRET` stays in `.env.local` (gitignored). It is typed by
  the human into the consent form over the HTTPS tunnel — it never appears
  in a URL, and the OAuth module never echoes it into a redirect.
- Access tokens are in-memory only; a daemon restart revokes everything and
  the App silently re-runs the OAuth handshake.

## Verifying the exposure (after standing up)

```bash
# 1. Metadata is reachable over the tunnel:
curl -s https://jarvis-mcp.<your-domain>/.well-known/oauth-authorization-server | jq .issuer
#    → "https://jarvis-mcp.<your-domain>"   (proves MCP_ISSUER_URL is pinned)

# 2. /mcp without a token is refused BEFORE the transport:
curl -s -o /dev/null -w '%{http_code}' -X POST https://jarvis-mcp.<your-domain>/mcp
#    → 401

# 3. The webview is NOT exposed:
curl -s -o /dev/null -w '%{http_code}' https://jarvis-mcp.<your-domain>/api/state
#    → 404 (edge rule, request never reaches the daemon)
curl -s -o /dev/null -w '%{http_code}' https://jarvis-mcp.<your-domain>/health
#    → 404
```

## Recovery runbook

| Symptom | Action |
| --- | --- |
| App connector reports unreachable | `cloudflared tunnel info jarvis-mcp`; if no connections, restart the service (`sudo launchctl kickstart -k system/com.cloudflare.cloudflared`). Never open an inbound host port as a fallback. |
| 403 on every tunneled request | The public hostname is missing from `JARVIS_ALLOWED_HOSTS` — fix env, restart Jarvis. |
| 401 loop in the App after a Jarvis restart | Expected: tokens are in-memory. The App re-runs the OAuth handshake; approve via the consent form. |
| Issuer in metadata shows the wrong host | `MCP_ISSUER_URL` unset or stale — fix env, restart Jarvis. |
| Suspected credential compromise | Delete the tunnel (`cloudflared tunnel delete`), rotate `JARVIS_HTTP_SECRET`, restart Jarvis (revokes all tokens), re-create the tunnel under a new hostname if needed. |
| Take the surface offline NOW | `sudo launchctl bootout system/com.cloudflare.cloudflared` (or kill cloudflared). The daemon keeps running locally; nothing else exposes it. |
