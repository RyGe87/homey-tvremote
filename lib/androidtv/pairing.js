'use strict';

const tls = require('tls');
const path = require('path');
const crypto = require('crypto');
const protobuf = require('protobufjs');

const { DelimitedReader } = require('./framing');

const PAIRING_PORT = 6467;

/** Hex that may be odd-length or 0x-prefixed, as Node reports certificates. */
function hexToBuffer(value) {
  const clean = String(value).replace(/^0x/i, '');
  return Buffer.from(clean.length % 2 ? `0${clean}` : clean, 'hex');
}

/** One pairing attempt. The television shows a six-character code; feeding
 *  that code back proves both sides are talking to each other and not to a
 *  man in the middle. */
class PairingSession {

  constructor({ host, certs, clientName = 'Homey', serviceName = 'com.homey.tvremote' }) {
    this.host = host;
    this.certs = certs;
    this.clientName = clientName;
    this.serviceName = serviceName;

    const root = protobuf.loadSync(path.join(__dirname, 'pairingmessage.proto'));
    this.PairingMessage = root.lookupType('pairing.PairingMessage');
    this.Status = root.lookupEnum('pairing.PairingMessage.Status').values;
    this.RoleType = root.lookupEnum('pairing.RoleType').values;
    this.EncodingType = root.lookupEnum('pairing.PairingEncoding.EncodingType').values;

    this.reader = new DelimitedReader();
    this.socket = null;
    this.awaitingCode = null;
    this.finished = null;
  }

  encode(payload) {
    const message = this.PairingMessage.create({
      ...payload,
      status: this.Status.STATUS_OK,
      protocolVersion: 2,
    });
    return this.PairingMessage.encodeDelimited(message).finish();
  }

  send(payload) {
    this.socket.write(Buffer.from(this.encode(payload)));
  }

  /** Connects and walks the handshake up to the point where the television
   *  puts a code on screen. Resolves once that code can be entered. */
  start() {
    return new Promise((resolve, reject) => {
      this.awaitingCode = { resolve, reject };
      this.finished = new Promise((done, fail) => {
        this._done = done;
        this._fail = fail;
      });
      // Nobody may await this yet; an unhandled rejection would crash the app.
      this.finished.catch(() => {});

      this.socket = tls.connect({
        host: this.host,
        port: PAIRING_PORT,
        cert: this.certs.cert,
        key: this.certs.key,
        rejectUnauthorized: false,
      });

      this.socket.setTimeout(20000);
      this.socket.on('timeout', () => this.fail(new Error('De tv antwoordde niet op tijd')));
      this.socket.on('error', err => this.fail(err));
      this.socket.on('secureConnect', () => {
        this.send({
          pairingRequest: { serviceName: this.serviceName, clientName: this.clientName },
        });
      });

      this.socket.on('data', chunk => {
        try {
          for (const frame of this.reader.push(chunk)) this.handle(frame);
        } catch (err) {
          this.fail(err);
        }
      });
    });
  }

  handle(frame) {
    const message = this.PairingMessage.decode(frame);

    if (message.status !== this.Status.STATUS_OK) {
      this.fail(new Error(`De tv wees de koppeling af (status ${message.status})`));
      return;
    }

    if (message.pairingRequestAck) {
      this.send({
        pairingOption: {
          preferredRole: this.RoleType.ROLE_TYPE_INPUT,
          inputEncodings: [{
            type: this.EncodingType.ENCODING_TYPE_HEXADECIMAL,
            symbolLength: 6,
          }],
        },
      });
    } else if (message.pairingOption) {
      this.send({
        pairingConfiguration: {
          clientRole: this.RoleType.ROLE_TYPE_INPUT,
          encoding: {
            type: this.EncodingType.ENCODING_TYPE_HEXADECIMAL,
            symbolLength: 6,
          },
        },
      });
    } else if (message.pairingConfigurationAck) {
      // The code is on screen now, and somebody has to walk over and read it.
      // Any timeout from here on would cut that person off mid-errand.
      this.socket.setTimeout(0);
      if (this.awaitingCode) {
        this.awaitingCode.resolve(true);
        this.awaitingCode = null;
      }
    } else if (message.pairingSecretAck) {
      this._done(true);
      this.socket.end();
    }
  }

  /** Answers the code shown on the television. The first byte of the code is
   *  a checksum over both public keys, so a typo is caught before sending. */
  async sendCode(code) {
    const cleaned = String(code || '').replace(/[^0-9a-fA-F]/g, '');
    if (cleaned.length !== 6) throw new Error('De code bestaat uit zes tekens');

    const codeBytes = hexToBuffer(cleaned);
    const client = this.socket.getCertificate();
    const server = this.socket.getPeerCertificate();

    if (!client || !client.modulus) throw new Error('Geen eigen certificaat op de verbinding');
    if (!server || !server.modulus) throw new Error('De tv gaf geen certificaat');

    const sha = crypto.createHash('sha256');
    sha.update(hexToBuffer(client.modulus));
    sha.update(hexToBuffer(client.exponent));
    sha.update(hexToBuffer(server.modulus));
    sha.update(hexToBuffer(server.exponent));
    sha.update(codeBytes.subarray(1));
    const hash = sha.digest();

    if (hash[0] !== codeBytes[0]) {
      this.stop();
      throw new Error('Die code klopt niet met wat de tv toont');
    }

    this.send({ pairingSecret: { secret: hash } });
    return this.finished;
  }

  fail(error) {
    if (this.awaitingCode) {
      this.awaitingCode.reject(error);
      this.awaitingCode = null;
    }
    if (this._fail) this._fail(error);
    this.stop();
  }

  stop() {
    if (this.socket) this.socket.destroy();
  }
}

module.exports = { PairingSession, PAIRING_PORT };
