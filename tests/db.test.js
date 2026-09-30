import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const TEST_DB_PATH = path.join(os.tmpdir(), `shiggyai-test-${Date.now()}.sqlite`);
process.env.DB_PATH = TEST_DB_PATH;

const {
  addUserMemory,
  addGuildMemory,
  getUserMemories,
  getGuildMemories,
  deleteUserMemory,
  deleteUserMemoryAdmin,
  deleteGuildMemory,
  clearUserMemories
} = await import('../src/db.js');
const { MAX_MEMORY_LENGTH } = await import('../src/memoryHygiene.js');

const USER = 'user-1';
const GUILD = 'guild-1';

// Paarweise klar unterschiedliche Begriffe: die Deckel-Tests wollen die Eviction pruefen und
// duerfen nicht an der Dublettenerkennung haengenbleiben.
const NOUNS = [
  'Kaffee', 'Fahrrad', 'Klavier', 'Bergwandern', 'Astronomie', 'Schach', 'Aquarell', 'Bouldern',
  'Keramik', 'Jazzmusik', 'Segeln', 'Botanik', 'Origami', 'Tauchen', 'Kalligrafie', 'Imkerei',
  'Bogenschiessen', 'Mykologie', 'Weinbau', 'Tischlerei', 'Fotografie', 'Geologie', 'Ballett',
  'Kanufahren', 'Uhrmacherei', 'Vogelkunde', 'Gartenbau', 'Fechten', 'Buchbinden', 'Meteorologie',
  'Golf', 'Skulptur', 'Reiten', 'Kartografie', 'Gewichtheben', 'Hoerspiel', 'Zauberkunst',
  'Modellbau', 'Angeln', 'Yoga', 'Puppenspiel', 'Numismatik', 'Klettern', 'Weberei',
  'Paragleiten', 'Schmieden', 'Eishockey', 'Linoldruck', 'Sternwarte', 'Trampolin',
  'Glasblasen', 'Handball', 'Zeichentrick', 'Marathon', 'Saxofon'
];

after(() => {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    fs.rmSync(TEST_DB_PATH + suffix, { force: true });
  }
});

test('addUserMemory + getUserMemories speichert und liest Erinnerungen (neueste zuerst)', () => {
  clearUserMemories(USER);
  addUserMemory(USER, 'mag Kaffee');
  addUserMemory(USER, 'arbeitet an einem Discord-Bot');

  const memories = getUserMemories(USER);
  assert.equal(memories.length, 2);
  assert.equal(memories[0].content, 'arbeitet an einem Discord-Bot');
  assert.equal(memories[1].content, 'mag Kaffee');
});

test('addUserMemory ignoriert leere/nur-Whitespace Inhalte', () => {
  clearUserMemories(USER);
  addUserMemory(USER, '   ');
  assert.equal(getUserMemories(USER).length, 0);
});

test('User-Memories sind serveruebergreifend - keine Guild-Isolation mehr', () => {
  clearUserMemories(USER);
  addUserMemory(USER, 'ein Fakt');

  // Dieselbe Erinnerung muss unabhaengig vom "Kontext" (DM/Server X/Server Y) auftauchen -
  // getUserMemories nimmt gar keine Guild mehr entgegen, es gibt nur einen Topf pro User.
  const memories = getUserMemories(USER);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].content, 'ein Fakt');
});

test('getUserMemories ist pro User isoliert', () => {
  clearUserMemories(USER);
  clearUserMemories('user-2');
  addUserMemory(USER, 'nur fuer user-1');
  addUserMemory('user-2', 'nur fuer user-2');

  assert.equal(getUserMemories(USER).length, 1);
  assert.equal(getUserMemories('user-2').length, 1);
  assert.equal(getUserMemories(USER)[0].content, 'nur fuer user-1');
});

test('deleteUserMemory loescht nur die eigene Erinnerung des richtigen Users', () => {
  clearUserMemories(USER);
  addUserMemory(USER, 'zu loeschen');
  const [{ id }] = getUserMemories(USER);

  assert.equal(deleteUserMemory(id, 'anderer-user'), false);
  assert.equal(deleteUserMemory(id, USER), true);
  assert.equal(getUserMemories(USER).length, 0);
});

