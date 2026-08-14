'use strict';

const Homey = require('homey');
const dgram = require('dgram');
const https = require('https');
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

// What each button on the search screen sends. A television opens a link only
// when an installed app claims that exact address, so these are not a matter
// of taste: they were measured against this set, one candidate at a time.
const SERVICES = {
  youtube: { link: q => `https://www.youtube.com/results?search_query=${q}` },
  netflix: { link: q => `https://www.netflix.com/search?q=${q}` },
  // Read out of the app's own manifest (3.115.0). Its StartupActivity accepts
  // exactly this and nothing more:
  //
  //   crunchyroll://          any path, which is why every variant merely
  //   crunchyroll://open      opened the app and then sat there
  //   https://(www.)crunchyroll.com/watch/…  /series/…  /artist/…
  //   https://(www.)crunchyroll.com/activate  /offer-inpremium
  //
  // There is no search path and no ACTION_SEARCH anywhere in the manifest, so
  // no address exists that carries a term into the app; /search?q=… matches
  // nothing, which is the television answering "no app knows how to process
  // this request". The button therefore opens the app, and the term goes in
  // the way that does work: through the text field, once one is open.
  crunchyroll: {
    link: () => 'crunchyroll://',
    termless: true,
    hint: 'Crunchyroll staat open. Zet de cursor in het zoekvak en druk dan op '
      + '"Stuur naar het veld op de tv".',
  },
};

// Crunchyroll has no search address, but a series does — so the searching is
// done here and only the answer goes to the television. Its own apps talk to
// this host, which unlike the website sits in front of no challenge a remote
// control could never solve, and the web client's credentials are public:
// they ship in the site's own JavaScript, and buy an anonymous hour.
const CR_HOST = 'beta-api.crunchyroll.com';
const CR_AUTH = 'Basic Y3Jfd2ViOg==';
const CR_RESULTS = 3;

