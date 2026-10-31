# -*- coding: utf-8 -*-
"""生成《空谷 Ondra 插件总清单》：运行中 + 未启用 + 纯库附录。"""
import json, glob, os

# ── 运行中插件：id -> (中文名, 作用, 判定, 删除影响) ──
# 判定：K=不可删  W=慎删  D=可删
LOADED = {
 'agent': ('智能体内核', 'Agent 接口、注册表、事件词汇，对话能力的根', 'K', '应用无法运行'),
 'agent-loop': ('Agent 主循环', '推理-工具-回复循环', 'K', '无法对话'),
 'agent-default-model': ('默认模型选择', '各入口共用默认模型', 'K', '无法确定模型'),
 'agent-preset-registry': ('预设注册表', 'Agent 预设声明与持久化', 'W', '预设功能消失'),
 'agent-instructions': ('项目指令加载', '读 AGENTS.md/CLAUDE.md 注入上下文', 'W', '模型不读项目说明'),
 'llm': ('模型服务接口', '中立 LLM 抽象层', 'K', '无模型调用能力'),
 'llm-deepseek': ('DeepSeek API Key 接入', 'API Key 方式', 'W', '少一种接入方式'),
 'llm-deepseek-account': ('DeepSeek 账号接入', '账号方式', 'W', '少一种接入方式'),
 'llm-pi-ai': ('pi-ai 中转适配器', '第三方中转', 'W', '中转渠道不可用'),
 'llm-retry': ('请求重试', '失败自动重试', 'W', '网络抖动更易失败'),
 'deepseek-llm-api-extensions': ('DeepSeek 请求字段扩展', '附加请求字段注册', 'W', '高级参数失效'),
 'session': ('会话内核', '事件溯源会话存储', 'K', '对话无法保存'),
 'session-projection': ('会话投影', '可扩展状态投影', 'K', '界面读不到状态'),
 'session-projection-cache': ('投影缓存', '落盘缓存加速', 'W', '启动变慢'),
 'session-persistence-jsonl': ('JSONL 持久化', '会话存盘', 'K', '对话不落盘'),
 'session-checkpoint-policy': ('会话检查点', '请求/工具前快照', 'W', '崩溃恢复变差'),
 'session-query-sqlite': ('会话全文检索', 'SQLite FTS5 搜索', 'W', '会话搜索失效'),
 'session-reference': ('跨会话引用', '跨会话快照引用', 'W', '@会话 失效'),
 'session-stats': ('会话统计', '轮数/耗时统计', 'D', '统计数字消失'),
 'session-title': ('会话标题服务', '标题生成注册表', 'W', '无自动标题'),
 'session-title-llm': ('标题 LLM 生成', '首条消息生成标题', 'D', '标题退化为首句'),
 'session-turn-outline': ('轮次大纲', '整段对话大纲投影', 'W', '大纲功能消失'),
 'session-log-deepseek': ('会话日志上传', '增量上传日志到官方', 'D', '不再上传，隐私更好'),
 'session-log-download': ('会话导出', 'ZIP/Markdown 导出', 'D', '导出按钮消失'),
 'session-telemetry-otel': ('会话遥测', '会话日志 OTel 上报', 'D', '不再外发，建议删'),
 'settings': ('设置内核', '用户设置抽象层', 'K', '设置页失效'),
 'storage': ('存储中枢', '命名后端注册', 'K', '数据无法读写'),
 'storage-domain': ('域数据', '带 schema 校验的数据形态', 'K', '业务数据层失效'),
 'storage-json': ('JSON 存储后端', 'JSON 文件 KV', 'K', '默认存储不可用'),
 'tools': ('工具注册表', '工具注册与执行管线', 'K', '模型不能调用工具'),
 'tool-bash': ('bash 工具', '执行 shell 命令', 'W', '模型不能跑命令'),
 'tool-pwsh': ('PowerShell 工具', 'Windows 命令执行', 'D', 'macOS 上本就禁用'),
 'tool-fs': ('文件读写工具', 'read/write/edit', 'W', '模型不能读写文件'),
 'tool-fs-search': ('文件搜索工具', 'glob/grep', 'W', '模型不能搜文件'),
 'tool-web': ('联网工具', 'web_search/web_fetch', 'W', '模型不能上网'),
 'tool-jobs': ('后台任务工具', 'job_output/list/kill', 'W', '不能管后台任务'),
 'tool-schedule': ('定时任务工具', '创建与管理提醒', 'W', '定时功能消失'),
 'tool-goal': ('目标工具', '同会话目标管理', 'D', '目标功能消失'),
 'tool-todo': ('待办工具', 'todo_write', 'D', '待办清单消失'),
 'tool-skill': ('技能加载工具', '按需加载技能', 'W', '技能体系不可用'),
 'tool-subagent': ('子智能体工具', '派生子智能体', 'W', '无法并行分工'),
 'tool-subagent-control': ('子智能体控制', '消息/中断/发现', 'W', '子体协调失效'),
 'tool-workflow': ('工作流工具', '执行 JS 编排脚本', 'D', '工作流消失'),
 'tool-working-directory': ('工作目录工具', '查看/切换工作目录', 'D', '切换消失'),
 'tool-executor-native': ('原生工具执行器', '工具执行基础实现', 'K', '工具全部不可执行'),
 'tool-executor-ptc': ('PTC 执行器', 'PTC 程序执行', 'W', 'PTC 模式不可用'),
 'ptc-runtime': ('PTC 运行时', 'Node 侧 PTC 环境', 'W', 'PTC 模式不可用'),
 'workflow-ptc': ('工作流 PTC', '沙箱内工作流编排', 'D', '工作流消失'),
 'subagent': ('子智能体接口', '提供者注册表', 'W', '子体功能消失'),
 'subagent-fork-in-process': ('进程内 fork 子体', '继承父会话', 'W', 'fork 不可用'),
 'subagent-spawn-in-process': ('进程内 spawn 子体', '全新子体', 'W', 'spawn 不可用'),
 'jobs': ('后台任务服务', '进程内任务实现', 'W', '后台任务消失'),
 'schedule': ('定时任务服务', '持久化提醒', 'D', '定时提醒消失'),
 'goal': ('目标服务', '事件溯源目标状态', 'D', '目标功能消失'),
 'goal-round-driver': ('目标轮驱动', '自动推进目标', 'D', '自动推进消失'),
 'plan-mode': ('计划模式', '先出计划的执行模式', 'D', '计划模式消失'),
 'compaction-basic': ('上下文压缩', '超长摘要压缩', 'W', '长对话易爆上下文'),
 'command-compact': ('/compact 命令', '手动压缩', 'D', '该命令消失'),
 'image-offload': ('图片卸载', '超预算图片转存', 'D', '图片处理变差'),
 'tool-result-pruner': ('工具结果裁剪', '超长结果头尾保留', 'D', '输出更占上下文'),
 'repeat-tool-reminder': ('重复调用提醒', '打转时提醒', 'D', '更易死循环'),
 'timeout-policy': ('超时策略', '工具调用超时', 'W', '工具可能挂起'),
 'mcp-resources': ('MCP 资源', 'MCP 资源发现与读取', 'D', 'MCP 不可用'),
 'spill-policy': ('溢出策略', '超预算结果落盘', 'W', '超长结果被丢'),
 'spill-local': ('溢出本地存储', '溢出内容落盘实现', 'W', '溢出内容读不回'),
 'token-meter': ('Token 计量', '用量测量', 'K', '用量与压缩失效'),
 'system-prompt': ('系统提示装配', '拼装系统提示词', 'K', '模型无行为规范'),
 'sandbox': ('沙箱后端', '本地进程沙箱', 'K', '执行失去隔离'),
 'sandbox-policy': ('沙箱策略', '每次调用策略', 'K', '权限判定失效'),
 'bash-sandbox': ('bash 沙箱', '沙箱化 bash', 'W', 'bash 失去隔离'),
 'pwsh-sandbox': ('PowerShell 沙箱', '沙箱化 pwsh', 'D', 'Windows 专用'),
 'fs-sandbox': ('文件沙箱', '文件访问约束', 'K', '文件权限失控'),
 'fs-observation-policy': ('文件观察策略', '文件上下文规则', 'D', '上下文提示变弱'),
 'subprocess': ('子进程服务', '本地子进程', 'K', '无法启动外部进程'),
 'shell-env': ('Shell 环境变量', 'DSH_* 变量注册', 'K', '工具环境缺失'),
 'attachment-local': ('附件存储', '私有附件存储', 'W', '上传失效'),
 'timer': ('定时器服务', 'cordis 定时器', 'K', '定时逻辑失效'),
 'hmr': ('热重载', '模块与配置热更新', 'D', '开发用，发布版可删'),
 'credentials': ('凭据存储', '本地 .env 凭据', 'K', 'API Key 无处存放'),
 'authorization': ('授权接口', '插件授权流程', 'K', '授权链路断裂'),
 'deepseek-account': ('DeepSeek 账号登录', '浏览器 PKCE', 'W', '账号登录消失'),
 'approval': ('审批接口', '人工确认审批', 'K', '危险操作无法确认'),
 'user-questions': ('提问接口', '向用户提问', 'K', '追问失效'),
 'permission': ('权限预设', '新会话默认权限', 'W', '权限选择器消失'),
 'working-directory': ('工作目录', '会话工作目录', 'K', '无法确定目录'),
 'workspace': ('工作区注册表', '工作区实体', 'K', '工作区失效'),
 'workspace-changes': ('工作区变更', '按轮记录 git 改动', 'D', '变更卡片消失'),
 'skill': ('技能注册表', '技能提供者', 'W', '技能体系消失'),
 'skill-filesystem': ('本地技能', '文件系统读技能', 'W', '技能加载失效'),
 'message-feedback': ('消息反馈', '点赞点踩记录', 'D', '反馈按钮消失'),
 'message-quotes': ('消息引用', '选中文本引用', 'D', '引用消失'),
 'deliverable-file-references': ('交付物引用', '文件链接模型指引', 'D', '提示变弱'),
 'file-reference-local': ('本地文件引用', '@文件 索引', 'W', '@文件 失效'),
 'office-to-pdf': ('Office 转 PDF', '文档转换', 'D', 'Office 预览失效'),
 'harness-dev-context': ('开发上下文', '注入仓库与 GUI 地址', 'D', '调试用，建议删'),
 'config-editor': ('配置编辑器', 'patch 持久化配置', 'W', '配置无法保存'),
 'plugin-manager': ('插件管理器', '插件与 Bundle 管理', 'W', '插件面板失效'),
 'tool-plugin-manager': ('插件管理工具', '让模型操作插件', 'D', '模型不能改插件'),
 'plugin-inventory': ('插件清单服务', '只读插件状态', 'D', '清单页失效'),
 'plugin-package-inventory-deepseek': ('插件包清单', '官方插件包清单', 'D', '列表为空'),
 'directory-picker': ('目录选择器', '自适应选目录', 'W', '选目录失效'),
 'open-in-app': ('外部应用打开', '用其他应用打开文件', 'D', '按钮消失'),
 'web': ('联网能力接口', 'web 能力抽象', 'K', '联网工具失去基础'),
 'web-fetch-http': ('HTTP 抓取', '匿名抓网页', 'D', '抓取失效'),
 'web-search-deepseek': ('DeepSeek 搜索', '官方搜索', 'D', '搜索失效'),
 'web-deepseek-api': ('DeepSeek Search/Fetch', '官方搜索与抓取 API', 'D', '搜索抓取失效'),
 'otel': ('OpenTelemetry', '事件与日志上报', 'D', '遥测不可用，建议删'),
 'desktop-product-telemetry': ('产品遥测', '桌面端事件上报', 'D', '不再上报，建议删'),
 'product-analytics': ('产品分析', '事件采集', 'D', '不再采集，建议删'),
 'commands': ('命令注册表', '斜杠命令体系', 'W', '斜杠命令失效'),
 'connection': ('连接传输', '鉴权 RPC', 'K', '前端断连'),
 'modules': ('模块系统', '客户端模块装载', 'K', '界面无法加载'),
 'resources': ('资源模型', 'URL 到资源', 'K', '资源读取失效'),
 'locale': ('多语言', '语言包与偏好', 'K', '界面无文字'),
 'shortcuts': ('快捷键座位（已清空）', '组合键注册与监听已删除，仅保留空座位', 'D', '再删需改 30+ 调用点'),
 'file-upload': ('文件上传', '上传与暂存', 'W', '拖拽上传失效'),
 'client-hmr': ('前端热重载', '重建自动刷新', 'D', '开发用，可删'),
 'ui-renderer': ('界面渲染器', 'React 插槽与渲染引擎', 'K', '界面白屏'),
 'ui-layout': ('三栏框架', 'AppFrame 三栏', 'K', '界面结构消失'),
 'ui-theme': ('主题', '主题与毛玻璃 token', 'K', '样式全丢'),
 'ui-settings': ('设置框架', '设置域基础', 'K', '设置页消失'),
 'ui-session': ('会话适配', '会话状态到 React', 'K', '对话区失效'),
 'ui-conversation': ('对话装配', '外壳/输入框/队列', 'K', '对话区失效'),
 'ui-chat': ('聊天渲染', '消息节点渲染', 'K', '消息不显示'),
 'ui-sidebar': ('左栏', '会话树与搜索', 'K', '左栏消失'),
 'ui-sidebar-right': ('右栏', '右侧面板容器', 'K', '右栏消失'),
 'ui-tool': ('工具卡片', '工具调用展示', 'W', '工具调用不可见'),
 'ui-trajectory': ('轨迹视图', '完整执行轨迹', 'D', '轨迹页消失'),
 'ui-approval': ('审批界面', '审批卡片', 'W', '审批无法点击'),
 'ui-attachment': ('附件展示', '输入框与消息附件', 'W', '附件显示异常'),
 'ui-input-trigger': ('输入触发器', '/ 与 @ 菜单', 'W', '菜单失效'),
 'ui-commands': ('命令面板', '/ 命令来源', 'W', '面板失效'),
 'ui-model-selection': ('模型选择器', '模型下拉', 'W', '不能换模型'),
 'ui-user-questions': ('提问界面', '提问卡片', 'W', '追问无法展示'),
 'ui-plan': ('计划界面', '计划控件与卡片', 'D', '计划 UI 消失'),
 'ui-goal': ('目标条', '输入框上方目标条', 'D', '目标 UI 消失'),
 'ui-jobs': ('后台任务列表', '会话头部任务列表', 'D', '任务列表消失'),
 'ui-schedule': ('定时任务页', '任务管理页', 'D', '定时页消失'),
 'ui-skill': ('技能界面', '技能展示', 'D', '展示消失'),
 'ui-subagent': ('子智能体界面', '子体卡片', 'D', '展示消失'),
 'ui-workflow-run': ('工作流运行', '工作流展示', 'D', '展示消失'),
 'ui-deliverables': ('交付物卡片', '改动文件卡片', 'D', '卡片消失'),
 'ui-reference': ('引用来源', '@文件/@会话 来源', 'W', '引用菜单失效'),
 'ui-secret-mask': ('密钥打码', '显示时遮蔽凭据', 'D', '密钥明文（建议保留）'),
 'ui-message-feedback': ('消息反馈', '点赞点踩', 'D', '按钮消失'),
 'ui-file-drag': ('文件拖拽', '拖拽入窗', 'D', '拖拽失效'),
 'ui-open-in-app': ('外部打开', '用其他应用打开', 'D', '按钮消失'),
 'ui-cordis': ('动态插件卡片', 'cordis_define 卡片', 'D', '卡片消失'),
 'ui-brand-official': ('官方品牌位', '侧栏品牌占位', 'D', '品牌位消失（可换自家）'),
 'entry-customization': ('入口自定义', '侧栏/视图入口定制', 'D', '定制消失'),
 'ui-agent-preset': ('预设界面', '预设选择与管理', 'D', '预设 UI 消失'),
 'ui-plugin-manager': ('插件面板', '侧栏 Plugins 面板', 'D', '面板消失'),
 'ui-settings-general': ('通用设置', '通用设置页与引导', 'K', '设置主体消失'),
 'ui-settings-models': ('模型设置', '模型配置页', 'W', '不能改模型'),
 'ui-settings-account': ('账户设置/关于', '账户与「关于」入口', 'W', '关于消失'),
 'ui-settings-agent-loop': ('主循环设置', 'Agent 循环设置页', 'D', '该页消失'),
 'ui-settings-subagent': ('子体设置', '子智能体设置页', 'D', '该页消失'),
 'ui-settings-shell': ('Shell 设置', 'Shell 执行设置页', 'D', '该页消失'),
 'ui-settings-web-search': ('搜索设置', '联网搜索设置页', 'D', '该页消失'),
 'ui-settings-plugins': ('插件设置', '内置插件设置区', 'D', '该区消失'),
 'ui-settings-plugin-inventory': ('插件清单页', '只读清单 tab', 'D', 'tab 消失'),
 'ui-settings-session-log': ('日志上传设置', '上传开关', 'D', '设置项消失'),
 'ui-permission': ('权限界面', '权限预设 UI', 'D', '权限选择消失'),
 'ui-sidebar-files': ('文件栏', '右栏文件浏览', 'D', '文件浏览消失'),
 'ui-sidebar-browser': ('浏览器栏', '右栏沙箱浏览器', 'D', '浏览器标签消失'),
 'ui-sidebar-terminal': ('终端栏', '右栏终端', 'D', '终端消失'),
 'ui-sidebar-documentpreview': ('文档预览', 'Office/PDF/图片预览', 'D', '预览消失'),
 'ui-workspace': ('工作区界面', '工作区切换与行菜单', 'W', '切换消失'),
 'api-remotes': ('远端 BFF', '按需装配 Host 能力', 'K', '前端拿不到数据'),
 'typert-gateway': ('Typert 网关', '远端分发与端点', 'K', 'RPC 全断'),
 'typert': ('Typert 注册表', '反射与 schema', 'K', '类型系统失效'),
 'typert-loader': ('Typert 装载', 'Loader 集成', 'K', '类型装载失败'),
 'session-controller': ('会话接口', '会话命令与冷读', 'K', '会话不可操作'),
 'settings-controller': ('设置接口', '配置读写', 'K', '设置不可读写'),
 'workspace-controller': ('工作区接口', '工作区命令', 'K', '工作区不可操作'),
 'workspace-files': ('工作区文件接口', '文件读写', 'K', '文件不可读'),
 'job-controller': ('任务接口', '任务观测流', 'W', '任务不可观测'),
 'terminal-controller': ('终端接口', '会话内终端', 'W', '终端不可用'),
 'account-controller': ('账户接口', '账户操作', 'W', '账户页失效'),
 'remote-access': ('远端访问控制', '非 owner 权限', 'W', '多端协作失效'),
 'webserver': ('Web 服务', '路由与页面服务', 'K', '页面打不开'),
 'web-runtime': ('Web 运行时', '外壳与运行时胶水', 'K', '页面打不开'),
 'web-startup': ('Web 启动参数', '启动参数', 'K', '启动失败'),
}

