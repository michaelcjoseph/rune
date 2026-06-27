Assert COVERAGE and SUPERSET, not exact result equality. The floor is ripgrep-over-everything, so pin presence and shape, not literal result lists (which churn as the fixture grows).

Good acceptance intent for `fullvault-coverage-acceptance`:
- Build a fixture vault with a known unique token in a knowledge/ file (e.g. `ZZ_KNOWLEDGE_MARKER`) and another in a peripheral folder (e.g. `ZZ_WORLDVIEW_MARKER` under world-view/).
- Call the real vault_search handler with production deps and a default query (no `types`).
- Assert the result contains a hit whose `file` starts with `knowledge/` AND a hit whose `file` starts with `world-view/`. Do NOT assert the full result array equals a fixed list.

Good intent for `ripgrep-parity-harness`:
- For each representative query, collect ripgrep `{file,line}` pairs and index `{file,line}` pairs; assert `ripgrepSet ⊆ indexSet`. Report any ripgrep pair missing from the index as a coverage regression with the offending file/line — never assert set equality (the index may legitimately return a superset).