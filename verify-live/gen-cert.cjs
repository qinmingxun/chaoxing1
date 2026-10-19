
const f = require('node-forge');
const fs = require('node:fs');
const keys = f.pki.rsa.generateKeyPair(2048);
const cert = f.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = '01' + Date.now().toString(16);
cert.validity.notBefore = new Date(Date.now() - 3600 * 1000);
cert.validity.notAfter = new Date(Date.now() + 48 * 3600 * 1000);
const attrs = [{ name: 'commonName', value: 'u.unipus.cn' }];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.setExtensions([{ name: 'subjectAltName', altNames: [
  { type: 2, value: 'u.unipus.cn' },
  { type: 2, value: 'localhost' },
  { type: 7, ip: '127.0.0.1' },
]}]);
cert.sign(keys.privateKey, f.md.sha256.create());
fs.writeFileSync(__dirname + '/key.pem', f.pki.privateKeyToPem(keys.privateKey));
fs.writeFileSync(__dirname + '/cert.pem', f.pki.certificateToPem(cert));
console.log('pem written: key.pem + cert.pem (CN=u.unipus.cn, 48h)');
