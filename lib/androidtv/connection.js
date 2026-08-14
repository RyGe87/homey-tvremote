'use strict';

const tls = require('tls');
const path = require('path');
const EventEmitter = require('events');
const protobuf = require('protobufjs');

const { DelimitedReader } = require('./framing');

const REMOTE_PORT = 6466;

// The television announces what it supports as a bit mask, and expects the
// same shape back. Without the IME bit it never tells us which text field is
// selected, and typing is then impossible.
const FEATURE = {
  PING: 1,
  KEY: 2,
  IME: 4,
  VOICE: 8,
  UNKNOWN_1: 16,
  POWER: 32,
  VOLUME: 64,
  APP_LINK: 512,
};

const WANTED_FEATURES = FEATURE.PING | FEATURE.KEY | FEATURE.IME
  | FEATURE.POWER | FEATURE.VOLUME | FEATURE.APP_LINK;

/** A live connection to a paired Android TV.
 *
 *  Emits: ready, powered(bool), app(package), field(state), close, error
 */
class RemoteConnection extends EventEmitter {

  constructor({ host, certs, model = 'Homey', vendor = 'Athom' }) {
    super();
    this.host = host;
    this.certs = certs;
    this.model = model;
    this.vendor = vendor;

    const root = protobuf.loadSync(path.join(__dirname, 'remotemessage.proto'));
    this.RemoteMessage = root.lookupType('remote.RemoteMessage');
    this.KeyCode = root.lookupEnum('remote.RemoteKeyCode').values;
    this.Direction = root.lookupEnum('remote.RemoteDirection').values;

    this.reader = new DelimitedReader();
    this.socket = null;
    this.connected = false;

    this.features = WANTED_FEATURES;
    this.imeCounter = 0;
    this.fieldCounter = 0;
    // The identifier the television gives the selected field itself, which is
    // numbered separately from the batch-edit counters above.
    this.textFieldCounter = 0;
    // Rises every time the television confirms the contents of a text field.
    this.echoCount = 0;
    this.currentApp = null;
    this.powered = null;
    // What the television says is in the selected text field, if anything.
    this.textField = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve(this);
      };

      this.socket = tls.connect({
        host: this.host,
        port: REMOTE_PORT,
        cert: this.certs.cert,
        key: this.certs.key,
        rejectUnauthorized: false,
      });

      // The television pings every few seconds; silence means it is gone.
      this.socket.setTimeout(15000);
      this.socket.on('timeout', () => this.socket.destroy());

      this.socket.on('secureConnect', () => {
        this.connected = true;
      });

      this.socket.on('data', chunk => {
        try {
          for (const frame of this.reader.push(chunk)) this.handle(frame, settle);
        } catch (err) {
          this.emit('error', err);
        }
      });

