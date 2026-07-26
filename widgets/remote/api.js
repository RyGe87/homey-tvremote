'use strict';

module.exports = {
  async press({ homey, body }) {
    return homey.app.press(body && body.button);
  },

  async status({ homey }) {
    return homey.app.status();
  },
};
