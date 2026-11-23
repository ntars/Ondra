cmake_minimum_required(VERSION 3.14)
project(runner LANGUAGES CXX)

# WebView2 后端：默认从 NuGet 取官方 Win32 SDK；设 OFF 可离线构建，
# 此时代理只会在运行时报告“此构建未编译 WebView2 后端”。
option(ONDRA_ENABLE_WEBVIEW2 "Build the WebView2-backed embedded browser" ON)
set(ONDRA_WEBVIEW2_VERSION "1.0.2739.15" CACHE STRING "Microsoft.Web.WebView2 SDK version")

if(ONDRA_ENABLE_WEBVIEW2)
  set(ONDRA_WEBVIEW2_NUPKG
      "${CMAKE_BINARY_DIR}/webview2/microsoft.web.webview2.${ONDRA_WEBVIEW2_VERSION}.nupkg")
  set(ONDRA_WEBVIEW2_SDK_DIR "${CMAKE_BINARY_DIR}/webview2/sdk")
  if(NOT EXISTS "${ONDRA_WEBVIEW2_SDK_DIR}/build/native/include/WebView2.h")
    file(MAKE_DIRECTORY "${ONDRA_WEBVIEW2_SDK_DIR}")
    file(DOWNLOAD
         "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${ONDRA_WEBVIEW2_VERSION}/microsoft.web.webview2.${ONDRA_WEBVIEW2_VERSION}.nupkg"
         "${ONDRA_WEBVIEW2_NUPKG}"
         STATUS ONDRA_WEBVIEW2_DOWNLOAD_STATUS
         TLS_VERIFY ON
         SHOW_PROGRESS)
    list(GET ONDRA_WEBVIEW2_DOWNLOAD_STATUS 0 ONDRA_WEBVIEW2_DOWNLOAD_CODE)
    if(ONDRA_WEBVIEW2_DOWNLOAD_CODE EQUAL 0)
      execute_process(COMMAND "${CMAKE_COMMAND}" -E tar xf "${ONDRA_WEBVIEW2_NUPKG}"
                      WORKING_DIRECTORY "${ONDRA_WEBVIEW2_SDK_DIR}")
    endif()
  endif()
endif()

# Define the application target. To change its name, change BINARY_NAME in the
# top-level CMakeLists.txt, not the value here, or `flutter run` will no longer
# work.
#
# Any new source files that you add to the application should be added here.
add_executable(${BINARY_NAME} WIN32
  "flutter_window.cpp"
  "main.cpp"
  "utils.cpp"
  "win32_window.cpp"
  "web_view_win.cpp"
  "${FLUTTER_MANAGED_DIR}/generated_plugin_registrant.cc"
  "Runner.rc"
  "runner.exe.manifest"
)

# Apply the standard set of build settings. This can be removed for applications
# that need different build settings.
apply_standard_settings(${BINARY_NAME})

# Add preprocessor definitions for the build version.
target_compile_definitions(${BINARY_NAME} PRIVATE "FLUTTER_VERSION=\"${FLUTTER_VERSION}\"")
target_compile_definitions(${BINARY_NAME} PRIVATE "FLUTTER_VERSION_MAJOR=${FLUTTER_VERSION_MAJOR}")
target_compile_definitions(${BINARY_NAME} PRIVATE "FLUTTER_VERSION_MINOR=${FLUTTER_VERSION_MINOR}")
target_compile_definitions(${BINARY_NAME} PRIVATE "FLUTTER_VERSION_PATCH=${FLUTTER_VERSION_PATCH}")
target_compile_definitions(${BINARY_NAME} PRIVATE "FLUTTER_VERSION_BUILD=${FLUTTER_VERSION_BUILD}")

# Disable Windows macros that collide with C++ standard library functions.
target_compile_definitions(${BINARY_NAME} PRIVATE "NOMINMAX")

# Add dependency libraries and include directories. Add any application-specific
# dependencies here.
target_link_libraries(${BINARY_NAME} PRIVATE flutter flutter_wrapper_app)
target_link_libraries(${BINARY_NAME} PRIVATE "dwmapi.lib" "shell32.lib")
target_include_directories(${BINARY_NAME} PRIVATE "${CMAKE_SOURCE_DIR}")

if(ONDRA_ENABLE_WEBVIEW2 AND ONDRA_WEBVIEW2_SDK_DIR)
  if(EXISTS "${ONDRA_WEBVIEW2_SDK_DIR}/build/native/include/WebView2.h")
    target_compile_definitions(${BINARY_NAME} PRIVATE ONDRA_WEBVIEW2_AVAILABLE)
    target_include_directories(${BINARY_NAME} PRIVATE
      "${ONDRA_WEBVIEW2_SDK_DIR}/build/native/include"
      "${ONDRA_WEBVIEW2_SDK_DIR}/build/native/include/winmd")
    target_link_libraries(${BINARY_NAME} PRIVATE
      "${ONDRA_WEBVIEW2_SDK_DIR}/build/native/x64/WebView2LoaderStatic.lib"
      "advapi32.lib" "shlwapi.lib" "windowscodecs.lib")
  else()
    message(WARNING "WebView2 SDK unavailable; building fallback without WebView2")
  endif()
endif()

# Run the Flutter tool portions of the build. This must not be removed.
add_dependencies(${BINARY_NAME} flutter_assemble)
