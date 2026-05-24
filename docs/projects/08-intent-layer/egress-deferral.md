# Egress Enforcement — Deferral ADR

**Status:** Deferred. Audit-only today; promote to enforced when the trigger fires.
**Decided:** 2026-05-23, alongside Phase 6 A1.3.
**Owner:** Phase 6 A1, intent-layer track A.

## Context

Phase 6 task A1.3 reads:

> Egress enforcement — implement the per-run proxy that consults `isEgressAllowed`
> against each product's allowlist in `policies/products.json`, **or — if deferred —
> document the gap explicitly**. Policy is decided (narrow starter, expanded per
> stack as runs surface deny errors); only the enforcement mechanism choice remains.

The policy half is shipped:

- `src/intent/sandbox.ts:isEgressAllowed` — exact-match + case-fold + trailing-dot
  tolerant; pinned by `src/intent/sandbox.test.ts`.
- `policies/products.json` — per-product `egressAllowlist` arrays. Starter list is
  GitHub + the npm registry; stack-specific hosts added per product as runs surface
  deny errors.
- `src/jobs/egress-policy.ts` — runtime wrapper (`checkEgress`) + audit log writer
  (`appendEgressDenialLog`) + an explicit `EGRESS_ENFORCEMENT_MODE` constant.

What is **not** shipped: the per-run network-level enforcer that takes an outbound
HTTPS connection and either lets it through or breaks it. `checkEgress` today
returns `{ allowed: false, mode: 'documented-gap' }` on a non-allowlisted host but
does not actually block the socket — it logs the attempt and leaves the call site
to act on the boolean.

## Decision

**Defer the enforcement mechanism.** Ship the audit hook now; build the proxy when
a trigger fires.

## Rationale

1. **No caller today.** The natural caller is the gen-eval-loop runner (Phase 6
   A3), which spawns `/work --auto` and `/review` against a sandboxed worktree.
   A3 is not yet implemented. Building enforcement before a caller is YAGNI.

2. **Real safety nets are already in place.** The deferred-enforcement window is
   not unguarded:
   - **Worktree isolation** (A1.1): a run writes only inside its own
     `<WORKTREE_ROOT>/<product>/<project>` tree.
   - **Credential scoping** (A1.2): the spawn env contains only the run's own
     product's credentials plus a small `process.env` allowlist
     (`PATH HOME USER LANG LC_ALL TERM SHELL TMPDIR`). Jarvis's own secrets
     (TELEGRAM_BOT_TOKEN, READWISE_TOKEN, …) never reach the child.
   - **No Jarvis credentials → no exfiltration path that matters most.** A run
     cannot leak Jarvis secrets because it cannot read them. The remaining
     concern is leaking the product's own repo state, which would happen via the
     credentials a run is allowed to use anyway. Note specifically that the
     starter allowlist (`github.com` + the npm registry) covers **write**
     endpoints too, not just reads: a misbehaving run holding the product's
     GitHub credentials could push to a fork or publish a package within the
     deferred window. The proxy doesn't close that gap on its own — the gap
     closes when scoped per-repo tokens are issued (a separate hardening track)
     — but the proxy combined with a tightened allowlist (no `github.com` for
     a product that doesn't need it) shrinks it.
   - **OpenAI dashboard cap** (user-side prereq, deferred): caps cross-model
     autonomous-run spend at the provider level.

3. **The enforcement mechanism is non-trivial.** A working per-run proxy needs:
   a Node HTTP/HTTPS server with CONNECT-tunneling support, per-run port
   allocation, `HTTP_PROXY` / `HTTPS_PROXY` env injection at spawn time, lifecycle
   hooks (start before child, stop after), and TLS-cert handling for the CONNECT
   path. Doing this before we see what hosts Claude CLI and Codex actually need
   in autonomous runs risks building the wrong shape.

4. **The eventual proxy reuses what's already shipped.** When the trigger fires,
   the proxy can call `checkEgress(sandbox, host, opts)` directly — the policy,
   the allowlist source, and the audit log are already wired. The proxy adds the
   "actually block the socket" half on top.

## Trigger to promote to `proxy-enforced`

Either of:

- **`logs/egress-denials.jsonl` shows real denials.** A non-empty file means a run
  tried to reach a host the operator didn't allowlist. That's the signal the gap
  matters in practice — investigate (legitimate host? add it to products.json),
  then build the proxy to convert "log the attempt" into "break the connection."
- **A3 (gen-eval-loop runner) is wired and producing real autonomous runs.** Even
  without observed denials, an end-to-end autonomous merge path means the
  consequences of an exfiltration bug change — the runner is auto-merging code
  into a product repo's main line. Promote at that point as a defense-in-depth
  step.

## Enforcement mechanism (when the trigger fires)

The intended design:

- **A Node HTTP/HTTPS proxy** started per sandboxed run, listening on a
  loopback-bound ephemeral port. Implements `CONNECT` for HTTPS tunneling and
  plain HTTP for `http://` URLs.
- **Per-product allowlist consulted via `checkEgress`** before either CONNECT
  acceptance or HTTP request forwarding. Denied connections close the client
  socket with an explicit error message.
- **Spawn-time env injection** via `buildSandboxEnv`'s extensibility: the proxy
  exports `HTTP_PROXY` and `HTTPS_PROXY` env vars the child inherits. The
  `DEFAULT_BASE_ENV_KEYS` allowlist already excludes those keys, so a
  spawn-time merge adds them deliberately.
- **Lifecycle.** The proxy starts before the child is spawned and stops after the
  child exits (or is killed). The future gen-eval-loop runner's mutation applier
  is the natural place to own this.
- **Flip the constant.** `EGRESS_ENFORCEMENT_MODE` flips from `'documented-gap'`
  to `'proxy-enforced'` in the same commit. Every grep of that name surfaces the
  call sites that should be re-examined.

## Out of scope (here)

- **System-level enforcement (pf, iptables, Docker network policy).** Pf requires
  root config changes; Docker isn't part of the v1 wedge. The userspace proxy
  approach above is enforceable per-run without touching system config.
- **DNS-level blocking.** DNS resolution happens before any code in this module
  runs; blocking at DNS would require a system resolver change.
- **The pragmatic "bypass the proxy" gap.** A determined child could open a raw
  socket and ignore HTTP_PROXY/HTTPS_PROXY. The proxy is a guard against
  accidental exfiltration via standard HTTP libraries, not a sandbox against
  hostile code. The trust model for Regime B already assumes the executor
  (Claude CLI / Codex) is non-hostile.

## Related

- Spec: `docs/projects/08-intent-layer/spec.md` §"Layer 4: Sandboxing and security"
- Tests: `src/jobs/egress-policy.test.ts`, `src/intent/sandbox.test.ts`
- Sibling tasks: A1.1 (worktree lifecycle, shipped), A1.2 (credential scoping,
  shipped), A1.4 (fs write guard wiring, next).
