import 'dotenv/config';
import { Client, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { askGemini, extractMemories, GeminiRateLimitError, GENERIC_FALLBACK_REPLY } from './gemini.js';
import {
  addUserMemory,
  addGuildMemory,
  getUserMemories,
  getGuildMemories,
  deleteUserMemory,
  deleteUserMemoryAdmin,
  deleteGuildMemory,
  clearUserMemories
} from './db.js';
import { RateLimiter } from './rateLimiter.js';
import { buildMemoryPage, parseMemoryButtonId, renderMemoryLines } from './pagination.js';
import { chunkText } from './textChunking.js';
import { statusEmbed, EMBED_DESCRIPTION_LIMIT } from './statusEmbed.js';

const BOT_PERSONA = process.env.BOT_PERSONA || 'Du bist ein hilfreicher Discord-Bot.';

// User-IDs, die /memory admin nutzen duerfen (Memories einsehen/hinzufuegen/loeschen).
const TRUSTED_USER_IDS = new Set(
  (process.env.TRUSTED_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);
const SHORT_TERM_CONTEXT_LIMIT = parseInt(process.env.SHORT_TERM_CONTEXT_LIMIT || '15', 10);

// Clientseitiges Limit, wieviele Gemini-Requests pro Minute rausgehen duerfen.
// Der Gemini Free Tier liegt je nach Modell aktuell bei ca. 10-15 RPM (Flash-Modelle),
// live einsehbar unter https://aistudio.google.com/rate-limit fuer dein Projekt.
// Bewusst etwas konservativer als das echte Limit, damit Puffer fuer Retries bleibt.
// Wird von der Live-Antwort UND dem passiven Lernen (unten) gemeinsam genutzt.
const RATE_LIMIT_RPM = parseInt(process.env.RATE_LIMIT_RPM || '10', 10);
const rateLimiter = new RateLimiter(RATE_LIMIT_RPM);

// Wenn eine Anfrage laenger als das hier warten muesste, sagen wir dem User kurz
// Bescheid statt ihn einfach im Ungewissen tippen zu lassen.
const QUEUE_WARNING_THRESHOLD_MS = 5_000;

// ---- Passives Lernen: liest auch Nachrichten mit, die nicht an den Bot gerichtet sind ----
// Bewusst gebatcht statt pro Nachricht, sonst sprengt das sehr schnell RATE_LIMIT_RPM
// und die Kosten (ein Gemini-Call pro Channel-Nachricht waere zu viel). Standardmaessig aus,
// da es sich das Gemini-Budget mit Live-Antworten teilt und die dadurch unerwartet ausbremsen kann.
const LEARNING_ENABLED = (process.env.LEARNING_ENABLED ?? 'true') !== 'false';
const LEARNING_BATCH_SIZE = parseInt(process.env.LEARNING_BATCH_SIZE || '20', 10);
const LEARNING_SWEEP_INTERVAL_MINUTES = parseInt(process.env.LEARNING_SWEEP_INTERVAL_MINUTES || '10', 10);
const LEARNING_MIN_SWEEP_SIZE = 3;

// Speicherdeckel: Channels mit weniger als LEARNING_MIN_SWEEP_SIZE Nachrichten werden nie
// geflusht und bleiben sonst dauerhaft im Speicher liegen - bei vielen (auch stillen) Channels
// waechst die Map also unbegrenzt. Ist der Deckel erreicht, fliegt der aelteste Eintrag raus
// (Map behaelt Einfuegereihenfolge). Pro Channel ist die Groesse bereits durch
// LEARNING_BATCH_SIZE begrenzt, da dann automatisch geflusht wird.
const MAX_LEARNING_CHANNELS = 200;

// channelId -> { guildId, messages: [{authorId, authorName, content}] }
const learningBuffers = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

// 'ready' ist ab discord.js v14.22 deprecated (heisst in v15 nur noch 'clientReady').
client.once('clientReady', () => {
  console.log(`Eingeloggt als ${client.user.tag}`);
});

// ---- Nachrichten-Handler: antwortet nur bei Mention/Reply, sammelt sonst fuers passive Lernen ----
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return; // DMs laufen ueber /ask, da Mention/Reply-Erkennung dort nicht sinnvoll ist

  const isMentioned = message.mentions.has(client.user.id);

  let isReplyToBot = false;
  if (message.reference?.messageId) {
    try {
      const referenced = await message.channel.messages.fetch(message.reference.messageId);
      isReplyToBot = referenced.author.id === client.user.id;
    } catch {
      // referenzierte Nachricht evtl. geloescht, ignorieren
    }
  }

  if (!isMentioned && !isReplyToBot) {
    if (LEARNING_ENABLED) bufferForPassiveLearning(message);
    return;
  }

  await message.channel.sendTyping();

  try {
    // Falls das clientseitige Limit gerade ausgeschoepft ist: kurz Bescheid geben,
    // statt den User im Ungewissen zu lassen wann/ob eine Antwort kommt.
    if (rateLimiter.remaining() === 0) {
      await message.reply(
        statusEmbed("Lots of requests right now, I need to wait a sec (rate limit). Reply's coming up...")
      );
    }
    await rateLimiter.acquire();
    // Typing-Indikator haelt nur ~10s, nach dem Warten nochmal auffrischen
    await message.channel.sendTyping();

    // Kurzzeit-Kontext: letzte N Nachrichten im Channel VOR der aktuellen, live von Discord
    const fetched = await message.channel.messages.fetch({
      limit: SHORT_TERM_CONTEXT_LIMIT,
      before: message.id
    });

    const shortTermMessages = [...fetched.values()]
      .reverse() // chronologisch aufsteigend
      .map((m) => ({
        authorName: m.member?.displayName || m.author.username,
        content: cleanContent(m, client.user.id),
        isBot: m.author.id === client.user.id
      }));

    // Aktuelle Nachricht saeubern (Mention rausfiltern)
    const currentUserMessage = cleanContent(message, client.user.id) || '(keine Textnachricht)';
    const currentUserName = message.member?.displayName || message.author.username;

    // User-Gedaechtnis (serveruebergreifend) + Server-Gedaechtnis (nur dieser Server)
    const userMemories = getUserMemories(message.author.id);
    const serverMemories = getGuildMemories(message.guild.id);

    const { reply, newUserMemories, newServerMemories } = await askGemini({
      persona: BOT_PERSONA,
      shortTermMessages,
      userMemories,
      serverMemories,
      currentUserName,
      currentUserMessage
    });

    for (const mem of newUserMemories) {
      addUserMemory(message.author.id, mem);
    }
    for (const mem of newServerMemories) {
      addGuildMemory(message.guild.id, mem);
    }

    if (reply === GENERIC_FALLBACK_REPLY) {
      await message.reply(statusEmbed(reply));
    } else {
      await sendChunked(message, reply);
    }
  } catch (err) {
    if (err instanceof GeminiRateLimitError) {
      console.warn('Gemini Rate Limit erreicht:', err.message);
      await message.reply(statusEmbed(formatRateLimitMessage(err)));
      return;
    }

    console.error('Fehler beim Verarbeiten der Nachricht:', err);
    await message.reply(statusEmbed('Oops, something went wrong while thinking. Check the logs.'));
  }
});

