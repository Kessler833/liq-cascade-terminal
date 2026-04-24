import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir:    '../dist/frontend',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target:    'http://localhost:8000',
        changeOrigin: true,
      },
      '/ws': {
        target:    'ws://localhost:8000',
        ws:        true,
        changeOrigin: true,
      },
    },
  },
});
