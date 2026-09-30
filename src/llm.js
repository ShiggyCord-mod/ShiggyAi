const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL;

// Provider-neutral gehalten: alles hier spricht die OpenAI-kompatible Chat-Completions-API,
// ein Wechsel des Anbieters ist damit reine .env-Arbeit. Default ist CodeCraft
// (https://codecraftapi.com/v1), Auth per Bearer-Token - der Key landet also nicht in der URL.
const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'https://codecraftapi.com/v1').replace(/\/+$/, '');
const API_URL = `${LLM_BASE_URL}/chat/completions`;

// Nur fuer Reasoning-Modelle relevant und nicht von jedem Endpoint akzeptiert, deshalb
// standardmaessig NICHT mitgeschickt. Wer ein Reasoning-Modell nutzt, setzt z.B.
// LLM_REASONING_EFFORT=low - der Bot schreibt kurze Chat-Antworten, viel Reasoning kostet
// hier nur Latenz und Token-Budget.
const REASONING_EFFORT = process.env.LLM_REASONING_EFFORT || '';

// Sicherheitsnetz gegen ausufernde/kaputte Antworten (siehe Vorfall: Modell generierte endlos
// fast-identische Memory-Strings bis zum impliziten Token-Limit -> riesige, nicht parsbare
// Antwort, die roh in Discord landete). Bewusst interne Konstanten statt .env-Variablen: das ist
// ein Sicherheits-Invariant, kein Tuning-Knopf, den man versehentlich zu hoch drehen koennen sollte.
const MAX_OUTPUT_TOKENS_REPLY = 2048; // askLlm: Chat-Reply + ein paar kurze Memory-Strings
const MAX_OUTPUT_TOKENS_EXTRACT = 1024; // extractMemories: kein Freitext-Reply noetig
export const MAX_MEMORY_ITEMS = 5; // askLlm: neue Memories pro Antwort
const MAX_MEMORY_ITEMS_BATCH = 20; // extractMemories: Batch kann mehrere User betreffen
export const MAX_MEMORY_LENGTH = 300; // max. Zeichen pro Memory-Eintrag
const MAX_LOG_TEXT_LENGTH = 500; // Rohtext-Logging bei Parse-Fehlern deckeln
export const GENERIC_FALLBACK_REPLY =
  'Oops, I got a broken response. Try again, or phrase your question a bit differently.';

// Structured Outputs mit strict:true (das Schema wird beim Decoding erzwungen) koennen laengst
// nicht alle OpenAI-kompatiblen Endpoints - viele beherrschen nur den schwaecheren json_object-
// Modus, der zwar valides JSON garantiert, aber nicht die Form. Welcher Fall vorliegt, sagt einem
// erst ein echter Request: beim ersten passenden 400 wird einmal heruntergestuft und das gemerkt,
// statt es bei jedem Call erneut zu versuchen. Das Parsing unten ist ohnehin tolerant genug,
// um mit unerzwungener Form klarzukommen, und die Form steht zusaetzlich im System-Prompt.
const SCHEMA_UNSUPPORTED_PATTERN = /json_schema|response_format|structured|schema/i;
let structuredOutputMode = 'json_schema';

/** Nur fuer Tests: der heruntergestufte Modus ist Modulzustand und ueberlebt sonst jeden Testfall. */
export function resetStructuredOutputMode() {
  structuredOutputMode = 'json_schema';
}

/** Welcher Structured-Output-Modus gerade aktiv ist ('json_schema' oder 'json_object'). */
export function getStructuredOutputMode() {
  return structuredOutputMode;
}

// Jeder HTTP-Versuch an die API wird hier gemeldet - auch der fehlgeschlagene erste Versuch
// einer Herabstufung, damit die Token-Abrechnung im Dashboard ehrlich bleibt. Absichtlich ein
// Hook statt eines direkten Imports der Log-Schicht: llm.js bleibt damit frei von
// DB-Abhaengigkeiten und in Tests ohne Datenbank pruefbar.
let callRecorder = null;

/** @param {((entry: object) => void) | null} fn */
export function setCallRecorder(fn) {
  callRecorder = fn;
}

function record(entry) {
  if (!callRecorder) return;
  try {
    callRecorder(entry);
  } catch (err) {
    // Protokollieren darf den Bot nie umbringen.
    console.error('Konnte den API-Call nicht protokollieren:', err);
  }
}

/**
 * Eigener Error-Typ fuer den Fall, dass die API selbst mit 429 antwortet (z.B. weil das
 * clientseitige Limit nicht zum echten Limit des Anbieters passt, oder ein Tageskontingent
 * erreicht ist). So kann index.js gezielt darauf reagieren.
 */
