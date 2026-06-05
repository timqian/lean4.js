import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { lean4Plugin } from 'lean4.js/vite'
import fs from 'fs'
import path from 'path'

// Plugin to copy coi-serviceworker.js into the build output
function coiServiceWorkerPlugin() {
  return {
    name: 'coi-serviceworker',
    buildStart() {
      const src = path.resolve('node_modules/coi-serviceworker/coi-serviceworker.min.js')
      const dest = path.resolve('public/coi-serviceworker.js')
      fs.copyFileSync(src, dest)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react(), lean4Plugin(), coiServiceWorkerPlugin()],
})
