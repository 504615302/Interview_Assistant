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

export function to16kAudioBuffer(input: AudioBuffer): AudioBuffer {
  const source = input.getChannelData(0)
  const samples = downsampleTo16k(source, input.sampleRate)
  const buffer = new AudioBuffer({
    length: samples.length,
    numberOfChannels: 1,
    sampleRate: 16000
  })
  buffer.copyToChannel(samples, 0)
  return buffer
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
}

let modelPromise: Promise<VoskModel> | null = null

async function loadModel(modelUrl: string): Promise<VoskModel> {
  const mod = (await import('vosk-browser')) as {
    createModel: (url: string) => Promise<VoskModel>
  }
  try {
    return await mod.createModel(modelUrl)
  } catch {
    throw new Error('本地语音模型加载失败，请重启应用重试')
  }
}

export class LocalStt {
  private model: VoskModel | null = null
  private recognizer: VoskRecognizer | null = null
  private finals: string[] = []
  private partial = ''

  async prepare(modelUrl: string): Promise<void> {
    if (!modelPromise) modelPromise = loadModel(modelUrl)
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
