import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // In production a Pages Function proxies greenroom over the Cloudflare tunnel
      // (functions/_greenroom.ts). There is no Function in `vite dev`, so any page
      // that talks to greenroom is dead locally unless the same path is pointed at
      // the copy already running on this machine. Dev only, never in the build.
      '/greenroom/embed': {
        target: 'http://127.0.0.1:5710',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/greenroom\/embed/, ''),
      },
    },
  },
})
