import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  define: { __APP_VERSION__: JSON.stringify('v0.0.0-test') },
  test: { include: ['test/**/*.test.ts'], environment: 'node', coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/server/function.ts'], reporter: ['text-summary', 'html', 'lcov'] } },
});