/**
 * Sammelt eine nicht an den Bot gerichtete Nachricht fuer das spaetere gebatchte
 * Lernen und stoesst einen Flush an, sobald der Batch voll ist (siehe Sweep-Timer
 * weiter unten fuer den Fall, dass ein Channel nie volle Batches erreicht).
 */
function bufferForPassiveLearning(message) {
  const content = cleanContent(message, client.user.id);
  if (!content) return;

  const channelId = message.channel.id;
  let entry = learningBuffers.get(channelId);
  if (!entry) {
    if (learningBuffers.size >= MAX_LEARNING_CHANNELS) {
      const oldestChannelId = learningBuffers.keys().next().value;
      learningBuffers.delete(oldestChannelId);
    }
    entry = { guildId: message.guild.id, messages: [] };
    learningBuffers.set(channelId, entry);
  }
  entry.messages.push({
    authorId: message.author.id,
    authorName: message.member?.displayName || message.author.username,
    content
  });

  if (entry.messages.length >= LEARNING_BATCH_SIZE) {
    flushLearningBuffer(channelId);
  }
}

/**
 * Schickt den gesammelten Batch eines Channels an Gemini zur Fakten-Extraktion
 * und speichert die gefundenen User- und Server-Memories. Teilt sich den Rate
 * Limiter mit der Live-Antwort, damit das Gesamtbudget nicht ueberschritten wird.
 */
