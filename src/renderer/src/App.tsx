import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_SETTINGS,
  HOTKEY_OPTIONS,
  MODEL_OPTIONS,
  formatHotkey,
  type AppSettings
} from '@shared/types'
import { AudioRecorder, normalizeTranscript } from './audio/capture'
import { LiveSpeech, isSpeechApiAvailable } from './audio/speech'

type Status = 'idle' | 'recording' | 'transcribing' | 'answering' | 'error'

function statusLabel(status: Status, recording: boolean): string {
  if (status === 'recording' || recording) return '正在收声'
  if (status === 'transcribing') return '正在识别问题'
  if (status === 'answering') return '正在生成答案'
  if (status === 'error') return '出错了'
  return '就绪'
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = String(Math.floor(total / 60)).padStart(2, '0')
  const seconds = String(total % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [ready, setReady] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [level, setLevel] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [copied, setCopied] = useState(false)
  const [hotkeyHint, setHotkeyHint] = useState('')

  const recorderRef = useRef(new AudioRecorder())
  const speechRef = useRef(new LiveSpeech())
  const recordingRef = useRef(false)
  const startedAtRef = useRef(0)
  const busyRef = useRef(false)

  const hotkeyText = useMemo(() => formatHotkey(settings.hotkey), [settings.hotkey])

  useEffect(() => {
    void window.api.getSettings().then((loaded) => {
      setSettings(loaded)
      setShowSettings(!loaded.apiKey.trim())
      setReady(true)
    })
  }, [])

  useEffect(() => {
    return window.api.onAnswerChunk((text) => setAnswer(text))
  }, [])

  useEffect(() => {
    if (!recordingRef.current) return
    const timer = window.setInterval(() => {
      setElapsed(Date.now() - startedAtRef.current)
    }, 200)
    return () => window.clearInterval(timer)
  }, [status])

  const startListening = useCallback(async () => {
    if (busyRef.current) return
    setError('')
    setCopied(false)
    setQuestion('')
    setAnswer('')
    setElapsed(0)
    setStatus('recording')
    recordingRef.current = true
    startedAtRef.current = Date.now()

    try {
      await recorderRef.current.start(settings.audioSource, setLevel)
      const canUseSpeech =
        settings.audioSource === 'microphone' &&
        settings.sttMode !== 'whisper' &&
        isSpeechApiAvailable()
      if (canUseSpeech) {
        speechRef.current.start((text) => setQuestion(text))
      }
    } catch (err) {
      recordingRef.current = false
      setStatus('error')
      setError(err instanceof Error ? err.message : '无法开始收声')
    }
  }, [settings.audioSource, settings.sttMode])

  const stopAndAnswer = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    recordingRef.current = false
    setLevel(0)

    const liveText = await speechRef.current.stop()
    let wav: ArrayBuffer
    let durationMs = 0
    try {
      const recorded = recorderRef.current.stop()
      wav = recorded.wav
      durationMs = recorded.durationMs
    } catch (err) {
      busyRef.current = false
      setStatus('error')
      setError(err instanceof Error ? err.message : '停止收声失败')
      return
    }

    if (durationMs < 800) {
      busyRef.current = false
      setStatus('error')
      setError('收声太短，请按快捷键后对着会议声音或多说几句')
      return
    }

    try {
      let nextQuestion = liveText
      const canUseCloudStt = Boolean(settings.sttBaseUrl.trim()) && settings.sttMode !== 'speech-api'
      const needCloudStt =
        canUseCloudStt &&
        (settings.sttMode === 'whisper' || settings.audioSource === 'system' || !nextQuestion)

      if (needCloudStt) {
        setStatus('transcribing')
        nextQuestion = normalizeTranscript(
          await window.api.transcribe({
            audio: wav,
            filename: 'question.wav',
            mimeType: 'audio/wav'
          })
        )
      }

      if (!nextQuestion) {
        throw new Error(
          settings.audioSource === 'system'
            ? '系统声音需要转写服务。MiniMax 没有语音识别接口，请改用麦克风，或填写兼容 Whisper 的转写地址。'
            : '没有识别到内容。请靠近麦克风外放会议声音，并允许麦克风权限。'
        )
      }

      setQuestion(nextQuestion)
      setAnswer('')
      setStatus('answering')
      const full = await window.api.answer(nextQuestion)
      setAnswer(full)
      setStatus('idle')
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setStatus('idle')
      } else {
        setStatus('error')
        setError(err instanceof Error ? err.message : '生成答案失败')
      }
    } finally {
      busyRef.current = false
    }
  }, [settings.audioSource, settings.sttBaseUrl, settings.sttMode])

  const toggleListening = useCallback(() => {
    if (recordingRef.current) {
      void stopAndAnswer()
      return
    }
    if (status === 'transcribing' || status === 'answering') return
    void startListening()
  }, [startListening, status, stopAndAnswer])

  useEffect(() => {
    return window.api.onHotkeyToggle(() => {
      void toggleListening()
    })
  }, [toggleListening])

  async function saveCurrentSettings(): Promise<void> {
    const result = await window.api.saveSettings(settings)
    setSettings(result.settings)
    setHotkeyHint(result.hotkeyOk ? '' : '快捷键注册失败，可能被其他软件占用')
    if (result.settings.apiKey.trim()) setShowSettings(false)
  }

  async function copyAnswer(): Promise<void> {
    if (!answer) return
    await navigator.clipboard.writeText(answer)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  if (!ready) {
    return (
      <div className="shell">
        <div className="titlebar">
          <span>面试助手</span>
        </div>
        <div className="empty">正在加载…</div>
      </div>
    )
  }

  return (
    <div className="shell">
      <header className="titlebar">
        <div className="brand">
          <span className="logo">面</span>
          <div>
            <strong>面试助手</strong>
            <small>MiniMax</small>
          </div>
        </div>
        <div className="window-actions">
          <button type="button" onClick={() => void window.api.minimize()}>
            –
          </button>
          <button type="button" className="close" onClick={() => void window.api.close()}>
            ×
          </button>
        </div>
      </header>

      <div className="status-row">
        <span className={`pill ${recordingRef.current || status === 'recording' ? 'live' : status}`}>
          <i />
          {statusLabel(status, recordingRef.current)}
        </span>
        <span className="timer">
          {status === 'recording' ? formatDuration(elapsed) : hotkeyText}
        </span>
      </div>

      <div className="meter" aria-hidden="true">
        <span style={{ transform: `scaleY(${Math.min(1, 0.12 + level * 8)})` }} />
        <span style={{ transform: `scaleY(${Math.min(1, 0.18 + level * 11)})` }} />
        <span style={{ transform: `scaleY(${Math.min(1, 0.1 + level * 9)})` }} />
        <span style={{ transform: `scaleY(${Math.min(1, 0.2 + level * 13)})` }} />
        <span style={{ transform: `scaleY(${Math.min(1, 0.14 + level * 10)})` }} />
      </div>

      <section className="card">
        <div className="card-head">
          <h2>问题</h2>
        </div>
        <p className={question ? 'body' : 'placeholder'}>
          {question || `按 ${hotkeyText} 开始收声，再按一次停止并生成答案`}
        </p>
      </section>

      <section className="card answer">
        <div className="card-head">
          <h2>答案</h2>
          <button type="button" className="ghost" disabled={!answer} onClick={() => void copyAnswer()}>
            {copied ? '已复制' : '复制'}
          </button>
        </div>
        <pre className={answer ? 'body' : 'placeholder'}>
          {answer || '识别到问题后，MiniMax 会在这里流式显示回答'}
        </pre>
      </section>

      {error ? <div className="error">{error}</div> : null}

      <footer className="footer">
        <button type="button" className="primary" onClick={() => void toggleListening()}>
          {status === 'recording' ? '停止并作答' : '开始收声'}
        </button>
        <button type="button" className="ghost" onClick={() => setShowSettings(true)}>
          设置
        </button>
      </footer>

      {showSettings ? (
        <div className="settings">
          <div className="settings-head">
            <h2>设置</h2>
            <button type="button" className="ghost" onClick={() => setShowSettings(false)}>
              关闭
            </button>
          </div>
          <label>
            MiniMax API Key
            <input
              type="password"
              value={settings.apiKey}
              placeholder="sk-..."
              onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })}
            />
          </label>
          <p className="hint">
            在{' '}
            <a href="https://platform.minimaxi.com/user-center/payment/token-plan" target="_blank" rel="noreferrer">
              MiniMax 开放平台
            </a>{' '}
            创建 Key。国内和国际 Key 不通用。
          </p>
          <label>
            区域
            <select
              value={settings.region}
              onChange={(event) =>
                setSettings({ ...settings, region: event.target.value as AppSettings['region'] })
              }
            >
              <option value="china">国内 api.minimaxi.com</option>
              <option value="global">国际 api.minimax.io</option>
            </select>
          </label>
          <label>
            答题模型
            <select
              value={settings.model}
              onChange={(event) => setSettings({ ...settings, model: event.target.value })}
            >
              {MODEL_OPTIONS.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          <label>
            收声来源
            <select
              value={settings.audioSource}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  audioSource: event.target.value as AppSettings['audioSource']
                })
              }
            >
              <option value="microphone">麦克风（外放会议可用）</option>
              <option value="system">系统声音（耳机开会推荐）</option>
            </select>
          </label>
          <label>
            语音识别
            <select
              value={settings.sttMode}
              onChange={(event) =>
                setSettings({ ...settings, sttMode: event.target.value as AppSettings['sttMode'] })
              }
            >
              <option value="auto">自动（麦克风实时识别，失败再转写）</option>
              <option value="speech-api">仅浏览器语音识别</option>
              <option value="whisper">音频转写接口</option>
            </select>
          </label>
          <label>
            转写 Base URL（可选）
            <input
              value={settings.sttBaseUrl}
              placeholder="MiniMax 无此接口；可选填兼容 Whisper 的地址"
              onChange={(event) => setSettings({ ...settings, sttBaseUrl: event.target.value })}
            />
          </label>
          <label>
            转写模型
            <input
              value={settings.sttModel}
              onChange={(event) => setSettings({ ...settings, sttModel: event.target.value })}
            />
          </label>
          <label>
            全局快捷键
            <select
              value={settings.hotkey}
              onChange={(event) => setSettings({ ...settings, hotkey: event.target.value })}
            >
              {HOTKEY_OPTIONS.map((hotkey) => (
                <option key={hotkey} value={hotkey}>
                  {formatHotkey(hotkey)}
                </option>
              ))}
            </select>
          </label>
          {hotkeyHint ? <p className="hint warn">{hotkeyHint}</p> : null}
          <p className="hint">
            答题使用 MiniMax。语音识别默认走麦克风实时转写；MiniMax 没有官方语音识别接口。
          </p>
          <button type="button" className="primary" onClick={() => void saveCurrentSettings()}>
            保存
          </button>
        </div>
      ) : null}
    </div>
  )
}
