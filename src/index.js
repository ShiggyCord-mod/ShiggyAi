import 'dotenv/config';
import { Client, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { askGemini, extractMemories, GeminiRateLimitError } from './gemini.js';
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
import { buildMemoryPage, parseMemoryButtonId } from './pagination.js';

const BOT_PERSONA = process.env.BOT_PERSONA || 'Du bist ein hilfreicher Discord-Bot.';

// User-IDs, die /memory admin nutzen duerfen (Memories einsehen/hinzufuegen/loeschen).
const TRUSTED_USER_IDS = new Set(
  (process.env.TRUSTED_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);
const SHORT_TERM_CONTEXT_LIMIT = parseInt(process.env.SHORT_TERM_CONTEXT_LIMIT || '15', 10);
const DISCORD_MSG_LIMIT = 2000;

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

client.once('ready', () => {
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
        'Grad viele Anfragen unterwegs, ich muss kurz warten (Rate Limit). Antwort kommt gleich...'
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

    await sendChunked(message, reply);
  } catch (err) {
    if (err instanceof GeminiRateLimitError) {
      console.warn('Gemini Rate Limit erreicht:', err.message);
      await message.reply(formatRateLimitMessage(err));
      return;
    }

    console.error('Fehler beim Verarbeiten der Nachricht:', err);
    await message.reply('Ups, da ist beim Nachdenken etwas schiefgelaufen. Schau mal in die Logs.');
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
  if (interaction.isButton()) {
    await handleMemoryPaginationButton(interaction);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping') {
    const sent = await interaction.reply({ content: 'Pong! Messe Latenz...', fetchReply: true });
    const roundtripMs = sent.createdTimestamp - interaction.createdTimestamp;
    const wsPing = Math.round(client.ws.ping);
    await interaction.editReply(`🏓 Pong! Antwortzeit: ${roundtripMs}ms, Gateway-Ping: ${wsPing}ms`);
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
      await interaction.reply({ content: 'Dafuer fehlt dir die Berechtigung.', ephemeral: true });
      return;
    }

    // Server-Erinnerungen brauchen zwingend einen Server-Kontext (nicht in DMs nutzbar).
    if ((sub === 'list-server' || sub === 'forget-server' || sub === 'add-server') && !guildId) {
      await interaction.reply({ content: 'Server-Erinnerungen gibt es nur auf einem Server, nicht in DMs.', ephemeral: true });
      return;
    }

    if (sub === 'list-user') {
      const target = interaction.options.getUser('user', true);
      const memories = getUserMemories(target.id, 200);
      if (memories.length === 0) {
        await interaction.reply({ content: `Keine Erinnerungen ueber ${target.tag}.`, ephemeral: true });
        return;
      }
      const page = buildMemoryPage({ mode: 'user', targetUserId: target.id, page: 0, entries: memories });
      await interaction.reply({ ...page, flags: page.flags | MessageFlags.Ephemeral });
    }

    if (sub === 'list-server') {
      const memories = getGuildMemories(guildId, 200);
      if (memories.length === 0) {
        await interaction.reply({ content: 'Keine Server-Erinnerungen auf diesem Server.', ephemeral: true });
        return;
      }
      const page = buildMemoryPage({ mode: 'server', page: 0, entries: memories });
      await interaction.reply({ ...page, flags: page.flags | MessageFlags.Ephemeral });
    }

    if (sub === 'forget-user') {
      const id = interaction.options.getInteger('id', true);
      const deleted = deleteUserMemoryAdmin(id);
      await interaction.reply({
        content: deleted ? `Erinnerung \`${id}\` geloescht.` : `Keine Erinnerung mit ID \`${id}\` gefunden.`,
        ephemeral: true
      });
    }

    if (sub === 'forget-server') {
      const id = interaction.options.getInteger('id', true);
      const deleted = deleteGuildMemory(id, guildId);
      await interaction.reply({
        content: deleted ? `Erinnerung \`${id}\` geloescht.` : `Keine Erinnerung mit ID \`${id}\` gefunden.`,
        ephemeral: true
      });
    }

    if (sub === 'add-user') {
      const target = interaction.options.getUser('user', true);
      const content = interaction.options.getString('content', true);
      addUserMemory(target.id, content);
      await interaction.reply({ content: `Erinnerung fuer ${target.tag} gespeichert (serveruebergreifend).`, ephemeral: true });
    }

    if (sub === 'add-server') {
      const content = interaction.options.getString('content', true);
      addGuildMemory(guildId, content);
      await interaction.reply({ content: 'Server-Erinnerung gespeichert.', ephemeral: true });
    }

    return;
  }

  if (sub === 'list') {
    const memories = getUserMemories(userId, 25);
    if (memories.length === 0) {
      await interaction.reply({ content: 'Ich merke mir aktuell nichts ueber dich.', ephemeral: true });
      return;
    }
    const list = memories.map((m) => `\`${m.id}\` - ${m.content}`).join('\n');
    await interaction.reply({ content: `**Das merke ich mir ueber dich (serveruebergreifend):**\n${list}`, ephemeral: true });
  }

  if (sub === 'forget') {
    const id = interaction.options.getInteger('id', true);
    const deleted = deleteUserMemory(id, userId);
    await interaction.reply({
      content: deleted ? `Erinnerung \`${id}\` geloescht.` : `Keine Erinnerung mit ID \`${id}\` gefunden.`,
      ephemeral: true
    });
  }

  if (sub === 'clear') {
    const count = clearUserMemories(userId);
    await interaction.reply({ content: `${count} Erinnerung(en) geloescht.`, ephemeral: true });
  }
});

/**
 * Behandelt Klicks auf die Vor/Zurueck-Buttons der /memory admin Listen (Components V2).
 * Die Seite wird bei jedem Klick frisch aus der DB geladen, es wird kein Zustand
 * zwischen Klicks im Speicher gehalten - der Button-customId traegt alles Noetige.
 */
async function handleMemoryPaginationButton(interaction) {
  const parsed = parseMemoryButtonId(interaction.customId);
  if (!parsed) return;

  if (!TRUSTED_USER_IDS.has(interaction.user.id)) {
    await interaction.reply({ content: 'Dafuer fehlt dir die Berechtigung.', ephemeral: true });
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
  const question = interaction.options.getString('frage', true);
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

    await sendChunkedReply(interaction, reply);
  } catch (err) {
    if (err instanceof GeminiRateLimitError) {
      console.warn('Gemini Rate Limit erreicht:', err.message);
      await interaction.editReply(formatRateLimitMessage(err));
      return;
    }

    console.error('Fehler beim Verarbeiten von /ask:', err);
    await interaction.editReply('Ups, da ist beim Nachdenken etwas schiefgelaufen. Schau mal in die Logs.');
  }
}

/**
 * Baut eine ehrliche Rate-Limit-Nachricht. Bei Tageslimit ist Googles mitgelieferter
 * retryDelay (oft nur ein paar Sekunden) irrefuehrend - das Kontingent ist trotzdem erst
 * am naechsten Tag wieder da, egal wie kurz man wartet.
 */
function formatRateLimitMessage(err) {
  if (err.isDailyQuota) {
    const limitHint = err.dailyQuotaLimit ? ` (aktuell ${err.dailyQuotaLimit} Anfragen/Tag im Free Tier fuer dieses Modell)` : '';
    return (
      `Tageskontingent von Gemini ist fuer heute aufgebraucht${limitHint}. ` +
      'Das setzt sich erst zurueck, wenn bei Google der Tag umspringt (Mitternacht Pacific Time) - ' +
      'kurz warten und nochmal probieren bringt nichts. Aktuellen Stand siehst du live unter ' +
      'https://aistudio.google.com/rate-limit, alternativ GEMINI_MODEL wechseln oder auf ein bezahltes Tier upgraden.'
    );
  }

  const waitHint = err.retryAfterSeconds
    ? ` Google sagt, in ca. ${err.retryAfterSeconds}s geht's wieder.`
    : ' Versuchs in ein, zwei Minuten nochmal.';
  return `Gemini ist gerade ausgelastet (Rate Limit erreicht).${waitHint}`;
}

/**
 * Wie sendChunked, nur fuer Interaction-Replies (editReply fuer den ersten Teil,
 * followUp fuer den Rest, statt message.reply/channel.send).
 */
async function sendChunkedReply(interaction, text) {
  if (text.length <= DISCORD_MSG_LIMIT) {
    await interaction.editReply(text);
    return;
  }
  const chunks = text.match(new RegExp(`.{1,${DISCORD_MSG_LIMIT}}`, 'gs')) || [text];
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
  if (text.length <= DISCORD_MSG_LIMIT) {
    await message.reply(text);
    return;
  }
  const chunks = text.match(new RegExp(`.{1,${DISCORD_MSG_LIMIT}}`, 'gs')) || [text];
  for (let i = 0; i < chunks.length; i++) {
    if (i === 0) {
      await message.reply(chunks[i]);
    } else {
      await message.channel.send(chunks[i]);
    }
  }
}

client.login(process.env.DISCORD_TOKEN);
