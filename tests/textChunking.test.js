import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, truncateTo, DISCORD_MSG_LIMIT, MAX_CHUNKS } from '../src/textChunking.js';

test('chunkText gibt kurzen Text unveraendert als Ein-Element-Array zurueck', () => {
  assert.deepEqual(chunkText('hallo'), ['hallo']);
});

test('chunkText teilt Text ueber dem Limit in mehrere Stuecke, solange unter maxChunks', () => {
  const text = 'a'.repeat(DISCORD_MSG_LIMIT + 500);
  const chunks = chunkText(text);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, DISCORD_MSG_LIMIT);
});

test('chunkText deckelt auf MAX_CHUNKS und haengt einen Kuerzungshinweis an den letzten Chunk', () => {
  const text = 'a'.repeat(DISCORD_MSG_LIMIT * 10);
  const chunks = chunkText(text);
  assert.equal(chunks.length, MAX_CHUNKS);
  for (const c of chunks) assert.ok(c.length <= DISCORD_MSG_LIMIT);
  assert.match(chunks[chunks.length - 1], /abgeschnitten/);
});

test('chunkText respektiert benutzerdefinierte chunkSize/maxChunks', () => {
  const chunks = chunkText('a'.repeat(100), { chunkSize: 10, maxChunks: 2 });
  assert.equal(chunks.length, 2);
});

test('truncateTo laesst Text unter dem Limit unveraendert', () => {
  assert.equal(truncateTo('kurz', 100), 'kurz');
  assert.equal(truncateTo('genau-zehn', 10), 'genau-zehn');
});

test('truncateTo kuerzt auf hoechstens maxLen Zeichen, inklusive Hinweis', () => {
  const out = truncateTo('x'.repeat(500), 50);
  assert.equal(out.length, 50);
  assert.ok(out.endsWith('...'));
});

test('truncateTo kommt mit absurd kleinen Limits klar, ohne sie zu reissen', () => {
  assert.equal(truncateTo('abcdef', 2).length, 2);
  assert.equal(truncateTo('abcdef', 3).length, 3);
  assert.equal(truncateTo('abc', 0), '');
});
