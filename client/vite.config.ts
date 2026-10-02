import { defineConfig } from 'vite';

// The build is plain static files. Nothing Discord-specific goes in: the page
// asks the server for the client ID at runtime (GET /api/config).
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
});
