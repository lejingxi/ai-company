import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5180, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:3180', changeOrigin: true } } },
});
