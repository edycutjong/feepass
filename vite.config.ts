import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Released version shown in the footer: the newest v* tag on this commit's history (set by the Release workflow),
// falling back to package.json when the build has no git history (e.g. a CLI upload).
function appVersion(): string {
  try {
    return execSync('git describe --tags --abbrev=0 --match "v*"', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'v' + JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
  }
}

export default defineConfig({
  plugins: [vue()],
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        gate: fileURLToPath(new URL('./gate.html', import.meta.url)),
      },
    },
  },
});