# ── 未启用插件：包短名 -> (中文名, 作用, 判定, 说明) ──
UNUSED = {
 'dsh-acp-app': ('ACP 自动化服务', 'JSON-RPC stdio 自动化入口', 'D', '给外部程序驱动用，桌面版不需要'),
 'dsh-base': ('基础预设包', '所有 profile 的第一层 patch', 'K', '这是打包底座，不是可删插件'),
 'dsh-client-ui-action-cards': ('回答下方动作卡', '答案下的操作建议卡', 'D', '未启用'),
 'dsh-client-ui-creation-recommendations': ('建站推荐卡', '个性化建站卡片', 'D', '营销性质'),
 'dsh-client-ui-directory-picker-browse': ('应用内目录浏览', '选目录时的文件浏览界面', 'D', '被 auto 版替代'),
 'dsh-client-ui-directory-picker-native': ('原生目录选择', '系统目录对话框', 'D', '被 auto 版替代'),
 'dsh-client-ui-plugin-market': ('插件市场发现页', '浏览插件市场', 'D', '需联网市场'),
 'dsh-client-ui-plugin-recommendations': ('插件推荐卡', '官方插件推荐', 'D', '营销性质'),
 'dsh-cua': ('Computer Use 共享层', '桌面自动化对象与授权', 'D', '实验功能'),
 'dsh-cua-bundle': ('Computer Use 预设包', 'macOS 自动化与权限设置', 'D', '实验功能'),
 'dsh-experimental-agent-team-profile': ('Agent 团队预设', '多智能体协作整套', 'D', '实验'),
 'dsh-experimental-auto-review': ('自动审查', '每次工具调用前 LLM 审查', 'D', '实验，增加成本'),
 'dsh-experimental-badge-skill-bundle': ('加徽章技能', '在文档/PR 里加 powered by 徽章', 'D', '实验，营销'),
 'dsh-experimental-client-ui-agent-team': ('Agent 团队界面', '团队名册与任务板', 'D', '实验'),
 'dsh-experimental-client-ui-claude-code-mods': ('Claude Code 兼容带', '提示词上方 mods 条', 'D', '实验'),
 'dsh-experimental-client-ui-cot-translation': ('思维链翻译', '把推理过程机器翻译', 'D', '实验'),
 'dsh-experimental-client-ui-forge': ('变更请求面板', '会话变更请求与 worktree', 'D', '实验'),
 'dsh-experimental-client-ui-stats': ('开销统计表', '每轮上下文/耗时/缓存/工具成本', 'D', '实验'),
 'dsh-experimental-client-ui-voice-input': ('语音输入', '录音转文字填入输入框', 'D', '实验，需下模型'),
 'dsh-experimental-cot-translation-bundle': ('思维链翻译预设', '翻译推理过程', 'D', '实验'),
 'dsh-experimental-forge-bundle': ('变更请求预设', 'Git 仓库变更请求', 'D', '实验'),
 'dsh-experimental-inspector': ('跨域调试器', 'Host 调试与 Client 运行时检视', 'D', '实验，开发用'),
 'dsh-experimental-inspector-profile': ('调试器预设', '裸会话日志检视', 'D', '实验'),
 'dsh-experimental-liveshare': ('LiveShare 共享', '把会话分享给他人', 'D', '实验，需 Relay'),
 'dsh-experimental-plugin-market-bundle': ('自定义插件市场', '浏览并安装插件索引', 'D', '实验'),
 'dsh-experimental-ralph-bundle': ('重复作业跑批', '用新 Agent 反复跑同一任务', 'D', '实验'),
 'dsh-experimental-session-inspector': ('会话检视器', '虚拟化日志与节点检视', 'D', '实验'),
 'dsh-experimental-session-search': ('历史会话检索工具', '让模型搜索早期会话', 'D', '实验'),
 'dsh-experimental-session-titles-bundle': ('标题刷新预设', '新提示到达时更新标题', 'D', '实验'),
 'dsh-experimental-terminal-bundle': ('常驻终端预设', '跨工具调用保活 shell', 'D', '实验'),
 'dsh-experimental-tool-worktree': ('worktree 工具', '创建并进入 Git worktree', 'D', '实验'),
 'dsh-experimental-voice-input-bundle': ('语音输入预设', '本地 SenseVoice 识别', 'D', '实验，需下运行时'),
 'dsh-headless': ('无头模式', '一次性 Agent 运行器', 'D', 'CLI 场景，桌面版不用'),
 'dsh-personalized-recommendations': ('个性化推荐', '推荐卡片服务', 'D', '营销性质'),
 'dsh-sdk-app': ('SDK 服务包', 'stdio JSON-RPC 服务', 'D', '给外部集成用'),
 'dsh-sdk-minimal': ('最小 SDK 包', '单适配器最小集成', 'D', '给外部集成用'),
 'dsh-session-format-v0-to-v1': ('会话格式迁移 v0→v1', '旧格式升级', 'K', '迁移用，删了老数据读不了'),
 'dsh-session-format-v1-to-v2': ('会话格式迁移 v1→v2', '旧格式升级', 'K', '迁移用'),
 'dsh-session-format-v2-to-v3': ('会话格式迁移 v2→v3', '旧格式升级', 'K', '迁移用'),
 'dsh-session-format-v3-to-v4': ('会话格式迁移 v3→v4', '旧格式升级', 'K', '迁移用'),
 'dsh-subagent-claude-code': ('Claude Code 子体', '经官方 SDK 调 Claude Code', 'D', '需另装 Claude Code'),
 'dsh-subagent-codex': ('Codex 子体', '调 Codex app-server', 'D', '需另装 Codex'),
}

