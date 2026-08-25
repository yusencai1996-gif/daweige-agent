import { describe, expect, it } from 'vitest'
import { countCodePoints } from '../../../src/renderer/features/roles/count-chars'

describe('countCodePoints(守则字数码点口径,S-03)', () => {
  it('ASCII:码点数与 string.length 一致', () => {
    expect(countCodePoints('hello world')).toBe(11)
    expect(countCodePoints('')).toBe(0)
  })

  it('中文:BMP 字符一码元一码点,两种口径相同', () => {
    expect(countCodePoints('守则正文四个字')).toBe(7)
  })

  it('emoji:辅助平面字符按 1 字计,string.length 会多数一倍', () => {
    const s = '守则🚀👍'
    expect(s.length).toBe(6) // UTF-16 码元口径(后端 TypeBox schema 用,不动)
    expect(countCodePoints(s)).toBe(4) // 码点口径(与 checkGuardrails 一致)
    // 组合 emoji(国旗/ZWJ 序列)按码点而不是按「字素簇」计,与后端 [...s] 行为对齐
    expect(countCodePoints('👨‍👩‍👧')).toBe([...'👨‍👩‍👧'].length)
  })
})
