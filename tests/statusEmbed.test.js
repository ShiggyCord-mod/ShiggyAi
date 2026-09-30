import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusEmbed, STATUS_EMBED_COLOR, EMBED_DESCRIPTION_LIMIT, EMBED_TITLE_LIMIT } from '../src/statusEmbed.js';

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

test('statusEmbed kuerzt eine zu lange Description auf das Discord-Limit, statt zu werfen', () => {
  // Regression: /memory list baute aus 25 Erinnerungen ~6000 Zeichen, EmbedBuilder validiert
  // dagegen und warf - im Handler ohne try/catch hat das den ganzen Prozess beendet.
  const payload = statusEmbed('x'.repeat(EMBED_DESCRIPTION_LIMIT + 2000));
  assert.equal(payload.embeds[0].data.description.length, EMBED_DESCRIPTION_LIMIT);
});

test('statusEmbed kuerzt auch einen zu langen Titel', () => {
  const payload = statusEmbed('ok', 'T'.repeat(EMBED_TITLE_LIMIT + 50));
  assert.equal(payload.embeds[0].data.title.length, EMBED_TITLE_LIMIT);
});
