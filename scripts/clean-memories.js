import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { db, getAllMemories, deleteMemoryById } from '../src/db.js';
import { isRunaway, isAuthorityClaim, similarity, contentTokens, DUPLICATE_THRESHOLD } from '../src/memoryHygiene.js';

// Raeumt einen bereits entarteten Bestand auf. Die Filter in memoryHygiene.js greifen nur beim
// Schreiben, also fuer alles Neue - was vorher schon drin war, bleibt liegen.
//
// Standard ist der Trockenlauf: nichts wird geloescht, ausgegeben wird nur, was passieren wuerde.
// Erst --apply loescht, und legt vorher eine Kopie der Datenbank an.

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.DB_PATH || './data/memory.sqlite';

const clip = (s, n = 72) => (s.length > n ? s.slice(0, n) + '…' : s).replace(/\s+/g, ' ');

const memories = getAllMemories();
if (memories.length === 0) {
  console.log('Keine Erinnerungen vorhanden, nichts zu tun.');
  process.exit(0);
}

const doomed = new Map(); // id -> Begruendung

// 1) Ausgeuferte Eintraege: eine kaputte Generierung, kein langer Fakt
for (const m of memories) {
  if (isRunaway(m.content)) doomed.set(m.id, `ausgeufert (${m.content.length} Zeichen)`);
  else if (isAuthorityClaim(m.content)) doomed.set(m.id, 'Behauptung ueber Rechte/Rollen');
}

// 2) Dubletten gruppenweise: pro Besitzer und Scope vergleichen, denn Erinnerungen
//    verschiedener Besitzer sind nie Dubletten voneinander.
const groups = new Map();
for (const m of memories) {
  if (doomed.has(m.id)) continue;
  const key = `${m.scope}:${m.user_id ?? m.guild_id}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({ ...m, tokens: contentTokens(m.content) });
}

const duplicateGroups = [];
for (const [key, rows] of groups) {
  // Kuerzeste zuerst: der Bestand wird mit der Zeit geschwaetziger, die knappste Fassung
  // derselben Aussage traegt also am meisten Information pro Zeichen.
  rows.sort((a, b) => a.content.length - b.content.length);

  for (let i = 0; i < rows.length; i++) {
    if (doomed.has(rows[i].id)) continue;
    const dupes = [];
    for (let j = i + 1; j < rows.length; j++) {
      if (doomed.has(rows[j].id)) continue;
      const score = similarity(rows[i].tokens, rows[j].tokens);
      const limit = Math.min(rows[i].tokens.size, rows[j].tokens.size) < 4 ? 0.8 : DUPLICATE_THRESHOLD;
      if (score >= limit) {
        doomed.set(rows[j].id, `Dublette von ${rows[i].id} (${score.toFixed(2)})`);
        dupes.push({ ...rows[j], score });
      }
    }
    if (dupes.length) duplicateGroups.push({ owner: key, keep: rows[i], drop: dupes });
  }
}

// ---- Bericht ----
const runaways = memories.filter((m) => doomed.get(m.id)?.startsWith('ausgeufert'));
const authority = memories.filter((m) => doomed.get(m.id) === 'Behauptung ueber Rechte/Rollen');

console.log(`Bestand: ${memories.length} Erinnerungen, ${sum(memories)} Zeichen\n`);

if (runaways.length) {
  console.log(`Ausgeufert (${runaways.length}) - werden geloescht:`);
  for (const m of runaways) console.log(`  [${m.id}] ${m.content.length} Zeichen: ${clip(m.content, 64)}`);
  console.log();
}

if (authority.length) {
  console.log(`Behauptungen ueber Rechte/Rollen (${authority.length}) - werden geloescht:`);
  for (const m of authority) console.log(`  [${m.id}] ${clip(m.content)}`);
  console.log();
}

if (duplicateGroups.length) {
  const dropped = duplicateGroups.reduce((n, g) => n + g.drop.length, 0);
  console.log(`Dubletten (${dropped} Eintraege in ${duplicateGroups.length} Gruppen) - je der kuerzeste bleibt:`);
  for (const g of duplicateGroups) {
    console.log(`  behalten [${g.keep.id}] ${clip(g.keep.content)}`);
    for (const d of g.drop) console.log(`    loeschen [${d.id}] (${d.score.toFixed(2)}) ${clip(d.content)}`);
  }
  console.log();
}

if (doomed.size === 0) {
  console.log('Nichts zu beanstanden, der Bestand ist in Ordnung.');
  process.exit(0);
}

const survivors = memories.filter((m) => !doomed.has(m.id));
console.log(
  `Ergebnis: ${memories.length} -> ${survivors.length} Erinnerungen, ` +
  `${sum(memories)} -> ${sum(survivors)} Zeichen (${Math.round((1 - sum(survivors) / sum(memories)) * 100)} % kleiner).`
);

if (!APPLY) {
  console.log('\nTrockenlauf - nichts geaendert. Zum Ausfuehren: npm run memories:clean -- --apply');
  process.exit(0);
}

// ---- Anwenden ----
const backup = `${DB_PATH}.backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // WAL in die Hauptdatei ziehen, damit die Kopie vollstaendig ist
fs.mkdirSync(path.dirname(backup), { recursive: true });
fs.copyFileSync(DB_PATH, backup);
console.log(`\nSicherung: ${backup}`);

let deleted = 0;
const run = db.transaction(() => {
  for (const id of doomed.keys()) if (deleteMemoryById(id)) deleted++;
});
run();

console.log(`${deleted} Erinnerungen geloescht. Zurueck geht es mit: cp "${backup}" "${DB_PATH}"`);

function sum(rows) {
  return rows.reduce((n, m) => n + m.content.length, 0);
}