pkgs = {}
for pj in glob.glob('packages/*/*/package.json'):
    try:
        d = json.load(open(pj, encoding='utf-8'))
    except Exception:
        continue
    n = d.get('name', '')
    if n.startswith('@deepseek-ai/'):
        pkgs[n] = {'desc': d.get('description', '').strip(), 'dsh': 'dsh' in d, 'dir': os.path.dirname(pj)}

rows = json.load(open('.tmp/real.json', encoding='utf-8'))
SEAMS = json.load(open('.tmp/seams.json', encoding='utf-8'))

def is_seam(plugin_id: str):
    """按手册《能力接缝》判断该插件是否提供 ctx.* 契约。"""
    k = plugin_id.replace('-', '').lower()
    for seam in SEAMS:
        sl = seam.lower()
        if sl == k or sl == k + 's' or k == sl + 's':
            return seam
    return None

out = []
out.append('# 空谷 Ondra 插件总清单\n')
out.append('覆盖 `packages/` 下全部 **368** 个包：其中 **183** 个插件正在运行、**42** 个插件已随包未启用、**143** 个是代码库（不单独运行）。\n')
out.append('> 判定：🔴 不可删 ｜ 🟡 慎删（少一块功能或需连带改配置）｜ 🟢 可删\n')
out.append('''## 零、判定依据（来自项目手册）

本清单的判定不是拍的，依据以下四份官方文档：

| 文档 | 给出的判据 |
|---|---|
| `packages/bundle/README.zh.md` | 所有 profile 以 `dsh-base` 为基础，`web-app` 是浏览器层，`headless`/`acp`/`sdk` 是其他表层。**base 层是共同地基，删不得** |
| `apps/cli/composition.md` | 每个 profile 的确切插件组合图（本清单第一部分即来自它） |
| `docs/architecture.zh.md` | 服务分层：核心主干服务 / 可替换的 seam / 组合点 / 独立服务 |
| `docs/capability-seams.zh.md` | **107 个 `ctx.*` 契约**：契约层不可删（删了所有消费者编译失败），其背后的实现可以替换 |

由此得到三条硬规则：

1. **提供 `ctx.*` 契约的插件 → 不可删**，除非同时改掉全部消费者（表中「契约层」列标 ✅）。
2. **只做实现、不提供契约的插件 → 可替换/可删**（例如 `llm-deepseek` 换成别家）。
3. **只做界面的 `ui-*` → 可删**，但 `ui-renderer` / `ui-layout` / `ui-settings` / `ui-sidebar` / `ui-conversation` / `ui-chat` 是界面骨架，删了白屏。
''')

