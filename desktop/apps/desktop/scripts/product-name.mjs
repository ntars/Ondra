/**
 * 产品显示名：macOS 的 .app 目录名与 Windows 的 .exe 文件名共用这一处。
 *
 * 打包配置与打包后的冒烟校验都从这里取值。改产品名只改这一行，
 * 否则冒烟脚本会拿旧名字去找产物并以 ENOENT 失败（Windows 曾因
 * 硬编码 'Ondra.exe' 与实际的「空谷 Ondra.exe」不一致而卡住整个发布）。
 */
export const PRODUCT_NAME = '空谷 Ondra'
