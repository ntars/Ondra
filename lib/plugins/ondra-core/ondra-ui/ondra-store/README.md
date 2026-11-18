# ondra-store · 存储（合并版）

旧版 store-json / store-sqlite / snapshot / data-migrate / path-layout 五个包，新版一个：
**一份状态只能有一个写入者**。

## 对外

`ctx.store`：`write(key, value)` / `read(key, fallback)` / `snapshot(key, keep)`。

## 三条规矩

1. **原子写**：写 `.tmp` 再改名。防的不是写失败，是「写了一半断电」。
2. **坏文件不致命**：`read` 解析失败回落默认值，一个坏键不该让应用起不来。
3. **键名受限**：只允许 `[a-z0-9._-]`，避免路径穿越。

## 不做

不做 SQLite：当前数据量（几千条记忆、几百个会话）JSON 足够；真到瓶颈再加，
但不预留两套后端——两套就是两个真源。
