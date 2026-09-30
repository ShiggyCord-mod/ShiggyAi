export const DISCORD_MSG_LIMIT = 2000;
export const MAX_CHUNKS = 3;

const TRUNCATION_NOTICE = '\n\n_(Antwort war zu lang und wurde abgeschnitten.)_';
const TRUNCATION_SUFFIX = '...';

/**
 * Teilt Text in Discord-taugliche Haeppchen (max chunkSize Zeichen), aber hoechstens maxChunks
 * Stueck - Sicherheitsnetz gegen ausufernd lange/kaputte Antworten. Muss dafuer gekuerzt werden,
 * bekommt der letzte Chunk einen Hinweis angehaengt.
 * @returns {string[]}
 */
export function chunkText(text, { maxChunks = MAX_CHUNKS, chunkSize = DISCORD_MSG_LIMIT } = {}) {
  if (text.length <= chunkSize) return [text];

  const allChunks = text.match(new RegExp(`.{1,${chunkSize}}`, 'gs')) || [text];
  if (allChunks.length <= maxChunks) return allChunks;

  const kept = allChunks.slice(0, maxChunks);
  const noticeRoom = Math.max(0, chunkSize - TRUNCATION_NOTICE.length);
  kept[maxChunks - 1] = kept[maxChunks - 1].slice(0, noticeRoom) + TRUNCATION_NOTICE;
  return kept;
}

/**
 * Kuerzt Text hart auf maxLen Zeichen und haengt - nur wenn wirklich gekuerzt werden musste -
 * einen Hinweis an, der selbst noch ins Limit passt. Das Ergebnis ist NIE laenger als maxLen.
 *
 * Gedacht als letzte Instanz direkt vor dem Discord-Call: die Builder von discord.js validieren
 * Laengen und WERFEN bei Ueberschreitung (EmbedBuilder: 4096 Zeichen Description, TextDisplay:
 * 4000). Ohne diesen Deckel wird aus zu viel Inhalt keine gekuerzte Nachricht, sondern gar keine.
 */
export function truncateTo(text, maxLen) {
  if (maxLen <= 0) return '';
  if (text.length <= maxLen) return text;
  if (maxLen <= TRUNCATION_SUFFIX.length) return text.slice(0, maxLen);
  return text.slice(0, maxLen - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}
