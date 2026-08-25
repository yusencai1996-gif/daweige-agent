import { describe, expect, it } from 'vitest'
import { createRequestGate } from '../../../src/renderer/features/usage/UsageView'

/**
 * S-02 请求代次闸门:卸载后/过期代次的响应必须被丢弃。
 * 场景对应 UsageView 的 load():每次请求 begin 领代次,响应回来先 accept 再 setState。
 */
describe('RequestGate(S-02 请求代次保护)', () => {
  it('最新代次允许落地;有新请求后旧代次作废', () => {
    const gate = createRequestGate()
    const gen1 = gate.begin()
    expect(gate.accept(gen1)).toBe(true)

    const gen2 = gate.begin()
    expect(gen2).toBeGreaterThan(gen1)
    expect(gate.accept(gen1)).toBe(false) // 旧代次
    expect(gate.accept(gen2)).toBe(true)
  })

  it('组件卸载后,任何代次的响应都丢弃;重挂载(StrictMode)后最新代次恢复', () => {
    const gate = createRequestGate()
    const gen1 = gate.begin()
    gate.unmount()
    expect(gate.accept(gen1)).toBe(false)

    // StrictMode:同一组件实例卸载→重挂载,代次不清零
    gate.mount()
    const gen2 = gate.begin()
    expect(gate.accept(gen1)).toBe(false)
    expect(gate.accept(gen2)).toBe(true)
  })

  it('竞态:慢旧请求 + 快新请求,最终只有新请求结果落地', async () => {
    const gate = createRequestGate()
    const applied: string[] = []

    const deferred = <T>() => {
      let resolve!: (value: T) => void
      const promise = new Promise<T>((res) => { resolve = res })
      return { promise, resolve }
    }

    /* 旧请求(慢):gen1;新请求(快):gen2 */
    const slow = deferred<string>()
    const fast = deferred<string>()

    const runRequest = async (gen: number, promise: Promise<string>) => {
      const result = await promise
      if (gate.accept(gen)) applied.push(result)
    }

    const gen1 = gate.begin()
    const p1 = runRequest(gen1, slow.promise)
    const gen2 = gate.begin()
    const p2 = runRequest(gen2, fast.promise)

    fast.resolve('新快照')
    await p2
    expect(applied).toEqual(['新快照'])

    slow.resolve('旧快照')
    await p1
    expect(applied).toEqual(['新快照']) // 旧响应被丢弃,不覆盖
  })

  it('卸载场景:请求在途时组件卸载,响应到达后不落地', async () => {
    const gate = createRequestGate()
    const applied: string[] = []
    const gen = gate.begin()
    gate.unmount() // 请求在途时卸载
    const result = await Promise.resolve('迟到的响应')
    if (gate.accept(gen)) applied.push(result)
    expect(applied).toEqual([])
  })
})
