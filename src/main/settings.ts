import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings } from '../shared/types'

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): AppSettings {
  try {
    const file = settingsPath()
    if (!existsSync(file)) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppSettings>
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(next: AppSettings): AppSettings {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const merged = { ...DEFAULT_SETTINGS, ...next }
  writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), 'utf8')
  return merged
}
