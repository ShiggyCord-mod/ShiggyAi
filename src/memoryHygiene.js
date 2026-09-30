// Qualitaetsfilter fuer neue Erinnerungen.
//
// Hintergrund: Ohne diese Filter frisst sich der Bestand selbst auf. Gemessen an einem echten
// Bestand von 50 Eintraegen: 78 % drehten sich um dasselbe Thema, 38 Paare waren Dubletten
// (eines bei 0.90 Wortueberlappung, also praktisch derselbe Satz), 33 von 50 begannen mit
// einem Verhaltensadverb ("consistently demonstrates...") und trugen damit keine Information.
// Ein Eintrag war 3276 Zeichen lang - ein einzelner Satz, in dem das Modell in eine Schleife
// geraten war, und der allein rund ein Drittel des Prompts gefressen hat.
//
// Das ist ein Rueckkopplungseffekt: Das Modell sieht im Prompt lauter solche Eintraege und
// schreibt beim naechsten Mal mehr davon. Zusammen mit dem Deckel pro Besitzer verdraengt die
// Monokultur dann ueber die Eviction die echten Fakten. Auf "halte es kurz" im Prompt ist dabei
// kein Verlass, das zeigt der Bestand oben - deshalb hier im Code.

export const MAX_MEMORY_LENGTH = 300;   // darueber wird gekuerzt
export const RUNAWAY_LENGTH = 600;      // darueber komplett verworfen (siehe unten)
export const DUPLICATE_THRESHOLD = 0.45;

// Bei wenigen bedeutungstragenden Woertern ist Jaccard zu grob: zwei kurze, inhaltlich klar
// verschiedene Eintraege mit gemeinsamer Schablone ("interessiert sich fuer Thema X" vs. "... Y")
// kommen allein durch das Geruest auf 0.50. Darum gilt fuer kurze Eintraege eine strengere
// Schwelle - dort zaehlt praktisch nur noch echte Textgleichheit.
export const SHORT_ENTRY_TOKENS = 4;
export const SHORT_ENTRY_THRESHOLD = 0.8;

// Warum verwerfen statt kuerzen: Ein Eintrag, der das Doppelte des Limits reisst, ist keine
// lange Information, sondern eine kaputte Generierung. Wer den auf 300 Zeichen kuerzt, behaelt
// ein sinnloses Satzfragment - und das wandert in den naechsten Prompt und stuetzt den Effekt.

// Sehr haeufige Woerter tragen bei diesen Saetzen keine Bedeutung und wuerden die
// Aehnlichkeit nach oben verzerren.
const STOPWORDS = new Set(
  ('the a an and or of to his her he she is are was were in on with that this for as by it its ' +
   'und der die das ein eine einem einen ist sind war waren mit auf fuer als von den dem sich')
    .split(' ')
);

/**
 * Behauptungen ueber Rechte, Rollen oder Autoritaet werden nie gespeichert.
 *
 * Wichtig zur Einordnung: Die /memory admin Befehle haengen an TRUSTED_USER_IDS aus der .env,
 * nicht am Gedaechtnis - eine solche Erinnerung kann also keine Befehle freischalten. Der
 * Schaden ist, dass der Bot die Behauptung anschliessend anderen gegenueber als gegeben
 * vertritt ("X ist hier Admin"). Das reicht als Grund, sie gar nicht erst aufzunehmen.
 */
const AUTHORITY_PATTERNS = [
  /\b(admin|administrator|moderator|besitzer|inhaber|eigent[uü]mer|owner|staff)\b/i,
  /\b(darf|d[uü]rfen|erlaubt|berechtigt|befugt|permission|allowed|authoriz|authoris|privileg)/i,
  /\b(bypass|umgeh|ignorier|override|freischalt|vollzugriff|full access|root)\b/i,
  /\b(hat gesagt|sagte, dass|laut aussage|claims that .* (can|may|is allowed))/i
];

export function isAuthorityClaim(text) {
  return AUTHORITY_PATTERNS.some((re) => re.test(text));
}

/**
 * Erkennt eine in eine Schleife geratene Generierung: entweder absurd lang, oder ein kurzer
 * Wortblock, der sich innerhalb des Eintrags mehrfach wiederholt.
 */
export function isRunaway(text) {
  if (text.length > RUNAWAY_LENGTH) return true;

  const words = normalizeWords(text);
  if (words.length < 12) return false;

  // Wiederholte 4-Wort-Folgen sind ein deutliches Schleifensignal
  const seen = new Set();
  let repeats = 0;
  for (let i = 0; i + 4 <= words.length; i++) {
    const gram = words.slice(i, i + 4).join(' ');
    if (seen.has(gram)) repeats++;
    else seen.add(gram);
  }
  return repeats >= 3;
}

function normalizeWords(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Bedeutungstragende Wortmenge eines Eintrags. */
export function contentTokens(text) {
  return new Set(normalizeWords(text).filter((w) => w.length > 3 && !STOPWORDS.has(w)));
}

/** Jaccard-Aehnlichkeit zweier Eintraege, 0 (nichts gemeinsam) bis 1 (gleiche Wortmenge). */
export function similarity(a, b) {
  const ta = a instanceof Set ? a : contentTokens(a);
  const tb = b instanceof Set ? b : contentTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;

  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/**
 * Sucht unter vorhandenen Eintraegen eine Dublette zum neuen Inhalt.
 *
 * Die Schwelle von 0.45 ist an echten Daten kalibriert, nicht geraten: bei 0.50 rutschten
 * eindeutige Dubletten durch ("demonstrates a high level of emotional depth..." zweimal bei
 * 0.44). Bei einem gesunden Bestand schlaegt der Filter so gut wie nie an.
 *
 * @param {string} content
 * @param {Array<{id?: number, content: string}>} existing
 * @returns {{id?: number, content: string, score: number}|null}
 */
export function findDuplicate(content, existing, threshold = DUPLICATE_THRESHOLD) {
  const tokens = contentTokens(content);
  if (tokens.size === 0) return null;

  let best = null;
  for (const row of existing) {
    const other = contentTokens(row.content);
    const score = similarity(tokens, other);
    const limit = Math.min(tokens.size, other.size) < SHORT_ENTRY_TOKENS
      ? Math.max(threshold, SHORT_ENTRY_THRESHOLD)
      : threshold;
    if (score >= limit && (!best || score > best.score)) best = { ...row, score };
  }
  return best;
}

/**
 * Prueft einen vom Modell vorgeschlagenen Eintrag, bevor er in die Naehe der DB kommt.
 * @returns {{ok: true, content: string} | {ok: false, reason: string}}
 */
export function vetNewMemory(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not_a_string' };

  const content = raw.trim();
  if (!content) return { ok: false, reason: 'empty' };
  if (isRunaway(content)) return { ok: false, reason: 'runaway' };
  if (isAuthorityClaim(content)) return { ok: false, reason: 'authority_claim' };

  return { ok: true, content: content.slice(0, MAX_MEMORY_LENGTH) };
}
