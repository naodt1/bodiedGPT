import { defineConfig } from 'vite';

// Ollama is reached through this dev-server proxy (/ollama -> localhost:11434),
// so the browser never has CORS problems talking to it.
export default defineConfig({
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
