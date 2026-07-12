// NODE_OPTIONS loads this before a validation command starts. The root npm/npx
// process passes report support to its direct test/build runner; that runner
// restores the operator's original NODE_OPTIONS before it creates workers.
// This keeps timeout reports useful without poisoning Next/Vitest workers.
const reportOptions = process.env.RUNE_VALIDATION_REPORT_NODE_OPTIONS;
const originalOptions = process.env.RUNE_VALIDATION_ORIGINAL_NODE_OPTIONS || '';
const depth = Number(process.env.RUNE_VALIDATION_REPORT_DEPTH || '0');

if (depth >= 1 || !reportOptions) {
  if (originalOptions) process.env.NODE_OPTIONS = originalOptions;
  else delete process.env.NODE_OPTIONS;
  delete process.env.RUNE_VALIDATION_REPORT_NODE_OPTIONS;
  delete process.env.RUNE_VALIDATION_ORIGINAL_NODE_OPTIONS;
  delete process.env.RUNE_VALIDATION_REPORT_DEPTH;
} else {
  process.env.NODE_OPTIONS = reportOptions;
  process.env.RUNE_VALIDATION_REPORT_DEPTH = '1';
}
