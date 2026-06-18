# Spec Assumptions

## Brief

Add a cockpit action that lets the operator retry a failed project promotion.

## Good PM output

## Problem

Failed promotion retries require manual file edits, so a recoverable planning handoff can get
stuck even after the operator fixes the source issue.

## Done Definition

- The cockpit exposes retry only for retryable failed promotions.
- A successful retry returns the current promotion state and errors, if any.
- Non-retryable states return a clear conflict rather than silently doing nothing.

## Assumptions

- The existing promotion state machine remains the source of truth.
- Retry is operator-only through the authenticated cockpit surface.
- The task does not add a new Telegram command.
