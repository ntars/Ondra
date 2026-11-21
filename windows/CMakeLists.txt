# Project-level configuration.
cmake_minimum_required(VERSION 3.14)
project(ondra LANGUAGES CXX)

# The name of the executable created for the application. Change this to change
# the on-disk name of your application.
set(BINARY_NAME "ondra")

# Explicitly opt in to modern CMake behaviors to avoid warnings with recent
# versions of CMake.
cmake_policy(VERSION 3.14...3.25)

# Define build configuration option.
get_property(IS_MULTICONFIG GLOBAL PROPERTY GENERATOR_IS_MULTI_CONFIG)
if(IS_MULTICONFIG)
  set(CMAKE_CONFIGURATION_TYPES "Debug;Profile;Release"
    CACHE STRING "" FORCE)
else()
  if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE "Debug" CACHE
      STRING "Flutter build mode" FORCE)
    set_property(CACHE CMAKE_BUILD_TYPE PROPERTY STRINGS
      "Debug" "Profile" "Release")
  endif()
endif()
# Define settings for the Profile build mode.
set(CMAKE_EXE_LINKER_FLAGS_PROFILE "${CMAKE_EXE_LINKER_FLAGS_RELEASE}")
set(CMAKE_SHARED_LINKER_FLAGS_PROFILE "${CMAKE_SHARED_LINKER_FLAGS_RELEASE}")
set(CMAKE_C_FLAGS_PROFILE "${CMAKE_C_FLAGS_RELEASE}")
set(CMAKE_CXX_FLAGS_PROFILE "${CMAKE_CXX_FLAGS_RELEASE}")

# Use Unicode for all projects.
add_definitions(-DUNICODE -D_UNICODE)

# Compilation settings that should be applied to most targets.
#
# Be cautious about adding new options here, as plugins use this function by
# default. In most cases, you should add new options to specific targets instead
# of modifying this function.
function(APPLY_STANDARD_SETTINGS TARGET)
  target_compile_features(${TARGET} PUBLIC cxx_std_17)
  target_compile_options(${TARGET} PRIVATE /W4 /WX /wd4100)
  target_compile_options(${TARGET} PRIVATE /EHsc)
  target_compile_options(${TARGET} PRIVATE /utf-8)
target_compile_definitions(${TARGET} PRIVATE "_HAS_EXCEPTIONS=0")
  target_compile_definitions(${TARGET} PRIVATE "$<$<CONFIG:Debug>:_DEBUG>")
endfunction()

# Flutter library and tool build rules.
set(FLUTTER_MANAGED_DIR "${CMAKE_CURRENT_SOURCE_DIR}/flutter")
add_subdirectory(${FLUTTER_MANAGED_DIR})

# Application build; see runner/CMakeLists.txt.
add_subdirectory("runner")


# Generated plugin build rules, which manage building the plugins and adding
# them to the application.
include(flutter/generated_plugins.cmake)


# === Installation ===
# Support files are copied into place next to the executable, so that it can
# run in place. This is done instead of making a separate bundle (as on Linux)
# so that building and running from within Visual Studio will work.
set(BUILD_BUNDLE_DIR "$<TARGET_FILE_DIR:${BINARY_NAME}>")
# Make the "install" step default, as it's required to run.
set(CMAKE_VS_INCLUDE_INSTALL_TO_DEFAULT_BUILD 1)
if(CMAKE_INSTALL_PREFIX_INITIALIZED_TO_DEFAULT)
  set(CMAKE_INSTALL_PREFIX "${BUILD_BUNDLE_DIR}" CACHE PATH "..." FORCE)
endif()

set(INSTALL_BUNDLE_DATA_DIR "${CMAKE_INSTALL_PREFIX}/data")
set(INSTALL_BUNDLE_LIB_DIR "${CMAKE_INSTALL_PREFIX}")

install(TARGETS ${BINARY_NAME} RUNTIME DESTINATION "${CMAKE_INSTALL_PREFIX}"
  COMPONENT Runtime)

install(FILES "${FLUTTER_ICU_DATA_FILE}" DESTINATION "${INSTALL_BUNDLE_DATA_DIR}"
  COMPONENT Runtime)

install(FILES "${FLUTTER_LIBRARY}" DESTINATION "${INSTALL_BUNDLE_LIB_DIR}"
  COMPONENT Runtime)

