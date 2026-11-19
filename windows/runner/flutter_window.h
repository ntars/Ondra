#ifndef RUNNER_FLUTTER_WINDOW_H_
#define RUNNER_FLUTTER_WINDOW_H_

#include <flutter/dart_project.h>
#include <flutter/encodable_value.h>
#include <flutter/flutter_view_controller.h>
#include <flutter/method_channel.h>

#include <memory>

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

  // The project to run.
  flutter::DartProject project_;

  // The Flutter instance hosted by this window.
  std::unique_ptr<flutter::FlutterViewController> flutter_controller_;

  // The `ondra/window` method channel.
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>>
      appearance_channel_;

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
