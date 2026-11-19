#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>
#include <windows.h>

#include "flutter_window.h"
#include "utils.h"

int APIENTRY wWinMain(_In_ HINSTANCE instance, _In_opt_ HINSTANCE prev,
                      _In_ wchar_t *command_line, _In_ int show_command) {
  // Attach to console when present (e.g., 'flutter run') or create a
  // new console when running with a debugger.
  if (!::AttachConsole(ATTACH_PARENT_PROCESS) && ::IsDebuggerPresent()) {
    CreateAndAttachConsole();
  }

  // Initialize COM, so that it is available for use in the library and/or
  // plugins.
  ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  flutter::DartProject project(L"data");

  std::vector<std::string> command_line_arguments =
      GetCommandLineArguments();

  project.set_dart_entrypoint_arguments(std::move(command_line_arguments));

  FlutterWindow window(project);
  Win32Window::Point origin(10, 10);
  // 与 macOS 同一个基线：960×600。
  //
  // 模板默认是 1280×720，那是 Flutter 的示例尺寸。三栏的排版基线写在
  // `lib/app/version.dart` 的 `ondraWindowWidth/Height`（960×600），
  // 两个平台用同一个值，页面在两端才是同一套版式——否则 Windows 上多出来
  // 的 320px 会让中栏白得发空，而设计时没按那个宽度调过。
  Win32Window::Size size(960, 600);
  // 标题用产品名，不是包名。模板的 `L"ondra"` 是工程名，出现在任务栏和
  // Alt+Tab 里；macOS 那边窗口标题是「空谷」。
  if (!window.Create(L"空谷 Ondra", origin, size)) {
    return EXIT_FAILURE;
  }
  window.SetQuitOnClose(true);

  ::MSG msg;
  while (::GetMessage(&msg, nullptr, 0, 0)) {
    ::TranslateMessage(&msg);
    ::DispatchMessage(&msg);
  }

  ::CoUninitialize();
  return EXIT_SUCCESS;
}
