import { afterEach, describe, expect, test, vi } from 'vitest'
import { consoleLogger } from '../src/logger'

afterEach(() => vi.restoreAllMocks())

describe('consoleLogger', () => {
  test('routes info to console.info', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    consoleLogger('info', 'connected', 42)
    expect(info).toHaveBeenCalledWith('connected', 42)
  })

  test('routes debug to console.log', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    consoleLogger('debug', '[tegra] device id', new Uint8Array(16))
    expect(log).toHaveBeenCalledWith('[tegra] device id', new Uint8Array(16))
  })
})
