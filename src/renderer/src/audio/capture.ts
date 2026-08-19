export function normalizeTranscript(text: string): string {
  const trimmed = text.trim()
  const cjk = (trimmed.match(/[\u4e00-\u9fff]/g) ?? []).length
  if (cjk > trimmed.length / 4) return trimmed.replace(/\s+/g, '')
  return trimmed
}

export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeString = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i))
    }
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    offset += 2
  }
  return buffer
}

export async function captureAudioStream(source: 'microphone' | 'system'): Promise<MediaStream> {
  if (source === 'microphone') {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    })
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: 16,
      height: 16,
      frameRate: 1
    },
    audio: true
  })

  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((track) => track.stop())
    throw new Error('没有捕获到系统声音，请确认会议正在播放音频')
  }

  return stream
}

export class AudioRecorder {
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private processor: ScriptProcessorNode | null = null
  private analyser: AnalyserNode | null = null
  private chunks: Float32Array[] = []
  private raf = 0

  async start(
    source: 'microphone' | 'system',
    onLevel: (level: number) => void
  ): Promise<void> {
    this.chunks = []
    this.stream = await captureAudioStream(source)
    const context = new AudioContext({ sampleRate: 16000 })
    this.context = context
    if (context.state === 'suspended') await context.resume()

    const sourceNode = context.createMediaStreamSource(this.stream)
    const analyser = context.createAnalyser()
    analyser.fftSize = 256
    this.analyser = analyser

    const processor = context.createScriptProcessor(4096, 1, 1)
    this.processor = processor
    processor.onaudioprocess = (event) => {
      this.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
    }

    const mute = context.createGain()
    mute.gain.value = 0
    sourceNode.connect(analyser)
    analyser.connect(processor)
    processor.connect(mute)
    mute.connect(context.destination)

    const data = new Uint8Array(analyser.frequencyBinCount)
    const tick = (): void => {
      analyser.getByteTimeDomainData(data)
      let sum = 0
      for (const value of data) {
        const centered = (value - 128) / 128
        sum += centered * centered
      }
      onLevel(Math.sqrt(sum / data.length))
      this.raf = requestAnimationFrame(tick)
    }
    tick()
  }

  stop(): { wav: ArrayBuffer; durationMs: number } {
    cancelAnimationFrame(this.raf)
    this.processor?.disconnect()
    this.analyser?.disconnect()
    this.stream?.getTracks().forEach((track) => track.stop())

    const sampleRate = this.context?.sampleRate ?? 16000
    void this.context?.close()
    this.processor = null
    this.analyser = null
    this.context = null
    this.stream = null

    const length = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const samples = new Float32Array(length)
    let offset = 0
    for (const chunk of this.chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }
    this.chunks = []
    return {
      wav: encodeWav(samples, sampleRate),
      durationMs: (length / sampleRate) * 1000
    }
  }
}
