import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  net,
  protocol,
  session,
  shell
} from 'electron'
import { loadSettings, saveSettings } from './settings'
import { streamAnswer, transcribeAudio } from './minimax'
import { ensureVoskModel, voskArchivePath } from './vosk-model'
import type { AppSettings } from '../shared/types'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'voskmodel',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: true
    }
  }
])

const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null
let answerAbort: AbortController | null = null

function preloadPath(): string {
  const candidates = [
    join(__dirname, '../preload/index.mjs'),
    join(__dirname, '../preload/index.cjs'),
    join(__dirname, '../preload/index.js')
  ]
  return candidates.find((file) => existsSync(file)) ?? candidates[0]
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 460,
    height: 720,
    minWidth: 380,
    minHeight: 480,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.once('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function registerHotkey(accelerator: string): boolean {
  globalShortcut.unregisterAll()
  return globalShortcut.register(accelerator, () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.send('hotkey:toggle')
  })
}

function setupDisplayMedia(): void {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      const source = sources[0]
      if (!source) {
        callback({})
        return
      }
      callback({ video: source, audio: 'loopback' })
    })
  })
}

function setupIpc(): void {
  ipcMain.handle('settings:get', () => loadSettings())

  ipcMain.handle('settings:save', (_event, next: AppSettings) => {
    const saved = saveSettings(next)
    const ok = registerHotkey(saved.hotkey)
    return { settings: saved, hotkeyOk: ok }
  })

  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:close', () => mainWindow?.close())

  ipcMain.handle('vosk:ensure', async (event) => {
    return ensureVoskModel((progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('vosk:progress', progress)
      }
    })
  })

  ipcMain.handle(
    'stt:transcribe',
    async (
      _event,
      payload: { audio: ArrayBuffer; filename: string; mimeType: string }
    ) => {
      const settings = loadSettings()
      return transcribeAudio({
        settings,
        audio: Buffer.from(payload.audio),
        filename: payload.filename,
        mimeType: payload.mimeType
      })
    }
  )

  ipcMain.handle('ai:answer', async (event, question: string) => {
    answerAbort?.abort()
    answerAbort = new AbortController()
    const settings = loadSettings()
    return streamAnswer({
      settings,
      question,
      signal: answerAbort.signal,
      onDelta: (text) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('ai:chunk', text)
        }
      }
    })
  })

  ipcMain.handle('ai:cancel', () => {
    answerAbort?.abort()
    answerAbort = null
  })
}

app.whenReady().then(() => {
  protocol.handle('voskmodel', () => net.fetch(pathToFileURL(voskArchivePath()).href))
  setupIpc()
  setupDisplayMedia()
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture')
  })

  mainWindow = createWindow()
  registerHotkey(loadSettings().hotkey)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})
