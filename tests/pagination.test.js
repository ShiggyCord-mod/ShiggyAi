import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import {
  buildMemoryPage,
  parseMemoryButtonId,
  renderMemoryLines,
  MEMORY_PAGE_SIZE,
  TEXT_DISPLAY_LIMIT
} from '../src/pagination.js';

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

test('buildMemoryPage bleibt unter dem TextDisplay-Limit, wenn ein Eintrag ausufert', () => {
  // Regression: MAX_MEMORY_LENGTH wird nur beim Schreiben durch das Modell erzwungen, nicht in
  // der DB - ueber /memory admin add-user und aus Altdaten landen laengere Inhalte in der
  // Tabelle. Vorher warf TextDisplayBuilder dann "Invalid string length".
  const entries = makeEntries(MEMORY_PAGE_SIZE);
  entries[0].content = 'x'.repeat(5000);

  const page = buildMemoryPage({ mode: 'user', targetUserId: 'u1', page: 0, entries });
  const text = page.components[0].components[0].data.content;
  assert.ok(text.length <= TEXT_DISPLAY_LIMIT, `${text.length} > ${TEXT_DISPLAY_LIMIT}`);
});

test('buildMemoryPage zeigt trotz eines ausufernden Eintrags alle Eintraege der Seite', () => {
  // Nur die fertige Seite abzuschneiden wuerde den Rest der Seite verschlucken - und ueber
  // keine andere Seite erreichbar machen, da die Seitengrenzen fix sind.
  const entries = makeEntries(MEMORY_PAGE_SIZE);
  entries[0].content = 'x'.repeat(5000);

  const page = buildMemoryPage({ mode: 'user', targetUserId: 'u1', page: 0, entries });
  const text = page.components[0].components[0].data.content;
  for (const entry of entries) {
    assert.ok(text.includes(`\`${entry.id}\``), `Eintrag ${entry.id} fehlt auf der Seite`);
  }
});

test('renderMemoryLines verteilt das Budget gleichmaessig und haelt es insgesamt ein', () => {
  const entries = makeEntries(10).map((e) => ({ ...e, content: 'y'.repeat(1000) }));
  const lines = renderMemoryLines(entries, 2000);
  assert.equal(lines.length, 10);
  assert.ok(lines.join('\n').length <= 2000 + 10);
});

test('renderMemoryLines laesst kurze Eintraege unangetastet', () => {
  const lines = renderMemoryLines(makeEntries(3), 4000);
  assert.deepEqual(lines, ['`1` - fakt-1', '`2` - fakt-2', '`3` - fakt-3']);
});

test('renderMemoryLines gibt bei leerer Liste ein leeres Array zurueck (keine Division durch 0)', () => {
  assert.deepEqual(renderMemoryLines([], 4000), []);
});
