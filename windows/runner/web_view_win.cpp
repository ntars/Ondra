#include "web_view_win.h"

#include <flutter/standard_method_codec.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <thread>
#include <utility>
#include <vector>

#ifdef ONDRA_WEBVIEW2_AVAILABLE
#define INITGUID
#include "WebView2.h"
#include <wincodec.h>
#include <wrl.h>
#undef INITGUID
#endif

namespace {

constexpr char kHostChannel[] = "ondra/webview/host";
constexpr char kRejectedReason[] =
    "已阻止导航：目标的协议、主机或端口不在白名单里。";
constexpr char kInvalidReason[] =
    "已阻止导航：只允许合法且不含凭据的 http(s) 地址。";
constexpr char kDowngradeReason[] = "已阻止导航：不允许从 HTTPS 降级到 HTTP。";
constexpr int kTextureWidth = 1280;
constexpr int kTextureHeight = 720;
constexpr int kCaptureIntervalMs = 200;  // 5 fps：够用且不会把 UI 线程喂满。

// 捕获请求的序号。CapturePreview 完成回调可能晚于下一次请求到达；只接受
// 与当前请求序号一致的结果，避免旧 PNG 写进新帧。
constexpr uint64_t kPendingCapture = UINT64_MAX;

std::string Utf16ToUtf8(const std::wstring& text) {
  if (text.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, text.data(),
                                       static_cast<int>(text.size()), nullptr,
                                       0, nullptr, nullptr);
  if (size <= 0) return {};
  std::string result(size, '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                      result.data(), size, nullptr, nullptr);
  return result;
}

std::wstring Utf8ToUtf16(const std::string& text) {
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

std::string Lower(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return value;
}

// 把 BGRA 原地转成 Flutter 像素纹理需要的 RGBA；alpha 保持 WebView2 的页面
// 输出（正常站点是不透明的），不能凭空把透明当白色。
void BgraToRgba(std::vector<uint8_t>& pixels) {
  for (size_t i = 0; i + 3 < pixels.size(); i += 4) {
    std::swap(pixels[i], pixels[i + 2]);
  }
}

struct Origin {
  std::string scheme;
  std::string host;
  int port = 0;

  bool operator==(const Origin& other) const {
    return scheme == other.scheme && host == other.host && port == other.port;
  }
};

// 与 Dart 的 BrowserClient._webUri /  macOS 的 OndraBrowserOrigin 对齐：
// http(s)、无凭据、无百分号、严格 host/IP、端口 1..65535。
Origin ParseOrigin(const std::string& input) {
  Origin invalid;
  if (input.empty() ||
      std::any_of(input.begin(), input.end(), [](unsigned char c) {
        return std::isspace(c) || std::iscntrl(c) || c == '\\' || c == '%';
      })) {
    return invalid;
  }
  const auto scheme_end = input.find("://");
  if (scheme_end == std::string::npos) return invalid;
  Origin result;
  result.scheme = Lower(input.substr(0, scheme_end));
  if (result.scheme != "http" && result.scheme != "https") return invalid;

  const size_t authority_begin = scheme_end + 3;
  const size_t authority_end = input.find_first_of("/?#", authority_begin);
  const std::string authority =
      input.substr(authority_begin, authority_end - authority_begin);
  if (authority.empty() || authority.find('@') != std::string::npos) {
    return invalid;
  }

  std::string host;
  int port = 0;
  if (authority.front() == '[') {
    const size_t bracket = authority.find(']');
    if (bracket == std::string::npos || bracket == 1) return invalid;
    host = Lower(authority.substr(0, bracket + 1));
    if (std::any_of(host.begin() + 1, host.end() - 1, [](unsigned char c) {
          return !std::isxdigit(c) && c != ':';
        })) {
      return invalid;
    }
    if (bracket + 1 < authority.size()) {
      if (authority[bracket + 1] != ':') return invalid;
      port = std::atoi(authority.c_str() + bracket + 2);
    }
  } else {
    const size_t colon = authority.find(':');
    host = Lower(authority.substr(0, colon));
    if (colon != std::string::npos) {
      port = std::atoi(authority.c_str() + colon + 1);
    }
    if (host.empty() || host.size() > 253) return invalid;
    size_t start = 0;
    bool dotted_ip = true;
    while (start <= host.size()) {
      const size_t dot = host.find('.', start);
      const std::string label =
          host.substr(start, dot == std::string::npos ? std::string::npos
                                                      : dot - start);
      if (label.empty() || label.size() > 63 ||
          !std::isalnum(static_cast<unsigned char>(label.front())) ||
          !std::isalnum(static_cast<unsigned char>(label.back()))) {
        return invalid;
      }
      for (const unsigned char c : label) {
        if (!std::isalnum(c) && c != '-') return invalid;
      }
      if (label.find_first_not_of("0123456789") == std::string::npos) {
        if (label.size() > 1 && label.front() == '0') return invalid;
        if (std::atoi(label.c_str()) > 255) return invalid;
      } else {
        dotted_ip = false;
      }
      if (dot == std::string::npos) break;
      start = dot + 1;
    }
    if (dotted_ip && std::count(host.begin(), host.end(), '.') != 3) {
      return invalid;
    }
  }
  if (port == 0) {
    port = result.scheme == "https" ? 443 : 80;
  }
  if (port < 1 || port > 65535) return invalid;
  result.host = host;
  result.port = port;
  return result;
}

// 不回传完整 URL，避免把 URL 里的潜在密钥显示到错误栏。
void SendError(flutter::BinaryMessenger* messenger, int64_t id,
               const char* method, const char* reason) {
  const auto channel = std::make_unique<flutter::MethodChannel<
      flutter::EncodableValue>>(
      messenger, "ondra/webview/" + std::to_string(id),
      &flutter::StandardMethodCodec::GetInstance());
  channel->InvokeMethod(
      method, std::make_unique<flutter::EncodableValue>(flutter::EncodableMap{
                  {flutter::EncodableValue("reason"),
                   flutter::EncodableValue(reason)}}));
}

}  // namespace

#ifndef ONDRA_WEBVIEW2_AVAILABLE
// 离线/SDK 缺失时只给出空白帧，并由 `start` 报告原因；绝不静默加载网页。
static const FlutterDesktopPixelBuffer* EmptyPixels(size_t width,
                                                    size_t height,
                                                    void* user_data) {
  static std::vector<uint8_t> empty;
  empty.assign(width * height * 4, 0);
  auto* buffer = static_cast<FlutterDesktopPixelBuffer*>(user_data);
  buffer->buffer = empty.data();
  buffer->width = width;
  buffer->height = height;
  return buffer;
}
#endif

class OndraWebViewHost::View {
 public:
  void HandleCall(const flutter::MethodCall<flutter::EncodableValue>& call,
                  std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);

  View(flutter::BinaryMessenger* messenger,
       FlutterDesktopTextureRegistrarRef textures, int64_t id,
       const flutter::EncodableMap& params, HWND parent_window)
      : messenger_(messenger), id_(id), texture_registrar_(textures) {
    parent_window_ = parent_window;
    const auto url_it = params.find(flutter::EncodableValue("url"));
    if (url_it != params.end()) {
      if (const auto* url = std::get_if<std::string>(&url_it->second)) {
        initial_url_ = *url;
        requires_https_ = ParseOrigin(*url).scheme == "https";
      }
    }
    const auto sites_it = params.find(flutter::EncodableValue("allowedSites"));
    if (sites_it != params.end()) {
      if (const auto* sites = std::get_if<flutter::EncodableList>(
              &sites_it->second)) {
        for (const auto& site : *sites) {
          if (const auto* text = std::get_if<std::string>(&site)) {
            const Origin origin = ParseOrigin(*text);
            if (!origin.host.empty()) allowed_.push_back(origin);
          }
        }
      }
    }

    FlutterDesktopTextureInfo info = {};
    info.type = kFlutterDesktopPixelBufferTexture;
#ifdef ONDRA_WEBVIEW2_AVAILABLE
    info.pixel_buffer_config.callback = &View::CopyPixels;
    info.pixel_buffer_config.user_data = this;
#else
    info.pixel_buffer_config.callback = &EmptyPixels;
    info.pixel_buffer_config.user_data = &pixel_buffer_;
#endif
    texture_id_ = FlutterDesktopTextureRegistrarRegisterExternalTexture(
        texture_registrar_, &info);

    channel_ = std::make_unique<flutter::MethodChannel<
        flutter::EncodableValue>>(
        messenger, "ondra/webview/" + std::to_string(id),
        &flutter::StandardMethodCodec::GetInstance());
    channel_->SetMethodCallHandler(
        [this](const auto& call, auto result) { HandleCall(call, std::move(result)); });
  }

  ~View() {
    if (channel_) channel_->SetMethodCallHandler(nullptr);
    {
      std::lock_guard<std::mutex> lock(capture_mutex_);
      capture_stop_.store(true);
    }
    capture_cv_.notify_all();
    if (capture_thread_.joinable()) capture_thread_.join();
#ifdef ONDRA_WEBVIEW2_AVAILABLE
    if (web_view_ != nullptr) {
      web_view_->remove_FrameNavigationStarting(frame_token_);
      web_view_->remove_NewWindowRequested(new_window_token_);
      web_view_->remove_NavigationCompleted(navigation_completed_token_);
    }
    if (controller_) controller_->Close();
    web_view_.Reset();
    if (host_window_ != nullptr) DestroyWindow(host_window_);
#endif
    if (texture_registrar_ && texture_id_ >= 0) {
      FlutterDesktopTextureRegistrarUnregisterExternalTexture(
          texture_registrar_, texture_id_, nullptr, nullptr);
    }
  }

  int64_t texture_id() const { return texture_id_; }

  HWND host_window() const {
#ifdef ONDRA_WEBVIEW2_AVAILABLE
    return host_window_;
#else
    return nullptr;
#endif
  }

  void Resize(int width, int height) {
#ifdef ONDRA_WEBVIEW2_AVAILABLE
    const auto w = width > 0 ? width : kTextureWidth;
    const auto h = height > 0 ? height : kTextureHeight;
    {
      std::lock_guard<std::mutex> lock(capture_mutex_);
      if (frame_width_ == w && frame_height_ == h) return;
      frame_width_ = w;
      frame_height_ = h;
      // 尺寸变了先回退到不透明占位，避免旧帧被缩放到新尺寸造成花屏。
      frame_bytes_.assign(static_cast<size_t>(w) * h * 4, 0);
      std::fill(frame_bytes_.begin() + 3, frame_bytes_.end(), 255);
    }
    {
      std::lock_guard<std::mutex> lock(buffer_mutex_);
      pixel_buffer_.buffer = frame_bytes_.data();
      pixel_buffer_.width = w;
      pixel_buffer_.height = h;
    }
    if (controller_ != nullptr) {
      RECT rect = {0, 0, w, h};
      controller_->put_Bounds(rect);
    }
    if (host_window_ != nullptr) {
      MoveWindow(host_window_, 0, 0, w, h, TRUE);
    }
    capture_width_.store(w);
    capture_height_.store(h);
    FlutterDesktopTextureRegistrarMarkExternalTextureFrameAvailable(
        texture_registrar_, texture_id_);
#endif
  }

  void HandleCall(
      const flutter::MethodCall<flutter::EncodableValue>& call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
    if (call.method_name() == "start") {
#ifdef ONDRA_WEBVIEW2_AVAILABLE
      if (!started_ && !stopped_) {
        started_ = true;
        if (!Permit(initial_url_)) {
          result->Success();
          return;
        }
        InitializeWebView();
      }
#else
      SendError(messenger_, id_, "loadFailed",
                "此构建未编译 WebView2 后端（缺少 Microsoft.Web.WebView2 SDK）");
#endif
      result->Success();
      return;
    }
    if (call.method_name() == "stop") {
      stopped_ = true;
      {
        std::lock_guard<std::mutex> lock(capture_mutex_);
        capture_stop_.store(true);
      }
      capture_cv_.notify_all();
#ifdef ONDRA_WEBVIEW2_AVAILABLE
      if (web_view_) web_view_->Stop();
#endif
      result->Success();
      return;
    }
    result->NotImplemented();
  }

 private:
  flutter::BinaryMessenger* messenger_;
  int64_t id_;
  FlutterDesktopTextureRegistrarRef texture_registrar_;
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>> channel_;
  int64_t texture_id_ = -1;
  std::string initial_url_;
  std::vector<Origin> allowed_;
  int frame_width_ = kTextureWidth;
  int frame_height_ = kTextureHeight;
  std::vector<uint8_t> frame_bytes_;
  bool requires_https_ = false;
  bool started_ = false;
  bool stopped_ = false;
  HWND parent_window_ = nullptr;
  std::atomic<bool> capture_stop_{false};
  std::atomic<uint64_t> capture_done_{kPendingCapture};
  std::atomic<uint64_t> next_capture_id_{0};
  std::mutex capture_mutex_;
  std::mutex buffer_mutex_;
  std::condition_variable capture_cv_;
  std::thread capture_thread_;
  std::atomic<int> capture_width_{kTextureWidth};
  std::atomic<int> capture_height_{kTextureHeight};
  FlutterDesktopPixelBuffer pixel_buffer_ = {};
#ifdef ONDRA_WEBVIEW2_AVAILABLE
  Microsoft::WRL::ComPtr<ICoreWebView2> web_view_;
  Microsoft::WRL::ComPtr<ICoreWebView2Controller> controller_;
  HWND host_window_ = nullptr;
  EventRegistrationToken frame_token_{};
  EventRegistrationToken new_window_token_{};
  EventRegistrationToken navigation_completed_token_{};
#endif

#ifdef ONDRA_WEBVIEW2_AVAILABLE
  // Flutter 的渲染线程直接读这个缓冲。回调只交换共享状态，PNG 解码/缩放
  // 交给专用的 capture 线程，避免阻塞 UI 或 WebView2 的消息循环。
  static const FlutterDesktopPixelBuffer* CopyPixels(size_t width,
                                                     size_t height,
                                                     void* user_data) {
    auto* view = static_cast<View*>(user_data);
    std::lock_guard<std::mutex> lock(view->buffer_mutex_);
    // 渲染线程按需取尺寸；这里直接报告引擎请求的物理像素数，避免 1280x720
    // 固定尺寸与容器不一致导致的拉伸。真正的图像由 CaptureFrame 缩放。
    view->pixel_buffer_.width = width;
    view->pixel_buffer_.height = height;
    return &view->pixel_buffer_;
  }

  // WebView2 在 NavigationCompleted 后取一帧；之后按固定间隔刷新，覆盖异步
  // 渲染、滚动和动画。CapturePreview 产 PNG，WIC 解码成 32bpp PBGRA 后再转 RGBA。
  void ScheduleCapture() {
    std::lock_guard<std::mutex> lock(capture_mutex_);
    if (capture_thread_.joinable()) return;
    // 线程一旦 join 就不能重新启动；stop 后视图会被 Dart 侧重建，
    // 新 View 会拿到新的 capture_thread_。
    if (capture_stop_.load()) return;
    capture_thread_ = std::thread([this] { CaptureLoop(); });
  }

  void CaptureLoop() {
    // WebView2 的回调在 UI 线程，std::thread 是 MTA；显式切到 STA 才能使用
    // WIC 的 COM 工厂。CoInitialize 失败时不假装页面已经上屏。
    if (FAILED(::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return;
    while (true) {
      {
        std::unique_lock<std::mutex> lock(capture_mutex_);
        if (capture_stop_.load()) break;
      }
      const HRESULT hr = CaptureFrame();
      if (SUCCEEDED(hr)) {
        FlutterDesktopTextureRegistrarMarkExternalTextureFrameAvailable(
            texture_registrar_, texture_id_);
      }
      std::unique_lock<std::mutex> lock(capture_mutex_);
      capture_cv_.wait_for(lock, std::chrono::milliseconds(kCaptureIntervalMs),
                           [this] { return capture_stop_.load(); });
    }
    ::CoUninitialize();
  }

  HRESULT CaptureFrame() {
    Microsoft::WRL::ComPtr<ICoreWebView2> view;
    {
      std::lock_guard<std::mutex> lock(capture_mutex_);
      view = web_view_;
    }
    if (!view) return S_FALSE;
    Microsoft::WRL::ComPtr<IStream> stream;
    if (FAILED(::CreateStreamOnHGlobal(nullptr, TRUE, &stream))) return E_FAIL;
    STATSTG stats = {};
    const uint64_t capture_id = next_capture_id_.fetch_add(1);
    capture_done_.store(kPendingCapture);
    // 完成回调持有 view，跨线程调用时不会在本方法退出后变成悬空引用。
    Microsoft::WRL::ComPtr<ICoreWebView2> captured_view = view;
    const HRESULT request = view->CapturePreview(
        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, stream.Get(),
        Microsoft::WRL::Callback<
            Microsoft::WRL::ICoreWebView2CapturePreviewCompletedHandler>(
                [this, captured_view, capture_id](HRESULT error) -> HRESULT {
                  // 只有成功完成才发布帧；失败让本轮等待超时，不写入半张 PNG。
                  if (SUCCEEDED(error)) {
                    capture_done_.store(capture_id);
                  }
                  return error;
                }).Get());
    if (FAILED(request)) return request;

    // CapturePreview 是异步的；捕获线程等待完成标记后再交给 WIC 解码。
    if (!WaitForCapture(capture_id)) return E_FAIL;
    // WebView2 在 UI 线程写 stream；等完成标记后取最终大小再回到起点。
    if (FAILED(stream->Stat(&stats, STATFLAG_DEFAULT))) return E_FAIL;
    LARGE_INTEGER zero = {};
    if (FAILED(stream->Seek(zero, STREAM_SEEK_SET, nullptr))) return E_FAIL;
    if (stats.cbSize.QuadPart <= 0 ||
        stats.cbSize.QuadPart > 64LL * 1024 * 1024) {
      return E_FAIL;
    }
    return DecodePngToFrame(stream.Get());
  }

  // 完成回调由 WebView2 在 UI 线程置位；捕获线程轮询有界，不会把失败伪装成
  // 成功帧。每次请求前先清掉上一帧可能遗留的标记。
  bool WaitForCapture(uint64_t capture_id) {
    for (int attempt = 0; attempt < 100; ++attempt) {
      if (capture_done_.load() == capture_id) return true;
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    return false;
  }

  HRESULT DecodePngToFrame(IStream* stream) {
    Microsoft::WRL::ComPtr<IWICImagingFactory> factory;
    if (FAILED(::CoCreateInstance(CLSID_WICImagingFactory, nullptr,
                                  CLSCTX_INPROC_SERVER,
                                  IID_PPV_ARGS(&factory)))) {
      return E_FAIL;
    }
    Microsoft::WRL::ComPtr<IWICBitmapDecoder> decoder;
    if (FAILED(factory->CreateDecoderFromStream(
            stream, nullptr, WICDecodeMetadataCacheOnLoad, &decoder))) {
      return E_FAIL;
    }
    Microsoft::WRL::ComPtr<IWICBitmapFrameDecode> frame;
    if (FAILED(decoder->GetFrame(0, &frame))) return E_FAIL;
    Microsoft::WRL::ComPtr<IWICFormatConverter> converter;
    if (FAILED(factory->CreateFormatConverter(&converter))) return E_FAIL;
    if (FAILED(converter->Initialize(frame.Get(), GUID_WICPixelFormat32bppPBGRA,
                                     WICBitmapDitherTypeNone, nullptr, 0.0,
                                     WICBitmapPaletteTypeMedianCut))) {
      return E_FAIL;
    }
    UINT src_width = 0, src_height = 0;
    if (FAILED(converter->GetSize(&src_width, &src_height)) ||
        src_width == 0 || src_height == 0) {
      return E_FAIL;
    }

    int width, height;
    {
      std::lock_guard<std::mutex> lock(capture_mutex_);
      width = frame_width_;
      height = frame_height_;
    }
    std::vector<uint8_t> pixels(static_cast<size_t>(width) * height * 4, 0);
    if (src_width != static_cast<UINT>(width) ||
        src_height != static_cast<UINT>(height)) {
      Microsoft::WRL::ComPtr<IWICBitmapScaler> scaler;
      if (FAILED(factory->CreateBitmapScaler(&scaler))) return E_FAIL;
      if (FAILED(scaler->Initialize(converter.Get(), static_cast<UINT>(width),
                                    static_cast<UINT>(height),
                                    WICBitmapInterpolationModeFant))) {
        return E_FAIL;
      }
      if (FAILED(scaler->CopyPixels(nullptr, static_cast<UINT>(width) * 4,
                                    static_cast<UINT>(pixels.size()),
                                    pixels.data()))) {
        return E_FAIL;
      }
    } else if (FAILED(converter->CopyPixels(
                   nullptr, static_cast<UINT>(width) * 4,
                   static_cast<UINT>(pixels.size()), pixels.data()))) {
      return E_FAIL;
    }
    BgraToRgba(pixels);
    {
      std::lock_guard<std::mutex> lock(buffer_mutex_);
      frame_bytes_.swap(pixels);
      pixel_buffer_.buffer = frame_bytes_.data();
      pixel_buffer_.width = width;
      pixel_buffer_.height = height;
    }
    return S_OK;
  }
#endif

  bool Permit(const std::string& url, bool update_state = false) {
    if (stopped_) return false;
    const Origin origin = ParseOrigin(url);
    if (origin.host.empty()) {
      SendError(messenger_, id_, "navigationRejected", kInvalidReason);
      return false;
    }
    if (origin.scheme == "http" && requires_https_) {
      SendError(messenger_, id_, "navigationRejected", kDowngradeReason);
      return false;
    }
    if (std::find(allowed_.begin(), allowed_.end(), origin) == allowed_.end()) {
      SendError(messenger_, id_, "navigationRejected", kRejectedReason);
      return false;
    }
    if (update_state && origin.scheme == "https") {
      requires_https_ = true;
    }
    return true;
  }

  void HandleCall(const flutter::MethodCall<flutter::EncodableValue>& call,
#ifdef ONDRA_WEBVIEW2_AVAILABLE
  void InitializeWebView() {
    using namespace Microsoft::WRL;
    HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(
        nullptr, nullptr, nullptr,
        Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [this](HRESULT result, ICoreWebView2Environment* environment)
                -> HRESULT {
              if (FAILED(result) || environment == nullptr) {
                SendError(messenger_, id_, "loadFailed",
                          "WebView2 环境初始化失败，请安装 WebView2 运行时");
                return result;
              }
              // WebView2 2D controller needs a real child HWND under the
              // Flutter top-level window. A STATIC child under the desktop
              // gets destroyed with the desktop host and cannot reliably
              // deliver focus/paint; keep it under our own window instead.
              HWND host = CreateWindowExW(0, L"STATIC", L"", WS_CHILD, 0, 0,
                                          kTextureWidth, kTextureHeight,
                                          parent_window_, nullptr,
                                          GetModuleHandle(nullptr), nullptr);
              if (host == nullptr) {
                SendError(messenger_, id_, "loadFailed",
                          "WebView2 宿主窗口创建失败");
                return E_FAIL;
              }
              environment->CreateCoreWebView2Controller(
                  host,
                  Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                      [this, host](HRESULT create_result,
                             ICoreWebView2Controller* raw_controller) -> HRESULT {
                        if (FAILED(create_result) || raw_controller == nullptr) {
                          SendError(messenger_, id_, "loadFailed",
                                    "WebView2 控件创建失败");
                          return create_result;
                        }
                        ComPtr<ICoreWebView2Controller> controller;
                        if (raw_controller == nullptr) {
                          SendError(messenger_, id_, "loadFailed",
                                    "WebView2 控制器不可用");
                          return E_FAIL;
                        }
                        ComPtr<ICoreWebView2> web_view;
                        if (FAILED(controller->get_CoreWebView2(
                                web_view.GetAddressOf()))) {
                          SendError(messenger_, id_, "loadFailed",
                                    "WebView2 页面对象不可用");
                          DestroyWindow(host);
                          return E_FAIL;
                        }
                        // 所有失败分支都走完后才发布成员，capture 线程只见
                        // 到完整可用的 controller/view/host。
                        {
                          std::lock_guard<std::mutex> lock(capture_mutex_);
                          controller_ = raw_controller;
                          web_view_ = web_view;
                          host_window_ = host;
                        }
                        controller->put_IsVisible(TRUE);
                        RECT rect = {0, 0, kTextureWidth, kTextureHeight};
                        controller->put_Bounds(rect);

                        // Both events are on the base ICoreWebView2 interface
                        // in the SDK version we pin. Keep callback objects
                        // alive until registration returns, then release.
                        {
                          auto frame_handler =
                              Callback<ICoreWebView2NavigationStartingEventHandler>(
                                  [this](ICoreWebView2*,
                                         ICoreWebView2NavigationStartingEventArgs*
                                             args) -> HRESULT {
                                    return OnNavigation(args);
                                  });
                          web_view->add_FrameNavigationStarting(
                              frame_handler.Get(), &frame_token_);
                          auto new_window_handler =
                              Callback<ICoreWebView2NewWindowRequestedEventHandler>(
                                  [this](ICoreWebView2*,
                                         ICoreWebView2NewWindowRequestedEventArgs*
                                             args) -> HRESULT {
                                    return OnNewWindow(args);
                                  });
                          web_view->add_NewWindowRequested(
                              new_window_handler.Get(), &new_window_token_);
                        }
                        web_view->add_NavigationCompleted(
                            Callback<ICoreWebView2NavigationCompletedEventHandler>(
                                [this](ICoreWebView2*,
                                       ICoreWebView2NavigationCompletedEventArgs*
                                           args) -> HRESULT {
                                  BOOL success = FALSE;
                                  COREWEBVIEW2_WEB_ERROR_STATUS status =
                                      COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
                                  if (SUCCEEDED(args->get_IsSuccess(&success)) &&
                                      !success && !stopped_ &&
                                      (FAILED(args->get_WebErrorStatus(&status)) ||
                                       (status !=
                                            COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED &&
                                        status !=
                                            COREWEBVIEW2_WEB_ERROR_STATUS_REDIRECT_FAILED))) {
                                    SendError(messenger_, id_, "loadFailed",
                                              "页面加载失败，请检查网络或站点证书");
                                  }
                                  return S_OK;
                                }).Get(),
                            &navigation_completed_token_);
                        ScheduleCapture();
                        const HRESULT navigated =
                            web_view->Navigate(Utf8ToUtf16(initial_url_).c_str());
                        // 用宿主窗口当前尺寸初始化 WebView2 边界；后续 WM_SIZE
                        // 由 OndraWebViewHost::OnParentWindowResized 同步。
                        Resize(capture_width_.load(), capture_height_.load());
                        return navigated;
                      }).Get(),
                  nullptr);
              return S_OK;
            }).Get(),
        nullptr);
    if (FAILED(hr)) {
      SendError(messenger_, id_, "loadFailed",
                "WebView2 环境初始化失败，请安装 WebView2 运行时");
    }
  }
#endif  // ONDRA_WEBVIEW2_AVAILABLE (InitializeWebView)

#ifdef ONDRA_WEBVIEW2_AVAILABLE
  HRESULT OnNavigation(ICoreWebView2NavigationStartingEventArgs* args) {
    LPWSTR url = nullptr;
    if (FAILED(args->get_Uri(&url)) || url == nullptr) return S_OK;
    const std::string target = Utf16ToUtf8(url);
    CoTaskMemFree(url);
    // 先读 URI、更新 HTTPS 锁，再取消不允许的请求；取消结果以 put_Cancel 为准。
    const bool allowed = Permit(target, true);
    if (FAILED(args->put_Cancel(allowed ? FALSE : TRUE))) return E_FAIL;
    return S_OK;
  }

  HRESULT OnNewWindow(ICoreWebView2NewWindowRequestedEventArgs* args) {
    LPWSTR url = nullptr;
    if (FAILED(args->get_Uri(&url)) || url == nullptr) return S_OK;
    const std::string target = Utf16ToUtf8(url);
    CoTaskMemFree(url);
    if (!Permit(target)) {
      return args->put_Handled(TRUE);
    }
    // target=_blank / window.open：合法请求留在同一视图，不弹新窗口。
    return web_view_->Navigate(Utf8ToUtf16(target).c_str());
  }
#endif  // ONDRA_WEBVIEW2_AVAILABLE (navigation handlers)


};  // class OndraWebViewHost::View

OndraWebViewHost::OndraWebViewHost(
    flutter::BinaryMessenger* messenger,
    FlutterDesktopTextureRegistrarRef textures,
    HWND parent_window)
    : messenger_(messenger),
      textures_(textures),
      parent_window_(parent_window) {
  channel_ = std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
      messenger_, kHostChannel, &flutter::StandardMethodCodec::GetInstance());
  channel_->SetMethodCallHandler(
      [this](const flutter::MethodCall<flutter::EncodableValue>& call,
             std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>>
                 result) {
        if (call.method_name() != "create") {
          result->NotImplemented();
          return;
        }
        const auto* args = std::get_if<flutter::EncodableMap>(call.arguments());
        if (args == nullptr) {
          result->Error("bad-args", "creation args missing");
          return;
        }
        const auto id = next_id_++;
        auto view = std::make_unique<View>(
            messenger_, textures_, id, *args, parent_window_);
        const int64_t texture_id = view->texture_id();
        views_[id] = std::move(view);
        result->Success(flutter::EncodableValue(texture_id));
      });
}

OndraWebViewHost::~OndraWebViewHost() {
  if (channel_) channel_->SetMethodCallHandler(nullptr);
  views_.clear();
}

OndraWebViewHost::OndraWebViewHost(
    flutter::BinaryMessenger* messenger,
    FlutterDesktopTextureRegistrarRef textures)
    : OndraWebViewHost(messenger, textures, nullptr) {}

void OndraWebViewHost::OnParentWindowResized(HWND parent, int width,
                                             int height) {
  for (auto& entry : views_) {
    View* view = entry.second.get();
    if (view == nullptr) {
      continue;
    }
    view->Resize(width, height);
  }
}


