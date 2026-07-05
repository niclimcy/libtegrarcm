import { DeviceFilters } from './constants'
import { DeviceOptions, TegraDevice } from './device'
import { TegraUsbError } from './errors'

/**
 * Prompt the user to pick a Tegra device in RCM (recovery / APX) mode.
 * Call {@link TegraDevice.connect} on the result before using it.
 */
export async function requestDevice(options?: Partial<DeviceOptions>): Promise<TegraDevice> {
  if (typeof navigator === 'undefined' || !navigator.usb) {
    throw new TegraUsbError('WebUSB is not available in this browser')
  }

  const usbDevice = await navigator.usb.requestDevice({ filters: DeviceFilters })
  return new TegraDevice(usbDevice, options)
}
