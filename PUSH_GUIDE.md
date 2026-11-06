# GitHub 推送指引

本文针对空谷 Ondra 仓库的实际状态编写，所有数字均为本机实测值与远端 API 查询结果，不是估算。

---

## 一、开始前的三项事实

动手之前请先读完这一节。本项目的推送有两个特殊之处，按常规做法操作会失败或留下错误结果。

### 1.1 远端不是空仓库，且结构与本地完全不同

远端 `github.com/ntars/Ondra` 当前状态（2026-11-04 最后推送）：

| 项目 | 值 |
| --- | --- |
| 默认分支 | `main` |
| 提交数 | 4 |
| 跟踪文件数 | 15961 |
| 仓库体积 | 21581 KB |

远端根目录是 v1.2.0 的旧结构：

```
.github/        CI 工作流（build-windows.yml）
desktop/        14082 个文件
cordis/         1833 个文件
content/
docs/
```

本地 v2.0.1 的结构是：

```
cordis-host/    1852 个文件
src-tauri/      29 个文件
src/            24 个文件
dsh-sidecar/    11 个文件
tools/          10 个文件
```

两套目录**没有一个顶层目录重合**。这不是增量更新，是整仓换代。如果只做 `git add .` 加普通提交，远端的 `desktop/`、`cordis/`、`content/`、`docs/` 会原样留着，与本地新结构并存，克隆下来的人会看到两代代码混在一起。

### 1.2 本地目录当前不是 git 仓库

```
$ cd /Users/ntars/Github/Ondra && git status
fatal: not a git repository (or any of the parent directories): .git
```

所以不能直接 `git add`。有两种起步方式，见第三节。**推荐从远端克隆**，理由在 3.1 说明。

### 1.3 分支名不一致会静默失败

本机 `git config --global init.defaultBranch` 未设置，`git init` 会建出 `master` 分支。远端默认分支是 `main`。

在演练环境中实测：把 `master` 推到远端后，远端出现了一个独立的 `master` 分支，而 `main` 保持旧内容不变。GitHub Pages、EdgeOne 与仓库首页读的都是 `main`，结果是**推送显示成功、线上仍是旧版**。这个失败没有任何报错。

---

## 二、推送前必须做的三件事

### 2.1 备份

推送是不可逆操作，`--force` 会丢弃远端历史。动手前先备份两份：

```bash
# 备份 1：远端当前状态完整克隆（含全部历史），留存回滚依据
cd ~/Backups 2>/dev/null || mkdir -p ~/Backups && cd ~/Backups
git clone --mirror https://github.com/ntars/Ondra.git Ondra-remote-backup-$(date +%Y%m%d).git

# 备份 2：本地目录打包（排除依赖与构建产物）
cd /Users/ntars/Github
tar -czf ~/Backups/Ondra-local-$(date +%Y%m%d).tar.gz \
  --exclude='Ondra/node_modules' \
  --exclude='Ondra/src-tauri/target' \
  --exclude='Ondra/releases' \
  --exclude='Ondra/dist' \
  --exclude='Ondra/.site-dist' \
  Ondra
```

`--mirror` 克隆包含全部引用（分支、标签），是唯一能把远端恢复到原样的备份方式。普通的 `git clone` 只带默认分支，回滚时会丢东西。

验证备份：

```bash
ls -lh ~/Backups/Ondra-remote-backup-*.git
du -sh ~/Backups/Ondra-remote-backup-*.git
```

### 2.2 配置提交身份

本机 `user.name` 与 `user.email` 均为空，直接提交会报 `Author identity unknown` 并中止。

```bash
# 只对本仓库生效，不动全局配置
cd /Users/ntars/Github/Ondra
git config user.name "Ntarstudio"
git config user.email "你的 GitHub 邮箱"
```

邮箱建议用 GitHub 账号的 noreply 地址（形如 `12345678+username@users.noreply.github.com`），避免真实邮箱进入公开提交历史。

### 2.3 确认忽略规则

`.gitignore` 已覆盖依赖、构建产物、发布产物、字体完整包、运行时组装产物与工具工作目录。实测效果：

| 状态 | 待入库文件数 | 体积 |
| --- | --- | --- |
| 修复前 | 5633 | 约 48 MB |
| 修复后 | 1943 | 21.91 MB |

差额主要来自 `cordis-host/plugins/*/lib/` 下的 3637 个 TypeScript 编译产物（26 MB）。这些文件由 `tsc -b` 从 `src/` 生成，不入库；克隆后需先执行 `pnpm run build` 才能得到 `lib/`，因为各包 `package.json` 的 `main` 指向 `lib/index.js`。

