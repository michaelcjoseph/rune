# Rune Eval Framework

MVP behavioral-regression harness for the agents in `.claude/agents/` (and the
vault-resident agents loaded via `loadAgentDef`). One YAML file per agent —
each fixture invokes the agent via `runAgent()`, then runs assertions against
the captured output.

Designed to be boring: local YAML, manual runs, no CI gate yet. The goal is to
make it cheap to notice when a prompt edit silently broke behavior.

## Running

```bash
npm run evals                           # all agents
npm run evals -- wiki-compiler          # one agent
npm run evals -- --dry-run              # validate YAML, count calls, no API
```

A failed assertion exits non-zero with a per-fixture breakdown. Malformed YAML
is skipped with an error; other files continue. Agent timeouts are reported as
failed fixtures, not crashes.

## File layout

```
evals/
├── README.md              # this file
├── wiki-compiler.yaml     # one file per agent
├── kb-query.yaml
├── content-triager.yaml
└── resolver.yaml          # (Phase B)
```

File name must match the agent name (e.g. `wiki-compiler.yaml` ↔ agent
`wiki-compiler`). The runner uses the filename stem as the `runAgent()`
argument.

### Special case: `resolver.yaml`

The resolver is a module (`src/bot/resolver.ts`), not a markdown agent, so
`runAgent()` cannot invoke it. The runner special-cases the filename stem
`resolver`: when it sees it, the fixture's `input` is passed to the real
`classifyIntent(input, getSkillRegistry())` pipeline, and the routing-ready
`ClassifyResult` fields are serialized as JSON. Assertions then run against
that JSON string. The serialized shape is:

```json
{"skill":"...","args":"...","confidence":0.0,"second_skill":"...","second_confidence":0.0,"ambiguous":false}
```

The `raw` classifier text is dropped so eval output is stable. No other
filenames get this treatment.

Caveats specific to the resolver special-case:
- **`timeout_ms` has no effect.** The classifier timeout is always
  `CLASSIFIER_TIMEOUT_MS` from `src/config.ts`. Per-fixture overrides in
  the YAML are silently ignored on this path.
- **Do not create `.claude/agents/resolver.md`.** The runner's
  filename-stem check would silently shadow the real agent; the agent
  would still work in production via `loadAgentDef`, but
  `npm run evals -- resolver` would keep exercising the module path
  instead of the agent.

## YAML schema

```yaml
agent: wiki-compiler        # required — must match filename stem
fixtures:
  - name: "Readwise highlight ingestion"   # required — human label
    input: |                               # required — prompt sent to runAgent
      Ingest this Readwise highlight into the KB: ...
    timeout_ms: 120000                     # optional — per-fixture override
    assertions:
      - type: substring
        value: "knowledge/wiki/"
      - type: citation_present
        target: "source-name"              # bare slug, no [[ ]]
      - type: max_length_chars
        value: 4000
```

### Required fields

| Field | Meaning |
|---|---|
| `agent` | The agent name (must match filename stem). |
| `fixtures[].name` | Short label — shown in pass/fail output. |
| `fixtures[].input` | The prompt passed to `runAgent(agent, input)`. |
| `fixtures[].assertions` | At least one assertion — a fixture with zero assertions is a validation error. |

### Optional fields

| Field | Meaning |
|---|---|
| `fixtures[].timeout_ms` | Per-fixture timeout. Default: the global `CLAUDE_TIMEOUT_MS` from config. |

## Assertion types

Each assertion is an object with a `type` and type-specific keys. All assertions
in a fixture must pass for the fixture to pass.

### `substring`

Output must contain the given string (case-sensitive).

```yaml
- type: substring
  value: "knowledge/wiki/"
```

### `citation_present`

Output must contain a wikilink pointing at `target`. Matches `[[target]]` and
`[[target|alias]]` forms. Use this to verify that the agent cited the expected
source page rather than inventing information.

```yaml
- type: citation_present
  target: "source-name"        # bare slug, no [[ ]]
```

### `max_length_chars`

Output character length must be `<= value`. Useful as a cheap check against
runaway prompt bleed.

```yaml
- type: max_length_chars
  value: 4000
```

### `json_shape`

Output must be parseable as JSON and must contain every key listed in
`required_keys` (top-level). Types of values are not checked — presence only.
Keep shape assertions shallow; deeply nested expectations brittle out fast.

```yaml
- type: json_shape
  required_keys: ["route", "confidence", "args"]
```

### `regex`

Output must match the given regular expression (JavaScript flavor). Use `flags`
for case-insensitive / multiline matching.

```yaml
- type: regex
  pattern: "^Topic: .+$"
  flags: "m"
```

## Authoring conventions

- **Fixtures are self-contained and synthetic.** Inputs should not rely on
  vault state unless the agent's job is to read vault state — in that case,
  pick a stable anchor (e.g., a wiki page that isn't going to move) and
  document the dependency inline. `input:` values are committed to the public
  repo: never paste personal vault content, real CRM names, or real journal
  prose. Use synthetic stand-ins.
- **Avoid pathological `regex` patterns.** The runner has no regex timeout —
  a backtracking-heavy pattern against a long output will hang the process
  and require `Ctrl-C`. Prefer anchored patterns and bounded quantifiers.
- **Assertions are the minimum behavioral guarantee, not a full spec.** Aim for
  the one or two checks that would catch a real regression, not a full snapshot
  of expected output.
- **Citation assertions beat substring assertions for knowledge agents.** The
  common failure mode is "agent answered without citing anything" — catch it
  directly.
- **Cost-sensitive changes go in `--dry-run` first.** A full run is ~$0.50 at
  MVP volume (2–3 agents, 1–2 fixtures each); cheap, but not free.

## Not in MVP

- CI gate / automatic run on PRs.
- Snapshot-style diff assertions.
- Structured output-schema validation beyond top-level key presence.
- Fixture sharing between agents.

These can be layered on later without breaking the file format.
