import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: '.',
  publicDir: false,
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.FLOWBOARD_PORT || 18790}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
