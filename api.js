'use strict';

/**
 * The app's own HTTP API, reachable at
 *
 *   https://<homey>/api/app/dev.rymenants.tvremote/<path>
 *
 * These endpoints are declared public in the manifest, so the standalone
 * remote page can call them straight from a browser without carrying a token.
 * A Homey token would grant control over the entire house; this grants control
 * over a television, to whoever is already on the home network.
 */
module.exports = {

  async status({ homey }) {
    return homey.app.status();
  },

  async press({ homey, body }) {
    return homey.app.press(body && body.button);
  },

  async search({ homey, body }) {
    return homey.app.search(body && body.service, body && body.term);
  },

  async text({ homey, body }) {
    return homey.app.sendText(body && body.term);
  },

  async wake({ homey }) {
    return homey.app.wake();
  },
};
