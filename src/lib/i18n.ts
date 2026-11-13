/**
 * 设置面板的双语文案层（2.3.0 起）。
 *
 * ## 为什么只覆盖设置面板
 *
 * 语言偏好切换的是**界面壳层的静态文案**：设置面板的导航、标题、说明、
 * 按钮。对话主界面的人格语料、宿主插件参数与场景层数据是「内容」而不是
 * 「界面」，前者是中文人格的一部分，后者由宿主按需下发——两者都不在
 * 这一层管辖范围内，选中英语时它们保持简体中文。
 *
 * ## 为什么是「中英并列的元组」而不是两棵 key 树
 *
 * 每条文案的中英两版必须**肩并肩**：翻译漏一条时，两个语言树会各自少一
 * 个节点，类型系统不会报警；元组写法下漏译等于留一个空位，`t()` 的类型
 * 会逼着补齐。键名用「页.段.项」的扁平点路径，跳转与全文检索都方便。
 *
 * 参数用 `{0}` `{1}` 占位，`t()` 按序替换。占位符保证插值位置随语序
 * 移动，而不是硬拼字符串。
 */

import { useSyncExternalStore } from 'react'
import { getPreferences, subscribePreferences } from './preferences.ts'

/** 一条文案：[简体中文, English]。 */
type Entry = readonly [zh: string, en: string]

