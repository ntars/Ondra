# Windows x64 安装包构建指令

本文档说明如何从源码构建「空谷 Ondra」的 Windows x64 安装包（`ondra-<版本>-win-x64-unsigned.exe`）。全文适用于 Windows 10/11 x64 构建主机，也可作为云端构建（GitHub Actions）的步骤依据。

---

## 一、构建产物的定义

| 项目 | 说明 |
| --- | --- |
| 产物文件名 | `ondra-<版本>-win-x64-unsigned.exe`，其中 `<版本>` 取自 `desktop/apps/desktop/package.json` 的 `version` 字段 |
| 产物类型 | NSIS 安装程序（单文件 exe），非绿色版 |
| 签名状态 | 未签名（unsigned）。Windows SmartScreen 会提示「未知发布者」，属预期行为 |
| 默认安装路径 | `<系统盘>:\Ondra`，例如系统盘为 C 盘时为 `C:\Ondra` |
| 安装路径可改性 | 可在安装向导首页修改盘符与目录：路径输入框可直接编辑，也可点击「浏览」按钮选择任意盘符下的目录 |
| 安装范围 | 当前用户（per-user），不需要管理员权限，不写入 `Program Files` |

安装路径的实现位置为 `desktop/apps/desktop/scripts/installer.nsh`：脚本以 `$WINDIR` 前两位取出系统盘符，拼成 `<系统盘>:\Ondra` 作为初始值，再交由安装向导首页的路径输入框覆盖。

---

## 二、构建主机要求

### 2.1 硬性限制

Windows x64 安装包**只能在 Windows x64 主机上构建**。此限制由 `desktop/apps/desktop/scripts/package-target.ts` 的 `resolveDesktopPackageTarget` 强制校验，在 macOS 或 Linux 上执行会直接报错：

```
desktop package: win-x64 requires a Windows x64 build host
```

### 2.2 软件依赖

| 软件 | 版本要求 | 用途 | 校验方式 |
| --- | --- | --- | --- |
| Windows | 10 或 11，x64 | 构建主机与最终运行环境 | `winver` |
| Node.js | 24.9.0 或更高 | 运行构建脚本与打包脚本 | `node -v` |
| pnpm | 11.28.5 | 工作区依赖安装与脚本调度 | `pnpm -v` |
| Git | 任意较新版本 | 提供提交号，供产物记录构建来源 | `git --version` |
| Visual Studio C++ 生成工具 | 含 MSVC x86/x64 编译器与 Windows SDK | 编译安装器的原生辅助库 `window-frame.dll` | `vswhere -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64` |
| tar | Windows 10 1803 及以上自带 | 解包 Electron 与运行时归档 | `tar --version` |

Visual Studio 生成工具的安装方式见官方文档：安装时勾选「使用 C++ 的桌面开发」工作负载，并确认「Windows 10 SDK」已被选中。缺少该组件时，打包会在 `prepare-windows-installer.ps1` 处失败，错误信息为：

```
Windows installer preparation requires Visual Studio C++ Build Tools and a Windows SDK.
```

### 2.3 磁盘与耗时

| 项目 | 参考值 |
| --- | --- |
| 源码与依赖占用 | 约 12 GB（含 `node_modules`） |
| 构建缓存占用 | 约 4 GB（`.desktop-build` 与下载缓存） |
| 安装依赖耗时 | 5 至 15 分钟（取决于网络） |
| 全量构建与打包耗时 | 20 至 40 分钟（首次下载 Electron 与运行时归档偏慢） |

---

## 三、获取源码

```powershell
git clone https://github.com/ntars/Ondra.git
cd Ondra
```

仓库根目录下的 `desktop/` 才是 pnpm 工作区根目录，后续所有 pnpm 命令必须在 `desktop/` 内执行。

> `toolchain/`、`build/`、`.desktop-build/`、`node_modules/` 均被 `.gitignore` 排除。源码中不包含这些目录，构建过程会自动重建。

