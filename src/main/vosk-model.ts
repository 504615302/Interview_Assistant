import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, net } from 'electron'
import extract from 'extract-zip'
import { create as tarCreate } from 'tar'

const MODEL_DIR_NAME = 'vosk-model-small-cn-0.22'
const ARCHIVE_NAME = 'vosk-cn-0.22-flat.tar.gz'
const FORMAT_MARK = 'flat-v1'

const DOWNLOAD_URLS = [
  'https://hf-mirror.com/rhasspy/vosk-models/resolve/main/zh/vosk-model-small-cn-0.22.zip',
  'https://huggingface.co/rhasspy/vosk-models/resolve/main/zh/vosk-model-small-cn-0.22.zip',
  'https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip',
  'https://hf-mirror.com/csukuangfj/vosk-models/resolve/main/asr/vosk-model-small-cn-0.22.zip'
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

export function formatNetworkError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as Error & { cause?: unknown }).cause
  if (cause instanceof Error && cause.message) {
    return `${error.message}（${cause.message}）`
  }
  if (typeof cause === 'string' && cause) {
    return `${error.message}（${cause}）`
  }
  return error.message
}

function downloadWithChromium(
  url: string,
  dest: string,
  onProgress: (progress: VoskProgress) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'GET',
      url,
      redirect: 'follow'
    })
    request.setHeader(
      'User-Agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) InterviewAssistant/0.1'
    )
    request.on('response', (response) => {
      const status = response.statusCode ?? 0
      if (status >= 400) {
        reject(new Error(`${url} 返回 HTTP ${status}`))
        return
      }
      const lengthHeader = response.headers['content-length']
      const total = Number(Array.isArray(lengthHeader) ? lengthHeader[0] : lengthHeader || 0)
      let received = 0
      const file = createWriteStream(dest)
      response.on('data', (chunk) => {
        received += chunk.length
        file.write(chunk)
        onProgress({ phase: 'download', received, total })
      })
      response.on('end', () => {
        file.end(() => resolve())
      })
      response.on('error', (error) => {
        file.destroy()
        reject(error)
      })
      file.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })
}

async function downloadZip(onProgress: (progress: VoskProgress) => void): Promise<void> {
  mkdirSync(modelRoot(), { recursive: true })
  const errors: string[] = []

  for (const url of DOWNLOAD_URLS) {
    try {
      onProgress({ phase: 'download', received: 0, total: 0 })
      await downloadWithChromium(url, zipPath(), onProgress)
      if (!existsSync(zipPath()) || statSync(zipPath()).size < 1_000_000) {
        throw new Error('下载的文件不完整')
      }
      return
    } catch (error) {
      errors.push(`${url} → ${formatNetworkError(error)}`)
      if (existsSync(zipPath())) rmSync(zipPath(), { force: true })
    }
  }

  throw new Error(
    `无法下载语音模型。可浏览器打开 https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip 下载后点「选择本地 zip」。详情：${errors.join('；')}`
  )
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
    throw new Error('模型目录缺少 am 或 conf，请确认 zip 是 vosk-model-small-cn-0.22')
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

async function readArchive(): Promise<Uint8Array> {
  if (!isVoskModelReady()) {
    throw new Error('语音模型安装失败，请检查网络后重试，或选择本地 zip')
  }
  const buf = await readFile(voskArchivePath())
  return new Uint8Array(buf)
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
  return readArchive()
}

export async function importVoskZip(
  sourceZip: string,
  onProgress: (progress: VoskProgress) => void
): Promise<Uint8Array> {
  mkdirSync(modelRoot(), { recursive: true })
  if (!existsSync(sourceZip)) {
    throw new Error('选择的 zip 不存在')
  }
  if (statSync(sourceZip).size < 1_000_000) {
    throw new Error('zip 太小，请下载 vosk-model-small-cn-0.22.zip（约 42MB）')
  }
  copyFileSync(sourceZip, zipPath())
  await packArchive(onProgress)
  return readArchive()
}
