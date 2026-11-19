#include "flutter_window.h"

#include <dwmapi.h>
#include <flutter_windows.h>
#include <windows.h>

#include <optional>

#include "flutter/generated_plugin_registrant.h"

namespace {

// 窗口最小尺寸：与 macOS 的 `contentMinSize` 同一个值。
//
// 960×600 是三栏成立的下限（左 200 + 右 280 之后中栏还剩 480），
// 写在 `lib/app/version.dart` 的 `ondraWindowWidth/Height` 里。macOS 那边
// 由 `MainFlutterWindow.swift` 的 `contentMinSize` 设，这里补上 Windows 的
// 对应实现——模板默认不设最小尺寸，用户可以把它拖成一条竖线，三栏会先
// 挤成畸形再溢出。
constexpr int kMinWindowWidth = 960;
constexpr int kMinWindowHeight = 600;

void ApplyDarkTitleBar(HWND hwnd, bool dark) {
  BOOL value = dark ? TRUE : FALSE;
  // DWMWA_USE_IMMERSIVE_DARK_MODE 的号在 SDK 里是 20（1809 时代是 19）。
  // 这里直接用同工程 `win32_window.cpp` 已经在用的那个枚举值，不另写数字：
  // 两处用同一个来源，升级 SDK 时才不会一半跟上、一半没跟上。
  if (FAILED(DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &value,
                                   sizeof(value)))) {
    // 老系统（1809/1903）只认 19，失败再试一次。都失败就放弃：
    // 标题栏配色不该影响窗口能不能用。
    constexpr DWORD kLegacy = 19;
    DwmSetWindowAttribute(hwnd, kLegacy, &value, sizeof(value));
  }
}

}  // namespace

FlutterWindow::FlutterWindow(const flutter::DartProject& project)
    : project_(project) {}

FlutterWindow::~FlutterWindow() {}

bool FlutterWindow::OnCreate() {
  if (!Win32Window::OnCreate()) {
    return false;
  }

  RECT frame = GetClientArea();

  // The size here must match the window dimensions to avoid unnecessary surface
  // creation / destruction in the startup path.
  flutter_controller_ = std::make_unique<flutter::FlutterViewController>(
      frame.right - frame.left, frame.bottom - frame.top, project_);
  // Ensure that basic setup of the controller was successful.
  if (!flutter_controller_->engine() || !flutter_controller_->view()) {
    return false;
  }
  RegisterPlugins(flutter_controller_->engine());
  SetChildContent(flutter_controller_->view()->GetNativeWindow());

  // 明暗通道：与 macOS 的 `ondra/window` 同名同参（一个 bool）。
  //
  // Dart 侧 `window_appearance_io.dart` 只在亮度真的变化时发一次，而且
  // **把失败吞掉了**——没有接收方时它不报错，只是静默什么都不做。
  // 所以这条通道必须在原生侧真的接上，否则「深色画布 + 亮白标题栏」
  // 这种错层在现场看不出来：画布确实变深了，只有边框没变。
  appearance_channel_ =
      std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
          flutter_controller_->engine()->messenger(), "ondra/window",
          &flutter::StandardMethodCodec::GetInstance());
  appearance_channel_->SetMethodCallHandler(
      [this](const flutter::MethodCall<flutter::EncodableValue>& call,
             std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>>
                 result) {
        if (call.method_name().compare("setAppearance") != 0) {
          result->NotImplemented();
          return;
        }
        // 参数是 Dart 那边直接传的 bool；读不到就当浅色，不抛。
        bool dark = false;
        if (const auto* value = std::get_if<bool>(call.arguments())) {
          dark = *value;
        }
        SetWindowAppearance(dark);
        result->Success();
      });

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    this->Show();
  });

  // Flutter can complete the first frame before the "show window" callback is
  // registered. The following call ensures a frame is pending to ensure the
  // window is shown. It is a no-op if the first frame hasn't completed yet.
  flutter_controller_->ForceRedraw();

  return true;
}

void FlutterWindow::OnDestroy() {
  appearance_channel_.reset();
  if (flutter_controller_) {
    flutter_controller_ = nullptr;
  }

  Win32Window::OnDestroy();
}

void FlutterWindow::SetWindowAppearance(bool dark) {
  HWND hwnd = GetHandle();
  if (hwnd == nullptr) {
    return;
  }
  appearance_forced_ = true;
  appearance_dark_ = dark;
  ApplyDarkTitleBar(hwnd, dark);
  // 让非客户区（标题栏 / 边框）重画一次，否则新的深浅色要等下次系统重绘
  // 才生效，表现为「切了主题，边框过几秒才变」。
  SetWindowPos(hwnd, nullptr, 0, 0, 0, 0,
               SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
  InvalidateRect(hwnd, nullptr, TRUE);
}

LRESULT
FlutterWindow::MessageHandler(HWND hwnd, UINT const message,
                              WPARAM const wparam,
                              LPARAM const lparam) noexcept {
  // 系统强调色变化时，基类会把标题栏按**系统**亮度重设（`UpdateTheme`）。
  // 只要 Dart 指定过明暗，就以应用的选择为准，并把标题栏改回去。
  //
  // 这一步不能省：用户选「强制深色」而系统是浅色时，系统换一次壁纸的
  // 强调色，标题栏就会自己变白，而画布还是深的。
  if (message == WM_DWMCOLORIZATIONCOLORCHANGED && appearance_forced_) {
    ApplyDarkTitleBar(hwnd, appearance_dark_);
    return 0;
  }

  // 最小尺寸：按 DPI 缩放后再钳住，否则高分屏上 960 物理像素只有 640 逻辑宽，
  // 三栏照样挤坏。
  if (message == WM_GETMINMAXINFO) {
    auto* info = reinterpret_cast<MINMAXINFO*>(lparam);
    // 与 `win32_window.cpp` 的 `Create()` 同一套取 DPI 的方式：
    // 用 MonitorFromWindow + FlutterDesktopGetDpiForMonitor，不用
    // GetDpiForWindow（那是 Win10 1607 才有的 API，而这里没必要为了一个
    // 尺寸钳制去抬系统的下限）。
    const HMONITOR monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    const UINT dpi = FlutterDesktopGetDpiForMonitor(monitor);
    const double scale = dpi == 0 ? 1.0 : dpi / 96.0;
    info->ptMinTrackSize.x = static_cast<LONG>(kMinWindowWidth * scale);
    info->ptMinTrackSize.y = static_cast<LONG>(kMinWindowHeight * scale);
    return 0;
  }

  // Give Flutter, including plugins, an opportunity to handle window messages.
  if (flutter_controller_) {
    std::optional<LRESULT> result =
        flutter_controller_->HandleTopLevelWindowProc(hwnd, message, wparam,
                                                      lparam);
    if (result) {
      return *result;
    }
  }

  switch (message) {
    case WM_FONTCHANGE:
      flutter_controller_->engine()->ReloadSystemFonts();
      break;
  }

  return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
}
