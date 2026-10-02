import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { readFileSync } from 'fs';

const version = readFileSync(path.resolve(__dirname, '../VERSION'), 'utf8').trim();

// Per-build token so bundle filenames change on every build. Vite's content
// hash alone has proven unreliable here (identical filename across builds),
// which let clients cling to a stale cached bundle.
const buildId = Date.now().toString(36);

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-${buildId}-[hash].js`,
        chunkFileNames: `assets/[name]-${buildId}-[hash].js`,
        assetFileNames: `assets/[name]-${buildId}-[hash].[ext]`,
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3421',
    },
  },
});
