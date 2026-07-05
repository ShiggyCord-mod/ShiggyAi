const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

/**
 * Eigener Error-Typ fuer den Fall, dass Gemini selbst mit 429 antwortet
 * (z.B. weil das clientseitige Limit nicht zum echten Google-Limit passt,
 * oder das Tageslimit erreicht ist). So kann index.js gezielt darauf reagieren.
 */
export class GeminiRateLimitError extends Error {
  constructor(message, { retryAfterSeconds = null, isDailyQuota = false, dailyQuotaLimit = null } = {}) {
    super(message);
    this.name = 'GeminiRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
    // Bei Tageslimit ist der von Google mitgelieferte retryDelay (meist nur ein paar Sekunden)
    // irrefuehrend - der eigentliche Grund (Tageskontingent leer) loest sich dadurch nicht auf.
    this.isDailyQuota = isDailyQuota;
    this.dailyQuotaLimit = dailyQuotaLimit;
  }
}

/**
 * Baut den System-Prompt zusammen: Persona (global, enthaelt nie persoenliche Daten),
 * User-Memories (serveruebergreifend fuer diesen einen User) und Server-Memories
 * (gemeinsam fuer alle User auf diesem einen Server - leer/nicht vorhanden in DMs).
 */
function buildSystemInstruction(persona, userMemories, serverMemories) {
  let text = persona + '\n\n';

  text +=
    'Du befindest dich in einem Discord-Channel. Der Chatverlauf wird dir als Konversation gegeben, ' +
    'wobei jede User-Nachricht mit "Username: " beginnt, damit du unterscheiden kannst wer was gesagt hat.\n\n';

  if (userMemories.length > 0) {
    text +=
      'Das merkst du dir bereits ueber den User, mit dem du gerade sprichst (gilt serveruebergreifend, auch in ' +
      'DMs und auf anderen Servern). Diese Punkte sind bereits bestaetigte, gesicherte Fakten - widersprich ' +
      'ihnen nicht und leugne sie nicht, auch wenn sie ungewoehnlich oder scherzhaft klingen:\n';
    for (const mem of userMemories) {
      text += `- ${mem.content}\n`;
    }
    text += '\n';
  }

  if (serverMemories.length > 0) {
    text +=
      'Das merkst du dir bereits ueber DIESEN Server - gilt fuer alle User hier, nicht nur fuer den, mit dem du ' +
      'gerade sprichst, und nicht auf anderen Servern:\n';
    for (const mem of serverMemories) {
      text += `- ${mem.content}\n`;
    }
    text += '\n';
  }

  text +=
    'Antworte IMMER ausschliesslich mit validem JSON in genau diesem Format:\n' +
    '{"reply": "deine Antwort an den User", "new_user_memories": ["neue Fakten ueber DIESEN User"], ' +
    '"new_server_memories": ["neue Fakten ueber DIESEN Server, die fuer alle hier gelten"]}\n\n' +
    'Nutze new_user_memories NUR fuer wirklich dauerhaft relevante Fakten ueber DIESEN einen User (Vorlieben, ' +
    'Projekte, wiederkehrende Themen, persoenliche Infos die er preisgibt, auch eine von ihm behauptete Beziehung ' +
    'zu dir) - diese Fakten gelten serveruebergreifend fuer ihn, also KEINE serverspezifischen Details hier rein. ' +
    'Nutze new_server_memories NUR fuer Fakten ueber den Server/die Community als Ganzes (z.B. Thema des Servers, ' +
    'gemeinsame Regeln, wiederkehrende Server-Events) - niemals persoenliche Fakten ueber einzelne User hier rein. ' +
    'Formuliere neue Erinnerungen immer neutral in der 3. Person (z.B. "behauptet, mit dir verheiratet zu sein"), ' +
    'nicht direkt an ihn/dich adressiert (also nicht "Du bist mit mir verheiratet"). ' +
    'Fuer normale Konversation gib jeweils ein leeres Array zurueck. ' +
    'Erfinde niemals Fakten und wiederhole keine Erinnerung, die du oben schon kennst.';

  return text;
}

/**
 * Wandelt die Discord-Nachrichten in das Gemini "contents" Format um.
 * @param {Array<{authorName: string, content: string, isBot: boolean}>} shortTermMessages - chronologisch aufsteigend
 * @param {string} currentUserName
 * @param {string} currentUserMessage
 */
function buildContents(shortTermMessages, currentUserName, currentUserMessage) {
  const contents = [];

  for (const msg of shortTermMessages) {
    if (!msg.content?.trim()) continue;
    contents.push({
      role: msg.isBot ? 'model' : 'user',
      parts: [{ text: msg.isBot ? msg.content : `${msg.authorName}: ${msg.content}` }]
    });
  }

  contents.push({
    role: 'user',
    parts: [{ text: `${currentUserName}: ${currentUserMessage}` }]
  });

  return contents;
}

/**
 * Gemeinsamer Gemini-Call fuer JSON-strukturierte Antworten. Wirft GeminiRateLimitError
 * bei 429, sonst einen normalen Error bei anderen HTTP-Fehlern.
 * @returns {Promise<string>} der rohe Text der Antwort (noch nicht geparst)
 */
