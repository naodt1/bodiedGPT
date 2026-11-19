import { defineConfig } from 'vite';

// Ollama is reached through this dev-server proxy (/ollama -> localhost:11434),
// so the browser never has CORS problems talking to it.
export default defineConfig({
  build: {
    rollupOptions: {
      // The app plus the three article pages
      input: {
        main: 'index.html',
        howItWorks: 'how-it-works.html',
        results: 'results.html',
        references: 'references.html',
        changes: 'changes.html',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/ollama': {
        target: 'http://localhost:11434',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ollama/, ''),
      },
    },
  },
});
