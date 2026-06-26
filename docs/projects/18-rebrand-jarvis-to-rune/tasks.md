# Rebrand Jarvis to Rune — Tasks

Not started. See [spec.md](spec.md) for architecture and [test-plan.md](test-plan.md) for verification.

> **Test-first by default.** Phases with code-test tasks open with a **Tests (write first)**
> block; those tests mirror the matching [test-plan.md](test-plan.md) sections and must fail
> (red) before implementation begins. Docs-or-config-only tasks record a reviewed no-code-test
> rationale instead. A phase's implementation is done when its test-plan sections pass.

## Phase 0 — Inventory

> Depends on: nothing.

### Tests (write first)

- [x] No code-test-required tasks — `jarvis-inventory-and-allowlist` is `docs-or-config-only`;
      record and review the no-code-test rationale (test-plan.md §1).

### Implementation

- [x] **jarvis-inventory-and-allowlist** — Produce an authoritative case-insensitive inventory
      of every `jarvis` occurrence across the repo and classify each into: brand
      text/prose/prompt to rewrite, public identifier to rename (package metadata, committed
      repo URLs/badges, CI/workflow references, MCP/server names such as `jarvis-kb`,
      command/slug names, runtime-visible names), private functional identifier kept as-is with
      written rationale (e.g. `com.jarvis.daemon`), or excluded agent-definition filename.
      Output the explicit final allowlist acceptance greps against; if committed, sanitize so it
      does not itself trip the final grep gates.

## Phase 1 — Path De-Leak

> Depends on: Phase 0.

### Tests (write first)

- [x] Write the test suite for **env-var-path-extraction** — test-plan.md §2. Prove that unset
      `RUNE_*` defaults resolve to working computed paths and that overrides win.
- [x] Confirm the suite fails (red) before implementation begins.

### Implementation

- [x] **env-var-path-extraction** — Extract remaining hardcoded
      `/Users/jarvis/workspace/jarvis/...` references into `RUNE_*` env vars following the
      existing `process.env.<VAR> || <computedDefault>` style. In the same pass, rename
      `JARVIS_LOGS_DIR` to `RUNE_LOGS_DIR`, update `logger.ts` and every consumer, and convert
      the known holdouts in `scripts/hooks/block-nonresponse.cjs` and
      `src/server/static/product-deep-view-client.test.ts`. Defaults must preserve current
      behavior without committing literal `/Users/jarvis`, `workspace/jarvis`, or stale
      `JARVIS_*` names; compute defaults from repo/root helpers.

## Phase 2 — Brand Sweep

> Depends on: Phase 0.

### Tests (write first)

- [x] No code-test-required tasks — both brand-sweep tasks are `docs-or-config-only`; record and
      review the no-code-test rationale (test-plan.md §3).

### Implementation

- [x] **brand-sweep-docs-metadata** — Per the Phase 0 inventory, replace agent-name "Jarvis"
      with "Rune" across docs, README, every CLAUDE.md file, public package metadata,
      lockfile/package-manager metadata where applicable, CI/workflow files, committed
      `github.com/.../jarvis` URLs, badges, and repository descriptions. Preserve casing and
      voice; use `@runeai` only where the public handle is the right reference. Do not touch the
      macOS username, the `com.jarvis.daemon` label, private env-var values, agent-definition
      file contents, or runtime identifiers owned by other tasks.
- [x] **brand-sweep-agent-defs** — Replace agent-name "Jarvis" with "Rune" in prose and prompts
      inside agent-definition files (`.claude/agents/*.md`, `.agents/`, `agents/`,
      `.codex/agents/`, and `src/intent/agent-def.ts`). Change only brand text in prose or
      prompt bodies; do not rename files and do not alter prompt logic, role behavior, tool
      contracts, or personal-specific content beyond the brand name.

## Phase 3 — Runtime Rename

> Depends on: Phase 0.

### Tests (write first)

- [x] Write the test suite for **runtime-identifier-and-string-rename** — test-plan.md §4. Cover
      command routing, MCP/server metadata, config resolution, and representative user-facing
      output affected by the rename.
- [x] Confirm the suite fails (red) before implementation begins.

### Implementation

- [x] **runtime-identifier-and-string-rename** — Per the Phase 0 inventory, rename public
      runtime identifiers and user-visible strings that carry the old name, including MCP/server
      names such as `jarvis-kb`, command/slug names, generated messages, HTTP/MCP metadata
      names, and code-owned public labels. Update all references in one pass with no
      compatibility alias unless explicitly approved by the spec.

## Phase 4 — Exhaustive Per-Instance Rename

> Depends on: Phases 0–3. This phase supersedes the prematurely-checked Phase 3
> runtime rename by tracking every remaining `jarvis` token as its own task, so no
> instance can be silently skipped. Each task renames one occurrence to `rune`
> (preserving casing: `Jarvis`→`Rune`, `JARVIS`→`RUNE`).
>
> **Excluded (must NOT rename):** the macOS username in `/Users/jarvis/…`, and the
> launchd label `com.jarvis.daemon` (kept per spec). The rebrand project's own docs
> under `docs/projects/18-rebrand-jarvis-to-rune/` are excluded as self-referential.
> `workspace/jarvis` path references ARE in scope (they become `workspace/rune`).

> Generated: 1427 tasks across 312 files.

### `.agents/skills/work/SKILL.md`

- [x] `.agents/skills/work/SKILL.md:263` — rename `Jarvis`→rune: `- Any file under '.codex/agents/', '.claude/agents/' (Jarvis), or '$VAULT_DIR/.claude/agen…`

### `.claude/agents/intent-scan.md`

- [x] `.claude/agents/intent-scan.md:18` — rename `JARVIS`→rune: `cd "$JARVIS_PROJECT_ROOT" && npm run intent-scan`
- [x] `.claude/agents/intent-scan.md:21` — rename `JARVIS`→rune: `The 'JARVIS_PROJECT_ROOT' env var is set by the Claude CLI spawner in`

### `.claude/agents/lenny-sync.md`

- [x] `.claude/agents/lenny-sync.md:14` — rename `JARVIS`→rune: `You may only write to 'library/lenny/posts/', 'library/lenny/podcasts/', and '$JARVIS_PROJ…`
- [x] `.claude/agents/lenny-sync.md:18` — rename `JARVIS`→rune: `Location: '$JARVIS_PROJECT_ROOT/logs/lenny-sync-state.json'`
- [x] `.claude/agents/lenny-sync.md:75` — rename `JARVIS`→rune: `1. Write '{"last_sync_at": "<today>"}' to '$JARVIS_PROJECT_ROOT/logs/lenny-sync-state.json…`
- [x] `.claude/agents/lenny-sync.md:116` — rename `JARVIS`→rune: `6. After all writes succeed, update state: '{"last_sync_at": "<today>"}' to '$JARVIS_PROJE…`

### `.claude/agents/security-auditor.md`

- [x] `.claude/agents/security-auditor.md:47` — rename `JARVIS`→rune: `- HTTP endpoints validate 'JARVIS_HTTP_SECRET' before processing`

### `.claude/skills/work/SKILL.md`

- [x] `.claude/skills/work/SKILL.md:31` — rename `Jarvis`→rune: `When running under '--auto', you have no human at the keyboard. If you reach a step you ge…`
- [x] `.claude/skills/work/SKILL.md:36` — rename `JARVIS`→rune: `JARVIS_WORK_RUN_SENTINEL { "version": 1, "pendingCheck": "<what a human must do>", "comman…`
- [x] `.claude/skills/work/SKILL.md:40` — rename `JARVIS`→rune: `- It MUST be the **last line** of your final result, on its own line, opening with the exa…`
- [x] `.claude/skills/work/SKILL.md:274` — rename `Jarvis`→rune: `- Any file under '.claude/agents/' (Jarvis) or '$VAULT_DIR/.claude/agents/' (vault-residen…`

### `.codex/agents/architecture-reviewer.toml`

- [x] `.codex/agents/architecture-reviewer.toml:3` — rename `Jarvis`→rune: `You are the architecture reviewer for Jarvis, a single-process TypeScript/Node.js server t…`
- [x] `.codex/agents/architecture-reviewer.toml:7` — rename `Jarvis`→rune: `Jarvis is a single Node.js process with these subsystems:`

### `.codex/agents/code-reviewer.toml`

- [x] `.codex/agents/code-reviewer.toml:1` — rename `Jarvis`→rune: `description = "Reviews code changes for bugs, security issues, TypeScript strict-mode viol…`
- [x] `.codex/agents/code-reviewer.toml:3` — rename `Jarvis`→rune: `You are the code reviewer for Jarvis, a TypeScript/Node.js server. You review changes for …`

### `.codex/agents/code-simplifier.toml`

- [x] `.codex/agents/code-simplifier.toml:3` — rename `Jarvis`→rune: `You are the code simplifier for Jarvis, a TypeScript/Node.js server. After a feature is im…`
- [x] `.codex/agents/code-simplifier.toml:7` — rename `Jarvis`→rune: `Jarvis intentionally follows a minimal approach:`

### `.codex/agents/daily-content-updater.toml`

- [x] `.codex/agents/daily-content-updater.toml:3` — rename `Jarvis`→rune: `You are the daily content updater agent for Jarvis. You receive proposed updates drawn fro…`

### `.codex/agents/docs-sync.toml`

- [x] `.codex/agents/docs-sync.toml:3` — rename `Jarvis`→rune: `You are the docs-sync agent for Jarvis. After feature implementation, you update 'AGENTS.m…`
- [x] `.codex/agents/docs-sync.toml:5` — rename `Jarvis`→rune: `**Write scope:** You write exclusively to the Jarvis workspace — 'AGENTS.md', files under …`

### `.codex/agents/intent-scan.toml`

- [x] `.codex/agents/intent-scan.toml:11` — rename `JARVIS`→rune: `cd "$JARVIS_PROJECT_ROOT" && npm run intent-scan`
- [x] `.codex/agents/intent-scan.toml:14` — rename `JARVIS`→rune: `The 'JARVIS_PROJECT_ROOT' env var is set by the Codex CLI spawner in`

### `.codex/agents/json-updater.toml`

- [x] `.codex/agents/json-updater.toml:3` — rename `Jarvis`→rune: `You are the JSON data updater agent for Jarvis. You receive proposed updates to JSON data …`

### `.codex/agents/lenny-sync.toml`

- [x] `.codex/agents/lenny-sync.toml:7` — rename `JARVIS`→rune: `You may only write to 'library/lenny/posts/', 'library/lenny/podcasts/', and '$JARVIS_PROJ…`
- [x] `.codex/agents/lenny-sync.toml:11` — rename `JARVIS`→rune: `Location: '$JARVIS_PROJECT_ROOT/logs/lenny-sync-state.json'`
- [x] `.codex/agents/lenny-sync.toml:68` — rename `JARVIS`→rune: `1. Write '{"last_sync_at": "<today>"}' to '$JARVIS_PROJECT_ROOT/logs/lenny-sync-state.json…`
- [x] `.codex/agents/lenny-sync.toml:109` — rename `JARVIS`→rune: `6. After all writes succeed, update state: '{"last_sync_at": "<today>"}' to '$JARVIS_PROJE…`

### `.codex/agents/morning-prep.toml`

- [x] `.codex/agents/morning-prep.toml:3` — rename `Jarvis`→rune: `You are the morning prep agent for Jarvis. You gather data from the user's Obsidian vault …`

### `.codex/agents/playbook-proposer.toml`

- [x] `.codex/agents/playbook-proposer.toml:3` — rename `Jarvis`→rune: `You are the playbook proposer for Jarvis. Extract '#playbook'-tagged passages from a journ…`

### `.codex/agents/playbook-updater.toml`

- [x] `.codex/agents/playbook-updater.toml:3` — rename `Jarvis`→rune: `You are the playbook updater for Jarvis. Append approved playbook drafts to 'pages/playboo…`

### `.codex/agents/project-setup-writer.toml`

- [x] `.codex/agents/project-setup-writer.toml:1` — rename `Jarvis`→rune: `description = "Creates spec.md, tasks.md, and test-plan.md for a new Jarvis project from a…`
- [x] `.codex/agents/project-setup-writer.toml:3` — rename `Jarvis`→rune: `You are a technical writer creating project documentation for the Jarvis project.`
- [x] `.codex/agents/project-setup-writer.toml:5` — rename `Jarvis`→rune: `**Write scope:** You write exclusively to the Jarvis workspace — '{PROJECT_ROOT}/docs/proj…`
- [x] `.codex/agents/project-setup-writer.toml:7` — rename `Jarvis`→rune: `You will receive an approved Project Brief and a path to the Jarvis project root. Your job…`

### `.codex/agents/project-updater.toml`

- [x] `.codex/agents/project-updater.toml:3` — rename `Jarvis`→rune: `You are the project updater for Jarvis. Apply approved updates from a review to project pa…`

### `.codex/agents/proposal-updater.toml`

- [x] `.codex/agents/proposal-updater.toml:3` — rename `Jarvis`→rune: `You are the proposal updater for Jarvis. You action user-approved Ask-Twice`
- [x] `.codex/agents/proposal-updater.toml:11` — rename `Jarvis`→rune: `- '.Codex/agents/*.md' — existing runtime agents (Jarvis-side only; do not`
- [x] `.codex/agents/proposal-updater.toml:40` — rename `Jarvis`→rune: `8. **All paths must be absolute, rooted at the Jarvis project root** passed`
- [x] `.codex/agents/proposal-updater.toml:98` — rename `Jarvis`→rune: `on the next Jarvis restart. Call this out in the output if cron was`

### `.codex/agents/psychology-updater.toml`

- [x] `.codex/agents/psychology-updater.toml:3` — rename `Jarvis`→rune: `You are the psychology updater for Jarvis. Apply surgical updates to 'pages/psychology.md'…`

### `.codex/agents/release-notes.toml`

- [x] `.codex/agents/release-notes.toml:3` — rename `Jarvis`→rune: `You are the release notes agent for Jarvis. You generate human-readable changelogs from gi…`

### `.codex/agents/security-auditor.toml`

- [x] `.codex/agents/security-auditor.toml:3` — rename `Jarvis`→rune: `You are the security auditor for Jarvis, a TypeScript/Node.js server that connects to Tele…`
- [x] `.codex/agents/security-auditor.toml:7` — rename `Jarvis`→rune: `Jarvis is a personal server with these sensitive assets:`
- [x] `.codex/agents/security-auditor.toml:38` — rename `JARVIS`→rune: `- HTTP endpoints validate 'JARVIS_HTTP_SECRET' before processing`

### `.codex/agents/session-summarizer.toml`

- [x] `.codex/agents/session-summarizer.toml:3` — rename `Jarvis`→rune: `You are the session summarizer for Jarvis. You produce structured summaries of Telegram co…`

### `.codex/agents/system-scanner.toml`

- [x] `.codex/agents/system-scanner.toml:3` — rename `Jarvis`→rune: `You are the system scanner for Jarvis. Load vault system files and return a current-state …`

### `.codex/agents/test-specialist.toml`

- [x] `.codex/agents/test-specialist.toml:3` — rename `Jarvis`→rune: `You are the test specialist for Jarvis, a TypeScript/Node.js server. You write and run tes…`
- [x] `.codex/agents/test-specialist.toml:7` — rename `Jarvis`→rune: `Jarvis is a single-process server (Telegram bot + HTTP server + cron scheduler + knowledge…`

### `.codex/agents/workout-generator.toml`

- [x] `.codex/agents/workout-generator.toml:3` — rename `Jarvis`→rune: `You are the workout generator for Jarvis. You are read-only. Your output goes to a parser,…`

### `.codex/agents/worldview-updater.toml`

- [x] `.codex/agents/worldview-updater.toml:3` — rename `Jarvis`→rune: `You are the worldview updater for Jarvis. Apply user-approved diffs to 'world-view/*.md' f…`

### `AGENTS.md`