---

## 四、配置打包环境文件

打包脚本会读取 `desktop/apps/desktop/.env.windows`。该文件不入库，必须由构建者本地创建。

### 4.1 创建文件

```powershell
cd desktop\apps\desktop
Copy-Item .env.windows.example .env.windows
```

### 4.2 未签名构建的最小配置

打开 `.env.windows`，至少填写以下三项。其余键保持示例文件中的注释状态即可。

```dotenv
ONDRA_DESKTOP_APP_ID=com.ntars.ondra
ONDRA_DESKTOP_AUTO_UPDATE_ENV=test

# 必填：强制更新策略的服务来源，未签名构建同样必填
ONDRA_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN=https://ai.ntars.cn
ONDRA_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN=https://ai.ntars.cn
```

未签名构建无需填写 `ONDRA_DESKTOP_WINDOWS_CER_FILE`、`ONDRA_DESKTOP_WINDOWS_SIGNTOOL`、`ONDRA_DESKTOP_WINDOWS_KEY_CONTAINER`、`ONDRA_DESKTOP_WINDOWS_TOKEN_PIN` 这四项签名凭据；填写了也不会被读取。

### 4.3 可选优化项

| 键 | 说明 |
| --- | --- |
| `ONDRA_DESKTOP_NPM_REGISTRY` | 指定运行时安装所用的 npm 镜像，例如 `https://registry.npmmirror.com`，可显著缩短安装依赖耗时 |
| `ONDRA_DESKTOP_WINDOWS_COMPRESSION_LEVEL` | 安装器压缩等级，取值 `3` 或 `7`。`3` 更快、体积略大；`7` 更小、耗时更长 |
| `ONDRA_DESKTOP_WINDOWS_PACK_CONCURRENCY` | 并行打包并发数。内存不足时调低 |

---

## 五、构建步骤

在仓库根目录下依次执行：

```powershell
cd desktop

# 1. 安装工作区依赖（严格按锁文件安装，不得省略 --frozen-lockfile）
pnpm install --frozen-lockfile

# 2. 编译全部包与前端资源，并执行内置质量门禁
pnpm run build

# 3. 打包 Windows x64 未签名安装程序
pnpm run package:desktop:win:x64:unsigned
```

第 2 步的 `build` 脚本会执行类型检查、产物构建与测试门禁。任一环节失败都会中断构建，此时不要跳过第 2 步直接执行第 3 步，否则会打包出缺少前端资源或类型不一致的产物。

### 5.1 可选的构建来源标记

若源码目录不带 `.git`（例如通过压缩包获取），打包脚本无法读取提交号。可显式提供：

```powershell
$env:ONDRA_CLIENT_COMMIT_HASH = "<40 位提交哈希或任意构建标识>"
pnpm run package:desktop:win:x64:unsigned
```

---

## 六、产物位置

构建成功后，产物位于：

```
desktop\apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts\ondra-<版本>-win-x64-unsigned.exe
```

目录结构说明：

