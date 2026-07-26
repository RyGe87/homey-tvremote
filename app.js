'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');

// The Android TV app exposes most keys as button capabilities. A few keys —
// notably the options/menu key — only exist behind its press_key flow action.
const ANDROID_TV_URI = 'homey:app:com.android.tv';
const PRESS_KEY_CARD = `${ANDROID_TV_URI}:press_key`;

// Buttons in the widget mapped to what the television actually understands.
const CAPABILITY_KEYS = {
  up: 'key_cursor_up',
  down: 'key_cursor_down',
  left: 'key_cursor_left',
  right: 'key_cursor_right',
  ok: 'key_confirm',
  back: 'key_back',
  // Android TV has no dedicated exit key; leaving the app means going home.
  exit: 'key_home',
  previous: 'key_previous',
  next: 'key_next',
  volume_up: 'volume_up',
  volume_down: 'volume_down',
  mute: 'volume_mute',
};

// Keys without a capability, sent through the Android TV app's flow card.
const FLOW_KEYS = {
  info: 'key_options',
};

class TvRemoteApp extends Homey.App {

  async onInit() {
    this.api = await HomeyAPI.createAppAPI({ homey: this.homey });
    this._deviceId = null;
    this.log('TV Remote widget app started');

    // Resolve the television once at startup so the log immediately shows
    // whether the widget will have something to talk to.
    this.status()
      .then(status => this.log('Television:', JSON.stringify(status)))
      .catch(err => this.error(`Could not resolve television: ${err}`));
  }

  /** The television device, cached. Any device from the Android TV app will
   *  do; households with one TV never have to configure anything. */
  async getDevice() {
    const devices = await this.api.devices.getDevices();

    if (this._deviceId && devices[this._deviceId]) {
      return devices[this._deviceId];
    }

    const device = Object.values(devices).find(d => {
      const driver = String(d.driverId || d.driverUri || '');
      return driver.includes('com.android.tv')
        || (Array.isArray(d.capabilities) && d.capabilities.includes('key_confirm'));
    });

    if (!device) {
      throw new Error('No Android TV device found in Homey');
    }
    this._deviceId = device.id;
    return device;
  }

  async status() {
    try {
      const device = await this.getDevice();
      const onoff = device.capabilitiesObj && device.capabilitiesObj.onoff;
      return {
        found: true,
        name: device.name,
        available: Boolean(device.available),
        on: onoff ? Boolean(onoff.value) : null,
      };
    } catch (err) {
      return { found: false, error: err.message };
    }
  }

  async press(button) {
    const device = await this.getDevice();

    if (button === 'power') {
      const current = device.capabilitiesObj && device.capabilitiesObj.onoff;
      const next = !(current && current.value);
      await device.setCapabilityValue({ capabilityId: 'onoff', value: next });
      this.log(`power -> ${next ? 'on' : 'off'}`);
      return { ok: true, on: next };
    }

    const capability = CAPABILITY_KEYS[button];
    if (capability) {
      await device.setCapabilityValue({ capabilityId: capability, value: true });
      this.log(`${button} -> ${capability}`);
      return { ok: true };
    }

    const flowKey = FLOW_KEYS[button];
    if (flowKey) {
      await this.api.flow.runFlowCardAction({
        uri: ANDROID_TV_URI,
        id: PRESS_KEY_CARD,
        args: {
          device: { id: device.id },
          option: { id: flowKey, key: flowKey, name: flowKey },
        },
      });
      this.log(`${button} -> flow key ${flowKey}`);
      return { ok: true };
    }

    throw new Error(`Unknown button: ${button}`);
  }
}

module.exports = TvRemoteApp;