验证方法：

```bash
cd /Users/ntars/Github/Ondra
git add -A --dry-run | wc -l          # 应输出 1943 左右
git add -A --dry-run | grep -c '/lib/' # 应只匹配 src/lib/ 下 4 个源码文件
```

如果 `/lib/` 匹配数远超 4，说明忽略规则没生效，检查目录是否被其他 `.gitignore` 覆盖：

```bash
git check-ignore -v cordis-host/plugins/ondra-persona-core/lib/index.js
```

---

## 三、推送流程

### 3.1 推荐路径：从远端克隆后整体刷新

这个路径保留远端 4 个提交的历史，同时把工作区完全替换为 v2.0.1 内容。历史可追溯，回滚也容易。

```bash
# 步骤 1：克隆远端到临时目录（不要直接克隆到 Ondra，本地已有内容）
cd /tmp
rm -rf Ondra-push
git clone https://github.com/ntars/Ondra.git Ondra-push
cd Ondra-push

# 步骤 2：删除工作区全部文件，保留 .git 目录
# 说明：find 的 -mindepth 1 -maxdepth 1 限定只看顶层，! -name '.git' 排除版本库
find . -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +

# 步骤 3：把本地 v2.0.1 内容铺进去
# 说明：--exclude 与 .gitignore 保持一致，避免把依赖与产物带进暂存区；
#       源路径结尾的 / 很重要，表示复制目录内容而不是目录本身
rsync -a \
  --exclude='node_modules' \
  --exclude='.pnpm-store' \
  --exclude='dist' \
  --exclude='target' \
  --exclude='releases' \
  --exclude='.site-dist' \
  --exclude='src-tauri/target' \
  --exclude='src-tauri/gen' \
  --exclude='src-tauri/runtime' \
  --exclude='src/assets/fonts/official' \
  --exclude='.ondra' \
  --exclude='.workbuddy' \
  --exclude='*.tsbuildinfo' \
  --exclude='.DS_Store' \
  --exclude='._*' \
  /Users/ntars/Github/Ondra/ ./

# 步骤 4：核对暂存内容
git add -A
git status --short | head -30
git status --short | wc -l     # 应在 1943 上下

# 步骤 5：确认旧目录已被标记为删除
git status --short | grep '^D' | head -10
```

第 5 步的输出必须包含大量 `D` 开头的行（`desktop/`、`cordis/`、`content/`、`docs/` 下的文件）。如果一条 `D` 都没有，说明第 2 步的删除没生效，此时提交会把两代代码混在一起。

```bash
# 步骤 6：提交
git commit -m "feat: 整体更新至 v2.0.1

- 目录结构重排：cordis-host / dsh-sidecar / src / src-tauri
- README 与 README_EN 重写，逐插件说明 137 个包的功能与配置项
- NOTICE 重写，逐条披露 529 个第三方组件
- 移除 v1.2.0 的 desktop / cordis / content / docs 四套旧目录"

# 步骤 7：推送，显式指定远端分支为 main
# 说明：本地克隆自 main，HEAD 已在 main 上，HEAD:main 是明确写法，
#       避免因分支名不一致推到别处
git push origin HEAD:main
```

### 3.2 备选路径：本地初始化后强推

适用于不需要保留远端历史、且确认远端内容已备份的情况。

```bash
cd /Users/ntars/Github/Ondra

# 步骤 1：初始化，显式指定分支名为 main
# 说明：-b main 绕开本机默认的 master，这是 1.3 所述失败的直接预防
git init -b main

# 步骤 2：配置身份
git config user.name "Ntarstudio"
git config user.email "你的 GitHub 邮箱"

# 步骤 3：关联远端
git remote add origin https://github.com/ntars/Ondra.git

# 步骤 4：暂存并核对
git add -A
git status --short | wc -l

# 步骤 5：提交
git commit -m "feat: 空谷 Ondra v2.0.1"

# 步骤 6：强推
# 风险：--force 会丢弃远端 4 个提交。仓库公开但无协作者，
#       且已完成 2.1 的 --mirror 备份，方可执行。
git push --force origin main
```

`--force` 与 `--force-with-lease` 的选择：后者在远端有他人新提交时拒绝覆盖，更安全。单人仓库两者效果相同，建议优先用：

```bash
git push --force-with-lease origin main
```

---

## 四、推送后的一致性核对

推送命令返回成功后，仍需确认远端与本地一致。以下检查全部通过，才算完成。

