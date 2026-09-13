import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.join(projectRoot, 'src', 'client');

export default defineConfig({
  root: clientRoot,
  appType: 'mpa',
  publicDir: false,
  envDir: projectRoot,
  build: {
    outDir: path.join(projectRoot, 'dist', 'client'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2020',
    rollupOptions: {
      input: {
        index: path.join(clientRoot, 'index.html'),
        chat: path.join(clientRoot, 'chat.html')
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true
      }
    }
  }
});
