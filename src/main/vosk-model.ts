import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { app } from 'electron'
import extract from 'extract-zip'
import { create as tarCreate } from 'tar'

export const VOSK_MODEL_URL = 'voskmodel://model.tar.gz'
const MODEL_DIR_NAME = 'vosk-model-small-cn-0.22'
const ZIP_NAME = `${MODEL_DIR_NAME}.zip`

const DOWNLOAD_URLS = [
  'https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip',
  'https://hf-mirror.com/csukuangfj/vosk-models/resolve/main/asr/vosk-model-small-cn-0.22.zip',
  'https://huggingface.co/csukuangfj/vosk-models/resolve/main/asr/vosk-model-small-cn-0.22.zip'
]

export type VoskProgress = {
  phase: 'download' | 'extract'
  received: number
  total: number
}

function modelRoot(): string {
  return join(app.getPath('userData'), 'vosk')
}

export function voskArchivePath(): string {
  return join(modelRoot(), `${MODEL_DIR_NAME}.tar.gz`)
}

function zipPath(): string {
  return join(modelRoot(), ZIP_NAME)
}

function extractDir(): string {
  return join(modelRoot(), 'extract')
}

export function isVoskModelReady(): boolean {
  const archive = voskArchivePath()
  if (!existsSync(archive)) return false
  try {
    return statSync(archive).size > 1_000_000
  } catch {
    return false
  }
}

async function downloadZip(onProgress: (progress: VoskProgress) => void): Promise<void> {
  mkdirSync(modelRoot(), { recursive: true })
  let lastError: Error | null = null

  for (const url of DOWNLOAD_URLS) {
    try {
      const response = await fetch(url)
      if (!response.ok || !response.body) {
        throw new Error(`下载失败 ${response.status}`)
      }
      const total = Number(response.headers.get('content-length') || 0)
      let received = 0
      const nodeStream = Readable.fromWeb(response.body as never)
      nodeStream.on('data', (chunk: Buffer) => {
        received += chunk.length
        onProgress({ phase: 'download', received, total })
      })
      await pipeline(nodeStream, createWriteStream(zipPath()))
      if (statSync(zipPath()).size < 1_000_000) {
        throw new Error('模型文件不完整')
      }
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  throw lastError ?? new Error('无法下载中文语音模型')
}

async function packArchive(onProgress: (progress: VoskProgress) => void): Promise<void> {
  onProgress({ phase: 'extract', received: 0, total: 1 })
  const extractTo = extractDir()
  if (existsSync(extractTo)) rmSync(extractTo, { recursive: true, force: true })
  mkdirSync(extractTo, { recursive: true })
  await extract(zipPath(), { dir: extractTo })
  const names = readdirSync(extractTo).filter((name) => name !== '__MACOSX')
  const entries = names.includes(MODEL_DIR_NAME) ? [MODEL_DIR_NAME] : names
  if (entries.length === 0) throw new Error('解压后没有找到语音模型文件')

  await tarCreate(
    {
      gzip: true,
      file: voskArchivePath(),
      cwd: extractTo
    },
    entries
  )

  rmSync(zipPath(), { force: true })
  rmSync(extractTo, { recursive: true, force: true })
  onProgress({ phase: 'extract', received: 1, total: 1 })
}

export async function ensureVoskModel(
  onProgress: (progress: VoskProgress) => void
): Promise<string> {
  if (!isVoskModelReady()) {
    await downloadZip(onProgress)
    await packArchive(onProgress)
  }
  if (!isVoskModelReady()) {
    throw new Error('语音模型安装失败，请检查网络后重试')
  }
  return VOSK_MODEL_URL
}
