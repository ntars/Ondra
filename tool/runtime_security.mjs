import fs from 'node:fs';
import path from 'node:path';

// DeepSeek Harness 的 distribution 会给部分包应用 `[dsh-purge]` 补丁。多数是
// 产品裁剪，但安全实现不能随包静默失效：被覆盖的 sandbox、approval 与权限
// 文件都有同名 `.dshpurge.bak` 原实现。这里只恢复下列安全关键文件；其他
// purge 保留，避免把官方兼容/裁剪修复一并回滚。
export const SECURITY_RESTORE_FILES = [
  'dsh-sandbox/lib/index.js',
  'dsh-sandbox-local/lib/index.js',
  'dsh-fs-sandbox/lib/index.js',
  'dsh-user-approval/lib/index.js',
  'dsh-sandbox-policy/lib/index.js',
  'dsh-tool-fs/lib/index.js',
  'dsh-tool-bash/lib/index.js',
  'dsh-permission-presets/lib/index.js',
  'dsh-subagent/lib/index.js',
];

function fail(message, detail) {
  const error = new Error(detail ? `${message}\n${detail}` : message);
  error.securityFailure = true;
  throw error;
}

/** 只恢复确实被 purge 的安全文件；没有 bak 说明源安装本身不完整。 */
export function restoreSecurityFiles(nmDest) {
  const restored = [];
  for (const rel of SECURITY_RESTORE_FILES) {
    const dest = path.join(nmDest, '@deepseek-ai', rel);
    if (!fs.existsSync(dest)) {
      fail(`安全审计失败：缺少 ${rel}`,
        '源 DSH 安装缺少安全关键包，不能产出无沙箱的运行时。');
    }
    const text = fs.readFileSync(dest, 'utf8');
    if (!text.includes('[dsh-purge]')) continue;

    const backup = `${dest}.dshpurge.bak`;
    if (!fs.existsSync(backup)) {
      fail(`安全审计失败：${rel} 被 purge 但没有备份`,
        `缺少 ${backup}；拒绝用已绕过沙箱的实现打包。`);
    }
    fs.copyFileSync(backup, dest);
    restored.push(rel);
  }
  return restored;
}

/**
 * 恢复后做真实文本审计。仅检查 `[dsh-purge]` 不够：补丁也可能删掉关键调用
 * 而不再留标记，所以对已知 bypass 形态再做一次断言。
 */
export function auditSecurityFiles(nmDest) {
  const failures = [];
  const expected = new Map([
    ['dsh-sandbox/lib/index.js', /function approveEscalation\(|const approveEscalation =/],
    ['dsh-sandbox-local/lib/index.js', /async confine\(argv, policy, signal\)/],
    ['dsh-fs-sandbox/lib/index.js', /async checkedTarget\(target, sandboxPolicy\)/],
    ['dsh-user-approval/lib/index.js', /class .*Approval|allowed-once/],
    ['dsh-sandbox-policy/lib/index.js', /renderPolicyContext|defaultMode/],
    ['dsh-tool-fs/lib/index.js', /class FsSandboxController|resolvePolicy/],
    ['dsh-tool-bash/lib/index.js', /resolveSandboxPolicy|sandboxPolicy/],
    ['dsh-permission-presets/lib/index.js', /presets|sandbox/],
    ['dsh-subagent/lib/index.js', /subagent/],
  ]);
  for (const rel of SECURITY_RESTORE_FILES) {
    const file = path.join(nmDest, '@deepseek-ai', rel);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      failures.push(`${rel}: 无法读取（${err.code || err.message}）`);
      continue;
    }
    if (text.includes('[dsh-purge]')) failures.push(`${rel}: 仍含 [dsh-purge]`);
    if (/bypass: .*never|escalation bypass: every|approval bypass: every|auto-granted in this session/i.test(text)) {
      failures.push(`${rel}: 仍含已知 bypass 文案`);
    }
    const shape = expected.get(rel);
    if (shape && !shape.test(text)) failures.push(`${rel}: 缺少预期安全实现`);
  }
  if (failures.length) {
    fail(`安全审计失败（${failures.length} 项）`, failures.join('\n  '));
  }
}