export class LlmRateLimitError extends Error {
  constructor(message, { retryAfterSeconds = null, isDailyQuota = false, dailyQuotaLimit = null } = {}) {
    super(message);
    this.name = 'LlmRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
    // Bei Tageslimit ist ein kurzer Retry-Hinweis irrefuehrend - das Kontingent ist erst wieder
    // da, wenn das Tagesfenster rollt, egal wie kurz man wartet.
    this.isDailyQuota = isDailyQuota;
    this.dailyQuotaLimit = dailyQuotaLimit;
  }
}

/**
 * 402 heisst: das Kontingent des Accounts ist erschoepft bzw. das Modell verlangt einen
 * bezahlten Plan. Anders als ein 429 loest sich das nicht durch Warten, und es ist auch kein
 * Fehler im Bot - es muss jemand im Dashboard des Anbieters aktiv werden. Eigener Typ, damit
 * index.js das klar sagen kann statt "irgendwas ist schiefgelaufen, schau in die Logs".
 */
export class LlmBillingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LlmBillingError';
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
    'Erfinde niemals Fakten und wiederhole keine Erinnerung, die du oben schon kennst. ' +
    'Halte new_user_memories und new_server_memories IMMER kurz: hoechstens ein paar (max. 5) ' +
    'praegnante Ein-Satz-Fakten pro Antwort, keine langen Aufzaehlungen oder Wiederholungen.';

  return text;
}

/**
 * Wandelt die Discord-Nachrichten in das OpenAI-kompatible "messages" Format um.
 * Der System-Prompt wird vom Aufrufer als erste Nachricht davorgesetzt.
 * @param {Array<{authorName: string, content: string, isBot: boolean}>} shortTermMessages - chronologisch aufsteigend
 * @param {string} currentUserName
 * @param {string} currentUserMessage
 */
function buildConversation(shortTermMessages, currentUserName, currentUserMessage) {
  const messages = [];

  for (const msg of shortTermMessages) {
    if (!msg.content?.trim()) continue;
    messages.push({
      role: msg.isBot ? 'assistant' : 'user',
      content: msg.isBot ? msg.content : `${msg.authorName}: ${msg.content}`
    });
  }

  messages.push({ role: 'user', content: `${currentUserName}: ${currentUserMessage}` });

  return messages;
}

/**
 * Liest den Antworttext aus einer Chat-Completion. `content` ist laut Schema ein String
 * oder ein Array von Text-Parts (und bei Reasoning-Modellen theoretisch null, wenn nur
 * `reasoning` befuellt ist) - alle drei Faelle hier abfangen.
 */
function extractContent(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : (part?.text ?? ''))).join('');
  }
  return '';
}

/**
 * Baut aus einer 429-Antwort einen LlmRateLimitError. OpenAI-kompatible APIs liefern
 * ueblicherweise `x-ratelimit-*`-Header pro Zeitfenster mit, garantiert ist das aber nicht.
 * Deshalb gestaffelt: erst Header, dann Fehlertext als Fallback - fehlt beides, bleibt es
 * bei null (index.js formuliert dann eine allgemeine Nachricht).
 */
function buildRateLimitError(res, errText) {
  const header = (name) => res.headers?.get?.(name) ?? null;
  const num = (value) => {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? Math.ceil(parsed) : null;
  };

  const dayRemaining = header('x-ratelimit-remaining-requests-day') ?? header('x-ratelimit-remaining-tokens-day');
  const isDailyQuota =
    num(dayRemaining) === 0 || /per[-_ ]?day|daily|tokens_per_day|requests_per_day/i.test(errText);

  const dailyQuotaLimit = isDailyQuota ? num(header('x-ratelimit-limit-requests-day')) : null;

  const retryAfterSeconds =
    num(header('retry-after')) ??
    num(header('x-ratelimit-reset-requests-minute')) ??
    num(header('x-ratelimit-reset-tokens-minute')) ??
    num(errText.match(/"retry_after(?:_seconds)?":\s*"?(\d+(?:\.\d+)?)"?/)?.[1]);

  return new LlmRateLimitError(errText, { retryAfterSeconds, isDailyQuota, dailyQuotaLimit });
}

function buildResponseFormat(mode, schemaName, responseSchema) {
  if (mode === 'json_schema') {
    return { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema: responseSchema } };
  }
  return { type: 'json_object' };
}

