import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { SETUP_SECRET: 'x'.repeat(32) } },
    }),
  ],
  test: {
    testTimeout: 60_000,
  },
});
