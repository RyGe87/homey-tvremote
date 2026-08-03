'use strict';

const Homey = require('homey');
const dgram = require('dgram');
const os = require('os');

const { generateCertificate } = require('./lib/androidtv/certificate');
const { PairingSession } = require('./lib/androidtv/pairing');
const { RemoteConnection } = require('./lib/androidtv/connection');

// Buttons in the widget, spoken straight to the television.
const KEYS = {
  up: 'KEYCODE_DPAD_UP',
  down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT',
  right: 'KEYCODE_DPAD_RIGHT',
  ok: 'KEYCODE_DPAD_CENTER',
  back: 'KEYCODE_BACK',
  // Android TV has no exit key; leaving an app means going home.
  exit: 'KEYCODE_HOME',
  info: 'KEYCODE_MENU',
  previous: 'KEYCODE_MEDIA_PREVIOUS',
  next: 'KEYCODE_MEDIA_NEXT',
  volume_up: 'KEYCODE_VOLUME_UP',
  volume_down: 'KEYCODE_VOLUME_DOWN',
  mute: 'KEYCODE_VOLUME_MUTE',
  power: 'KEYCODE_POWER',
};

// Magic packets go to the discard (9) and echo (7) ports, a few times each:
// a sleeping network card easily misses a single datagram.
const WOL_PORTS = [9, 7];
const WOL_REPEATS = 3;

// Measured on this television: one packet does nothing, but repeated salvos
// wake it after roughly a minute.
const WAKE_TOTAL_MS = 90000;
const WAKE_INTERVAL_MS = 3000;

class TvRemoteApp extends Homey.App {

  async onInit() {
    this.log('TV Remote widget app started');

    // Connect straight away so the log shows whether this will work at all.
    this.tryConnection()
      .then(connection => this.log(connection
        ? `Connected to the television at ${connection.host}`
        : 'Not connected yet (not paired, or the television is asleep)'))
      .catch(err => this.error(`Could not reach the television: ${err}`));
  }

  // -------------------------------------------------------------------
  // Where the television is, and who we are to it
  // -------------------------------------------------------------------

  host() {
    const ip = this.homey.settings.get('tvIp');
    if (!ip) throw new Error('Geen IP-adres van de tv ingesteld');
    return ip;
  }

  setHost(ip) {
    // Phone keyboards happily offer a comma where a full stop belongs, so
    // take either rather than rejecting a perfectly clear address.
    const clean = String(ip || '').trim().replace(/,/g, '.');
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(clean)) throw new Error('Dat is geen geldig IP-adres');

