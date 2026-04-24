# Projects

| Project | Status | Description |
|---|---|---|
| [01-mvp](01-mvp/spec.md) | Done | Core server: Telegram bot, knowledge base engine, scheduled jobs, Mac Mini deployment |
| [02-journal-kb](02-journal-kb/spec.md) | Done | Daily journals auto-ingested into KB; reviews use KB-activity digests; meeting notes auto-structure (attendees → CRM, decisions → Decisions Log); wiki lint extended for decay |
| [03-resolver](03-resolver/spec.md) | Done | Resolver routes free-form Telegram messages to skills; Ask-Twice telemetry proposes new skills/crons; skill-frontmatter–driven cron; MVP eval framework; `/learn`; deterministic entity auto-linking; compilation checkpoints + source hierarchy. Hybrid KB search deferred to [ideas.md](ideas.md). |
| [04-custom-workouts](04-custom-workouts/spec.md) | Spec | `/workout [home\|gym] [focus]` generates a tailored daily workout from goals, recent activity, Whoop recovery, available equipment, and an exercise-preference list (Preferred / Trying / Benched / Retired). `/done-workout` logs the session via the existing `#workout` journal-tag pipeline. |