/**
 * Gemeinsamer Call fuer JSON-strukturierte Antworten. Wirft LlmRateLimitError bei 429,
 * LlmBillingError bei 402, sonst einen normalen Error bei anderen HTTP-Fehlern.
 * @returns {Promise<string>} der rohe Text der Antwort (noch nicht geparst)
 */
async function callLlm({ kind, systemInstruction, messages, schemaName, responseSchema, temperature, maxOutputTokens }) {
  if (!LLM_API_KEY) {
    throw new Error('LLM_API_KEY ist nicht gesetzt (siehe .env.example).');
  }
  if (!LLM_MODEL) {
    throw new Error('LLM_MODEL ist nicht gesetzt - es gibt bewusst keinen Default, da die gueltigen Model-IDs vom Anbieter abhaengen (siehe .env.example).');
  }

  const send = async (mode) => {
    const body = {
      model: LLM_MODEL,
      messages: [{ role: 'system', content: systemInstruction }, ...messages],
      temperature,
      // Bewusst max_tokens und nicht das neuere max_completion_tokens: ersteres verstehen
      // praktisch alle OpenAI-kompatiblen Endpoints, letzteres laengst nicht alle.
      max_tokens: maxOutputTokens,
      response_format: buildResponseFormat(mode, schemaName, responseSchema)
    };

    if (REASONING_EFFORT) {
      body.reasoning_effort = REASONING_EFFORT;
    }

    const startedAt = Date.now();
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLM_API_KEY}`
      },
      body: JSON.stringify(body)
    });

    return { res, body, mode, latencyMs: Date.now() - startedAt };
  };

  let attempt = await send(structuredOutputMode);
  let res = attempt.res;

  // Einmalige Herabstufung, falls der Endpoint json_schema nicht kann (siehe oben).
  if (res.status === 400 && structuredOutputMode === 'json_schema') {
    const errText = await res.text();
    recordAttempt(kind, attempt, { responseText: errText, error: `HTTP 400: ${truncateForLog(errText)}` });

    if (SCHEMA_UNSUPPORTED_PATTERN.test(errText)) {
      console.warn(
        'Endpoint lehnt json_schema ab, falle ab jetzt auf json_object zurueck. Antwort war:',
        truncateForLog(errText)
      );
      structuredOutputMode = 'json_object';
      attempt = await send(structuredOutputMode);
      res = attempt.res;
    } else {
      throw new Error(`LLM API Fehler (400): ${errText}`);
    }
  }

  if (!res.ok) {
    const errText = await res.text();
    recordAttempt(kind, attempt, { responseText: errText, error: `HTTP ${res.status}: ${truncateForLog(errText)}` });

    if (res.status === 429) {
      throw buildRateLimitError(res, errText);
    }

    if (res.status === 402) {
      throw new LlmBillingError(errText);
    }

    throw new Error(`LLM API Fehler (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const choice = data?.choices?.[0];
  const rawText = extractContent(choice?.message);

  recordAttempt(kind, attempt, {
    responseText: safeStringify(data),
    content: rawText,
    usage: data?.usage ?? null,
    finishReason: choice?.finish_reason ?? null
  });

  if (!rawText.trim()) {
    throw new Error('Die API hat keine verwertbare Antwort geliefert.');
  }

  if (choice?.finish_reason === 'length') {
    // rawText ist dann mitten im String abgeschnitten und meist kein valides JSON mehr -
    // der JSON.parse-Fallback beim Aufrufer faengt das sicher ab, das hier ist nur fuers Log.
    console.warn('Antwort erreichte max_tokens und wurde abgeschnitten (finish_reason: length).');
  }

  return rawText;
}

/** Baut einen Log-Eintrag aus Versuch plus Ergebnis und gibt ihn an den Recorder weiter. */
function recordAttempt(kind, attempt, result) {
  record({
    kind: kind ?? 'unknown',
    model: LLM_MODEL,
    structuredMode: attempt.mode,
    status: attempt.res.status ?? null,
    ok: attempt.res.ok === true,
    latencyMs: attempt.latencyMs,
    request: attempt.body,
    responseText: result.responseText ?? null,
    content: result.content ?? null,
    usage: result.usage ?? null,
    finishReason: result.finishReason ?? null,
    error: result.error ?? null
  });
}

/** Ein Response-Envelope soll das Logging nie zum Werfen bringen (z.B. bei Zyklen). */
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Fragt das Modell nach einer Antwort.
 * @returns {Promise<{reply: string, newUserMemories: string[], newServerMemories: string[]}>}
 */
export async function askLlm({ persona, shortTermMessages, userMemories, serverMemories, currentUserName, currentUserMessage }) {
  const systemInstruction = buildSystemInstruction(persona, userMemories, serverMemories);
  const messages = buildConversation(shortTermMessages, currentUserName, currentUserMessage);

  const rawText = await callLlm({
    kind: 'reply',
    systemInstruction,
    messages,
    schemaName: 'discord_reply',
    // Structured Outputs verlangen additionalProperties:false und - bei strict:true - dass
    // alle Properties in "required" stehen. Leere Memory-Arrays sind der Normalfall, das
    // Parsing unten bleibt trotzdem tolerant, falls ein Modell doch Felder weglaesst (im
    // json_object-Fallback wird die Form gar nicht erzwungen).
    responseSchema: {
      type: 'object',
      properties: {
        reply: { type: 'string' },
        new_user_memories: { type: 'array', items: { type: 'string' } },
        new_server_memories: { type: 'array', items: { type: 'string' } }
      },
      required: ['reply', 'new_user_memories', 'new_server_memories'],
      additionalProperties: false
    },
    temperature: 0.8,
    maxOutputTokens: MAX_OUTPUT_TOKENS_REPLY
  });

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    // Rohtext NIE als reply zurueckgeben - kann bei Truncation ein riesiger, kaputter Blob sein
    // (siehe Vorfall). Stattdessen eine kurze, sichere generische Antwort.
    console.error('askLlm: Antwort war kein valides JSON. Rohtext (gekuerzt):', truncateForLog(rawText));
    return { reply: GENERIC_FALLBACK_REPLY, newUserMemories: [], newServerMemories: [] };
  }

  return {
    reply: parsed.reply ?? '(keine Antwort)',
    newUserMemories: sanitizeMemoryList(parsed.new_user_memories, MAX_MEMORY_ITEMS),
    newServerMemories: sanitizeMemoryList(parsed.new_server_memories, MAX_MEMORY_ITEMS)
  };
}

