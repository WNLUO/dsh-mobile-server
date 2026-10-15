/** Plugin OTA API publishes authenticated npm tarballs and serves stable releases. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-ota-'));
process.env.PLUGIN_OTA_ROOT = temp;
process.env.PLUGIN_CONTROL_TOKEN = 'ota-test-token';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.RELAY_SECRET = 'ota-test-relay-secret-0123456789';

const { server, start, stop } = require('../server.js');

function npmTarball(name, version) {
  const content = Buffer.from(JSON.stringify({ name, version }));
  const header = Buffer.alloc(512);
  header.write('package/package.json');
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write('ustar\0', 257);
  header.write('00', 263);
  return zlib.gzipSync(Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512), Buffer.alloc(1024)]));
}
function request(port, route, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: options.method || 'GET', headers: options.headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('plugin OTA publishes authenticated tgz, checks public stable release and downloads it', async () => {
  const { port } = await start({ port: 0, host: '127.0.0.1' });
  try {
    const bytes = npmTarball('dsh-mobile-plugin', '1.2.0');
    const releasePath = '/api/desktop-plugins/control/ota/releases/1.2.0/package.tgz?platform=macos&channel=stable';
    assert.equal((await request(port, releasePath, { method: 'PUT', headers: { 'content-type': 'application/gzip' }, body: bytes })).status, 401);
    const published = await request(port, releasePath, { method: 'PUT', headers: { authorization: 'Bearer ota-test-token', 'content-type': 'application/gzip' }, body: bytes });
    assert.equal(published.status, 201);
    assert.equal(JSON.parse(published.body).release.size, bytes.length);
    assert.equal((await request(port, '/api/desktop-plugins/control/ota/releases/1.3.0/package.tgz?platform=macos&channel=stable', { method: 'PUT', headers: { authorization: 'Bearer ota-test-token', 'content-type': 'application/gzip' }, body: bytes })).status, 400);

    const check = await request(port, '/api/desktop-plugins/ota/latest?platform=macos&channel=stable');
    assert.equal(check.status, 200);
    const result = JSON.parse(check.body);
    assert.equal(result.ok, true);
    assert.equal(result.data.version, '1.2.0');
    assert.equal(result.data.packageUrl, `http://127.0.0.1:${port}/api/desktop-plugins/ota/releases/1.2.0/package.tgz?platform=macos`);

    const download = await request(port, '/api/desktop-plugins/ota/releases/1.2.0/package.tgz?platform=macos');
    assert.equal(download.status, 200);
    assert.deepEqual(download.body, bytes);
    assert.equal(JSON.parse((await request(port, '/api/desktop-plugins/ota/latest?platform=macos&channel=stable')).body).data.version, '1.2.0');
    assert.equal((await request(port, '/api/desktop-plugins/ota/latest?platform=macos&channel=beta')).status, 400);
  } finally {
    await stop();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
