import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 红线扫描:生产源码(src/main、src/shared、src/renderer)不引入 child_process;
 * 第一版不执行任何系统命令(PLAN M4-07 / 边界 §5.1)。
 * 0.4.0 C 起唯一豁免:src/main/sandbox/sandbox-process-host.ts
 * (沙箱执行器宿主——只启动经过哈希校验的 daweige-sandbox-helper.exe,PLAN §5.6)。
 */

const PROD_DIRS = ['src/main', 'src/shared', 'src/renderer']
/** 0.4.0 C:唯一允许 import child_process 的模块(沙箱宿主)。 */
const CHILD_PROCESS_ALLOWLIST = new Set(['src/main/sandbox/sandbox-process-host.ts'])

function collectFiles(dir: string, pattern: RegExp, acc: string[] = []): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      collectFiles(full, pattern, acc)
    } else if (pattern.test(e.name)) {
      acc.push(full)
    }
  }
  return acc
}

describe('红线:无 child_process 进入生产源', () => {
  it.each(PROD_DIRS)('%s 不含 child_process 引用', (dir) => {
    const files = collectFiles(join(process.cwd(), dir), /\.tsx?$/)
    const offenders = files
      .map((f) => ({ file: f, rel: f.replace(/\\/g, '/').replace(/^.*?(src\/)/, 'src/') }))
      .filter(({ file, rel }) => /child_process/.test(readFileSync(file, 'utf-8')) && !CHILD_PROCESS_ALLOWLIST.has(rel))
      .map(({ file }) => file)
    expect(offenders, `以下文件引用了 child_process:${offenders.join(', ')}`).toEqual([])
  })
})
