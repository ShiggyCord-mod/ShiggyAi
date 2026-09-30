import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder
} from 'discord.js';
import { truncateTo } from './textChunking.js';

export const MEMORY_PAGE_SIZE = 10;

// Discord-Limit fuer eine einzelne TextDisplay-Komponente. TextDisplayBuilder validiert
// dagegen und wirft bei Ueberschreitung, die Nachricht geht dann gar nicht erst raus.
export const TEXT_DISPLAY_LIMIT = 4000;

/**
 * Rendert Memory-Eintraege als "`id` - content"-Zeilen und deckelt dabei JEDEN Eintrag auf
 * ein gleich grosses Budget.
 *
 * Warum pro Eintrag und nicht erst am Ende: MAX_MEMORY_LENGTH wird nur beim Schreiben durch
 * das Modell erzwungen, nicht in der DB-Schicht - ueber /memory admin add-user und aus
 * Altdaten liegen laengere Inhalte in der Tabelle (aktuell einer mit >3000 Zeichen). Wuerde
 * man nur die fertige Seite abschneiden, frisst so ein Eintrag die ganze Seite auf und die
 * restlichen Erinnerungen waeren ueber keine Seite mehr erreichbar.
 */
export function renderMemoryLines(entries, totalBudget) {
  if (entries.length === 0) return [];

  const perEntry = Math.floor(totalBudget / entries.length);
  return entries.map((m) => {
    const prefix = `\`${m.id}\` - `;
    return prefix + truncateTo(m.content, perEntry - prefix.length);
  });
}

/**
 * Baut eine Components-V2-Seite (Container + Pagination-Buttons) fuer eine Liste von Memories.
 * @param {{mode: 'user'|'server', targetUserId?: string|null, page: number, entries: Array, pageSize?: number}} args
 */
export function buildMemoryPage({ mode, targetUserId = null, page, entries, pageSize = MEMORY_PAGE_SIZE }) {
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const clampedPage = Math.min(Math.max(page, 0), totalPages - 1);
  const pageEntries = entries.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize);

  const title =
    mode === 'server'
      ? '**Server memories (apply to everyone here, not cross-server)**'
      : `**Memories about <@${targetUserId}> (cross-server)**`;
  const header = `${title} (Page ${clampedPage + 1}/${totalPages})\n`;

  const lines = pageEntries.length
    ? renderMemoryLines(pageEntries, TEXT_DISPLAY_LIMIT - header.length)
    : ['_No entries._'];

  // Der Deckel pro Eintrag oben haelt die Seite schon im Rahmen; das hier ist die Zusicherung,
  // dass wir das Komponenten-Limit unter keinen Umstaenden reissen (Header, Trennzeichen,
  // Rundung beim Budget pro Eintrag).
  const content = truncateTo(header + lines.join('\n'), TEXT_DISPLAY_LIMIT);

  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(content)
  );

  const targetPart = targetUserId || '-';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mem:${mode}:${targetPart}:${clampedPage - 1}`)
      .setLabel('◀ Back')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(clampedPage <= 0),
    new ButtonBuilder()
      .setCustomId(`mem:${mode}:${targetPart}:${clampedPage + 1}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(clampedPage >= totalPages - 1)
  );

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container, row]
  };
}

/**
 * Parst die customId eines Pagination-Buttons (Format "mem:<mode>:<targetUserId|->:<page>").
 * @returns {{mode: string, targetUserId: string|null, page: number}|null}
 */
export function parseMemoryButtonId(customId) {
  const parts = customId.split(':');
  if (parts.length !== 4 || parts[0] !== 'mem') return null;

  const [, mode, targetPart, pageStr] = parts;
  const page = parseInt(pageStr, 10);
  if (Number.isNaN(page)) return null;

  return { mode, targetUserId: targetPart === '-' ? null : targetPart, page };
}
