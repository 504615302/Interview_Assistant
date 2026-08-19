import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { app } from 'electron'
import extract from 'extract-zip'
import { create as tarCreate } from 'tar'

const MODEL_DIR_NAME = 'vosk-model-small-cn-0.22'
const ARCHIVE_NAME = 'vosk-cn-0.22-flat.tar.gz'
const FORMAT_MARK = 'flat-v1'

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
  return join(modelRoot(), ARCHIVE_NAME)
}

function zipPath(): string {
  return join(modelRoot(), `${MODEL_DIR_NAME}.zip`)
}

function extractDir(): string {
  return join(modelRoot(), 'extract')
}

function markPath(): string {
  return join(modelRoot(), 'format.txt')
}

function isVoskModelReady(): boolean {
  const archive = voskArchivePath()
  const mark = markPath()
  if (!existsSync(archive) || !existsSync(mark)) return false
  try {
    return statSync(archive).size > 1_000_000
  } catch {
    return false
  }
}

function findModelDir(root: string): string {
  const names = readdirSync(root).filter((name) => name !== '__MACOSX')
  if (names.includes('am') && names.includes('conf')) return root
  for (const name of names) {
    const full = join(root, name)
    if (statSync(full).isDirectory()) {
      try {
        return findModelDir(full)
      } catch {
        // keep searching
      }
    }
  }
  throw new Error('解压后没有找到 am/conf，模型包格式不对')
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

  const modelDir = findModelDir(extractTo)
  const entries = readdirSync(modelDir).filter((name) => name !== '__MACOSX')
  if (!entries.includes('am') || !entries.includes('conf')) {
    throw new Error('模型目录缺少 am 或 conf')
  }

  await tarCreate(
    {
      gzip: true,
      file: voskArchivePath(),
      cwd: modelDir
    },
    entries
  )

  writeFileSync(markPath(), FORMAT_MARK, 'utf8')
  rmSync(zipPath(), { force: true })
  rmSync(extractTo, { recursive: true, force: true })
  onProgress({ phase: 'extract', received: 1, total: 1 })
}

export async function ensureVoskModel(
  onProgress: (progress: VoskProgress) => void
): Promise<Uint8Array> {
  mkdirSync(modelRoot(), { recursive: true })
  const stale = join(modelRoot(), `${MODEL_DIR_NAME}.tar.gz`)
  if (existsSync(stale)) rmSync(stale, { force: true })

  if (!isVoskModelReady()) {
    await downloadZip(onProgress)
    await packArchive(onProgress)
  }
  if (!isVoskModelReady()) {
    throw new Error('语音模型安装失败，请检查网络后重试')
  }

  const buf = await readFile(voskArchivePath())
  return new Uint8Array(buf)
}
