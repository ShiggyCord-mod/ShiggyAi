export const DISCORD_MSG_LIMIT = 2000;
export const MAX_CHUNKS = 3;

const TRUNCATION_NOTICE = '\n\n_(Antwort war zu lang und wurde abgeschnitten.)_';

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
