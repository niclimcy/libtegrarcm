export class TegraUsbError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

/** RCM message framing / protocol failure. */
export class RcmError extends TegraUsbError {}

/** BCT assembly / parsing failure. */
export class BctError extends TegraUsbError {}

/** Signing (RSA / ECC / AES-CMAC) failure. */
export class SignError extends TegraUsbError {}

/**
 * The device re-enumerated and the browser dropped its WebUSB grant. Tegra
 * recovery devices are serial-less, so the spec drops the grant on
 * re-enumeration (e.g. after boot). Recover by prompting the user with
 * requestDevice() again (requires a user gesture).
 */
export class ReacquireNeededError extends TegraUsbError {
  constructor() {
    super(
      'the WebUSB grant was dropped on re-enumeration (serial-less device); ' +
        'prompt the user with requestDevice() to reacquire it'
    )
  }
}
