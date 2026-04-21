import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'cli/**/*.test.ts'],
    testTimeout: 10000,
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