def table(title, note, items, status):
    out.append(f'\n## {title}\n')
    out.append(note + '\n')
    out.append('| 状态 | 插件 | 中文名 | 作用 | 契约层 | 判定 | 删除影响 |')
    out.append('|---|---|---|---|---|---|---|')
    for key, (cn, desc, verdict, impact) in items:
        mark = {'K': '🔴 不可删', 'W': '🟡 慎删', 'D': '🟢 可删'}[verdict]
        seam = '✅ 提供 ctx.' + is_seam(key) if is_seam(key) else '—'
        out.append(f'| {status} | `{key}` | {cn} | {desc} | {seam} | {mark} | {impact} |')

loaded_items = [(k, v) for k, v in LOADED.items()]
unused_items = [(k.replace('dsh-', ''), v) for k, v in UNUSED.items()]

table('一、正在运行的插件（183 个）', '来自 `cordis.patch.yml`，应用启动时真实加载。', loaded_items, '运行中')
table('二、已随包但未启用的插件（42 个）', '代码在，配置里没开。想彻底瘦身可以直接删这些包。', unused_items, '未启用')

libs = json.load(open('.tmp/libs.json', encoding='utf-8'))
out.append('\n## 三、代码库（143 个，不是插件、不能单独删）\n')
out.append('这些包本身不注册任何插件，只提供函数、类型或构建产物；上面的插件依赖它们，删掉会导致编译失败。'
           '列出来只为让主人看清"包里到底装了什么"，不建议动。\n')
