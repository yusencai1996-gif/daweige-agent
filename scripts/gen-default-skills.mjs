#!/usr/bin/env node
// 把 src/main/skills/defaults 下各技能的 SKILL.md 生成为 default-skill-content.ts(纯字符串导出)。
// 原因:?raw 是 Vite 专属语法,playwright 的 esbuild transform 不认(把 .md 当 JS 解析);
// 生成 TS 后 vitest/electron-vite/playwright/Node 全链路兼容。改 .md 内容后必须重跑本脚本。
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const defaultsDir = join(root, 'src', 'main', 'skills', 'defaults')
const outFile = join(root, 'src', 'main', 'skills', 'default-skill-content.ts')

function collect(dir) {
  const entries = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) entries.push(...collect(full))
    else if (name === 'SKILL.md') entries.push(relative(defaultsDir, full).replace(/\\/g, '/'))
  }
  return entries.sort()
}

const keys = collect(defaultsDir)
if (keys.length === 0) throw new Error(`no SKILL.md found under ${defaultsDir}`)
const map = {}
for (const key of keys) {
  map[key.replace(/\/SKILL\.md$/, '')] = readFileSync(join(defaultsDir, key), 'utf8')
}

const banner = '// 由 scripts/gen-default-skills.mjs 生成,勿手改;改 .md 后跑 npm run gen:skills 重新生成。\n'
const iface = `export interface DefaultSkillContent {\n${keys.map((k) => `  readonly ${JSON.stringify(k.replace(/\/SKILL\.md$/, ''))}: string`).join('\n')}\n}\n`
const body = `export const DEFAULT_SKILL_CONTENT: DefaultSkillContent = ${JSON.stringify(map, null, 2)}\n`
writeFileSync(outFile, banner + iface + body, 'utf8')
console.log(`[gen:skills] ${keys.length} skills -> ${relative(root, outFile)}`)
