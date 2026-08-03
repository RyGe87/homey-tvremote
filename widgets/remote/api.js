'use strict';

module.exports = {
  async press({ homey, body }) {
    return homey.app.press(body && body.button);
  },

  async status({ homey }) {
    return homey.app.status();
  },

  async search({ homey, body }) {
    return homey.app.search(body && body.service, body && body.term);
  },


  async text({ homey, body }) {
    return homey.app.sendText(body && body.term);
  },

  async pairStart({ homey, body }) {
    return homey.app.pairStart(body && body.ip);
  },

  async setHost({ homey, body }) {
    return homey.app.setHost(body && body.ip);
  },

  async pairCode({ homey, body }) {
    return homey.app.pairCode(body && body.code);
  },

  async wake({ homey }) {
    return homey.app.wake();
  },
};
