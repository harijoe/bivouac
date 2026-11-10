import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: { port: 5199, proxy: { '/api': { target: process.env.BIVOUAC_API ?? 'http://127.0.0.1:3100', changeOrigin: true } } },
  build: { outDir: 'dist', sourcemap: false },
});
