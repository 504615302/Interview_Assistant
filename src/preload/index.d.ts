import type { InterviewApi } from './index'

declare global {
  interface Window {
    api: InterviewApi
  }
}

export {}
