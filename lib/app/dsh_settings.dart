/// 内核配置桥：把界面上的设置写进**内核真正读的那份文件**。
///
/// ## 为什么必须有这一层
///
/// `prefs.json` 只让「界面记得住」，不让「内核照着做」。实测过后果：
/// 33 个设置项里只有 2 项有消费点，其余 30 项拨了开关也不生效——
/// 界面读得回、落得盘，内核一律按自己的默认值跑，而且两边都不报错。
///
/// 内核的用户配置层在 `~/.ondra/dsh/settings.json`，形状是：
///
/// ```json
/// { "user": { "<插件段 id>": { "<kebab-case 字段>": <值> } } }
/// ```
///
/// 段 id 来自各插件 `settings.ts` 里的 `CONFIG_SECTION_ID`
/// （`ondra-tts` → `tts`、`ondra-memory-decay` → `memory-decay`）。
/// 字段名在文件里是 **kebab**，插件内部转成 camel —— 写错一个键，
/// 内核那边会安静地用默认值，这正是「几个字段巧合生效、其余全不生效」的成因。
///
/// ## 这一层只做一件事
///
/// 把「设置页的键」翻译成「内核的段 + 字段」，读进来、写回去。
/// 它不做界面，也不替内核判合法性——非法值会被内核自己回退到默认值，
/// 那是内核的职责（它有 `completeConfig()` 逐字段夹紧）。
library;

export 'dsh_settings_stub.dart' if (dart.library.io) 'dsh_settings_io.dart';