### 4.1 远端文件树与本地清单比对

```bash
# 取远端文件清单
git ls-tree -r --name-only origin/main | sort > /tmp/remote-files.txt

# 取本地暂存清单
git ls-files | sort > /tmp/local-files.txt

# 比对
diff /tmp/local-files.txt /tmp/remote-files.txt && echo "完全一致"
```

### 4.2 关键目录确认已消失

```bash
# 旧结构不应再出现在远端
for d in desktop cordis content docs; do
  n=$(git ls-tree -r --name-only origin/main | grep -c "^$d/")
  echo "$d: $n 个文件"
done
```

四个数字必须全部为 `0`。

### 4.3 三份文档已在远端

```bash
git ls-tree -r --name-only origin/main | grep -E '^(README\.md|README_EN\.md|NOTICE|LICENSE)$'
```

应输出四行。

### 4.4 通过 GitHub API 独立验证

不依赖本地 git 状态，直接查远端：

```bash
# 根目录内容
curl -s https://api.github.com/repos/ntars/Ondra/contents/ \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      JSON.parse(s).forEach(f=>console.log(f.type[0], f.name))})'

# 仓库当前状态
curl -s https://api.github.com/repos/ntars/Ondra \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const j=JSON.parse(s);
      console.log("默认分支:", j.default_branch);
      console.log("体积(KB):", j.size);
      console.log("最后推送:", j.pushed_at)})'
```

`pushed_at` 应为刚推送的时间，`size` 应在 22000 KB 上下（v2.0.1 入库 21.91 MB，加 git 对象开销）。

### 4.5 浏览器最终确认

打开 `https://github.com/ntars/Ondra`，确认：

1. 根目录只列出 `cordis-host`、`dsh-sidecar`、`src`、`src-tauri`、`tools`、`assets` 与若干根文件。
2. 没有 `desktop`、`cordis`、`content`、`docs` 四个目录。
3. README 渲染后首屏显示"空谷 Ondra"与语言切换链接。
4. 提交历史中能看到本次提交。

---

## 五、失败处理

按错误信息对照下表。每条都给出可直接执行的命令。

### 5.1 认证失败

**现象**

```
remote: Support for password authentication was removed on August 13, 2021.
fatal: Authentication failed for 'https://github.com/ntars/Ondra.git/'
```

或

```
git@github.com: Permission denied (publickey).
```

**原因**：GitHub 不接受账号密码；HTTPS 需 Personal Access Token，SSH 需正确配置密钥。

**本机现状**：SSH 认证已可用。实测 `ssh -T git@github.com` 返回：

```
Hi ntars! You've successfully authenticated, but GitHub does not provide shell access.
```

说明 `~/.ssh/id_ed25519` 已登记在 GitHub 账号下。**优先用 SSH 地址**：

```bash
cd /Users/ntars/Github/Ondra
git remote set-url origin git@github.com:ntars/Ondra.git
git remote -v          # 确认已改为 SSH
git push origin HEAD:main
```

若必须用 HTTPS，改用 GitHub CLI 登录（本机已安装 `gh`，但未登录）：

```bash
gh auth login
# 依次选择：GitHub.com → SSH 或 HTTPS → 浏览器授权
gh auth status
```

`gh auth login` 完成后会写入凭证助手，之后 HTTPS 推送免输密码。

### 5.2 网络超时或连接重置

**现象**

```
fatal: unable to access 'https://github.com/ntars/Ondra.git/':
Failed to connect to github.com port 443: Operation timed out
```

或推送中途卡在 `Writing objects` 后断开。

**处理顺序**：

```bash
# 1. 先确认网络可达
curl -sI https://github.com | head -1

# 2. 提高 HTTP 缓冲区（大仓库常见），并放宽低速断线判定
git config --global http.postBuffer 524288000
git config --global http.lowSpeedLimit 0
git config --global http.lowSpeedTime 999999

# 3. 走 SSH（22 端口），绕开 HTTPS 的代理问题
git remote set-url origin git@github.com:ntars/Ondra.git

# 4. 若 22 端口被封，改用 GitHub 的 443 端口 SSH
#    在 ~/.ssh/config 中写入：
#    Host github.com
#      HostName ssh.github.com
#      Port 443
#      User git
ssh -T -p 443 git@ssh.github.com

# 5. 已有代理时显式指定（端口按实际代理改）
git config --global http.proxy http://127.0.0.1:7890
git config --global https.proxy http://127.0.0.1:7890

# 用完记得清除，否则换网络后反而连不上
git config --global --unset http.proxy
git config --global --unset https.proxy
```