out.append('| 包名 | 作用（官方自述） |')
out.append('|---|---|')
for name, desc in libs.items():
    short = name.replace('@deepseek-ai/', '')
    d = (desc or '（官方无自述）').replace('|', '\\|')
    out.append(f'| `{short}` | {d} |')

# ── 四、368 个包的去留判定 ──
keep_loaded = [(k, v) for k, v in loaded_items if v[2] in ('K', 'W')]
drop_loaded = [(k, v) for k, v in loaded_items if v[2] == 'D']
keep_unused = [(k, v) for k, v in unused_items if v[2] == 'K']
drop_unused = [(k, v) for k, v in unused_items if v[2] == 'D']

out.append('\n## 四、368 个包的去留总表\n')
out.append(f'**结论：留 {len(keep_loaded) + len(keep_unused) + len(libs)} 个（其中插件 {len(keep_loaded) + len(keep_unused)}、库 {len(libs)}），删 {len(drop_loaded) + len(drop_unused)} 个。**\n')

out.append('### 4.1 建议删除（%d 个）\n' % (len(drop_loaded) + len(drop_unused)))
out.append('分两类：**未启用插件**（删了零影响）与**运行中的遥测/开发类**（删了更干净）。\n')
out.append('| # | 插件 | 中文名 | 状态 | 为什么删 |')
out.append('|---|---|---|---|---|')
n = 0
for k, v in drop_unused:
    n += 1
    out.append(f'| {n} | `{k}` | {v[0]} | 未启用 | 零影响：配置里没开，删了不动任何运行逻辑（功能：{v[1]}） |')
