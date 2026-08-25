import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 红线扫描:生产源码(src/main、src/shared、src/renderer)不引入 child_process;
 * 第一版不执行任何系统命令(PLAN M4-07 / 边界 §5.1)。
 */

const PROD_DIRS = ['src/main', 'src/shared', 'src/renderer']

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
    const offenders = files.filter((f) => /child_process/.test(readFileSync(f, 'utf-8')))
    expect(offenders, `以下文件引用了 child_process:${offenders.join(', ')}`).toEqual([])
  })
})