async function flushLearningBuffer(channelId) {
  const entry = learningBuffers.get(channelId);
  if (!entry || entry.messages.length === 0) return;
  learningBuffers.delete(channelId);

  try {
    await rateLimiter.acquire();
    const { userMemories, serverMemories } = await extractMemories({ persona: BOT_PERSONA, messages: entry.messages });
    for (const { userId, content } of userMemories) {
      addUserMemory(userId, content);
    }
    for (const content of serverMemories) {
      addGuildMemory(entry.guildId, content);
    }
  } catch (err) {
    console.error(`Fehler beim passiven Lernen (Channel ${channelId}):`, err);
  }
}

// Sicherheitsnetz fuer Channels, die nie LEARNING_BATCH_SIZE erreichen: alle X Minuten
// werden kleinere, aber nicht winzige Batches trotzdem geflusht, damit nichts ewig liegen bleibt.
if (LEARNING_ENABLED) {
  setInterval(() => {
    for (const [channelId, entry] of learningBuffers) {
      if (entry.messages.length >= LEARNING_MIN_SWEEP_SIZE) {
        flushLearningBuffer(channelId);
      }
    }
  }, LEARNING_SWEEP_INTERVAL_MINUTES * 60_000);
}

// ---- Slash Commands ----
client.on('interactionCreate', async (interaction) => {
  try {
    await routeInteraction(interaction);
  } catch (err) {
    // Ohne diesen Catch wird aus jedem Fehler hier eine unhandled rejection, und Node beendet
    // den Prozess dann standardmaessig - ein einzelner kaputter Command haette also nicht nur
    // sich selbst, sondern den ganzen Bot mitgenommen.
    console.error('Fehler beim Verarbeiten einer Interaction:', err);
    await safeRespond(interaction, statusEmbed('Oops, something went wrong. Check the logs.'));
  }
});

/**
 * Verteilt eine Interaction auf den passenden Handler. Darf absichtlich nach oben durchwerfen -
 * der Catch im Listener macht daraus eine Nachricht an den User statt eines Prozess-Endes.
 */