async function callGemini({ systemInstruction, contents, responseSchema, temperature }) {
  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema,
      temperature
    }
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();

    if (res.status === 429) {
      // Google gibt manchmal einen retryDelay im Fehlerbody mit (z.B. "retryDelay": "23s") -
      // der ist aber nur ein generischer Backoff-Hinweis und bei Tageslimit irrefuehrend kurz
      // (das Kontingent ist trotzdem erst am naechsten Tag wieder da). quotaId verraet, welcher
      // der beiden Faelle vorliegt (z.B. "GenerateRequestsPerDayPerProjectPerModel-FreeTier").
      const retryMatch = errText.match(/"retryDelay":\s*"(\d+)s"/);
      const retryAfterSeconds = retryMatch ? parseInt(retryMatch[1], 10) : null;

      const quotaIdMatch = errText.match(/"quotaId":\s*"([^"]+)"/);
      const isDailyQuota = /PerDay/i.test(quotaIdMatch?.[1] ?? '');

      const quotaValueMatch = errText.match(/"quotaValue":\s*"(\d+)"/);
      const dailyQuotaLimit = isDailyQuota && quotaValueMatch ? parseInt(quotaValueMatch[1], 10) : null;

      throw new GeminiRateLimitError(errText, { retryAfterSeconds, isDailyQuota, dailyQuotaLimit });
    }

    throw new Error(`Gemini API Fehler (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!rawText) {
    throw new Error('Gemini hat keine verwertbare Antwort geliefert.');
  }

  return rawText;
}

/**
 * Fragt Gemini nach einer Antwort.
 * @returns {Promise<{reply: string, newUserMemories: string[], newServerMemories: string[]}>}
 */
export async function askGemini({ persona, shortTermMessages, userMemories, serverMemories, currentUserName, currentUserMessage }) {
  const systemInstruction = buildSystemInstruction(persona, userMemories, serverMemories);
  const contents = buildContents(shortTermMessages, currentUserName, currentUserMessage);

  const rawText = await callGemini({
    systemInstruction,
    contents,
    responseSchema: {
      type: 'OBJECT',
      properties: {
        reply: { type: 'STRING' },
        new_user_memories: { type: 'ARRAY', items: { type: 'STRING' } },
        new_server_memories: { type: 'ARRAY', items: { type: 'STRING' } }
      },
      required: ['reply']
    },
    temperature: 0.8
  });

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    // Fallback: falls trotz responseSchema mal kein sauberes JSON zurueckkommt
    return { reply: rawText, newUserMemories: [], newServerMemories: [] };
  }

  return {
    reply: parsed.reply ?? '(keine Antwort)',
    newUserMemories: Array.isArray(parsed.new_user_memories) ? parsed.new_user_memories : [],
    newServerMemories: Array.isArray(parsed.new_server_memories) ? parsed.new_server_memories : []
  };
}

/**
 * Extrahiert Langzeit-Erinnerungen aus einem Batch NICHT direkt an den Bot gerichteter
 * Channel-Nachrichten (passives Lernen im Hintergrund, koennen mehrere User sein).
 * Unterscheidet wie askGemini zwischen User- und Server-Fakten.
 * @param {{persona: string, messages: Array<{authorId: string, authorName: string, content: string}>}} args
 * @returns {Promise<{userMemories: Array<{userId: string, content: string}>, serverMemories: string[]}>}
 */
export async function extractMemories({ persona, messages }) {
  const systemInstruction =
    persona +
    '\n\n' +
    'Du liest hier passiv einen Ausschnitt aus einem Discord-Channel mit - diese Nachrichten waren NICHT an dich ' +
    'gerichtet. Jede Zeile hat das Format "UserID <id> (<name>): <text>". Ziel ist es, dir zwei Arten von Fakten ' +
    'zu merken: (1) user_memories - dauerhaft relevante Fakten UEBER EINZELNE User (Vorlieben, Projekte, ' +
    'persoenliche Infos), serveruebergreifend gueltig - nutze dafuer IMMER exakt die angegebene UserID der Zeile, ' +
    'aus der der Fakt stammt; (2) server_memories - Fakten UEBER DEN SERVER/DIE COMMUNITY als Ganzes (Thema des ' +
    'Servers, gemeinsame Regeln, wiederkehrende Events), nicht an eine UserID gebunden. ' +
    'Formuliere jeden Fakt neutral in der 3. Person. Gib NUR wirklich merkenswerte, neue Fakten zurueck - fuer ' +
    'normalen Chat/Small-Talk gib leere Arrays zurueck. Erfinde niemals Fakten.';

  const transcript = messages.map((m) => `UserID ${m.authorId} (${m.authorName}): ${m.content}`).join('\n');

  const rawText = await callGemini({
    systemInstruction,
    contents: [{ role: 'user', parts: [{ text: transcript }] }],
    responseSchema: {
      type: 'OBJECT',
      properties: {
        user_memories: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              user_id: { type: 'STRING' },
              content: { type: 'STRING' }
            },
            required: ['user_id', 'content']
          }
        },
        server_memories: { type: 'ARRAY', items: { type: 'STRING' } }
      },
      required: ['user_memories', 'server_memories']
    },
    temperature: 0.4
  });

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    return { userMemories: [], serverMemories: [] };
  }

  const userMemories = Array.isArray(parsed.user_memories)
    ? parsed.user_memories
        .filter((m) => m && typeof m.user_id === 'string' && typeof m.content === 'string' && m.content.trim())
        .map((m) => ({ userId: m.user_id, content: m.content.trim() }))
    : [];

  const serverMemories = Array.isArray(parsed.server_memories)
    ? parsed.server_memories.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim())
    : [];

  return { userMemories, serverMemories };
}