test('clearUserMemories loescht alle Erinnerungen eines Users und gibt die Anzahl zurueck', () => {
  clearUserMemories(USER);
  addUserMemory(USER, 'a');
  addUserMemory(USER, 'b');

  assert.equal(clearUserMemories(USER), 2);
  assert.equal(getUserMemories(USER).length, 0);
});

test('Deckel von 50 User-Memories wird durchgesetzt, aelteste fliegen zuerst raus', () => {
  const user = 'user-cap-test';
  clearUserMemories(user);

  for (let i = 0; i < 55; i++) {
    addUserMemory(user, `interessiert sich fuer Thema ${NOUNS[i]}`);
  }

  const memories = getUserMemories(user, 100);
  assert.equal(memories.length, 50);
  assert.equal(memories[0].content, `interessiert sich fuer Thema ${NOUNS[54]}`);
  assert.equal(memories[memories.length - 1].content, `interessiert sich fuer Thema ${NOUNS[5]}`);
});

test('addGuildMemory + getGuildMemories speichert und liest Server-Erinnerungen (neueste zuerst)', () => {
  addGuildMemory(GUILD, 'Server dreht sich um Minecraft');
  addGuildMemory(GUILD, 'Game-Night ist immer freitags');

  const memories = getGuildMemories(GUILD, 100);
  assert.ok(memories.length >= 2);
  assert.equal(memories[0].content, 'Game-Night ist immer freitags');
});

test('getGuildMemories ist pro Guild isoliert (nicht serveruebergreifend)', () => {
  const guildA = 'guild-a';
  const guildB = 'guild-b';
  addGuildMemory(guildA, 'nur fuer guild-a');

  const memoriesA = getGuildMemories(guildA, 100);
  const memoriesB = getGuildMemories(guildB, 100);
  assert.ok(memoriesA.some((m) => m.content === 'nur fuer guild-a'));
  assert.ok(!memoriesB.some((m) => m.content === 'nur fuer guild-a'));
});

test('deleteGuildMemory loescht nur innerhalb der angegebenen Guild', () => {
  const guild = 'guild-forget-test';
  addGuildMemory(guild, 'zu loeschen');
  const [{ id }] = getGuildMemories(guild, 100);

  assert.equal(deleteGuildMemory(id, 'andere-guild'), false);
  assert.equal(deleteGuildMemory(id, guild), true);
  assert.ok(!getGuildMemories(guild, 100).some((m) => m.id === id));
});

test('deleteUserMemoryAdmin loescht per ID, unabhaengig vom User (serveruebergreifend)', () => {
  clearUserMemories(USER);
  addUserMemory(USER, 'admin loescht das');
  const [{ id }] = getUserMemories(USER);

  assert.equal(deleteUserMemoryAdmin(id), true);
  assert.equal(getUserMemories(USER).length, 0);
});

test('Deckel von 50 Guild-Memories wird durchgesetzt, aelteste fliegen zuerst raus', () => {
  const guild = 'guild-cap-test';

  for (let i = 0; i < 55; i++) {
    addGuildMemory(guild, `Serverthema ${NOUNS[i]}`);
  }

  const memories = getGuildMemories(guild, 100);
  assert.equal(memories.length, 50);
  assert.equal(memories[0].content, `Serverthema ${NOUNS[54]}`);
  assert.equal(memories[memories.length - 1].content, `Serverthema ${NOUNS[5]}`);
});

