import { minimaxBaseUrl, type AppSettings } from '../shared/types'

const SYSTEM_PROMPT = `你是面试答题助手。根据面试官口述转写出来的问题，给出候选人可以当场扫读或口述的中文答案。

要求：
1. 先用一句话直接回答核心观点。
2. 再用 3～6 条要点展开；行为/项目题优先用 STAR（背景、任务、行动、结果），结果尽量带数字。
3. 语言自然、简洁，像口语，不要空话、不要自我介绍你是 AI。
4. 如果转写含糊，先写出你理解的问题，再作答。
5. 不要输出思考过程，直接给答案。`

function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .trim()
}

function joinBase(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`
}

async function readErrorMessage(response: Response): Promise<string> {
  const raw = await response.text()
  try {
    const json = JSON.parse(raw) as {
      error?: { message?: string }
      base_resp?: { status_msg?: string }
      message?: string
    }
    return (
      json.error?.message ||
      json.base_resp?.status_msg ||
      json.message ||
      raw ||
      `HTTP ${response.status}`
    )
  } catch {
    return raw || `HTTP ${response.status}`
  }
}

export async function transcribeAudio(params: {
  settings: AppSettings
  audio: Buffer
  filename: string
  mimeType: string
  signal?: AbortSignal
}): Promise<string> {
  const { settings, audio, filename, mimeType, signal } = params
  const sttBase = settings.sttBaseUrl.trim()
  if (!sttBase) {
    throw new Error(
      'MiniMax 没有语音识别接口。请用麦克风收声，或在设置里填写兼容 Whisper 的转写地址。'
    )
  }
  if (!settings.apiKey.trim()) {
    throw new Error('请先在设置中填写 API Key')
  }
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), filename)
  form.append('model', settings.sttModel.trim() || 'whisper-1')
  form.append('language', 'zh')

  const response = await fetch(joinBase(sttBase, '/audio/transcriptions'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey.trim()}`
    },
    body: form,
    signal
  })

  if (!response.ok) {
    throw new Error(`语音识别失败：${await readErrorMessage(response)}`)
  }

  const json = (await response.json()) as { text?: string }
  const text = json.text?.trim()
  if (!text) throw new Error('语音识别没有返回文本')
  return text
}

export async function streamAnswer(params: {
  settings: AppSettings
  question: string
  onDelta: (fullText: string) => void
  signal?: AbortSignal
}): Promise<string> {
  const { settings, question, onDelta, signal } = params
  if (!settings.apiKey.trim()) {
    throw new Error('请先在设置中填写 MiniMax API Key')
  }

  const response = await fetch(joinBase(minimaxBaseUrl(settings.region), '/chat/completions'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.apiKey.trim()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: settings.model,
      stream: true,
      temperature: 0.7,
      max_completion_tokens: 2048,
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `面试官问题：\n${question}` }
      ]
    }),
    signal
  })

  if (!response.ok) {
    throw new Error(`MiniMax 调用失败：${await readErrorMessage(response)}`)
  }

  if (!response.body) {
    throw new Error('MiniMax 没有返回流式内容')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let raw = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        const json = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>
        }
        const piece = json.choices?.[0]?.delta?.content
        if (piece) {
          raw += piece
          onDelta(stripThinking(raw))
        }
      } catch {
        // ignore malformed SSE chunks
      }
    }
  }

  const finalText = stripThinking(raw)
  if (!finalText) throw new Error('MiniMax 没有生成答案')
  onDelta(finalText)
  return finalText
}
