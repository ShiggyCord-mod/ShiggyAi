import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { buildMemoryPage, parseMemoryButtonId, MEMORY_PAGE_SIZE } from '../src/pagination.js';

function makeEntries(count) {
  return Array.from({ length: count }, (_, i) => ({ id: i + 1, content: `fakt-${i + 1}` }));
}

test('buildMemoryPage setzt IsComponentsV2 Flag und liefert Container + ActionRow', () => {
  const page = buildMemoryPage({ mode: 'user', targetUserId: 'u1', page: 0, entries: makeEntries(3) });
  assert.equal(page.flags, MessageFlags.IsComponentsV2);
  assert.equal(page.components.length, 2);
});

test('buildMemoryPage zeigt nur die Eintraege der aktuellen Seite (pageSize Default)', () => {
  const entries = makeEntries(25);
  const page = buildMemoryPage({ mode: 'user', targetUserId: 'u1', page: 0, entries });
  const text = page.components[0].components[0].data.content;

  assert.match(text, /fakt-1\b/);
  assert.match(text, new RegExp(`fakt-${MEMORY_PAGE_SIZE}\\b`));
  assert.doesNotMatch(text, new RegExp(`fakt-${MEMORY_PAGE_SIZE + 1}\\b`));
});

test('buildMemoryPage: Zurueck-Button ist auf Seite 0 deaktiviert, Weiter nicht', () => {
  const page = buildMemoryPage({ mode: 'user', targetUserId: 'u1', page: 0, entries: makeEntries(25) });
  const [prevButton, nextButton] = page.components[1].components;

  assert.equal(prevButton.data.disabled, true);
  assert.equal(nextButton.data.disabled, false);
});

test('buildMemoryPage: Weiter-Button ist auf letzter Seite deaktiviert', () => {
  const entries = makeEntries(15); // 2 Seiten bei pageSize 10
  const page = buildMemoryPage({ mode: 'user', targetUserId: 'u1', page: 1, entries });
  const [prevButton, nextButton] = page.components[1].components;

  assert.equal(prevButton.data.disabled, false);
  assert.equal(nextButton.data.disabled, true);
});

test('buildMemoryPage clamped eine ausserhalb liegende Seitenzahl auf die letzte gueltige Seite', () => {
  const entries = makeEntries(5);
  const page = buildMemoryPage({ mode: 'user', targetUserId: 'u1', page: 99, entries });
  const text = page.components[0].components[0].data.content;

  assert.match(text, /Page 1\/1/);
});

test('buildMemoryPage im server-Modus zeigt den Server-Titel statt eines User-Tags', () => {
  const entries = makeEntries(2);
  const page = buildMemoryPage({ mode: 'server', page: 0, entries });
  const text = page.components[0].components[0].data.content;

  assert.match(text, /Server memories/);
  assert.match(text, /fakt-1/);
  assert.match(text, /fakt-2/);
});

test('buildMemoryPage im user-Modus zeigt den angesprochenen User im Titel', () => {
  const page = buildMemoryPage({ mode: 'user', targetUserId: 'u1', page: 0, entries: makeEntries(1) });
  const text = page.components[0].components[0].data.content;

  assert.match(text, /<@u1>/);
});

test('parseMemoryButtonId parst gueltige customIds', () => {
  assert.deepEqual(parseMemoryButtonId('mem:user:123456:2'), { mode: 'user', targetUserId: '123456', page: 2 });
  assert.deepEqual(parseMemoryButtonId('mem:server:-:0'), { mode: 'server', targetUserId: null, page: 0 });
});

test('parseMemoryButtonId gibt null bei fremden/kaputten customIds zurueck', () => {
  assert.equal(parseMemoryButtonId('irgendwas:user:1:0'), null);
  assert.equal(parseMemoryButtonId('mem:user:1'), null);
  assert.equal(parseMemoryButtonId('mem:user:1:nicht-numerisch'), null);
});

test('buildMemoryPage und parseMemoryButtonId sind roundtrip-kompatibel', () => {
  const page = buildMemoryPage({ mode: 'user', targetUserId: 'u1', page: 1, entries: makeEntries(25) });
  const nextButton = page.components[1].components[1];
  const parsed = parseMemoryButtonId(nextButton.data.custom_id);

  assert.deepEqual(parsed, { mode: 'user', targetUserId: 'u1', page: 2 });
});