for k, v in drop_loaded:
    n += 1
    out.append(f'| {n} | `{k}` | {v[0]} | 运行中 | {v[3]} |')

out.append('\n### 4.2 必须保留的插件（%d 个）\n' % (len(keep_loaded) + len(keep_unused)))
out.append('提供 `ctx.*` 契约、或属于 base 地基、或界面骨架。删任何一个都要连带改大量调用点。\n')
out.append('| # | 插件 | 中文名 | 状态 | 保留理由 |')
out.append('|---|---|---|---|---|')
n = 0
for k, v in keep_unused:
    n += 1
    out.append(f'| {n} | `{k}` | {v[0]} | 未启用 | {v[3]} |')
for k, v in keep_loaded:
    n += 1
    seam = is_seam(k)
    why = ('提供 ctx.' + seam) if seam else ('界面/功能骨架' if v[2] == 'K' else '功能依赖，删前需连带清理')
    out.append(f'| {n} | `{k}` | {v[0]} | 运行中 | {why} |')

out.append('\n### 4.3 代码库（%d 个，全部保留）\n' % len(libs))
out.append('不注册插件、只被上面的插件 import。除非确认无人引用，一律不动。\n')

open('../build/插件清单.md', 'w', encoding='utf-8').write('\n'.join(out))
print('已生成 build/插件清单.md')
print('运行中', len(loaded_items), '未启用', len(unused_items), '库', len(libs))