本次入库 1943 个文件、21.91 MB，不是大仓库，正常网络下推送耗时应在十几秒内。若反复超时，多半是本机到 GitHub 的链路问题，而非仓库体积。

### 5.3 文件超过大小限制

**现象**

```
remote: error: File xxx is 123.45 MB; this exceeds GitHub's file size limit of 100.00 MB
```

或

```
remote: warning: See https://gh.io/lfs
remote: error: GH001: Large files detected.
```

**本项目实测结果**：入库文件最大的是 `src/assets/fonts/MiSansVF.woff2`，8.35 MB，远低于 100 MB 上限。**按现有忽略规则不会触发这个问题**。

若因改动忽略规则而触发，先定位：

```bash
# 列出暂存区中超过 50 MB 的文件
# 说明：用 while read 逐行处理，不用 xargs -I。
#       本项目有 1944 个入库文件，xargs 拼参数时命令行会超出系统长度上限，
#       报 "command line cannot be assembled, too long"。
git ls-files | while IFS= read -r f; do
  [ -f "$f" ] || continue
  s=$(stat -f '%z' "$f" 2>/dev/null)
  [ "$s" -gt 52428800 ] && awk -v s="$s" -v f="$f" 'BEGIN{printf "%.2f MB  %s\n", s/1048576, f}'
done
```

处理方式，按推荐顺序：

```bash
# 方式一（推荐）：补上忽略规则，从暂存区移除。适用于构建产物、字体完整包等
echo 'src/assets/fonts/official/' >> .gitignore
git rm -r --cached src/assets/fonts/official
git commit --amend --no-edit

# 方式二：文件确需入库，改用 Git LFS（本机未安装）
brew install git-lfs
git lfs install
git lfs track "*.woff2"
git add .gitattributes
git add -A
git commit -m "chore: 用 LFS 管理字体文件"
```

**注意**：文件一旦进入提交历史，只在后续提交中删除是不够的，历史里仍有该对象，推送照样被拒。必须用 `git filter-repo` 重写历史，或回退到未包含该文件的提交。这是 `--amend` 与 `git reset` 要在**推送前**使用的原因。

### 5.4 文件名大小写冲突

**现象**

```
error: The following untracked working tree files would be overwritten by checkout
```

或 macOS 上 `git status` 显示某文件既被删除又被新增。

**原因**：macOS 文件系统默认不区分大小写，`README.md` 与 `readme.md` 视为同一文件；Git 区分大小写，视为两个不同文件。在 macOS 上改文件名大小写，Git 可能认为什么都没变。

**本项目实测结果**：入库范围内**不存在**大小写冲突。检测命令与结果：

```bash
git ls-files | tr 'A-Z' 'a-z' | sort | uniq -d
# 无输出，即无冲突
```

后续若遇到，用 `git mv` 强制两步改名：

```bash
git mv README.md README-tmp.md
git mv README-tmp.md Readme.md
git commit -m "fix: 修正文件名大小写"
```

同时建议把仓库与本地都设为保留大小写：

```bash
git config core.ignorecase false
```

### 5.5 远端历史冲突

**现象**

```
! [rejected]        main -> main (fetch first)
error: failed to push some refs to 'https://github.com/ntars/Ondra.git'
hint: Updates were rejected because the remote contains work that you do
hint: not have locally.
```

**原因**：远端有本地没有的提交。若刚推送过又立刻重推，通常是上一次推送部分成功后本地状态未同步。

**处理，按风险从低到高**：

```bash
# 方案一：先拉取再推送，保留双方提交（最安全）
git pull --rebase origin main
git push origin HEAD:main

# 方案二：确认远端内容可丢弃时强推，用 --force-with-lease 防误伤
# 说明：--force-with-lease 会在远端存在本地未知的新提交时拒绝执行，
#       比 --force 安全，单人仓库也建议用它
git fetch origin
git push --force-with-lease origin main

# 方案三：远端有混乱提交需要彻底重置（最后手段）
# 风险：远端全部历史被替换。执行前必须有 2.1 的 --mirror 备份。
git push --force origin main
```

回滚到备份：

```bash
cd ~/Backups
git clone --mirror Ondra-remote-backup-YYYYMMDD.git Ondra-restore.git
cd Ondra-restore.git
git push --mirror https://github.com/ntars/Ondra.git
```

### 5.6 其他问题

**`git add` 报 `index.lock` 已存在**

上次 git 进程被中断留下锁文件。确认没有 git 进程在跑之后删除：

