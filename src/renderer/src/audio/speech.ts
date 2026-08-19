import { normalizeTranscript } from './capture'

type SpeechCtor = new () => SpeechRecognition

function getSpeechCtor(): SpeechCtor | null {
  const speechWindow = window as Window & {
    SpeechRecognition?: SpeechCtor
    webkitSpeechRecognition?: SpeechCtor
  }
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null
}

export function isSpeechApiAvailable(): boolean {
  return getSpeechCtor() !== null
}

export class LiveSpeech {
  private recognition: SpeechRecognition | null = null
  private finalText = ''
  private latestText = ''

  start(onUpdate: (text: string) => void): boolean {
    const Ctor = getSpeechCtor()
    if (!Ctor) return false

    this.finalText = ''
    this.latestText = ''
    const recognition = new Ctor()
    this.recognition = recognition
    recognition.lang = 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = true

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = ''
      let final = this.finalText
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]
        const piece = result?.[0]?.transcript ?? ''
        if (result?.isFinal) final += piece
        else interim += piece
      }
      this.finalText = final
      this.latestText = normalizeTranscript(`${final} ${interim}`)
      onUpdate(this.latestText)
    }

    recognition.onerror = () => {
      // Keep whatever text we already collected.
    }

    try {
      recognition.start()
      return true
    } catch {
      return false
    }
  }

  stop(): Promise<string> {
    const recognition = this.recognition
    this.recognition = null
    if (!recognition) {
      return Promise.resolve(this.latestText || normalizeTranscript(this.finalText))
    }

    return new Promise((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve(this.latestText || normalizeTranscript(this.finalText))
      }

      recognition.onend = () => finish()
      try {
        recognition.stop()
      } catch {
        finish()
      }
      window.setTimeout(finish, 800)
    })
  }
}
