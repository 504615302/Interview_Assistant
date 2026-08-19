import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

function copyVoskBrowser(): Plugin {
  return {
    name: 'copy-vosk-browser',
    buildStart() {
      const from = resolve('node_modules/vosk-browser/dist/vosk.js')
      const dir = resolve('src/renderer/public')
      mkdirSync(dir, { recursive: true })
      copyFileSync(from, resolve(dir, 'vosk.js'))
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    publicDir: resolve('src/renderer/public'),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), copyVoskBrowser()]
  }
})
