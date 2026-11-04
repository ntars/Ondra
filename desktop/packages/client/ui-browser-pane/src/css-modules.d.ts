/** CSS Modules 的类型声明，构建期由 tsdown 生成同名 .css 产物。 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
