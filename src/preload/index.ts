import { contextBridge, ipcRenderer } from 'electron'
import type { AppSettings } from '../shared/types'

export interface SaveSettingsResult {
  settings: AppSettings
  hotkeyOk: boolean
}

const api = {
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: AppSettings): Promise<SaveSettingsResult> =>
    ipcRenderer.invoke('settings:save', settings),
  minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  close: (): Promise<void> => ipcRenderer.invoke('window:close'),
  transcribe: (payload: {
    audio: ArrayBuffer
    filename: string
    mimeType: string
  }): Promise<string> => ipcRenderer.invoke('stt:transcribe', payload),
  ensureVoskModel: (): Promise<Uint8Array> => ipcRenderer.invoke('vosk:ensure'),
  onVoskProgress: (
    handler: (progress: { phase: 'download' | 'extract'; received: number; total: number }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      progress: { phase: 'download' | 'extract'; received: number; total: number }
    ): void => handler(progress)
    ipcRenderer.on('vosk:progress', listener)
    return () => ipcRenderer.removeListener('vosk:progress', listener)
  },
  answer: (question: string): Promise<string> => ipcRenderer.invoke('ai:answer', question),
  cancelAnswer: (): Promise<void> => ipcRenderer.invoke('ai:cancel'),
  onHotkeyToggle: (handler: () => void): (() => void) => {
    const listener = (): void => handler()
    ipcRenderer.on('hotkey:toggle', listener)
    return () => ipcRenderer.removeListener('hotkey:toggle', listener)
  },
  onAnswerChunk: (handler: (text: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, text: string): void => handler(text)
    ipcRenderer.on('ai:chunk', listener)
    return () => ipcRenderer.removeListener('ai:chunk', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type InterviewApi = typeof api
