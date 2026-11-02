import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': { target: process.env.API_PROXY ?? 'http://localhost:3001', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
