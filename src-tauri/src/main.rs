//! 桌面端可执行文件入口。
//!
//! 真正的逻辑在 `lib.rs` 的 `run()`：那份代码同时被 Android 的动态库复用，
//! 所以不能留在这里。这里只保留两样「只有 bin 才需要」的东西：
//!
//! 1. Windows 的 `windows_subsystem` 属性——它作用于**可执行文件**，
//!    放 lib 里对 Android 无意义（lib.rs 里那份注释已说明）。
//! 2. `fn main()` 这个符号本身——Rust 的 bin crate 必须有它。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ondra::run();
}