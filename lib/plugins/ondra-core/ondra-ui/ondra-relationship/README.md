# ondra-relationship · 关系与主动（合并版）

旧版 first-meet / identity / worldbook / proactive-{gate,quota,reason} / rhythm 多个包，
新版一个：主动说话的额度取决于关系阶段，分开算就会出现「刚认识却天天找你」。

## 对外

`ctx.relationship`：`touch()` / `stage()` / `mayProactive()` / `silence()`。

## 三道闸

阶段（stranger 不主动）→ 冷却（默认 180 分钟）→ 单日额度（默认 1，上限 3）。
全过才允许；开口说什么不在这里决定。

## 不做

不写文案、不发消息、不做「她喜欢你」这类数值展示——信任只是排序与闸门的输入。
