import { EmbedBuilder } from 'discord.js';

export const STATUS_EMBED_COLOR = 0xed4245; // Discord "Red"

/**
 * Embed mit rotem Rand fuer System-/Status-Nachrichten (Rate-Limit, Fehler, /memory,
 * /ping). Die eigentliche Gemini-Chat-Antwort bleibt bewusst normaler Text, damit sie
 * sich wie eine echte Konversation anfuehlt statt wie ein Tool-Output.
 */
export function statusEmbed(description, title) {
  const embed = new EmbedBuilder().setColor(STATUS_EMBED_COLOR).setDescription(description);
  if (title) embed.setTitle(title);
  return { embeds: [embed] };
}
