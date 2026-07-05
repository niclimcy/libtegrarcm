import { afterEach, describe, expect, test, vi } from 'vitest'
import { DeviceFilters } from '../src/constants'
import { TegraUsbError } from '../src/errors'
import { requestDevice } from '../src/requestDevice'

afterEach(() => vi.unstubAllGlobals())

describe('requestDevice', () => {
  test('throws TegraUsbError when WebUSB is unavailable', async () => {
    vi.stubGlobal('navigator', {})
    await expect(requestDevice()).rejects.toThrow(TegraUsbError)
    await expect(requestDevice()).rejects.toThrow(/WebUSB is not available/)
  })

  test('prompts with the NVIDIA filter and wraps the picked device', async () => {
    const usbDevice = { transferIn: () => {} }
    const request = vi.fn(() => Promise.resolve(usbDevice))
    vi.stubGlobal('navigator', { usb: { requestDevice: request } })

    const device = await requestDevice({ timeout: 123 })

    expect(request).toHaveBeenCalledWith({ filters: DeviceFilters })
    expect(device.usbDevice).toBe(usbDevice)
    expect(device.deviceOptions.timeout).toBe(123)
  })
})
