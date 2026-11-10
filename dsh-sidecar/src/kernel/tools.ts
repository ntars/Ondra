/**
 * 工具注册表与参数校验。
 *
 * ## 校验为什么必须在执行前
 *
 * 工具参数由模型生成，模型会产生不存在的字段、漏掉必填项、把数字写成字符串。
 * 若不校验就直接执行，错误会发生在工具内部——那时已经产生了副作用
 * （写了文件、发了请求），无法回滚。校验前置能把副作用挡在门外。
 *
 * ## 为什么手写校验而不用 JSON Schema 库
 *
 * 当前需要的校验只有"必填字段存在"与"顶层类型匹配"两项。引入完整 JSON Schema
 * 校验器会带来数百 KB 依赖，而项目规范要求用最小、最直接的代码解决问题。
 * 当参数复杂度上升到需要嵌套校验时，再引入库并在此处替换即可——
 * 契约（{@link ToolRegistry.invoke} 的失败语义）保持不变。
 */

import { KernelErrorCode, RpcErrorCode } from '../protocol.js'
import { RpcHandlerError } from '../rpc/dispatcher.js'
import type { ToolDefinition } from './types.js'

/** 工具名合法格式：小写字母开头，随后小写字母、数字或下划线。 */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/

/** 工具注册表。 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  /**
   * @param definitions 初始工具集合。
   * @throws 名称重复或格式非法时抛出——注册期就该失败，而不是等到调用时才发现。
   */
  constructor(definitions: readonly ToolDefinition[]) {
    for (const definition of definitions) {
      if (!TOOL_NAME_PATTERN.test(definition.name)) {
        throw new Error(`工具名不合规：${definition.name}（须匹配 ${TOOL_NAME_PATTERN.source}）`)
      }
      if (this.tools.has(definition.name)) {
        throw new Error(`工具名重复：${definition.name}`)
      }
      this.tools.set(definition.name, definition)
    }
  }

  /**
   * 列出全部工具（不含执行函数）。
   *
   * 刻意剔除 `execute`：LIST 结果会直接发给界面渲染，函数无法序列化，
   * 且暴露执行入口没有意义。
   */
  list(): Array<Pick<ToolDefinition, 'name' | 'description' | 'parameters'>> {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters }))
  }

  /** 按名称取工具定义。 */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  /**
   * 调用工具。
   *
   * @param name 工具名。
   * @param args 由模型生成的原始参数，本方法负责校验。
   * @returns 工具的执行结果。
   * @throws {@link RpcHandlerError} 工具不存在、参数不合规或执行失败时抛出。
   */
  async invoke(name: string, args: unknown): Promise<unknown> {
    const tool = this.tools.get(name)
    if (tool === undefined) {
      throw new RpcHandlerError(RpcErrorCode.InvalidParams, `工具不存在：${name}`)
    }
    validateAgainstSchema(tool.parameters, args, name)
    try {
      return await tool.execute(args)
    } catch (error) {
      // 工具自身的失败属于业务错误（如网络不可达），与协议错误分开报，
      // 让调用方能区分"我的参数写错了"和"工具执行时出错了"。
      throw new RpcHandlerError(
        KernelErrorCode.NotImplemented,
        `工具 ${name} 执行失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

/**
 * 按 JSON Schema 的最小子集校验参数。
 *
 * 支持：`type: object`、`required`、`properties[].type` 的顶层类型匹配。
 * 不支持嵌套对象、数组元素、`oneOf` 等——超出范围时**跳过校验而非报错**，
 * 因为把"不支持的约束"当成"校验失败"会误伤合法调用。
 *
 * @param schema 工具的 `parameters` 字段。
 * @param value 待校验参数。
 * @param toolName 仅用于错误信息，让用户知道是哪个工具的参数不对。
 * @throws {@link RpcHandlerError} 校验不通过时抛出。
 */
function validateAgainstSchema(schema: Record<string, unknown>, value: unknown, toolName: string): void {
  if (schema.type !== 'object') return
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RpcHandlerError(RpcErrorCode.InvalidParams, `工具 ${toolName} 的参数必须是对象`)
  }
  const record = value as Record<string, unknown>

  const required = schema.required
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === 'string' && !(key in record)) {
        throw new RpcHandlerError(RpcErrorCode.InvalidParams, `工具 ${toolName} 缺少必填参数：${key}`)
      }
    }
  }

  const properties = schema.properties
  if (typeof properties !== 'object' || properties === null) return
  for (const [key, propertySchema] of Object.entries(properties as Record<string, unknown>)) {
    if (!(key in record)) continue
    if (typeof propertySchema !== 'object' || propertySchema === null) continue
    const expected = (propertySchema as Record<string, unknown>).type
    if (typeof expected !== 'string') continue
    if (!matchesType(record[key], expected)) {
      throw new RpcHandlerError(
        RpcErrorCode.InvalidParams,
        `工具 ${toolName} 的参数 ${key} 类型应为 ${expected}`,
      )
    }
  }
}

/** 判断值是否符合 JSON Schema 的 type 名称。 */
function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array': return Array.isArray(value)
    case 'null': return value === null
    // 未知类型名不构成否定证据，放过而不是误伤。
    default: return true
  }
}
