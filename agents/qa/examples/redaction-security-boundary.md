# Redaction Security Boundary Test

## Task

Pin that a formatter never leaks raw secret-like credentials while still showing a useful
redacted placeholder.

## Good QA test shape

```ts
it('redacts raw tokens but preserves a placeholder shape', () => {
  const rawToken = 'sk-testRawToken0123456789';
  const result = formatDiagnostic({
    message: `provider failed with token ${rawToken}`,
  });

  const redactedPlaceholder = '[REDACTED_TOKEN]';

  expect(result).not.toContain(rawToken);
  expect(result).toContain(redactedPlaceholder);
});
```

## Why this is good

- The input uses a realistic raw secret-shaped token, not an already-redacted fixture.
- The negative assertion checks the exact raw token is absent.
- The positive assertion checks a redacted placeholder is present, so the output remains useful.
