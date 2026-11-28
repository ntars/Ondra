# Ondra 内核开发手册 - 第8轮进度报告

## 当前状态：全部通过

- **验证命令**：`flutter test --no-pub` 589 passed / 4 skipped / 0 failed
- **Node 套件**：plugin_boot_integration_test.mjs (4/4) + workspace_sandbox_test.mjs (3/3) 全绿
- **门禁**：`flutter analyze --no-pub` No issues found

## F01-F19 文件清单状态

| 编号 | 手册路径 | 实际路径 | 状态 |
|------|----------|----------|------|
| F01 | profiles/konggu/cordis.yml | plugin-profile/cordis.yml | ✓ |
| F02 | profiles/konggu/package.json | plugin-profile/package.json | ✓ |
| F03 | profiles/konggu/cordis.patch.yml | plugin-profile/cordis.patch.yml | ✓ |
| F04 | tool/probe.mjs | tool/probe.mjs | ✓ |
| F05 | lib/chat/transport/rpc_frames.dart | lib/plugins/ondra-core/ondra-ui/ondra-chat/ui/transport/rpc_frames.dart | ✓ |
| F06 | lib/chat/transport/stdio_transport_io.dart | lib/plugins/ondra-core/ondra-ui/ondra-chat/ui/transport/stdio_transport_io.dart | ✓ |
| F07 | lib/chat/transport/stdio_transport.dart | lib/plugins/ondra-core/ondra-ui/ondra-chat/ui/transport/stdio_transport.dart | ✓ |
| F08 | lib/chat/transport/stdio_transport_stub.dart | lib/plugins/ondra-core/ondra-ui/ondra-chat/ui/transport/stdio_transport_stub.dart | ✓ |
| F09 | lib/chat/chat_client.dart | lib/plugins/ondra-core/ondra-ui/ondra-chat/ui/chat_client.dart | ✓ |
| F10 | lib/app/bundled_runtime.dart | lib/app/bundled_runtime.dart | ✓ |
| F11 | lib/app/runtime_seed.dart | lib/app/runtime_seed.dart | ✓ |
| F12 | lib/app/dsh_settings.dart | lib/app/dsh_settings.dart | ✓ |
| F13 | lib/app/data_root_io.dart | lib/app/data_root_io.dart | ✓ |
| F14 | lib/app/crash_log_io.dart | lib/app/crash_log_io.dart | ✓ |
| F15 | lib/plugins/ondra-settings/model_client.dart | lib/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/model_client.dart | ✓ |
| F16 | lib/plugins/ondra-settings/model_types.dart | lib/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/model_types.dart | ✓ |
| F17 | lib/plugins/ondra-settings/console_sheet.dart | lib/plugins/ondra-core/ondra-ui/ondra-settings/ui/console_sheet.dart | ✓ |
| F18 | lib/app/model_warmup.dart | lib/app/model_warmup.dart | ✓ |
| F19 | test/settings_models_ui_test.dart | test/settings_models_ui_test.dart | ✓ |

## 第14章真机验收要求

- **Android**：jniLibs/arm64-v8a/ 11 个 .so + assets/ondra-dsh.zip 已存在
- **iOS**：默认 R3（远程内核），本地内核实验分支，不进承诺矩阵
- **OHOS**：待生成（Flutter 端口不可用）
- **Web**：flutter build web --release ✓

## 待处理事项

1. Android 真机握手（无设备/模拟器连接）
2. iOS 完整 Xcode 缺失（仅 CommandLineTools）
3. OHOS 端口生成

## 决策记录索引

- docs/decisions/D-001 至 D-010（覆盖附录 F 所有问题）

## 证据文档索引

- docs/kernel-replication-evidence.md（含 P5 预热实测、P6 runtime 大小、门禁结果）
- docs/features.md（§15.6 第5步，9类功能登记）
- docs/platforms.md（多端发布状态）

---
*生成时间：2026-11-28T20:50:00+08:00*
