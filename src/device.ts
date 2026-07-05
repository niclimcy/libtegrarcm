import { RcmError } from './errors'
import { consoleLogger, Logger } from './logger'
import { UsbTransport, WebUsbTransport } from './transport'

export type DeviceOptions = {
  /** whether to enable additional logging (basic logging is already enabled) */
  logging: boolean
  /** the number of milliseconds to time out after */
  timeout: number
  /** where to send log output; defaults to the console */
  logger?: Logger
}

const DEFAULT_DEVICE_OPTIONS: DeviceOptions = {
  logging: false,
  timeout: 5000
}

/** T210/T214 device id (chip UID) length returned by the bootrom. */
const DEVICE_ID_LENGTH = 16

function isUsbDevice(value: UsbTransport | USBDevice): value is USBDevice {
  return 'transferIn' in value && typeof value.transferIn === 'function'
}

/** A Tegra SoC in RCM (recovery / APX) mode. */
export class TegraDevice {
  transport: UsbTransport
  deviceOptions: DeviceOptions

  constructor(transport: UsbTransport | USBDevice, options?: Partial<DeviceOptions>) {
    this.transport = isUsbDevice(transport) ? new WebUsbTransport(transport) : transport
    this.deviceOptions = { ...DEFAULT_DEVICE_OPTIONS, ...options }
  }

  /** The underlying WebUSB device, when connected over WebUSB. */
  get usbDevice(): USBDevice | undefined {
    return this.transport instanceof WebUsbTransport ? this.transport.device : undefined
  }

  private get logger(): Logger {
    return this.deviceOptions.logger ?? consoleLogger
  }

  private log(...data: unknown[]): void {
    if (this.deviceOptions.logging) this.logger('debug', ...data)
  }

  async connect(): Promise<void> {
    await this.transport.connect(this.deviceOptions.timeout)
    this.log('[tegra] connected')
  }

  /**
   * Read the chip's unique id. The bootrom emits the device id as the first
   * bulk-IN packet after enumeration; this is the value tegrarcm/fusee use to
   * select per-device options and confirm the device is in recovery.
   */
  async readUid(): Promise<Uint8Array<ArrayBuffer>> {
    const uid = await this.transport.bulkIn(DEVICE_ID_LENGTH, this.deviceOptions.timeout)
    if (uid.length !== DEVICE_ID_LENGTH) {
      throw new RcmError(`short device id: expected ${DEVICE_ID_LENGTH} bytes, got ${uid.length}`)
    }
    this.log('[tegra] device id', uid)
    return uid
  }

  /** Send a framed RCM message (or raw payload chunk) to the bootrom. */
  async send(data: Uint8Array<ArrayBuffer>): Promise<void> {
    await this.transport.bulkOut(data, this.deviceOptions.timeout)
  }

  /** Read up to `length` bytes from the bulk IN endpoint (e.g. status replies). */
  async receive(length: number): Promise<Uint8Array<ArrayBuffer>> {
    return this.transport.bulkIn(length, this.deviceOptions.timeout)
  }

  /** Perform a standard/class/vendor control IN transfer. */
  async controlTransferIn(
    setup: USBControlTransferParameters,
    length: number
  ): Promise<Uint8Array<ArrayBuffer>> {
    return this.transport.controlTransferIn(setup, length, this.deviceOptions.timeout)
  }

  async close(): Promise<void> {
    await this.transport.close(this.deviceOptions.timeout)
  }
}
