# Quality / Engagement Eval — Deferral ADR

**Status:** Deferred. v1 gates on loop closure, not output quality; build a
quality/engagement eval when the trigger fires.
**Decided:** 2026-06-08, at Project 14 Phase 7 closeout.
**Owner:** Project 14, orchestrated-work track.

## Context

The spec's **Deferrals** and **Non-Goals** both name this cut:

> **Quality / engagement eval.** Deferred — v1 gates on loop closure, not output
> quality. *Trigger to promote:* loop closure is stable and usage data exists to
> judge whether the team's output is actually better (the Project 12 path).

> **A quality eval.** v1 proves loop closure and learning-loop plumbing. Quality is
> judged later through usage/engagement, as in Project 12.

The spec is explicit that v1 proves the loop closes *mechanically*, not that quality
is already better:

> v1 proves the loop closes mechanically, not that quality is already better. A
> deterministic fixture project goes from `plan` to multi-task orchestrated `work`,
> exercises at least one review round that changes the diff, updates `context.md`
> between tasks, and hands the final branch/run facts to the finalizer without a
> human merge button. Live real-task smoke checks are useful evidence, but they are
> not required for project completion.

What v1 ships toward quality is *plumbing*, not measurement: the role gates
(QA-first, reviewer independence, objection-class hard gates), the bounded
`context.md`, and the feedback→role-memory **learning loop** that lets the team
compound from real usage. None of these is accompanied by a metric that scores
whether the team's output is actually good.

## Decision

**Defer the quality / engagement eval.** Do not build a scoring harness, a quality
rubric, or an engagement metric for orchestrated-team output in v1. Acceptance is
loop closure + learning-loop plumbing, verified by deterministic fixtures and unit
suites, per the spec.

## Rationale

1. **Quality is unmeasurable before the loop closes on real work.** The production
   role-spawn binding is deferred, so orchestrated runs do not yet drive live role
   models. With no real output, there is nothing to score. A quality eval built now
   would have no signal to consume.

2. **This mirrors the Project 12 sequencing, deliberately.** Project 12 (writer
   memory) shipped the compounding learning loop first and explicitly deferred the
   quality/engagement judgment to later usage data. Project 14 folds in the same
   philosophy by design (spec §"Provenance" ties the two). Re-deriving an eval here
   would duplicate a decision already made one layer up.

3. **A premature rubric biases the team toward the rubric, not the work.** Scoring
   output before we understand what "good" looks like for an autonomous product team
   risks optimizing the team against a proxy metric. Usage/engagement signal — does
   the operator keep using orchestrated runs, do the produced branches land and stay
   landed — is the honest later measure.

4. **The learning loop is the eval's eventual input, and it is shipped.** When a
   quality eval is built, its raw material is exactly the feedback records the
   nightly learning loop already consumes (`logs/feedback.jsonl`) plus the work-run
   outcome/forensics already captured by Project 11. The measurement layer sits on
   top of plumbing that exists; building it now would precede its own data source.

## Trigger to promote (build a quality / engagement eval)

Both of:

- **Loop closure is stable on real tasks.** The live role-spawn binding has landed
  and the orchestrated path closes real projects to a clean finalizer handoff
  consistently (see `legacy-work-removal-deferral.md`'s real-closure trigger).
- **Usage data exists to judge output quality.** Enough real orchestrated runs and
  feedback records have accumulated to compare orchestrated-team output against the
  legacy `/work --auto` baseline — the Project 12 usage/engagement path.

## Out of scope (here)

- The eval's metric design (rubric, engagement signal, A/B against legacy) — deferred
  to when real output exists to measure.
- Wiring quality scores back into model/role selection — a downstream concern that
  depends on having a trusted score first.

## Related

- Spec: `docs/projects/14-product-team-agents/spec.md` §"What's shipping",
  §"Non-Goals", §"Deferrals", §"Provenance".
- Precedent: `docs/projects/12-writer-memory/` (learning loop shipped, quality
  deferred to usage).
- Data sources the eventual eval reuses: `logs/feedback.jsonl` (learning loop),
  Project 11 work-run outcomes/forensics.
- Sibling deferrals: `autonomous-dispatch-deferral.md`,
  `legacy-work-removal-deferral.md`.
