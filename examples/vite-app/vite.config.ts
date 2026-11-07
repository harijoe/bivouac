/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // bivouac serves the preview under a custom hostname (t-<id>.<project>.<domain>): allow it.
  server: { host: '0.0.0.0', port: 5173, allowedHosts: true },
  test: { globals: true, environment: 'jsdom', setupFiles: ['./src/setup.ts'] },
});
