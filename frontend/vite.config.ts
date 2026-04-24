import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir:      '../dist/frontend',
    emptyOutDir: true,
  },
  server: {
    host:        '0.0.0.0',   // bind to all interfaces for LAN access
    port:        5173,
    strictPort:  true,
    proxy: {
      '/api': {
        // In dev, proxy REST calls to backend.
        // Vite replaces localhost with the actual origin at runtime so
        // LAN clients hit the backend on the same machine IP automatically.
        target:       'http://localhost:8000',
        changeOrigin: true,
      },
      '/ws': {
        target:       'ws://localhost:8000',
        ws:           true,
        changeOrigin: true,
      },
    },
  },
});
