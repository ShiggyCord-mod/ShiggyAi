import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder
} from 'discord.js';

export const MEMORY_PAGE_SIZE = 10;

/**
 * Baut eine Components-V2-Seite (Container + Pagination-Buttons) fuer eine Liste von Memories.
 * @param {{mode: 'user'|'server', targetUserId?: string|null, page: number, entries: Array, pageSize?: number}} args
 */
export function buildMemoryPage({ mode, targetUserId = null, page, entries, pageSize = MEMORY_PAGE_SIZE }) {
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const clampedPage = Math.min(Math.max(page, 0), totalPages - 1);
  const pageEntries = entries.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize);

  const lines = pageEntries.length ? pageEntries.map((m) => `\`${m.id}\` - ${m.content}`) : ['_No entries._'];

  const title =
    mode === 'server'
      ? '**Server memories (apply to everyone here, not cross-server)**'
      : `**Memories about <@${targetUserId}> (cross-server)**`;

  const container = new ContainerBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`${title} (Page ${clampedPage + 1}/${totalPages})\n${lines.join('\n')}`)
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
