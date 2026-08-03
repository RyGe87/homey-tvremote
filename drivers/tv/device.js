'use strict';

const Homey = require('homey');

// The television is polled rather than subscribed to: one connection is all a
// television allows, and the app owns it. Ten seconds is quick enough for a
// flow condition and gentle enough to leave the connection alone.
const POLL_MS = 10000;

class TvDevice extends Homey.Device {

  async onInit() {
    this.registerCapabilityListener('onoff', value => this.setPower(value));
    this.registerCapabilityListener('volume_up', () => this.homey.app.press('volume_up'));
    this.registerCapabilityListener('volume_down', () => this.homey.app.press('volume_down'));
    this.registerCapabilityListener('volume_mute', () => this.homey.app.press('mute'));

    this.poll = this.homey.setInterval(() => {
      this.refresh().catch(err => this.error(`Refresh failed: ${err.message}`));
    }, POLL_MS);
    this.refresh().catch(() => {});

    this.log('Television device ready');
  }

  async onUninit() {
    if (this.poll) this.homey.clearInterval(this.poll);
  }

  /** The address lives in the app, because the connection does. This keeps
   *  the device's own settings page the one place to correct it. */
  async onSettings({ newSettings, changedKeys }) {
    if (!changedKeys.includes('ip')) return;
    this.homey.app.setHost(newSettings.ip);
    this.refresh().catch(() => {});
  }

  /** The power key toggles, so only press it when the television is not
   *  already in the state being asked for. */
  async setPower(value) {
    const status = await this.homey.app.status();

    if (!status.connected) {
      if (!value) throw new Error('De tv is niet bereikbaar');
      // Asking an unreachable television to turn on is exactly what waking is
      // for; the widget shows how far it got.
      await this.homey.app.wake();
      return;
    }

    if (status.on === Boolean(value)) return;
    await this.homey.app.press('power');
  }

  async refresh() {
    const status = await this.homey.app.status();

    if (!status.connected) {
      // Unavailable rather than guessing: a sleeping television says nothing.
      await this.setUnavailable('De tv is niet bereikbaar').catch(() => {});
      return;
    }

    await this.setAvailable().catch(() => {});
    if (typeof status.on === 'boolean') {
      await this.setCapabilityValue('onoff', status.on).catch(() => {});
    }
  }
}

module.exports = TvDevice;
