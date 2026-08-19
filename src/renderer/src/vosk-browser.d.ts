declare module 'vosk-browser' {
  export class Model {
    constructor(modelUrl: string, logLevel?: number)
    on(event: string, listener: (message: { result?: boolean; error?: string }) => void): void
    terminate(): void
    readonly KaldiRecognizer: new (sampleRate: number) => unknown
  }
  export function createModel(modelUrl: string): Promise<Model>
}
