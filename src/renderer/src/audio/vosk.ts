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

async function loadModel(archive: ArrayBuffer | Uint8Array): Promise<VoskModel> {
  const vosk = (await import('vosk-browser')) as {
    Model: new (modelUrl: string) => VoskModel
  }

  if (blobUrl) URL.revokeObjectURL(blobUrl)
  const bytes = archive instanceof Uint8Array ? archive : new Uint8Array(archive)
  blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/gzip' }))
  const modelUrl = blobUrl

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

export class LocalStt {
  private model: VoskModel | null = null
  private recognizer: VoskRecognizer | null = null
  private finals: string[] = []
  private partial = ''

  async prepare(archive: ArrayBuffer | Uint8Array): Promise<void> {
    if (!modelPromise) modelPromise = loadModel(archive)
    this.model = await modelPromise
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
