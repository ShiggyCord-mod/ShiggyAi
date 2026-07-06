import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusEmbed, STATUS_EMBED_COLOR } from '../src/statusEmbed.js';

test('statusEmbed baut ein Embed mit rotem Rand und der uebergebenen Beschreibung', () => {
  const payload = statusEmbed('Something happened.');
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].data.color, STATUS_EMBED_COLOR);
  assert.equal(payload.embeds[0].data.description, 'Something happened.');
  assert.equal(payload.embeds[0].data.title, undefined);
});

test('statusEmbed setzt einen Titel, wenn einer uebergeben wird', () => {
  const payload = statusEmbed('list content', 'A title');
  assert.equal(payload.embeds[0].data.title, 'A title');
});
