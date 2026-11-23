#ifndef RUNNER_WEB_VIEW_WIN_H_
#define RUNNER_WEB_VIEW_WIN_H_

#include <flutter/binary_messenger.h>
#include <flutter/encodable_value.h>
#include <flutter/method_channel.h>
#include <flutter_windows.h>

#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#ifdef ONDRA_WEBVIEW2_AVAILABLE
#include "WebView2.h"
#include <wrl.h>
#endif

// WebView2 后端：用宿主方法通道创建纹理，并复用每视图的
// `ondra/webview/<id>` 协议。无 SDK 时进入 fallback，只报告错误。
class OndraWebViewHost {
 public:
  explicit OndraWebViewHost(flutter::BinaryMessenger* messenger,
                            FlutterDesktopTextureRegistrarRef textures);
  OndraWebViewHost(flutter::BinaryMessenger* messenger,
                   FlutterDesktopTextureRegistrarRef textures,
                   HWND parent_window);
  ~OndraWebViewHost();

  OndraWebViewHost(const OndraWebViewHost&) = delete;
  OndraWebViewHost& operator=(const OndraWebViewHost&) = delete;

  // 宿主 create 返回的是纹理 ID；视图 ID 另由 Dart 侧生成，协议通道按视图 ID 命名。
  int64_t next_id() const { return next_id_; }

  // 由 Flutter 顶层窗口每次收到 WM_SIZE 时调用；把当前页面尺寸同步给所有
  // WebView2 视图，让 CapturePreview 产出的像素与 Flutter 纹理显示比例一致。
  void OnParentWindowResized(HWND parent, int width, int height);

 private:
  friend class View;
  class View;

  flutter::BinaryMessenger* messenger_;
  FlutterDesktopTextureRegistrarRef textures_;
  HWND parent_window_ = nullptr;
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>> channel_;
  std::unordered_map<int64_t, std::unique_ptr<View>> views_;
  int64_t next_id_ = 1;
};

#endif  // RUNNER_WEB_VIEW_WIN_H_
