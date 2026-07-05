import { SlashCommandBuilder, ApplicationIntegrationType, InteractionContextType } from 'discord.js';

// Fuer Commands, die auch per User-Install (auf dem eigenen Account des Users installiert,
// statt nur als Server-Mitglied) und damit in DMs/auf fremden Servern nutzbar sein sollen.
const EVERYWHERE_INTEGRATION_TYPES = [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall];
const EVERYWHERE_CONTEXTS = [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel];

export const commands = [
  new SlashCommandBuilder()
    .setName('memory')
    .setDescription('Verwalte was der Bot sich ueber dich merkt (serveruebergreifend)')
    .setIntegrationTypes(EVERYWHERE_INTEGRATION_TYPES)
    .setContexts(EVERYWHERE_CONTEXTS)
    .addSubcommand(sub =>
      sub.setName('list').setDescription('Zeigt an, was sich der Bot ueber dich merkt (serveruebergreifend)')
    )
    .addSubcommand(sub =>
      sub
        .setName('forget')
        .setDescription('Loescht eine einzelne Erinnerung anhand ihrer ID')
        .addIntegerOption(opt =>
          opt.setName('id').setDescription('Die ID aus /memory list').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('clear').setDescription('Loescht ALLE Erinnerungen die der Bot ueber dich hat')
    )
    .addSubcommandGroup(group =>
      group
        .setName('admin')
        .setDescription('Nur fuer vertrauenswuerdige User (TRUSTED_USER_IDS)')
        .addSubcommand(sub =>
          sub
            .setName('list-user')
            .setDescription('Zeigt alle Erinnerungen ueber einen User (serveruebergreifend, mit IDs)')
            .addUserOption(opt =>
              opt.setName('user').setDescription('Der User, dessen Erinnerungen angezeigt werden sollen').setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub.setName('list-server').setDescription('Zeigt die Server-Erinnerungen dieses Servers (mit IDs)')
        )
        .addSubcommand(sub =>
          sub
            .setName('forget-user')
            .setDescription('Loescht eine User-Erinnerung anhand ihrer ID (serveruebergreifend)')
            .addIntegerOption(opt =>
              opt.setName('id').setDescription('Die Memory-ID aus /memory admin list-user').setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('forget-server')
            .setDescription('Loescht eine Server-Erinnerung anhand ihrer ID (nur dieser Server)')
            .addIntegerOption(opt =>
              opt.setName('id').setDescription('Die Memory-ID aus /memory admin list-server').setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('add-user')
            .setDescription('Fuegt manuell eine Erinnerung ueber einen User hinzu (serveruebergreifend)')
            .addUserOption(opt =>
              opt.setName('user').setDescription('Der User, fuer den die Erinnerung gespeichert wird').setRequired(true)
            )
            .addStringOption(opt =>
              opt.setName('content').setDescription('Der Inhalt der Erinnerung').setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('add-server')
            .setDescription('Fuegt manuell eine Server-Erinnerung fuer diesen Server hinzu')
            .addStringOption(opt =>
              opt.setName('content').setDescription('Der Inhalt der Erinnerung').setRequired(true)
            )
        )
    ),
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Zeigt die aktuelle Bot-Latenz an')
    .setIntegrationTypes(EVERYWHERE_INTEGRATION_TYPES)
    .setContexts(EVERYWHERE_CONTEXTS),
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Stell dem Bot eine Frage - funktioniert ueberall, auch in DMs und auf fremden Servern')
    .addStringOption(opt =>
      opt.setName('frage').setDescription('Deine Frage an den Bot').setRequired(true)
    )
    .setIntegrationTypes(EVERYWHERE_INTEGRATION_TYPES)
    .setContexts(EVERYWHERE_CONTEXTS)
].map(cmd => cmd.toJSON());
