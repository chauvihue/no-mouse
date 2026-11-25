import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { tanstackRouter } from '@tanstack/router-plugin/vite'

// GitHub Pages serves this repo at https://<user>.github.io/no-mouse/.
// Set BASE_PATH (e.g. "/") to build for a different host or repo name.
const base = process.env.BASE_PATH ?? '/no-mouse/'

export default defineConfig({
  base,
  plugins: [tanstackRouter({ target: 'react' }), react()],
})