test('Migration: alte (guild_id, user_id)-Zeilen landen als User-Memory (serveruebergreifend)', async () => {
  const migrationDbPath = path.join(os.tmpdir(), `shiggyai-migration-test-${Date.now()}.sqlite`);
  const oldDb = new Database(migrationDbPath);
  oldDb.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  oldDb.prepare('INSERT INTO memories (guild_id, user_id, content) VALUES (?, ?, ?)').run('old-guild', 'migrated-user', 'alter Fakt');
  oldDb.close();

  const previousDbPath = process.env.DB_PATH;
  process.env.DB_PATH = migrationDbPath;

  try {
    // Frisches Modul laden, damit die Migrationslogik am Modul-Top-Level erneut laeuft.
    const { getUserMemories: getUserMemoriesFresh } = await import(`../src/db.js?migration-test=${Date.now()}`);
    const memories = getUserMemoriesFresh('migrated-user');
    assert.equal(memories.length, 1);
    assert.equal(memories[0].content, 'alter Fakt');
  } finally {
    process.env.DB_PATH = previousDbPath;
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      fs.rmSync(migrationDbPath + suffix, { force: true });
    }
  }
});

// ---- Laengen-Invariante und Dublettenschutz beim Schreiben ----

test('addUserMemory erzwingt die Laengengrenze, egal auf welchem Weg der Inhalt kommt', () => {
  // Nur in llm.js zu kuerzen reichte nicht: ueber /memory admin add-user kamen beliebig lange
  // Inhalte in die Tabelle, und daran sind /memory list und die Admin-Liste zerbrochen.
  const user = 'user-length';
  clearUserMemories(user);
  addUserMemory(user, 'w'.repeat(5000), { dedupe: false });

  const [row] = getUserMemories(user, 10);
  assert.equal(row.content.length, MAX_MEMORY_LENGTH);
});

test('addUserMemory lehnt eine Neuformulierung derselben Aussage ab', () => {
  const user = 'user-dupe';
  clearUserMemories(user);

  const first = addUserMemory(user, 'reinforces his marital status through ongoing and heartfelt interactions');
  assert.equal(first.stored, true);

  const second = addUserMemory(user, 'consistently reinforces his marital status through his ongoing and heartfelt interactions');
  assert.equal(second.stored, false);
  assert.equal(second.reason, 'duplicate');
  assert.equal(second.duplicateOf, first ? getUserMemories(user, 10)[0].id : undefined);
  assert.equal(getUserMemories(user, 10).length, 1, 'es bleibt bei einem Eintrag');
});

test('addUserMemory speichert inhaltlich verschiedene Fakten weiterhin', () => {
  const user = 'user-distinct';
  clearUserMemories(user);
  assert.equal(addUserMemory(user, 'trinkt morgens am liebsten schwarzen Kaffee').stored, true);
  assert.equal(addUserMemory(user, 'arbeitet an einem Discord-Bot mit Langzeitgedaechtnis').stored, true);
  assert.equal(getUserMemories(user, 10).length, 2);
});

test('dedupe:false umgeht die Pruefung - fuer manuelle Eintraege durch einen Menschen', () => {
  const user = 'user-force';
  clearUserMemories(user);
  addUserMemory(user, 'trinkt morgens am liebsten schwarzen Kaffee');
  const forced = addUserMemory(user, 'trinkt morgens am liebsten schwarzen Kaffee', { dedupe: false });

  assert.equal(forced.stored, true);
  assert.equal(getUserMemories(user, 10).length, 2);
});

test('addUserMemory meldet leere Inhalte als solche, statt still nichts zu tun', () => {
  const user = 'user-empty';
  clearUserMemories(user);
  assert.deepEqual(addUserMemory(user, '   '), { stored: false, reason: 'empty' });
  assert.deepEqual(addUserMemory(user, null), { stored: false, reason: 'empty' });
  assert.equal(getUserMemories(user, 10).length, 0);
});

test('addGuildMemory verhaelt sich bei Laenge und Dubletten genauso', () => {
  const guild = 'guild-hygiene';
  addGuildMemory(guild, 'v'.repeat(5000), { dedupe: false });
  assert.equal(getGuildMemories(guild, 10)[0].content.length, MAX_MEMORY_LENGTH);

  const before = getGuildMemories(guild, 100).length;
  assert.equal(addGuildMemory(guild, 'v'.repeat(400)).reason, 'duplicate');
  assert.equal(getGuildMemories(guild, 100).length, before);
});