const DICT = {
  /* --- 壳：导航与标题 --- */
  'nav.general': ['通用', 'General'],
  'nav.models': ['模型与 API', 'Models & API'],
  'nav.persona': ['人物设定', 'Persona'],
  'nav.backup': ['备份与还原', 'Backup & Restore'],
  'nav.plugins': ['扩展功能', 'Extensions'],
  'nav.about': ['关于', 'About'],
  'settings.title': ['设置', 'Settings'],
  'settings.close': ['关闭设置', 'Close settings'],
  'settings.navLabel': ['设置分类', 'Settings categories'],

  /* --- 通用 --- */
  'general.theme': ['主题', 'Theme'],
  'general.theme.system': ['跟随系统', 'Follow system'],
  'general.theme.systemHint': ['随系统外观同步切换', 'Syncs with the system appearance'],
  'general.theme.light': ['浅色', 'Light'],
  'general.theme.lightHint': ['纸白', 'Paper white'],
  'general.theme.dark': ['深色', 'Dark'],
  'general.theme.darkHint': ['墨夜', 'Ink night'],
  'general.themeNote': [
    '跟随系统时，主题随系统外观同步切换。选择浅色或深色后，将固定使用所选主题，不再随系统变化。',
    'When following the system, the theme switches with the system appearance. Choosing Light or Dark pins the theme and stops following the system.',
  ],
  'general.font': ['字号', 'Font size'],
  'general.font.small': ['小', 'Small'],
  'general.font.standard': ['标准', 'Standard'],
  'general.font.large': ['大', 'Large'],
  'general.fontSample': [
    '于无声处，听见共鸣。这句话按当前字号排出来。',
    'In stillness, hear the resonance. This line is laid out at the current font size.',
  ],
  'general.fontSampleMeta': [
    '示例用正文字号（--text-body），不是缩放整个示例块',
    'The sample uses the body font token (--text-body), not a scaled block',
  ],
  'general.fontNote': [
    '这里改的是全局比例，会在系统字号的基础上再放大或缩小。系统里已经调大过的人，用「标准」不会把他调回小字。',
    'This sets a global ratio on top of the system font size. If the system font was already enlarged, choosing Standard will not shrink it back.',
  ],
  'general.locale': ['语言', 'Language'],
  'general.locale.zh': ['简体中文', 'Simplified Chinese'],
  'general.locale.zhHint': ['默认语言', 'Default language'],
  'general.locale.en': ['English', 'English'],
  'general.locale.enHint': ['设置面板已翻译', 'Settings panel translated'],
  'general.localeNote': [
    '设置面板的界面文案提供简体中文与英语两套。对话主界面、人格语料与插件参数内容仍为简体中文，将随后续版本补齐。',
    'The settings panel is available in Simplified Chinese and English. The chat interface, persona copy and plugin-parameter content remain Simplified Chinese for now and will follow in later releases.',
  ],
  'general.send': ['发送方式', 'Sending'],
  'general.send.interrupt': ['打断', 'Interrupt'],
  'general.send.interruptHint': ['生成过程中按 Enter 可立即插入输入', 'Press Enter while generating to insert input immediately'],
  'general.send.queue': ['排队', 'Queue'],
  'general.send.queueHint': ['待本轮生成完成后再插入输入', 'Waits for the current reply to finish before inserting input'],
  'general.sendNote': [
    '本项仅影响生成过程中按 Enter 的行为。空闲时 Enter 始终为发送，Shift + Enter 始终为换行。选择「排队」时，生成中按 Cmd/Ctrl + Enter 可越过队列立即发送。',
    'This only affects Enter while a reply is being generated. When idle, Enter always sends and Shift + Enter always inserts a newline. With Queue, Cmd/Ctrl + Enter during generation jumps the queue and sends immediately.',
  ],
  'general.notify': ['系统通知', 'System notifications'],
  'general.notify.row': ['系统通知', 'System notifications'],
  'general.notify.rowHint': ['窗口不在前台时，回复将通过系统通知送达', 'When the window is not in the foreground, replies arrive as system notifications'],
  'general.notify.denied': [
    '系统里拒绝了通知权限。去「系统设置 → 通知 → 空谷 Ondra」打开，再回来打开这个开关。',
    'Notification permission was denied in the system. Open System Settings → Notifications → Ondra, then come back and turn this on.',
  ],
  'general.notify.unsupported': [
    '这台机器上读不到通知权限（浏览器里预览时也会这样）。桌面端才能发系统通知。',
    'Notification permission cannot be read on this machine (also true in browser previews). Only the desktop build can send system notifications.',
  ],
  'general.notify.note1': [
    '仅在窗口不可见时发送。窗口在屏幕上、只是焦点落在其他应用时不发送：返回应用即可直接看到，此时推送反而是干扰。',
    'Sent only while the window is hidden. If the window is on screen but unfocused, nothing is pushed: coming back shows the reply directly, and a push would only interrupt.',
  ],
  'general.notify.note2': [
    '主动消息仍受每日上限与作息约束；通知只把已出现在时间轴上的内容呈现在通知中心。静音期间不发送任何通知。',
    'Proactive messages remain bound by the daily cap and the daily rhythm; notifications only surface content already on the timeline. Nothing is sent while muted.',
  ],
  'general.permission': ['默认权限', 'Default permission'],
  'general.permission.pending': ['正在读取…', 'Reading…'],
  'general.permission.loadError': ['读不到权限设置：{0}', 'Cannot read the permission setting: {0}'],
  'general.permission.chat': ['只在对话内', 'In chat only'],
  'general.permission.chatHint': ['不碰文件、不跑命令', 'No files, no commands'],
  'general.permission.workspace': ['限于工作区', 'Workspace only'],
  'general.permission.workspaceHint': ['能在绑定的目录里读写', 'Reads and writes only in the bound folder'],
  'general.permission.full': ['不限制', 'Unrestricted'],
  'general.permission.fullHint': ['可读取整台设备上的文件', 'Can read files on the whole device'],
  'general.permissionNote': [
    '这是新会话的默认档位，不是当前会话的。已经开着的对话各自记住自己建立时的档位——否则改一次默认值，正在进行的对话会在中途悄悄扩大权限。',
    'This is the default for new sessions, not for the current one. Open conversations keep the level they were created with — otherwise one change would silently widen an ongoing conversation midway.',
  ],
  'general.permissionWarn': [
    '当前默认档位为「不限制」：新会话将能够读取整台机器上的文件。若非必要，建议改回「限于工作区」或「只在对话内」。',
    'The default is currently Unrestricted: new sessions will be able to read files across the whole machine. Unless necessary, prefer Workspace only or In chat only.',
  ],
  'general.permissionWriteFail': ['写入失败', 'Failed to save'],
  'general.fullConfirmTitle': ['放宽到「不限制」', 'Relax to Unrestricted'],
  'general.fullConfirmConfirm': ['仍然放宽', 'Still relax'],
  'general.cancel': ['取消', 'Cancel'],
  'general.fullConfirmBody': [
    '此档位允许新会话读取整台机器上的文件。除非确有需要，否则「限于工作区」更安全。确认放宽至不限制？',
    'This level lets new sessions read files across the whole machine. Unless truly needed, Workspace only is safer. Relax to Unrestricted?',
  ],
  'general.sound': ['音效', 'Sounds'],
  'general.sound.row': ['提示音', 'Sound cues'],
  'general.sound.rowHint': ['发送、回复开始、出错时各播放一次', 'Plays once on send, on reply start, and on error'],
  'general.sound.volume': ['音量', 'Volume'],
  'general.sound.volumeAria': ['提示音音量', 'Sound cue volume'],
  'general.sound.cueSend': ['发送', 'Send'],
  'general.sound.cueSendHint': ['消息发送时', 'When a message is sent'],
  'general.sound.cueSpeak': ['回复开始', 'Reply starts'],
  'general.sound.cueSpeakHint': ['开始生成回复时', 'When a reply starts generating'],
  'general.sound.cueError': ['出错', 'Error'],
  'general.sound.cueErrorHint': ['本轮失败时', 'When the round fails'],
  'general.sound.cueLocked': ['先打开提示音', 'Turn on sound cues first'],
  'general.sound.note': [
    '本档音量仅作用于上述三种提示音，不改变系统音量。本应用不提供打字音与环境音：打字音会与逐字输出叠加成噪声，环境音会使应用偏离陪伴定位。',
    'This volume applies only to the three cues above and never changes the system volume. No typing sounds or ambient loops: typing sounds pile onto streaming text, and ambience pulls the app away from companionship.',
  ],
  'general.voiceInput': ['语音输入', 'Voice input'],
  'general.voiceInput.row': ['语音输入', 'Voice input'],
  'general.voiceInput.rowHint': ['在输入框显示麦克风按钮，可录音转为文字', 'Shows a microphone button in the composer to record and transcribe'],
  'general.voiceInputNote': [
    '首次使用麦克风时，系统会请求授权。语音转写在本机完成，需要您的环境中装有本地语音识别模型（如 whisper）；未安装时，录音后会给明确提示而非静默失败。',
    'The system asks for microphone access on first use. Transcription runs locally and needs a local speech model (such as whisper) in your environment; without one, recording ends with a clear message instead of failing silently.',
  ],
  /*
   * 主动发言。
   *
   * ## 为什么从「扩展功能」搬到这里
   *
   * 原先这三段只在模块层里，名字是「主动门控」「主动节律」「主动话由」。
   * 用户想让她少说两句时，需要先知道有个叫「主动门控」的插件段——那是
   * 实现者的词汇，不是用户的。它们回答的问题（她什么时候开口）属于
   * 「这个应用用起来什么样」，也就是这一页。
   */
  'general.proactive': ['主动发言', 'Proactive messages'],
  'general.proactiveNote': [
    '她不会一直沉默，也不会一直说话。这一节决定她多久可以主动开口一次、在什么时段保持安静、以及每条主动消息要不要说明理由。收起时只显示项数，点开可逐项调。',
    'She neither stays silent nor talks constantly. This section decides how often she may speak up, when she stays quiet, and whether each proactive message explains why it was sent.',
  ],
  'general.proactive.gate': ['开口时机与限额', 'Timing and limits'],
  'general.proactive.quota': ['每日节奏', 'Daily rhythm'],
  'general.proactive.reason': ['消息理由', 'Message rationale'],

  /* --- 模型与 API --- */
  'models.title': ['模型提供商', 'Model providers'],
  'models.note': [
    '模型来源只有两类：一是内置的「本地演示」，不联网、只会回声，用来确认链路通不通，无需任何配置；二是您在本页添加的 OpenAI 兼容端点（DeepSeek、Moonshot、Ollama、vLLM 等），填基址、API Key 与模型名即可。添加后它会出现在输入框下方的模型选择器里，点「设为默认」即可用于对话。API Key 按机密字段处理，读回时打码，不在界面明文回显。',
    'There are exactly two kinds of model source. The built-in Local demo never goes online and only echoes your text — it exists to prove the pipeline works and needs no configuration. Everything else is an OpenAI-compatible endpoint you add on this page (DeepSeek, Moonshot, Ollama, vLLM and so on) with a base URL, an API key and a model name. Once added it appears in the model picker under the composer; choose Set as default to use it for conversations. The API key is treated as a secret: it is masked when read back and never echoed in plain text.',
  ],
  'models.add': ['添加提供商', 'Add provider'],
  'models.empty': ['还没有添加任何提供商。此时对话使用的是内置的「本地演示」——它只会把您的话回声一遍，不产生真实回答。点上方「添加提供商」接入一个真实的模型后端。', 'No providers yet. Conversations currently use the built-in Local demo, which only echoes your text and produces no real answer. Click Add provider above to connect a real model backend.'],
  'models.defaultTag': ['默认', 'Default'],
  'models.setDefault': ['设为默认', 'Set as default'],
  'models.edit': ['编辑', 'Edit'],
  'models.delete': ['删除', 'Delete'],
  'models.editorNew': ['添加提供商', 'Add provider'],
  'models.editorEdit': ['编辑提供商', 'Edit provider'],
  'models.field.name': ['名称', 'Name'],
  'models.field.namePh': ['例如：本地 Ollama', 'e.g. local Ollama'],
  'models.field.baseUrl': ['基址', 'Base URL'],
  'models.field.baseUrlPh': ['https://… 或 http://localhost:11434/v1', 'https://… or http://localhost:11434/v1'],
  'models.field.key': ['API Key', 'API Key'],
  'models.field.keyPh': ['留空表示无需密钥', 'Leave empty if no key is required'],
  'models.field.model': ['模型名', 'Model name'],
  'models.field.modelPh': ['例如：llama3.1:8b', 'e.g. llama3.1:8b'],
  'models.save': ['保存', 'Save'],
  'models.saving': ['保存中…', 'Saving…'],
  'models.ok.saved': ['已保存提供商', 'Provider saved'],
  'models.ok.removed': ['已删除', 'Deleted'],
  'models.ok.defaultSet': ['已设为默认提供商', 'Set as the default provider'],
  'models.ok.defaultCleared': ['已取消默认提供商', 'Default provider cleared'],
  'models.err.load': ['读不到提供商列表', 'Cannot read the provider list'],
  'models.err.save': ['保存失败', 'Failed to save'],
  'models.err.remove': ['删除失败', 'Failed to delete'],
  'models.err.required': ['请填写名称、基址与模型名', 'Fill in the name, the base URL and the model'],
  /*
   * 「存下了，但还差密钥」——不是失败，也不是成功。
   *
   * 上一版这种情况下也回「已保存提供商」，用户以为配好了，切过去发第一句
   * 才收到 401；那时他已经在对话里，回不到这个表单，也不知道该改哪一项。
   * 本机端点（Ollama 等）不需要密钥，所以这条只在远端端点出现。
   */
  'models.warn.noKey': [
    '已保存，但还没有填 API Key：现在切到这个提供商，对话会返回「密钥无效」。补上密钥后再试。',
    'Saved, but no API key yet: switching to this provider now will fail with "invalid key". Add the key and try again.',
  ],

  /* --- 人物设定 --- */
  'persona.pack': ['人设包', 'Persona pack'],
  'persona.pack.note': [
    '人设包决定她是谁：名字、说话方式与记忆里的自称。切换立即生效，不必重启。包本体只读，导入的 .skill.zip 原样保留。',
    'A persona pack decides who she is: her name, the way she speaks, and how she refers to herself. Switching takes effect immediately, no restart needed. Packs are read-only; imported .skill.zip files are kept as-is.',
  ],
  'persona.pack.empty': [
    '没读到人设包。检查随包目录是否存在，或点「重新扫描」。',
    'No persona packs found. Check that the bundled directory exists, or click Rescan.',
  ],
  'persona.pack.rescan': ['重新扫描', 'Rescan'],
  'persona.pack.switch': ['切换', 'Switch'],
  'persona.pack.switched': ['已切换', 'Switched'],
  'persona.pack.current': ['当前', 'Current'],
  'persona.pack.role.factory': ['出厂', 'Factory'],
  'persona.pack.role.sample': ['示例', 'Sample'],
  'persona.pack.role.user': ['用户', 'User'],
  'persona.avatar': ['头像', 'Avatar'],
  'persona.avatar.note': [
    '显示在标题栏左上角，24 像素。默认用应用图标；自定义图片会缩到 96×96 存在本机，不上传。',
    'Shown at 24 px in the title bar. Defaults to the app icon; a custom image is scaled to 96×96 and stored on this machine only.',
  ],
  'persona.avatar.pick': ['选择图片', 'Choose image'],
  'persona.avatar.reset': ['恢复默认', 'Reset to default'],
  'persona.avatar.err': ['这张图片读不出来，换一张试试', 'That image could not be read. Try another one.'],
  'persona.voice': ['朗读声音', 'Voice'],
  'persona.tone': ['说话口吻', 'Tone'],
  'persona.pace': ['说话节奏', 'Pace'],
  'persona.rules': ['说话的规矩', 'Rules'],
  'persona.memory': ['记忆', 'Memory'],
  /*
   * 四张卡下方的「更多设置」。
   *
   * ## 为什么按卡片分别命名，不共用一个「更多设置」
   *
   * 一页里有四个长得一样的折叠按钮，读屏用户靠名字区分它们。四个都叫
   * 「更多设置」时，屏幕阅读器的元素列表里会出现四条同名项，用户只能
   * 靠位置猜。带上是哪张卡的，才说得清点开的是哪一个。
   */
  'persona.more.vars': ['她怎么称呼你', 'How she addresses you'],
  'persona.more.voice': ['朗读的更多设置', 'More voice settings'],
  'persona.more.voiceGate': ['朗读时机的更多设置', 'More speech-gate settings'],
  'persona.more.tone': ['口吻的更多设置', 'More tone settings'],
  'persona.more.lexicon': ['语感与语气词', 'Speech habits and particles'],
  'persona.more.expression': ['表情判定', 'Emoji and expression'],
  'persona.more.pace': ['节奏的更多设置', 'More rhythm settings'],
  'persona.more.rules': ['规矩的更多设置', 'More rule settings'],
  'persona.memory.note': [
    '这里决定她记多久、怎么淡忘、什么时候回头复核。日常只需要「记忆保留深度」一个数，其余按需展开。下面的知识库是您手写给她看的内容，与自动记忆是两回事。',
    'This decides how long she remembers, how memories fade, and when she revisits them. Day to day only one number matters; the rest can stay folded. The knowledge base below is what you write for her — separate from automatic memory.',
  ],
  'persona.more.memoryCore': ['记忆保留与容量', 'Retention and capacity'],
  'persona.more.memoryDecay': ['遗忘曲线', 'Fading curve'],
  'persona.more.memoryAudit': ['复核与复查', 'Review and audit'],
  'kb.note': [
    '这里是您可自己维护的知识清单：把常用背景、人物设定、项目资料录进来，她会在对话时参考。支持分类，便于管理与检索。数据保存在本机，不上传。',
    'A knowledge list you maintain yourself: record background, persona notes and project material, and she will refer to it in conversation. Entries support categories for easier management and lookup. Data stays on this machine and is never uploaded.',
  ],
  'kb.add': ['新增条目', 'New entry'],
  'kb.empty': ['知识库还是空的。点上面的「新增条目」写第一条。', 'The knowledge base is empty. Click New entry above to write the first one.'],
  'kb.edit': ['编辑', 'Edit'],
  'kb.delete': ['删除', 'Delete'],
  'kb.editorNew': ['新增条目', 'New entry'],
  'kb.editorEdit': ['编辑条目', 'Edit entry'],
  'kb.field.title': ['标题', 'Title'],
  'kb.field.titlePh': ['例如：项目代号、人物关系', 'e.g. project codename, relationships'],
  'kb.field.category': ['分类', 'Category'],
  'kb.field.categoryPh': ['可选，例如：工作 / 人物 / 资料', 'Optional, e.g. work / people / material'],
  'kb.field.body': ['内容', 'Content'],
  'kb.field.bodyPh': ['录入这条知识的正文', 'Write the body of this entry'],
  'kb.save': ['保存', 'Save'],
  'kb.saving': ['保存中…', 'Saving…'],
  'kb.ok.saved': ['已保存', 'Saved'],
  'kb.ok.deleted': ['已删除', 'Deleted'],
  'kb.err.title': ['请先填写标题', 'Add a title first'],
  'kb.err.load': ['读不到知识库', 'Cannot read the knowledge base'],
  'kb.err.save': ['保存失败', 'Failed to save'],
  'kb.err.delete': ['删除失败', 'Failed to delete'],

  /* --- 备份与还原 --- */
  'data.export': ['导出', 'Export'],
  'data.exportNote': [
    '对话本来就以明文 JSON 存在数据目录里，一个会话一个文件。「导出」做的是把当前这段（或全部，含已归档的段）写进下载目录，并存一份人能直接读的形式。文件不会上传到任何地方。',
    'Conversations already live as plain-text JSON in the data folder, one file per session. Export writes the current session (or all of them, including archived ones) to the downloads folder, plus a human-readable copy. Files are never uploaded anywhere.',
  ],
  'data.exportCurrent': ['导出这一段的 JSON', 'Export this session as JSON'],
  'data.exportMarkdown': ['导出为 Markdown', 'Export as Markdown'],
  'data.exportAll': ['导出全部', 'Export all'],
  'data.none': ['暂无可导出的对话', 'Nothing to export yet'],
  'data.savedTo': ['已存到 {0}', 'Saved to {0}'],
  'data.savedAll': ['共 {0} 段，已存到 {1}', '{0} sessions saved to {1}'],
  'data.import': ['导入', 'Import'],
  'data.importNoteA': ['导入的是上面那种 JSON 文件。恢复时', 'The file is the same JSON as above. Restoring '],
  'data.importNoteStrong': ['当前这一段会被归档', 'archives the current session'],
  'data.importNoteB': [
    '，不会被删掉——单会话制下同时只有一段对话，旧的那段要让开位置。归档的段仍在数据目录里。',
    ' instead of deleting it — only one session is active at a time, so the old one has to step aside. Archived sessions remain in the data folder.',
  ],
  'data.restore': ['从文件恢复…', 'Restore from a file…'],
  'data.restoring': ['正在读取…', 'Reading…'],
  'data.ok.restored': ['已恢复 {0} 条消息', 'Restored {0} messages'],
  'data.ok.restoredArchived': ['已恢复 {0} 条消息，上一段已归档', 'Restored {0} messages; the previous session was archived'],
  'data.err.import': ['导入失败', 'Import failed'],
  'data.err.generic': ['操作未完成', 'The operation did not finish'],
  /*
   * 「需要桌面端」与「未授权」是两件完全不同的事。
   *
   * 上一版这里没有这一条，前端直接把宿主对 HTTP 401 的原文「未授权」
   * 摊给用户——用户会去翻权限设置，而真实原因是这个功能只能由应用外壳
   * 完成（文件选择与写入），浏览器预览里根本没有那个能力。
   */
  'data.err.desktopOnly': [
    '这一步需要桌面端才能完成：选择与写入文件由应用外壳负责，浏览器预览里没有这个能力。',
    'This step needs the desktop app: choosing and writing files is handled by the app shell, which a browser preview does not have.',
  ],
  'backup.title': ['备份与恢复', 'Backup & restore'],
  'backup.note': [
    '备份会复制本应用的全部本地数据（会话、记忆、世界书、知识库、模型配置与偏好）到数据目录下的「backups」文件夹，互不覆盖，可保留多份。恢复会把整库回到所选备份的时刻——此操作会覆盖当前全部数据，请先确认。',
    'A backup copies all local data (sessions, memory, the world book, the knowledge base, model configuration and preferences) into the backups folder inside the data directory. Backups do not overwrite each other and several can be kept. Restoring rolls the whole store back to the moment of the chosen backup — it overwrites all current data, so confirm first.',
  ],
  'backup.create': ['创建备份', 'Create backup'],
  'backup.creating': ['正在创建…', 'Creating…'],
  'backup.existing': ['已有备份', 'Existing backups'],
  'backup.empty': ['暂无备份。点击上方按钮可创建当前全部数据的首份快照。', 'No backups yet. Click the button above to take the first snapshot of all data.'],
  'backup.rollback': ['回滚到此份', 'Roll back to this one'],
  'backup.ok.created': ['已创建备份（{0}）', 'Backup created ({0})'],
  'backup.ok.restored': ['已回滚到所选备份，应用将重新读取数据', 'Rolled back to the chosen backup; the app will reload data'],
  'backup.err.list': ['读不到备份列表', 'Cannot read the backup list'],
  'backup.err.create': ['创建备份失败', 'Failed to create the backup'],
  'backup.err.restore': ['回滚失败', 'Rollback failed'],
  'backup.confirmTitle': ['回滚到此备份', 'Roll back to this backup'],
  'backup.confirmConfirm': ['回滚', 'Roll back'],
  'backup.confirmBody': [
    '此操作会用这份备份覆盖当前全部本地数据，且不可撤销。确定要回滚到该时刻吗？',
    'This overwrites all current local data with the chosen backup and cannot be undone. Roll back to that moment?',
  ],

  /* --- 关于 --- */
  'about.version': ['版本', 'Version'],
  'about.license': ['许可证', 'License'],
  'about.repo': ['仓库', 'Repository'],
  'about.update': ['更新', 'Update'],
  'about.updateNote': [
    '本应用不内置自动下载安装（需代码签名与更新服务器）。点击「检查更新」将比对 GitHub 上的最新发布；若有新版本，可前往下载页获取安装包覆盖安装，配置与对话均不受影响。',
    'The app does not auto-download updates (that requires code signing and an update server). Check for updates compares against the latest GitHub release; if a new version exists, grab the installer from the releases page and install over the current one — configuration and conversations are untouched.',
  ],
  'about.check': ['检查更新', 'Check for updates'],
  'about.checking': ['正在检查…', 'Checking…'],
  'about.openReleases': ['打开下载页', 'Open the releases page'],
  'about.err.check': ['检查更新失败', 'Update check failed'],
  'about.ok.latest': ['已是最新（v{0}）。', 'Up to date (v{0}).'],
  'about.ok.available': ['发现新版本 v{0}（当前 v{1}）。前往下载页获取更新。', 'New version v{0} found (current v{1}). Get it from the releases page.'],
  'about.err.link': ['打不开这个地址', 'Cannot open this address'],

  /* --- 隐私 --- */
  'privacy.dataDir': ['数据存放位置', 'Where data lives'],
  'privacy.dataDirNote': [
    '所有会话、记忆、世界书、知识库、模型配置与备份都保存在本机的「应用支持目录」中，不强制上云。您可随时在文件管理器中查看这一目录。',
    'All sessions, memory, the world book, the knowledge base, model configuration and backups live in the app-support directory on this machine. Nothing is forced into the cloud; you can open the folder any time in your file manager.',
  ],
  'privacy.dataRow': ['数据目录', 'Data folder'],
  'privacy.pending': ['正在读取…', 'Reading…'],
  'privacy.reveal': ['在访达中显示', 'Reveal in Finder'],
  'privacy.network': ['联网范围', 'Network scope'],
  'privacy.networkNote': [
    '联网仅发生在向您所选的模型服务发起对话请求时。选择本地推理或免费模型时，对话可完全离线进行。内置浏览器仅加载已批准地址，不会在后台访问任意站点。',
    'Network access happens only when a chat request goes to the model service you chose. With local inference or the free model, conversations run fully offline. The built-in browser loads approved addresses only and never visits arbitrary sites in the background.',
  ],
  'privacy.offline': ['离线能力', 'Offline capability'],
  'privacy.offlineNote': [
    '使用本地或免费模型时，对话、记忆、世界书、知识库与备份均在本机完成，无需网络。此时即使断开网络，全部既有功能仍可使用。',
    'With a local or the free model, conversations, memory, the world book, the knowledge base and backups all run on this machine without network. Even offline, every existing feature keeps working.',
  ],
  'privacy.data': ['数据处理说明', 'How data is handled'],
  'privacy.dataNote': [
    '对话与记忆用于提升陪伴体验，不用于训练任何第三方模型，也不会离开本机，除非您主动导出或恢复。除您选定的模型服务提供商会接收您发送的内容外，不会向其他第三方共享数据。',
    'Conversations and memory exist to improve the companionship experience; they are never used to train third-party models and never leave this machine unless you export or restore them yourself. Apart from the model provider you chose receiving what you send, no data is shared with any third party.',
  ],

  /* --- 应用权限 --- */
  'perm.title': ['应用权限', 'App permissions'],
  'perm.note': [
    '下列权限由操作系统统一管理。本应用仅在对应功能需要时才会使用它们，您可随时在系统设置中收回。此处的「应用权限」与「通用」页的「默认权限」（AI 的能力范围）是两个不同的维度。',
    'The permissions below are managed by the operating system. The app uses them only when the matching feature needs them, and you can revoke them in system settings at any time. These app permissions and the Default permission on the General page (what the AI may touch) are two different dimensions.',
  ],
  'perm.manage': ['在系统设置中管理', 'Manage in System Settings'],
  'perm.footNote': [
    '以上状态来自本应用可感知的范围。若某项显示「由系统授权」，实际授权状态以系统设置为准；点击「在系统设置中管理」可直接跳转对应面板。',
    'The states above reflect what the app can sense. If one says granted-by-system, the authoritative state is the one in system settings; Manage in System Settings jumps straight to the matching pane.',
  ],
  'perm.mic': ['麦克风', 'Microphone'],
  'perm.micPurpose': ['用于语音输入，将您的语音转为文字。首次使用时由系统请求授权。', 'Used for voice input, turning your speech into text. The system asks for access on first use.'],
  'perm.files': ['文件与文件夹', 'Files and folders'],
  'perm.filesPurpose': ['用于读写会话、记忆、世界书、知识库与备份，均存于本机数据目录。', 'Used to read and write sessions, memory, the world book, the knowledge base and backups, all inside the local data directory.'],
  'perm.filesStatus': ['本应用可管理自身数据目录', 'The app manages its own data folder'],
  'perm.network': ['网络', 'Network'],
  'perm.networkPurpose': ['用于连接您所选的模型服务（在线或免费模型）。本地推理与离线模型不依赖网络。', 'Used to reach the model service you chose (online or the free model). Local inference and offline models need no network.'],
  'perm.networkStatus': ['可访问所选模型服务', 'Reaches the chosen model service'],
  'perm.notifications': ['通知', 'Notifications'],
  'perm.notificationsPurpose': ['用于在您离开时提示主动发起的内容（默认关闭）。', 'Used to surface proactive content while you are away (off by default).'],
  'perm.status.granted': ['已授权', 'Granted'],
  'perm.status.denied': ['已拒绝', 'Denied'],
  'perm.status.notYet': ['尚未授权', 'Not granted yet'],
  'perm.status.bySystem': ['由系统授权', 'Granted by the system'],
} satisfies Record<string, Entry>

/** 全部文案键。 */
export type MessageKey = keyof typeof DICT

/**
 * 取一条文案。
 *
 * @param key 文案键。
 * @param params 替换 `{0}` `{1}` 占位符的值，按序对应。
 * @returns 当前语言下的文案。
 */
export function t(key: MessageKey, ...params: Array<string | number>): string {
  const entry: Entry = DICT[key]
  let text = getPreferences().locale === 'en' ? entry[1] : entry[0]
  for (let index = 0; index < params.length; index++) {
    text = text.replaceAll(`{${String(index)}}`, String(params[index]))
  }
  return text
}

/**
 * 订阅语言变化的组件钩子。
 *
 * `t()` 本身读模块级当前值，语言切换后需要有人**重新渲染**才会换成新话。
 * 设置页里大部分组件本来就订阅了偏好（开关、单选都要跟着变），但
 * 知识库、备份这类纯异步页没有订阅——它们显式调一次这个钩子，保证
 * 切语言时整页立即跟着换。
 *
 * @returns 与模块级 `t` 同一引用，直接当函数用。
 */
export function useT(): typeof t {
  useSyncExternalStore(subscribePreferences, getPreferences, getPreferences)
  return t
}
