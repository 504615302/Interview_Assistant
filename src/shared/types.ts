export type AudioSource = 'microphone' | 'system'
export type Region = 'china' | 'global'
export type SttMode = 'local' | 'auto' | 'speech-api' | 'whisper'

export interface AppSettings {
  apiKey: string
  region: Region
  model: string
  audioSource: AudioSource
  hotkey: string
  sttMode: SttMode
  sttBaseUrl: string
  sttModel: string
}

export const HOTKEY_OPTIONS = [
  'CommandOrControl+Shift+Space',
  'CommandOrControl+Shift+Q',
  'Alt+Space',
  'F8',
  'F9'
] as const

export const MODEL_OPTIONS = [
  'MiniMax-M2.7-highspeed',
  'MiniMax-M2.7',
  'MiniMax-M3',
  'MiniMax-M2.5-highspeed'
] as const

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  region: 'china',
  model: 'MiniMax-M2.7-highspeed',
  audioSource: 'microphone',
  hotkey: 'CommandOrControl+Shift+Space',
  sttMode: 'local',
  sttBaseUrl: '',
  sttModel: 'whisper-1'
}

export function minimaxBaseUrl(region: Region): string {
  return region === 'global' ? 'https://api.minimax.io/v1' : 'https://api.minimaxi.com/v1'
}

export function formatHotkey(accelerator: string): string {
  return accelerator
    .replaceAll('CommandOrControl', 'Ctrl')
    .replaceAll('+', ' + ')
}
