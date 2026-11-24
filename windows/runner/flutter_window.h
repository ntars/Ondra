#ifndef RUNNER_FLUTTER_WINDOW_H_
#define RUNNER_FLUTTER_WINDOW_H_

#include <flutter/dart_project.h>
#include <flutter/encodable_value.h>
#include <flutter/flutter_view_controller.h>
#include <flutter/method_channel.h>

#include <cstdint>
#include <memory>

#include "web_view_win.h"
#include "win32_window.h"

// A window that does nothing but host a Flutter view.
class FlutterWindow : public Win32Window {
 public:
  // Creates a new FlutterWindow hosting a Flutter view running |project|.
  explicit FlutterWindow(const flutter::DartProject& project);
  virtual ~FlutterWindow();

 protected:
  // Win32Window:
  bool OnCreate() override;
  void OnDestroy() override;
  LRESULT MessageHandler(HWND window, UINT const message, WPARAM const wparam,
                         LPARAM const lparam) noexcept override;

 private:
  // 接 Dart 侧 `ondra/window` 通道的 `setAppearance`。
  //
  // Dart 那边只发一个 bool（当前是不是深色）。Windows 没有 AppKit 那层玻璃，
  // 但**标题栏**是系统画的，它跟着 `DWMWA_USE_IMMERSIVE_DARK_MODE` 走：
  // 不接这一下，切到深色后是「深色画布 + 亮白色标题栏」，比不切还难看。
  void SetWindowAppearance(bool dark);

  // `ondra/platform` 的 Windows 睡眠断言。timer 让 ES_SYSTEM_REQUIRED
  // 持续被重新武装；窗口销毁时无条件撤掉，避免留下系统级状态。
  void begin_prevent_sleep();
  void end_prevent_sleep();

  // The project to run.
  flutter::DartProject project_;

  // The Flutter instance hosted by this window.
  std::unique_ptr<flutter::FlutterViewController> flutter_controller_;

  // The `ondra/window` method channel.
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      appearance_channel_;

  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      platform_channel_;

  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      notify_channel_;

  std::unique_ptr<::OndraWebViewHost> web_view_host_;
  // `ondra/webview` 不是 GeneratedPluginRegistrant 里的插件；若宿主构建拿不到
  // texture registrar，也必须先占用方法通道，避免 Dart 把 MissingPlugin 误报成
  // 「这个构建没有内嵌浏览器」。
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      web_view_host_error_channel_;

  UINT_PTR prevent_sleep_timer_ = 0;

  // Dart 有没有**明确指定**过明暗。
  //
  // 为什么需要这个标记：`win32_window.cpp` 的 `UpdateTheme()` 在
  // `WM_DWMCOLORIZATIONCOLORCHANGED` 时会按**系统**亮度重设标题栏。而空谷的
  // 主题是「浅色 / 深色 / 跟随系统」三选一——用户选了「强制深色」而系统是
  // 浅色时，系统一改强调色，标题栏就会被拽回白色，与深色画布错层。
  // 所以只要 Dart 指定过一次，就以它为准，不再让 `UpdateTheme` 覆盖。
  bool appearance_forced_ = false;
  bool appearance_dark_ = false;
};

#endif  // RUNNER_FLUTTER_WINDOW_H_