- [x] `AGENTS.md:113` — rename `Jarvis`→rune: `│   ├── mcp-transport.ts     # /mcp Streamable HTTP route (project 16 Phase 2): mountMcpRo…`
- [x] `AGENTS.md:114` (instance #1) — rename `JARVIS`→rune: `│   ├── mcp-oauth.ts         # Single-user OAuth 2.1 for /mcp (project 16 Phase 2): create…`
- [x] `AGENTS.md:114` (instance #2) — rename `JARVIS`→rune: `│   ├── mcp-oauth.ts         # Single-user OAuth 2.1 for /mcp (project 16 Phase 2): create…`
- [x] `AGENTS.md:149` — rename `JARVIS`→rune: `│   ├── work-runner.ts       # workRunApplier: MutationApplier for 'work-run' kind; spawns…`
- [x] `AGENTS.md:154` — rename `jarvis`→rune: `│   ├── work-run-gc.ts        # Phase 3 implemented: retention GC — 'planGc' (pure: select…`
- [x] `AGENTS.md:157` — rename `JARVIS`→rune: `│   ├── work-run-sentinel.ts  # Project 13 Phase 1b — blocked-on-human sentinel contract: …`
- [x] `AGENTS.md:159` — rename `jarvis`→rune: `│   ├── gen-eval-loop-runner.ts # genEvalLoopApplier: MutationApplier for 'gen-eval-loop' …`
- [x] `AGENTS.md:160` — rename `jarvis`→rune: `│   ├── scaffold-approval.ts # Shared scaffold-approval runtime (09-expand-cockpit Phase 4…`
- [x] `AGENTS.md:215` — rename `jarvis`→rune: `│   ├── scaffold-target.ts    # Scaffold-target resolution (09-expand-cockpit Phase 4): re…`
- [x] `AGENTS.md:239` — rename `Jarvis`→rune: `│   ├── server.ts            # Shared MCP server factory (project 16): createJarvisMcpServ…`
- [x] `AGENTS.md:283` — rename `jarvis`→rune: `└── jarvis.ts                # CLI entry point for local interactive use`
- [x] `AGENTS.md:409` — rename `JARVIS`→rune: `- 'JARVIS_HTTP_SECRET' — shared secret for authenticated HTTP endpoints; also the human-ap…`
- [x] `AGENTS.md:410` — rename `jarvis`→rune: `- 'MCP_ISSUER_URL' — pinned issuer base URL for the /mcp OAuth metadata (the public tunnel…`
- [x] `AGENTS.md:413` — rename `JARVIS`→rune: `- 'WORKSPACE_DIR' — path to workspace root (e.g. '~/workspace'). When set, agents receive …`
- [x] `AGENTS.md:416` — rename `JARVIS`→rune: `- 'JARVIS_ALLOWED_HOSTS' — optional, defaults to 'localhost,127.0.0.1'; host-guard allowli…`
- [x] `AGENTS.md:489` — rename `jarvis`→rune: `**Config**: '.claude/settings.json' registers 'jarvis-kb' MCP server.`

### `CLAUDE.md`

- [x] `CLAUDE.md:113` — rename `Jarvis`→rune: `│   ├── mcp-transport.ts     # /mcp Streamable HTTP route (project 16 Phase 2): mountMcpRo…`
- [x] `CLAUDE.md:114` (instance #1) — rename `JARVIS`→rune: `│   ├── mcp-oauth.ts         # Single-user OAuth 2.1 for /mcp (project 16 Phase 2): create…`
- [x] `CLAUDE.md:114` (instance #2) — rename `JARVIS`→rune: `│   ├── mcp-oauth.ts         # Single-user OAuth 2.1 for /mcp (project 16 Phase 2): create…`
- [x] `CLAUDE.md:149` — rename `JARVIS`→rune: `│   ├── work-runner.ts       # workRunApplier: MutationApplier for 'work-run' kind; spawns…`
- [x] `CLAUDE.md:154` — rename `jarvis`→rune: `│   ├── work-run-gc.ts        # Phase 3 implemented: retention GC — 'planGc' (pure: select…`
- [x] `CLAUDE.md:157` — rename `JARVIS`→rune: `│   ├── work-run-sentinel.ts  # Project 13 Phase 1b — blocked-on-human sentinel contract: …`
- [x] `CLAUDE.md:159` — rename `jarvis`→rune: `│   ├── gen-eval-loop-runner.ts # genEvalLoopApplier: MutationApplier for 'gen-eval-loop' …`
- [x] `CLAUDE.md:160` — rename `jarvis`→rune: `│   ├── scaffold-approval.ts # Shared scaffold-approval runtime (09-expand-cockpit Phase 4…`
- [x] `CLAUDE.md:215` — rename `jarvis`→rune: `│   ├── scaffold-target.ts    # Scaffold-target resolution (09-expand-cockpit Phase 4): re…`
- [x] `CLAUDE.md:239` — rename `Jarvis`→rune: `│   ├── server.ts            # Shared MCP server factory (project 16): createJarvisMcpServ…`
- [x] `CLAUDE.md:283` — rename `jarvis`→rune: `└── jarvis.ts                # CLI entry point for local interactive use`
- [x] `CLAUDE.md:409` — rename `JARVIS`→rune: `- 'JARVIS_HTTP_SECRET' — shared secret for authenticated HTTP endpoints; also the human-ap…`
- [x] `CLAUDE.md:410` — rename `jarvis`→rune: `- 'MCP_ISSUER_URL' — pinned issuer base URL for the /mcp OAuth metadata (the public tunnel…`
- [x] `CLAUDE.md:413` — rename `JARVIS`→rune: `- 'WORKSPACE_DIR' — path to workspace root (e.g. '~/workspace'). When set, agents receive …`
- [x] `CLAUDE.md:416` — rename `JARVIS`→rune: `- 'JARVIS_ALLOWED_HOSTS' — optional, defaults to 'localhost,127.0.0.1'; host-guard allowli…`
- [x] `CLAUDE.md:489` — rename `jarvis`→rune: `**Config**: '.claude/settings.json' registers 'jarvis-kb' MCP server.`

### `README.md`

- [x] `README.md:42` — rename `jarvis`→rune: `│  │   MCP: jarvis-kb  │  │ Obsidian Vault (iCloud)│    │`
- [x] `README.md:54` — rename `jarvis`→rune: `- **Knowledge base** — two-layer search (LLM reads compact index → ripgrep full-text), no …`
- [x] `README.md:132` — rename `jarvis`→rune: `**MCP server.** The KB is also exposed as an MCP server ('jarvis-kb') so any Claude Code s…`
- [x] `README.md:244` — rename `JARVIS`→rune: `JARVIS_HTTP_SECRET=...                   # required to enable webview auth`
- [x] `README.md:246` — rename `JARVIS`→rune: `JARVIS_ALLOWED_HOSTS=localhost,127.0.0.1 # host-guard allowlist for webview endpoints`
- [x] `README.md:276` (instance #1) — rename `jarvis`→rune: `The server starts the Telegram bot (polling), HTTP server on port 3847, the MCP server ('j…`
- [x] `README.md:276` (instance #2) — rename `JARVIS`→rune: `The server starts the Telegram bot (polling), HTTP server on port 3847, the MCP server ('j…`
- [x] `README.md:398` (instance #1) — rename `JARVIS`→rune: `'http://localhost:3847/' hosts a vanilla HTML/JS chat UI that mirrors the TG dispatcher in…`
- [x] `README.md:398` (instance #2) — rename `JARVIS`→rune: `'http://localhost:3847/' hosts a vanilla HTML/JS chat UI that mirrors the TG dispatcher in…`
- [x] `README.md:402` — rename `jarvis`→rune: `The KB is exposed as an MCP server ('jarvis-kb') registered in '.claude/settings.json', so…`

### `cli/jarvis.test.ts`

- [x] `cli/jarvis.test.ts:73` — rename `jarvis`→rune: `process.argv = ['node', 'jarvis', ...args];`
- [x] `cli/jarvis.test.ts:99` — rename `jarvis`→rune: `await import('./jarvis.js');`
- [x] `cli/jarvis.test.ts:104` — rename `jarvis`→rune: `describe('cli/jarvis', () => {`
- [x] `cli/jarvis.test.ts:110` — rename `Jarvis`→rune: `'Jarvis CLI — Knowledge base operations from the terminal\n',`
- [x] `cli/jarvis.test.ts:112` — rename `jarvis`→rune: `expect(logSpy).toHaveBeenCalledWith('Usage: jarvis <command> [args]\n');`
- [x] `cli/jarvis.test.ts:121` — rename `Jarvis`→rune: `'Jarvis CLI — Knowledge base operations from the terminal\n',`
- [x] `cli/jarvis.test.ts:130` — rename `Jarvis`→rune: `'Jarvis CLI — Knowledge base operations from the terminal\n',`
- [x] `cli/jarvis.test.ts:141` — rename `Jarvis`→rune: `'Jarvis CLI — Knowledge base operations from the terminal\n',`
- [x] `cli/jarvis.test.ts:173` — rename `jarvis`→rune: `expect(errorSpy).toHaveBeenCalledWith('Usage: jarvis query <question>');`
- [x] `cli/jarvis.test.ts:202` — rename `jarvis`→rune: `'Ingestion queue is empty. Usage: jarvis ingest <vault-relative-path> [--guidance "..."]',`
- [x] `cli/jarvis.test.ts:302` — rename `jarvis`→rune: `'Usage: jarvis search <term> [--type entity|concept|topic|comparison]',`
- [x] `cli/jarvis.test.ts:443` (instance #1) — rename `jarvis`→rune: `''jarvis study' needs an interactive terminal — use 'jarvis study status' for a non-intera…`
- [x] `cli/jarvis.test.ts:443` (instance #2) — rename `jarvis`→rune: `''jarvis study' needs an interactive terminal — use 'jarvis study status' for a non-intera…`

### `cli/jarvis.ts`

- [x] `cli/jarvis.ts:19` — rename `Jarvis`→rune: `console.log('Jarvis CLI — Knowledge base operations from the terminal\n');`
- [x] `cli/jarvis.ts:20` — rename `jarvis`→rune: `console.log('Usage: jarvis <command> [args]\n');`
- [x] `cli/jarvis.ts:107` — rename `jarvis`→rune: `console.error('Usage: jarvis query <question>');`
- [x] `cli/jarvis.ts:135` — rename `jarvis`→rune: `console.log('Ingestion queue is empty. Usage: jarvis ingest <vault-relative-path> [--guida…`
- [x] `cli/jarvis.ts:217` — rename `jarvis`→rune: `console.error('Usage: jarvis search <term> [--type entity|concept|topic|comparison]');`
- [x] `cli/jarvis.ts:266` (instance #1) — rename `jarvis`→rune: `''jarvis study' needs an interactive terminal — use 'jarvis study status' for a non-intera…`
- [x] `cli/jarvis.ts:266` (instance #2) — rename `jarvis`→rune: `''jarvis study' needs an interactive terminal — use 'jarvis study status' for a non-intera…`

### `docs/projects/01-mvp/spec.md`

- [x] `docs/projects/01-mvp/spec.md:238` — rename `jarvis`→rune: `**Rune agents** (in 'jarvis/.claude/agents/'):`
- [x] `docs/projects/01-mvp/spec.md:405` — rename `jarvis`→rune: `- [ ] Local CLI entry point (cli/jarvis.ts)`

### `docs/projects/01-mvp/tasks.md`

- [x] `docs/projects/01-mvp/tasks.md:130` — rename `jarvis`→rune: `- [x] CLI entry point (cli/jarvis.ts)`

### `docs/projects/01-mvp/test-plan.md`

- [x] `docs/projects/01-mvp/test-plan.md:66` — rename `JARVIS`→rune: `- [ ] 🟢 When 'JARVIS_HTTP_SECRET' is set, unauthenticated POST returns 401`

### `docs/projects/04-custom-workouts/spec.md`

- [x] `docs/projects/04-custom-workouts/spec.md:104` — rename `jarvis`→rune: `- **CLI**: 'npm run cli -- workout [home|gym] [focus]' and 'npm run cli -- done-workout' v…`
- [x] `docs/projects/04-custom-workouts/spec.md:234` — rename `jarvis`→rune: `- 'cli/jarvis.ts' — wire 'workout' and 'done-workout' CLI subcommands; reuse the same unde…`
- [x] `docs/projects/04-custom-workouts/spec.md:282` — rename `jarvis`→rune: `- [ ] Wire both commands into 'cli/jarvis.ts'`

### `docs/projects/04-custom-workouts/tasks.md`

- [x] `docs/projects/04-custom-workouts/tasks.md:79` — rename `jarvis`→rune: `- [x] Wire 'workout' subcommand in 'cli/jarvis.ts': 'npm run cli -- workout [home|gym] [fo…`
- [x] `docs/projects/04-custom-workouts/tasks.md:80` — rename `jarvis`→rune: `- [x] Wire 'done-workout' subcommand in 'cli/jarvis.ts': 'npm run cli -- done-workout' inv…`

### `docs/projects/05-library-into-kb/spec.md`

- [x] `docs/projects/05-library-into-kb/spec.md:31` — rename `jarvis`→rune: `- **Re-exposing the Lenny MCP via 'jarvis-kb'.** The MCP is consumed by Rune only (used by…`
- [x] `docs/projects/05-library-into-kb/spec.md:161` — rename `jarvis`→rune: `| Lenny MCP exposure scope | **Rune only** (consumed by 'lenny-sync'). Not re-exposed via …`

### `docs/projects/06-webview/spec.md`

- [x] `docs/projects/06-webview/spec.md:29` — rename `JARVIS`→rune: `- **Multi-user support.** Rune is single-user. Auth is one shared bearer token ('JARVIS_HT…`
- [x] `docs/projects/06-webview/spec.md:46` — rename `JARVIS`→rune: `- **No new env vars beyond 'JARVIS_HTTP_SECRET'** (already exists). One new optional confi…`
- [x] `docs/projects/06-webview/spec.md:202` (instance #1) — rename `JARVIS`→rune: `- **Browser**: 'http://127.0.0.1:3847/'. Auth handled on first load via 'JARVIS_HTTP_SECRE…`
- [x] `docs/projects/06-webview/spec.md:202` (instance #2) — rename `jarvis`→rune: `- **Browser**: 'http://127.0.0.1:3847/'. Auth handled on first load via 'JARVIS_HTTP_SECRE…`
- [x] `docs/projects/06-webview/spec.md:223` (instance #1) — rename `JARVIS`→rune: `| Auth | Shared bearer ('JARVIS_HTTP_SECRET'). On first load, client supplies it as '?toke…`
- [x] `docs/projects/06-webview/spec.md:223` (instance #2) — rename `jarvis`→rune: `| Auth | Shared bearer ('JARVIS_HTTP_SECRET'). On first load, client supplies it as '?toke…`
- [x] `docs/projects/06-webview/spec.md:256` (instance #1) — rename `jarvis`→rune: `13. WHEN any '/api/*' endpoint or WS upgrade receives a request without a valid 'jarvis-au…`
- [x] `docs/projects/06-webview/spec.md:256` (instance #2) — rename `JARVIS`→rune: `13. WHEN any '/api/*' endpoint or WS upgrade receives a request without a valid 'jarvis-au…`
- [x] `docs/projects/06-webview/spec.md:257` — rename `JARVIS`→rune: `14. WHEN any new endpoint receives a request whose 'Host' header (port stripped) is not in…`
- [x] `docs/projects/06-webview/spec.md:330` — rename `jarvis`→rune: `63. WHEN the auth-bootstrap handler sets the 'jarvis-auth' cookie THEN it sets 'Secure' if…`
- [x] `docs/projects/06-webview/spec.md:331` — rename `JARVIS`→rune: `64. WHEN 'JARVIS_ALLOWED_HOSTS' is parsed at startup THEN the value is split on commas, ea…`
- [x] `docs/projects/06-webview/spec.md:359` — rename `JARVIS`→rune: `JARVIS_ALLOWED_HOSTS=localhost,127.0.0.1,mac-mini.tail-xxxx.ts.net`
- [x] `docs/projects/06-webview/spec.md:364` (instance #1) — rename `JARVIS`→rune: `**On the laptop:** install Tailscale, sign in to the same tailnet. First load: 'https://ma…`
- [x] `docs/projects/06-webview/spec.md:364` (instance #2) — rename `jarvis`→rune: `**On the laptop:** install Tailscale, sign in to the same tailnet. First load: 'https://ma…`
- [x] `docs/projects/06-webview/spec.md:369` — rename `JARVIS`→rune: `- Auth is still the single shared 'JARVIS_HTTP_SECRET'; the tailnet is the trust boundary,…`
- [x] `docs/projects/06-webview/spec.md:455` — rename `JARVIS`→rune: `- Manual smoke: 'npm run dev', browser to 'http://127.0.0.1:3847/?token=$JARVIS_HTTP_SECRE…`
- [x] `docs/projects/06-webview/spec.md:567` — rename `JARVIS`→rune: `- **Missing or wrong bearer token on first load**: page renders a minimal "auth required —…`
- [x] `docs/projects/06-webview/spec.md:568` — rename `JARVIS`→rune: `- **Cookie expired**: not applicable in v1 — cookie has no expiry and is invalidated only …`
- [x] `docs/projects/06-webview/spec.md:570` — rename `JARVIS`→rune: `- **Auth cookie present but 'JARVIS_HTTP_SECRET' rotated**: cookie validation fails on eve…`

### `docs/projects/06-webview/tasks.md`

- [x] `docs/projects/06-webview/tasks.md:41` (instance #1) — rename `jarvis`→rune: `- [x] Create 'src/server/auth.ts': 'verifyAuth(req): { ok: true; userId } | { ok: false }'…`
- [x] `docs/projects/06-webview/tasks.md:41` (instance #2) — rename `JARVIS`→rune: `- [x] Create 'src/server/auth.ts': 'verifyAuth(req): { ok: true; userId } | { ok: false }'…`
- [x] `docs/projects/06-webview/tasks.md:48` — rename `JARVIS`→rune: `- 401 on missing/invalid auth; 403 on Host header not in 'JARVIS_ALLOWED_HOSTS' (port stri…`
- [x] `docs/projects/06-webview/tasks.md:49` — rename `JARVIS`→rune: `- [x] Modify 'src/config.ts': add 'JARVIS_ALLOWED_HOSTS' env var. Parsed at startup (split…`
- [x] `docs/projects/06-webview/tasks.md:50` — rename `JARVIS`→rune: `- [x] Wire 'JARVIS_ALLOWED_HOSTS' into the Host-guard in 'src/server/webview.ts' (requirem…`
- [x] `docs/projects/06-webview/tasks.md:51` — rename `jarvis`→rune: `- [x] In the 'POST /api/auth-bootstrap' handler (cookie-set path): set 'Secure' on the 'ja…`
- [x] `docs/projects/06-webview/tasks.md:72` — rename `jarvis`→rune: `- [x] Add 'POST /api/auth-bootstrap' route: validates '?token=' body, sets 'jarvis-auth' c…`
- [x] `docs/projects/06-webview/tasks.md:75` — rename `JARVIS`→rune: `- [x] Manual smoke: 'npm run dev' → browser to 'http://127.0.0.1:3847/?token=$JARVIS_HTTP_…`
- [x] `docs/projects/06-webview/tasks.md:80` — rename `JARVIS`→rune: `- **Environment Variables** section: document 'OBSIDIAN_VAULT_NAME' and 'JARVIS_ALLOWED_HO…`
- [x] `docs/projects/06-webview/tasks.md:114` (instance #1) — rename `jarvis`→rune: `- [x] 'git clone' jarvis to '~/workspace/jarvis'`
- [x] `docs/projects/06-webview/tasks.md:114` (instance #2) — rename `jarvis`→rune: `- [x] 'git clone' jarvis to '~/workspace/jarvis'`
- [x] `docs/projects/06-webview/tasks.md:115` — rename `jarvis`→rune: `- [x] 'cd ~/workspace/jarvis && npm install'`
- [x] `docs/projects/06-webview/tasks.md:122` — rename `JARVIS`→rune: `- [x] Verify all required vars are present: 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_USER_ID', 'JAR…`
- [x] `docs/projects/06-webview/tasks.md:135` — rename `JARVIS`→rune: `- [x] Set 'JARVIS_ALLOWED_HOSTS' in '.env.local' to include the actual MagicDNS hostname`
- [x] `docs/projects/06-webview/tasks.md:136` — rename `JARVIS`→rune: `- [x] On the laptop: install Tailscale, sign in to the same tailnet, browse 'https://<host…`
- [x] `docs/projects/06-webview/tasks.md:142` (instance #1) — rename `jarvis`→rune: `- [x] Write '~/Library/LaunchAgents/com.jarvis.daemon.plist' running 'npm start' (or 'npm …`
- [x] `docs/projects/06-webview/tasks.md:142` (instance #2) — rename `jarvis`→rune: `- [x] Write '~/Library/LaunchAgents/com.jarvis.daemon.plist' running 'npm start' (or 'npm …`
- [x] `docs/projects/06-webview/tasks.md:148` — rename `jarvis`→rune: `- [x] Confirm log access from laptop: 'ssh mini "tail -f ~/Library/Logs/jarvis/stdout.log"…`

### `docs/projects/06-webview/test-plan.md`

- [x] `docs/projects/06-webview/test-plan.md:42` — rename `jarvis`→rune: `- [ ] 🔴 'GET /' without a 'jarvis-auth' cookie shows the auth-required bootstrap page (not…`
- [x] `docs/projects/06-webview/test-plan.md:45` — rename `JARVIS`→rune: `- [ ] 🔴 'GET /api/state' with 'Authorization: Bearer $JARVIS_HTTP_SECRET' returns 200.`
- [x] `docs/projects/06-webview/test-plan.md:46` — rename `jarvis`→rune: `- [ ] 🔴 'GET /api/state' with 'jarvis-auth' cookie returns 200.`
- [x] `docs/projects/06-webview/test-plan.md:47` — rename `JARVIS`→rune: `- [ ] 🔴 Any new endpoint with 'Host' header (port stripped) not in 'JARVIS_ALLOWED_HOSTS' …`
- [x] `docs/projects/06-webview/test-plan.md:48` — rename `JARVIS`→rune: `- [ ] 🟡 With 'JARVIS_ALLOWED_HOSTS=localhost,127.0.0.1,mac-mini.tail-xxxx.ts.net', a reque…`
- [x] `docs/projects/06-webview/test-plan.md:169` — rename `JARVIS`→rune: `- [ ] 🟢 'JARVIS_HTTP_SECRET' rotated while a tab is open: cookie validation fails on next …`
- [x] `docs/projects/06-webview/test-plan.md:179` (instance #1) — rename `JARVIS`→rune: `- '.env.local' on the Mac mini contains 'JARVIS_ALLOWED_HOSTS=localhost,127.0.0.1,<actual-…`
- [x] `docs/projects/06-webview/test-plan.md:179` (instance #2) — rename `JARVIS`→rune: `- '.env.local' on the Mac mini contains 'JARVIS_ALLOWED_HOSTS=localhost,127.0.0.1,<actual-…`
- [x] `docs/projects/06-webview/test-plan.md:183` (instance #1) — rename `JARVIS`→rune: `- [ ] 🔴 First-load auth bootstrap: from the laptop, browse 'https://<host>.tail-xxxx.ts.ne…`
- [x] `docs/projects/06-webview/test-plan.md:183` (instance #2) — rename `jarvis`→rune: `- [ ] 🔴 First-load auth bootstrap: from the laptop, browse 'https://<host>.tail-xxxx.ts.ne…`
- [x] `docs/projects/06-webview/test-plan.md:192` — rename `JARVIS`→rune: `- [ ] 🟢 MagicDNS hostname rotation: if the user re-signs into a fresh tailnet and the Magi…`
- [x] `docs/projects/06-webview/test-plan.md:199` (instance #1) — rename `JARVIS`→rune: `- [ ] 🟡 'JARVIS_ALLOWED_HOSTS' is documented in 'CLAUDE.md' Environment Variables alongsid…`
- [x] `docs/projects/06-webview/test-plan.md:199` (instance #2) — rename `JARVIS`→rune: `- [ ] 🟡 'JARVIS_ALLOWED_HOSTS' is documented in 'CLAUDE.md' Environment Variables alongsid…`

### `docs/projects/07-spaced-repetition/tasks.md`

- [x] `docs/projects/07-spaced-repetition/tasks.md:43` — rename `jarvis`→rune: `- [x] CLI: add 'study' subcommand in 'cli/jarvis.ts' so 'npm run cli -- study [N]' runs a …`

### `docs/projects/08-intent-layer/agent-lessons.md`

- [x] `docs/projects/08-intent-layer/agent-lessons.md:397` — rename `jarvis`→rune: `Claude Code session transcript at '~/.claude/projects/-Users-jarvis-workspace-pkms/'`

### `docs/projects/08-intent-layer/spec.md`

- [x] `docs/projects/08-intent-layer/spec.md:363` — rename `jarvis`→rune: `│ ▸ jarvis · playbook · "weekly review timing" · 5h   │`
- [x] `docs/projects/08-intent-layer/spec.md:369` — rename `jarvis`→rune: `│ ▸ jarvis · ask-twice · "/foo skill proposal" · 2d   │`
- [x] `docs/projects/08-intent-layer/spec.md:520` — rename `jarvis`→rune: `The key recursion: **Rune is itself a product.** It has a repo ('~/workspace/jarvis') and …`

### `docs/projects/08-intent-layer/tasks.md`

- [x] `docs/projects/08-intent-layer/tasks.md:270` — rename `jarvis`→rune: `- [x] **(agent)** On 'merge: true' — 'git -C <productRepo> merge --no-ff <branch>' and pus…`
- [x] `docs/projects/08-intent-layer/tasks.md:316` — rename `jarvis`→rune: `- [x] **(agent)** Handle the result — 'appendFiledIdeas(result.ideasMarkdown)'; for each '…`

### `docs/projects/08-intent-layer/test-plan.md`

- [x] `docs/projects/08-intent-layer/test-plan.md:160` — rename `jarvis`→rune: `fail-closed (visible in 'logs/jarvis.log' as an 'error'-level entry).`

### `docs/projects/09-expand-cockpit/spec.md`

- [x] `docs/projects/09-expand-cockpit/spec.md:166` — rename `jarvis`→rune: `┌─ jarvis ────────────────────────────────┐`
- [x] `docs/projects/09-expand-cockpit/spec.md:178` — rename `jarvis`→rune: `┌─ jarvis backlog ────────────────── [✕] ─┐`

### `docs/projects/09-expand-cockpit/tasks.md`

- [x] `docs/projects/09-expand-cockpit/tasks.md:61` (instance #1) — rename `jarvis`→rune: `- [x] 'product-scaffold-target.test.ts' — approval resolves the target product's 'repoPath…`
- [x] `docs/projects/09-expand-cockpit/tasks.md:61` (instance #2) — rename `jarvis`→rune: `- [x] 'product-scaffold-target.test.ts' — approval resolves the target product's 'repoPath…`

### `docs/projects/09-expand-cockpit/test-plan.md`

- [x] `docs/projects/09-expand-cockpit/test-plan.md:5` — rename `jarvis`→rune: `> See also: cross-cutting jarvis test conventions in`
- [x] `docs/projects/09-expand-cockpit/test-plan.md:61` — rename `jarvis`→rune: `- Approval resolves the target product's canonical 'repoPath' from 'policies/products.json…`

### `docs/projects/10-jarvis-identity-refactor/spec.md`

- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:10` — rename `jarvis`→rune: `compiler ('jarvis/bin/compile-instructions') with an explicit IR, pure-function`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:11` — rename `JARVIS`→rune: `'claude'/'agents' renderers, a YAML manifest, a '$JARVIS_HOME' wrapper, a named-token`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:13` — rename `jarvis`→rune: `jarvis and four consumer repos (pkms, aura, assay, relay), each via its own project.`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:21` — rename `jarvis`→rune: `vault and orchestrator concerns together) into 'jarvis/CLAUDE.md', leaving a one-line`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:31` — rename `JARVIS`→rune: `'$JARVIS_HOME' / CI-cascade layer existed only to manage divergence that the design`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:34` — rename `jarvis`→rune: `(jarvis 'AGENTS.md' frozen at 2026-05-19 while 'CLAUDE.md' advanced through projects`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:48` — rename `JARVIS`→rune: `'$JARVIS_HOME' wrapper, named-token inventory verifier, CI drift-check cascade, the`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:61` — rename `jarvis`→rune: `filename is a symlink to it), and Rune's orchestrator identity living in the jarvis repo.`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:67` — rename `jarvis`→rune: `- **Identity lives where it's owned** — orchestrator mechanics in jarvis, vault mechanics`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:73` — rename `jarvis`→rune: `'CLAUDE.md'. Core repos: jarvis, pkms. Best-effort: aura, assay.`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:75` — rename `jarvis`→rune: `'jarvis/CLAUDE.md'; leave a pointer in pkms.`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:80` — rename `JARVIS`→rune: `- CI drift checks, pre-commit hooks, '$JARVIS_HOME' wrappers.`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:92` — rename `jarvis`→rune: `1. **Drift.** 'jarvis/CLAUDE.md' (408 lines, last edited 2026-06-01, carries the project`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:93` — rename `jarvis`→rune: `08–09 cockpit / planning-session / mutation-pipeline updates) vs 'jarvis/AGENTS.md'`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:103` — rename `jarvis`→rune: `Rune *orchestrator* behaves, not how the *vault* is structured. They belong in jarvis.`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:127` — rename `jarvis`→rune: `| jarvis | both files, drifted                | 'git rm AGENTS.md' → symlink to 'CLAUDE.md…`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:139` — rename `jarvis`→rune: `Cut the orchestrator sections from 'pkms/CLAUDE.md', paste them into 'jarvis/CLAUDE.md',`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:143` — rename `jarvis`→rune: `**Moving out of 'pkms/CLAUDE.md' → into 'jarvis/CLAUDE.md':**`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:146` — rename `jarvis`→rune: `the agent split (generic tooling agents in jarvis vs personal-specifics agents in`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:163` — rename `jarvis`→rune: `> and the review write-up pipeline — is documented in 'jarvis/CLAUDE.md'.`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:174` — rename `jarvis`→rune: `confirm before committing the jarvis symlink (test-plan §1). **Fallback if it does`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:177` — rename `jarvis`→rune: `- **git symlink support.** macOS/Linux only (jarvis runs on both); 'core.symlinks'`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:180` — rename `jarvis`→rune: `sections must appear verbatim in 'jarvis/CLAUDE.md' and be absent from 'pkms/CLAUDE.md',`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:190` — rename `jarvis`→rune: `### Phase 1 — Content move (pkms ↔ jarvis)`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:192` — rename `jarvis`→rune: `- [ ] Append the '## Rune' and '### How Reviews Work' sections to 'jarvis/CLAUDE.md'`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:195` — rename `jarvis`→rune: `- [ ] Read the diff in both repos; confirm the moved content is present in jarvis, absent`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:201` — rename `jarvis`→rune: `- [ ] **jarvis:** 'git rm AGENTS.md'; 'ln -s CLAUDE.md AGENTS.md'; 'git add'.`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:202` — rename `jarvis`→rune: `- [ ] **Verify Codex loads through the symlink** in jarvis before proceeding (see Risks).`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:214` — rename `jarvis`→rune: `| 'AGENTS.md' is a symlink to 'CLAUDE.md' | jarvis + pkms (core); assay + aura (best-effor…`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:216` — rename `jarvis`→rune: `| Codex loads through the symlink | confirmed | manual Codex session in jarvis reads orche…`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:217` — rename `jarvis`→rune: `| Orchestrator sections moved, not lost | 100% present in jarvis, absent in pkms | git dif…`
- [x] `docs/projects/10-jarvis-identity-refactor/spec.md:226` — rename `jarvis`→rune: `(Risks); revert the jarvis symlink, regenerate 'AGENTS.md' as a copy, add the diff check.`

### `docs/projects/10-jarvis-identity-refactor/tasks.md`

- [x] `docs/projects/10-jarvis-identity-refactor/tasks.md:8` — rename `jarvis`→rune: `> 'pkms/CLAUDE.md' to 'jarvis/CLAUDE.md'. The prior compiler/manifest/verifier/CI/playbook`
- [x] `docs/projects/10-jarvis-identity-refactor/tasks.md:19` — rename `jarvis`→rune: `''10-jarvis-identity-refactor'' string in 'src/jobs/supervision-store.test.ts' is`
- [x] `docs/projects/10-jarvis-identity-refactor/tasks.md:23` — rename `JARVIS`→rune: `_(2946 passing; the lone failure — 'claude.test.ts' "does not set JARVIS_WORKSPACE_DIR"`
- [x] `docs/projects/10-jarvis-identity-refactor/tasks.md:25` — rename `JARVIS`→rune: `exports 'JARVIS_WORKSPACE_DIR' into 'process.env', which the spawn env spread leaks into`
- [x] `docs/projects/10-jarvis-identity-refactor/tasks.md:28` — rename `jarvis`→rune: `## Phase 1 — Content move (pkms ↔ jarvis)`
- [x] `docs/projects/10-jarvis-identity-refactor/tasks.md:33` — rename `jarvis`→rune: `routing, 'loadAgentDef' order) from 'pkms/CLAUDE.md' into 'jarvis/CLAUDE.md', placed`
- [x] `docs/projects/10-jarvis-identity-refactor/tasks.md:37` — rename `jarvis`→rune: `write-up + post-agent pipeline; the specialist updaters) into 'jarvis/CLAUDE.md'.`
- [x] `docs/projects/10-jarvis-identity-refactor/tasks.md:40` — rename `jarvis`→rune: `… is documented in 'jarvis/CLAUDE.md'."`
- [x] `docs/projects/10-jarvis-identity-refactor/tasks.md:44` — rename `jarvis`→rune: `- [x] Read the git diff in both repos — moved content present in jarvis, absent in pkms,`
- [x] `docs/projects/10-jarvis-identity-refactor/tasks.md:47` (instance #1) — rename `jarvis`→rune: `- [x] Commit jarvis to 'main'. Commit pkms straight to 'main' (no-branch rule). _(jarvis`
- [x] `docs/projects/10-jarvis-identity-refactor/tasks.md:47` (instance #2) — rename `jarvis`→rune: `- [x] Commit jarvis to 'main'. Commit pkms straight to 'main' (no-branch rule). _(jarvis`
- [x] `docs/projects/10-jarvis-identity-refactor/tasks.md:48` — rename `jarvis`→rune: `lands on the work branch 'jarvis-work/2d0534db' → merges to main downstream, the`
- [x] `docs/projects/10-jarvis-identity-refactor/tasks.md:58` — rename `jarvis`→rune: `- [x] **jarvis:** 'git rm AGENTS.md'; 'ln -s CLAUDE.md AGENTS.md'; 'git add AGENTS.md'.`
- [x] `docs/projects/10-jarvis-identity-refactor/tasks.md:61` — rename `jarvis`→rune: `- [x] **Verify Codex reads through the symlink** in jarvis — open a Codex session, confirm`
- [x] `docs/projects/10-jarvis-identity-refactor/tasks.md:64` — rename `jarvis`→rune: `stop. _(Verified manually 2026-06-03: Michael opened a Codex session in the jarvis`
- [x] `docs/projects/10-jarvis-identity-refactor/tasks.md:83` — rename `jarvis`→rune: `'readlink AGENTS.md' = 'CLAUDE.md' (test-plan §1). _(All four — jarvis, pkms, assay,`
- [x] `docs/projects/10-jarvis-identity-refactor/tasks.md:89` — rename `jarvis`→rune: `- [x] Commit each repo to 'main'. _(jarvis '53d91de', pkms 'eeb572f', assay 'dbf277e',`
- [x] `docs/projects/10-jarvis-identity-refactor/tasks.md:99` — rename `JARVIS`→rune: `- The '$JARVIS_HOME' wrapper and 'wrapper-template.sh'.`

### `docs/projects/10-jarvis-identity-refactor/test-plan.md`

- [x] `docs/projects/10-jarvis-identity-refactor/test-plan.md:22` — rename `jarvis`→rune: `- [ ] 🔴 In jarvis and pkms, 'AGENTS.md' is a symlink to 'CLAUDE.md':`
- [x] `docs/projects/10-jarvis-identity-refactor/test-plan.md:25` — rename `jarvis`→rune: `- [ ] 🔴 **Manual:** open a Codex session in jarvis; confirm it loads instructions through`
- [x] `docs/projects/10-jarvis-identity-refactor/test-plan.md:30` — rename `jarvis`→rune: `- [ ] 🔴 **Manual:** open Claude Code in jarvis; confirm 'CLAUDE.md' loads as before.`
- [x] `docs/projects/10-jarvis-identity-refactor/test-plan.md:36` — rename `jarvis`→rune: `## 2. Content move (pkms → jarvis)`
- [x] `docs/projects/10-jarvis-identity-refactor/test-plan.md:39` — rename `jarvis`→rune: `'jarvis/CLAUDE.md' after the move.`
- [x] `docs/projects/10-jarvis-identity-refactor/test-plan.md:41` — rename `jarvis`→rune: `- [ ] 🔴 The pointer line ("Rune orchestration … is documented in 'jarvis/CLAUDE.md'")`
- [x] `docs/projects/10-jarvis-identity-refactor/test-plan.md:49` — rename `jarvis`→rune: `to fit jarvis's structure). Read the diff — it is the proof, replacing the dropped`
- [x] `docs/projects/10-jarvis-identity-refactor/test-plan.md:66` — rename `jarvis`→rune: `> After both phases: a developer (or Codex/Claude session) opening jarvis loads a single`
- [x] `docs/projects/10-jarvis-identity-refactor/test-plan.md:68` — rename `jarvis`→rune: `> Opening pkms loads vault-only instructions plus a one-line pointer to jarvis. Editing`

### `docs/projects/11-work-run-observability/phase-6-diagnosis.md`

- [x] `docs/projects/11-work-run-observability/phase-6-diagnosis.md:11` (instance #1) — rename `jarvis`→rune: `'10-jarvis-identity-refactor' (run '7b8410fb', branch 'jarvis-work/7b8410fb',`
- [x] `docs/projects/11-work-run-observability/phase-6-diagnosis.md:11` (instance #2) — rename `jarvis`→rune: `'10-jarvis-identity-refactor' (run '7b8410fb', branch 'jarvis-work/7b8410fb',`

### `docs/projects/12-writer-memory/spec.md`

- [x] `docs/projects/12-writer-memory/spec.md:23` — rename `jarvis`→rune: `1. **Primary:** a writer role ('SOUL.md' + 'memory.md') in the jarvis repo, running behind`
- [x] `docs/projects/12-writer-memory/spec.md:33` — rename `jarvis`→rune: `- Cross-product / per-product memory, a global tier. One role, jarvis repo only.`
- [x] `docs/projects/12-writer-memory/spec.md:48` — rename `jarvis`→rune: `jarvis/agents/writer/`
- [x] `docs/projects/12-writer-memory/spec.md:65` — rename `jarvis`→rune: `Both files live in the **jarvis repo** at 'PROJECT_ROOT/agents/writer/'. They are read fro…`
- [x] `docs/projects/12-writer-memory/spec.md:129` — rename `jarvis`→rune: `'agents/writer/memory.md' in the jarvis repo (not the vault's 'git add -A' helper, which r…`
- [x] `docs/projects/12-writer-memory/spec.md:291` — rename `jarvis`→rune: `| Lesson capture works | ≥1 per feedback session with valid candidate lessons | 'captureLe…`

### `docs/projects/12-writer-memory/tasks.md`

- [x] `docs/projects/12-writer-memory/tasks.md:33` — rename `jarvis`→rune: `- [x] Write 'jarvis/agents/writer/SOUL.md' from this spec — charter referencing`
- [x] `docs/projects/12-writer-memory/tasks.md:108` — rename `jarvis`→rune: `- [x] Build the memory-scoped commit helper (jarvis repo, stages only`

### `docs/projects/12-writer-memory/test-plan.md`

- [x] `docs/projects/12-writer-memory/test-plan.md:74` — rename `jarvis`→rune: `> 'agents/writer/memory.md' to the jarvis repo. A later composed '/blog' start loads one o…`

### `docs/projects/13-work-run-monitoring/spec.md`

- [x] `docs/projects/13-work-run-monitoring/spec.md:43` — rename `jarvis`→rune: `('jarvis-work/<run-id>' off repo HEAD, as today) and defines no new merge path.`
- [x] `docs/projects/13-work-run-monitoring/spec.md:93` — rename `jarvis`→rune: `and refuses to prune outside the 'jarvis-work/' prefix. **Implication:** the GC carve-out …`
- [x] `docs/projects/13-work-run-monitoring/spec.md:299` — rename `JARVIS`→rune: `blocked-on-human stop with one exact final line — 'JARVIS_WORK_RUN_SENTINEL { ...json... }…`
- [x] `docs/projects/13-work-run-monitoring/spec.md:506` — rename `jarvis`→rune: `proposed topology was invalid — 'refs/heads/jarvis-work/<project>' and`
- [x] `docs/projects/13-work-run-monitoring/spec.md:507` — rename `jarvis`→rune: `'refs/heads/jarvis-work/<project>/<run-id>' cannot coexist (a ref is a file; a nested ref …`
- [x] `docs/projects/13-work-run-monitoring/spec.md:509` — rename `jarvis`→rune: `ref **outside** 'refs/heads' (e.g. 'refs/jarvis/integration/<product>/<project>'), advance…`

### `docs/projects/13-work-run-monitoring/tasks.md`

- [x] `docs/projects/13-work-run-monitoring/tasks.md:75` — rename `JARVIS`→rune: `- [x] Write sentinel parser tests for valid 'JARVIS_WORK_RUN_SENTINEL' payloads, malformed…`
- [x] `docs/projects/13-work-run-monitoring/tasks.md:124` — rename `JARVIS`→rune: `- [x] Define the 'JARVIS_WORK_RUN_SENTINEL { … }' line contract in '.claude/skills/work/SK…`

### `docs/projects/13-work-run-monitoring/test-plan.md`

- [x] `docs/projects/13-work-run-monitoring/test-plan.md:45` — rename `JARVIS`→rune: `- [ ] 🔴 A final 'JARVIS_WORK_RUN_SENTINEL { … }' line in the result envelope is parsed fro…`

### `docs/projects/14-product-team-agents/context.md`

- [x] `docs/projects/14-product-team-agents/context.md:3` — rename `jarvis`→rune: `> Orchestration state for the 'jarvis' project "Product-Team Orchestrated Work".`

### `docs/projects/14-product-team-agents/live-acceptance-6abf35cf.md`

- [x] `docs/projects/14-product-team-agents/live-acceptance-6abf35cf.md:16` — rename `jarvis`→rune: `- **Branch:** 'jarvis-work/live-accept-sum'`
- [x] `docs/projects/14-product-team-agents/live-acceptance-6abf35cf.md:36` — rename `jarvis`→rune: `{"mutationId":"14165a44-5241-409f-9a72-e507a578cd14","ts":"2026-06-14T02:57:30.809Z","kind…`

### `docs/projects/14-product-team-agents/phase-10-active-harm-verification.md`

- [x] `docs/projects/14-product-team-agents/phase-10-active-harm-verification.md:30` — rename `JARVIS`→rune: `TELEGRAM_BOT_TOKEN=test-token TELEGRAM_USER_ID=12345 VAULT_DIR=/tmp/vault JARVIS_HTTP_SECR…`

### `docs/projects/14-product-team-agents/tasks.md`

- [x] `docs/projects/14-product-team-agents/tasks.md:605` — rename `jarvis`→rune: `in '.env.local' and 'orchestratedMode: true' restored on the 'jarvis' product in`

### `docs/projects/15-work-run-finalizer/spec.md`

- [x] `docs/projects/15-work-run-finalizer/spec.md:427` — rename `jarvis`→rune: `fix). The branch merge → 'main' and the jarvis server restart remain a human go-live step.`

### `docs/projects/15-work-run-finalizer/tasks.md`

- [x] `docs/projects/15-work-run-finalizer/tasks.md:226` — rename `jarvis`→rune: `egressAllowlist), and a read-only real-'products.json' test pinning jarvis =`
- [x] `docs/projects/15-work-run-finalizer/tasks.md:318` — rename `jarvis`→rune: `the jarvis entry in 'policies/products.json'; other products omit it → '[]' → gate fails c…`
- [x] `docs/projects/15-work-run-finalizer/tasks.md:395` — rename `jarvis`→rune: `> This turns on autonomous merges to jarvis's real 'main' behind the hard gate.`
- [x] `docs/projects/15-work-run-finalizer/tasks.md:402` — rename `jarvis`→rune: `> **Go-live (merge this branch → 'main' + restart the jarvis server) stays a human step**,…`

### `docs/projects/16-claude-app-connector/context.md`

- [x] `docs/projects/16-claude-app-connector/context.md:3` — rename `jarvis`→rune: `> Orchestration state for the 'jarvis' project "Move the Rune conversation surface to the …`
- [x] `docs/projects/16-claude-app-connector/context.md:30` (instance #1) — rename `jarvis`→rune: `- MCP server today: 'jarvis/src/mcp/server.ts' exports 'createKBServer()' using 'McpServer…`
- [x] `docs/projects/16-claude-app-connector/context.md:30` (instance #2) — rename `jarvis`→rune: `- MCP server today: 'jarvis/src/mcp/server.ts' exports 'createKBServer()' using 'McpServer…`
- [x] `docs/projects/16-claude-app-connector/context.md:32` — rename `jarvis`→rune: `- Vault primitives ('jarvis/src/vault/'): 'appendToJournal(text): string'; 'gitCommitAndPu…`
- [x] `docs/projects/16-claude-app-connector/context.md:33` — rename `jarvis`→rune: `- KB queue ('jarvis/src/kb/queue.ts'): 'enqueue(source, guidance?)', 'getPriority()' (give…`
- [x] `docs/projects/16-claude-app-connector/context.md:34` (instance #1) — rename `jarvis`→rune: `- Conversation layer ('jarvis/src/bot/commands/fresh.ts', 'fresh-full.ts'): 'closeConversa…`
- [x] `docs/projects/16-claude-app-connector/context.md:34` (instance #2) — rename `jarvis`→rune: `- Conversation layer ('jarvis/src/bot/commands/fresh.ts', 'fresh-full.ts'): 'closeConversa…`
- [x] `docs/projects/16-claude-app-connector/context.md:34` (instance #3) — rename `jarvis`→rune: `- Conversation layer ('jarvis/src/bot/commands/fresh.ts', 'fresh-full.ts'): 'closeConversa…`
- [x] `docs/projects/16-claude-app-connector/context.md:35` (instance #1) — rename `jarvis`→rune: `- Idea routing: product registry 'jarvis/policies/products.json' ('aura', 'assay', 'jarvis…`
- [x] `docs/projects/16-claude-app-connector/context.md:35` (instance #2) — rename `jarvis`→rune: `- Idea routing: product registry 'jarvis/policies/products.json' ('aura', 'assay', 'jarvis…`
- [x] `docs/projects/16-claude-app-connector/context.md:35` (instance #3) — rename `jarvis`→rune: `- Idea routing: product registry 'jarvis/policies/products.json' ('aura', 'assay', 'jarvis…`
- [x] `docs/projects/16-claude-app-connector/context.md:36` (instance #1) — rename `jarvis`→rune: `- Daemon HTTP server: 'jarvis/src/server/http.ts' 'startHttpServer()' on '127.0.0.1:3847',…`
- [x] `docs/projects/16-claude-app-connector/context.md:36` (instance #2) — rename `jarvis`→rune: `- Daemon HTTP server: 'jarvis/src/server/http.ts' 'startHttpServer()' on '127.0.0.1:3847',…`
- [x] `docs/projects/16-claude-app-connector/context.md:36` (instance #3) — rename `JARVIS`→rune: `- Daemon HTTP server: 'jarvis/src/server/http.ts' 'startHttpServer()' on '127.0.0.1:3847',…`
- [x] `docs/projects/16-claude-app-connector/context.md:39` — rename `Jarvis`→rune: `**Decision: one server, one process.** Refactor 'createKBServer()' into a shared 'createJa…`
- [x] `docs/projects/16-claude-app-connector/context.md:47` — rename `JARVIS`→rune: `**Auth (R4(a), single-user):** Claude App custom connectors require OAuth 2.1 for remote M…`
- [x] `docs/projects/16-claude-app-connector/context.md:93` — rename `Jarvis`→rune: `Start with: Refactor createKBServer() into a shared createJarvisMcpServer(opts) factory th…`

### `docs/projects/16-claude-app-connector/e2e-acceptance-test.md`

- [x] `docs/projects/16-claude-app-connector/e2e-acceptance-test.md:15` — rename `jarvis`→rune: `'https://jarvis.tail6b86b9.ts.net' (Funnel on).`
- [x] `docs/projects/16-claude-app-connector/e2e-acceptance-test.md:17` — rename `JARVIS`→rune: `http://127.0.0.1:3847/health' → '200') with 'JARVIS_HTTP_SECRET',`
- [x] `docs/projects/16-claude-app-connector/e2e-acceptance-test.md:18` — rename `JARVIS`→rune: `'MCP_ISSUER_URL', and the ts.net hostname in 'JARVIS_ALLOWED_HOSTS'.`
- [x] `docs/projects/16-claude-app-connector/e2e-acceptance-test.md:93` — rename `jarvis`→rune: `cd ~/workspace/jarvis && npm run seed    # or the KB-ingest entry the queue uses`

### `docs/projects/16-claude-app-connector/spec.md`

- [x] `docs/projects/16-claude-app-connector/spec.md:164` — rename `Jarvis`→rune: `'createKBServer()' into a shared 'createJarvisMcpServer(opts)' factory that`
- [x] `docs/projects/16-claude-app-connector/spec.md:197` — rename `Jarvis`→rune: `'createJarvisMcpServer' instance exposing only the six App-surface tools and`
- [x] `docs/projects/16-claude-app-connector/spec.md:200` — rename `JARVIS`→rune: `'JARVIS_HTTP_SECRET' and binds issued access tokens to the one known user id;`
- [x] `docs/projects/16-claude-app-connector/spec.md:231` — rename `Jarvis`→rune: `- [ ] Refactor 'createKBServer()' into a shared 'createJarvisMcpServer(opts)'`
- [x] `docs/projects/16-claude-app-connector/spec.md:248` — rename `JARVIS`→rune: `gated on 'JARVIS_HTTP_SECRET', bearer-validated per request).`

### `docs/projects/16-claude-app-connector/tasks.md`

- [x] `docs/projects/16-claude-app-connector/tasks.md:28` — rename `Jarvis`→rune: `- [x] **mcp-server-shared-factory** — Refactor 'createKBServer()' into a shared 'createJar…`
- [x] `docs/projects/16-claude-app-connector/tasks.md:46` — rename `Jarvis`→rune: `- [x] **streamable-http-transport** — Mount 'StreamableHTTPServerTransport' at a new '/mcp…`
- [x] `docs/projects/16-claude-app-connector/tasks.md:47` (instance #1) — rename `JARVIS`→rune: `- [x] **mcp-oauth-single-user** — Implement single-user OAuth 2.1 for the '/mcp' endpoint …`
- [x] `docs/projects/16-claude-app-connector/tasks.md:47` (instance #2) — rename `JARVIS`→rune: `- [x] **mcp-oauth-single-user** — Implement single-user OAuth 2.1 for the '/mcp' endpoint …`
- [x] `docs/projects/16-claude-app-connector/tasks.md:48` — rename `jarvis`→rune: `- [x] **remote-tunnel-exposure** (docs/config only) — Stand up a named tunnel exposing onl…`

### `docs/projects/16-claude-app-connector/tech-spec.md`

- [x] `docs/projects/16-claude-app-connector/tech-spec.md:4` (instance #1) — rename `jarvis`→rune: `- MCP server today: 'jarvis/src/mcp/server.ts' exports 'createKBServer()' using 'McpServer…`
- [x] `docs/projects/16-claude-app-connector/tech-spec.md:4` (instance #2) — rename `jarvis`→rune: `- MCP server today: 'jarvis/src/mcp/server.ts' exports 'createKBServer()' using 'McpServer…`
- [x] `docs/projects/16-claude-app-connector/tech-spec.md:6` — rename `jarvis`→rune: `- Vault primitives ('jarvis/src/vault/'): 'appendToJournal(text): string'; 'gitCommitAndPu…`
- [x] `docs/projects/16-claude-app-connector/tech-spec.md:7` — rename `jarvis`→rune: `- KB queue ('jarvis/src/kb/queue.ts'): 'enqueue(source, guidance?)', 'getPriority()' (give…`
- [x] `docs/projects/16-claude-app-connector/tech-spec.md:8` (instance #1) — rename `jarvis`→rune: `- Conversation layer ('jarvis/src/bot/commands/fresh.ts', 'fresh-full.ts'): 'closeConversa…`
- [x] `docs/projects/16-claude-app-connector/tech-spec.md:8` (instance #2) — rename `jarvis`→rune: `- Conversation layer ('jarvis/src/bot/commands/fresh.ts', 'fresh-full.ts'): 'closeConversa…`
- [x] `docs/projects/16-claude-app-connector/tech-spec.md:8` (instance #3) — rename `jarvis`→rune: `- Conversation layer ('jarvis/src/bot/commands/fresh.ts', 'fresh-full.ts'): 'closeConversa…`
- [x] `docs/projects/16-claude-app-connector/tech-spec.md:9` (instance #1) — rename `jarvis`→rune: `- Idea routing: product registry 'jarvis/policies/products.json' ('aura', 'assay', 'jarvis…`
- [x] `docs/projects/16-claude-app-connector/tech-spec.md:9` (instance #2) — rename `jarvis`→rune: `- Idea routing: product registry 'jarvis/policies/products.json' ('aura', 'assay', 'jarvis…`
- [x] `docs/projects/16-claude-app-connector/tech-spec.md:9` (instance #3) — rename `jarvis`→rune: `- Idea routing: product registry 'jarvis/policies/products.json' ('aura', 'assay', 'jarvis…`
- [x] `docs/projects/16-claude-app-connector/tech-spec.md:10` (instance #1) — rename `jarvis`→rune: `- Daemon HTTP server: 'jarvis/src/server/http.ts' 'startHttpServer()' on '127.0.0.1:3847',…`
- [x] `docs/projects/16-claude-app-connector/tech-spec.md:10` (instance #2) — rename `jarvis`→rune: `- Daemon HTTP server: 'jarvis/src/server/http.ts' 'startHttpServer()' on '127.0.0.1:3847',…`
- [x] `docs/projects/16-claude-app-connector/tech-spec.md:10` (instance #3) — rename `JARVIS`→rune: `- Daemon HTTP server: 'jarvis/src/server/http.ts' 'startHttpServer()' on '127.0.0.1:3847',…`
- [x] `docs/projects/16-claude-app-connector/tech-spec.md:13` — rename `Jarvis`→rune: `**Decision: one server, one process.** Refactor 'createKBServer()' into a shared 'createJa…`
- [x] `docs/projects/16-claude-app-connector/tech-spec.md:21` — rename `JARVIS`→rune: `**Auth (R4(a), single-user):** Claude App custom connectors require OAuth 2.1 for remote M…`

### `docs/projects/16-claude-app-connector/test-plan.md`

- [x] `docs/projects/16-claude-app-connector/test-plan.md:23` — rename `Jarvis`→rune: `- [ ] 🔴 'createJarvisMcpServer(opts)' registers exactly the requested tool set on one 'Mcp…`
- [x] `docs/projects/16-claude-app-connector/test-plan.md:83` — rename `JARVIS`→rune: `- [ ] 🔴 Authorization is gated on 'JARVIS_HTTP_SECRET' (DCR + authorization-code flow).`

### `docs/projects/16-claude-app-connector/tunnel-runbook.md`

- [x] `docs/projects/16-claude-app-connector/tunnel-runbook.md:82` — rename `JARVIS`→rune: `- 'JARVIS_ALLOWED_HOSTS=localhost,127.0.0.1,<machine>.<tailnet>.ts.net' —`
- [x] `docs/projects/16-claude-app-connector/tunnel-runbook.md:85` — rename `JARVIS`→rune: `- 'JARVIS_HTTP_SECRET' must be set (the /mcp surface is not mounted`
- [x] `docs/projects/16-claude-app-connector/tunnel-runbook.md:93` — rename `JARVIS`→rune: `- 'JARVIS_HTTP_SECRET' stays in '.env.local' (gitignored). The human types`
- [x] `docs/projects/16-claude-app-connector/tunnel-runbook.md:124` — rename `JARVIS`→rune: `| 403 on every funneled request | The ts.net hostname is missing from 'JARVIS_ALLOWED_HOST…`
- [x] `docs/projects/16-claude-app-connector/tunnel-runbook.md:129` — rename `JARVIS`→rune: `| Suspected compromise | 'tailscale serve reset' (drops all mounts — surface offline), 'rm…`
- [x] `docs/projects/16-claude-app-connector/tunnel-runbook.md:144` — rename `jarvis`→rune: `3. 'cloudflared tunnel create jarvis-mcp' → writes credentials`
- [x] `docs/projects/16-claude-app-connector/tunnel-runbook.md:147` (instance #1) — rename `jarvis`→rune: `4. 'cloudflared tunnel route dns jarvis-mcp jarvis-mcp.<your-domain>'`
- [x] `docs/projects/16-claude-app-connector/tunnel-runbook.md:147` (instance #2) — rename `jarvis`→rune: `4. 'cloudflared tunnel route dns jarvis-mcp jarvis-mcp.<your-domain>'`
- [x] `docs/projects/16-claude-app-connector/tunnel-runbook.md:150` — rename `jarvis`→rune: `tunnel: jarvis-mcp`
- [x] `docs/projects/16-claude-app-connector/tunnel-runbook.md:154` — rename `jarvis`→rune: `- hostname: jarvis-mcp.<your-domain>`
- [x] `docs/projects/16-claude-app-connector/tunnel-runbook.md:157` — rename `jarvis`→rune: `- hostname: jarvis-mcp.<your-domain>`
- [x] `docs/projects/16-claude-app-connector/tunnel-runbook.md:163` — rename `jarvis`→rune: `6. Env: 'MCP_ISSUER_URL=https://jarvis-mcp.<your-domain>', add the hostname`
- [x] `docs/projects/16-claude-app-connector/tunnel-runbook.md:164` — rename `JARVIS`→rune: `to 'JARVIS_ALLOWED_HOSTS', restart Rune.`
- [x] `docs/projects/16-claude-app-connector/tunnel-runbook.md:167` — rename `jarvis`→rune: `8. Recovery: 'cloudflared tunnel info jarvis-mcp'; restart via`

### `docs/projects/17-cockpit-redesign/context.md`

- [x] `docs/projects/17-cockpit-redesign/context.md:3` — rename `jarvis`→rune: `> Orchestration state for the 'jarvis' project "Cockpit Redesign — Surface Rethink (Workst…`
- [x] `docs/projects/17-cockpit-redesign/context.md:305` (instance #1) — rename `JARVIS`→rune: `- ceptance, because it requires the real Rune daemon, 'JARVIS_HTTP_SECRET', and 'JARVIS_AC…`
- [x] `docs/projects/17-cockpit-redesign/context.md:305` (instance #2) — rename `JARVIS`→rune: `- ceptance, because it requires the real Rune daemon, 'JARVIS_HTTP_SECRET', and 'JARVIS_AC…`
- [x] `docs/projects/17-cockpit-redesign/context.md:305` (instance #3) — rename `JARVIS`→rune: `- ceptance, because it requires the real Rune daemon, 'JARVIS_HTTP_SECRET', and 'JARVIS_AC…`

### `docs/projects/17-cockpit-redesign/spec.md`

- [x] `docs/projects/17-cockpit-redesign/spec.md:468` — rename `jarvis`→rune: `- [ ] 'e2e-acceptance-on-jarvis' stub-free end-to-end acceptance on a real product`

### `docs/projects/17-cockpit-redesign/tasks.md`

- [x] `docs/projects/17-cockpit-redesign/tasks.md:116` — rename `jarvis`→rune: `- [x] **e2e-acceptance-on-jarvis** — Stub-free end-to-end acceptance on a real product (Ru…`

### `docs/projects/bugs.md`

- [x] `docs/projects/bugs.md:42` — rename `JARVIS`→rune: `- The parked-run path now exists — an '--auto' agent that emits 'JARVIS_WORK_RUN_SENTINEL'…`
- [x] `docs/projects/bugs.md:66` — rename `jarvis`→rune: `- The 2026-06-04 resume fix made each project run check out a stable per-project branch ('…`
- [x] `docs/projects/bugs.md:70` — rename `jarvis`→rune: `- Confirmed instance: Phase 11A (gate-rejection feedback retries) was built out-of-band an…`
- [x] `docs/projects/bugs.md:94` — rename `JARVIS`→rune: `- [x] Work-run terminal alert gives no "stopped / blocked on a decision" signal — a delibe…`
- [x] `docs/projects/bugs.md:118` — rename `jarvis`→rune: `- D. (manual, this branch only) If A ships without B, the already-committed 'jarvis-work/1…`
- [x] `docs/projects/bugs.md:133` — rename `jarvis`→rune: `- **5. No merge/push/delete-branch finalizer for plain work-runs.** 'work-runner.ts' class…`
- [x] `docs/projects/bugs.md:172` — rename `jarvis`→rune: `- Each run derives a brand-new branch from its own id: 'const branch = jarvis-work/${descr…`
- [x] `docs/projects/bugs.md:174` — rename `jarvis`→rune: `- When a run ends without merging (killed, 'failed', GC'd, or just left unmerged like ever…`
- [x] `docs/projects/bugs.md:176` — rename `jarvis`→rune: `- Confirmed instance: run '19cd198f' shipped 25 commits (Phases 1–3 + Phase 4 tests) on 'j…`
- [x] `docs/projects/bugs.md:178` (instance #1) — rename `jarvis`→rune: `- A. Resume the project's existing branch. Before creating a worktree, look up the latest …`
- [x] `docs/projects/bugs.md:178` (instance #2) — rename `jarvis`→rune: `- A. Resume the project's existing branch. Before creating a worktree, look up the latest …`
- [x] `docs/projects/bugs.md:181` — rename `jarvis`→rune: `- D. (cheap guard) Before spawning, detect an unmerged 'jarvis-work/*' branch for the same…`
- [x] `docs/projects/bugs.md:183` (instance #1) — rename `jarvis`→rune: `- **Stable branch name.** 'work-runner.ts' now derives the branch from the project, not th…`
- [x] `docs/projects/bugs.md:183` (instance #2) — rename `jarvis`→rune: `- **Stable branch name.** 'work-runner.ts' now derives the branch from the project, not th…`
- [x] `docs/projects/bugs.md:200` (instance #1) — rename `jarvis`→rune: `- **B. Allowed working dir is only the worktree.** 'cwd: sandbox.worktree' is the sole all…`
- [x] `docs/projects/bugs.md:200` (instance #2) — rename `jarvis`→rune: `- **B. Allowed working dir is only the worktree.** 'cwd: sandbox.worktree' is the sole all…`
- [x] `docs/projects/bugs.md:200` (instance #3) — rename `jarvis`→rune: `- **B. Allowed working dir is only the worktree.** 'cwd: sandbox.worktree' is the sole all…`
- [x] `docs/projects/bugs.md:200` (instance #4) — rename `jarvis`→rune: `- **B. Allowed working dir is only the worktree.** 'cwd: sandbox.worktree' is the sole all…`
- [x] `docs/projects/bugs.md:222` (instance #1) — rename `jarvis`→rune: `- The registry now carries per-project task progress ('RegistryProject.progress'), so the …`
- [x] `docs/projects/bugs.md:222` (instance #2) — rename `jarvis`→rune: `- The registry now carries per-project task progress ('RegistryProject.progress'), so the …`
- [x] `docs/projects/bugs.md:222` (instance #3) — rename `jarvis`→rune: `- The registry now carries per-project task progress ('RegistryProject.progress'), so the …`

### `docs/projects/ideas.md`

- [x] `docs/projects/ideas.md:22` — rename `jarvis`→rune: `- **The actual gap — automated dispatch is jarvis-only and partly unwired.** Three layers,…`
- [x] `docs/projects/ideas.md:24` — rename `jarvis`→rune: `- *Layer B — the automated work-run dispatch isn't wired for any repo.* The nightly observ…`
- [x] `docs/projects/ideas.md:26` — rename `jarvis`→rune: `- The hard parts are (1) the dispatch path + product attribution (Layer B/C) and (2) the c…`
- [x] `docs/projects/ideas.md:48` (instance #1) — rename `jarvis`→rune: `- The '[[jarvis]]' wikilink appended into vault journals on session capture ('src/jobs/cap…`
- [x] `docs/projects/ideas.md:48` (instance #2) — rename `jarvis`→rune: `- The '[[jarvis]]' wikilink appended into vault journals on session capture ('src/jobs/cap…`
- [x] `docs/projects/ideas.md:49` — rename `jarvis`→rune: `- The MCP server name 'jarvis-kb' (default name in 'src/mcp/server.ts').`
- [x] `docs/projects/ideas.md:55` — rename `jarvis`→rune: `- **Scope:** full rename across code + repo + identifiers + vault wikilinks. Needs its own…`

### `docs/projects/index.md`

- [x] `docs/projects/index.md:18` (instance #1) — rename `jarvis`→rune: `| [10-jarvis-identity-refactor](10-jarvis-identity-refactor/spec.md) | Done | Symlink AGEN…`
- [x] `docs/projects/index.md:18` (instance #2) — rename `jarvis`→rune: `| [10-jarvis-identity-refactor](10-jarvis-identity-refactor/spec.md) | Done | Symlink AGEN…`
- [x] `docs/projects/index.md:18` (instance #3) — rename `jarvis`→rune: `| [10-jarvis-identity-refactor](10-jarvis-identity-refactor/spec.md) | Done | Symlink AGEN…`
- [x] `docs/projects/index.md:26` (instance #1) — rename `jarvis`→rune: `| [18-rebrand-jarvis-to-rune](18-rebrand-jarvis-to-rune/spec.md) | Not Started | Cut the a…`
- [x] `docs/projects/index.md:26` (instance #2) — rename `jarvis`→rune: `| [18-rebrand-jarvis-to-rune](18-rebrand-jarvis-to-rune/spec.md) | Not Started | Cut the a…`
- [x] `docs/projects/index.md:145` — rename `jarvis`→rune: `## 10-jarvis-identity-refactor — Done`
- [x] `docs/projects/index.md:147` — rename `jarvis`→rune: `[Spec](10-jarvis-identity-refactor/spec.md)`
- [x] `docs/projects/index.md:149` — rename `jarvis`→rune: `Two surgical edits: make 'AGENTS.md' a symlink to 'CLAUDE.md' per repo so the two can neve…`
- [x] `docs/projects/index.md:152` — rename `jarvis`→rune: `- **Drift fix:** 'ln -s CLAUDE.md AGENTS.md'. Core repos jarvis + pkms (both currently dri…`
- [x] `docs/projects/index.md:153` — rename `jarvis`→rune: `- **Identity fix:** move the '## Rune' and '### How Reviews Work' sections from pkms to ja…`
- [x] `docs/projects/index.md:154` — rename `JARVIS`→rune: `- **Dropped:** the compiler, IR, renderers, manifest, '$JARVIS_HOME' wrapper, inventory ve…`
- [x] `docs/projects/index.md:155` (instance #1) — rename `jarvis`→rune: `- **Task breakdown & test plan:** see [tasks.md](10-jarvis-identity-refactor/tasks.md) and…`
- [x] `docs/projects/index.md:155` (instance #2) — rename `jarvis`→rune: `- **Task breakdown & test plan:** see [tasks.md](10-jarvis-identity-refactor/tasks.md) and…`
- [x] `docs/projects/index.md:180` (instance #1) — rename `jarvis`→rune: `- **The role:** 'jarvis/agents/writer/{SOUL.md, memory.md}' in the jarvis repo. 'SOUL.md' …`
- [x] `docs/projects/index.md:180` (instance #2) — rename `jarvis`→rune: `- **The role:** 'jarvis/agents/writer/{SOUL.md, memory.md}' in the jarvis repo. 'SOUL.md' …`
- [x] `docs/projects/index.md:182` — rename `jarvis`→rune: `- **Write path:** after a mandatory feedback checkpoint the writer emits a completion sent…`
- [x] `docs/projects/index.md:185` — rename `jarvis`→rune: `- **Scope:** one role, jarvis repo only, no cross-product. The planning pipeline and engag…`
- [x] `docs/projects/index.md:344` — rename `Jarvis`→rune: `- **Six-tool surface:** 'kb_query', 'vault_search', 'log_idea', 'crm_lookup', 'get_priorit…`
- [x] `docs/projects/index.md:347` — rename `JARVIS`→rune: `- **Transport + auth:** 'StreamableHTTPServerTransport' at '/mcp' on the daemon HTTP serve…`
- [x] `docs/projects/index.md:367` — rename `jarvis`→rune: `## 18-rebrand-jarvis-to-rune — Not Started`
- [x] `docs/projects/index.md:369` — rename `jarvis`→rune: `[Spec](18-rebrand-jarvis-to-rune/spec.md)`
- [x] `docs/projects/index.md:375` — rename `jarvis`→rune: `- **Inventory first:** a case-insensitive 'jarvis' sweep classifies every hit (brand-rewri…`
- [x] `docs/projects/index.md:376` (instance #1) — rename `jarvis`→rune: `- **Path de-leak:** extract hardcoded '/Users/jarvis/workspace/jarvis/...' references behi…`
- [x] `docs/projects/index.md:376` (instance #2) — rename `JARVIS`→rune: `- **Path de-leak:** extract hardcoded '/Users/jarvis/workspace/jarvis/...' references behi…`
- [x] `docs/projects/index.md:377` — rename `jarvis`→rune: `- **Brand + runtime sweep:** rewrite agent-name references across docs, metadata, CI, URLs…`
- [x] `docs/projects/index.md:380` (instance #1) — rename `jarvis`→rune: `- **Task breakdown & test plan:** see [tasks.md](18-rebrand-jarvis-to-rune/tasks.md) and […`
- [x] `docs/projects/index.md:380` (instance #2) — rename `jarvis`→rune: `- **Task breakdown & test plan:** see [tasks.md](18-rebrand-jarvis-to-rune/tasks.md) and […`

### `evals/README.md`

- [x] `evals/README.md:1` — rename `Jarvis`→rune: `# Jarvis Eval Framework`

### `package.json`

- [x] `package.json:9` — rename `jarvis`→rune: `"cli": "tsx --env-file-if-exists=.env.local cli/jarvis.ts",`

### `policies/escalation-policy.json`

- [x] `policies/escalation-policy.json:2` — rename `Jarvis`→rune: `"_comment": "Declarative escalation policy for the intent layer (project 08). Data, not co…`

### `policies/products.json`

- [x] `policies/products.json:5` — rename `jarvis`→rune: `"credentialsFile": "~/.config/jarvis/credentials/aura/.env",`
- [x] `policies/products.json:17` — rename `jarvis`→rune: `"credentialsFile": "~/.config/jarvis/credentials/assay/.env",`
- [x] `policies/products.json:46` — rename `jarvis`→rune: `"credentialsFile": "~/.config/jarvis/credentials/relay/.env",`

### `scripts/dispatch-review.ts`

- [x] `scripts/dispatch-review.ts:58` — rename `jarvis`→rune: `// specific product workflow). Using 'jarvis' / 'review-cross-model' so`
- [x] `scripts/dispatch-review.ts:63` — rename `jarvis`→rune: `product: 'jarvis',`

### `scripts/run-evals.test.ts`

- [x] `scripts/run-evals.test.ts:31` — rename `JARVIS`→rune: `JARVIS_HTTP_SECRET: '',`

### `scripts/run-orchestrated-acceptance.ts`

- [x] `scripts/run-orchestrated-acceptance.ts:8` — rename `jarvis`→rune: `// real path: sandboxed worktree (resume if 'jarvis-work/<slug>' already`
- [x] `scripts/run-orchestrated-acceptance.ts:11` — rename `Jarvis`→rune: `// claude), Jarvis-owned closeout commits, and the deliberate finalizer hold.`
- [x] `scripts/run-orchestrated-acceptance.ts:39` — rename `jarvis`→rune: `const product = argValue('--product') ?? 'jarvis';`

### `src/ai/claude-workspace.test.ts`

- [x] `src/ai/claude-workspace.test.ts:19` — rename `jarvis`→rune: `MODEL_POLICY_FILE: '/tmp/jarvis-nonexistent-model-policy.json',`
- [x] `src/ai/claude-workspace.test.ts:79` — rename `JARVIS`→rune: `it('sets JARVIS_WORKSPACE_DIR in child process env when WORKSPACE_DIR is configured', asyn…`
- [x] `src/ai/claude-workspace.test.ts:83` — rename `JARVIS`→rune: `expect(spawnEnv['JARVIS_WORKSPACE_DIR']).toBe('/home/user/workspace');`
- [x] `src/ai/claude-workspace.test.ts:86` — rename `JARVIS`→rune: `it('always sets JARVIS_PROJECT_ROOT regardless of WORKSPACE_DIR', async () => {`
- [x] `src/ai/claude-workspace.test.ts:90` — rename `JARVIS`→rune: `expect(spawnEnv['JARVIS_PROJECT_ROOT']).toBe('/tmp/test-project');`

### `src/ai/claude.test.ts`

- [x] `src/ai/claude.test.ts:933` — rename `JARVIS`→rune: `it('does not set JARVIS_WORKSPACE_DIR when WORKSPACE_DIR is empty', async () => {`
- [x] `src/ai/claude.test.ts:937` — rename `JARVIS`→rune: `expect(spawnEnv).not.toHaveProperty('JARVIS_WORKSPACE_DIR');`

### `src/ai/claude.ts`

- [x] `src/ai/claude.ts:497` — rename `Jarvis`→rune: `*  Jarvis's own .claude/agents/ is checked first (generic, public, versioned with code);`
- [x] `src/ai/claude.ts:504` — rename `jarvis`→rune: `const jarvisPath = join(PROJECT_ROOT, '.claude', 'agents', '${agentName}.md');`
- [x] `src/ai/claude.ts:510` — rename `jarvis`→rune: `raw = readFileSync(jarvisPath, 'utf8');`
- [x] `src/ai/claude.ts:511` — rename `jarvis`→rune: `filePath = jarvisPath;`
- [x] `src/ai/claude.ts:555` — rename `Jarvis`→rune: `*  (not nested). Good enough for Jarvis's flat frontmatter schema. */`

### `src/ai/codex.ts`

- [x] `src/ai/codex.ts:57` — rename `Jarvis`→rune: `*  Jarvis must boot and serve Claude-backed features on machines without`
- [x] `src/ai/codex.ts:191` — rename `Jarvis`→rune: `*  not rely on the default — the default leaks every Jarvis secret`
- [x] `src/ai/codex.ts:192` — rename `JARVIS`→rune: `*  (TELEGRAM_BOT_TOKEN, JARVIS_HTTP_SECRET, …) into the product child,`
- [x] `src/ai/codex.ts:194` — rename `Jarvis`→rune: `*  enforces. Non-sandboxed callers (internal Jarvis dispatches) keep`

### `src/bot/commands/approve.test.ts`

- [x] `src/bot/commands/approve.test.ts:56` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/bot/commands/approve.test.ts:59` — rename `jarvis`→rune: `artifact: { product: 'jarvis', title: 'Test Project', spec: 'A spec.', tasks: 'tasks', tes…`

### `src/bot/commands/approve.ts`

- [x] `src/bot/commands/approve.ts:63` — rename `Jarvis`→rune: `'No spec proposed yet — keep scoping until Jarvis proposes one.',`

### `src/bot/commands/clear.test.ts`

- [x] `src/bot/commands/clear.test.ts:102` — rename `jarvis`→rune: `const scope = { kind: 'product', product: 'jarvis' };`
- [x] `src/bot/commands/clear.test.ts:125` — rename `jarvis`→rune: `product: 'jarvis',`

### `src/bot/commands/done-workout.test.ts`

- [x] `src/bot/commands/done-workout.test.ts:15` — rename `jarvis`→rune: `const logsTmpDir = jn(td(), 'jarvis-done-workout-logs-${Date.now()}');`

### `src/bot/commands/fresh-full.test.ts`

- [x] `src/bot/commands/fresh-full.test.ts:116` — rename `jarvis`→rune: `expect(entry).toContain('[[jarvis]]');`
- [x] `src/bot/commands/fresh-full.test.ts:118` — rename `Jarvis`→rune: `expect(entry).toContain('[Jarvis]');`
- [x] `src/bot/commands/fresh-full.test.ts:174` — rename `Jarvis`→rune: `expect(entry).toContain('\t- [Jarvis] Line one');`
- [x] `src/bot/commands/fresh-full.test.ts:191` — rename `jarvis`→rune: `expect(entry).toContain('[[jarvis]] webview chat (full transcript)');`
- [x] `src/bot/commands/fresh-full.test.ts:205` — rename `jarvis`→rune: `expect(entry).toContain('[[jarvis]] telegram chat (full transcript)');`

### `src/bot/commands/fresh-full.ts`

- [x] `src/bot/commands/fresh-full.ts:19` — rename `Jarvis`→rune: `const label = role === 'user' ? 'Me' : 'Jarvis';`
- [x] `src/bot/commands/fresh-full.ts:56` — rename `jarvis`→rune: `const entry = '- ${ts} [[jarvis]] ${transportLabel(transport)} (full transcript)\n${transc…`

### `src/bot/commands/fresh.integration.test.ts`

- [x] `src/bot/commands/fresh.integration.test.ts:7` — rename `jarvis`→rune: `const tmpDir = join(tmpdir(), 'jarvis-fresh-int-${Date.now()}');`
- [x] `src/bot/commands/fresh.integration.test.ts:189` — rename `jarvis`→rune: `expect(journalContent).toContain('[[jarvis]] telegram chat');`

### `src/bot/commands/fresh.test.ts`

- [x] `src/bot/commands/fresh.test.ts:203` — rename `jarvis`→rune: `const scope = { kind: 'product', product: 'jarvis' };`
- [x] `src/bot/commands/fresh.test.ts:229` — rename `jarvis`→rune: `expect(entry).toContain('[[jarvis]] webview chat');`
- [x] `src/bot/commands/fresh.test.ts:243` — rename `jarvis`→rune: `expect(entry).toContain('[[jarvis]] telegram chat');`
- [x] `src/bot/commands/fresh.test.ts:281` — rename `jarvis`→rune: `const scope = { kind: 'product', product: 'jarvis' };`
- [x] `src/bot/commands/fresh.test.ts:349` — rename `jarvis`→rune: `expect(entry).toContain('[[jarvis]]');`

### `src/bot/commands/fresh.ts`

- [x] `src/bot/commands/fresh.ts:69` — rename `jarvis`→rune: `const entry = '- ${ts} [[jarvis]] ${transportLabel(transport)}\n${summaryLines}';`

### `src/bot/commands/journal.test.ts`

- [x] `src/bot/commands/journal.test.ts:61` — rename `jarvis`→rune: `expect(entry).toContain('[[jarvis]] telegram chat');`
- [x] `src/bot/commands/journal.test.ts:72` — rename `jarvis`→rune: `expect(entry).toContain('[[jarvis]] webview chat');`
- [x] `src/bot/commands/journal.test.ts:118` — rename `jarvis`→rune: `const scope = { kind: 'product', product: 'jarvis' };`

### `src/bot/commands/journal.ts`

- [x] `src/bot/commands/journal.ts:19` — rename `jarvis`→rune: `const entry = '- ${ts} [[jarvis]] ${transportLabel(transport)}\n\t- ${text}';`

### `src/bot/commands/learn-list.test.ts`

- [x] `src/bot/commands/learn-list.test.ts:8` — rename `jarvis`→rune: `const tmpDir = join(tmpdir(), 'jarvis-learn-list-test-${Date.now()}');`

### `src/bot/commands/learn.test.ts`

- [x] `src/bot/commands/learn.test.ts:7` — rename `jarvis`→rune: `const tmpDir = join(tmpdir(), 'jarvis-learn-test-${Date.now()}');`

### `src/bot/commands/plan.test.ts`

- [x] `src/bot/commands/plan.test.ts:52` — rename `jarvis`→rune: `name: 'jarvis',`
- [x] `src/bot/commands/plan.test.ts:137` — rename `jarvis`→rune: `expect(reply).toContain('jarvis');`
- [x] `src/bot/commands/plan.test.ts:158` — rename `jarvis`→rune: `expect(reply).toContain('jarvis');`

### `src/bot/commands/workout.test.ts`

- [x] `src/bot/commands/workout.test.ts:15` — rename `jarvis`→rune: `const vaultTmpDir = jn(td(), 'jarvis-workout-vault-${Date.now()}');`
- [x] `src/bot/commands/workout.test.ts:16` — rename `jarvis`→rune: `const logsTmpDir = jn(td(), 'jarvis-workout-logs-${Date.now()}');`

### `src/bot/handlers/url.ts`

- [x] `src/bot/handlers/url.ts:64` — rename `Jarvis`→rune: `headers: { 'User-Agent': 'Jarvis/1.0 (Personal Knowledge Bot)' },`

### `src/bot/skill-registry.test.ts`

- [x] `src/bot/skill-registry.test.ts:104` — rename `Jarvis`→rune: `// visibility into Jarvis's most commonly-used capabilities.`
- [x] `src/bot/skill-registry.test.ts:178` — rename `Jarvis`→rune: `it('dedupes agents by filename stem with Jarvis dir winning over vault', () => {`

### `src/bot/skill-registry.ts`

- [x] `src/bot/skill-registry.ts:225` — rename `Jarvis`→rune: `/** Scan Jarvis + vault '.claude/agents/' for agents with 'triggers:' frontmatter`
- [x] `src/bot/skill-registry.ts:227` — rename `Jarvis`→rune: `*  frontmatter edits. Jarvis-first precedence matches loadAgentDef.`

### `src/index-startup-recovery.test.ts`

- [x] `src/index-startup-recovery.test.ts:16` — rename `jarvis`→rune: `PROJECT_ROOT: '/tmp/jarvis',`
- [x] `src/index-startup-recovery.test.ts:18` — rename `jarvis`→rune: `LOGS_DIR: '/tmp/jarvis/logs',`
- [x] `src/index-startup-recovery.test.ts:19` — rename `jarvis`→rune: `WORKTREE_ROOT: '/tmp/jarvis/worktrees',`
- [x] `src/index-startup-recovery.test.ts:20` — rename `jarvis`→rune: `PRODUCTS_CONFIG_FILE: '/tmp/jarvis/products.json',`
- [x] `src/index-startup-recovery.test.ts:21` — rename `jarvis`→rune: `WORK_RUNS_DIR: '/tmp/jarvis/work-runs',`
- [x] `src/index-startup-recovery.test.ts:22` — rename `jarvis`→rune: `SUPERVISED_RUNS_FILE: '/tmp/jarvis/supervised-runs.json',`
- [x] `src/index-startup-recovery.test.ts:27` — rename `JARVIS`→rune: `JARVIS_HTTP_SECRET: '',`
- [x] `src/index-startup-recovery.test.ts:161` — rename `jarvis`→rune: `supervisedRunsFile: '/tmp/jarvis/supervised-runs.json',`
- [x] `src/index-startup-recovery.test.ts:162` — rename `jarvis`→rune: `workRunsDir: '/tmp/jarvis/work-runs',`

### `src/integrations/whoop/keychain.test.ts`

- [x] `src/integrations/whoop/keychain.test.ts:33` — rename `jarvis`→rune: `['find-generic-password', '-s', 'jarvis-whoop', '-a', 'access-token', '-w'],`
- [x] `src/integrations/whoop/keychain.test.ts:53` — rename `jarvis`→rune: `'delete-generic-password', '-s', 'jarvis-whoop', '-a', 'access-token',`
- [x] `src/integrations/whoop/keychain.test.ts:57` — rename `jarvis`→rune: `'add-generic-password', '-s', 'jarvis-whoop', '-a', 'access-token', '-w', 'new-value',`
- [x] `src/integrations/whoop/keychain.test.ts:102` — rename `jarvis`→rune: `['delete-generic-password', '-s', 'jarvis-whoop', '-a', 'access-token'],`

### `src/integrations/whoop/keychain.ts`

- [x] `src/integrations/whoop/keychain.ts:6` — rename `jarvis`→rune: `const SERVICE = 'jarvis-whoop';`

### `src/intent/backlog-id.test.ts`

- [x] `src/intent/backlog-id.test.ts:119` (instance #1) — rename `jarvis`→rune: `// jarvis at /Users/x/workspace/jarvis and aura at /Users/x/workspace/aura — both hold a`
- [x] `src/intent/backlog-id.test.ts:119` (instance #2) — rename `jarvis`→rune: `// jarvis at /Users/x/workspace/jarvis and aura at /Users/x/workspace/aura — both hold a`
- [x] `src/intent/backlog-id.test.ts:123` — rename `jarvis`→rune: `const jarvisItem = computeBacklogId({`
- [x] `src/intent/backlog-id.test.ts:135` — rename `jarvis`→rune: `expect(jarvisItem).toBe(auraItem);`

### `src/intent/backlog-reader.test.ts`

- [x] `src/intent/backlog-reader.test.ts:104` — rename `jarvis`→rune: `scaffoldRepo(root, 'jarvis', {`
- [x] `src/intent/backlog-reader.test.ts:115` — rename `jarvis`→rune: `{ name: 'jarvis', repoBacked: true },`
- [x] `src/intent/backlog-reader.test.ts:118` (instance #1) — rename `jarvis`→rune: `configWith({ jarvis: join(root, 'jarvis'), aura: join(root, 'aura') }),`
- [x] `src/intent/backlog-reader.test.ts:118` (instance #2) — rename `jarvis`→rune: `configWith({ jarvis: join(root, 'jarvis'), aura: join(root, 'aura') }),`
- [x] `src/intent/backlog-reader.test.ts:124` (instance #1) — rename `jarvis`→rune: `const jarvis = byProduct(result, 'jarvis');`
- [x] `src/intent/backlog-reader.test.ts:124` (instance #2) — rename `jarvis`→rune: `const jarvis = byProduct(result, 'jarvis');`
- [x] `src/intent/backlog-reader.test.ts:125` — rename `jarvis`→rune: `expect(jarvis.notRepoBacked).toBe(false);`
- [x] `src/intent/backlog-reader.test.ts:126` — rename `jarvis`→rune: `expect(jarvis.bugs.map((b) => b.text)).toEqual([`
- [x] `src/intent/backlog-reader.test.ts:130` — rename `jarvis`→rune: `expect(jarvis.bugs[1]!.status).toBe('done');`
- [x] `src/intent/backlog-reader.test.ts:131` — rename `jarvis`→rune: `expect(jarvis.ideas.map((i) => i.text)).toEqual(['Some idea']);`
- [x] `src/intent/backlog-reader.test.ts:132` — rename `jarvis`→rune: `expect(jarvis.fileWarnings).toEqual([]);`
- [x] `src/intent/backlog-reader.test.ts:141` — rename `jarvis`→rune: `scaffoldRepo(root, 'jarvis', { bugs: '- [ ] A bug\n' });`
- [x] `src/intent/backlog-reader.test.ts:144` — rename `jarvis`→rune: `registryWith([{ name: 'jarvis', repoBacked: true }]),`
- [x] `src/intent/backlog-reader.test.ts:145` (instance #1) — rename `jarvis`→rune: `configWith({ jarvis: join(root, 'jarvis') }),`
- [x] `src/intent/backlog-reader.test.ts:145` (instance #2) — rename `jarvis`→rune: `configWith({ jarvis: join(root, 'jarvis') }),`
- [x] `src/intent/backlog-reader.test.ts:149` — rename `jarvis`→rune: `const bug = byProduct(result, 'jarvis').bugs[0]!;`
- [x] `src/intent/backlog-reader.test.ts:158` — rename `jarvis`→rune: `scaffoldRepo(root, 'jarvis', { bugs: '- [ ] Shared bug text\n' });`
- [x] `src/intent/backlog-reader.test.ts:163` — rename `jarvis`→rune: `{ name: 'jarvis', repoBacked: true },`
- [x] `src/intent/backlog-reader.test.ts:166` (instance #1) — rename `jarvis`→rune: `configWith({ jarvis: join(root, 'jarvis'), aura: join(root, 'aura') }),`
- [x] `src/intent/backlog-reader.test.ts:166` (instance #2) — rename `jarvis`→rune: `configWith({ jarvis: join(root, 'jarvis'), aura: join(root, 'aura') }),`
- [x] `src/intent/backlog-reader.test.ts:172` — rename `jarvis`→rune: `expect(byProduct(result, 'jarvis').bugs[0]!.id).toBe(byProduct(result, 'aura').bugs[0]!.id…`
- [x] `src/intent/backlog-reader.test.ts:198` — rename `jarvis`→rune: `mkdirSync(join(root, 'jarvis', 'docs', 'projects'), { recursive: true });`
- [x] `src/intent/backlog-reader.test.ts:201` — rename `jarvis`→rune: `registryWith([{ name: 'jarvis', repoBacked: true }]),`
- [x] `src/intent/backlog-reader.test.ts:202` (instance #1) — rename `jarvis`→rune: `configWith({ jarvis: join(root, 'jarvis') }),`
- [x] `src/intent/backlog-reader.test.ts:202` (instance #2) — rename `jarvis`→rune: `configWith({ jarvis: join(root, 'jarvis') }),`
- [x] `src/intent/backlog-reader.test.ts:206` (instance #1) — rename `jarvis`→rune: `const jarvis = byProduct(result, 'jarvis');`
- [x] `src/intent/backlog-reader.test.ts:206` (instance #2) — rename `jarvis`→rune: `const jarvis = byProduct(result, 'jarvis');`
- [x] `src/intent/backlog-reader.test.ts:207` — rename `jarvis`→rune: `expect(jarvis.bugs).toEqual([]);`
- [x] `src/intent/backlog-reader.test.ts:208` — rename `jarvis`→rune: `expect(jarvis.ideas).toEqual([]);`
- [x] `src/intent/backlog-reader.test.ts:209` — rename `jarvis`→rune: `expect(jarvis.fileWarnings).toEqual([]);`
- [x] `src/intent/backlog-reader.test.ts:210` — rename `jarvis`→rune: `expect(jarvis.notRepoBacked).toBe(false);`
- [x] `src/intent/backlog-reader.test.ts:215` — rename `jarvis`→rune: `const repoPath = join(root, 'jarvis');`
- [x] `src/intent/backlog-reader.test.ts:222` — rename `jarvis`→rune: `registryWith([{ name: 'jarvis', repoBacked: true }]),`
- [x] `src/intent/backlog-reader.test.ts:223` — rename `jarvis`→rune: `configWith({ jarvis: repoPath }),`
- [x] `src/intent/backlog-reader.test.ts:227` (instance #1) — rename `jarvis`→rune: `const jarvis = byProduct(result, 'jarvis');`
- [x] `src/intent/backlog-reader.test.ts:227` (instance #2) — rename `jarvis`→rune: `const jarvis = byProduct(result, 'jarvis');`
- [x] `src/intent/backlog-reader.test.ts:228` — rename `jarvis`→rune: `expect(jarvis.bugs).toEqual([]);`
- [x] `src/intent/backlog-reader.test.ts:231` — rename `jarvis`→rune: `expect(hasWarning(jarvis, 'unreadable-file')).toBe(true);`
- [x] `src/intent/backlog-reader.test.ts:233` — rename `jarvis`→rune: `expect(jarvis.ideas.map((i) => i.text)).toEqual(['ok idea']);`
- [x] `src/intent/backlog-reader.test.ts:240` — rename `jarvis`→rune: `scaffoldRepo(root, 'jarvis', {`
- [x] `src/intent/backlog-reader.test.ts:246` — rename `jarvis`→rune: `registryWith([{ name: 'jarvis', repoBacked: true }]),`
- [x] `src/intent/backlog-reader.test.ts:247` (instance #1) — rename `jarvis`→rune: `configWith({ jarvis: join(root, 'jarvis') }),`
- [x] `src/intent/backlog-reader.test.ts:247` (instance #2) — rename `jarvis`→rune: `configWith({ jarvis: join(root, 'jarvis') }),`
- [x] `src/intent/backlog-reader.test.ts:251` (instance #1) — rename `jarvis`→rune: `const jarvis = byProduct(result, 'jarvis');`
- [x] `src/intent/backlog-reader.test.ts:251` (instance #2) — rename `jarvis`→rune: `const jarvis = byProduct(result, 'jarvis');`
- [x] `src/intent/backlog-reader.test.ts:252` — rename `jarvis`→rune: `expect(jarvis.bugs.map((b) => b.text)).toEqual(['top bug']);`
- [x] `src/intent/backlog-reader.test.ts:253` — rename `jarvis`→rune: `expect(jarvis.fileWarnings.map((w) => '${w.file}:${w.code}')).toEqual([`
- [x] `src/intent/backlog-reader.test.ts:262` — rename `jarvis`→rune: `return { product: 'jarvis', notRepoBacked: false, bugs: [], ideas: [], fileWarnings: [], .…`
- [x] `src/intent/backlog-reader.test.ts:267` — rename `jarvis`→rune: `scaffoldRepo(root, 'jarvis', {`
- [x] `src/intent/backlog-reader.test.ts:272` — rename `jarvis`→rune: `registryWith([{ name: 'jarvis', repoBacked: true }]),`
- [x] `src/intent/backlog-reader.test.ts:273` (instance #1) — rename `jarvis`→rune: `configWith({ jarvis: join(root, 'jarvis') }),`
- [x] `src/intent/backlog-reader.test.ts:273` (instance #2) — rename `jarvis`→rune: `configWith({ jarvis: join(root, 'jarvis') }),`
- [x] `src/intent/backlog-reader.test.ts:294` — rename `jarvis`→rune: `const repoPath = join(root, 'jarvis');`
- [x] `src/intent/backlog-reader.test.ts:303` — rename `jarvis`→rune: `registryWith([{ name: 'jarvis', repoBacked: true }]),`
- [x] `src/intent/backlog-reader.test.ts:304` — rename `jarvis`→rune: `configWith({ jarvis: repoPath }),`
- [x] `src/intent/backlog-reader.test.ts:308` (instance #1) — rename `jarvis`→rune: `const jarvis = byProduct(result, 'jarvis');`
- [x] `src/intent/backlog-reader.test.ts:308` (instance #2) — rename `jarvis`→rune: `const jarvis = byProduct(result, 'jarvis');`
- [x] `src/intent/backlog-reader.test.ts:309` — rename `jarvis`→rune: `expect(jarvis.bugs).toEqual([]);`
- [x] `src/intent/backlog-reader.test.ts:310` — rename `jarvis`→rune: `expect(hasWarning(jarvis, 'symlink-escape')).toBe(true);`
- [x] `src/intent/backlog-reader.test.ts:312` — rename `jarvis`→rune: `expect(JSON.stringify(jarvis.bugs)).not.toContain('exfiltrated');`
- [x] `src/intent/backlog-reader.test.ts:323` — rename `jarvis`→rune: `const repoPath = join(workspaceRoot, 'jarvis');`
- [x] `src/intent/backlog-reader.test.ts:331` — rename `jarvis`→rune: `registryWith([{ name: 'jarvis', repoBacked: true }]),`
- [x] `src/intent/backlog-reader.test.ts:332` — rename `jarvis`→rune: `configWith({ jarvis: repoPath }),`
- [x] `src/intent/backlog-reader.test.ts:336` (instance #1) — rename `jarvis`→rune: `const jarvis = byProduct(result, 'jarvis');`
- [x] `src/intent/backlog-reader.test.ts:336` (instance #2) — rename `jarvis`→rune: `const jarvis = byProduct(result, 'jarvis');`
- [x] `src/intent/backlog-reader.test.ts:337` — rename `jarvis`→rune: `expect(jarvis.bugs).toEqual([]);`
- [x] `src/intent/backlog-reader.test.ts:338` — rename `jarvis`→rune: `expect(hasWarning(jarvis, 'symlink-escape')).toBe(true);`
- [x] `src/intent/backlog-reader.test.ts:339` — rename `jarvis`→rune: `expect(JSON.stringify(jarvis.bugs)).not.toContain('exfiltrated');`
- [x] `src/intent/backlog-reader.test.ts:345` — rename `jarvis`→rune: `const repoPath = scaffoldRepo(outsideRoot, 'jarvis', { bugs: '- [ ] off-limits bug\n' });`
- [x] `src/intent/backlog-reader.test.ts:348` — rename `jarvis`→rune: `registryWith([{ name: 'jarvis', repoBacked: true }]),`
- [x] `src/intent/backlog-reader.test.ts:349` — rename `jarvis`→rune: `configWith({ jarvis: repoPath }),`
- [x] `src/intent/backlog-reader.test.ts:353` (instance #1) — rename `jarvis`→rune: `const jarvis = byProduct(result, 'jarvis');`
- [x] `src/intent/backlog-reader.test.ts:353` (instance #2) — rename `jarvis`→rune: `const jarvis = byProduct(result, 'jarvis');`
- [x] `src/intent/backlog-reader.test.ts:354` — rename `jarvis`→rune: `expect(jarvis.bugs).toEqual([]);`
- [x] `src/intent/backlog-reader.test.ts:355` — rename `jarvis`→rune: `expect(jarvis.ideas).toEqual([]);`
- [x] `src/intent/backlog-reader.test.ts:356` — rename `jarvis`→rune: `expect(hasWarning(jarvis, 'repo-outside-workspace')).toBe(true);`
- [x] `src/intent/backlog-reader.test.ts:358` — rename `jarvis`→rune: `expect(JSON.stringify(jarvis.bugs)).not.toContain('off-limits');`

### `src/intent/backlog-write-lock.ts`

- [x] `src/intent/backlog-write-lock.ts:42` — rename `Jarvis`→rune: `* This guards only Jarvis's OWN in-process writes; a Claude CLI child (work-run) is a sepa…`

### `src/intent/cockpit-dispatch-mode.test.ts`

- [x] `src/intent/cockpit-dispatch-mode.test.ts:20` — rename `jarvis`→rune: `name: 'jarvis',`

### `src/intent/context-curator.test.ts`

- [x] `src/intent/context-curator.test.ts:2` — rename `Jarvis`→rune: `* Phase 3 test suite for 'src/intent/context-curator.ts' — the Jarvis-owned`

### `src/intent/context-curator.ts`

- [x] `src/intent/context-curator.ts:2` — rename `Jarvis`→rune: `* Context curator — the Jarvis-owned 'context.md' update + validation (project`

### `src/intent/escalation.ts`

- [x] `src/intent/escalation.ts:2` — rename `Jarvis`→rune: `* Escalation policy — a declarative file deciding when Jarvis stops and asks Michael`
- [x] `src/intent/escalation.ts:6` — rename `Jarvis`→rune: `* and merges on its own. That makes one question load-bearing: **when does Jarvis escalate`

### `src/intent/feedback-reader.test.ts`

- [x] `src/intent/feedback-reader.test.ts:44` — rename `jarvis`→rune: `tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-feedback-'));`
- [x] `src/intent/feedback-reader.test.ts:126` — rename `jarvis`→rune: `tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-feedback-proc-'));`
- [x] `src/intent/feedback-reader.test.ts:144` — rename `jarvis`→rune: `tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-feedback-proc-'));`

### `src/intent/feedback-record.test.ts`

- [x] `src/intent/feedback-record.test.ts:95` — rename `jarvis`→rune: `const result = parseFeedbackRecord({ ...minimalRaw(), projectSlug: 'jarvis-14' });`
- [x] `src/intent/feedback-record.test.ts:98` — rename `jarvis`→rune: `expect(VALID_SLUG.test('jarvis-14')).toBe(true);`

### `src/intent/finalizer-handoff.ts`

- [x] `src/intent/finalizer-handoff.ts:4` — rename `Jarvis`→rune: `* When no unchecked tasks remain, Jarvis hands the completed project's branch /`
- [x] `src/intent/finalizer-handoff.ts:26` — rename `jarvis`→rune: `/** The work branch (e.g. 'jarvis-work/14-...'). */`

### `src/intent/gate-learning.test.ts`

- [x] `src/intent/gate-learning.test.ts:6` — rename `Jarvis`→rune: `* structured gate-rejection record; neutral Jarvis validation then privacy-filters,`

### `src/intent/gate-learning.ts`

- [x] `src/intent/gate-learning.ts:7` — rename `Jarvis`→rune: `* -> neutral Jarvis validates/transforms it into a lesson or no-lesson decision`
- [x] `src/intent/gate-learning.ts:26` — rename `Jarvis`→rune: `/** Neutral Jarvis validation accepted and attributed a memory lesson. */`
- [x] `src/intent/gate-learning.ts:34` — rename `Jarvis`→rune: `/** Neutral Jarvis validation declined to write a lesson. */`
- [x] `src/intent/gate-learning.ts:58` — rename `Jarvis`→rune: `/** Neutral Jarvis validation/privacy/dedup attribution step. */`

### `src/intent/home-pulse-deep-view.test.ts`

- [x] `src/intent/home-pulse-deep-view.test.ts:113` — rename `jarvis`→rune: `operatorWorktreePath: '/tmp/jarvis-aura-01-mvp',`
- [x] `src/intent/home-pulse-deep-view.test.ts:139` — rename `jarvis`→rune: `worktreePathFor: vi.fn((product: string, slug: string) => '/tmp/jarvis-${product}-${slug}'…`
- [x] `src/intent/home-pulse-deep-view.test.ts:418` — rename `jarvis`→rune: `worktreePath: '/tmp/jarvis-aura-01-mvp',`
- [x] `src/intent/home-pulse-deep-view.test.ts:560` — rename `jarvis`→rune: `worktreePath: '/tmp/jarvis-aura-b-open',`

### `src/intent/intent-proposal-queue.test.ts`

- [x] `src/intent/intent-proposal-queue.test.ts:26` — rename `jarvis`→rune: `default: { INTENT_PROPOSAL_QUEUE_FILE: '/tmp/jarvis-test-intent-proposal-queue.json' },`

### `src/intent/journal-intent-e2e.test.ts`

- [x] `src/intent/journal-intent-e2e.test.ts:81` — rename `jarvis`→rune: `'- 10am #aura #jarvis cross-cutting friction with the resolver',`
- [x] `src/intent/journal-intent-e2e.test.ts:88` — rename `jarvis`→rune: `notes, roadmapCandidates: [], registeredProducts: ['aura', 'jarvis'],`
- [x] `src/intent/journal-intent-e2e.test.ts:295` — rename `jarvis`→rune: `{ kind: 'disambiguation', note: 'cross-cutting friction', candidates: ['aura', 'jarvis'] }…`

### `src/intent/learning-loop.test.ts`

- [x] `src/intent/learning-loop.test.ts:3` — rename `Jarvis`→rune: `* nightly learning loop that reads feedback records, runs a Jarvis-owned`

### `src/intent/learning-loop.ts`

- [x] `src/intent/learning-loop.ts:7` — rename `Jarvis`→rune: `* DURABLE reason, never silent no-feedback) → run a Jarvis-owned post-mortem`
- [x] `src/intent/learning-loop.ts:42` — rename `Jarvis`→rune: `/** The Jarvis-owned post-mortem decision. */`
- [x] `src/intent/learning-loop.ts:51` — rename `Jarvis`→rune: `/** Jarvis-owned post-mortem: LLM in production, fixture in tests. Decides`
- [x] `src/intent/learning-loop.ts:90` — rename `Jarvis`→rune: `* valid record runs the Jarvis-owned post-mortem: a 'lesson' attribution writes into`

### `src/intent/model-policy.test.ts`

- [x] `src/intent/model-policy.test.ts:224` — rename `jarvis`→rune: `expect(loadModelPolicy('/tmp/jarvis-nonexistent-model-policy.json')).toBeNull();`

### `src/intent/observation-callbacks.test.ts`

- [x] `src/intent/observation-callbacks.test.ts:120` — rename `Jarvis`→rune: `const reply = JSON.stringify({ file: false, reason: 'not Jarvis friction' });`
- [x] `src/intent/observation-callbacks.test.ts:126` — rename `Jarvis`→rune: `expect(out.reason).toBe('not Jarvis friction');`

### `src/intent/observation-ideas-io.test.ts`

- [x] `src/intent/observation-ideas-io.test.ts:26` — rename `jarvis`→rune: `tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-ideas-io-test-'));`

### `src/intent/observation-loop.test.ts`

- [x] `src/intent/observation-loop.test.ts:10` — rename `Jarvis`→rune: `* Jarvis interaction is logged", "synthesis diarizes before the loop reasons", "runs`

### `src/intent/observation-loop.ts`

- [x] `src/intent/observation-loop.ts:2` — rename `Jarvis`→rune: `* Observation loop — Phase 5's operational self-improvement core. Jarvis observes its own`

### `src/intent/observation-sensor-readers.ts`

- [x] `src/intent/observation-sensor-readers.ts:193` — rename `Jarvis`→rune: `// Source: 'logs/agent-runs.jsonl' and 'logs/mutations.jsonl' — Jarvis's`
- [x] `src/intent/observation-sensor-readers.ts:200` — rename `Jarvis`→rune: `// sink we don't have yet. The wedge here is Jarvis's own observability;`

### `src/intent/observation-sensor.test.ts`

- [x] `src/intent/observation-sensor.test.ts:12` — rename `Jarvis`→rune: `* every Jarvis call site is genuine multi-file integration, separately handled.`

### `src/intent/observation-sensor.ts`

- [x] `src/intent/observation-sensor.ts:4` — rename `Jarvis`→rune: `* vault signals, product telemetry, and logged Jarvis interactions (successful or not).`
- [x] `src/intent/observation-sensor.ts:9` — rename `Jarvis`→rune: `* that appends an 'InteractionLogRecord' from every Jarvis call site (Telegram handlers,`
- [x] `src/intent/observation-sensor.ts:22` — rename `Jarvis`→rune: `* A log record for one Jarvis interaction — Telegram message, agent invocation, command`

### `src/intent/orch-execution.test.ts`

- [x] `src/intent/orch-execution.test.ts:182` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/intent/orch-execution.test.ts:183` — rename `jarvis`→rune: `branch: 'jarvis-work/14-x',`
- [x] `src/intent/orch-execution.test.ts:187` — rename `jarvis`→rune: `expect(h.branch).toBe('jarvis-work/14-x');`
- [x] `src/intent/orch-execution.test.ts:201` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/intent/orch-execution.test.ts:216` — rename `jarvis`→rune: `product: 'jarvis',`

### `src/intent/orch-reconstruct.ts`

- [x] `src/intent/orch-reconstruct.ts:4` — rename `Jarvis`→rune: `* After a crash/restart, Jarvis rebuilds where a project run stood from durable`

### `src/intent/orch-run-record.ts`

- [x] `src/intent/orch-run-record.ts:4` — rename `Jarvis`→rune: `* One record per task attempt — the durable, truthful evidence Jarvis keeps for`

### `src/intent/orch-task-select.ts`

- [x] `src/intent/orch-task-select.ts:2` — rename `Jarvis`→rune: `* Jarvis-owned task selection (project 14, Phase 3).`

### `src/intent/plan-e2e.test.ts`

- [x] `src/intent/plan-e2e.test.ts:51` — rename `jarvis`→rune: `id: 'promo-e2e', product: 'jarvis', backlogItemId: 'b-e2e',`
- [x] `src/intent/plan-e2e.test.ts:85` — rename `jarvis`→rune: `id: 'promo-retry', product: 'jarvis', backlogItemId: 'b-retry',`

### `src/intent/planner.ts`

- [x] `src/intent/planner.ts:46` — rename `Jarvis`→rune: `/** Jarvis-seeded orchestration 'context.md' (project 14). Written`
- [x] `src/intent/planner.ts:144` — rename `Jarvis`→rune: `* repo's 'docs/projects/' — Jarvis is just one product — and to emit a 'scaffold-result'`
- [x] `src/intent/planner.ts:147` — rename `Jarvis`→rune: `* Jarvis-workspace-scoped brief.`
- [x] `src/intent/planner.ts:168` — rename `Jarvis`→rune: `'not necessarily Jarvis. Determine the next project number from that repo's ' +`

### `src/intent/planning-critique.test.ts`

- [x] `src/intent/planning-critique.test.ts:9` — rename `Jarvis`→rune: `* The critique is a Jarvis-owned NEUTRAL step (not a seventh role): a pure`

### `src/intent/planning-critique.ts`

- [x] `src/intent/planning-critique.ts:9` — rename `Jarvis`→rune: `* This is a Jarvis-owned NEUTRAL step, not a seventh role — like the`
- [x] `src/intent/planning-critique.ts:10` — rename `Jarvis`→rune: `* learning-loop post-mortem, Jarvis runs it over the role artifacts (PM-owned`

### `src/intent/planning-roles-wiring.test.ts`

- [x] `src/intent/planning-roles-wiring.test.ts:141` — rename `Jarvis`→rune: `'# QA exemplar for Jarvis',`
- [x] `src/intent/planning-roles-wiring.test.ts:217` — rename `jarvis`→rune: `const result = await defaultPlanningRoleDeps(call).pmAssessAndSpec({ brief: 'cockpit', pro…`
- [x] `src/intent/planning-roles-wiring.test.ts:258` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/intent/planning-roles-wiring.test.ts:284` — rename `jarvis`→rune: `const result = await defaultPlanningRoleDeps(call).techLeadBreakdown({ brief: 'x', product…`
- [x] `src/intent/planning-roles-wiring.test.ts:296` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/intent/planning-roles-wiring.test.ts:307` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/intent/planning-roles-wiring.test.ts:319` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/intent/planning-roles-wiring.test.ts:336` — rename `jarvis`→rune: `product: 'jarvis',`

### `src/intent/planning-roles-wiring.ts`

- [x] `src/intent/planning-roles-wiring.ts:342` — rename `Jarvis`→rune: `// Planning critique pass (Phase 9) — Jarvis-owned neutral cross-model step`
- [x] `src/intent/planning-roles-wiring.ts:496` — rename `Jarvis`→rune: `// Jarvis's Telegram/HTTP secrets — pass only what the Codex CLI itself needs.`
- [x] `src/intent/planning-roles-wiring.ts:610` — rename `Jarvis`→rune: `// Phase 9: the Jarvis-owned cross-model critique pass (Claude → Codex,`

### `src/intent/planning-roles.test.ts`

- [x] `src/intent/planning-roles.test.ts:12` — rename `Jarvis`→rune: `* underspecified path that asserts Jarvis blocks rather than fabricating a spec."`

### `src/intent/planning-roles.ts`

- [x] `src/intent/planning-roles.ts:11` — rename `Jarvis`→rune: `*           → Jarvis seeds context.md`
- [x] `src/intent/planning-roles.ts:113` — rename `Jarvis`→rune: `/** Phase 9: the Jarvis-owned cross-model critique pass — runs AFTER the`

### `src/intent/postmortem.test.ts`

- [x] `src/intent/postmortem.test.ts:2` — rename `Jarvis`→rune: `* Phase 6 test suite for 'src/intent/postmortem.ts' — the Jarvis-owned post-mortem`
- [x] `src/intent/postmortem.test.ts:9` — rename `JARVIS`→rune: `* The post-mortem is JARVIS-owned, not a role: a neutral LLM call (injected 'ask'`

### `src/intent/postmortem.ts`

- [x] `src/intent/postmortem.ts:2` — rename `Jarvis`→rune: `* Jarvis-owned post-mortem (project 14, Phase 6).`
- [x] `src/intent/postmortem.ts:6` — rename `JARVIS`→rune: `* "no lesson warranted". The post-mortem is JARVIS-owned, not a role: a neutral LLM`
- [x] `src/intent/postmortem.ts:8` — rename `Jarvis`→rune: `* parses and validates deterministically. Jarvis makes the attribution call; the`
- [x] `src/intent/postmortem.ts:66` — rename `Jarvis`→rune: `'You are Jarvis running a neutral engineering post-mortem on ONE piece of feedback',`
- [x] `src/intent/postmortem.ts:139` — rename `Jarvis`→rune: `/** Run the Jarvis-owned post-mortem for one record. Builds the prompt, calls the`

### `src/intent/product-routing.test.ts`

- [x] `src/intent/product-routing.test.ts:36` — rename `jarvis`→rune: `return ['aura', 'assay', 'jarvis', 'relay'];`
- [x] `src/intent/product-routing.test.ts:116` (instance #1) — rename `JARVIS`→rune: `expect(resolveProductTarget('JARVIS', knownProducts)).toMatchObject({ product: 'jarvis', r…`
- [x] `src/intent/product-routing.test.ts:116` (instance #2) — rename `jarvis`→rune: `expect(resolveProductTarget('JARVIS', knownProducts)).toMatchObject({ product: 'jarvis', r…`
- [x] `src/intent/product-routing.test.ts:184` — rename `jarvis`→rune: `tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-product-routing-test-'));`

### `src/intent/project-14-closeout.test.ts`

- [x] `src/intent/project-14-closeout.test.ts:105` — rename `jarvis`→rune: `name: 'jarvis',`

### `src/intent/project-context.test.ts`

- [x] `src/intent/project-context.test.ts:8` — rename `Jarvis`→rune: `* 'context.md' is Jarvis-owned orchestration state, NOT role memory and NOT a`

### `src/intent/project-context.ts`

- [x] `src/intent/project-context.ts:4` — rename `Jarvis`→rune: `* 'docs/projects/<project>/context.md' is Jarvis-owned ORCHESTRATION STATE that`
- [x] `src/intent/project-context.ts:8` — rename `Jarvis`→rune: `* Jarvis's context curator owns every write.`
- [x] `src/intent/project-context.ts:105` — rename `Jarvis`→rune: `'> Owned by Jarvis\'s context curator — roles read a bounded slice and emit handoff',`

### `src/intent/project-orchestrator.test.ts`

- [x] `src/intent/project-orchestrator.test.ts:10` — rename `Jarvis`→rune: `* ready-for-closeout, perform Jarvis-owned closeout (context update + tick`
- [x] `src/intent/project-orchestrator.test.ts:100` — rename `jarvis`→rune: `branch: 'jarvis-work/14-x',`
- [x] `src/intent/project-orchestrator.test.ts:179` — rename `jarvis`→rune: `expect(raw['branch'] ?? handoff['branch']).toBe('jarvis-work/14-x');`
- [x] `src/intent/project-orchestrator.test.ts:199` — rename `jarvis`→rune: `expect(raw['branch'] ?? handoff['branch']).toBe('jarvis-work/14-x');`
- [x] `src/intent/project-orchestrator.test.ts:253` — rename `jarvis`→rune: `const worktreePath = '/tmp/jarvis-worktrees/aura/14-dirty-worktree';`
- [x] `src/intent/project-orchestrator.test.ts:335` — rename `jarvis`→rune: `const worktreePath = '/tmp/jarvis-worktrees/aura/14-malformed-gate-output';`
- [x] `src/intent/project-orchestrator.test.ts:609` — rename `jarvis`→rune: `const worktreePath = '/tmp/jarvis-worktrees/aura/14-x';`
- [x] `src/intent/project-orchestrator.test.ts:642` — rename `jarvis`→rune: `const worktreePath = '/tmp/jarvis-worktrees/aura/14-x-${severity}';`
- [x] `src/intent/project-orchestrator.test.ts:684` — rename `jarvis`→rune: `const worktreePath = '/tmp/jarvis-worktrees/aura/14-x-objection-open';`
- [x] `src/intent/project-orchestrator.test.ts:765` — rename `jarvis`→rune: `const worktreePath = '/tmp/jarvis-worktrees/aura/14-non-reversible-terminal';`
- [x] `src/intent/project-orchestrator.test.ts:898` — rename `jarvis`→rune: `branch: 'jarvis-work/14-x',`
- [x] `src/intent/project-orchestrator.test.ts:993` — rename `jarvis`→rune: `const worktreePath = '/tmp/jarvis-worktrees/aura/14-x';`
- [x] `src/intent/project-orchestrator.test.ts:1043` — rename `jarvis`→rune: `branch: 'jarvis-work/14-x',`
- [x] `src/intent/project-orchestrator.test.ts:1280` — rename `jarvis`→rune: `const worktreePath = '/tmp/jarvis-worktrees/aura/14-recording-failure';`
- [x] `src/intent/project-orchestrator.test.ts:1342` — rename `jarvis`→rune: `const worktreePath = '/tmp/jarvis-worktrees/aura/14-acceptance-recording-failure';`
- [x] `src/intent/project-orchestrator.test.ts:1398` — rename `Jarvis`→rune: `// Terminal bug recording — unresolved >low findings become Jarvis bugs`
- [x] `src/intent/project-orchestrator.test.ts:1471` — rename `Jarvis`→rune: `it('writes one detailed Jarvis bugs.md entry per remaining open >low finding before finali…`
- [x] `src/intent/project-orchestrator.test.ts:1680` — rename `jarvis`→rune: `expect(handoffBranch).toBe('jarvis-work/14-x');`
- [x] `src/intent/project-orchestrator.test.ts:1691` — rename `jarvis`→rune: `expect(res.handoff.branch).toBe('jarvis-work/14-x');`
- [x] `src/intent/project-orchestrator.test.ts:1699` — rename `jarvis`→rune: `const worktreePath = '/tmp/jarvis-worktrees/aura/14-closeout-checks';`

### `src/intent/project-orchestrator.ts`

- [x] `src/intent/project-orchestrator.ts:4` — rename `Jarvis`→rune: `* Jarvis owns the project loop. It ties the Phase 3/4 substrate together:`
- [x] `src/intent/project-orchestrator.ts:10` — rename `Jarvis`→rune: `*     on ready-for-closeout, perform Jarvis-owned CLOSEOUT:`
- [x] `src/intent/project-orchestrator.ts:225` — rename `Jarvis`→rune: `// --- Jarvis-owned closeout ---`

### `src/intent/promotions.test.ts`

- [x] `src/intent/promotions.test.ts:10` — rename `Jarvis`→rune: `* persisting each transition to an append-only JSONL log so the chain survives a Jarvis re…`
- [x] `src/intent/promotions.test.ts:46` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/intent/promotions.test.ts:62` — rename `jarvis`→rune: `expect(p.product).toBe('jarvis');`

### `src/intent/promotions.ts`

- [x] `src/intent/promotions.ts:6` — rename `Jarvis`→rune: `* append-only JSONL log so the chain survives a Jarvis restart. The state machine is pure;…`

### `src/intent/registry.test.ts`

- [x] `src/intent/registry.test.ts:23` — rename `jarvis`→rune: `PROJECT_ROOT: '/test/jarvis',`
- [x] `src/intent/registry.test.ts:61` — rename `JARVIS`→rune: `const JARVIS_INDEX = indexMd([`
- [x] `src/intent/registry.test.ts:73` (instance #1) — rename `jarvis`→rune: `{ name: 'jarvis', repoBacked: true, projectsIndex: JARVIS_INDEX },`
- [x] `src/intent/registry.test.ts:73` (instance #2) — rename `JARVIS`→rune: `{ name: 'jarvis', repoBacked: true, projectsIndex: JARVIS_INDEX },`
- [x] `src/intent/registry.test.ts:87` — rename `jarvis`→rune: `expect(registry.products.map((p) => p.name).sort()).toEqual(['assay', 'family', 'jarvis'])…`
- [x] `src/intent/registry.test.ts:90` — rename `jarvis`→rune: `// 3 jarvis projects + 1 assay project + 0 family projects.`
- [x] `src/intent/registry.test.ts:92` — rename `jarvis`→rune: `expect(all.filter((p) => p.product === 'jarvis')).toHaveLength(3);`
- [x] `src/intent/registry.test.ts:99` (instance #1) — rename `jarvis`→rune: `const jarvis = registry.products.find((p) => p.name === 'jarvis')!;`
- [x] `src/intent/registry.test.ts:99` (instance #2) — rename `jarvis`→rune: `const jarvis = registry.products.find((p) => p.name === 'jarvis')!;`
- [x] `src/intent/registry.test.ts:100` — rename `jarvis`→rune: `const bySlug = Object.fromEntries(jarvis.projects.map((p) => [p.slug, p.status]));`
- [x] `src/intent/registry.test.ts:110` — rename `jarvis`→rune: `name: 'jarvis',`
- [x] `src/intent/registry.test.ts:112` — rename `JARVIS`→rune: `projectsIndex: JARVIS_INDEX,`
- [x] `src/intent/registry.test.ts:121` (instance #1) — rename `jarvis`→rune: `const jarvis = registry.products.find((p) => p.name === 'jarvis')!;`
- [x] `src/intent/registry.test.ts:121` (instance #2) — rename `jarvis`→rune: `const jarvis = registry.products.find((p) => p.name === 'jarvis')!;`
- [x] `src/intent/registry.test.ts:122` — rename `jarvis`→rune: `const bySlug = Object.fromEntries(jarvis.projects.map((p) => [p.slug, p.progress]));`
- [x] `src/intent/registry.test.ts:264` — rename `jarvis`→rune: `expect(all.some((p) => p.product === 'jarvis' && p.slug === '08-intent-layer')).toBe(true)…`

### `src/intent/registry.ts`

- [x] `src/intent/registry.ts:42` — rename `jarvis`→rune: `/** Product name, e.g. 'jarvis', 'assay'. */`

### `src/intent/sandbox.test.ts`

- [x] `src/intent/sandbox.test.ts:26` — rename `jarvis`→rune: `const WORKTREE_ROOT = '/tmp/jarvis-worktrees';`
- [x] `src/intent/sandbox.test.ts:33` — rename `jarvis`→rune: `worktree: '/tmp/jarvis-worktrees/aura/02-growth',`
- [x] `src/intent/sandbox.test.ts:74` — rename `jarvis`→rune: `expect(isWriteAllowed('/tmp/jarvis-worktrees/aura/02-growth/src/app.ts', sandbox())).toBe(…`
- [x] `src/intent/sandbox.test.ts:86` — rename `jarvis`→rune: `const escaping = '/tmp/jarvis-worktrees/aura/02-growth/../../../../etc/passwd';`
- [x] `src/intent/sandbox.test.ts:91` — rename `jarvis`→rune: `// '/tmp/jarvis-worktrees/aura/02-growth-evil' must not pass as inside '.../02-growth'.`
- [x] `src/intent/sandbox.test.ts:92` — rename `jarvis`→rune: `expect(isWriteAllowed('/tmp/jarvis-worktrees/aura/02-growth-evil/x.ts', sandbox())).toBe(f…`
- [x] `src/intent/sandbox.test.ts:96` — rename `jarvis`→rune: `const relayPath = '/tmp/jarvis-worktrees/relay/01-relay-core/src/index.ts';`
- [x] `src/intent/sandbox.test.ts:101` — rename `jarvis`→rune: `expect(isWriteAllowed('/tmp/jarvis-worktrees/aura/02-growth', sandbox())).toBe(true);`
- [x] `src/intent/sandbox.test.ts:163` — rename `Jarvis`→rune: `it("never lets a run reach Jarvis's own credentials", () => {`
- [x] `src/intent/sandbox.test.ts:164` — rename `jarvis`→rune: `expect(canReachCredential(sandbox({ product: 'aura' }), 'jarvis')).toBe(false);`

### `src/intent/sandbox.ts`

- [x] `src/intent/sandbox.ts:83` — rename `jarvis`→rune: `return 'jarvis-work/${projectSlug}';`
- [x] `src/intent/sandbox.ts:175` — rename `Jarvis`→rune: `* Jarvis's own credentials, or a prefix/case-variant of its product name. Both values are`

### `src/intent/scaffold-target.test.ts`

- [x] `src/intent/scaffold-target.test.ts:7` — rename `Jarvis`→rune: `* not always Jarvis's. 'resolveScaffoldTarget(product, registry, productsConfig)' rejects …`
- [x] `src/intent/scaffold-target.test.ts:12` — rename `Jarvis`→rune: `* path in prompt text. Jarvis is just another registry/products entry — never a hard-coded…`
- [x] `src/intent/scaffold-target.test.ts:29` — rename `jarvis`→rune: `{ name: 'jarvis', repoBacked: true },`
- [x] `src/intent/scaffold-target.test.ts:36` (instance #1) — rename `jarvis`→rune: `jarvis: { repoPath: '/home/u/workspace/jarvis' },`
- [x] `src/intent/scaffold-target.test.ts:36` (instance #2) — rename `jarvis`→rune: `jarvis: { repoPath: '/home/u/workspace/jarvis' },`
- [x] `src/intent/scaffold-target.test.ts:53` — rename `jarvis`→rune: `it('treats jarvis as a normal product — its repoPath comes from config, not a hard-coded d…`
- [x] `src/intent/scaffold-target.test.ts:54` — rename `jarvis`→rune: `expect(okTarget(resolveScaffoldTarget('jarvis', REGISTRY, CONFIG)).repoPath).toBe(`
- [x] `src/intent/scaffold-target.test.ts:55` — rename `jarvis`→rune: `'/home/u/workspace/jarvis',`
- [x] `src/intent/scaffold-target.test.ts:59` — rename `jarvis`→rune: `it('reads the jarvis repoPath from the supplied config, not any constant (custom path prov…`
- [x] `src/intent/scaffold-target.test.ts:60` — rename `jarvis`→rune: `const customReg: RegistryLike = { products: [{ name: 'jarvis', repoBacked: true }] };`
- [x] `src/intent/scaffold-target.test.ts:61` (instance #1) — rename `jarvis`→rune: `const customCfg: ProductsConfigLike = { jarvis: { repoPath: '/custom/elsewhere/jarvis' } }…`
- [x] `src/intent/scaffold-target.test.ts:61` (instance #2) — rename `jarvis`→rune: `const customCfg: ProductsConfigLike = { jarvis: { repoPath: '/custom/elsewhere/jarvis' } }…`
- [x] `src/intent/scaffold-target.test.ts:62` — rename `jarvis`→rune: `expect(okTarget(resolveScaffoldTarget('jarvis', customReg, customCfg)).repoPath).toBe(`
- [x] `src/intent/scaffold-target.test.ts:63` — rename `jarvis`→rune: `'/custom/elsewhere/jarvis',`
- [x] `src/intent/scaffold-target.test.ts:94` — rename `Jarvis`→rune: `it('scopes writes to the target repo, not Jarvis — a different product gets a different sc…`
- [x] `src/intent/scaffold-target.test.ts:96` (instance #1) — rename `jarvis`→rune: `const jarvis = scaffoldWriteScope('/home/u/workspace/jarvis');`
- [x] `src/intent/scaffold-target.test.ts:96` (instance #2) — rename `jarvis`→rune: `const jarvis = scaffoldWriteScope('/home/u/workspace/jarvis');`
- [x] `src/intent/scaffold-target.test.ts:97` — rename `jarvis`→rune: `expect(aura.cwd).not.toBe(jarvis.cwd);`
- [x] `src/intent/scaffold-target.test.ts:98` — rename `jarvis`→rune: `expect(aura.writableDirs).not.toEqual(jarvis.writableDirs);`

### `src/intent/scaffold-target.ts`

- [x] `src/intent/scaffold-target.ts:5` — rename `Jarvis`→rune: `* TARGET PRODUCT's repo — not always Jarvis's. This module is the pure boundary that turns…`
- [x] `src/intent/scaffold-target.ts:10` — rename `Jarvis`→rune: `*   'repoPath' from 'policies/products.json'. Jarvis is just another registry/products ent…`
- [x] `src/intent/scaffold-target.ts:11` — rename `jarvis`→rune: `*   is never a hard-coded default, so a custom config path for 'jarvis' resolves to that p…`
- [x] `src/intent/scaffold-target.ts:19` — rename `Jarvis`→rune: `* silently anchor the child to Jarvis's own cwd). Full canonicalization — 'realpath' + con…`
- [x] `src/intent/scaffold-target.ts:78` — rename `Jarvis`→rune: `* its single writable directory. Scoping writes to exactly the target repo (not Jarvis, no…`
- [x] `src/intent/scaffold-target.ts:82` — rename `Jarvis`→rune: `// A relative or empty path would anchor the child's cwd to Jarvis's own process cwd rathe…`

### `src/intent/supervision-max-runtime.test.ts`

- [x] `src/intent/supervision-max-runtime.test.ts:38` — rename `jarvis`→rune: `product: 'jarvis',`

### `src/intent/supervision-parked.test.ts`

- [x] `src/intent/supervision-parked.test.ts:39` — rename `jarvis`→rune: `product: 'jarvis',`

### `src/intent/supervision-quiet-cancel.test.ts`

- [x] `src/intent/supervision-quiet-cancel.test.ts:39` — rename `jarvis`→rune: `product: 'jarvis',`

### `src/intent/supervision-quiet.test.ts`

- [x] `src/intent/supervision-quiet.test.ts:33` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/intent/supervision-quiet.test.ts:114` — rename `jarvis`→rune: `expect(msg).toContain('jarvis/11-work-run-observability');`

### `src/intent/supervision.ts`

- [x] `src/intent/supervision.ts:345` — rename `Jarvis`→rune: `* Recover a run after a Jarvis restart. A run that was 'running' cannot be observed across`

### `src/intent/team-task-workflow.test.ts`

- [x] `src/intent/team-task-workflow.test.ts:12` — rename `Jarvis`→rune: `* merge: Jarvis owns closeout. Every role seam is injected so the whole flow runs`

### `src/intent/team-task-workflow.ts`

- [x] `src/intent/team-task-workflow.ts:20` — rename `Jarvis`→rune: `* It does NOT mark 'tasks.md', write 'context.md', or merge — Jarvis owns`
- [x] `src/intent/team-task-workflow.ts:253` — rename `Jarvis`→rune: `*  merging are Jarvis's closeout, not the workflow's. */`

### `src/jobs/__acceptance__/orchestrated-live.acceptance.ts`

- [x] `src/jobs/__acceptance__/orchestrated-live.acceptance.ts:186` — rename `Jarvis`→rune: `/** Minimal env for the harness's own git/node spawns — Jarvis secrets`
- [x] `src/jobs/__acceptance__/orchestrated-live.acceptance.ts:337` — rename `Jarvis`→rune: `// git init + initial commit on 'main'. MINIMAL_ENV keeps Jarvis secrets out`
- [x] `src/jobs/__acceptance__/orchestrated-live.acceptance.ts:342` — rename `jarvis`→rune: `await git(['config', 'user.email', 'acceptance@jarvis.local']);`
- [x] `src/jobs/__acceptance__/orchestrated-live.acceptance.ts:343` — rename `Jarvis`→rune: `await git(['config', 'user.name', 'Jarvis Acceptance']);`
- [x] `src/jobs/__acceptance__/orchestrated-live.acceptance.ts:443` — rename `Jarvis`→rune: `// The daemon's public validate() resolves projects under this Jarvis`

### `src/jobs/capture.test.ts`

- [x] `src/jobs/capture.test.ts:110` — rename `jarvis`→rune: `expect(entry).toContain('[[jarvis]]');`
- [x] `src/jobs/capture.test.ts:132` — rename `jarvis`→rune: `const scope = { kind: 'product', product: 'jarvis' };`

### `src/jobs/capture.ts`

- [x] `src/jobs/capture.ts:26` — rename `jarvis`→rune: `const entry = '- ${ts} [[jarvis]] ${transportLabel(transport)}\n${summaryLines}';`

### `src/jobs/credential-injector.test.ts`

- [x] `src/jobs/credential-injector.test.ts:11` — rename `jarvis`→rune: `* IMPORTANT: No test reads ~/.config/jarvis/credentials/ or any real on-disk`
- [x] `src/jobs/credential-injector.test.ts:71` — rename `jarvis`→rune: `worktree: '/tmp/jarvis-worktrees/${product}/${project}',`
- [x] `src/jobs/credential-injector.test.ts:83` — rename `jarvis`→rune: `tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-cred-injector-test-'));`
- [x] `src/jobs/credential-injector.test.ts:218` — rename `JARVIS`→rune: `const result = getBaseEnv(['__JARVIS_TEST_KEY_THAT_DOES_NOT_EXIST__']);`
- [x] `src/jobs/credential-injector.test.ts:220` — rename `JARVIS`→rune: `expect(result).not.toHaveProperty('__JARVIS_TEST_KEY_THAT_DOES_NOT_EXIST__');`
- [x] `src/jobs/credential-injector.test.ts:273` — rename `Jarvis`→rune: `it('does NOT contain Jarvis-specific secret keys', () => {`
- [x] `src/jobs/credential-injector.test.ts:277` — rename `JARVIS`→rune: `'JARVIS_HTTP_SECRET',`

### `src/jobs/credential-injector.ts`

- [x] `src/jobs/credential-injector.ts:14` — rename `Jarvis`→rune: `* 2. **Jarvis's own secrets in 'process.env' never reach the child.** The`
- [x] `src/jobs/credential-injector.ts:16` — rename `Jarvis`→rune: `*    is **not** passed through wholesale the way the in-Jarvis Claude CLI`
- [x] `src/jobs/credential-injector.ts:142` — rename `Jarvis`→rune: `* This is the gate that keeps Jarvis's own secrets (TELEGRAM_BOT_TOKEN,`

### `src/jobs/dispatch-runtime.ts`

- [x] `src/jobs/dispatch-runtime.ts:11` — rename `Jarvis`→rune: `*    Jarvis's '.claude/agents/<name>.md' directly (the CLI knows the`
- [x] `src/jobs/dispatch-runtime.ts:13` — rename `Jarvis`→rune: `*    document since Codex doesn't know Jarvis's agents dir.`
- [x] `src/jobs/dispatch-runtime.ts:24` — rename `Jarvis`→rune: `* only for in-Jarvis dispatches.`
- [x] `src/jobs/dispatch-runtime.ts:117` — rename `Jarvis`→rune: `*  'process.env', which is safe only for in-Jarvis dispatches. */`
- [x] `src/jobs/dispatch-runtime.ts:230` — rename `Jarvis`→rune: `// doesn't know Jarvis's agents dir. 'runCodex' reads each option with`

### `src/jobs/egress-policy.test.ts`

- [x] `src/jobs/egress-policy.test.ts:70` — rename `jarvis`→rune: `worktree: '/tmp/jarvis-worktrees/${product}/${project}',`
- [x] `src/jobs/egress-policy.test.ts:92` — rename `jarvis`→rune: `tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-egress-policy-test-'));`

### `src/jobs/execution-agent.test.ts`

- [x] `src/jobs/execution-agent.test.ts:70` — rename `jarvis`→rune: `PROJECT_ROOT: '/tmp/test-jarvis',`
- [x] `src/jobs/execution-agent.test.ts:107` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/execution-agent.test.ts:320` — rename `jarvis`→rune: `text: 'legacy stdout from /tmp/test-jarvis/private/file.md',`

### `src/jobs/fix-attempt-store.test.ts`

- [x] `src/jobs/fix-attempt-store.test.ts:91` — rename `jarvis`→rune: `attemptId: 'jarvis-proceeding',`
- [x] `src/jobs/fix-attempt-store.test.ts:92` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/fix-attempt-store.test.ts:95` — rename `jarvis`→rune: `runId: 'run-jarvis-fix',`
- [x] `src/jobs/fix-attempt-store.test.ts:107` — rename `jarvis`→rune: `expect(getLatestFixAttempt(latest, 'jarvis', 'shared-bug-id')).toMatchObject({`
- [x] `src/jobs/fix-attempt-store.test.ts:108` — rename `jarvis`→rune: `attemptId: 'jarvis-proceeding',`
- [x] `src/jobs/fix-attempt-store.test.ts:109` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/fix-attempt-store.test.ts:112` — rename `jarvis`→rune: `runId: 'run-jarvis-fix',`

### `src/jobs/gen-eval-loop-runner.test.ts`

- [x] `src/jobs/gen-eval-loop-runner.test.ts:84` — rename `jarvis`→rune: `tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-gel-runner-test-'));`
- [x] `src/jobs/gen-eval-loop-runner.test.ts:270` — rename `jarvis`→rune: `worktree: '/tmp/jarvis-worktrees/aura/01-growth',`
- [x] `src/jobs/gen-eval-loop-runner.test.ts:298` — rename `jarvis`→rune: `worktreeRoot: '/tmp/jarvis-worktrees',`
- [x] `src/jobs/gen-eval-loop-runner.test.ts:536` — rename `jarvis`→rune: `worktree: '/tmp/jarvis-worktrees/aura/01-growth',`
- [x] `src/jobs/gen-eval-loop-runner.test.ts:555` — rename `jarvis`→rune: `worktreeRoot: '/tmp/jarvis-worktrees',`
- [x] `src/jobs/gen-eval-loop-runner.test.ts:679` — rename `jarvis`→rune: `worktree: '/tmp/jarvis-worktrees/aura/01-growth',`
- [x] `src/jobs/gen-eval-loop-runner.test.ts:700` — rename `jarvis`→rune: `worktreeRoot: '/tmp/jarvis-worktrees',`
- [x] `src/jobs/gen-eval-loop-runner.test.ts:820` — rename `jarvis`→rune: `//      derived from the mutationId (''jarvis-gen-eval/' + mutationId.slice(0,8)').`
- [x] `src/jobs/gen-eval-loop-runner.test.ts:852` — rename `jarvis`→rune: `worktree: '/tmp/jarvis-worktrees/aura/01-growth',`
- [x] `src/jobs/gen-eval-loop-runner.test.ts:871` — rename `jarvis`→rune: `worktreeRoot: '/tmp/jarvis-worktrees',`
- [x] `src/jobs/gen-eval-loop-runner.test.ts:885` — rename `jarvis`→rune: `// the mutationId: 'jarvis-gen-eval/' + mutationId.slice(0, 8).`
- [x] `src/jobs/gen-eval-loop-runner.test.ts:886` — rename `jarvis`→rune: `// mutationId is 'mut-1' here, so the branch is 'jarvis-gen-eval/mut-1'.`
- [x] `src/jobs/gen-eval-loop-runner.test.ts:893` — rename `jarvis`→rune: `branch: expect.stringMatching(/^jarvis-gen-eval\//),`
- [x] `src/jobs/gen-eval-loop-runner.test.ts:896` — rename `jarvis`→rune: `expect(firstCall['branch']).toBe('jarvis-gen-eval/mut-1');`
- [x] `src/jobs/gen-eval-loop-runner.test.ts:920` — rename `jarvis`→rune: `expect(callBranch).toMatch(/^jarvis-gen-eval\//);`

### `src/jobs/gen-eval-loop-runner.ts`

- [x] `src/jobs/gen-eval-loop-runner.ts:273` — rename `jarvis`→rune: `const message = 'jarvis(${sandbox.product}): merge gen-eval-loop branch ${branch}';`
- [x] `src/jobs/gen-eval-loop-runner.ts:543` — rename `jarvis`→rune: `const branch = 'jarvis-gen-eval/${opts.mutationId.slice(0, 8)}';`

### `src/jobs/intent-scan.test.ts`

- [x] `src/jobs/intent-scan.test.ts:6` — rename `jarvis`→rune: `const tmpLogs = join(tmpdir(), 'jarvis-intent-scan-test-${Date.now()}');`

### `src/jobs/morning-prep.integration.test.ts`

- [x] `src/jobs/morning-prep.integration.test.ts:6` — rename `jarvis`→rune: `const tmpDir = join(tmpdir(), 'jarvis-morning-prep-int-${Date.now()}');`

### `src/jobs/morning-prep.test.ts`

- [x] `src/jobs/morning-prep.test.ts:464` — rename `jarvis`→rune: `error: 'spawn ENOENT /Users/somebody/workspace/jarvis/node_modules/.bin/claude',`

### `src/jobs/mutations-log-recovery.test.ts`

- [x] `src/jobs/mutations-log-recovery.test.ts:32` — rename `jarvis`→rune: `payload: { projectSlug: 'demo', product: 'jarvis' },`
- [x] `src/jobs/mutations-log-recovery.test.ts:59` — rename `jarvis`→rune: `payload: { projectSlug: '14-product-team-agents', product: 'jarvis' },`

### `src/jobs/mutations-log.test.ts`

- [x] `src/jobs/mutations-log.test.ts:196` — rename `jarvis`→rune: `payload: { projectSlug: '14-product-team-agents', product: 'jarvis' },`
- [x] `src/jobs/mutations-log.test.ts:202` — rename `jarvis`→rune: `payload: { projectSlug: 'stale-run', product: 'jarvis' },`

### `src/jobs/nightly.ts`

- [x] `src/jobs/nightly.ts:527` — rename `jarvis`→rune: `{ product: 'jarvis', project: plan.projectSlug },`
- [x] `src/jobs/nightly.ts:590` — rename `Jarvis`→rune: `*  records, runs the Jarvis-owned post-mortem on each NOT-yet-processed record (up to`
- [x] `src/jobs/nightly.ts:592` — rename `jarvis`→rune: `*  responsible role's memory.md (its own atomic commit in the jarvis repo). Each`

### `src/jobs/orchestrated-run-store.test.ts`

- [x] `src/jobs/orchestrated-run-store.test.ts:102` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/orchestrated-run-store.test.ts:104` — rename `jarvis`→rune: `branch: 'jarvis-work/14-product-team-agents',`
- [x] `src/jobs/orchestrated-run-store.test.ts:106` (instance #1) — rename `jarvis`→rune: `worktreePath: '/tmp/jarvis-worktrees/jarvis/14-product-team-agents',`
- [x] `src/jobs/orchestrated-run-store.test.ts:106` (instance #2) — rename `jarvis`→rune: `worktreePath: '/tmp/jarvis-worktrees/jarvis/14-product-team-agents',`
- [x] `src/jobs/orchestrated-run-store.test.ts:274` — rename `jarvis`→rune: `key: 'mut-orch-1:merge-success:jarvis-work/demo:pushed-not-deleted',`
- [x] `src/jobs/orchestrated-run-store.test.ts:275` — rename `jarvis`→rune: `branch: 'jarvis-work/demo',`
- [x] `src/jobs/orchestrated-run-store.test.ts:289` — rename `jarvis`→rune: `branch: 'jarvis-work/demo',`
- [x] `src/jobs/orchestrated-run-store.test.ts:296` — rename `jarvis`→rune: `branch: 'jarvis-work/demo',`

### `src/jobs/orchestrated-work-recovery.test.ts`

- [x] `src/jobs/orchestrated-work-recovery.test.ts:34` — rename `jarvis`→rune: `payload: { projectSlug: '14-product-team-agents', product: 'jarvis' },`
- [x] `src/jobs/orchestrated-work-recovery.test.ts:59` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/orchestrated-work-recovery.test.ts:61` — rename `jarvis`→rune: `branch: 'jarvis-work/14-product-team-agents',`
- [x] `src/jobs/orchestrated-work-recovery.test.ts:63` (instance #1) — rename `jarvis`→rune: `worktreePath: '/tmp/jarvis-worktrees/jarvis/14-product-team-agents',`
- [x] `src/jobs/orchestrated-work-recovery.test.ts:63` (instance #2) — rename `jarvis`→rune: `worktreePath: '/tmp/jarvis-worktrees/jarvis/14-product-team-agents',`

### `src/jobs/orchestrated-work-runner.test.ts`

- [x] `src/jobs/orchestrated-work-runner.test.ts:122` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:147` — rename `jarvis`→rune: `payload: { projectSlug: string; product?: string } = { projectSlug: 'demo', product: 'jarv…`
- [x] `src/jobs/orchestrated-work-runner.test.ts:201` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:202` — rename `jarvis`→rune: `branch: 'jarvis-work/demo',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:360` — rename `jarvis`→rune: `const descriptor = makeDescriptor({ projectSlug, product: 'jarvis' }, 'mut-recovered-redis…`
- [x] `src/jobs/orchestrated-work-runner.test.ts:362` — rename `jarvis`→rune: `branch: 'jarvis-work/recovered-branch',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:379` — rename `jarvis`→rune: `branch: 'jarvis-work/recovered-branch',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:446` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:447` — rename `jarvis`→rune: `branch: 'jarvis-work/demo',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:699` — rename `jarvis`→rune: `{ projectSlug, product: 'jarvis' },`
- [x] `src/jobs/orchestrated-work-runner.test.ts:1068` — rename `Jarvis`→rune: `it('pumps Jarvis-owned orchestration lifecycle events as activity before the terminal even…`
- [x] `src/jobs/orchestrated-work-runner.test.ts:1174` (instance #1) — rename `jarvis`→rune: `['commit', '-m', 'jarvis(jarvis): closeout — Build the streak core'],`
- [x] `src/jobs/orchestrated-work-runner.test.ts:1174` (instance #2) — rename `jarvis`→rune: `['commit', '-m', 'jarvis(jarvis): closeout — Build the streak core'],`
- [x] `src/jobs/orchestrated-work-runner.test.ts:1396` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:1401` (instance #1) — rename `jarvis`→rune: `commitSubject: 'jarvis(jarvis): closeout — Build the streak core',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:1401` (instance #2) — rename `jarvis`→rune: `commitSubject: 'jarvis(jarvis): closeout — Build the streak core',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:1414` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:1419` (instance #1) — rename `jarvis`→rune: `commitSubject: 'jarvis(jarvis): closeout — Render the streak card',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:1419` (instance #2) — rename `jarvis`→rune: `commitSubject: 'jarvis(jarvis): closeout — Render the streak card',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:1664` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:1704` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:1705` — rename `jarvis`→rune: `branch: 'jarvis-work/demo',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:1788` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:1789` — rename `jarvis`→rune: `branch: 'jarvis-work/demo',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:1848` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:1849` — rename `jarvis`→rune: `branch: 'jarvis-work/demo',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:1996` — rename `jarvis`→rune: `jarvis: {`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2047` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2050` — rename `jarvis`→rune: `branch: 'jarvis-work/demo',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2054` — rename `jarvis`→rune: `integrationWorktree: expect.stringContaining('gate-jarvis-${runId}'),`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2078` (instance #1) — rename `jarvis`→rune: `args: ['merge', '--no-ff', 'jarvis-work/demo', '-m', 'jarvis(jarvis): merge orchestrated b…`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2078` (instance #2) — rename `jarvis`→rune: `args: ['merge', '--no-ff', 'jarvis-work/demo', '-m', 'jarvis(jarvis): merge orchestrated b…`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2078` (instance #3) — rename `jarvis`→rune: `args: ['merge', '--no-ff', 'jarvis-work/demo', '-m', 'jarvis(jarvis): merge orchestrated b…`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2078` (instance #4) — rename `jarvis`→rune: `args: ['merge', '--no-ff', 'jarvis-work/demo', '-m', 'jarvis(jarvis): merge orchestrated b…`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2082` — rename `jarvis`→rune: `expect.objectContaining({ args: ['branch', '-d', 'jarvis-work/demo'], cwd: repoPath }),`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2255` — rename `jarvis`→rune: `(command === 'merge' && args.includes('jarvis-work/demo')) ||`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2257` — rename `jarvis`→rune: `(command === 'branch' && args[1] === '-d' && args[2] === 'jarvis-work/demo')`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2367` — rename `jarvis`→rune: `const expectedRange = '${baseSha}..jarvis-work/demo';`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2388` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2389` — rename `jarvis`→rune: `branch: 'jarvis-work/demo',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2414` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2415` — rename `jarvis`→rune: `branch: 'jarvis-work/demo',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2428` (instance #1) — rename `jarvis`→rune: `const worktreePath = '/tmp/jarvis-worktrees/jarvis/demo-non-reversible';`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2428` (instance #2) — rename `jarvis`→rune: `const worktreePath = '/tmp/jarvis-worktrees/jarvis/demo-non-reversible';`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2432` — rename `jarvis`→rune: `branch: 'jarvis-work/demo',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2439` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2440` — rename `jarvis`→rune: `branch: 'jarvis-work/demo',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2453` — rename `jarvis`→rune: `expect(data['branch']).toBe('jarvis-work/demo');`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2553` — rename `jarvis`→rune: `branch: 'jarvis-work/demo',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2563` — rename `jarvis`→rune: `branch: 'jarvis-work/demo',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2571` — rename `jarvis`→rune: `(command === 'merge' && args.includes('jarvis-work/demo')) ||`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2573` — rename `jarvis`→rune: `(command === 'branch' && args[1] === '-d' && args[2] === 'jarvis-work/demo')`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2623` — rename `jarvis`→rune: `{ projectSlug, product: 'jarvis' },`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2688` — rename `jarvis`→rune: `{ projectSlug, product: 'jarvis' },`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2798` — rename `jarvis`→rune: `{ projectSlug, product: 'jarvis' },`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2864` — rename `jarvis`→rune: `const noopGit: GitRunner = async () => ({ stdout: 'jarvis-work/x', stderr: '' });`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2882` — rename `jarvis`→rune: `repoPath = mkdtempSync(join(tmpdir(), 'jarvis-bugs-'));`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2894` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2909` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2917` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/orchestrated-work-runner.test.ts:2929` — rename `jarvis`→rune: `product: 'jarvis',`

### `src/jobs/orchestrated-work-runner.ts`

- [x] `src/jobs/orchestrated-work-runner.ts:4` — rename `Jarvis`→rune: `* The Jarvis-owned multi-task orchestration loop dispatched through the existing`
- [x] `src/jobs/orchestrated-work-runner.ts:356` — rename `jarvis`→rune: `const message = 'jarvis(${product}): closeout — ${task.text}'.slice(0, 200);`
- [x] `src/jobs/orchestrated-work-runner.ts:834` — rename `jarvis`→rune: `const product = descriptor.payload.product ?? 'jarvis';`
- [x] `src/jobs/orchestrated-work-runner.ts:986` — rename `jarvis`→rune: `((h.descriptor.payload as OrchestratedWorkPayload).product ?? 'jarvis') === product &&`
- [x] `src/jobs/orchestrated-work-runner.ts:1118` — rename `jarvis`→rune: `const message = 'jarvis(${product}): merge orchestrated branch ${branch}';`
- [x] `src/jobs/orchestrated-work-runner.ts:1619` — rename `jarvis`→rune: `const product = descriptor.payload.product ?? 'jarvis';`

### `src/jobs/planning-expiry.test.ts`

- [x] `src/jobs/planning-expiry.test.ts:43` — rename `jarvis`→rune: `planning: { status: 'scoping' as const, product: 'jarvis', idea: '', surface: 'chat' as co…`
- [x] `src/jobs/planning-expiry.test.ts:183` — rename `jarvis`→rune: `product: 'jarvis',`

### `src/jobs/playbook-extract.test.ts`

- [x] `src/jobs/playbook-extract.test.ts:6` — rename `jarvis`→rune: `const tmpDir = join(tmpdir(), 'jarvis-playbook-test-${Date.now()}');`

### `src/jobs/recovery-finalize-runner.test.ts`

- [x] `src/jobs/recovery-finalize-runner.test.ts:40` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/recovery-finalize-runner.test.ts:113` — rename `jarvis`→rune: `expect(captured.summaries[0]!.summary.branch).toBe('jarvis-work/15-work-run-finalizer');`

### `src/jobs/recovery-finalize-runner.ts`

- [x] `src/jobs/recovery-finalize-runner.ts:358` — rename `jarvis`→rune: `const message = 'jarvis(${run.product}): merge recovered work-run branch ${branch}';`

### `src/jobs/registry-rebuild.test.ts`

- [x] `src/jobs/registry-rebuild.test.ts:27` — rename `jarvis`→rune: `root = mkdtempSync(join(tmpdir(), 'jarvis-registry-scan-'));`
- [x] `src/jobs/registry-rebuild.test.ts:29` — rename `jarvis`→rune: `// jarvis: two projects, both with tasks.md`
- [x] `src/jobs/registry-rebuild.test.ts:30` (instance #1) — rename `jarvis`→rune: `const jarvis = join(root, 'jarvis');`
- [x] `src/jobs/registry-rebuild.test.ts:30` (instance #2) — rename `jarvis`→rune: `const jarvis = join(root, 'jarvis');`
- [x] `src/jobs/registry-rebuild.test.ts:31` — rename `jarvis`→rune: `makeProject(jarvis, '01-mvp', '- [x] a\n- [x] b\n');`
- [x] `src/jobs/registry-rebuild.test.ts:32` — rename `jarvis`→rune: `makeProject(jarvis, '10-thing', '- [x] a\n- [ ] b\n- [ ] c\n');`
- [x] `src/jobs/registry-rebuild.test.ts:33` — rename `jarvis`→rune: `mkdirSync(join(jarvis, 'docs', 'projects'), { recursive: true });`
- [x] `src/jobs/registry-rebuild.test.ts:35` — rename `jarvis`→rune: `join(jarvis, 'docs', 'projects', 'index.md'),`
- [x] `src/jobs/registry-rebuild.test.ts:53` (instance #1) — rename `jarvis`→rune: `jarvis: { repoPath: jarvis, baseBranch: 'main', credentialsFile: '', egressAllowlist: [] }…`
- [x] `src/jobs/registry-rebuild.test.ts:53` (instance #2) — rename `jarvis`→rune: `jarvis: { repoPath: jarvis, baseBranch: 'main', credentialsFile: '', egressAllowlist: [] }…`
- [x] `src/jobs/registry-rebuild.test.ts:69` — rename `jarvis`→rune: `expect(sources.products.map((p) => p.name).sort()).toEqual(['aura', 'ghost', 'jarvis', 're…`
- [x] `src/jobs/registry-rebuild.test.ts:74` (instance #1) — rename `jarvis`→rune: `const jarvis = sources.products.find((p) => p.name === 'jarvis')!;`
- [x] `src/jobs/registry-rebuild.test.ts:74` (instance #2) — rename `jarvis`→rune: `const jarvis = sources.products.find((p) => p.name === 'jarvis')!;`
- [x] `src/jobs/registry-rebuild.test.ts:75` — rename `jarvis`→rune: `expect(jarvis.projectsIndex).toContain('10-thing');`
- [x] `src/jobs/registry-rebuild.test.ts:76` — rename `jarvis`→rune: `expect(jarvis.taskProgress).toEqual({`

### `src/jobs/sandbox-fs.test.ts`

- [x] `src/jobs/sandbox-fs.test.ts:64` — rename `jarvis`→rune: `const probeDir = mkdtempSync(join(tmpdir(), 'jarvis-sandbox-fs-probe-'));`
- [x] `src/jobs/sandbox-fs.test.ts:82` — rename `jarvis`→rune: `tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-sandbox-fs-test-'));`
- [x] `src/jobs/sandbox-fs.test.ts:115` — rename `jarvis`→rune: `const sandbox = sandboxFor(join('/tmp', 'jarvis-worktrees', 'aura', '01-growth'));`
- [x] `src/jobs/sandbox-fs.test.ts:120` — rename `jarvis`→rune: `const sandbox = sandboxFor(join('/tmp', 'jarvis-worktrees', 'aura', '01-growth'));`
- [x] `src/jobs/sandbox-fs.test.ts:160` — rename `jarvis`→rune: `const outside = mkdtempSync(join(tmpdir(), 'jarvis-outside-'));`
- [x] `src/jobs/sandbox-fs.test.ts:266` — rename `jarvis`→rune: `const targetOutside = '/etc/__jarvis_test_should_not_exist__';`
- [x] `src/jobs/sandbox-fs.test.ts:319` — rename `jarvis`→rune: `const outside = mkdtempSync(join(tmpdir(), 'jarvis-outside-'));`
- [x] `src/jobs/sandbox-fs.test.ts:361` — rename `jarvis`→rune: `const outside = mkdtempSync(join(tmpdir(), 'jarvis-outside-'));`
- [x] `src/jobs/sandbox-fs.test.ts:404` — rename `jarvis`→rune: `const outside = mkdtempSync(join(tmpdir(), 'jarvis-outside-'));`

### `src/jobs/sandbox-fs.ts`

- [x] `src/jobs/sandbox-fs.ts:7` — rename `Jarvis`→rune: `* These wrappers protect **Jarvis's own writes when acting on behalf of a`

### `src/jobs/sandbox-runtime.test.ts`

- [x] `src/jobs/sandbox-runtime.test.ts:66` — rename `jarvis`→rune: `credentialsFile: '~/.config/jarvis/credentials/aura/.env',`
- [x] `src/jobs/sandbox-runtime.test.ts:106` — rename `jarvis`→rune: `tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-sandbox-test-'));`
- [x] `src/jobs/sandbox-runtime.test.ts:151` — rename `jarvis`→rune: `join(home, '.config/jarvis/credentials/aura/.env'),`
- [x] `src/jobs/sandbox-runtime.test.ts:262` — rename `Jarvis`→rune: `it('the REAL Jarvis product config declares validationCommands ["npm run build", "npm test…`
- [x] `src/jobs/sandbox-runtime.test.ts:264` — rename `Jarvis`→rune: `// "Jarvis product config includes validationCommands"). RED until the P1.5`
- [x] `src/jobs/sandbox-runtime.test.ts:266` — rename `Jarvis`→rune: `// The exact list is a spec-pinned policy choice (spec req 16); if Jarvis's`
- [x] `src/jobs/sandbox-runtime.test.ts:273` — rename `jarvis`→rune: `expect(result['jarvis']!.validationCommands).toEqual(['npm run build', 'npm test']);`
- [x] `src/jobs/sandbox-runtime.test.ts:308` — rename `jarvis`→rune: `const WORKTREE_ROOT = '/tmp/jarvis-worktrees-test';`
- [x] `src/jobs/sandbox-runtime.test.ts:409` — rename `jarvis`→rune: `branch: 'jarvis-work/abc',`
- [x] `src/jobs/sandbox-runtime.test.ts:439` — rename `jarvis`→rune: `branch: 'jarvis-work/fail',`
- [x] `src/jobs/sandbox-runtime.test.ts:454` — rename `jarvis`→rune: `branch: 'jarvis-work/empty',`
- [x] `src/jobs/sandbox-runtime.test.ts:469` — rename `jarvis`→rune: `branch: 'jarvis-work/xyz',`
- [x] `src/jobs/sandbox-runtime.test.ts:491` — rename `jarvis`→rune: `const branch = 'jarvis-work/01-growth';`
- [x] `src/jobs/sandbox-runtime.test.ts:531` — rename `jarvis`→rune: `const branch = 'jarvis-work/01-growth';`
- [x] `src/jobs/sandbox-runtime.test.ts:573` — rename `jarvis`→rune: `const branch = 'jarvis-work/01-growth';`
- [x] `src/jobs/sandbox-runtime.test.ts:597` — rename `jarvis`→rune: `).rejects.toThrow(/base reconciliation failed.*jarvis-work\/01-growth.*main.*previous09876…`
- [x] `src/jobs/sandbox-runtime.test.ts:610` — rename `jarvis`→rune: `const branch = 'jarvis-work/01-growth';`
- [x] `src/jobs/sandbox-runtime.test.ts:652` — rename `jarvis`→rune: `branch: 'jarvis-work/01-growth',`
- [x] `src/jobs/sandbox-runtime.test.ts:746` — rename `jarvis`→rune: `repo = mkdtempSync(join(tmpdir(), 'jarvis-deps-repo-'));`
- [x] `src/jobs/sandbox-runtime.test.ts:747` — rename `jarvis`→rune: `worktree = mkdtempSync(join(tmpdir(), 'jarvis-deps-wt-'));`
- [x] `src/jobs/sandbox-runtime.test.ts:794` — rename `jarvis`→rune: `const WORKTREE_PATH = '/tmp/jarvis-worktrees-test/aura/01-growth';`
- [x] `src/jobs/sandbox-runtime.test.ts:868` — rename `jarvis`→rune: `worktreeRoot: '/tmp/jarvis-worktrees-test',`
- [x] `src/jobs/sandbox-runtime.test.ts:879` (instance #1) — rename `jarvis`→rune: `// '/tmp/jarvis-worktrees-test-evil/...' is NOT inside '/tmp/jarvis-worktrees-test'.`
- [x] `src/jobs/sandbox-runtime.test.ts:879` (instance #2) — rename `jarvis`→rune: `// '/tmp/jarvis-worktrees-test-evil/...' is NOT inside '/tmp/jarvis-worktrees-test'.`
- [x] `src/jobs/sandbox-runtime.test.ts:880` — rename `jarvis`→rune: `const spec = makeSpec({ worktree: '/tmp/jarvis-worktrees-test-evil/aura/x' });`
- [x] `src/jobs/sandbox-runtime.test.ts:885` — rename `jarvis`→rune: `worktreeRoot: '/tmp/jarvis-worktrees-test',`
- [x] `src/jobs/sandbox-runtime.test.ts:1032` — rename `jarvis`→rune: `branch: 'jarvis-work/14-product-team-agents',`
- [x] `src/jobs/sandbox-runtime.test.ts:1083` — rename `jarvis`→rune: `branch: 'jarvis-work/14-product-team-agents',`

### `src/jobs/sandbox-runtime.ts`

- [x] `src/jobs/sandbox-runtime.ts:407` — rename `Jarvis`→rune: `// Reconcile against the LOCAL base ref — no 'git fetch'. Jarvis lands its`

### `src/jobs/scaffold-approval.test.ts`

- [x] `src/jobs/scaffold-approval.test.ts:31` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/scaffold-approval.test.ts:34` — rename `jarvis`→rune: `artifact: { product: 'jarvis', title: 'T', spec: 'spec', tasks: 'Tests (write first)', tes…`
- [x] `src/jobs/scaffold-approval.test.ts:59` — rename `jarvis`→rune: `products: [{ name: 'jarvis', repoBacked: true, projects: [] }],`
- [x] `src/jobs/scaffold-approval.test.ts:68` (instance #1) — rename `jarvis`→rune: `jarvis: { repoPath: '/ws/jarvis', baseBranch: 'main', credentialsFile: '', egressAllowlist…`
- [x] `src/jobs/scaffold-approval.test.ts:68` (instance #2) — rename `jarvis`→rune: `jarvis: { repoPath: '/ws/jarvis', baseBranch: 'main', credentialsFile: '', egressAllowlist…`
- [x] `src/jobs/scaffold-approval.test.ts:112` — rename `jarvis`→rune: `expect(paths).toContain('/ws/jarvis/docs/projects/${SLUG}/tech-spec.md');`
- [x] `src/jobs/scaffold-approval.test.ts:113` — rename `jarvis`→rune: `expect(paths).toContain('/ws/jarvis/docs/projects/${SLUG}/context.md');`
- [x] `src/jobs/scaffold-approval.test.ts:134` — rename `jarvis`→rune: `path: '/ws/jarvis/docs/projects/${SLUG}/examples/qa.md',`
- [x] `src/jobs/scaffold-approval.test.ts:151` — rename `jarvis`→rune: `id: 'p1', product: 'jarvis', backlogItemId: 'b1',`
- [x] `src/jobs/scaffold-approval.test.ts:159` — rename `jarvis`→rune: `expect(h.writes[0]!.path).toBe('/ws/jarvis/docs/projects/ideas.md');`
- [x] `src/jobs/scaffold-approval.test.ts:167` — rename `jarvis`→rune: `id: 'p1', product: 'jarvis', backlogItemId: 'b1',`
- [x] `src/jobs/scaffold-approval.test.ts:172` — rename `jarvis`→rune: `expect(h.writes[0]!.path).toBe('/ws/jarvis/docs/projects/bugs.md');`
- [x] `src/jobs/scaffold-approval.test.ts:179` — rename `jarvis`→rune: `id: 'p1', product: 'jarvis', backlogItemId: 'b1',`
- [x] `src/jobs/scaffold-approval.test.ts:192` — rename `jarvis`→rune: `id: 'p1', product: 'jarvis', backlogItemId: 'b1',`
- [x] `src/jobs/scaffold-approval.test.ts:207` — rename `jarvis`→rune: `id: 'p1', product: 'jarvis', backlogItemId: 'b1',`
- [x] `src/jobs/scaffold-approval.test.ts:221` — rename `jarvis`→rune: `readRegistry: () => ({ version: 1, builtAt: '', products: [{ name: 'jarvis', repoBacked: f…`
- [x] `src/jobs/scaffold-approval.test.ts:231` — rename `jarvis`→rune: `id: 'p1', product: 'jarvis', backlogItemId: 'b1',`
- [x] `src/jobs/scaffold-approval.test.ts:263` (instance #1) — rename `jarvis`→rune: `jarvis: { repoPath: '/elsewhere/jarvis', baseBranch: 'main', credentialsFile: '', egressAl…`
- [x] `src/jobs/scaffold-approval.test.ts:263` (instance #2) — rename `jarvis`→rune: `jarvis: { repoPath: '/elsewhere/jarvis', baseBranch: 'main', credentialsFile: '', egressAl…`
- [x] `src/jobs/scaffold-approval.test.ts:283` — rename `jarvis`→rune: `id: 'p1', product: 'jarvis', backlogItemId: 'b1',`
- [x] `src/jobs/scaffold-approval.test.ts:294` — rename `jarvis`→rune: `id: 'p1', product: 'jarvis', backlogItemId: 'b1',`

### `src/jobs/scaffold-approval.ts`

- [x] `src/jobs/scaffold-approval.ts:12` — rename `jarvis`→rune: `*     jarvis is just another product, never a hard-coded default. Reject unknown/not-repo-…`
- [x] `src/jobs/scaffold-approval.ts:193` — rename `Jarvis`→rune: `* none, so this is a no-op for them. 'context.md' is Jarvis-owned orchestration`
- [x] `src/jobs/scaffold-approval.ts:317` — rename `Jarvis`→rune: `// a tech spec, a Jarvis-seeded context.md, and possibly per-project role`

### `src/jobs/scheduler.test.ts`

- [x] `src/jobs/scheduler.test.ts:232` — rename `Jarvis`→rune: `it('dedupes by filename stem — Jarvis agent dir wins over vault', () => {`

### `src/jobs/scheduler.ts`

- [x] `src/jobs/scheduler.ts:170` — rename `Jarvis`→rune: `/** Scan '.claude/agents/' (Jarvis first, vault fallback) for agent files that`
- [x] `src/jobs/scheduler.ts:184` — rename `Jarvis`→rune: `// Jarvis-first precedence matches loadAgentDef: project dir wins over vault.`

### `src/jobs/stall-check-runner.ts`

- [x] `src/jobs/stall-check-runner.ts:47` — rename `jarvis`→rune: `const product = typeof payload['product'] === 'string' ? payload['product'] : 'jarvis';`

### `src/jobs/supervision-recovery.test.ts`

- [x] `src/jobs/supervision-recovery.test.ts:34` — rename `jarvis`→rune: `tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-supervision-recovery-test-'));`
- [x] `src/jobs/supervision-recovery.test.ts:239` — rename `Jarvis`→rune: `// The dangerous window (spec Edge Cases): Jarvis dies AFTER the agent emits`

### `src/jobs/supervision-recovery.ts`

- [x] `src/jobs/supervision-recovery.ts:4` — rename `Jarvis`→rune: `* can't be observed across a Jarvis restart). Mirrors 'reconcileOrphans()'`

### `src/jobs/supervision-store.test.ts`

- [x] `src/jobs/supervision-store.test.ts:254` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/supervision-store.test.ts:255` — rename `jarvis`→rune: `project: '10-jarvis-identity-refactor',`

### `src/jobs/supervision-store.ts`

- [x] `src/jobs/supervision-store.ts:15` — rename `Jarvis`→rune: `* Jarvis process per machine).`
- [x] `src/jobs/supervision-store.ts:73` — rename `Jarvis`→rune: `// visibility surface as a typed-but-broken record. (Only Jarvis writes`
- [x] `src/jobs/supervision-store.ts:114` — rename `Jarvis`→rune: `// PID-tagged temp name avoids collisions with other Jarvis processes only;`

### `src/jobs/team-task-deps.gate-learning.test.ts`

- [x] `src/jobs/team-task-deps.gate-learning.test.ts:149` — rename `jarvis`→rune: `product: 'jarvis',`

### `src/jobs/team-task-deps.postmortem-gate.test.ts`

- [x] `src/jobs/team-task-deps.postmortem-gate.test.ts:4` — rename `Jarvis`→rune: `* The production gate-learning binding must reuse Jarvis's neutral`
- [x] `src/jobs/team-task-deps.postmortem-gate.test.ts:97` — rename `jarvis`→rune: `product: 'jarvis',`

### `src/jobs/team-task-deps.test.ts`

- [x] `src/jobs/team-task-deps.test.ts:65` — rename `jarvis`→rune: `product: 'jarvis',`

### `src/jobs/work-dispatch.test.ts`

- [x] `src/jobs/work-dispatch.test.ts:69` (instance #1) — rename `jarvis`→rune: `jarvis: { repoPath: '/repo/jarvis', baseBranch: 'main', orchestratedMode: true },`
- [x] `src/jobs/work-dispatch.test.ts:69` (instance #2) — rename `jarvis`→rune: `jarvis: { repoPath: '/repo/jarvis', baseBranch: 'main', orchestratedMode: true },`
- [x] `src/jobs/work-dispatch.test.ts:72` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/work-dispatch.test.ts:81` (instance #1) — rename `jarvis`→rune: `jarvis: { repoPath: '/repo/jarvis', baseBranch: 'main', orchestratedMode: false },`
- [x] `src/jobs/work-dispatch.test.ts:81` (instance #2) — rename `jarvis`→rune: `jarvis: { repoPath: '/repo/jarvis', baseBranch: 'main', orchestratedMode: false },`
- [x] `src/jobs/work-dispatch.test.ts:84` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/work-dispatch.test.ts:92` (instance #1) — rename `jarvis`→rune: `writeConfig({ jarvis: { repoPath: '/repo/jarvis', baseBranch: 'main' } });`
- [x] `src/jobs/work-dispatch.test.ts:92` (instance #2) — rename `jarvis`→rune: `writeConfig({ jarvis: { repoPath: '/repo/jarvis', baseBranch: 'main' } });`
- [x] `src/jobs/work-dispatch.test.ts:94` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/work-dispatch.test.ts:102` (instance #1) — rename `jarvis`→rune: `writeConfig({ jarvis: { repoPath: '/repo/jarvis', baseBranch: 'main' } });`
- [x] `src/jobs/work-dispatch.test.ts:102` (instance #2) — rename `jarvis`→rune: `writeConfig({ jarvis: { repoPath: '/repo/jarvis', baseBranch: 'main' } });`
- [x] `src/jobs/work-dispatch.test.ts:112` (instance #1) — rename `jarvis`→rune: `writeConfig({ jarvis: { repoPath: '/repo/jarvis', baseBranch: 'main', orchestratedMode: tr…`
- [x] `src/jobs/work-dispatch.test.ts:112` (instance #2) — rename `jarvis`→rune: `writeConfig({ jarvis: { repoPath: '/repo/jarvis', baseBranch: 'main', orchestratedMode: tr…`
- [x] `src/jobs/work-dispatch.test.ts:114` — rename `jarvis`→rune: `product: 'jarvis',`

### `src/jobs/work-dispatch.ts`

- [x] `src/jobs/work-dispatch.ts:6` — rename `Jarvis`→rune: `* the Jarvis-owned orchestrated loop ('orchestrated-work') or the legacy`

### `src/jobs/work-run-classify.test.ts`

- [x] `src/jobs/work-run-classify.test.ts:343` — rename `Jarvis`→rune: `// --- system-cancel: a Jarvis backstop reap (quiet→cancel / max-runtime) is`
- [x] `src/jobs/work-run-classify.test.ts:580` — rename `jarvis`→rune: `const branch = 'jarvis-gen-eval/mut-abc';`
- [x] `src/jobs/work-run-classify.test.ts:618` — rename `jarvis`→rune: `const branch = 'jarvis-gen-eval/mut-xyz';`

### `src/jobs/work-run-classify.ts`

- [x] `src/jobs/work-run-classify.ts:54` — rename `Jarvis`→rune: `*  - 'system-cancel' — a Jarvis backstop reaped the run on its own (the P2.7`
- [x] `src/jobs/work-run-classify.ts:330` — rename `Jarvis`→rune: `// A Jarvis backstop reap (quiet→cancel / max-runtime ceiling), not a user`

### `src/jobs/work-run-finalizer.test.ts`

- [x] `src/jobs/work-run-finalizer.test.ts:71` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/work-run-finalizer.test.ts:72` — rename `jarvis`→rune: `branch: 'jarvis-work/15-work-run-finalizer',`
- [x] `src/jobs/work-run-finalizer.test.ts:194` — rename `jarvis`→rune: `return '${DEFAULT_RUN_ID}:merge-success:jarvis-work/15-work-run-finalizer:pushed-not-delet…`
- [x] `src/jobs/work-run-finalizer.test.ts:456` — rename `jarvis`→rune: `tmpRoot = mkdtempSync(join(tmpdir(), 'jarvis-project-done-branch-test-'));`
- [x] `src/jobs/work-run-finalizer.test.ts:458` — rename `jarvis`→rune: `const branch = 'jarvis-work/14-product-team-agents';`
- [x] `src/jobs/work-run-finalizer.test.ts:551` — rename `jarvis`→rune: `tmpRoot = mkdtempSync(join(tmpdir(), 'jarvis-project-done-branch-test-'));`
- [x] `src/jobs/work-run-finalizer.test.ts:557` — rename `jarvis`→rune: `git(repoPath, 'checkout', '-q', '-b', 'jarvis-work/no-index');`
- [x] `src/jobs/work-run-finalizer.test.ts:698` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/work-run-finalizer.test.ts:699` — rename `jarvis`→rune: `branch: 'jarvis-work/15-work-run-finalizer',`
- [x] `src/jobs/work-run-finalizer.test.ts:822` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/work-run-finalizer.test.ts:823` — rename `jarvis`→rune: `branch: 'jarvis-work/15-work-run-finalizer',`
- [x] `src/jobs/work-run-finalizer.test.ts:912` — rename `jarvis`→rune: `key: expect.stringMatching(new RegExp('${DEFAULT_RUN_ID}.*jarvis-work/15-work-run-finalize…`

### `src/jobs/work-run-finalizer.ts`

- [x] `src/jobs/work-run-finalizer.ts:146` — rename `jarvis`→rune: `/** The work branch (e.g. 'jarvis-work/15-...'). */`
- [x] `src/jobs/work-run-finalizer.ts:503` — rename `Jarvis`→rune: `const committerName = process.env.GIT_COMMITTER_NAME ?? process.env.GIT_AUTHOR_NAME ?? 'Ja…`
- [x] `src/jobs/work-run-finalizer.ts:505` — rename `jarvis`→rune: `process.env.GIT_COMMITTER_EMAIL ?? process.env.GIT_AUTHOR_EMAIL ?? 'jarvis@example.com';`

### `src/jobs/work-run-forensics.test.ts`

- [x] `src/jobs/work-run-forensics.test.ts:82` — rename `jarvis`→rune: `branch: 'jarvis-work/abcd1234',`
- [x] `src/jobs/work-run-forensics.test.ts:97` — rename `jarvis`→rune: `expect(statCall?.args.some(a => a.includes('deadbeef1234567890abcdef1234567890abcdef..jarv…`
- [x] `src/jobs/work-run-forensics.test.ts:123` — rename `jarvis`→rune: `expect(bundleCall!.args.some(a => a.includes('jarvis-work/abcd1234'))).toBe(true);`

### `src/jobs/work-run-gate-runtime.test.ts`

- [x] `src/jobs/work-run-gate-runtime.test.ts:36` — rename `jarvis`→rune: `const BRANCH = 'jarvis-work/feature';`
- [x] `src/jobs/work-run-gate-runtime.test.ts:78` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/work-run-gate-runtime.test.ts:102` — rename `jarvis`→rune: `tmpRoot = mkdtempSync(join(tmpdir(), 'jarvis-gate-runtime-test-'));`

### `src/jobs/work-run-gate-runtime.ts`

- [x] `src/jobs/work-run-gate-runtime.ts:60` — rename `jarvis`→rune: `/** The feature/work branch (e.g. 'jarvis-work/15-…'). */`
- [x] `src/jobs/work-run-gate-runtime.ts:127` — rename `Jarvis`→rune: `* with the active-process registry so a graceful Jarvis shutdown reaps it too.`
- [x] `src/jobs/work-run-gate-runtime.ts:155` — rename `Jarvis`→rune: `// unref'd so a validation command in flight during a graceful Jarvis`

### `src/jobs/work-run-gc-runner.ts`

- [x] `src/jobs/work-run-gc-runner.ts:28` — rename `Jarvis`→rune: `* Scope note: 'workRunsDir' ('logs/work-runs/') is Jarvis-global, so the dir-level`

### `src/jobs/work-run-gc.test.ts`

- [x] `src/jobs/work-run-gc.test.ts:37` — rename `jarvis`→rune: `branch: 'jarvis-work/${id}',`
- [x] `src/jobs/work-run-gc.test.ts:126` — rename `jarvis`→rune: `JSON.stringify({ id, outcome: 'noop', branch: 'jarvis-work/${id}', endedAt: '2026-05-30T1$…`
- [x] `src/jobs/work-run-gc.test.ts:150` — rename `jarvis`→rune: `const { stub } = makeGitStub('jarvis-work/run-0'); // run-0's branch is live`
- [x] `src/jobs/work-run-gc.test.ts:155` — rename `jarvis`→rune: `productRepos: { jarvis: '/fake/repo' },`
- [x] `src/jobs/work-run-gc.test.ts:182` — rename `jarvis`→rune: `productRepos: { jarvis: '/fake/repo' },`
- [x] `src/jobs/work-run-gc.test.ts:192` — rename `jarvis`→rune: `expect(calls.some((c) => c.includes('branch') && c.some((a) => a.includes('jarvis-work/run…`
- [x] `src/jobs/work-run-gc.test.ts:204` — rename `jarvis`→rune: `productRepos: { jarvis: '/fake/repo' },`
- [x] `src/jobs/work-run-gc.test.ts:215` — rename `jarvis`→rune: `expect(branchPrune!.some(a => a.includes('jarvis-work/run-0'))).toBe(true);`
- [x] `src/jobs/work-run-gc.test.ts:235` — rename `jarvis`→rune: `const SHARED = 'jarvis-work/09-expand-cockpit';`
- [x] `src/jobs/work-run-gc.test.ts:242` — rename `jarvis`→rune: `productRepos: { jarvis: '/fake/repo' },`
- [x] `src/jobs/work-run-gc.test.ts:257` — rename `jarvis`→rune: `const SHARED = 'jarvis-work/09-expand-cockpit';`
- [x] `src/jobs/work-run-gc.test.ts:264` — rename `jarvis`→rune: `productRepos: { jarvis: '/fake/repo' },`
- [x] `src/jobs/work-run-gc.test.ts:278` — rename `jarvis`→rune: `// A jarvis run and an aura run both age out. Each branch ref lives in its own`
- [x] `src/jobs/work-run-gc.test.ts:290` (instance #1) — rename `jarvis`→rune: `seed('run-jarvis', 0, 'jarvis', 'jarvis-work/09-cockpit');`
- [x] `src/jobs/work-run-gc.test.ts:290` (instance #2) — rename `jarvis`→rune: `seed('run-jarvis', 0, 'jarvis', 'jarvis-work/09-cockpit');`
- [x] `src/jobs/work-run-gc.test.ts:290` (instance #3) — rename `jarvis`→rune: `seed('run-jarvis', 0, 'jarvis', 'jarvis-work/09-cockpit');`
- [x] `src/jobs/work-run-gc.test.ts:291` — rename `jarvis`→rune: `seed('run-aura', 1, 'aura', 'jarvis-work/03-mobile');`
- [x] `src/jobs/work-run-gc.test.ts:303` (instance #1) — rename `jarvis`→rune: `productRepos: { jarvis: '/repos/jarvis', aura: '/repos/aura' },`
- [x] `src/jobs/work-run-gc.test.ts:303` (instance #2) — rename `jarvis`→rune: `productRepos: { jarvis: '/repos/jarvis', aura: '/repos/aura' },`
- [x] `src/jobs/work-run-gc.test.ts:310` — rename `jarvis`→rune: `expect([...result.deletedIds].sort()).toEqual(['run-aura', 'run-jarvis']);`
- [x] `src/jobs/work-run-gc.test.ts:313` (instance #1) — rename `jarvis`→rune: `const jarvisPrune = calls.find(c => c.args.includes('branch') && c.args.includes('jarvis-w…`
- [x] `src/jobs/work-run-gc.test.ts:313` (instance #2) — rename `jarvis`→rune: `const jarvisPrune = calls.find(c => c.args.includes('branch') && c.args.includes('jarvis-w…`
- [x] `src/jobs/work-run-gc.test.ts:314` — rename `jarvis`→rune: `const auraPrune = calls.find(c => c.args.includes('branch') && c.args.includes('jarvis-wor…`
- [x] `src/jobs/work-run-gc.test.ts:315` (instance #1) — rename `jarvis`→rune: `expect(jarvisPrune?.cwd).toBe('/repos/jarvis');`
- [x] `src/jobs/work-run-gc.test.ts:315` (instance #2) — rename `jarvis`→rune: `expect(jarvisPrune?.cwd).toBe('/repos/jarvis');`
- [x] `src/jobs/work-run-gc.test.ts:322` — rename `jarvis`→rune: `expect(wtListCwds).toContain('/repos/jarvis');`
- [x] `src/jobs/work-run-gc.test.ts:332` — rename `jarvis`→rune: `productRepos: { jarvis: '/fake/repo' },`
- [x] `src/jobs/work-run-gc.test.ts:356` — rename `jarvis`→rune: `productRepos: { jarvis: '/fake/repo' },`

### `src/jobs/work-run-gc.ts`

- [x] `src/jobs/work-run-gc.ts:51` — rename `jarvis`→rune: `*  in for pruning. Absent on pre-multi-product summaries (all jarvis then),`
- [x] `src/jobs/work-run-gc.ts:52` — rename `jarvis`→rune: `*  so callers default to ''jarvis''. */`
- [x] `src/jobs/work-run-gc.ts:210` — rename `jarvis`→rune: `// The stable per-project resume branch ('jarvis-work/<slug>') is shared by`
- [x] `src/jobs/work-run-gc.ts:239` — rename `jarvis`→rune: `if (!branch.startsWith('jarvis-work/')) {`
- [x] `src/jobs/work-run-gc.ts:243` — rename `jarvis`→rune: `// The branch lives in the run's own product repo. Default to 'jarvis' for`
- [x] `src/jobs/work-run-gc.ts:244` — rename `jarvis`→rune: `// pre-multi-product summaries (every run was jarvis then).`
- [x] `src/jobs/work-run-gc.ts:245` — rename `jarvis`→rune: `const product = e?.product ?? 'jarvis';`

### `src/jobs/work-run-merge-lock.test.ts`

- [x] `src/jobs/work-run-merge-lock.test.ts:49` — rename `jarvis`→rune: `// ("jar","vis/main") collide with ("jarvis","/main"). The gate runtime keys`
- [x] `src/jobs/work-run-merge-lock.test.ts:51` (instance #1) — rename `jarvis`→rune: `expect(baseBranchLockKey('jarvis', 'main')).toBe('jarvis:main');`
- [x] `src/jobs/work-run-merge-lock.test.ts:51` (instance #2) — rename `jarvis`→rune: `expect(baseBranchLockKey('jarvis', 'main')).toBe('jarvis:main');`
- [x] `src/jobs/work-run-merge-lock.test.ts:55` (instance #1) — rename `jarvis`→rune: `expect(baseBranchLockKey('jarvis', 'main')).toBe(baseBranchLockKey('jarvis', 'main'));`
- [x] `src/jobs/work-run-merge-lock.test.ts:55` (instance #2) — rename `jarvis`→rune: `expect(baseBranchLockKey('jarvis', 'main')).toBe(baseBranchLockKey('jarvis', 'main'));`
- [x] `src/jobs/work-run-merge-lock.test.ts:59` (instance #1) — rename `jarvis`→rune: `expect(baseBranchLockKey('jarvis', 'main')).not.toBe(baseBranchLockKey('jarvis', 'release'…`
- [x] `src/jobs/work-run-merge-lock.test.ts:59` (instance #2) — rename `jarvis`→rune: `expect(baseBranchLockKey('jarvis', 'main')).not.toBe(baseBranchLockKey('jarvis', 'release'…`
- [x] `src/jobs/work-run-merge-lock.test.ts:63` — rename `jarvis`→rune: `expect(baseBranchLockKey('jarvis', 'main')).not.toBe(baseBranchLockKey('aura', 'main'));`
- [x] `src/jobs/work-run-merge-lock.test.ts:72` — rename `jarvis`→rune: `'jarvis', 'main', 'project-A',`
- [x] `src/jobs/work-run-merge-lock.test.ts:75` — rename `jarvis`→rune: `'jarvis', 'main', 'project-B',`
- [x] `src/jobs/work-run-merge-lock.test.ts:88` — rename `jarvis`→rune: `const p1 = withBaseBranchLock('jarvis', 'main', async () => {`
- [x] `src/jobs/work-run-merge-lock.test.ts:93` — rename `jarvis`→rune: `const p2 = withBaseBranchLock('jarvis', 'main', async () => {`
- [x] `src/jobs/work-run-merge-lock.test.ts:112` — rename `jarvis`→rune: `const a = withBaseBranchLock('jarvis', 'main', async () => {`
- [x] `src/jobs/work-run-merge-lock.test.ts:117` — rename `jarvis`→rune: `const b = withBaseBranchLock('jarvis', 'release', async () => {`
- [x] `src/jobs/work-run-merge-lock.test.ts:131` — rename `jarvis`→rune: `withBaseBranchLock('jarvis', 'main', async () => {`
- [x] `src/jobs/work-run-merge-lock.test.ts:137` — rename `jarvis`→rune: `const ran = await withBaseBranchLock('jarvis', 'main', async () => 'ok');`
- [x] `src/jobs/work-run-merge-lock.test.ts:142` — rename `jarvis`→rune: `const value = await withBaseBranchLock('jarvis', 'main', async () => 42);`

### `src/jobs/work-run-merge-lock.ts`

- [x] `src/jobs/work-run-merge-lock.ts:15` — rename `Jarvis`→rune: `* only Jarvis's OWN finalize sequence; the '/work' child is a separate actor.`
- [x] `src/jobs/work-run-merge-lock.ts:16` — rename `Jarvis`→rune: `* Because Jarvis is a single local daemon (the single-writer assumption), an`
- [x] `src/jobs/work-run-merge-lock.ts:17` — rename `Jarvis`→rune: `* in-process mutex is sufficient — there is no second Jarvis process contending`
- [x] `src/jobs/work-run-merge-lock.ts:21` — rename `Jarvis`→rune: `* 'src/jobs/supervision-store.ts' (one Jarvis process per machine is the v1`
- [x] `src/jobs/work-run-merge-lock.ts:46` — rename `jarvis`→rune: `* ('jarvis','/main'). Takes no project arg — that is the whole point.`

### `src/jobs/work-run-noop-e2e.test.ts`

- [x] `src/jobs/work-run-noop-e2e.test.ts:56` — rename `jarvis`→rune: `const TEST_PROJECT_ROOT = '/test/jarvis';`
- [x] `src/jobs/work-run-noop-e2e.test.ts:101` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/work-run-noop-e2e.test.ts:102` — rename `jarvis`→rune: `repoPath: '/test/repo/jarvis',`
- [x] `src/jobs/work-run-noop-e2e.test.ts:117` — rename `jarvis`→rune: `const FAKE_WORKTREE = '/test/worktrees/jarvis/06-webview';`
- [x] `src/jobs/work-run-noop-e2e.test.ts:120` — rename `jarvis`→rune: `product: 'jarvis',`

### `src/jobs/work-run-reconciler.test.ts`

- [x] `src/jobs/work-run-reconciler.test.ts:23` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/work-run-reconciler.test.ts:54` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/work-run-reconciler.test.ts:91` — rename `jarvis`→rune: `payload: { projectSlug: '14-product-team-agents', product: 'jarvis' },`
- [x] `src/jobs/work-run-reconciler.test.ts:99` — rename `jarvis`→rune: `const dir = mkdtempSync(join(tmpdir(), 'jarvis-work-run-reconciler-test-'));`

### `src/jobs/work-run-release.test.ts`

- [x] `src/jobs/work-run-release.test.ts:37` — rename `jarvis`→rune: `const WORKTREE = '/tmp/test-worktrees/jarvis/06-webview';`
- [x] `src/jobs/work-run-release.test.ts:43` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/work-run-release.test.ts:58` — rename `jarvis`→rune: `data: { outcome: 'branch-complete', merged: true, projectSlug: '06-webview', product: 'jar…`

### `src/jobs/work-run-release.ts`

- [x] `src/jobs/work-run-release.ts:506` — rename `jarvis`→rune: `const message = 'jarvis(${run.product}): merge released work-run branch ${branch}';`
- [x] `src/jobs/work-run-release.ts:564` — rename `jarvis`→rune: `((h.descriptor.payload as { product?: string }).product ?? 'jarvis') === product &&`

### `src/jobs/work-run-sentinel.ts`

- [x] `src/jobs/work-run-sentinel.ts:8` — rename `JARVIS`→rune: `*   JARVIS_WORK_RUN_SENTINEL { "version": 1, "pendingCheck": "…", "command"?: "…", "reason…`
- [x] `src/jobs/work-run-sentinel.ts:23` — rename `JARVIS`→rune: `export const WORK_RUN_SENTINEL_MARKER = 'JARVIS_WORK_RUN_SENTINEL';`
- [x] `src/jobs/work-run-sentinel.ts:56` — rename `JARVIS`→rune: `*  - The sentinel is 'JARVIS_WORK_RUN_SENTINEL ' followed by a JSON object, on a`
- [x] `src/jobs/work-run-sentinel.ts:73` — rename `JARVIS`→rune: `// ("the JARVIS_WORK_RUN_SENTINEL is…") never trips a false park.`

### `src/jobs/work-run-store.test.ts`

- [x] `src/jobs/work-run-store.test.ts:58` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/work-run-store.test.ts:77` — rename `jarvis`→rune: `branch: 'jarvis-gen-eval/mut-test-001',`

### `src/jobs/work-run-transcript.test.ts`

- [x] `src/jobs/work-run-transcript.test.ts:459` — rename `jarvis`→rune: `content: '---BRANCH---\njarvis-work/7b8410fb',`

### `src/jobs/work-runner.test.ts`

- [x] `src/jobs/work-runner.test.ts:37` — rename `jarvis`→rune: `const TEST_PROJECT_ROOT = '/test/jarvis';`
- [x] `src/jobs/work-runner.test.ts:114` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/work-runner.test.ts:115` — rename `jarvis`→rune: `repoPath: '/test/repo/jarvis',`
- [x] `src/jobs/work-runner.test.ts:157` — rename `jarvis`→rune: `const FAKE_WORKTREE = '/test/worktrees/jarvis/06-webview';`
- [x] `src/jobs/work-runner.test.ts:160` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/jobs/work-runner.test.ts:317` — rename `jarvis`→rune: `payload: { projectSlug: '06-webview', product: 'jarvis' },`
- [x] `src/jobs/work-runner.test.ts:482` — rename `Jarvis`→rune: `// means an agent editing Jarvis's source files triggers tsx watch to`
- [x] `src/jobs/work-runner.test.ts:1072` (instance #1) — rename `jarvis`→rune: `it('calls createWorktree with product=jarvis, project=slug, branch=jarvis-work/<slug>', as…`
- [x] `src/jobs/work-runner.test.ts:1072` (instance #2) — rename `jarvis`→rune: `it('calls createWorktree with product=jarvis, project=slug, branch=jarvis-work/<slug>', as…`
- [x] `src/jobs/work-runner.test.ts:1091` — rename `jarvis`→rune: `expect(callArgs.product).toBe('jarvis');`
- [x] `src/jobs/work-runner.test.ts:1096` — rename `jarvis`→rune: `expect(callArgs.branch).toBe('jarvis-work/06-webview');`
- [x] `src/jobs/work-runner.test.ts:1140` — rename `jarvis`→rune: `it('honors payload.product when present (not hardcoded to jarvis)', async () => {`
- [x] `src/jobs/work-runner.test.ts:1143` — rename `jarvis`→rune: `// worktree against aura's repo, not jarvis.`
- [x] `src/jobs/work-runner.test.ts:1608` — rename `jarvis`→rune: `expect(terminal.data.product).toBe('jarvis');`
- [x] `src/jobs/work-runner.test.ts:1679` — rename `jarvis`→rune: `expect(opts.branch).toBe('jarvis-work/06-webview'); // stable per-project branch`
- [x] `src/jobs/work-runner.test.ts:1962` — rename `jarvis`→rune: `expect(mockWithBaseBranchLock).toHaveBeenCalledWith('jarvis', 'main', expect.any(Function)…`
- [x] `src/jobs/work-runner.test.ts:2176` — rename `jarvis`→rune: `const OPERATOR_WORKTREE = '/tmp/test-worktrees/jarvis/06-webview';`
- [x] `src/jobs/work-runner.test.ts:2250` — rename `jarvis`→rune: `payload: { projectSlug: '06-webview', product: 'jarvis' },`
- [x] `src/jobs/work-runner.test.ts:2279` — rename `JARVIS`→rune: `//  - On a parsed JARVIS_WORK_RUN_SENTINEL, write a durable supervision`
- [x] `src/jobs/work-runner.test.ts:2293` — rename `JARVIS`→rune: `'JARVIS_WORK_RUN_SENTINEL {"version":1,"pendingCheck":"Run the interactive Codex check and…`
- [x] `src/jobs/work-runner.test.ts:2342` — rename `jarvis`→rune: `{ id: 'parked-1', product: 'jarvis', project: '06-webview', status: 'blocked-on-human', st…`
- [x] `src/jobs/work-runner.test.ts:2344` — rename `jarvis`→rune: `const result = workRunApplier.validate({ projectSlug: '06-webview', product: 'jarvis' });`
- [x] `src/jobs/work-runner.test.ts:2358` — rename `jarvis`→rune: `const worktree = '/tmp/test-worktrees/jarvis/06-webview';`
- [x] `src/jobs/work-runner.test.ts:2367` — rename `jarvis`→rune: `const result = workRunApplier.validate({ projectSlug: '06-webview', product: 'jarvis' });`

### `src/jobs/work-runner.ts`

- [x] `src/jobs/work-runner.ts:187` — rename `jarvis`→rune: `* ''jarvis'' for back-compat with existing cockpit start paths that didn't`
- [x] `src/jobs/work-runner.ts:218` (instance #1) — rename `jarvis`→rune: `// jarvis-on-jarvis) is the same commit the live tree is on.`
- [x] `src/jobs/work-runner.ts:218` (instance #2) — rename `jarvis`→rune: `// jarvis-on-jarvis) is the same commit the live tree is on.`
- [x] `src/jobs/work-runner.ts:237` — rename `jarvis`→rune: `const product = payload.product ?? 'jarvis';`
- [x] `src/jobs/work-runner.ts:286` — rename `jarvis`→rune: `const product = descriptor.payload.product ?? 'jarvis';`
- [x] `src/jobs/work-runner.ts:416` — rename `Jarvis`→rune: `// the parent when the agent edits Jarvis's own source files. The`
- [x] `src/jobs/work-runner.ts:498` — rename `JARVIS`→rune: `// The run emitted a valid JARVIS_WORK_RUN_SENTINEL — it hit a step`
- [x] `src/jobs/work-runner.ts:633` — rename `jarvis`→rune: `((h.descriptor.payload as WorkRunPayload).product ?? 'jarvis') === product &&`
- [x] `src/jobs/work-runner.ts:850` — rename `jarvis`→rune: `const message = 'jarvis(${product}): merge work-run branch ${branch}';`

### `src/jobs/worktree-sweep.test.ts`

- [x] `src/jobs/worktree-sweep.test.ts:28` — rename `jarvis`→rune: `const WT = '/tmp/worktrees/jarvis/15-work-run-finalizer';`
- [x] `src/jobs/worktree-sweep.test.ts:45` — rename `jarvis`→rune: `const procs = [proc(201, '/tmp/worktrees/jarvis/99-other-project')];`
- [x] `src/jobs/worktree-sweep.test.ts:58` — rename `jarvis`→rune: `proc(2, '/tmp/worktrees/jarvis/99-other'), // out (other run)`
- [x] `src/jobs/worktree-sweep.test.ts:107` — rename `jarvis`→rune: `{ pid: 2, cwd: '/tmp/worktrees/jarvis/99-other' }, // out`
- [x] `src/jobs/worktree-sweep.test.ts:120` — rename `jarvis`→rune: `[{ pid: 10, cwd: '/private/tmp/worktrees/jarvis/15-work-run-finalizer/sub' }],`

### `src/kb/engine.test.ts`

- [x] `src/kb/engine.test.ts:89` — rename `jarvis`→rune: `// Regression: a stuck 'projects/jarvis.md' entry re-failed every nightly`

### `src/kb/queue.test.ts`

- [x] `src/kb/queue.test.ts:6` — rename `jarvis`→rune: `const tmpDir = join(tmpdir(), 'jarvis-test-${Date.now()}');`

### `src/kb/search.test.ts`

- [x] `src/kb/search.test.ts:100` — rename `jarvis`→rune: `path: { text: '/workspace/jarvis/src/server/webview.ts' },`
- [x] `src/kb/search.test.ts:108` — rename `jarvis`→rune: `path: { text: '/workspace/jarvis/docs/projects/17-cockpit-redesign/spec.md' },`
- [x] `src/kb/search.test.ts:118` — rename `jarvis`→rune: `repoPath: '/workspace/jarvis',`
- [x] `src/kb/search.test.ts:130` — rename `jarvis`→rune: `expect.arrayContaining(['/workspace/jarvis']),`

### `src/mcp/tools/log-idea.test.ts`

- [x] `src/mcp/tools/log-idea.test.ts:90` — rename `jarvis`→rune: `return ['aura', 'assay', 'jarvis', 'relay'];`

### `src/reviews/interview.test.ts`

- [x] `src/reviews/interview.test.ts:13` — rename `jarvis`→rune: `LOGS_DIR: '/tmp/jarvis-test-logs',`
- [x] `src/reviews/interview.test.ts:14` — rename `jarvis`→rune: `get PLAYBOOK_QUEUE_FILE() { return '/tmp/jarvis-test-logs/playbook-queue.json'; },`
- [x] `src/reviews/interview.test.ts:15` — rename `jarvis`→rune: `get REVIEW_SESSIONS_FILE() { return '/tmp/jarvis-test-logs/review-sessions.json'; },`
- [x] `src/reviews/interview.test.ts:16` — rename `jarvis`→rune: `get SESSIONS_FILE() { return '/tmp/jarvis-test-logs/tg-sessions.json'; },`

### `src/reviews/interview.ts`

- [x] `src/reviews/interview.ts:136` — rename `Jarvis`→rune: `prepSections.push('# Pending Ask-Twice Proposals (${proposals.length})\n${proposalList}\n\…`
- [x] `src/reviews/interview.ts:415` — rename `Jarvis`→rune: `// vault, not the Jarvis repo.`
- [x] `src/reviews/interview.ts:417` — rename `Jarvis`→rune: `'Action approved Ask-Twice proposals from \'${PROJECT_ROOT}/logs/proposal-queue.json\'. Cr…`
- [x] `src/reviews/interview.ts:457` — rename `Jarvis`→rune: `summarize('proposals', 'Ask-Twice proposals actioned (restart Jarvis to pick up new cron a…`

### `src/reviews/monthly.test.ts`

- [x] `src/reviews/monthly.test.ts:9` — rename `jarvis`→rune: `LOGS_DIR: '/tmp/jarvis-test-logs',`
- [x] `src/reviews/monthly.test.ts:10` — rename `jarvis`→rune: `get PLAYBOOK_QUEUE_FILE() { return '/tmp/jarvis-test-logs/playbook-queue.json'; },`
- [x] `src/reviews/monthly.test.ts:11` — rename `jarvis`→rune: `get REVIEW_SESSIONS_FILE() { return '/tmp/jarvis-test-logs/review-sessions.json'; },`
- [x] `src/reviews/monthly.test.ts:12` — rename `jarvis`→rune: `get SESSIONS_FILE() { return '/tmp/jarvis-test-logs/tg-sessions.json'; },`

### `src/reviews/new-project.test.ts`

- [x] `src/reviews/new-project.test.ts:126` — rename `Jarvis`→rune: `"Let's plan a new Jarvis project.",`
- [x] `src/reviews/new-project.test.ts:160` — rename `Jarvis`→rune: `expect(prepContextCall![1].prepContext).toContain('plan a new Jarvis project');`
- [x] `src/reviews/new-project.test.ts:314` — rename `Jarvis`→rune: `WHEN the user runs /digest THEN Jarvis sends a summary of today's articles.';`

### `src/reviews/planning-handler.test.ts`

- [x] `src/reviews/planning-handler.test.ts:56` — rename `jarvis`→rune: `tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-planning-handler-test-'));`

### `src/reviews/planning.test.ts`

- [x] `src/reviews/planning.test.ts:54` — rename `jarvis`→rune: `tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-planning-store-test-'));`
- [x] `src/reviews/planning.test.ts:322` — rename `jarvis`→rune: `id, product: 'jarvis', backlogItemId: 'b1',`
- [x] `src/reviews/planning.test.ts:329` — rename `jarvis`→rune: `createPlanningSession(7, 'idea', 'cockpit', 'jarvis');`
- [x] `src/reviews/planning.test.ts:339` — rename `jarvis`→rune: `createPlanningSession(8, 'idea', 'cockpit', 'jarvis');`
- [x] `src/reviews/planning.test.ts:355` — rename `jarvis`→rune: `createPlanningSession(11, 'idea', 'cockpit', 'jarvis');`
- [x] `src/reviews/planning.test.ts:367` — rename `jarvis`→rune: `createPlanningSession(9, 'idea', 'cockpit', 'jarvis');`
- [x] `src/reviews/planning.test.ts:376` — rename `jarvis`→rune: `createPlanningSession(10, 'idea', 'cockpit', 'jarvis');`

### `src/reviews/planning.ts`

- [x] `src/reviews/planning.ts:9` — rename `Jarvis`→rune: `* back from disk so a Jarvis restart doesn't lose an in-flight planning`

### `src/reviews/quarterly.test.ts`

- [x] `src/reviews/quarterly.test.ts:9` — rename `jarvis`→rune: `LOGS_DIR: '/tmp/jarvis-test-logs',`
- [x] `src/reviews/quarterly.test.ts:10` — rename `jarvis`→rune: `get PLAYBOOK_QUEUE_FILE() { return '/tmp/jarvis-test-logs/playbook-queue.json'; },`
- [x] `src/reviews/quarterly.test.ts:11` — rename `jarvis`→rune: `get REVIEW_SESSIONS_FILE() { return '/tmp/jarvis-test-logs/review-sessions.json'; },`
- [x] `src/reviews/quarterly.test.ts:12` — rename `jarvis`→rune: `get SESSIONS_FILE() { return '/tmp/jarvis-test-logs/tg-sessions.json'; },`

### `src/reviews/session.test.ts`

- [x] `src/reviews/session.test.ts:6` — rename `jarvis`→rune: `const tmpDir = join(tmpdir(), 'jarvis-review-sessions-test-${Date.now()}');`

### `src/reviews/weekly.test.ts`

- [x] `src/reviews/weekly.test.ts:11` — rename `jarvis`→rune: `LOGS_DIR: '/tmp/jarvis-test-logs',`

### `src/reviews/yearly.test.ts`

- [x] `src/reviews/yearly.test.ts:9` — rename `jarvis`→rune: `LOGS_DIR: '/tmp/jarvis-test-logs',`
- [x] `src/reviews/yearly.test.ts:10` — rename `jarvis`→rune: `get PLAYBOOK_QUEUE_FILE() { return '/tmp/jarvis-test-logs/playbook-queue.json'; },`
- [x] `src/reviews/yearly.test.ts:11` — rename `jarvis`→rune: `get REVIEW_SESSIONS_FILE() { return '/tmp/jarvis-test-logs/review-sessions.json'; },`
- [x] `src/reviews/yearly.test.ts:12` — rename `jarvis`→rune: `get SESSIONS_FILE() { return '/tmp/jarvis-test-logs/tg-sessions.json'; },`

### `src/roles/commit.ts`

- [x] `src/roles/commit.ts:6` — rename `jarvis`→rune: `* 'agents/<role>/memory.md' in the jarvis repo — never 'git add -A', so unrelated`
- [x] `src/roles/commit.ts:43` — rename `jarvis`→rune: `/** Repo root containing 'agents/<role>/memory.md'. Defaults to the jarvis repo`

### `src/roles/loader.ts`

- [x] `src/roles/loader.ts:14` — rename `jarvis`→rune: `* they live in the jarvis repo, not the Obsidian vault. The role is a closed`
- [x] `src/roles/loader.ts:45` — rename `jarvis`→rune: `/** Root holding every role's '<role>/{SOUL.md,memory.md}', in the jarvis repo. */`

### `src/roles/memory-writer.test.ts`

- [x] `src/roles/memory-writer.test.ts:322` — rename `jarvis`→rune: `tmpDir = mkdtempSync(join(tmpdir(), 'jarvis-test-role-'));`

### `src/server/__acceptance__/cockpit-real-product.acceptance.ts`

- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:3` — rename `Jarvis`→rune: `* Cockpit Redesign Phase 7 - LIVE real-product acceptance for Jarvis itself.`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:6` (instance #1) — rename `Jarvis`→rune: `* local Jarvis cockpit over HTTP/WebSocket against the real 'jarvis' product,`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:6` (instance #2) — rename `jarvis`→rune: `* local Jarvis cockpit over HTTP/WebSocket against the real 'jarvis' product,`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:11` — rename `JARVIS`→rune: `*   JARVIS_HTTP_SECRET=<local cockpit secret>`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:12` (instance #1) — rename `JARVIS`→rune: `*   JARVIS_ACCEPTANCE_MUTATE_REAL_JARVIS=1`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:12` (instance #2) — rename `JARVIS`→rune: `*   JARVIS_ACCEPTANCE_MUTATE_REAL_JARVIS=1`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:15` — rename `JARVIS`→rune: `*   JARVIS_ACCEPTANCE_BASE_URL=http://127.0.0.1:3847`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:16` (instance #1) — rename `JARVIS`→rune: `*   JARVIS_ACCEPTANCE_PRODUCT=jarvis`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:16` (instance #2) — rename `jarvis`→rune: `*   JARVIS_ACCEPTANCE_PRODUCT=jarvis`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:17` — rename `JARVIS`→rune: `*   JARVIS_ACCEPTANCE_PROJECT=17-cockpit-redesign`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:18` — rename `JARVIS`→rune: `*   JARVIS_ACCEPTANCE_TIMEOUT_MS=7200000`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:28` — rename `JARVIS`→rune: `const BASE_URL = env('JARVIS_ACCEPTANCE_BASE_URL', 'http://127.0.0.1:3847').replace(/\/$/,…`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:29` — rename `JARVIS`→rune: `const SECRET = env('JARVIS_HTTP_SECRET');`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:30` (instance #1) — rename `JARVIS`→rune: `const PRODUCT = env('JARVIS_ACCEPTANCE_PRODUCT', 'jarvis');`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:30` (instance #2) — rename `jarvis`→rune: `const PRODUCT = env('JARVIS_ACCEPTANCE_PRODUCT', 'jarvis');`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:31` — rename `JARVIS`→rune: `const PROJECT = env('JARVIS_ACCEPTANCE_PROJECT', '17-cockpit-redesign');`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:32` — rename `JARVIS`→rune: `const TIMEOUT_MS = Number(env('JARVIS_ACCEPTANCE_TIMEOUT_MS', String(2 * 60 * 60 * 1000)))…`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:33` (instance #1) — rename `JARVIS`→rune: `const MUTATE_REAL_JARVIS = process.env['JARVIS_ACCEPTANCE_MUTATE_REAL_JARVIS'] === '1';`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:33` (instance #2) — rename `JARVIS`→rune: `const MUTATE_REAL_JARVIS = process.env['JARVIS_ACCEPTANCE_MUTATE_REAL_JARVIS'] === '1';`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:33` (instance #3) — rename `JARVIS`→rune: `const MUTATE_REAL_JARVIS = process.env['JARVIS_ACCEPTANCE_MUTATE_REAL_JARVIS'] === '1';`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:152` — rename `jarvis`→rune: `const jarvisPulse = productFromPulse(home, PRODUCT);`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:153` — rename `jarvis`→rune: `assert(jarvisPulse.repoBacked === true, '${PRODUCT} must be repo-backed for real-product a…`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:388` (instance #1) — rename `JARVIS`→rune: `assert(MUTATE_REAL_JARVIS, 'set JARVIS_ACCEPTANCE_MUTATE_REAL_JARVIS=1 to run the real-pro…`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:388` (instance #2) — rename `JARVIS`→rune: `assert(MUTATE_REAL_JARVIS, 'set JARVIS_ACCEPTANCE_MUTATE_REAL_JARVIS=1 to run the real-pro…`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:388` (instance #3) — rename `JARVIS`→rune: `assert(MUTATE_REAL_JARVIS, 'set JARVIS_ACCEPTANCE_MUTATE_REAL_JARVIS=1 to run the real-pro…`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:389` — rename `JARVIS`→rune: `assert(Number.isFinite(TIMEOUT_MS) && TIMEOUT_MS > 0, 'JARVIS_ACCEPTANCE_TIMEOUT_MS must b…`
- [x] `src/server/__acceptance__/cockpit-real-product.acceptance.ts:394` — rename `Jarvis`→rune: `await poll('Jarvis cockpit server', async () => {`

### `src/server/backlog-append-api.test.ts`

- [x] `src/server/backlog-append-api.test.ts:82` — rename `JARVIS`→rune: `JARVIS_HTTP_SECRET: 'test-secret', OBSIDIAN_VAULT_NAME: 'TestVault', TELEGRAM_USER_ID: 42,`
- [x] `src/server/backlog-append-api.test.ts:83` — rename `JARVIS`→rune: `JARVIS_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']), IS_PRODUCTION: false as boolean…`

### `src/server/backlog-drawer.test.ts`

- [x] `src/server/backlog-drawer.test.ts:35` — rename `JARVIS`→rune: `JARVIS_HTTP_SECRET: 'test-secret',`
- [x] `src/server/backlog-drawer.test.ts:38` — rename `JARVIS`→rune: `JARVIS_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']),`

### `src/server/cockpit-backlog-counts.test.ts`

- [x] `src/server/cockpit-backlog-counts.test.ts:53` — rename `JARVIS`→rune: `JARVIS_HTTP_SECRET: 'test-secret',`
- [x] `src/server/cockpit-backlog-counts.test.ts:56` — rename `JARVIS`→rune: `JARVIS_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']),`

### `src/server/cockpit-ux.test.ts`

- [x] `src/server/cockpit-ux.test.ts:62` — rename `JARVIS`→rune: `JARVIS_HTTP_SECRET: 'test-secret',`
- [x] `src/server/cockpit-ux.test.ts:65` — rename `JARVIS`→rune: `JARVIS_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']),`
- [x] `src/server/cockpit-ux.test.ts:190` — rename `jarvis`→rune: `const AUTH_COOKIE = 'jarvis-auth=test-secret';`

### `src/server/fix-endpoint-api.test.ts`

- [x] `src/server/fix-endpoint-api.test.ts:36` — rename `JARVIS`→rune: `JARVIS_HTTP_SECRET: 'test-secret',`
- [x] `src/server/fix-endpoint-api.test.ts:39` — rename `JARVIS`→rune: `JARVIS_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']),`

### `src/server/home-products-api.test.ts`

- [x] `src/server/home-products-api.test.ts:43` — rename `JARVIS`→rune: `JARVIS_HTTP_SECRET: 'test-secret',`
- [x] `src/server/home-products-api.test.ts:46` — rename `JARVIS`→rune: `JARVIS_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']),`

### `src/server/http.test.ts`

- [x] `src/server/http.test.ts:10` — rename `JARVIS`→rune: `JARVIS_HTTP_SECRET: 'test-secret',`
- [x] `src/server/http.test.ts:72` — rename `JARVIS`→rune: `mockConfig.JARVIS_HTTP_SECRET = 'test-secret';`

### `src/server/http.ts`

- [x] `src/server/http.ts:98` — rename `Jarvis`→rune: `res.end('<h1>Whoop connection failed</h1><p>Check Jarvis logs for details.</p>');`

### `src/server/mcp-oauth.test.ts`

- [x] `src/server/mcp-oauth.test.ts:11` — rename `JARVIS`→rune: `*     gateSecret: string;       // JARVIS_HTTP_SECRET — the human-approval gate`
- [x] `src/server/mcp-oauth.test.ts:28` — rename `JARVIS`→rune: `* GET-with-secret contract would bake the JARVIS_HTTP_SECRET into all of`
- [x] `src/server/mcp-oauth.test.ts:66` — rename `JARVIS`→rune: `JARVIS_HTTP_SECRET: 'test-secret',`
- [x] `src/server/mcp-oauth.test.ts:67` — rename `JARVIS`→rune: `JARVIS_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']),`
- [x] `src/server/mcp-oauth.test.ts:423` — rename `JARVIS`→rune: `// Test 3 🔴 — Gate on JARVIS_HTTP_SECRET (the consent POST)`

### `src/server/plan-button-api.test.ts`

- [x] `src/server/plan-button-api.test.ts:25` — rename `JARVIS`→rune: `JARVIS_HTTP_SECRET: 'test-secret', OBSIDIAN_VAULT_NAME: 'TestVault', TELEGRAM_USER_ID: 42,`
- [x] `src/server/plan-button-api.test.ts:26` — rename `JARVIS`→rune: `JARVIS_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']), IS_PRODUCTION: false as boolean…`

### `src/server/planning-collision.test.ts`

- [x] `src/server/planning-collision.test.ts:24` — rename `JARVIS`→rune: `JARVIS_HTTP_SECRET: 'test-secret', OBSIDIAN_VAULT_NAME: 'TestVault', TELEGRAM_USER_ID: 42,`
- [x] `src/server/planning-collision.test.ts:25` — rename `JARVIS`→rune: `JARVIS_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']), IS_PRODUCTION: false as boolean…`

### `src/server/restart.ts`

- [x] `src/server/restart.ts:10` — rename `Jarvis`→rune: `* Restart the Jarvis daemon by asking launchd to kill + relaunch it.`

### `src/server/state-snapshot.test.ts`

- [x] `src/server/state-snapshot.test.ts:167` — rename `jarvis`→rune: `const productWebview = makeSession({ sessionId: 'jarvis-webview', model: 'opus', messageCo…`
- [x] `src/server/state-snapshot.test.ts:175` — rename `jarvis`→rune: `scope: { kind: 'product', product: 'jarvis' },`
- [x] `src/server/state-snapshot.test.ts:187` (instance #1) — rename `jarvis`→rune: `{ product: 'jarvis', transport: 'webview', sessionId: 'jarvis-webview', model: 'opus', mes…`
- [x] `src/server/state-snapshot.test.ts:187` (instance #2) — rename `jarvis`→rune: `{ product: 'jarvis', transport: 'webview', sessionId: 'jarvis-webview', model: 'opus', mes…`
- [x] `src/server/state-snapshot.test.ts:211` — rename `jarvis`→rune: `planning: { product: 'jarvis', status: 'scoping', surface: 'cockpit' },`
- [x] `src/server/state-snapshot.test.ts:215` — rename `jarvis`→rune: `product: 'jarvis',`

### `src/server/static/app.css`

- [x] `src/server/static/app.css:1` — rename `Jarvis`→rune: `/* Jarvis webview — Dracula theme.`

### `src/server/static/app.js`

- [x] `src/server/static/app.js:1` — rename `Jarvis`→rune: `/* Jarvis webview client */`
- [x] `src/server/static/app.js:99` — rename `jarvis`→rune: `window.jarvisConnectionStatus = 'disconnected';`
- [x] `src/server/static/app.js:113` — rename `jarvis`→rune: `window.dispatchEvent(new CustomEvent('jarvis-webview-frame', { detail: frame }));`
- [x] `src/server/static/app.js:116` — rename `jarvis`→rune: `// (it consumes the same frame via the jarvis-webview-frame event above).`
- [x] `src/server/static/app.js:214` — rename `jarvis`→rune: `window.jarvisSendWebviewMessage = function ({ product, text } = {}) {`
- [x] `src/server/static/app.js:224` — rename `jarvis`→rune: `window.jarvisConnectionStatus = status;`
- [x] `src/server/static/app.js:225` — rename `jarvis`→rune: `window.dispatchEvent(new CustomEvent('jarvis-connection-status', { detail: { status } }));`
- [x] `src/server/static/app.js:1347` — rename `jarvis`→rune: `// right repo. Optional in the API (defaults to 'jarvis' server-side`

### `src/server/static/client-view.js`

- [x] `src/server/static/client-view.js:120` — rename `jarvis`→rune: `window.jarvisClientRouter = router;`

### `src/server/static/home-view-client.test.ts`

- [x] `src/server/static/home-view-client.test.ts:120` — rename `jarvis`→rune: `productProject: 'jarvis',`
- [x] `src/server/static/home-view-client.test.ts:262` — rename `jarvis`→rune: `jarvisConnectionStatus: 'disconnected',`
- [x] `src/server/static/home-view-client.test.ts:280` — rename `jarvis`→rune: `(globalThis as any).window.jarvisConnectionStatus = 'connected';`
- [x] `src/server/static/home-view-client.test.ts:281` — rename `jarvis`→rune: `listeners.get('jarvis-connection-status')?.({ detail: { status: 'connected' } });`
- [x] `src/server/static/home-view-client.test.ts:285` — rename `jarvis`→rune: `expect((globalThis as any).window.removeEventListener).toHaveBeenCalledWith('jarvis-connec…`
- [x] `src/server/static/home-view-client.test.ts:348` — rename `jarvis`→rune: `name: 'jarvis',`

### `src/server/static/home-view.js`

- [x] `src/server/static/home-view.js:221` — rename `jarvis`→rune: `return window.jarvisConnectionStatus || 'disconnected';`
- [x] `src/server/static/home-view.js:244` — rename `jarvis`→rune: `window.addEventListener?.('jarvis-connection-status', onConnectionStatus);`
- [x] `src/server/static/home-view.js:315` — rename `jarvis`→rune: `window.removeEventListener?.('jarvis-connection-status', onConnectionStatus);`

### `src/server/static/index.html`

- [x] `src/server/static/index.html:8` — rename `Jarvis`→rune: `<title>Jarvis</title>`
- [x] `src/server/static/index.html:15` — rename `Jarvis`→rune: `<h2>Jarvis</h2>`
- [x] `src/server/static/index.html:71` — rename `Jarvis`→rune: `placeholder="Message Jarvis… (Cmd+Enter to send, Enter for newline)"`

### `src/server/static/product-deep-view-client.test.ts`

- [x] `src/server/static/product-deep-view-client.test.ts:1111` — rename `jarvis`→rune: `listeners.get('jarvis-webview-frame')?.({`
- [x] `src/server/static/product-deep-view-client.test.ts:1127` — rename `jarvis`→rune: `listeners.get('jarvis-webview-frame')?.({`
- [x] `src/server/static/product-deep-view-client.test.ts:1143` — rename `jarvis`→rune: `listeners.get('jarvis-webview-frame')?.({`
- [x] `src/server/static/product-deep-view-client.test.ts:1184` — rename `jarvis`→rune: `listeners.get('jarvis-webview-frame')?.({`
- [x] `src/server/static/product-deep-view-client.test.ts:1224` — rename `jarvis`→rune: `listeners.get('jarvis-webview-frame')?.({`
- [x] `src/server/static/product-deep-view-client.test.ts:1265` — rename `jarvis`→rune: `listeners.get('jarvis-webview-frame')?.({`
- [x] `src/server/static/product-deep-view-client.test.ts:1583` — rename `jarvis`→rune: `jarvisSendWebviewMessage: vi.fn(() => true),`
- [x] `src/server/static/product-deep-view-client.test.ts:1600` — rename `jarvis`→rune: `expect((globalThis as any).window.jarvisSendWebviewMessage).toHaveBeenCalledWith({`
- [x] `src/server/static/product-deep-view-client.test.ts:1606` — rename `jarvis`→rune: `listeners.get('jarvis-webview-frame')?.({ detail: { kind: 'message', text: 'Next: pick the…`
- [x] `src/server/static/product-deep-view-client.test.ts:1610` — rename `jarvis`→rune: `expect((globalThis as any).window.removeEventListener).toHaveBeenCalledWith('jarvis-webvie…`

### `src/server/static/product-deep-view.js`

- [x] `src/server/static/product-deep-view.js:537` — rename `jarvis`→rune: `if (typeof window !== 'undefined' && typeof window.jarvisSendWebviewMessage === 'function'…`
- [x] `src/server/static/product-deep-view.js:538` — rename `jarvis`→rune: `const sent = window.jarvisSendWebviewMessage({ product, text });`
- [x] `src/server/static/product-deep-view.js:554` — rename `jarvis`→rune: `: 'jarvis';`
- [x] `src/server/static/product-deep-view.js:1229` — rename `jarvis`→rune: `window.addEventListener?.('jarvis-webview-frame', onWebviewFrame);`
- [x] `src/server/static/product-deep-view.js:1286` — rename `jarvis`→rune: `window.removeEventListener?.('jarvis-webview-frame', onWebviewFrame);`

### `src/server/webview-bootstrap.test.ts`

- [x] `src/server/webview-bootstrap.test.ts:22` — rename `jarvis`→rune: `const scope = { kind: 'product' as const, product: 'jarvis' };`

### `src/server/webview.test.ts`

- [x] `src/server/webview.test.ts:50` — rename `JARVIS`→rune: `JARVIS_HTTP_SECRET: 'test-secret',`
- [x] `src/server/webview.test.ts:53` — rename `JARVIS`→rune: `JARVIS_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']),`
- [x] `src/server/webview.test.ts:254` — rename `JARVIS`→rune: `mockConfig.JARVIS_HTTP_SECRET = 'test-secret';`
- [x] `src/server/webview.test.ts:341` — rename `JARVIS`→rune: `mockConfig.JARVIS_HTTP_SECRET = '';`
- [x] `src/server/webview.test.ts:383` — rename `jarvis`→rune: `expect(cookieStr).toContain('jarvis-auth=test-secret');`
- [x] `src/server/webview.test.ts:534` (instance #1) — rename `jarvis`→rune: `it('overlays a live read of jarvis tasks.md onto jarvis project cards', async () => {`
- [x] `src/server/webview.test.ts:534` (instance #2) — rename `jarvis`→rune: `it('overlays a live read of jarvis tasks.md onto jarvis project cards', async () => {`
- [x] `src/server/webview.test.ts:535` — rename `jarvis`→rune: `// handleApiCockpit overlays getProjectSummaries() (a fresh, jarvis-local`
- [x] `src/server/webview.test.ts:536` (instance #1) — rename `jarvis`→rune: `// read) onto the registry's jarvis product so jarvis cards update in real`
- [x] `src/server/webview.test.ts:536` (instance #2) — rename `jarvis`→rune: `// read) onto the registry's jarvis product so jarvis cards update in real`
- [x] `src/server/webview.test.ts:537` — rename `jarvis`→rune: `// time. The overlay is scoped to the jarvis product to avoid a slug shared`
- [x] `src/server/webview.test.ts:542` — rename `jarvis`→rune: `products: [{ name: 'jarvis', repoBacked: true, projects: [{ slug: '01-mvp', status: 'activ…`
- [x] `src/server/webview.test.ts:557` (instance #1) — rename `jarvis`→rune: `it('surfaces a non-jarvis product\'s task progress from the registry, not the live jarvis …`
- [x] `src/server/webview.test.ts:557` (instance #2) — rename `jarvis`→rune: `it('surfaces a non-jarvis product\'s task progress from the registry, not the live jarvis …`
- [x] `src/server/webview.test.ts:559` — rename `jarvis`→rune: `// the live jarvis-local read must NOT bleed onto another product even when`
- [x] `src/server/webview.test.ts:560` — rename `jarvis`→rune: `// slugs collide. Here both jarvis and aura have a '01-mvp'; aura keeps its`
- [x] `src/server/webview.test.ts:567` — rename `jarvis`→rune: `{ name: 'jarvis', repoBacked: true, projects: [{ slug: '01-mvp', status: 'active' }] },`
- [x] `src/server/webview.test.ts:570` — rename `jarvis`→rune: `// Live jarvis read reports different counts for the same slug.`
- [x] `src/server/webview.test.ts:579` (instance #1) — rename `jarvis`→rune: `const jarvis = res.body.products.find((p: any) => p.name === 'jarvis');`
- [x] `src/server/webview.test.ts:579` (instance #2) — rename `jarvis`→rune: `const jarvis = res.body.products.find((p: any) => p.name === 'jarvis');`
- [x] `src/server/webview.test.ts:581` — rename `jarvis`→rune: `expect(jarvis.projects[0].taskProgress).toEqual({ done: 7, total: 12 }); // live overlay`
- [x] `src/server/webview.test.ts:695` — rename `jarvis`→rune: `body: JSON.stringify({ message: 'stay global', product: '../jarvis' }),`
- [x] `src/server/webview.test.ts:861` — rename `jarvis`→rune: `body: JSON.stringify({ kind: 'work-run', payload: { projectSlug: 'demo', product: 'jarvis'…`
- [x] `src/server/webview.test.ts:881` — rename `jarvis`→rune: `body: JSON.stringify({ kind: 'work-run', payload: { projectSlug: 'demo', product: 'jarvis'…`

### `src/server/webview.ts`

- [x] `src/server/webview.ts:549` — rename `Jarvis`→rune: `*  whether the repo had uncommitted work prior to Jarvis's append, not the always-true`

### `src/server/work-run-cockpit.test.ts`

- [x] `src/server/work-run-cockpit.test.ts:50` — rename `jarvis`→rune: `WORK_RUNS_DIR: '/tmp/jarvis-test-work-run-cockpit-${process.pid}',`
- [x] `src/server/work-run-cockpit.test.ts:92` — rename `JARVIS`→rune: `JARVIS_HTTP_SECRET: 'test-secret',`
- [x] `src/server/work-run-cockpit.test.ts:95` — rename `JARVIS`→rune: `JARVIS_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']),`
- [x] `src/server/work-run-cockpit.test.ts:235` — rename `jarvis`→rune: `const AUTH_COOKIE = 'jarvis-auth=test-secret';`
- [x] `src/server/work-run-cockpit.test.ts:255` — rename `jarvis`→rune: `branch: 'jarvis-work/02-growth',`

### `src/server/work-run-live-api.test.ts`

- [x] `src/server/work-run-live-api.test.ts:68` — rename `JARVIS`→rune: `JARVIS_HTTP_SECRET: 'test-secret',`
- [x] `src/server/work-run-live-api.test.ts:71` — rename `JARVIS`→rune: `JARVIS_ALLOWED_HOSTS: new Set(['localhost', '127.0.0.1']),`

### `src/test/setup-env.ts`

- [x] `src/test/setup-env.ts:3` — rename `jarvis`→rune: `process.env['VAULT_DIR'] ??= '/tmp/jarvis-test-vault';`

### `src/transport/mutations.test.ts`

- [x] `src/transport/mutations.test.ts:391` — rename `jarvis`→rune: `operatorWorktreePath: '/tmp/worktrees/jarvis/demo',`

### `src/transport/mutations.ts`

- [x] `src/transport/mutations.ts:34` — rename `jarvis`→rune: `* explicitly); otherwise defaults to 'jarvis' since today's only auto-approve`
- [x] `src/transport/mutations.ts:35` — rename `Jarvis`→rune: `* applier is the work-runner operating on the Jarvis repo itself. 'project'`
- [x] `src/transport/mutations.ts:59` — rename `jarvis`→rune: `const product = typeof p['product'] === 'string' ? p['product'] : 'jarvis';`
- [x] `src/transport/mutations.ts:131` — rename `jarvis`→rune: `product: typeof payload['product'] === 'string' ? payload['product'] : 'jarvis',`
- [x] `src/transport/mutations.ts:222` — rename `Jarvis`→rune: `// Project 14 Phase 5: the Jarvis-owned multi-task orchestration loop. The`
- [x] `src/transport/mutations.ts:293` — rename `Jarvis`→rune: `* surface, the cockpit Cancel button). 'system' is a Jarvis backstop reaping a`
- [x] `src/transport/mutations.ts:480` — rename `Jarvis`→rune: `*  human cancel from a Jarvis backstop reap — see {@link CancelReason}. */`

### `src/transport/op-labels.test.ts`

- [x] `src/transport/op-labels.test.ts:40` — rename `jarvis`→rune: `// Regression guard — every agent file shipped in jarvis's own`
- [x] `src/transport/op-labels.test.ts:45` — rename `Jarvis`→rune: `it('every Jarvis-resident agent has a curated entry in AGENT_LABELS', () => {`

### `src/transport/op-labels.ts`

- [x] `src/transport/op-labels.ts:7` — rename `Jarvis`→rune: `// Runtime agents (Jarvis-resident)`

### `src/transport/sender.test.ts`

- [x] `src/transport/sender.test.ts:173` (instance #1) — rename `jarvis`→rune: `commitSubject: 'jarvis(jarvis): closeout — Render the streak card',`
- [x] `src/transport/sender.test.ts:173` (instance #2) — rename `jarvis`→rune: `commitSubject: 'jarvis(jarvis): closeout — Render the streak card',`
- [x] `src/transport/sender.test.ts:222` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/transport/sender.test.ts:223` — rename `jarvis`→rune: `branch: 'jarvis-work/demo',`
- [x] `src/transport/sender.test.ts:233` — rename `jarvis`→rune: `expect(text.toLowerCase()).toContain('jarvis/demo');`

### `src/transport/telegram-sender.test.ts`

- [x] `src/transport/telegram-sender.test.ts:325` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/transport/telegram-sender.test.ts:327` — rename `jarvis`→rune: `branch: 'jarvis-work/demo',`
- [x] `src/transport/telegram-sender.test.ts:449` (instance #1) — rename `jarvis`→rune: `commitSubject: 'jarvis(jarvis): closeout — Render the streak card',`
- [x] `src/transport/telegram-sender.test.ts:449` (instance #2) — rename `jarvis`→rune: `commitSubject: 'jarvis(jarvis): closeout — Render the streak card',`
- [x] `src/transport/telegram-sender.test.ts:463` (instance #1) — rename `jarvis`→rune: `expect(text).toContain('jarvis(jarvis): closeout');`
- [x] `src/transport/telegram-sender.test.ts:463` (instance #2) — rename `jarvis`→rune: `expect(text).toContain('jarvis(jarvis): closeout');`
- [x] `src/transport/telegram-sender.test.ts:499` — rename `jarvis`→rune: `const worktree = '/tmp/worktrees/jarvis/06-webview';`
- [x] `src/transport/telegram-sender.test.ts:501` — rename `jarvis`→rune: `workRunStart({ operatorWorktreePath: worktree, runId: 'run-1234', projectSlug: '06-webview…`
- [x] `src/transport/telegram-sender.test.ts:541` — rename `jarvis`→rune: `operatorWorktreePath: '/tmp/worktrees/jarvis/demo',`
- [x] `src/transport/telegram-sender.test.ts:560` — rename `jarvis`→rune: `expect(text).toContain('/tmp/worktrees/jarvis/demo');`

### `src/transport/telegram-sender.ts`

- [x] `src/transport/telegram-sender.ts:69` — rename `JARVIS`→rune: `*  'JARVIS_ALLOWED_HOSTS' to a remote origin must revisit this field. Returns`

### `src/transport/telegram-ux.test.ts`

- [x] `src/transport/telegram-ux.test.ts:71` — rename `Jarvis`→rune: `'when handlePlanningTurn returns spec-proposed, Jarvis sends an inline-keyboard approval m…`

### `src/utils/intent-log.test.ts`

- [x] `src/utils/intent-log.test.ts:8` — rename `jarvis`→rune: `const tmpLogsDir = join(tmpdir(), 'jarvis-intent-log-test-${Date.now()}');`
- [x] `src/utils/intent-log.test.ts:115` — rename `Jarvis`→rune: `// batch. This matches Jarvis's single-process event-loop model: concurrent`

### `src/utils/intent-log.ts`

- [x] `src/utils/intent-log.ts:35` — rename `Jarvis`→rune: `*   1. Primary guarantee — Jarvis is a single Node.js process and 'appendFileSync'`

### `src/utils/logger.test.ts`

- [x] `src/utils/logger.test.ts:70` — rename `jarvis`→rune: `it('file sink is disabled under vitest (so test runs do not append to real jarvis.log)', (…`

### `src/utils/logger.ts`

- [x] `src/utils/logger.ts:9` — rename `jarvis`→rune: `const LOG_FILE_NAME = 'jarvis.log';`

### `src/utils/observation-log.test.ts`

- [x] `src/utils/observation-log.test.ts:17` — rename `jarvis`→rune: `const tmpLogsDir = join(tmpdir(), 'jarvis-observation-log-test-${Date.now()}');`

### `src/utils/observation-log.ts`

- [x] `src/utils/observation-log.ts:13` — rename `Jarvis`→rune: `* 1. Jarvis is a single Node.js process — 'appendFileSync' is synchronous,`

### `src/utils/sanitize-paths.ts`

- [x] `src/utils/sanitize-paths.ts:2` — rename `Jarvis`→rune: `* Strip Jarvis's absolute host paths from a string before it is surfaced to a user (a chat…`

### `src/utils/task-progress.ts`

- [x] `src/utils/task-progress.ts:3` — rename `jarvis`→rune: `* text so both callers — the cockpit's live jarvis-local read`

### `src/vault/equipment.test.ts`

- [x] `src/vault/equipment.test.ts:6` — rename `jarvis`→rune: `const tmpDir = join(tmpdir(), 'jarvis-equipment-test-${Date.now()}');`

### `src/vault/files.test.ts`

- [x] `src/vault/files.test.ts:6` — rename `jarvis`→rune: `const tmpDir = join(tmpdir(), 'jarvis-vault-test-${Date.now()}');`

### `src/vault/journal.test.ts`

- [x] `src/vault/journal.test.ts:6` — rename `jarvis`→rune: `const tmpDir = join(tmpdir(), 'jarvis-journal-test-${Date.now()}');`

### `src/vault/learnings.test.ts`

- [x] `src/vault/learnings.test.ts:7` — rename `jarvis`→rune: `const tmpDir = join(tmpdir(), 'jarvis-learnings-test-${Date.now()}');`

### `src/vault/sessions.test.ts`

- [x] `src/vault/sessions.test.ts:7` — rename `jarvis`→rune: `const tmpDir = join(tmpdir(), 'jarvis-sessions-test-${Date.now()}');`
- [x] `src/vault/sessions.test.ts:141` — rename `jarvis`→rune: `expect(parseSessionKey!('jarvis:webview:42')).toEqual({`
- [x] `src/vault/sessions.test.ts:144` — rename `jarvis`→rune: `scope: { kind: 'product', product: 'jarvis' },`
- [x] `src/vault/sessions.test.ts:181` (instance #1) — rename `jarvis`→rune: `const jarvisScope: SessionScope = { kind: 'product', product: 'jarvis' };`
- [x] `src/vault/sessions.test.ts:181` (instance #2) — rename `jarvis`→rune: `const jarvisScope: SessionScope = { kind: 'product', product: 'jarvis' };`
- [x] `src/vault/sessions.test.ts:186` (instance #1) — rename `jarvis`→rune: `const jarvisWeb = createSession(42, 'webview', 'jarvis webview', undefined, jarvisScope);`
- [x] `src/vault/sessions.test.ts:186` (instance #2) — rename `jarvis`→rune: `const jarvisWeb = createSession(42, 'webview', 'jarvis webview', undefined, jarvisScope);`
- [x] `src/vault/sessions.test.ts:186` (instance #3) — rename `jarvis`→rune: `const jarvisWeb = createSession(42, 'webview', 'jarvis webview', undefined, jarvisScope);`
- [x] `src/vault/sessions.test.ts:190` — rename `jarvis`→rune: `expect(jarvisWeb.sessionId).not.toBe(globalWeb.sessionId);`
- [x] `src/vault/sessions.test.ts:191` — rename `jarvis`→rune: `expect(pkmsWeb.sessionId).not.toBe(jarvisWeb.sessionId);`
- [x] `src/vault/sessions.test.ts:192` — rename `jarvis`→rune: `expect(telegram.sessionId).not.toBe(jarvisWeb.sessionId);`
- [x] `src/vault/sessions.test.ts:194` (instance #1) — rename `jarvis`→rune: `expect(getSession(42, 'webview', jarvisScope)!.firstMessage).toBe('jarvis webview');`
- [x] `src/vault/sessions.test.ts:194` (instance #2) — rename `jarvis`→rune: `expect(getSession(42, 'webview', jarvisScope)!.firstMessage).toBe('jarvis webview');`
- [x] `src/vault/sessions.test.ts:200` (instance #1) — rename `jarvis`→rune: `createSession(7, 'webview', 'jarvis scoped', undefined, jarvisScope);`
- [x] `src/vault/sessions.test.ts:200` (instance #2) — rename `jarvis`→rune: `createSession(7, 'webview', 'jarvis scoped', undefined, jarvisScope);`
- [x] `src/vault/sessions.test.ts:209` — rename `jarvis`→rune: `'product:jarvis:webview:7',`
- [x] `src/vault/sessions.test.ts:215` — rename `jarvis`→rune: `['jarvis:webview:12', {`
- [x] `src/vault/sessions.test.ts:238` — rename `jarvis`→rune: `expect(getSession(12, 'webview', jarvisScope)!.sessionId).toBe('product-session');`
- [x] `src/vault/sessions.test.ts:243` — rename `jarvis`→rune: `'jarvis:webview:12',`
- [x] `src/vault/sessions.test.ts:250` — rename `jarvis`→rune: `const session = createSession(88, 'webview', 'repo scoped first turn', 'haiku', jarvisScop…`
- [x] `src/vault/sessions.test.ts:251` — rename `jarvis`→rune: `appendMessageToSession(88, 'webview', 'user', 'look in this product repo', jarvisScope);`
- [x] `src/vault/sessions.test.ts:252` — rename `jarvis`→rune: `updateSession(88, 'webview', jarvisScope);`
- [x] `src/vault/sessions.test.ts:258` — rename `jarvis`→rune: `&& e.scope.product === 'jarvis',`
- [x] `src/vault/sessions.test.ts:264` — rename `jarvis`→rune: `deleteSession(88, 'webview', jarvisScope);`
- [x] `src/vault/sessions.test.ts:265` — rename `jarvis`→rune: `expect(getSession(88, 'webview', jarvisScope)).toBeNull();`
- [x] `src/vault/sessions.test.ts:270` — rename `jarvis`→rune: `const restored = getSession(88, 'webview', jarvisScope);`
- [x] `src/vault/sessions.test.ts:274` — rename `jarvis`→rune: `expect(getSessionMessages(88, 'webview', jarvisScope).map(m => m.text)).toEqual([`
- [x] `src/vault/sessions.test.ts:281` — rename `jarvis`→rune: `scope: { kind: 'product', product: 'jarvis' },`
- [x] `src/vault/sessions.test.ts:289` (instance #1) — rename `jarvis`→rune: `createSession(42, 'webview', 'jarvis webview', 'haiku', jarvisScope);`
- [x] `src/vault/sessions.test.ts:289` (instance #2) — rename `jarvis`→rune: `createSession(42, 'webview', 'jarvis webview', 'haiku', jarvisScope);`
- [x] `src/vault/sessions.test.ts:291` (instance #1) — rename `jarvis`→rune: `appendMessageToSession(42, 'webview', 'user', 'jarvis-only', jarvisScope);`
- [x] `src/vault/sessions.test.ts:291` (instance #2) — rename `jarvis`→rune: `appendMessageToSession(42, 'webview', 'user', 'jarvis-only', jarvisScope);`
- [x] `src/vault/sessions.test.ts:292` — rename `jarvis`→rune: `updateSession(42, 'webview', jarvisScope);`
- [x] `src/vault/sessions.test.ts:293` — rename `jarvis`→rune: `setSessionModel(42, 'webview', 'opus', jarvisScope);`
- [x] `src/vault/sessions.test.ts:298` — rename `jarvis`→rune: `expect(getSession(42, 'webview', jarvisScope)!.messageCount).toBe(2);`
- [x] `src/vault/sessions.test.ts:299` — rename `jarvis`→rune: `expect(getSession(42, 'webview', jarvisScope)!.model).toBe('opus');`
- [x] `src/vault/sessions.test.ts:300` — rename `jarvis`→rune: `expect(getSessionMessages(42, 'webview', jarvisScope).map(m => m.text)).toEqual([`
- [x] `src/vault/sessions.test.ts:301` — rename `jarvis`→rune: `'jarvis-only',`
- [x] `src/vault/sessions.test.ts:304` — rename `jarvis`→rune: `deleteSession(42, 'webview', jarvisScope);`
- [x] `src/vault/sessions.test.ts:306` — rename `jarvis`→rune: `expect(getSession(42, 'webview', jarvisScope)).toBeNull();`
- [x] `src/vault/sessions.test.ts:312` (instance #1) — rename `jarvis`→rune: `const jarvisScope: SessionScope = { kind: 'product', product: 'jarvis' };`
- [x] `src/vault/sessions.test.ts:312` (instance #2) — rename `jarvis`→rune: `const jarvisScope: SessionScope = { kind: 'product', product: 'jarvis' };`
- [x] `src/vault/sessions.test.ts:313` — rename `jarvis`→rune: `const jarvisContext: ProductPromptFixture = {`
- [x] `src/vault/sessions.test.ts:314` — rename `jarvis`→rune: `product: 'jarvis',`
- [x] `src/vault/sessions.test.ts:315` — rename `jarvis`→rune: `repoPath: '/workspace/jarvis',`
- [x] `src/vault/sessions.test.ts:319` — rename `Jarvis`→rune: `content: 'Jarvis architecture: one Node process owns Telegram polling and the localhost co…`
- [x] `src/vault/sessions.test.ts:344` — rename `jarvis`→rune: `scope: jarvisScope,`
- [x] `src/vault/sessions.test.ts:345` — rename `jarvis`→rune: `productContext: jarvisContext,`
- [x] `src/vault/sessions.test.ts:349` — rename `jarvis`→rune: `expect(prompt).toMatch(/active product:\s*jarvis/i);`
- [x] `src/vault/sessions.test.ts:361` — rename `jarvis`→rune: `scope: jarvisScope,`
- [x] `src/vault/sessions.test.ts:362` — rename `jarvis`→rune: `productContext: jarvisContext,`
- [x] `src/vault/sessions.test.ts:373` — rename `jarvis`→rune: `productContext: jarvisContext,`
- [x] `src/vault/sessions.test.ts:386` — rename `jarvis`→rune: `...jarvisContext,`
- [x] `src/vault/sessions.test.ts:393` — rename `jarvis`→rune: `scope: jarvisScope,`
- [x] `src/vault/sessions.test.ts:396` — rename `jarvis`→rune: `})).toThrow(/jarvis|aura|product context|scope/i);`

### `src/vault/sessions.ts`

- [x] `src/vault/sessions.ts:267` — rename `jarvis`→rune: `/** Journal-entry source label used wherever a "[[jarvis]] <label>" line is`

### `src/vault/voice.test.ts`

- [x] `src/vault/voice.test.ts:7` — rename `jarvis`→rune: `const tmpDir = join(tmpdir(), 'jarvis-voice-test-${Date.now()}');`

### `src/vault/watcher.test.ts`

- [x] `src/vault/watcher.test.ts:5` — rename `jarvis`→rune: `const tmpDir = join(tmpdir(), 'jarvis-watcher-test-${Date.now()}');`

### `src/vault/whoop-recent.test.ts`

- [x] `src/vault/whoop-recent.test.ts:6` — rename `jarvis`→rune: `const tmpDir = join(tmpdir(), 'jarvis-whoop-recent-test-${Date.now()}');`

### `src/workspace/files.test.ts`

- [x] `src/workspace/files.test.ts:7` — rename `jarvis`→rune: `const workspaceRoot = join(tmpdir(), 'jarvis-workspace-test-${Date.now()}');`
- [x] `src/workspace/files.test.ts:8` — rename `jarvis`→rune: `const projectRoot = join(tmpdir(), 'jarvis-project-root-test-${Date.now()}');`

### `src/writer/capture.ts`

- [x] `src/writer/capture.ts:162` — rename `Jarvis`→rune: `// risk duplicate lessons or '.git/index.lock' contention). Only one Jarvis runs at`

### `src/writer/commit.ts`

- [x] `src/writer/commit.ts:5` — rename `jarvis`→rune: `* stages ONLY 'agents/writer/memory.md' in the jarvis repo and makes a single`
- [x] `src/writer/commit.ts:38` — rename `jarvis`→rune: `/** Repo root containing 'agents/writer/memory.md'. Defaults to the jarvis repo`

### `src/writer/memory.ts`

- [x] `src/writer/memory.ts:13` — rename `jarvis`→rune: `* — they live in the jarvis repo, not the Obsidian vault.`
- [x] `src/writer/memory.ts:27` — rename `jarvis`→rune: `/** Directory holding the writer role's charter + memory, in the jarvis repo. */`

### `src/writer/soul.test.ts`

- [x] `src/writer/soul.test.ts:5` — rename `jarvis`→rune: `* Reads the real charter from the jarvis repo. No vault coupling: rather than`

## Phase 5 — Operational Cutover, Handle Ownership & Acceptance

> The final phase. These are the existing unchecked operational tasks the
> orchestrated run could not perform (and were wrongly auto-closed). They run
> LAST, after the full code/doc rename in Phase 4 lands. Three require a human
> operator (GitHub repo rename, `@runeai` handle, on-disk move + daemon cutover);
> the acceptance task verifies the whole rebrand end-to-end.

### Repo Rename (was Phase 4)
> Independent of the disk move.

#### Tests (write first)

- [x] No code-test-required tasks — `github-repo-remote-rename` is `docs-or-config-only`; record
      and review the no-code-test rationale (test-plan.md §5).

#### Implementation

- [x] **github-repo-remote-rename** — Rename the public GitHub repository to `rune`, 
- [ ] update the local git remote URL, and verify remote operations from the renamed checkout with
      `git fetch` plus either an authenticated dry-run push or a real temporary-branch push.
      Update any local repo metadata that depends on the remote name.

### Handle Ownership (was Phase 5)
> Independent of the disk move.

#### Tests (write first)

- [x] No code-test-required tasks — `secure-runeai-handle` is `docs-or-config-only`; record and
      review the no-code-test rationale (test-plan.md §5).

#### Implementation

- [x] **secure-runeai-handle** — Claim and secure the public `@runeai` handle on the intended
      public platform under a controlled login, then record ownership details privately. If the
      handle is no longer available, escalate immediately and pause approval because the
      brand-ownability premise has failed; do not silently proceed with a substitute handle.

### On-Disk Cutover (was Phase 6)
> Depends on: Phase 1 landed and still verified.

#### Tests (write first)

- [x] No code-test-required tasks — `disk-move-and-daemon-cutover` is `docs-or-config-only`;
      verification is a daemon liveness check and grep gates (test-plan.md §6).

#### Implementation (Human Only)

- [ ] **disk-move-and-daemon-cutover** — Before touching disk, confirm the worktree is clean
      enough for cutover and no long-running daemon work would be interrupted. Stop or unload
      the daemon as needed, rename `~/workspace/jarvis/` to `~/workspace/rune/`, update the
      deployed `RUNE_*` env-var values to the new path, update the single path line in
      `com.jarvis.daemon.plist` (leave the label as `com.jarvis.daemon`), then reload/start the
      daemon. Rollback is the inverse path and env edit.

- [ ] **daemon-plist-workingdir-edit** — Repoint the launchd daemon at the renamed directory.
      This is the load-bearing half of the cutover: the plist lives at
      `~/Library/LaunchAgents/com.jarvis.daemon.plist`, is NOT tracked in the repo, and hardcodes
      the old path, so merging the branch does not fix it. Verified current state: service is
      loaded as `com.jarvis.daemon` (was PID 36939) with
      `<key>WorkingDirectory</key>` → `<string>/Users/jarvis/workspace/jarvis</string>`. Steps:
  1. **Pre-flight.** Confirm the directory rename to `~/workspace/rune` is done, and that no
     orchestrated/work-run is in flight (the bounce kills the running process). Check current
     state: `launchctl list | grep com.jarvis.daemon` (expect one entry; note its PID).
  2. **Edit one line.** In `~/Library/LaunchAgents/com.jarvis.daemon.plist`, change the
     `WorkingDirectory` value from `/Users/jarvis/workspace/jarvis` to
     `/Users/jarvis/workspace/rune`. Leave everything else untouched: `Label` stays
     `com.jarvis.daemon`, `ProgramArguments` (`npm run start`), the `PATH` env var, and the
     `StandardOutPath`/`StandardErrorPath` log paths under `~/Library/Logs/jarvis/` (those are
     outside the workspace and must not change).
  3. **Reload so launchd re-reads the plist.** `kickstart -k` alone reuses the already-loaded
     config and will NOT pick up the path change. Run:
     `launchctl bootout gui/$(id -u)/com.jarvis.daemon` then
     `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jarvis.daemon.plist`
     (equivalently `launchctl unload`/`load` of the plist).
  4. **Verify boot.** `launchctl list | grep com.jarvis.daemon` shows a NEW pid and last-exit
     status `0` (not `78`/`-`); the HTTP server answers on `localhost:3847`; and
     `tail ~/Library/Logs/jarvis/stderr.log` shows a clean start with no chdir/path error.
  5. **Rollback.** If the daemon fails to boot, revert the `WorkingDirectory` line to
     `/Users/jarvis/workspace/jarvis` (rename the directory back if needed) and re-run step 3.

### Acceptance (was Phase 7)
> Depends on: all prior phases.

#### Tests (write first)

- [x] Write the acceptance verification suite — test-plan.md §7. Tests-as-deliverable: the
      verification itself is the deliverable, run with no stubs on load-bearing components.

#### Implementation

- [ ] **cutover-acceptance-verification** — Run the full Definition of Done against the
      renamed, env-driven, moved checkout: GitHub repo and remote are `rune`; fetch and
      authenticated push work from `~/workspace/rune/`; `@runeai` is secured; case-insensitive
      grep for `jarvis` returns only Phase 0 allowlisted survivors; greps for `/Users/jarvis`,
      `workspace/jarvis`, and `JARVIS_` return zero committed-code hits; the launchd daemon is
      loaded and healthy from the renamed checkout; and a real routine agent operation succeeds
      while reading/writing through the env-driven log path.
