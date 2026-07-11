const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  cacheDir: process.env.RUNE_VITEST_CACHE_DIR ?? 'node_modules/.vite',
  test: {
    include: ['src/**/*.test.ts', 'cli/**/*.test.ts', 'scripts/**/*.test.ts'],
    setupFiles: ['src/test/setup-env.ts'],
    testTimeout: 10000,
    // 'default' keeps normal output; 'hanging-process' stays silent on clean
    // exits and dumps the open-handle stack (why-is-node-running) the moment a
    // run fails to exit — turning the intermittent vitest hang into a
    // diagnosable event. A CLI `--reporter=...` overrides this for one-off runs.
    reporters: ['default', 'hanging-process'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/index.ts',
        'src/mcp/index.ts',
        'src/cli/**',
      ],
      reporter: ['text', 'html'],
    },
  },
});
