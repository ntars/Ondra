# ondra-channel · 通道接口（合并版）

把空谷接到 QQ / 飞书 / 邮件。**一条通道一种适配，投递策略只有一套**——
否则同一个群里，不同通道会各有一套礼让规则。

## 对外

`ctx.channel`：`register(adapter)` / `accept(msg)` / `next()` / `reply(msg, text)`。

## 入站规则

群聊（未开启群聊则拒收）→ 忙时策略（queue / steer / drop）→ 队列上限（超了丢最旧）。

## 适配器契约

`{ id, send(chatId, text) }`。QQ 机器人只是其中一个实现：AppID / 密钥走
`ondra-settings` 的通道接口页，沙箱开关也由那里给。
