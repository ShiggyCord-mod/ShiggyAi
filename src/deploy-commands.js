import 'dotenv/config';
import { REST, Routes, ApplicationIntegrationType } from 'discord.js';
import { commands } from './commands.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('DISCORD_TOKEN und CLIENT_ID muessen in der .env gesetzt sein.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

// Commands mit User-Install-Support (z.B. /ask, /ping) muessen global registriert werden,
// damit sie in DMs und auf Servern nutzbar sind, wo der Bot nicht als Mitglied drin ist.
// Guild-spezifische Registrierung wuerde sie an die eine GUILD_ID binden.
const guildOnlyCommands = commands.filter((c) => !c.integration_types?.includes(ApplicationIntegrationType.UserInstall));
const userInstallCommands = commands.filter((c) => c.integration_types?.includes(ApplicationIntegrationType.UserInstall));
const globalCommands = GUILD_ID ? userInstallCommands : commands;

try {
  if (globalCommands.length > 0) {
    console.log(`Registriere ${globalCommands.length} Command(s) global (kann bis zu 1h dauern)...`);
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: globalCommands });
  }

  // Immer PUTten (auch mit leerem Array), sonst bleiben alte Guild-Command-Registrierungen
  // als Karteileichen stehen, wenn ein Command von Guild-only auf global wechselt.
  if (GUILD_ID) {
    console.log(`Registriere ${guildOnlyCommands.length} Command(s) auf Guild ${GUILD_ID} (sofort sichtbar)...`);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: guildOnlyCommands });
  }

  console.log('Fertig.');
} catch (err) {
  console.error('Fehler beim Registrieren der Commands:', err);
  process.exit(1);
}
