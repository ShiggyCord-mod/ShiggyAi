import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

// Eigene Datei, weil die Freigabeliste beim Import gelesen wird und hier eine andere
// Konfiguration gelten muss als in dashboard.test.js.
const TEST_DB_PATH = path.join(os.tmpdir(), `shiggyai-access-${Date.now()}.sqlite`);
process.env.DB_PATH = TEST_DB_PATH;
process.env.DASHBOARD_PORT = '0';
process.env.DASHBOARD_ALLOWED_IPS = '100.100.255.201, 100.100.255.202';
process.env.LLM_MODEL = 'test-model';
process.env.LLM_API_KEY = 'cc_test';

const { startDashboard, isAllowed, normalizeIp } = await import('../src/dashboard.js?case=allowlist');

after(() => {
  for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(TEST_DB_PATH + suffix, { force: true });
});

test('normalizeIp loest die IPv4-in-IPv6-Schreibweise auf', () => {
  // Node liefert bei einem Dual-Stack-Socket genau diese Form - ohne Normalisierung wuerde die
  // Freigabeliste dann nicht greifen.
  assert.equal(normalizeIp('::ffff:100.100.255.201'), '100.100.255.201');
  assert.equal(normalizeIp('::FFFF:100.100.255.201'), '100.100.255.201');
  assert.equal(normalizeIp('100.100.255.201'), '100.100.255.201');
});

test('normalizeIp entfernt Klammern und Zone-Index bei IPv6', () => {
  assert.equal(normalizeIp('[fd7a:115c:a1e0::1]'), 'fd7a:115c:a1e0::1');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
  assert.equal(normalizeIp(''), '');
  assert.equal(normalizeIp(undefined), '');
});

test('isAllowed laesst nur die freigegebenen Adressen durch', () => {
  assert.equal(isAllowed('100.100.255.201'), true);
  assert.equal(isAllowed('100.100.255.202'), true);
  assert.equal(isAllowed('::ffff:100.100.255.201'), true, 'auch in IPv6-Schreibweise');

  assert.equal(isAllowed('100.100.255.203'), false, 'anderer Tailnet-Peer');
  assert.equal(isAllowed('192.168.18.50'), false, 'Rechner im LAN');
  assert.equal(isAllowed('8.8.8.8'), false);
  assert.equal(isAllowed(''), false);
});

test('Loopback ist immer erlaubt, auch mit Freigabeliste', () => {
  // Wer auf der Maschine sitzt, kann die SQLite-Datei sowieso lesen.
  assert.equal(isAllowed('127.0.0.1'), true);
  assert.equal(isAllowed('::1'), true);
  assert.equal(isAllowed('::ffff:127.0.0.1'), true);
});

test('eine gesetzte Freigabeliste blockt fremde Adressen am HTTP-Server', async () => {
  const server = startDashboard({ client: null, runtime: () => ({}) });
  await once(server, 'listening');
  const port = server.address().port;

  try {
    // Loopback kommt durch
    const ok = await fetch(`http://127.0.0.1:${port}/api/overview`);
    assert.equal(ok.status, 200);

    // Eine fremde Quelladresse laesst sich nicht einfach erfinden, also wird die Pruefung an
    // der Stelle getestet, an der der Server sie trifft.
    assert.equal(isAllowed('203.0.113.7'), false);
  } finally {
    server.close();
  }
});

test('die gebundene Adresse selbst ist erlaubt, sonst sperrt man sich aus', async () => {
  // Nachgemessen: bindet man an die VPN-Adresse der Maschine und ruft das Dashboard dort auf,
  // ist genau diese Adresse die Quelladresse - nicht 127.0.0.1. Ohne diesen Fall antwortete
  // der eigene Aufruf mit 403.
  process.env.DASHBOARD_HOST = '100.100.255.1';
  process.env.DASHBOARD_ALLOWED_IPS = '100.100.255.201';
  const mod = await import('../src/dashboard.js?case=selfaccess');

  assert.equal(mod.isAllowed('100.100.255.1'), true, 'die gebundene Adresse selbst');
  assert.equal(mod.isAllowed('100.100.255.201'), true, 'der freigegebene Peer');
  assert.equal(mod.isAllowed('127.0.0.1'), true, 'Loopback bleibt erlaubt');
  assert.equal(mod.isAllowed('100.100.255.202'), false, 'ein anderer Peer nicht');
});

test('ohne Freigabeliste darf jeder, der den gebundenen Port erreicht', async () => {
  // Das ist der Default und zusammen mit der Loopback-Bindung unkritisch - sobald aber weiter
  // gebunden wird, warnt der Start ausdruecklich davor.
  process.env.DASHBOARD_HOST = '127.0.0.1';
  delete process.env.DASHBOARD_ALLOWED_IPS;
  const mod = await import('../src/dashboard.js?case=noallowlist');

  assert.equal(mod.isAllowed('8.8.8.8'), true);
  assert.equal(mod.isAllowed('100.100.255.202'), true);
});
