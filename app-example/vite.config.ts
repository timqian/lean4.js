import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { lean4Plugin } from 'lean4.js/vite'

// https://vite.dev/config/
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react(), lean4Plugin()],
})
