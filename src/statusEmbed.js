import { EmbedBuilder } from 'discord.js';
import { truncateTo } from './textChunking.js';

export const STATUS_EMBED_COLOR = 0xed4245; // Discord "Red"

// Harte Discord-Limits. EmbedBuilder validiert dagegen und wirft bei Ueberschreitung,
// deshalb wird hier gedeckelt statt es auf den API-Call ankommen zu lassen.
export const EMBED_DESCRIPTION_LIMIT = 4096;
export const EMBED_TITLE_LIMIT = 256;

/**
 * Embed mit rotem Rand fuer System-/Status-Nachrichten (Rate-Limit, Fehler, /memory,
 * /ping). Die eigentliche Chat-Antwort bleibt bewusst normaler Text, damit sie sich wie
 * eine echte Konversation anfuehlt statt wie ein Tool-Output.
 *
 * Description und Title werden auf die Discord-Limits gekuerzt: der groesste Aufrufer ist
 * /memory list mit bis zu 25 Eintraegen, und da reichen durchschnittlich lange Erinnerungen
 * schon aus, um die 4096 Zeichen zu reissen.
 */
export function statusEmbed(description, title) {
  const embed = new EmbedBuilder()
    .setColor(STATUS_EMBED_COLOR)
    .setDescription(truncateTo(description, EMBED_DESCRIPTION_LIMIT));
  if (title) embed.setTitle(truncateTo(title, EMBED_TITLE_LIMIT));
  return { embeds: [embed] };
}
