# Interview_Assistant

面试时按全局快捷键收声，把面试官的问题转成文字，再由 **MiniMax** 生成可扫读的答案并显示在置顶窗口里。

## 基本能力

- 全局快捷键开始 / 停止收声（默认 `Ctrl + Shift + Space`）
- 支持麦克风，或捕获系统声音（耳机开视频会议时用）
- MiniMax 流式返回答案，窗口始终置顶

## 准备

1. 安装 [Node.js 20+](https://nodejs.org/)
2. 在 [MiniMax 开放平台](https://platform.minimaxi.com/user-center/payment/token-plan) 创建 API Key  
   - 国内：`https://api.minimaxi.com/v1`  
   - 国际：`https://api.minimax.io/v1`（Key 与区域必须配套）

## 启动

```bash
npm install
npm run dev
```

首次打开会进入设置页，填入 API Key 后保存即可。

打包：

```bash
npm run dist
```

## 使用

1. 把窗口拖到不会挡住自己摄像头的位置
2. 面试官开始提问时按快捷键，状态变为「正在收声」
3. 问题说完再按一次，助手会识别问题并流式显示答案
4. 也可以点窗口里的「开始收声 / 停止并作答」

## 语音识别说明

MiniMax 没有公开的语音识别接口，所以转写不走 MiniMax。

- 默认使用本地中文模型（Vosk，约 40MB，首次启动自动下载，之后离线可用）
- 若自动下载失败（国内常见），从 [Vosk 模型页](https://alphacephei.com/vosk/models) 下载 `vosk-model-small-cn-0.22.zip`，再在应用里点「选择本地 zip」
- 麦克风和系统声音都会把录到的音频送给这个本地模型
- 浏览器自带语音识别在 Electron / 国内网络下经常不可用，因此不再作为默认方案
- 也可以在设置里填写兼容 Whisper 的转写地址作为备选

## 快捷键

可在设置中切换：`Ctrl + Shift + Space`、`Ctrl + Shift + Q`、`Alt + Space`、`F8`、`F9`
