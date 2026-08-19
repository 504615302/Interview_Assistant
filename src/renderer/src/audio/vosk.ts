import { normalizeTranscript } from './capture'

export function downsampleTo16k(input: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === 16000) return input
  const ratio = sampleRate / 16000
  const length = Math.max(1, Math.floor(input.length / ratio))
  const output = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    output[i] = input[Math.min(input.length - 1, Math.floor(i * ratio))] ?? 0
  }
  return output
}

type VoskResultMessage = {
  result: {
    text?: string
    partial?: string
  }
}

type VoskRecognizer = {
  on(event: 'result' | 'partialresult', cb: (message: VoskResultMessage) => void): void
  acceptWaveformFloat(buffer: Float32Array, sampleRate: number): void
  retrieveFinalResult(): void
  remove(): void
}

type VoskModel = {
  KaldiRecognizer: new (sampleRate?: number) => VoskRecognizer
  on(event: 'load' | 'error', listener: (message: { result?: boolean; error?: string }) => void): void
  terminate(): void
}

let modelPromise: Promise<VoskModel> | null = null
let blobUrl: string | null = null

type VoskModule = {
  Model?: unknown
  createModel?: unknown
  default?: VoskModule
}

function asModelCtor(value: unknown): (new (modelUrl: string) => VoskModel) | undefined {
  if (typeof value === 'function') return value as new (modelUrl: string) => VoskModel
  if (value && typeof value === 'object') {
    const nested = (value as { default?: unknown }).default
    if (typeof nested === 'function') return nested as new (modelUrl: string) => VoskModel
  }
  return undefined
}

function asCreateModel(value: unknown): ((modelUrl: string) => Promise<VoskModel>) | undefined {
  return typeof value === 'function' ? (value as (modelUrl: string) => Promise<VoskModel>) : undefined
}

function readVoskFrom(value: unknown): VoskModule | null {
  if (!value || typeof value !== 'object') return null
  return value as VoskModule
}

async function loadVoskScript(): Promise<VoskModule> {
  const globalVosk = (globalThis as { Vosk?: VoskModule }).Vosk
  if (globalVosk && (globalVosk.Model || globalVosk.createModel)) {
    return globalVosk
  }

  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-vosk-loader="true"]')
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('无法加载 vosk.js')), { once: true })
      return
    }
    const script = document.createElement('script')
    script.src = `${import.meta.env.BASE_URL}vosk.js`
    script.async = true
    script.dataset.voskLoader = 'true'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('无法加载 vosk.js，请重启应用'))
    document.head.appendChild(script)
  })

  const vosk = (globalThis as { Vosk?: VoskModule }).Vosk
  if (!vosk) {
    throw new Error('vosk.js 已执行，但没有挂上全局 Vosk')
  }
  return vosk
}

function resolveVoskApi(imported: VoskModule): {
  Model?: new (modelUrl: string) => VoskModel
  createModel?: (modelUrl: string) => Promise<VoskModel>
} {
  const layers: Array<VoskModule | null> = [
    imported,
    imported.default ?? null,
    imported.default?.default ?? null,
    readVoskFrom((globalThis as { Vosk?: unknown }).Vosk)
  ]

  for (const layer of layers) {
    if (!layer) continue
    const Model = asModelCtor(layer.Model)
    const createModel = asCreateModel(layer.createModel)
    if (Model || createModel) return { Model, createModel }
  }

  throw new Error('vosk-browser 未能正确加载，请重启应用')
}

async function loadModel(archive: ArrayBuffer | Uint8Array): Promise<VoskModel> {
  const imported = await loadVoskScript()
  const vosk = resolveVoskApi(imported)

  if (blobUrl) URL.revokeObjectURL(blobUrl)
  const bytes = archive instanceof Uint8Array ? archive : new Uint8Array(archive)
  blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/gzip' }))
  const modelUrl = blobUrl

  if (typeof vosk.Model === 'function') {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: Error, model?: VoskModel): void => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        if (error) reject(error)
        else if (model) resolve(model)
      }

      const timer = window.setTimeout(() => {
        finish(new Error('语音模型加载超时，请重启应用'))
      }, 120000)

      try {
        const model = new vosk.Model(modelUrl)
        model.on('load', (message) => {
          if (message.result) finish(undefined, model)
          else finish(new Error('Vosk 无法解析模型文件'))
        })
        model.on('error', (message) => {
          finish(new Error(message.error || 'Vosk worker 报错'))
        })
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  if (typeof vosk.createModel !== 'function') {
    throw new Error('vosk-browser 没有可用的 Model / createModel')
  }

  const loaded = await Promise.race([
    vosk.createModel(modelUrl),
    new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error('语音模型加载超时，请重启应用')), 120000)
    })
  ])
  return loaded
}

export class LocalStt {
  private model: VoskModel | null = null
  private recognizer: VoskRecognizer | null = null
  private finals: string[] = []
  private partial = ''

  async prepare(archive: ArrayBuffer | Uint8Array): Promise<void> {
    if (!modelPromise) modelPromise = loadModel(archive)
    try {
      this.model = await modelPromise
    } catch (error) {
      modelPromise = null
      throw error
    }
  }

  start(onUpdate: (text: string) => void): void {
    if (!this.model) throw new Error('语音模型还没准备好')
    this.finals = []
    this.partial = ''
    const recognizer = new this.model.KaldiRecognizer(16000)
    this.recognizer = recognizer
    recognizer.on('result', (message) => {
      const text = normalizeTranscript(message.result.text ?? '')
      if (text) this.finals.push(text)
      this.partial = ''
      onUpdate(this.currentText())
    })
    recognizer.on('partialresult', (message) => {
      this.partial = normalizeTranscript(message.result.partial ?? '')
      onUpdate(this.currentText())
    })
  }

  accept(buffer: AudioBuffer): void {
    if (!this.recognizer) return
    try {
      const samples = downsampleTo16k(buffer.getChannelData(0), buffer.sampleRate)
      this.recognizer.acceptWaveformFloat(samples, 16000)
    } catch {
      // ignore empty / too-short chunks
    }
  }

  stop(): Promise<string> {
    const recognizer = this.recognizer
    this.recognizer = null
    if (!recognizer) {
      return Promise.resolve(this.currentText())
    }

    try {
      recognizer.retrieveFinalResult()
    } catch {
      // ignore
    }

    return new Promise((resolve) => {
      window.setTimeout(() => {
        try {
          recognizer.remove()
        } catch {
          // already removed
        }
        const text = this.currentText()
        this.finals = []
        this.partial = ''
        resolve(text)
      }, 400)
    })
  }

  private currentText(): string {
    return normalizeTranscript([...this.finals, this.partial].filter(Boolean).join(''))
  }
}
