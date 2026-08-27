#!/usr/bin/env node
// 构建沙箱执行器并生成 SHA-256 清单(0.4.0 C5)。
// dist:win 的前置步骤;产物 exe + .sha256 由 electron-builder extraResources 打进安装包,
// 运行期 sandbox-process-host 校验清单,不符即拒绝运行命令(fail-closed)。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const CRATE = join(ROOT, 'native', 'daweige-sandbox-helper')
const EXE = join(CRATE, 'target', 'release', 'daweige-sandbox-helper.exe')

function log(msg) {
  console.log(`[sandbox:build] ${msg}`)
}

async function main() {
  log('cargo build --locked --release(依赖 rustup/cargo;CI 在干净 Windows runner 可复现)')
  execFileSync('cargo', ['build', '--locked', '--release'], {
    cwd: CRATE,
    stdio: 'inherit',
    env: { ...process.env, RUSTFLAGS: process.env.RUSTFLAGS ?? '' },
  })

  const buf = await readFile(EXE)
  const digest = createHash('sha256').update(buf).digest('hex')
  await writeFile(`${EXE}.sha256`, `${digest} *daweige-sandbox-helper.exe\n`, 'utf-8')
  log(`helper 构建完成:${(buf.length / 1024).toFixed(0)} KB,sha256=${digest.slice(0, 16)}…`)
}

main().catch((err) => {
  console.error('[sandbox:build] 失败:', err.message)
  process.exit(1)
})
