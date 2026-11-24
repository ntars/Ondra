#include "flutter_window.h"

#include <dwmapi.h>
#include <flutter/encodable_value.h>
#include <flutter/method_channel.h>
#include <flutter/standard_method_codec.h>
#include <flutter_windows.h>
#include <shlobj.h>
#include <windows.h>
#include <shellapi.h>
#include <string>

#include <optional>

#include "flutter/generated_plugin_registrant.h"
#include "web_view_win.h"

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

// Keeps the Windows sleep assertion alive for exactly as long as Flutter
// claims the preventSleep setting. `ES_SYSTEM_REQUIRED` resets Windows' idle
// timer; re-arming it once a minute is the documented way to hold the system
// awake without changing the user's power plan.
constexpr UINT_PTR kPreventSleepTimerId = 0x4F4E4452;  // "ONDR"
constexpr UINT kPreventSleepIntervalMs = 60 * 1000;

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

namespace {

// Windows toast notifications without a packaged MSIX identity. The shell
// accepts a registered AppUserModelID plus a temporary shortcut in the Start
// menu; creating it once per process keeps later notifications cheap.
constexpr wchar_t kAppUserModelId[] = L"com.ntars.ondra";
constexpr wchar_t kShortcutName[] = L"Ondra.lnk";

std::wstring Utf8ToWide(const std::string& text) {
  if (text.empty()) return {};
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                       text.data(),
                                       static_cast<int>(text.size()), nullptr,
                                       0);
  if (size <= 0) return {};
  std::wstring result(size, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(),
                      static_cast<int>(text.size()), result.data(), size);
  return result;
}

std::wstring PowerShellLiteral(const std::wstring& value) {
  std::wstring out = L"'";
  for (wchar_t c : value) {
    if (c == L'\'') out += L"''";
    else out += c;
  }
  out += L'\'';
  return out;
}

bool EnsureToastShortcut() {
  wchar_t app_data[MAX_PATH] = {};
  if (FAILED(SHGetFolderPathW(nullptr, CSIDL_APPDATA, nullptr, 0, app_data))) {
    return false;
  }
  // Windows binds a toast to the process AppUserModelID, not to the EXE path.
  // Set it on every launch: a stale shortcut from an older build must not make
  // notifications disappear silently (alpha.15 notification regression).
  if (FAILED(SetCurrentProcessExplicitAppUserModelID(kAppUserModelId))) {
    return false;
  }
  const std::wstring shortcut =
      std::wstring(app_data) + L"\\Microsoft\\Windows\\Start Menu\\Programs\\" +
      kShortcutName;
  if (GetFileAttributesW(shortcut.c_str()) != INVALID_FILE_ATTRIBUTES) {
    return true;
  }

  wchar_t exe[MAX_PATH] = {};
  GetModuleFileNameW(nullptr, exe, MAX_PATH);
  const std::wstring script =
      L"$ws = New-Object -ComObject WScript.Shell; "
      L"$s = $ws.CreateShortcut(" +
      PowerShellLiteral(shortcut) +
      L"); $s.TargetPath = " + PowerShellLiteral(exe) +
      L"; $s.Save()";

  SHELLEXECUTEINFOW info = {};
  info.cbSize = sizeof(info);
  info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
  info.lpVerb = L"open";
  info.lpFile = L"powershell.exe";
  info.lpParameters = script.c_str();
  info.nShow = SW_HIDE;
  if (!ShellExecuteExW(&info)) return false;
  if (info.hProcess) {
    WaitForSingleObject(info.hProcess, 5000);
    CloseHandle(info.hProcess);
  }
  if (GetFileAttributesW(shortcut.c_str()) == INVALID_FILE_ATTRIBUTES) {
    return false;
  }
  return true;
}

