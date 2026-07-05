import { afterEach, describe, expect, test, vi } from 'vitest'
import { WebUsbTransport } from '../src/transport'

const VENDOR_CLASS = 0xff
const TIMEOUT = 1000

function endpoint(direction: 'in' | 'out', endpointNumber: number): USBEndpoint {
  return { direction, endpointNumber, type: 'bulk', packetSize: 64 }
}

function alternate(
  alternateSetting: number,
  interfaceClass: number,
  endpoints: USBEndpoint[]
): USBAlternateInterface {
  return {
    alternateSetting,
    interfaceClass,
    interfaceSubclass: 0xff,
    interfaceProtocol: 0xff,
    interfaceName: null,
    endpoints
  }
}

function configuration(
  interfaces: { interfaceNumber: number; alternates: USBAlternateInterface[] }[]
): USBConfiguration {
  return {
    configurationValue: 1,
    configurationName: null,
    interfaces: interfaces.map((usbInterface) => ({
      ...usbInterface,
      alternate: usbInterface.alternates[0]!,
      claimed: false
    }))
  }
}

/** The lone vendor-specific bulk in/out pair a real RCM device exposes. */
function rcmConfiguration(): USBConfiguration {
  return configuration([
    {
      interfaceNumber: 0,
      alternates: [alternate(0, VENDOR_CLASS, [endpoint('out', 1), endpoint('in', 1)])]
    }
  ])
}

function createMockUsbDevice(options: {
  configuration?: USBConfiguration
  /** configuration installed by selectConfiguration(); omit to leave none. */
  selectable?: USBConfiguration
}) {
  const okIn = (): Promise<USBInTransferResult> =>
    Promise.resolve({ status: 'ok', data: new DataView(new ArrayBuffer(0)) })
  const device = {
    configuration: options.configuration,
    open: vi.fn(() => Promise.resolve()),
    selectConfiguration: vi.fn(() => {
      device.configuration = options.selectable
      return Promise.resolve()
    }),
    claimInterface: vi.fn(() => Promise.resolve()),
    selectAlternateInterface: vi.fn(() => Promise.resolve()),
    transferOut: vi.fn((): Promise<USBOutTransferResult> =>
      Promise.resolve({ status: 'ok', bytesWritten: 0 })
    ),
    transferIn: vi.fn(okIn),
    controlTransferIn: vi.fn(okIn),
    close: vi.fn(() => Promise.resolve())
  }
  return device
}

function transportFor(device: ReturnType<typeof createMockUsbDevice>): WebUsbTransport {
  return new WebUsbTransport(device as unknown as USBDevice)
}

afterEach(() => vi.unstubAllGlobals())

describe('WebUsbTransport.connect', () => {
  test('claims the vendor-specific interface carrying the bulk pair', async () => {
    const device = createMockUsbDevice({
      configuration: configuration([
        // mass-storage-looking interface with endpoints: must be skipped
        {
          interfaceNumber: 0,
          alternates: [alternate(0, 0x08, [endpoint('out', 2), endpoint('in', 2)])]
        },
        {
          interfaceNumber: 1,
          alternates: [alternate(0, VENDOR_CLASS, [endpoint('out', 1), endpoint('in', 1)])]
        }
      ])
    })
    const transport = transportFor(device)

    await transport.connect(TIMEOUT)

    expect(device.open).toHaveBeenCalled()
    expect(device.claimInterface).toHaveBeenCalledWith(1)
    expect(transport.outEndpointNum).toBe(1)
    expect(transport.inEndpointNum).toBe(1)
    // alternate 0 needs no explicit select
    expect(device.selectAlternateInterface).not.toHaveBeenCalled()
  })

  test('selects a non-zero alternate setting when the bulk pair lives there', async () => {
    const device = createMockUsbDevice({
      configuration: configuration([
        {
          interfaceNumber: 0,
          alternates: [
            alternate(0, VENDOR_CLASS, []),
            alternate(1, VENDOR_CLASS, [endpoint('out', 3), endpoint('in', 4)])
          ]
        }
      ])
    })
    const transport = transportFor(device)

    await transport.connect(TIMEOUT)

    expect(device.claimInterface).toHaveBeenCalledWith(0)
    expect(device.selectAlternateInterface).toHaveBeenCalledWith(0, 1)
    expect(transport.outEndpointNum).toBe(3)
    expect(transport.inEndpointNum).toBe(4)
  })

  test('selects configuration 1 when none is active', async () => {
    const device = createMockUsbDevice({ selectable: rcmConfiguration() })
    await transportFor(device).connect(TIMEOUT)
    expect(device.selectConfiguration).toHaveBeenCalledWith(1)
  })

  test('skips selectConfiguration when a configuration is already active', async () => {
    const device = createMockUsbDevice({ configuration: rcmConfiguration() })
    await transportFor(device).connect(TIMEOUT)
    expect(device.selectConfiguration).not.toHaveBeenCalled()
  })

  test('throws when no configuration can be selected', async () => {
    const device = createMockUsbDevice({})
    await expect(transportFor(device).connect(TIMEOUT)).rejects.toThrow(
      /Unable to select the proper configuration/
    )
  })

  test('throws when no vendor-specific bulk pair exists', async () => {
    const device = createMockUsbDevice({
      configuration: configuration([
        // vendor class but missing the IN endpoint
        { interfaceNumber: 0, alternates: [alternate(0, VENDOR_CLASS, [endpoint('out', 1)])] }
      ])
    })
    await expect(transportFor(device).connect(TIMEOUT)).rejects.toThrow(
      /Unable to locate the bulk endpoints/
    )
    expect(device.claimInterface).not.toHaveBeenCalled()
  })
})

