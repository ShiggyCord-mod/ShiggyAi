import { SlashCommandBuilder, ApplicationIntegrationType, InteractionContextType } from 'discord.js';

// Fuer Commands, die auch per User-Install (auf dem eigenen Account des Users installiert,
// statt nur als Server-Mitglied) und damit in DMs/auf fremden Servern nutzbar sein sollen.
const EVERYWHERE_INTEGRATION_TYPES = [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall];
const EVERYWHERE_CONTEXTS = [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel];

export const commands = [
  new SlashCommandBuilder()
    .setName('memory')
    .setDescription('Manage what the bot remembers about you (cross-server)')
    .setIntegrationTypes(EVERYWHERE_INTEGRATION_TYPES)
    .setContexts(EVERYWHERE_CONTEXTS)
    .addSubcommand(sub =>
      sub.setName('list').setDescription('Show what the bot remembers about you (cross-server)')
    )
    .addSubcommand(sub =>
      sub
        .setName('forget')
        .setDescription('Delete a single memory by its ID')
        .addIntegerOption(opt =>
          opt.setName('id').setDescription('The ID from /memory list').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('clear').setDescription('Delete ALL memories the bot has about you')
    )
    .addSubcommandGroup(group =>
      group
        .setName('admin')
        .setDescription('Trusted users only (TRUSTED_USER_IDS)')
        .addSubcommand(sub =>
          sub
            .setName('list-user')
            .setDescription('Show all memories about a user (cross-server, with IDs)')
            .addUserOption(opt =>
              opt.setName('user').setDescription('The user whose memories should be shown').setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub.setName('list-server').setDescription("Show this server's memories (with IDs)")
        )
        .addSubcommand(sub =>
          sub
            .setName('forget-user')
            .setDescription('Delete a user memory by its ID (cross-server)')
            .addIntegerOption(opt =>
              opt.setName('id').setDescription('The memory ID from /memory admin list-user').setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('forget-server')
            .setDescription('Delete a server memory by its ID (this server only)')
            .addIntegerOption(opt =>
              opt.setName('id').setDescription('The memory ID from /memory admin list-server').setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('add-user')
            .setDescription('Manually add a memory about a user (cross-server)')
            .addUserOption(opt =>
              opt.setName('user').setDescription('The user this memory is saved for').setRequired(true)
            )
            .addStringOption(opt =>
              opt.setName('content').setDescription('The content of the memory').setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('add-server')
            .setDescription('Manually add a server memory for this server')
            .addStringOption(opt =>
              opt.setName('content').setDescription('The content of the memory').setRequired(true)
            )
        )
    ),
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription("Show the bot's current latency")
    .setIntegrationTypes(EVERYWHERE_INTEGRATION_TYPES)
    .setContexts(EVERYWHERE_CONTEXTS),
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask the bot a question - works everywhere, including DMs and other servers')
    .addStringOption(opt =>
      opt.setName('question').setDescription('Your question for the bot').setRequired(true)
    )
    .setIntegrationTypes(EVERYWHERE_INTEGRATION_TYPES)
    .setContexts(EVERYWHERE_CONTEXTS)
].map(cmd => cmd.toJSON());
