/**
 * 手机端的本地存储。
 *
 * ## 为什么不是 IndexedDB 的薄封装
 *
 * 桌面版的宿主用 SQLite（`node:sqlite`），手机上没有 Node，也没有
 * `node:sqlite`。但**上层代码只认识「一张表 + 按 key 读写」这件事**——
 * 会话、消息、记忆、情绪状态都是「一个 id 对一条 JSON」。
 *
 * 所以这里不实现 SQL，只实现最小可用的 KV：一个 object store，key 是
 * `表名:主键`，value 是 JSON 字符串。查询靠遍历过滤——手机端的数据量
 * （几百条消息、几千条记忆）在这个规模下遍历完全够用，而真正的 SQL
 * 查询能力在这里换不来任何用户可感的好处。
 *
 * ## 为什么 value 存字符串而不是对象
 *
 * IndexedDB 可以直接存结构化对象，但那样读出来的对象是**共享引用**：
 * 调用方改一个字段，库里那条也跟着变，下次读出来就是改过的值——而
 * 桌面版是「读出来是快照，改完要显式写回」。两边行为不一致时，同一段
 * 业务代码在手机上会静默写脏数据。序列化强制了快照语义。
 */

/** 库名与版本。改结构时版本 +1，`onupgradeneeded` 里补迁移。 */
const DB_NAME = 'ondra-local'
const DB_VERSION = 1
const STORE = 'kv'

/** 单例连接。打开一次复用，避免每次读写都走一遍 open 握手。 */
let connection: Promise<IDBDatabase> | undefined

/** 打开（或复用）数据库。 */
function open(): Promise<IDBDatabase> {
  if (connection !== undefined) return connection
  connection = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('打不开本地存储')) }
  })
  return connection
}

/** 把一次读写包成 Promise。 */
async function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return await new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const request = body(tx.objectStore(STORE))
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('本地存储操作失败')) }
  })
}

/** 拼一个复合键。`table` 与 `id` 里都不该出现 `:`，调用方保证。 */
function keyOf(table: string, id: string): string {
  return `${table}:${id}`
}

/** 读一条。不存在返回 undefined。 */
export async function get<T>(table: string, id: string): Promise<T | undefined> {
  const raw = await run<string | undefined>('readonly', (store) => store.get(keyOf(table, id)) as IDBRequest<string | undefined>)
  if (typeof raw !== 'string') return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    /* 存进去的是我们自己序列化的，解不开说明这条已经坏了，按不存在处理 */
    return undefined
  }
}

/** 写一条（覆盖）。 */
export async function put(table: string, id: string, value: unknown): Promise<void> {
  await run('readwrite', (store) => store.put(JSON.stringify(value), keyOf(table, id)) as IDBRequest<unknown>)
}

/** 删一条。 */
export async function remove(table: string, id: string): Promise<void> {
  await run('readwrite', (store) => store.delete(keyOf(table, id)) as IDBRequest<undefined>)
}

/**
 * 列一张表的全部条目。
 *
 * ## 为什么用前缀扫而不是维护索引
 *
 * IndexedDB 可以建索引，但索引要跟着每次写入维护，而这里只有「按表全取」
 * 一种查询。`getAllKeys` 一次拿到全部键，按前缀过滤后逐个取值——比维护
 * 一套索引简单，也没有「索引与数据不同步」这类只有并发时才会露出的 bug。
 *
 * 手机端单表最多几千条，这个开销在 10ms 量级。
 */
export async function list<T>(table: string): Promise<Array<{ id: string; value: T }>> {
  const prefix = `${table}:`
  const keys = await run<IDBValidKey[]>('readonly', (store) => store.getAllKeys() as IDBRequest<IDBValidKey[]>)
  const mine = keys
    .map((key) => String(key))
    .filter((key) => key.startsWith(prefix))
  const out: Array<{ id: string; value: T }> = []
  for (const key of mine) {
    const raw = await run<string | undefined>('readonly', (store) => store.get(key) as IDBRequest<string | undefined>)
    if (typeof raw !== 'string') continue
    try {
      out.push({ id: key.slice(prefix.length), value: JSON.parse(raw) as T })
    } catch {
      /* 坏条目跳过，不让一条坏数据毁掉整张表 */
    }
  }
  return out
}

/** 清空一张表。 */
export async function clearTable(table: string): Promise<void> {
  const prefix = `${table}:`
  const keys = await run<IDBValidKey[]>('readonly', (store) => store.getAllKeys() as IDBRequest<IDBValidKey[]>)
  for (const key of keys) {
    if (String(key).startsWith(prefix)) {
      await run('readwrite', (store) => store.delete(key) as IDBRequest<undefined>)
    }
  }
}

/** 整个库清空（「清空全部」用）。 */
export async function clearAll(): Promise<void> {
  await run('readwrite', (store) => store.clear() as IDBRequest<undefined>)
}