// Offered in the flow card. The protocol knows some three hundred key codes;
// this is the handful anyone actually puts in a flow.
const FLOW_KEYS = [
  { id: 'KEYCODE_POWER', name: 'Aan/uit' },
  { id: 'KEYCODE_HOME', name: 'Home' },
  { id: 'KEYCODE_BACK', name: 'Terug' },
  { id: 'KEYCODE_MENU', name: 'Menu' },
  { id: 'KEYCODE_DPAD_UP', name: 'Omhoog' },
  { id: 'KEYCODE_DPAD_DOWN', name: 'Omlaag' },
  { id: 'KEYCODE_DPAD_LEFT', name: 'Links' },
  { id: 'KEYCODE_DPAD_RIGHT', name: 'Rechts' },
  { id: 'KEYCODE_DPAD_CENTER', name: 'OK' },
  { id: 'KEYCODE_MEDIA_PLAY_PAUSE', name: 'Afspelen / pauzeren' },
  { id: 'KEYCODE_MEDIA_PLAY', name: 'Afspelen' },
  { id: 'KEYCODE_MEDIA_PAUSE', name: 'Pauzeren' },
  { id: 'KEYCODE_MEDIA_STOP', name: 'Stoppen' },
  { id: 'KEYCODE_MEDIA_NEXT', name: 'Volgende' },
  { id: 'KEYCODE_MEDIA_PREVIOUS', name: 'Vorige' },
  { id: 'KEYCODE_MEDIA_FAST_FORWARD', name: 'Vooruitspoelen' },
  { id: 'KEYCODE_MEDIA_REWIND', name: 'Terugspoelen' },
  { id: 'KEYCODE_VOLUME_UP', name: 'Volume harder' },
  { id: 'KEYCODE_VOLUME_DOWN', name: 'Volume zachter' },
  { id: 'KEYCODE_VOLUME_MUTE', name: 'Dempen' },
  { id: 'KEYCODE_MUTE', name: 'Microfoon dempen' },
  { id: 'KEYCODE_SEARCH', name: 'Zoeken' },
  { id: 'KEYCODE_TV_INPUT', name: 'Bron kiezen' },
  { id: 'KEYCODE_CHANNEL_UP', name: 'Kanaal omhoog' },
  { id: 'KEYCODE_CHANNEL_DOWN', name: 'Kanaal omlaag' },
  { id: 'KEYCODE_ENTER', name: 'Enter' },
  { id: 'KEYCODE_DEL', name: 'Wissen' },
];

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
    this.registerFlowCards();

    // Connect straight away so the log shows whether this will work at all.
    this.tryConnection()
      .then(connection => this.log(connection
        ? `Connected to the television at ${connection.host}`
        : 'Not connected yet (not paired, or the television is asleep)'))
      .catch(err => this.error(`Could not reach the television: ${err}`));
  }

  // -------------------------------------------------------------------
  // Flow cards
  // -------------------------------------------------------------------

  registerFlowCards() {
    this.homey.flow.getActionCard('press_key')
      .registerRunListener(async ({ key }) => {
        const connection = await this.connection();
        connection.sendKey(key.id);
        return true;
      })
      .registerArgumentAutocompleteListener('key', async query => {
        const term = String(query || '').toLowerCase();
        return FLOW_KEYS
          .filter(k => k.name.toLowerCase().includes(term) || k.id.toLowerCase().includes(term))
          .map(k => ({ id: k.id, name: k.name }));
      });

    this.homey.flow.getActionCard('send_text')
      .registerRunListener(async ({ text }) => {
        const result = await this.sendText(text);
        if (!result.ok) throw new Error(result.hint);
        return true;
      });

    this.homey.flow.getActionCard('open_link')
      .registerRunListener(async ({ link }) => this.openLink(link));

    this.homey.flow.getActionCard('wake')
      .registerRunListener(async () => this.wake());
  }

  // -------------------------------------------------------------------
  // Where the television is, and who we are to it
  // -------------------------------------------------------------------

  host() {
    const ip = this.homey.settings.get('tvIp');
    if (!ip) throw new Error('Geen IP-adres van de tv ingesteld');
    return ip;
  }

  /** The address if there is one, without complaining when there is not. */
  knownHost() {
    return this.homey.settings.get('tvIp') || null;
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

    // Reachable right now, which is the only moment its MAC can be looked up
    // — and waking it later is impossible without one.
    this.learnMac().catch(() => {});

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

    // The power button means "on" even when the television is too far gone to
    // hear a key: unreachable is exactly the case a magic packet is for.
    if (button === 'power') {
      const reachable = await this.tryConnection();
      if (!reachable) {
        this.log('power -> unreachable, waking instead');
        await this.wake();
        return { ok: true, waking: true };
      }
    }

    const connection = await this.connection();
    connection.sendKey(key);
    this.log(`${button} -> ${key}`);

    // Never guess the power state: the television reports it back itself.
    return { ok: true, on: connection.powered };
  }

  buildSearchLink(service, term) {
    const entry = SERVICES[service];
    if (!entry) throw new Error(`Onbekende dienst: ${service}`);

    const q = encodeURIComponent(String(term || '').trim());
    // Only the services that carry the term in their address need one.
    if (!q && !entry.termless) throw new Error('Geen zoekterm ingevuld');
    return entry.link(q);
  }

  async search(service, term) {
    const link = this.buildSearchLink(service, term);
    const connection = await this.connection();
    const before = connection.currentApp;
    connection.sendAppLink(link);
    this.log(`search ${service}: ${link}`);

    // A link only lands when an installed app claims that address; nothing
    // claims it, nothing happens, and the television stays silent. Waiting
    // for it to name a new app in front is the only proof we get.
    const app = await this.awaitApp(connection, before);
    if (app) this.log(`search ${service} opened ${app}`);
    return { ok: true, link, app, hint: SERVICES[service].hint || null };
  }

  /** The package the television reports in front, once it differs from what
   *  was there before — or null when it says nothing within a second and a
   *  half. Silence is not a failure: some sets never report at all. */
  async awaitApp(connection, before) {
    for (let i = 0; i < 10; i += 1) {
      await new Promise(resolve => this.homey.setTimeout(resolve, 150));
      const now = connection.currentApp;
      if (now && now !== before) return now;
    }
    return null;
  }

  // -------------------------------------------------------------------
  // Searching Crunchyroll, which happens here rather than on the television
  // -------------------------------------------------------------------

  /** A small JSON request, so this app keeps to its one dependency. */
  requestJson({ host, path, method = 'GET', headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
      const request = https.request({ host, path, method, headers, timeout: 15000 }, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Crunchyroll antwoordde met ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(new Error('Onleesbaar antwoord van Crunchyroll'));
          }
        });
      });

      request.on('timeout', () => request.destroy(new Error('Crunchyroll antwoordde niet op tijd')));
      request.on('error', reject);
      if (body) request.write(body);
      request.end();
    });
  }

  /** An anonymous token, kept for the hour it lasts. */
  async crunchyrollToken() {
    if (this._crToken && this._crToken.until > Date.now()) return this._crToken.value;

    const body = 'grant_type=client_id';
    const answer = await this.requestJson({
      host: CR_HOST,
      path: '/auth/v1/token',
      method: 'POST',
      headers: {
        Authorization: CR_AUTH,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
    });

    if (!answer.access_token) throw new Error('Crunchyroll gaf geen toegangssleutel');

    // Retire it a minute early rather than find out halfway through a search.
    const seconds = Number(answer.expires_in) || 3600;
    this._crToken = { value: answer.access_token, until: Date.now() + ((seconds - 60) * 1000) };
    return this._crToken.value;
  }

  /** The first few series for a term, each with the address that opens it.
   *  A series is one of the handful of paths the app genuinely claims. */
  async crunchyrollSearch(term) {
    const token = await this.crunchyrollToken();
    const query = new URLSearchParams({
      q: term, n: String(CR_RESULTS), type: 'series', locale: 'nl-NL',
    });

    const answer = await this.requestJson({
      host: CR_HOST,
      path: `/content/v2/discover/search?${query}`,
      headers: { Authorization: `Bearer ${token}` },
    });

    const found = [];
    for (const section of answer.data || []) {
      for (const item of section.items || []) {
        if (item.id && item.title) {
          found.push({
            id: item.id,
            title: item.title,
            link: `https://www.crunchyroll.com/series/${item.id}`,
          });
        }
      }
    }
    return found.slice(0, CR_RESULTS);
  }

  /** What the Crunchyroll button asks for. An undocumented interface can
   *  vanish without notice, so a failure opens the app and says what to do
   *  instead of leaving the viewer holding nothing. */
  async find(term) {
    const value = String(term || '').trim();
    if (!value) throw new Error('Geen zoekterm ingevuld');

    try {
      const results = await this.crunchyrollSearch(value);
      if (!results.length) {
        return { ok: false, results: [], hint: `Crunchyroll vond niets voor "${value}".` };
      }
      this.log(`crunchyroll "${value}": ${results.map(r => r.title).join(' | ')}`);
      return { ok: true, results };
    } catch (err) {
      this.error(`crunchyroll search failed: ${err.message}`);
      await this.openLink('crunchyroll://').catch(() => {});
      return {
        ok: false,
        results: [],
        hint: 'Zoeken bij Crunchyroll lukte niet, dus de app staat nu gewoon open. '
          + 'Ga naar het zoekvak en gebruik "Stuur naar het veld op de tv".',
      };
    }
  }

  async openLink(link) {
    const value = String(link || '').trim();
    // Any scheme an installed app can claim, not only the web: several apps
    // are reachable at all through their own, as crunchyroll:// is.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      throw new Error('Geef een link met een schema, bijvoorbeeld https:// of crunchyroll://');
    }
    const connection = await this.connection();
    const before = connection.currentApp;
    connection.sendAppLink(value);
    this.log(`open link: ${value}`);

    const app = await this.awaitApp(connection, before);
    if (app) this.log(`link opened ${app}`);
    return { ok: true, link: value, app };
  }

  /** Types a whole word into the text field the television has open,
   *  replacing what is there — a new search term should not land behind
   *  the previous one. */
  async sendText(text, { replace = true } = {}) {
    const value = String(text || '').trim();
    if (!value) throw new Error('Geen tekst opgegeven');

    let connection = await this.connection();

    // A television announces the open text field at the moment it opens it.
    // Connect after the viewer already stepped into a search box and we never
    // heard the announcement — and an edit that names no field is dropped
    // without a word, which looks exactly like the television ignoring us.
    if (!connection.hasTextField()) {
      this.log('No field announced yet; asking the television to say which is open');
      connection.requestField();
      await new Promise(resolve => this.homey.setTimeout(resolve, 700));
    }

    if (!connection.hasTextField()) {
      return {
        ok: false,
        field: null,
        fieldKnown: false,
        hint: 'De tv laat niet weten welk tekstvak openstaat. Ga op de tv even uit '
          + 'het zoekvak en klik het opnieuw aan — dan meldt ze het veld en lukt het.',
      };
    }

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
        fieldKnown: true,
        hint: 'De tv kent het tekstvak wel, maar nam de bewerking niet aan. '
          + 'Staat de cursor nog in datzelfde vak?',
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
