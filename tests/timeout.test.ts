import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { delay, timeoutPromise } from '../src/utils/timeout'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('timeoutPromise', () => {
  test('resolves with the value when the promise settles in time', async () => {
    await expect(timeoutPromise(Promise.resolve(42), 'too slow', 1000)).resolves.toBe(42)
  })

  test('propagates the underlying rejection', async () => {
    await expect(
      timeoutPromise(Promise.reject(new Error('endpoint stalled')), 'too slow', 1000)
    ).rejects.toThrow('endpoint stalled')
  })

  test('rejects with the reason once the timeout elapses', async () => {
    const never = new Promise<void>(() => {})
    const raced = timeoutPromise(never, '[device] unable to receive bulk data', 1000)
    const assertion = expect(raced).rejects.toThrow('[device] unable to receive bulk data')
    await vi.advanceTimersByTimeAsync(1000)
    await assertion
  })

  test('does not time out one tick early', async () => {
    let settled = false
    const raced = timeoutPromise(new Promise<void>(() => {}), 'too slow', 1000)
    raced.catch(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
  })

  test('clears its timer when the wrapped promise settles first', async () => {
    await timeoutPromise(Promise.resolve('done'), 'too slow', 1000)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('clears its timer when the wrapped promise rejects first', async () => {
    await timeoutPromise(Promise.reject(new Error('boom')), 'too slow', 1000).catch(() => {})
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('delay', () => {
  test('resolves after the given milliseconds', async () => {
    let done = false
    const pending = delay(500).then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(499)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(done).toBe(true)
  })
})