async function routeInteraction(interaction) {
  if (interaction.isButton()) {
    await handleMemoryPaginationButton(interaction);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    const sent = await interaction.reply({ ...statusEmbed('Measuring latency...'), fetchReply: true });
    const roundtripMs = sent.createdTimestamp - interaction.createdTimestamp;
    const wsPing = Math.round(client.ws.ping);
    await interaction.editReply(statusEmbed(`🏓 Pong! Response time: ${roundtripMs}ms, gateway ping: ${wsPing}ms`));
    return;
  }

  if (interaction.commandName === 'ask') {
    await handleAskCommand(interaction);
    return;
  }

  if (interaction.commandName !== 'memory') return;

  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  if (group === 'admin') {
    if (!TRUSTED_USER_IDS.has(userId)) {
      await interaction.reply({ ...statusEmbed("You don't have permission for that."), ephemeral: true });
      return;
    }

    // Server-Erinnerungen brauchen zwingend einen Server-Kontext (nicht in DMs nutzbar).
    if ((sub === 'list-server' || sub === 'forget-server' || sub === 'add-server') && !guildId) {
      await interaction.reply({ ...statusEmbed('Server memories only exist on a server, not in DMs.'), ephemeral: true });
      return;
    }

    if (sub === 'list-user') {
      const target = interaction.options.getUser('user', true);
      const memories = getUserMemories(target.id, 200);
      if (memories.length === 0) {
        await interaction.reply({ ...statusEmbed(`No memories about ${target.tag}.`), ephemeral: true });
        return;
      }
      const page = buildMemoryPage({ mode: 'user', targetUserId: target.id, page: 0, entries: memories });
      await interaction.reply({ ...page, flags: page.flags | MessageFlags.Ephemeral });
    }

    if (sub === 'list-server') {
      const memories = getGuildMemories(guildId, 200);
      if (memories.length === 0) {
        await interaction.reply({ ...statusEmbed('No server memories on this server.'), ephemeral: true });
        return;
      }
      const page = buildMemoryPage({ mode: 'server', page: 0, entries: memories });
      await interaction.reply({ ...page, flags: page.flags | MessageFlags.Ephemeral });
    }

    if (sub === 'forget-user') {
      const id = interaction.options.getInteger('id', true);
      const deleted = deleteUserMemoryAdmin(id);
      await interaction.reply({
        ...statusEmbed(deleted ? `Memory \`${id}\` deleted.` : `No memory found with ID \`${id}\`.`),
        ephemeral: true
      });
    }

    if (sub === 'forget-server') {
      const id = interaction.options.getInteger('id', true);
      const deleted = deleteGuildMemory(id, guildId);
      await interaction.reply({
        ...statusEmbed(deleted ? `Memory \`${id}\` deleted.` : `No memory found with ID \`${id}\`.`),
        ephemeral: true
      });
    }

    if (sub === 'add-user') {
      const target = interaction.options.getUser('user', true);
      const content = interaction.options.getString('content', true);
      addUserMemory(target.id, content);
      await interaction.reply({ ...statusEmbed(`Memory saved for ${target.tag} (cross-server).`), ephemeral: true });
    }

    if (sub === 'add-server') {
      const content = interaction.options.getString('content', true);
      addGuildMemory(guildId, content);
      await interaction.reply({ ...statusEmbed('Server memory saved.'), ephemeral: true });
    }

    return;
  }

  if (sub === 'list') {
    const memories = getUserMemories(userId, 25);
    if (memories.length === 0) {
      await interaction.reply({ ...statusEmbed("I don't currently remember anything about you."), ephemeral: true });
      return;
    }
    // Budget minus Trennzeichen: 25 Eintraege durchschnittlicher Laenge reissen die 4096
    // Zeichen der Embed-Description sonst muehelos, und der Command wirft statt zu antworten.
    const list = renderMemoryLines(memories, EMBED_DESCRIPTION_LIMIT - memories.length).join('\n');
    await interaction.reply({ ...statusEmbed(list, 'What I remember about you (cross-server)'), ephemeral: true });
  }

  if (sub === 'forget') {
    const id = interaction.options.getInteger('id', true);
    const deleted = deleteUserMemory(id, userId);
    await interaction.reply({
      ...statusEmbed(deleted ? `Memory \`${id}\` deleted.` : `No memory found with ID \`${id}\`.`),
      ephemeral: true
    });
  }

  if (sub === 'clear') {
    const count = clearUserMemories(userId);
    await interaction.reply({ ...statusEmbed(`Deleted ${count} ${count === 1 ? 'memory' : 'memories'}.`), ephemeral: true });
  }
}

/**
 * Behandelt Klicks auf die Vor/Zurueck-Buttons der /memory admin Listen (Components V2).
 * Die Seite wird bei jedem Klick frisch aus der DB geladen, es wird kein Zustand
 * zwischen Klicks im Speicher gehalten - der Button-customId traegt alles Noetige.
 */
async function handleMemoryPaginationButton(interaction) {
  const parsed = parseMemoryButtonId(interaction.customId);
  if (!parsed) return;

  if (!TRUSTED_USER_IDS.has(interaction.user.id)) {
    await interaction.reply({ ...statusEmbed("You don't have permission for that."), ephemeral: true });
    return;
  }

  const { mode, targetUserId, page } = parsed;
  const entries = mode === 'server' ? getGuildMemories(interaction.guildId, 200) : getUserMemories(targetUserId, 200);

  await interaction.update(buildMemoryPage({ mode, targetUserId, page, entries }));
}

/**
 * Slash-Command-Alternative zu Mention/Reply - funktioniert ueberall (User-Install),
 * auch in DMs und auf Servern, wo der Bot nicht als Mitglied drin ist. Ohne Kurzzeit-
 * Kontext aus dem Channel-Verlauf (in DMs/fremden Servern nicht sinnvoll verfuegbar),
 * aber mit User-Gedaechtnis und - falls auf einem Server ausgefuehrt - Server-Gedaechtnis.
 */