```bash
ps aux | grep '[g]it'          # 确认无残留进程
rm -f /Users/ntars/Github/Ondra/.git/index.lock
```

**提交后发现有文件漏了或多了**

推送前都可以改：

```bash
# 漏了文件
git add 遗漏的文件
git commit --amend --no-edit

# 多了文件
git rm --cached 多余的文件
git commit --amend --no-edit
```

**推送成功但网页仍是旧内容**

依次排查：

1. 确认推到了 `main` 而非 `master`：

   ```bash
   git ls-remote --heads origin
   ```

   输出应只有一行 `refs/heads/main`。出现 `refs/heads/master` 说明推错了分支。

2. 清掉多余的 `master`：

   ```bash
   git push origin --delete master
   ```

3. 确认 GitHub 默认分支设置指向 `main`：

   ```bash
   curl -s https://api.github.com/repos/ntars/Ondra | grep default_branch
   ```

4. 浏览器强制刷新（`Cmd+Shift+R`），或访问无痕窗口。GitHub 的 README 渲染有 CDN 缓存，通常几十秒内刷新。

**`.github/workflows/build-windows.yml` 会被删除，Windows 自动构建随之中断**

远端现有的 CI 工作流按 v1.2.0 的目录路径编写，引用了本地已不存在的目录：

```
cache-dependency-path: desktop/pnpm-lock.yaml
working-directory: desktop/apps/desktop
working-directory: desktop
```

`desktop/` 在 v2.0.1 中不存在，保留该工作流会导致每次触发都以"路径不存在"失败。因此本次推送会把它一并删除。

若仍需 Windows 自动构建，需按新结构重写后重新加入。新结构下的关键路径是 `src-tauri/`（Rust 壳）与 `pnpm-lock.yaml`（仓库根）。重写前建议先确认 CI 的必要性，避免提交一个从未跑通的工作流。

---

## 六、推送前检查清单

逐项打勾，全部确认后再执行推送命令。

- [ ] 已完成 `--mirror` 备份，且备份文件大小正常
- [ ] 已设置本仓库的 `user.name` 与 `user.email`
- [ ] `git add -A --dry-run | wc -l` 输出在 1943 上下
- [ ] `git add -A --dry-run | grep -c '/lib/'` 输出为 4（仅 `src/lib/` 源码）
- [ ] `git status --short | grep '^D'` 有大量删除记录（旧结构被清理）
- [ ] 已确认远端地址使用 SSH（`git remote -v`）
- [ ] 已确认本地分支为 `main`（`git branch --show-current`）
- [ ] 已接受 `.github/workflows/build-windows.yml` 将被删除，或已按新结构重写好
- [ ] 三份文档在暂存区：`README.md`、`README_EN.md`、`NOTICE`

---

## 七、命令速查

按推荐路径（3.1）的完整命令序列，可整段复制执行。

```bash
set -e

# ---- 备份 ----
mkdir -p ~/Backups
cd ~/Backups
git clone --mirror https://github.com/ntars/Ondra.git Ondra-remote-backup-$(date +%Y%m%d).git

# ---- 准备推送目录 ----
cd /tmp
rm -rf Ondra-push
git clone https://github.com/ntars/Ondra.git Ondra-push
cd Ondra-push
git config user.name "Ntarstudio"
git config user.email "你的 GitHub 邮箱"

# ---- 清空工作区，保留 .git ----
find . -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +

# ---- 铺入本地 v2.0.1 内容 ----
rsync -a \
  --exclude='node_modules' --exclude='.pnpm-store' \
  --exclude='dist' --exclude='target' --exclude='releases' --exclude='.site-dist' \
  --exclude='src-tauri/target' --exclude='src-tauri/gen' --exclude='src-tauri/runtime' \
  --exclude='src/assets/fonts/official' --exclude='.ondra' --exclude='.workbuddy' \
  --exclude='*.tsbuildinfo' --exclude='.DS_Store' --exclude='._*' \
  /Users/ntars/Github/Ondra/ ./

# ---- 暂存与核对 ----
git add -A
git status --short | wc -l
git status --short | grep '^D' | head -10

# ---- 提交与推送 ----
git commit -m "feat: 整体更新至 v2.0.1"
git push origin HEAD:main

# ---- 验证 ----
git ls-tree -r --name-only origin/main | sort > /tmp/remote-files.txt
git ls-files | sort > /tmp/local-files.txt
diff /tmp/local-files.txt /tmp/remote-files.txt && echo "远端与本地完全一致"
```

执行完毕后按第四节逐项验收。
