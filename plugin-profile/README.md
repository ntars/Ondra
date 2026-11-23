# plugin-profile（构建输入快照）

这份目录**不是源码**，是内核插件树的编译产物快照，由
`tool/sync_plugin_profile.mjs` 从本机 dsh profile 生成。

## 它解决什么问题

内核按 `$DSH_HOME/profiles/<name>` 找装配层，而那条目录原本只能靠
「在本机跑一次应用、且 `~/Downloads/plugins` 里有插件源码」才存在。这意味
着干净机器（CI runner、同事的电脑）永远产不出可用的包。

有了这份快照，装配退化成纯文件操作：`tool/assemble_runtime.mjs` 直接把
它拷进 `runtime/<平台>-<架构>/profile/`，首次运行时铺到
`$DSH_HOME/profiles/ondra`。

## 里面有什么

| 文件 | 作用 |
|---|---|
| `cordis.yml` | 装配层根（内容是一个空列表，树由 patch 组合而来） |
| `cordis.patch.yml` | 真正的装配描述：哪 77 个插件、什么顺序、什么参数 |
| `package.json` | `dsh.profile.bundles` 是装配起点；`dependencies` 已清空（见文件内注释） |
| `compatibility.json` | 精确版本豁免：让 0.2.2-rc.1 的插件在随包 dsh 0.2.1-rc.3 上装载 |
| `node_modules/@ondra/*` | 77 个插件包，只保留 `package.json` 与 `lib/` |

裁剪掉的：`src/`（TypeScript 源码）、`.map`/`.md`/`.tsbuildinfo`。
运行时只需要编译产物。

## 怎么更新

插件版本变了之后：

```sh
node tool/sync_plugin_profile.mjs            # 从 ~/.ondra/dsh/profiles/ondra 同步
git diff --stat plugin-profile               # 先看变了多少
git diff plugin-profile/cordis.patch.yml     # 装配结构变了没有
```

**不要手动改这里的文件。** 它会被下次同步整体覆盖。要改插件行为，改
`~/Downloads/plugins` 里的源码、重新装进 profile，再同步。

例外（TTS Windows 后端）：本机没有那棵插件源码树时，为了在当前工作区修掉
`cordis-plugin-ondra-tts` 的 Windows 无系统后端问题，直接改了这里编译后的
`lib/*.js` 与 `package.json`（新增 `lib/branches/windows-sapi.js`，并把
`enable` 默认改为 `false`）。下次跑 `sync_plugin_profile.mjs` 之前，必须先把
这几处改动合回插件源码；否则同步会把修复覆盖掉。`runtime/<平台>/profile` 是
由本目录装配出的产物，出包前需重跑 `tool/assemble_runtime.mjs`。

## 为什么不能省

去掉它，四件事同时坏掉：新机器第一次打开就抛
`profile "ondra" does not exist`；CI 无法出带运行时的包；不同机器打出来的
包内容不一致（取决于本机装过什么版本的插件）；插件目录一旦被清理，出包能力
直接消失。