bool ShowToast(const std::wstring& title, const std::wstring& body,
               bool sound) {
  if (!EnsureToastShortcut()) return false;
  // Windows toast XML uses XML escaping; the PowerShell side only handles
  // quoting, so replace the five XML characters here.
  auto xml_escape = [](const std::wstring& text) {
    std::wstring out;
    out.reserve(text.size());
    for (wchar_t c : text) {
      switch (c) {
        case L'&': out += L"&amp;"; break;
        case L'<': out += L"&lt;"; break;
        case L'>': out += L"&gt;"; break;
        case L'"': out += L"&quot;"; break;
        case L'\'': out += L"&apos;"; break;
        default: out += c; break;
      }
    }
    return out;
  };
  const std::wstring audio =
      sound ? L"<audio src=\"ms-winsoundevent:Notification.Default\" />"
            : L"<audio silent=\"true\" />";
  const std::wstring xml =
      L"<toast><visual><binding template=\"ToastGeneric\"><text>" +
      xml_escape(title) + L"</text><text>" + xml_escape(body) +
      L"</text></binding></visual>" + audio + L"</toast>";
  const std::wstring script =
      L"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI."
      L"Notifications, ContentType = WindowsRuntime] | Out-Null; "
      L"$xml = New-Object Windows.Data.Xml.Dom.XmlDocument; "
      L"$xml.LoadXml(" +
      PowerShellLiteral(xml) +
      L"); $toast = [Windows.UI.Notifications.ToastNotification]::new($xml); "
      L"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(" +
      PowerShellLiteral(kAppUserModelId) + L").Show($toast)";

  SHELLEXECUTEINFOW info = {};
  info.cbSize = sizeof(info);
  info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
  info.lpVerb = L"open";
  info.lpFile = L"powershell.exe";
  info.lpParameters = script.c_str();
  info.nShow = SW_HIDE;
  if (!ShellExecuteExW(&info)) return false;
  if (info.hProcess) {
    WaitForSingleObject(info.hProcess, 5000);
    CloseHandle(info.hProcess);
  }
  return true;
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

  platform_channel_ =
      std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
          flutter_controller_->engine()->messenger(), "ondra/platform",
          &flutter::StandardMethodCodec::GetInstance());
  platform_channel_->SetMethodCallHandler(
      [this](const flutter::MethodCall<flutter::EncodableValue>& call,
             std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>>
                 result) {
        if (call.method_name().compare("beginPreventSleep") == 0) {
          begin_prevent_sleep();
          result->Success(true);
          return;
        }
        if (call.method_name().compare("endPreventSleep") == 0) {
          end_prevent_sleep();
          result->Success();
          return;
        }
        result->NotImplemented();
      });

  notify_channel_ =
      std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
          flutter_controller_->engine()->messenger(), "ondra/notify",
          &flutter::StandardMethodCodec::GetInstance());
  notify_channel_->SetMethodCallHandler(
      [](const flutter::MethodCall<flutter::EncodableValue>& call,
         std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>>
             result) {
        if (call.method_name().compare("show") != 0) {
          result->NotImplemented();
          return;
        }
        const auto* args =
            std::get_if<flutter::EncodableMap>(call.arguments());
        if (args == nullptr) {
          result->Error("bad-arguments", "notification arguments missing");
          return;
        }
        auto string_arg = [args](const char* key) -> std::wstring {
          const auto it = args->find(flutter::EncodableValue(key));
          if (it == args->end()) return {};
          if (const auto* text = std::get_if<std::string>(&it->second)) {
            return Utf8ToWide(*text);
          }
          return {};
        };
        bool sound = true;
        const auto sound_it = args->find(flutter::EncodableValue("sound"));
        if (sound_it != args->end()) {
          if (const auto* value = std::get_if<bool>(&sound_it->second)) {
            sound = *value;
          }
        }
        const bool shown = ShowToast(string_arg("title"), string_arg("body"),
                                     sound);
        if (!shown) {
          result->Error("notify-failed", "Windows toast backend unavailable");
          return;
        }
        result->Success(true);
      });

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    this->Show();
  });

  // WebView2 纹理后端：必须在第一帧之前注册宿主方法通道，否则首屏已经构建
  // 网页视图时才去调用 `ondra/webview/host/create`，会先收到 MissingPlugin，
  // 页面把错误文案定格成「这个构建没有内嵌浏览器」，之后再也没有入口重试。
  // 在通知/睡眠/外观通道之后注册，互不干扰。
  // C++ engine wrapper 的底层 C 句柄是私有成员；通过 GetRegistrarForPlugin
  // 拿到同一 engine 的公开 registrar。FlutterDesktopEngineRef 与
  // FlutterDesktopPluginRegistrarRef 是不同句柄，不能互相 reinterpret_cast。
  // 这里只借用 registrar 的纹理接口，不注册第三方插件。
  auto* plugin_registrar =
      flutter_controller_->engine()->GetRegistrarForPlugin("ondra/webview");
  FlutterDesktopTextureRegistrarRef texture_registrar = nullptr;
  if (plugin_registrar != nullptr) {
    texture_registrar =
        FlutterDesktopRegistrarGetTextureRegistrar(plugin_registrar);
  }
  if (texture_registrar != nullptr) {
    web_view_host_ = std::make_unique<OndraWebViewHost>(
        flutter_controller_->engine()->messenger(), texture_registrar,
        GetHandle());
  } else {
    // 没有纹理后端时也要占用同一方法通道，让 Dart 收到明确错误码而不是
    // MissingPluginException 的误导文案。
    web_view_host_error_channel_ =
        std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
            flutter_controller_->engine()->messenger(), "ondra/webview/host",
            &flutter::StandardMethodCodec::GetInstance());
    web_view_host_error_channel_->SetMethodCallHandler(
        [](const flutter::MethodCall<flutter::EncodableValue>& call,
           std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>>
               result) {
          if (call.method_name() == "create") {
            result->Error("webview-unavailable", "这个构建没有纹理 registrar");
          } else {
            result->NotImplemented();
          }
        });
  }

  // Flutter can complete the first frame before the "show window" callback is
  // registered. The following call ensures a frame is pending to ensure the
  // window is shown. It is a no-op if the first frame hasn't completed yet.
  flutter_controller_->ForceRedraw();

  return true;
}

void FlutterWindow::OnDestroy() {
  end_prevent_sleep();
  web_view_host_.reset();
  web_view_host_error_channel_.reset();
  notify_channel_.reset();
  platform_channel_.reset();
  appearance_channel_.reset();
  if (flutter_controller_) {
    flutter_controller_ = nullptr;
  }

  Win32Window::OnDestroy();
}

void FlutterWindow::begin_prevent_sleep() {
  SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
  if (prevent_sleep_timer_ == 0) {
    prevent_sleep_timer_ = SetTimer(GetHandle(), kPreventSleepTimerId,
                                    kPreventSleepIntervalMs, nullptr);
  }
}

void FlutterWindow::end_prevent_sleep() {
  if (prevent_sleep_timer_ != 0) {
    KillTimer(GetHandle(), kPreventSleepTimerId);
    prevent_sleep_timer_ = 0;
  }
  SetThreadExecutionState(ES_CONTINUOUS);
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

  if (message == WM_TIMER && wparam == kPreventSleepTimerId) {
    SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
    return 0;
  }

  if (message == WM_SIZE && web_view_host_ != nullptr) {
    RECT client = {};
    ::GetClientRect(hwnd, &client);
    web_view_host_->OnParentWindowResized(
        hwnd, static_cast<int>(client.right - client.left),
        static_cast<int>(client.bottom - client.top));
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
