import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { readFileSync } from 'fs';

const version = readFileSync(path.resolve(__dirname, '../VERSION'), 'utf8').trim();
// Version der OpenCV-Datei unter /opencv/ (web/Dockerfile kopiert sie mit
// genau dieser Nummer im Dateinamen).
const opencvVersion = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'))
  .dependencies['@techstark/opencv-js'];

// Per-build token so bundle filenames change on every build. Vite's content
// hash alone has proven unreliable here (identical filename across builds),
// which let clients cling to a stale cached bundle.
const buildId = Date.now().toString(36);

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __OPENCV_VERSION__: JSON.stringify(opencvVersion),
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rolldownOptions: {
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