async function handleAskCommand(interaction) {
  const question = interaction.options.getString('question', true);
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const userName = interaction.member?.displayName || interaction.user.username;

  await interaction.deferReply();

  try {
    await rateLimiter.acquire();

    const userMemories = getUserMemories(userId);
    const serverMemories = guildId ? getGuildMemories(guildId) : [];

    const { reply, newUserMemories, newServerMemories } = await askGemini({
      persona: BOT_PERSONA,
      shortTermMessages: [],
      userMemories,
      serverMemories,
      currentUserName: userName,
      currentUserMessage: question
    });

    for (const mem of newUserMemories) {
      addUserMemory(userId, mem);
    }
    if (guildId) {
      for (const mem of newServerMemories) {
        addGuildMemory(guildId, mem);
      }
    }

    if (reply === GENERIC_FALLBACK_REPLY) {
      await interaction.editReply(statusEmbed(reply));
    } else {
      await sendChunkedReply(interaction, reply);
    }
  } catch (err) {
    if (err instanceof GeminiRateLimitError) {
      console.warn('Gemini Rate Limit erreicht:', err.message);
      await interaction.editReply(statusEmbed(formatRateLimitMessage(err)));
      return;
    }

    console.error('Fehler beim Verarbeiten von /ask:', err);
    await interaction.editReply(statusEmbed('Oops, something went wrong while thinking. Check the logs.'));
  }
}

/**
 * Baut eine ehrliche Rate-Limit-Nachricht. Bei Tageslimit ist Googles mitgelieferter
 * retryDelay (oft nur ein paar Sekunden) irrefuehrend - das Kontingent ist trotzdem erst
 * am naechsten Tag wieder da, egal wie kurz man wartet.
 */
function formatRateLimitMessage(err) {
  if (err.isDailyQuota) {
    const limitHint = err.dailyQuotaLimit ? ` (currently ${err.dailyQuotaLimit} requests/day on the free tier for this model)` : '';
    return (
      `Gemini's daily quota is used up for today${limitHint}. ` +
      "It only resets once Google's day rolls over (midnight Pacific Time) - " +
      'waiting a bit and trying again will not help. Check the live status at ' +
      'https://aistudio.google.com/rate-limit, or switch GEMINI_MODEL, or upgrade to a paid tier.'
    );
  }

  const waitHint = err.retryAfterSeconds
    ? ` Google says it should work again in about ${err.retryAfterSeconds}s.`
    : ' Try again in a minute or two.';
  return `Gemini is busy right now (rate limit reached).${waitHint}`;
}

/**
 * Wie sendChunked, nur fuer Interaction-Replies (editReply fuer den ersten Teil,
 * followUp fuer den Rest, statt message.reply/channel.send).
 */
async function sendChunkedReply(interaction, text) {
  const chunks = chunkText(text);
  await interaction.editReply(chunks[0]);
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp(chunks[i]);
  }
}

/**
 * Entfernt die Bot-Mention (<@id> / <@!id>) aus dem Nachrichtentext.
 */
function cleanContent(message, botId) {
  return message.content
    .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
    .trim();
}

/**
 * Discord-Nachrichten sind auf 2000 Zeichen begrenzt - lange Antworten aufteilen.
 */
async function sendChunked(message, text) {
  const chunks = chunkText(text);
  for (let i = 0; i < chunks.length; i++) {
    if (i === 0) {
      await message.reply(chunks[i]);
    } else {
      await message.channel.send(chunks[i]);
    }
  }
}

/**
 * Meldet einen Fehler an den User zurueck, ohne selbst zu werfen. Ob die Interaction schon
 * beantwortet ist, entscheidet ueber reply vs. followUp - und schlaegt auch das fehl (Token
 * abgelaufen, Interaction unbekannt), bleibt es beim Log.
 */
async function safeRespond(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    console.error('Konnte dem User den Fehler nicht melden:', err);
  }
}

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('Login bei Discord fehlgeschlagen:', err);
  process.exit(1);
});