function truncate(str, maxLen) {
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}

function truncateForLog(text) {
  return text.length > MAX_LOG_TEXT_LENGTH
    ? `${text.slice(0, MAX_LOG_TEXT_LENGTH)}... [gekuerzt, ${text.length} Zeichen gesamt]`
    : text;
}

function sanitizeMemoryList(list, maxItems) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => typeof m === 'string' && m.trim())
    .slice(0, maxItems)
    .map((m) => truncate(m.trim(), MAX_MEMORY_LENGTH));
}

/**
 * Extrahiert Langzeit-Erinnerungen aus einem Batch NICHT direkt an den Bot gerichteter
 * Channel-Nachrichten (passives Lernen im Hintergrund, koennen mehrere User sein).
 * Unterscheidet wie askLlm zwischen User- und Server-Fakten.
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
    'normalen Chat/Small-Talk gib leere Arrays zurueck. Erfinde niemals Fakten. ' +
    'Formuliere jeden Fakt kurz und praegnant (ein Satz) und wiederhole keinen Fakt mehrfach.\n\n' +
    // Die Form steht auch dann im Prompt, wenn json_schema aktiv ist: schadet nicht, ist aber
    // zwingend noetig, sobald auf json_object heruntergestuft wurde - dort erzwingt die API
    // nur "valides JSON", nicht die Struktur.
    'Antworte IMMER ausschliesslich mit validem JSON in genau diesem Format:\n' +
    '{"user_memories": [{"user_id": "die exakte UserID aus der Zeile", "content": "der Fakt"}], ' +
    '"server_memories": ["Fakt ueber den Server"]}';

  const transcript = messages.map((m) => `UserID ${m.authorId} (${m.authorName}): ${m.content}`).join('\n');

  const rawText = await callLlm({
    kind: 'extract',
    systemInstruction,
    messages: [{ role: 'user', content: transcript }],
    schemaName: 'extracted_memories',
    responseSchema: {
      type: 'object',
      properties: {
        user_memories: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              user_id: { type: 'string' },
              content: { type: 'string' }
            },
            required: ['user_id', 'content'],
            additionalProperties: false
          }
        },
        server_memories: { type: 'array', items: { type: 'string' } }
      },
      required: ['user_memories', 'server_memories'],
      additionalProperties: false
    },
    temperature: 0.4,
    maxOutputTokens: MAX_OUTPUT_TOKENS_EXTRACT
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
        .slice(0, MAX_MEMORY_ITEMS_BATCH)
        .map((m) => ({ userId: m.user_id, content: truncate(m.content.trim(), MAX_MEMORY_LENGTH) }))
    : [];

  const serverMemories = sanitizeMemoryList(parsed.server_memories, MAX_MEMORY_ITEMS_BATCH);

  return { userMemories, serverMemories };
}
