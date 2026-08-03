'use strict';

const Homey = require('homey');

class TvDriver extends Homey.Driver {

  /** Pairing happens here rather than in the widget: this is where Homey
   *  expects it, and a television only accepts one client, so there is one
   *  place where that one client is established. */
  async onPair(session) {
    this.attachPairing(session);

    session.setHandler('list_devices', async () => [{
      name: 'Televisie',
      data: { id: 'androidtv' },
      settings: { ip: this.homey.app.knownHost() || '' },
    }]);
  }

  /** Repairing is the same conversation without adding a device: used when
   *  the television forgot the pairing, or after a factory reset. */
  async onRepair(session) {
    this.attachPairing(session);
  }

  attachPairing(session) {
    session.setHandler('known_host', async () => this.homey.app.knownHost());

    // The address is collected on the first step and only checked on the
    // second, when the connection is actually attempted — typing half an
    // address should not throw an error after every keystroke.
    session.setHandler('set_host', async ip => {
      this._host = ip;
      return true;
    });

    session.setHandler('pair_start', async () => {
      await this.homey.app.pairStart(this._host);
      return true;
    });

    session.setHandler('pair_code', async code => {
      await this.homey.app.pairCode(code);
      return true;
    });
  }
}

module.exports = TvDriver;