| 目录 | 内容 |
| --- | --- |
| `unsigned-artifacts\` | 最终交付的未签名安装程序（本文档的目标产物） |
| `artifacts\` | 已签名版本，未签名构建不会写入 |
| `runtime\` | 打包用的 Electron 与 ondra 运行时展开目录 |
| `electron\` | 下载解包后的 Electron 二进制 |
| `packed\` | 归档中间产物 |

复制该 exe 到任意位置即可分发，安装程序自身不依赖构建目录。

---

## 七、构建过程的关键机制

理解以下机制有助于定位构建失败。

1. **安装器原生辅助库**：安装向导的窗口边框、进度页、解压失败报告等界面由 `desktop/apps/desktop/installer/window-frame.cpp` 编译成的 **32 位** `window-frame.dll` 提供。该库在打包前由 `scripts/prepare-windows-installer.ps1` 调用 MSVC 编译，输出到 `.desktop-build\targets\win-x64\installer-ui\`。缺少 MSVC 或 Windows SDK 时，此步失败。
2. **安装器界面资源**：同一步骤还会把品牌图片转换为 BMP，并生成 `strings.nsh` 多语言字符串。这些文件与 DLL 一起被 NSIS 脚本引用，因此不可手工删除。
3. **Electron 与运行时下载**：打包脚本按目标平台下载对应版本的 Electron 与 ondra 运行时归档，缓存在 `.desktop-build\downloads\`。断网或代理异常会导致此步超时。
4. **平台校验**：除主机校验外，`pnpm run build` 也会校验产物是否与目标架构匹配，任何跨平台取巧都会在打包阶段被拒绝。

---

## 八、常见失败与处理

| 现象 | 原因 | 处理方式 |
| --- | --- | --- |
| `win-x64 requires a Windows x64 build host` | 在非 Windows x64 主机上执行 | 换到 Windows 10/11 x64 主机 |
| `Windows installer preparation requires Visual Studio C++ Build Tools and a Windows SDK.` | 缺少 MSVC 或 Windows SDK | 安装 Visual Studio 生成工具，勾选「使用 C++ 的桌面开发」与 Windows SDK |
| `cannot read ...apps\desktop\.env.windows` | 未创建环境文件 | 按第四节复制并填写 `.env.windows` |
| `EINVAL` 或路径过长错误 | Windows 默认路径长度限制 | 将仓库克隆到较短的路径，例如 `C:\src\Ondra`；或启用长路径支持 |
| `Corepack is about to download ...` 后失败 | corepack 首次拉取 pnpm 失败（多为网络原因） | 用 `npm install -g pnpm@11.28.5` 安装固定版本，再重试 |
| `tar` 相关探测失败 | 系统 tar 版本过旧或被替换 | 使用 Windows 自带的 `C:\Windows\System32\tar.exe`，不要用 GNU tar 覆盖系统 PATH |
| 打包中断于 `pnpm install` | 镜像源不可达 | 在 `.npmrc` 中配置可用镜像后重跑 |
| 安装包运行时提示缺少 `VCRUNTIME140.dll` | 目标机器过旧 | 交付时附 Microsoft Visual C++ 运行库，或改用静态链接构建 |

---

## 九、云端构建

仓库提供 GitHub Actions 工作流 `.github/workflows/build-windows.yml`，在 GitHub 托管的 `windows-latest` 运行器上执行同一组命令，并上传产物为构建工件。

使用方式：

1. 在仓库的 Actions 页面选择 `Build Windows Installer`。
2. 点击 `Run workflow`。
3. 运行结束后在本次运行的 Artifacts 区域下载 `ondra-win-x64-unsigned`。

工作流需要读取 `ONDRA_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN` 与 `ONDRA_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN` 两个仓库变量（Settings → Secrets and variables → Actions → Variables）。未配置时工作流使用 `https://ai.ntars.cn` 作为占位来源。

云端构建的限制：

- 产物为未签名版本，与本地构建一致。
- 运行器不含硬件签名设备，无法产出签名版本。
- 单次运行时长通常为 25 至 45 分钟，其中依赖安装占主要部分。

---

## 十、交付前检查清单

1. `pnpm run build` 退出码为 0，无跳过的门禁。
2. `unsigned-artifacts` 目录中产物的文件名、版本号与 `desktop/apps/desktop/package.json` 一致。
3. 在干净的 Windows 虚拟机上实际安装一次，确认安装向导首页显示的初始路径为 `<系统盘>:\Ondra`。
4. 在向导首页修改盘符（例如改为 `D:\Ondra`）后继续安装，确认文件落在指定盘符。
5. 启动应用，确认主窗口、模型选择与右栏状态卡片正常显示。
6. 在「设置 → 关于」中确认版本号与构建标识符合预期。