# 随包运行时（node.exe + dsh 内核 + profile 种子 + sqlite3.exe）。
#
# 目录名必须是 `windows-<架构>`，不能写 `win-x64`：Dart 侧
# `lib/app/bundled_runtime_io.dart` 拿 `Platform.operatingSystem`（值是
# `windows`）去拼前缀，`startsWith('windows-')` 匹配不上 `win-` 就会当作
# 「包里没有运行时」，一路退回到「让用户自己装 node」。
#
# 装到 INSTALL_BUNDLE_LIB_DIR（即 exe 同目录）下的 `runtime\`：Dart 侧在
# 「可执行文件旁边的 runtime\<平台>-<架构>」找它。
#
# **缺了它不是「功能少一点」，是应用起不来。** Windows 上系统既没有 dsh 也
# 没有 node，`_resolveBinary` 最后只剩 PATH 里那个不存在的 `dsh`，用户看到的是
# 「找不到 dsh 可执行文件」。所以这里默认 FATAL_ERROR，而不是打一行警告就继续
# 构建出一个装完打不开的安装包。
#
# 确实只想验界面、不需要真实对话时，可以显式放行（环境变量，不走 -D：
# `flutter build` 不转发自定义 -D 给 CMake）：
#   set ONDRA_ALLOW_NO_RUNTIME=1
set(ONDRA_ALLOW_NO_RUNTIME OFF)
if(DEFINED ENV{ONDRA_ALLOW_NO_RUNTIME} AND NOT "$ENV{ONDRA_ALLOW_NO_RUNTIME}" STREQUAL "")
  set(ONDRA_ALLOW_NO_RUNTIME ON)
endif()

set(ONDRA_RUNTIME_TARGET "windows-x64")
if(CMAKE_SIZEOF_VOID_P EQUAL 4)
  set(ONDRA_RUNTIME_TARGET "windows-x86")
elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "ARM64|arm64")
  set(ONDRA_RUNTIME_TARGET "windows-arm64")
endif()
set(ONDRA_RUNTIME_SRC "${CMAKE_CURRENT_SOURCE_DIR}/../runtime/${ONDRA_RUNTIME_TARGET}")

if(EXISTS "${ONDRA_RUNTIME_SRC}/node.exe")
  install(DIRECTORY "${ONDRA_RUNTIME_SRC}"
    DESTINATION "${INSTALL_BUNDLE_LIB_DIR}/runtime"
    COMPONENT Runtime)
  if(NOT EXISTS "${ONDRA_RUNTIME_SRC}/sqlite3.exe")
    message(WARNING
      "随包运行时里没有 sqlite3.exe：内核能跑，但状态面板、记忆星图、"
      "导入导出会读不到数据。重跑 tool/assemble_runtime.mjs 让它自动取自 sqlite.org。")
  endif()
elseif(ONDRA_ALLOW_NO_RUNTIME)
  message(WARNING
    "ONDRA_ALLOW_NO_RUNTIME=ON：这次构建不含运行时，产物无法连接内核。")
else()
  message(FATAL_ERROR
    "缺少随包运行时：${ONDRA_RUNTIME_SRC}\n"
    "Windows 上没有系统 dsh 可退回，这样的安装包双击后连不上内核。\n"
    "先在本机跑：node tool\\assemble_runtime.mjs\n"
    "（它会从本机已装的 node 与 @deepseek-ai/dsh 生成这一份，并自动取 sqlite3.exe）\n"
    "确实只需要界面时，设环境变量 ONDRA_ALLOW_NO_RUNTIME=1 跳过这项检查。")
endif()

if(PLUGIN_BUNDLED_LIBRARIES)
  install(FILES "${PLUGIN_BUNDLED_LIBRARIES}"
    DESTINATION "${INSTALL_BUNDLE_LIB_DIR}"
    COMPONENT Runtime)
endif()

# Copy the native assets provided by the hook/build.dart from all packages.
set(NATIVE_ASSETS_DIR "${PROJECT_BUILD_DIR}native_assets/windows/")
install(DIRECTORY "${NATIVE_ASSETS_DIR}"
   DESTINATION "${INSTALL_BUNDLE_LIB_DIR}"
   COMPONENT Runtime)

# Fully re-copy the assets directory on each build to avoid having stale files
# from a previous install.
set(FLUTTER_ASSET_DIR_NAME "flutter_assets")
install(CODE "
  file(REMOVE_RECURSE \"${INSTALL_BUNDLE_DATA_DIR}/${FLUTTER_ASSET_DIR_NAME}\")
  " COMPONENT Runtime)
install(DIRECTORY "${PROJECT_BUILD_DIR}/${FLUTTER_ASSET_DIR_NAME}"
  DESTINATION "${INSTALL_BUNDLE_DATA_DIR}" COMPONENT Runtime)

# Install the AOT library on non-Debug builds only.
install(FILES "${AOT_LIBRARY}" DESTINATION "${INSTALL_BUNDLE_DATA_DIR}"
  CONFIGURATIONS Profile;Release
  COMPONENT Runtime)