describe('WebUsbTransport transfers', () => {
  async function connected() {
    const device = createMockUsbDevice({ configuration: rcmConfiguration() })
    const transport = transportFor(device)
    await transport.connect(TIMEOUT)
    return { device, transport }
  }

  test('bulkOut forwards data to the OUT endpoint', async () => {
    const { device, transport } = await connected()
    const data = new Uint8Array([1, 2, 3])
    await transport.bulkOut(data, TIMEOUT)
    expect(device.transferOut).toHaveBeenCalledWith(1, data)
  })

  test('bulkOut throws on a non-ok transfer status', async () => {
    const { device, transport } = await connected()
    device.transferOut.mockResolvedValueOnce({ status: 'stall', bytesWritten: 0 })
    await expect(transport.bulkOut(new Uint8Array(1), TIMEOUT)).rejects.toThrow(
      /transmit status stall/
    )
  })

  test('bulkIn copies out the received bytes, honoring the view byteOffset', async () => {
    const { device, transport } = await connected()
    const backing = new Uint8Array([0xff, 0xff, 0x11, 0x22, 0x33, 0xff])
    device.transferIn.mockResolvedValueOnce({
      status: 'ok',
      data: new DataView(backing.buffer, 2, 3)
    })

    const received = await transport.bulkIn(3, TIMEOUT)

    expect(device.transferIn).toHaveBeenCalledWith(1, 3)
    expect(received).toEqual(new Uint8Array([0x11, 0x22, 0x33]))
    // an owned copy, not a window into the transfer buffer
    expect(received.buffer).not.toBe(backing.buffer)
  })

  test('bulkIn throws on a non-ok transfer status', async () => {
    const { device, transport } = await connected()
    device.transferIn.mockResolvedValueOnce({ status: 'babble' })
    await expect(transport.bulkIn(4, TIMEOUT)).rejects.toThrow(/receive failed with status babble/)
  })

  test('controlTransferIn forwards the setup packet and decodes the reply', async () => {
    const { device, transport } = await connected()
    const reply = new Uint8Array([0x12, 0x01])
    device.controlTransferIn.mockResolvedValueOnce({
      status: 'ok',
      data: new DataView(reply.buffer)
    })
    const setup: USBControlTransferParameters = {
      requestType: 'standard',
      recipient: 'device',
      request: 6,
      value: 0x0100,
      index: 0
    }

    expect(await transport.controlTransferIn(setup, 2, TIMEOUT)).toEqual(reply)
    expect(device.controlTransferIn).toHaveBeenCalledWith(setup, 2)
  })

  test('close closes the underlying device', async () => {
    const { device, transport } = await connected()
    await transport.close(TIMEOUT)
    expect(device.close).toHaveBeenCalled()
  })
})

describe('WebUsbTransport.onDisconnect', () => {
  function disconnectEvent(device: unknown): Event {
    return Object.assign(new Event('disconnect'), { device })
  }

  test('fires once, only for the matching device', () => {
    const usb = new EventTarget()
    vi.stubGlobal('navigator', { usb })

    const device = createMockUsbDevice({ configuration: rcmConfiguration() })
    const transport = transportFor(device)
    const callback = vi.fn()
    transport.onDisconnect(callback)

    usb.dispatchEvent(disconnectEvent({ other: true }))
    expect(callback).not.toHaveBeenCalled()

    usb.dispatchEvent(disconnectEvent(device))
    expect(callback).toHaveBeenCalledTimes(1)

    // one-shot: a second disconnect of the same device does not re-fire
    usb.dispatchEvent(disconnectEvent(device))
    expect(callback).toHaveBeenCalledTimes(1)
  })
})
