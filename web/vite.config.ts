import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

// Serves watcher evidence bundles (public data: hashes, signals, explanations) at /evidence/*.
const evidenceDir = path.resolve(__dirname, '../watcher/evidence');
const evidence = () => ({
  name: 'rescueroom-evidence',
  configureServer(server: any) {
    server.middlewares.use('/evidence', (req: any, res: any, next: any) => {
      const f = path.join(evidenceDir, path.basename(decodeURIComponent(req.url || '')));
      if (!f.startsWith(evidenceDir) || !fs.existsSync(f)) return next();
      res.setHeader('content-type', 'application/json');
      fs.createReadStream(f).pipe(res);
    });
  },
});

export default defineConfig({
  plugins: [react(), evidence()],
  resolve: { alias: { '@deploy': path.resolve(__dirname, '../deploy') } },
  // near-api-js pieces inside the wallet selector expect Node's `global`.
  define: { global: 'globalThis' },
  server: {
    fs: { allow: ['..'] },
    // Local API (indexer, alerts, attacker sandbox): npm run api
    proxy: { '/api': { target: process.env.RR_API || 'http://127.0.0.1:8787', changeOrigin: false } },
  },
  preview: { proxy: { '/api': { target: process.env.RR_API || 'http://127.0.0.1:8787' } } },
  build: { chunkSizeWarningLimit: 1500 },
});