      this.socket.on('error', err => {
        this.emit('error', err);
        settle(err);
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.emit('close');
        settle(new Error('De verbinding met de tv sloot voor ze klaar was'));
      });
    });
  }

  send(payload) {
    if (!this.socket || this.socket.destroyed) throw new Error('Geen verbinding met de tv');
    const message = this.RemoteMessage.create(payload);
    this.socket.write(Buffer.from(this.RemoteMessage.encodeDelimited(message).finish()));
  }

  handle(frame, settle) {
    const message = this.RemoteMessage.decode(frame);

    // Anything but the heartbeat is worth seeing while debugging.
    if (!message.remotePingRequest && this.listenerCount('message')) {
      this.emit('message', this.RemoteMessage.toObject(message, { defaults: false }));
    }

    if (message.remoteConfigure) {
      // Keep only what both sides can do, then answer in the same shape.
      const supported = Number(message.remoteConfigure.code1 || 0);
      if (supported) this.features &= supported;

      this.send({
        remoteConfigure: {
          code1: this.features,
          deviceInfo: {
            model: this.model,
            vendor: this.vendor,
            unknown1: 1,
            unknown2: '1',
            packageName: 'homey-tvremote',
            appVersion: '1.0.0',
          },
        },
      });
      this.emit('ready', this.features);
      if (settle) settle();
    } else if (message.remoteSetActive) {
      this.send({ remoteSetActive: { active: this.features } });
    } else if (message.remotePingRequest) {
      this.send({ remotePingResponse: { val1: message.remotePingRequest.val1 } });
    } else if (message.remoteImeBatchEdit) {
      // These counters are what makes typing possible; they identify the
      // text field the television currently has open.
      this.imeCounter = message.remoteImeBatchEdit.imeCounter;
      this.fieldCounter = message.remoteImeBatchEdit.fieldCounter;
      this.emit('field', { imeCounter: this.imeCounter, fieldCounter: this.fieldCounter });
    } else if (message.remoteImeKeyInject) {
      const info = message.remoteImeKeyInject;
      this.currentApp = (info.appInfo && info.appInfo.appPackage) || this.currentApp;
      if (info.textFieldStatus) {
        this.textField = {
          value: info.textFieldStatus.value,
          label: info.textFieldStatus.label,
          counter: info.textFieldStatus.counterField,
        };
        // A field carries its own identifier, which is not the same number as
        // the batch-edit counters. Keep them apart instead of overwriting.
        this.textFieldCounter = info.textFieldStatus.counterField || this.textFieldCounter;
      }
      this.emit('app', this.currentApp);
    } else if (message.remoteImeShowRequest) {
      const status = message.remoteImeShowRequest.remoteTextFieldStatus;
      if (status) {
        // The television answers every edit with a fresh field identifier;
        // the next edit has to quote that newest one.
        this.textFieldCounter = status.counterField || this.textFieldCounter;
        this.textField = { value: status.value, counter: status.counterField };
        // Counting the echoes is how a caller knows an edit was accepted.
        this.echoCount += 1;
        this.emit('field', { fieldCounter: this.textFieldCounter, value: status.value });
      }
    } else if (message.remoteStart) {
      this.powered = Boolean(message.remoteStart.started);
      this.emit('powered', this.powered);
    } else if (message.remoteError) {
      this.emit('error', new Error('De tv meldde een fout'));
    }
  }

  /** Types a whole word into the text field the television has selected.
   *
   *  Both start and end are the length of the text minus one — the position
   *  of its last character, not the length. The reference implementation's
   *  own comment says "length", but its code does not, and the television
   *  agrees with the code.
   */
  sendText(text, { replace = false } = {}) {
    const value = String(text);
    const current = (this.textField && this.textField.value) || '';
    // Inserting puts the caret at the end of the new text; replacing selects
    // everything that is already in the field so it gets overwritten.
    const caret = replace ? 0 : Math.max(value.length - 1, 0);
    const tail = replace ? current.length : caret;
    // Measured against a real set: the field must be named by its OWN
    // identifier, the one the television reports in a text field status —
    // not by the counter inside its batch-edit message, which is a different
    // and much smaller number. Quoting the wrong one is silently ignored.
    this.sendEdit(value, caret, tail);
  }

  /** The raw edit, so the caret positions can be steered from outside while
   *  working out what a particular television expects. */
  sendEdit(value, start, end) {
    const field = this.fieldId();
    this.send({
      remoteImeBatchEdit: {
        imeCounter: this.imeCounter,
        fieldCounter: field,
        editInfo: [{
          insert: 1,
          textFieldStatus: { start, end, value },
        }],
      },
    });
  }

  sendKey(keyCode, direction = this.Direction.SHORT) {
    const code = typeof keyCode === 'string' ? this.KeyCode[keyCode] : keyCode;
    if (code === undefined) throw new Error(`Onbekende toets: ${keyCode}`);
    this.send({ remoteKeyInject: { keyCode: code, direction } });
  }

  sendAppLink(link) {
    this.send({ remoteAppLinkLaunchRequest: { appLink: link } });
  }

  /** The number an edit has to quote: the field's own identifier when the
   *  television gave us one, the batch-edit counter otherwise. Nought means
   *  it has named no field at all, and an edit would go nowhere. */
  fieldId() {
    return this.textFieldCounter || this.fieldCounter;
  }

  /** True once the television told us which field is open — typing before
   *  that lands nowhere. */
  hasTextField() {
    return Boolean(this.fieldId());
  }

  /** Asks the television to say again which text field it has open.
   *
   *  It announces a field when the field opens, not when we ask — so a
   *  connection made after the viewer already stepped into a search box
   *  never heard about it. This is the only way back into that state
   *  without making them leave the box and step into it again.
   */
  requestField() {
    this.send({ remoteImeShowRequest: {} });
  }

  close() {
    if (this.socket) this.socket.destroy();
  }
}

module.exports = { RemoteConnection, REMOTE_PORT, FEATURE };