    if (clean !== this.homey.settings.get('tvIp')) {
      this.homey.settings.set('tvIp', clean);
      this.closeConnection();
      this.log(`Television address set to ${clean}`);
    }
    return { ok: true, ip: clean };
  }

  /** Generated once and then kept: the television remembers this key. */
  certificates() {
    const cert = this.homey.settings.get('atvCert');
    const key = this.homey.settings.get('atvKey');
    if (cert && key) return { cert, key };

    this.log('Generating a client certificate (once)');
    const fresh = generateCertificate('homey-tvremote');
    this.homey.settings.set('atvCert', fresh.cert);
    this.homey.settings.set('atvKey', fresh.key);
    // A new key makes any earlier pairing worthless.
    this.homey.settings.set('atvPaired', false);
    return fresh;
  }

  isPaired() {
    return Boolean(this.homey.settings.get('atvPaired'));
  }

  /** Step one: the television puts a six-character code on screen. */
  async pairStart(ip) {
    if (ip) this.setHost(ip);
    if (this._pairing) this._pairing.stop();

    this._pairing = new PairingSession({
      host: this.host(),
      certs: this.certificates(),
      clientName: 'Homey',
      serviceName: 'dev.rymenants.tvremote',
    });

    await this._pairing.start();
    this.log('Pairing started; the television shows a code');
    return { ok: true };
  }

  /** Step two: the code proves both sides hold the same keys. */
  async pairCode(code) {
    if (!this._pairing) throw new Error('Start eerst het koppelen');

    await this._pairing.sendCode(code);
    this._pairing.stop();
    this._pairing = null;
    this.homey.settings.set('atvPaired', true);
    this.log('Paired with the television');

    // Prove it now rather than at the first button press.
    await this.connection();
    return { ok: true };
  }

  // -------------------------------------------------------------------
  // The connection itself
  // -------------------------------------------------------------------

  async connection() {
    if (this._connection && this._connection.connected) return this._connection;
    if (!this.isPaired()) throw new Error('Nog niet gekoppeld met de tv');

    const connection = new RemoteConnection({ host: this.host(), certs: this.certificates() });
    connection.on('error', err => this.error(`TV connection: ${err.message}`));
    connection.on('close', () => {
      if (this._connection === connection) this._connection = null;
    });

    await connection.connect();
    this._connection = connection;
    return connection;
  }

  /** The connection when there is one, or null — never an exception, so a
   *  sleeping television does not turn every call into an error. */
  async tryConnection() {
    if (!this.isPaired()) return null;
    try {
      return await this.connection();
    } catch (err) {
      return null;
    }
  }

  closeConnection() {
    if (this._connection) this._connection.close();
    this._connection = null;
  }

  async status() {
    const connection = await this.tryConnection();

    return {
      found: true,
      paired: this.isPaired(),
      connected: Boolean(connection),
      available: Boolean(connection),
      on: connection ? connection.powered : null,
      app: connection ? connection.currentApp : null,
      fieldKnown: Boolean(connection && connection.hasTextField()),
      field: connection && connection.textField ? connection.textField.value : null,
      host: this.homey.settings.get('tvIp') || null,
      mac: this.homey.settings.get('tvMac') || null,
      waking: Boolean(this._wake && this._wake.busy),
      wakeResult: this._wake && !this._wake.busy ? this._wake.result : null,
    };
  }

  // -------------------------------------------------------------------
  // Buttons, links and text
  // -------------------------------------------------------------------

  async press(button) {
    const key = KEYS[button];
    if (!key) throw new Error(`Onbekende knop: ${button}`);

    const connection = await this.connection();
    connection.sendKey(key);
    this.log(`${button} -> ${key}`);

    // Never guess the power state: the television reports it back itself.
    return { ok: true, on: connection.powered };
  }

  buildSearchLink(service, term) {
    const q = encodeURIComponent(String(term || '').trim());
    if (!q) throw new Error('Geen zoekterm ingevuld');

    switch (service) {
      case 'youtube': return `https://www.youtube.com/results?search_query=${q}`;
      case 'netflix': return `https://www.netflix.com/search?q=${q}`;
      default: throw new Error(`Onbekende dienst: ${service}`);
    }
  }

  async search(service, term) {
    const link = this.buildSearchLink(service, term);
    const connection = await this.connection();
    connection.sendAppLink(link);
    this.log(`search ${service}: ${link}`);
    return { ok: true, link };
  }

  async openLink(link) {
    if (!/^https?:\/\//i.test(String(link || ''))) {
      throw new Error('Geef een link die met http(s):// begint');
    }
    const connection = await this.connection();
    connection.sendAppLink(link);
    this.log(`open link: ${link}`);
    return { ok: true, link };
  }

  /** Types a whole word into the text field the television has open,
   *  replacing what is there — a new search term should not land behind
   *  the previous one. */
  async sendText(text, { replace = true } = {}) {
    const value = String(text || '').trim();
    if (!value) throw new Error('Geen tekst opgegeven');

    let connection = await this.connection();
    let field = await this.attemptText(connection, value, replace);

    // No confirmation means the field identifier we quoted was stale — the
    // television raises it on every edit, including ones made with the real
    // remote. A fresh connection makes it announce the current field again.
    if (!field) {
      this.log('No confirmation; reconnecting to refresh the field identifier');
      this.closeConnection();
      connection = await this.connection();
      await new Promise(resolve => this.homey.setTimeout(resolve, 600));
      field = await this.attemptText(connection, value, replace);
    }

    if (!field) {
      return {
        ok: false,
        field: null,
        hint: 'De tv nam de tekst niet aan. Staat de cursor echt in een '
          + 'tekstvak op het scherm?',
      };
    }

    this.log(`Sent text "${value}"; the field now reads "${field.value}"`);
    return { ok: true, field: field.value };
  }

  /** Sends the text and waits for the television to confirm the field's new
   *  contents. Returns the field, or null when nothing came back. */
  async attemptText(connection, value, replace) {
    const before = connection.echoCount;
    connection.sendText(value, { replace });

    for (let i = 0; i < 14; i += 1) {
      await new Promise(resolve => this.homey.setTimeout(resolve, 100));
      if (connection.echoCount > before) return connection.textField;
    }
    return null;
  }

  // -------------------------------------------------------------------
  // Waking: the television's remote service is closed while it sleeps, so
  // the only way in is a magic packet on the network card.
  // -------------------------------------------------------------------

  /** Ask Homey's ARP table which MAC answers for the television's address.
   *  Only works while it is awake, which is exactly when we want to learn. */
  async learnMac() {
    const mac = await this.homey.arp.getMAC(this.host());
    if (!mac || String(mac).length < 11) return null;

    if (this.homey.settings.get('tvMac') !== String(mac)) {
      this.log(`Learned MAC for ${this.host()}: ${mac}`);
      this.homey.settings.set('tvMac', String(mac));
    }
    return String(mac);
  }

  buildMagicPacket(mac) {
    const hex = String(mac).replace(/[^0-9a-fA-F]/g, '');
    if (hex.length !== 12) throw new Error(`"${mac}" is geen geldig MAC-adres`);
    const target = Buffer.from(hex, 'hex');
    return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(target)]);
  }

  /** Every reachable broadcast address. Some devices ignore the global
   *  255.255.255.255 but do answer a directed subnet broadcast. */
  broadcastAddresses() {
    const addresses = new Set(['255.255.255.255']);
    for (const nics of Object.values(os.networkInterfaces())) {
      for (const nic of nics || []) {
        if (nic.family !== 'IPv4' || nic.internal) continue;
        const ip = nic.address.split('.').map(Number);
        const mask = nic.netmask.split('.').map(Number);
        addresses.add(ip.map((octet, i) => octet | (~mask[i] & 0xff)).join('.'));
      }
    }
    return [...addresses];
  }

  async sendMagicPacket(mac) {
    const packet = this.buildMagicPacket(mac);
    const socket = dgram.createSocket('udp4');

    try {
      await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind(() => resolve());
      });
      socket.setBroadcast(true);

      for (const address of this.broadcastAddresses()) {
        for (const port of WOL_PORTS) {
          for (let i = 0; i < WOL_REPEATS; i += 1) {
            await new Promise((resolve, reject) => {
              socket.send(packet, port, address, err => (err ? reject(err) : resolve()));
            });
          }
        }
      }
      this.log(`Magic packet sent for ${mac}`);
    } finally {
      socket.close();
    }
  }

  /** Waking takes up to a minute and a half, far too long to hold a request
   *  open. So the widget starts it and then follows along through /status. */
  async wake() {
    if (this._wake && this._wake.busy) return { started: true, ...this._wake };

    this._wake = { busy: true, since: Date.now(), result: null };
    this._runWake()
      .then(result => { this._wake = { busy: false, since: this._wake.since, result }; })
      .catch(err => {
        this._wake = {
          busy: false,
          since: this._wake.since,
          result: { ok: false, error: err.message },
        };
      });

    return { started: true, busy: true };
  }

  async _runWake() {
    const mac = (await this.learnMac().catch(() => null))
      || this.homey.settings.get('tvMac');

    if (!mac) {
      throw new Error('Nog geen MAC-adres bekend. Druk één keer op Wek terwijl '
        + 'de tv aan staat, dan onthoudt de app het.');
    }

    await this.sendMagicPacket(mac);

    const deadline = Date.now() + WAKE_TOTAL_MS;
    let rounds = 0;

    while (Date.now() < deadline) {
      await new Promise(resolve => this.homey.setTimeout(resolve, WAKE_INTERVAL_MS));
      rounds += 1;

      const connection = await this.tryConnection();
      if (connection) {
        if (connection.powered) {
          this.log(`Wake succeeded after ${rounds} rounds`);
          return { ok: true, on: true, rounds };
        }
        // Reachable but still dark: now the real power key can do its work.
        try {
          connection.sendKey('KEYCODE_POWER');
        } catch (err) {
          // Connection went away again; the next round tries afresh.
        }
      }

      await this.sendMagicPacket(mac).catch(() => {});
    }

    return {
      ok: false,
      rounds,
      error: 'De tv reageerde niet binnen anderhalve minuut. Probeer het nog eens.',
    };
  }
}

module.exports = TvRemoteApp;
