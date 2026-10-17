import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The panel serving its own build.
 *
 * The build directory is deliberately created under a DOT SEGMENT, because that
 * is the case that broke: `res.sendFile` refuses an absolute path containing a
 * segment beginning with a dot, so an install under `/opt/.apps/panel` answered
 * 404 for every page — while its own assets, served by a different middleware,
 * loaded perfectly. Nothing looked wrong except that the panel would not open.
 *
 * `FRONTEND_DIR` is read when `app.js` is imported, so it has to be in place
 * before the harness pulls the app in; the import below is dynamic for that
 * reason, exactly like the harness's own.
 */
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skygenpanel-serve-'));
const dottedDir = path.join(buildDir, '.hidden', 'dist');
fs.mkdirSync(dottedDir, { recursive: true });
fs.writeFileSync(path.join(dottedDir, 'index.html'), '<html><body>painel</body></html>');
fs.writeFileSync(path.join(dottedDir, 'portal.html'), '<html><body>portal</body></html>');
fs.writeFileSync(path.join(dottedDir, 'whatsapp-signup.html'), '<html><body>signup</body></html>');
fs.writeFileSync(path.join(dottedDir, '.env'), 'SECRET=nao-deve-sair-daqui');
process.env.FRONTEND_DIR = dottedDir;

const { call, startTestServers, stopTestServers } = await import('./helpers/harness.js');

let panelUrl;
let portalUrl;

before(async () => {
  ({ panelUrl, portalUrl } = await startTestServers());
});

after(async () => {
  await stopTestServers();
  fs.rmSync(buildDir, { recursive: true, force: true });
});

describe('serving the build from a path that contains a dot segment', () => {
  it('answers a page route with the panel html', async () => {
    const { status, body } = await call(`${panelUrl}/login`);
    assert.equal(status, 200);
    assert.match(String(body), /painel/);
  });

  it('answers the customer portal with its own html', async () => {
    const { status, body } = await call(`${portalUrl}/faturas`);
    assert.equal(status, 200);
    assert.match(String(body), /portal/);
  });

  it('never hands out a dotfile from inside the build', async () => {
    // The fix is about where the file IS, never about what may be served. This
    // asks for a dotfile by name and asserts on the CONTENT, not the status:
    // `/.env` has no extension as far as `path.extname` is concerned, so the
    // SPA fallback claims it and answers the page — which is fine, and is not
    // what would be dangerous. What would be dangerous is the file.
    const { status, body } = await call(`${panelUrl}/.env`);
    assert.equal(status, 200);
    assert.match(String(body), /painel/);
    assert.doesNotMatch(String(body), /nao-deve-sair-daqui/, 'the build directory is not a file share');
  });

  it('never hands out a dotfile asked for as an asset either', async () => {
    // With an extension the fallback does not claim it, and the static
    // middleware's own `dotfiles: 'deny'` is what answers.
    const { status, body } = await call(`${panelUrl}/.env.local`);
    assert.equal(status, 404);
    assert.doesNotMatch(String(body ?? ''), /nao-deve-sair-daqui/);
  });

  it('leaves the API alone', async () => {
    const { status, body } = await call(`${panelUrl}/api/health`);
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
  });
});

describe('a página do Embedded Signup da Meta', () => {
  it('libera o SDK do Facebook só nela', async () => {
    const { response, status, body } = await call(`${panelUrl}/whatsapp-signup.html`);
    assert.equal(status, 200);
    assert.match(String(body), /signup/);
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self' https:\/\/connect\.facebook\.net/);
    assert.match(csp, /frame-src [^;]*https:\/\/www\.facebook\.com/);
    assert.match(csp, /connect-src [^;]*https:\/\/graph\.facebook\.com/);
    // O que não é do SDK fica como no resto do painel.
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src-attr 'none'/);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
  });

  it('o resto do painel continua sem o Facebook', async () => {
    const { response } = await call(`${panelUrl}/login`);
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self';/);
    assert.doesNotMatch(csp, /facebook/);
  });

  it('o portal do assinante também', async () => {
    const { response } = await call(`${portalUrl}/whatsapp-signup.html`);
    assert.doesNotMatch(response.headers.get('content-security-policy'), /facebook/);
  });
});
