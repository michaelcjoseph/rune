## Spec fragment

DoD #2/#3: a case-insensitive grep for 'jarvis' returns only the two excluded infra strings; `/Users/jarvis` and the hardcoded working-dir name return zero hits in committed code.

## Good QA verification intent

Assert on the grep result SET, not on individual file edits — the sweep's correctness is defined by what survives, not by which lines changed.

- `git grep -in jarvis -- ':!*.png' ':!*.lock'` must return exactly the two allowlisted survivors: the macOS username path segment (now reached via `RUNE_*` defaults) and the `com.jarvis.daemon` launchd label. Any third hit fails the check. Pin the allowlist as an explicit expected set so a NEW stray hit can't hide among the two.
- `git grep -n '/Users/jarvis' -- <committed paths>` must return zero. Assert empty, not 'small'.
- Env contract: with `RUNE_LOGS_DIR` UNSET the logger resolves its default path; with it SET to a temp dir the logger writes there. Both directions, because a default that silently wins over the override is the failure that ships.
- Daemon liveness is asserted by querying launchd that the service is loaded and not erroring from `~/workspace/rune/` — NOT by parsing the plist (a parseable plist that points nowhere still passes a parse check and fails reality).