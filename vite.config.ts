import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  root: 'ui/client',
  build: {
    outDir: '../../ui/public',
    emptyOutDir: false,  // keep approve.html and other static files
  },
  publicDir: 'public',  // copies ui/client/public/ → ui/public/ on build
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'ui/client/src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/approve': 'http://localhost:3000',
    },
  },
})
