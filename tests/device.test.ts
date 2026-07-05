import { describe, expect, test, vi } from 'vitest'
import { TegraDevice } from '../src/device'
import { WebUsbTransport } from '../src/transport'
import { bytes, createFakeTransport } from './fixtures'

describe('TegraDevice', () => {
  test('connect() opens the transport', async () => {
    const fake = createFakeTransport()
    const device = new TegraDevice(fake.transport)
    await device.connect()
    expect(fake.isConnected()).toBe(true)
  })

  test('readUid() returns the 16-byte device id from the first bulk-IN', async () => {
    const fake = createFakeTransport()
    const uid = bytes(...Array.from({ length: 16 }, (_, i) => i))
    fake.queueBulkIn(uid)

    const device = new TegraDevice(fake.transport)
    expect(await device.readUid()).toEqual(uid)
  })

  test('readUid() throws on a short device-id read', async () => {
    const fake = createFakeTransport()
    fake.queueBulkIn(bytes(1, 2, 3, 4)) // 4 bytes, not the expected 16
    const device = new TegraDevice(fake.transport)
    await expect(device.readUid()).rejects.toThrow(/device id/i)
  })

  test('send() forwards bytes to bulkOut', async () => {
    const fake = createFakeTransport()
    const device = new TegraDevice(fake.transport)
    await device.send(bytes(1, 2, 3))
    expect(fake.sent).toEqual([bytes(1, 2, 3)])
  })

  test('close() closes the transport', async () => {
    const fake = createFakeTransport()
    const device = new TegraDevice(fake.transport)
    await device.connect()
    await device.close()
    expect(fake.isConnected()).toBe(false)
  })

  test('receive() reads from bulkIn', async () => {
    const fake = createFakeTransport()
    fake.queueBulkIn(bytes(0, 0, 0, 0))
    const device = new TegraDevice(fake.transport)
    expect(await device.receive(4)).toEqual(bytes(0, 0, 0, 0))
  })

  test('controlTransferIn() forwards the setup packet and length', async () => {
    const fake = createFakeTransport()
    const device = new TegraDevice(fake.transport)
    const setup: USBControlTransferParameters = {
      requestType: 'standard',
      recipient: 'device',
      request: 6,
      value: 0x0100,
      index: 0
    }

    const reply = await device.controlTransferIn(setup, 18)

    expect(reply).toHaveLength(18)
    expect(fake.controlTransfers).toEqual([{ setup, length: 18 }])
  })

  test('wraps a raw USBDevice in a WebUsbTransport', () => {
    const usbDevice = { transferIn: () => {} } as unknown as USBDevice
    const device = new TegraDevice(usbDevice)
    expect(device.transport).toBeInstanceOf(WebUsbTransport)
    expect(device.usbDevice).toBe(usbDevice)
  })

  test('usbDevice is undefined for a custom transport', () => {
    const fake = createFakeTransport()
    expect(new TegraDevice(fake.transport).usbDevice).toBeUndefined()
  })

  test('routes debug logs to the provided logger when logging is on', async () => {
    const fake = createFakeTransport()
    const logger = vi.fn()
    const device = new TegraDevice(fake.transport, { logging: true, logger })

    await device.connect()
    fake.queueBulkIn(bytes(...new Array(16).fill(0)))
    await device.readUid()

    expect(logger).toHaveBeenCalledWith('debug', '[tegra] connected')
    expect(logger).toHaveBeenCalledWith('debug', '[tegra] device id', expect.any(Uint8Array))
  })

  test('falls back to the console logger when none is provided', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const fake = createFakeTransport()
    const device = new TegraDevice(fake.transport, { logging: true })
    await device.connect()
    expect(log).toHaveBeenCalledWith('[tegra] connected')
    log.mockRestore()
  })

  test('stays silent when logging is off', async () => {
    const fake = createFakeTransport()
    const logger = vi.fn()
    const device = new TegraDevice(fake.transport, { logger })
    await device.connect()
    expect(logger).not.toHaveBeenCalled()
  })
})
