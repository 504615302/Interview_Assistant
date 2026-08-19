import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  session,
  shell
} from 'electron'
import { loadSettings, saveSettings } from './settings'
import { streamAnswer, transcribeAudio } from './minimax'
import { ensureVoskModel, formatNetworkError, importVoskZip } from './vosk-model'
import type { AppSettings } from '../shared/types'

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
    try {
      return await ensureVoskModel((progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('vosk:progress', progress)
        }
      })
    } catch (error) {
      throw new Error(formatNetworkError(error))
    }
  })

  ipcMain.handle('vosk:import', async (event) => {
    const picked = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: '选择 vosk-model-small-cn-0.22.zip',
          filters: [{ name: 'Vosk 模型 zip', extensions: ['zip'] }],
          properties: ['openFile']
        })
      : await dialog.showOpenDialog({
          title: '选择 vosk-model-small-cn-0.22.zip',
          filters: [{ name: 'Vosk 模型 zip', extensions: ['zip'] }],
          properties: ['openFile']
        })
    if (picked.canceled || !picked.filePaths[0]) {
      throw new Error('未选择文件')
    }
    try {
      return await importVoskZip(picked.filePaths[0], (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('vosk:progress', progress)
        }
      })
    } catch (error) {
      throw new Error(formatNetworkError(error))
    }
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
