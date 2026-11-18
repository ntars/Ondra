# ondra-voice · 语音（合并版）

旧版 asr / tts / tts-gate / oral 四个包，新版一个：听与说是一条链路。

## 对外

`ctx.voice`：`plan(answer)` / `startListening()` / `stopListening()` / `heard(text, ms)`。

## 两条口径

1. **长回答只念前两段**：念完一整屏没人听，中途打断又很怪。
2. **只出计划不发声**：真正调用 TTS/ASR 是平台能力，交给 `ondra-flutter`。

## 音色与语速

来自 `ondra-settings` 的「语音与音色」页；本插件只消费，不持有配置界面。
