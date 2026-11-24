/// 产品标识与版本。
///
/// 版本标记为 3.0.0-alpha：随包运行时就位，装上不用再另装 Node 与内核。
/// pubspec 里的 `version: 3.0.0-alpha+1` 与此处保持一致（+1 是构建号）。
///
/// 为什么是 3 而不是 2.1：这一版改的是**交付形态**，不是功能增量。2.x 的承诺是
/// 「纯前端骨架、需要自己装运行时」，3.x 变成「双击就能说话」。用户能感知到的
/// 分界就在「要不要自己装东西」这一条上。
///
/// 名字分两个：对外叫「空谷 Ondra」（窗口标题、应用名、关于页），
/// 界面里的品牌锁定用短名「空谷」——两栏侧栏只有 200 宽，全名会把菜单挤窄。
const String ondraAppName = '空谷 Ondra';
const String ondraProductName = '空谷';

/// 开机语：一句话说清空谷是什么。
///
/// 刻意不写「AI 助手 / 智能助理」：那是所有产品都会写的词，写上去等于没写。
/// 这五个字说的是空谷的两个本事——记住你说过的话，并且能替你动手。
const String ondraSlogan = '记得住，也帮得上';

const String ondraVersion = '3.0.0-alpha';
const String ondraBuild = '17';

/// 「关于」里的一句话阶段说明。
///
/// 2.x 写的是「前端骨架 · 未接入后端」——那时候内核确实还没接上。现在包内自带
/// Node + dsh + 插件，走的是本机 stdio，还写「未接入」就是错的。
const String ondraStage = '随包内核 · 本机运行';

/// 人设名不在这里：它由 Cordis 运行时的 `ondra-persona` 插件给出，
/// 界面读 `plugins/ondra-core/ondra-ui/ondra-settings/ondra-persona/ui/persona_client.dart`
/// 的 `personaClient`。切人设是运行期行为，常量做不到。

/// 调试端口：开发期预览服务从这里起，被占用则顺延到下一个可用端口。
const int ondraDebugPort = 9060;

/// 主窗尺寸。默认值**与最小尺寸同值**：每次启动都按 960×600 打开，
/// 用户可以把窗口拉大，但拉不到比这更小，也不会记住上次的尺寸。
///
/// 960 是三栏成立的下限：左 200 + 右 280 之后，中栏还剩 480，
/// 再窄一行列表就开始挤了。
const double ondraWindowWidth = 960;
const double ondraWindowHeight = 600;
const double ondraWindowMinWidth = 960;
const double ondraWindowMinHeight = 600;
