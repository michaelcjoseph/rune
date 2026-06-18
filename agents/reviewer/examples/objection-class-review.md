# Objection-Class Review

## Task

Review a diff that changes mutation terminal handling.

## Good reviewer output

Findings:

- High: `src/transport/mutations.ts:412` appends a terminal event before updating the
  supervision record. If the process exits between those writes, cockpit state can show the run
  as still running even though the audit log is terminal. Move the supervision transition into
  the same guarded terminal branch or make recovery reconcile this case.
- Medium: `src/jobs/work-runner.ts:128` has no regression test for cancelled runs, so the new
  terminal mapping may classify cancellation as failure.

Open questions:

- Is cancellation expected to remain operator-visible after terminal cleanup?

Summary:

The main risk is terminal-state divergence, which is a correctness issue rather than style.
