## Self-review test exemplar (project-specific)

Self-review's whole value is a *measurable* revision, so the test must prove the artifact changed — not merely that the step ran. Fake only the LLM transport; never stub `runSelfReview` itself.

```ts
// The authoring fixture creates the flawed artifact outside this primitive.
// The fake review model returns the corrected artifact on the one cold self-review call.
const calls: string[] = [];
const fakeReviewModel: RoleModelCall = async ({ role, message }) => {
  calls.push(role);
  expect(message).toContain(flawedSpec.spec);
  return FIXED_SPEC_REPLY;
};

const { artifact, revised } = await runSelfReview({ role: 'pm', artifact: flawedSpec, render, parse, modelCall: fakeReviewModel });

expect(revised).toBe(true);                       // a real delta, not a flag
expect(artifact.spec).not.toEqual(flawedSpec.spec);
expect(artifact.spec).toContain(EXPECTED_FIX);
expect(calls).toEqual(['pm']);                     // exactly one cold pass
```

Also assert the clean-artifact path: a model reply with no changes yields `{ revised: false }` and the **input artifact unchanged** (fail-closed, never a flag-only report). And assert one-pass: the review seam is invoked exactly once — no loop.
