'use strict';

const crypto = require('crypto');
const forge = require('node-forge');

/** A self-signed client certificate. The television remembers its public key
 *  after pairing, so this pair must be generated once and then kept. */
function generateCertificate(name = 'homey-tvremote') {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = `01${crypto.randomBytes(19).toString('hex')}`;
  cert.validity.notBefore = new Date();
  const notAfter = new Date();
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 20);
  cert.validity.notAfter = notAfter;

  const attributes = [
    { name: 'commonName', value: name },
    { name: 'countryName', value: 'BE' },
    { shortName: 'ST', value: 'Flanders' },
    { name: 'localityName', value: 'Home' },
    { name: 'organizationName', value: 'Homey' },
    { shortName: 'OU', value: 'TV Remote widget' },
  ];
  cert.setSubject(attributes);
  cert.setIssuer(attributes);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    cert: forge.pki.certificateToPem(cert),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

module.exports = { generateCertificate };
