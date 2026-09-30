# Discord LLM Bot

Discord-Bot der auf Mention oder Reply antwortet, dabei den letzten Channel-Verlauf
als Kurzzeit-Kontext nutzt und sich dauerhaft Fakten merken kann (Langzeitgedaechtnis
in SQLite). Antworten kommen von einer OpenAI-kompatiblen Chat-Completions-API,
standardmaessig [CodeCraft](https://codecraftapi.com).

Im Code steht nichts anbieterspezifisches: `src/llm.js` spricht das OpenAI-Protokoll,
ein Anbieterwechsel ist reine `.env`-Arbeit (`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`).

## Setup

### 1. Discord Application anlegen
1. Auf https://discord.com/developers/applications eine neue Application erstellen.
2. Unter "Bot" einen Bot hinzufuegen, Token kopieren.
3. Unter "Bot" -> "Privileged Gateway Intents": **MESSAGE CONTENT INTENT** aktivieren
   (sonst sieht der Bot keinen Nachrichtentext).
4. Unter "OAuth2 -> URL Generator": Scopes `bot` und `applications.commands` anhaken,
   bei Bot-Permissions mindestens `Send Messages`, `Read Message History`, `View Channel`.
   Die generierte URL nutzen um den Bot auf deinen Server einzuladen.

### 2. API Key fuer das Modell
Bei CodeCraft einen Key erzeugen (Format `cc_...`) und als `LLM_API_KEY` eintragen.

`LLM_MODEL` hat **bewusst keinen Default**, weil gueltige Model-IDs am Anbieter haengen
und ein geratener Name nur einen 400 beim ersten Request gibt. Die Liste steht unter
https://codecraftapi.com/models oder direkt aus der API:

```bash
curl -H "Authorization: Bearer $LLM_API_KEY" https://codecraftapi.com/v1/models
```

### 3. Installation

```bash
cp .env.example .env
# .env ausfuellen: DISCORD_TOKEN, CLIENT_ID, LLM_API_KEY, LLM_MODEL, optional GUILD_ID

npm install
npm run deploy-commands   # registriert die Slash-Commands
npm start
```

Mit `GUILD_ID` in der `.env` sind die Guild-Commands sofort auf deinem Server sichtbar.
`/ask` und `/ping` werden immer global registriert (sonst funktionieren sie nicht in DMs
und auf Servern, wo der Bot nicht Mitglied ist) - global kann bis zu einer Stunde dauern.

## Nutzung

**Reden:**
- `@BotName was denkst du ueber X?` oder direkt auf eine Bot-Nachricht antworten.
- **`/ask <question>`**: funktioniert ueberall, auch in DMs und auf Servern ohne den Bot
  (User-Install). Ohne Kurzzeit-Kontext aus dem Channel, aber mit Gedaechtnis.
- **`/ping`**: aktuelle Latenz.

**Eigenes Gedaechtnis verwalten:**
- **`/memory list`**: zeigt was der Bot sich ueber dich merkt (nur fuer dich sichtbar).
- **`/memory forget <id>`**: loescht eine einzelne Erinnerung.
- **`/memory clear`**: loescht alle Erinnerungen ueber dich.

**Admin (nur User-IDs aus `TRUSTED_USER_IDS`):**
- **`/memory admin list-user <user>`** / **`list-server`**: alles mit IDs, mit Blaettern.
- **`/memory admin forget-user <id>`** / **`forget-server <id>`**: einzeln loeschen.
- **`/memory admin add-user <user> <content>`** / **`add-server <content>`**: manuell anlegen.

## Gedaechtnis

Zwei Arten, beide in derselben Tabelle per `scope` unterschieden:

- **User-Memories** gelten **serveruebergreifend** fuer eine Person (auch in DMs und auf
  anderen Servern).
- **Server-Memories** gelten fuer **alle** auf einem Server, aber nicht darueber hinaus.

Der Bot entscheidet selbst, was merkenswert ist - es gibt keinen manuellen
"merk dir das"-Befehl fuer normale User. Zwei Wege fuehren hinein:

1. **Aus dem Gespraech**: bei jeder Antwort darf das Modell bis zu 5 neue Fakten vorschlagen.
2. **Passives Lernen**: der Bot liest auch Nachrichten mit, die **nicht an ihn gerichtet**
   sind, und extrahiert daraus gebatcht Fakten - also auch ueber Leute, die ihn nie
   angesprochen haben. Gebatcht statt pro Nachricht, weil ein Call pro Channel-Nachricht
   das Rate- und Token-Budget sprengen wuerde. Steuerung ueber `LEARNING_ENABLED` (Default
   **an**), `LEARNING_BATCH_SIZE`, `LEARNING_SWEEP_INTERVAL_MINUTES`.

Pro User und pro Server gilt ein Deckel von 50 Erinnerungen (`MAX_MEMORIES_PER_SCOPE` in
`src/db.js`), aeltere fliegen automatisch raus.

## Aufbau

```
src/
  index.js           Bot-Client, Message-Handler, Slash-Command-Handler, passives Lernen
  llm.js             Call an die OpenAI-kompatible API inkl. strukturiertem JSON-Response
  db.js              SQLite Layer fuer das Langzeitgedaechtnis
  commands.js        Definition der Slash-Commands
  deploy-commands.js Registriert die Slash-Commands bei Discord
  pagination.js      Components-V2-Seiten + Blaetter-Buttons fuer die Admin-Listen
  rateLimiter.js     Clientseitiges Sliding-Window-Limit
  statusEmbed.js     Rote Embeds fuer System-/Statusmeldungen
  textChunking.js    Laengenlimits: Aufteilen und Kuerzen fuer Discord
data/
  memory.sqlite      wird automatisch angelegt
```

```bash
npm test   # node:test, keine externen Dependencies
```

## Structured Outputs

Der Bot braucht strukturiertes JSON (Antwort + neue Erinnerungen in einem Response).
`src/llm.js` fordert das per `response_format: json_schema` mit `strict: true` an, also
schema-erzwungen beim Decoding.

Nicht jeder OpenAI-kompatible Endpoint kann das - viele beherrschen nur den schwaecheren
`json_object`-Modus, der valides JSON garantiert, aber nicht dessen Form. Welcher Fall
vorliegt, zeigt erst ein echter Request: beim ersten passenden 400 stuft der Bot **einmal**
herunter, merkt sich das fuer den Prozess und wiederholt den Call. Die erwartete Form steht
zusaetzlich immer im System-Prompt, und das Parsing ist tolerant - eine unerzwungene Form
fuehrt also nicht zu kaputten Antworten, sondern hoechstens zu weniger Erinnerungen.

## Rate Limiting und Kontingente

Der Bot begrenzt sich clientseitig auf `RATE_LIMIT_RPM` Requests pro Minute (Default 10),
geteilt zwischen Live-Antworten und passivem Lernen. Das echte Limit haengt am Tarif des
Anbieters - bei CodeCraft dokumentiert als "per-minute limits vary by plan tier", ohne
konkrete Zahl. Der Default ist also eine Schaetzung und gehoert angepasst, sobald das
tatsaechliche Limit bekannt ist.

Drei Faelle sind abgedeckt:

1. **Eigenes Limit erreicht**: der Bot wartet intern (Queue) und sagt dem User Bescheid,
   wenn es laenger dauert, statt ihn im Ungewissen zu lassen.
2. **429 vom Anbieter**: wird abgefangen und als klare Nachricht ausgegeben, inklusive
   Retry-Hinweis aus `retry-after` / `x-ratelimit-*`-Headern falls mitgeliefert. Sieht der
   Bot ein erschoepftes Tageskontingent, sagt er das ehrlich statt einen kurzen Retry
   vorzuschlagen, der nichts bringt.
3. **402 vom Anbieter**: Kontingent aufgebraucht oder das Modell verlangt einen bezahlten
   Plan. Loest sich nicht durch Warten - der Bot sagt klar, dass nur der Betreiber das im
   Dashboard aendern kann.

## Grenzen / moegliche Erweiterungen

- Mention/Reply funktioniert nur in Server-Channels; in DMs laeuft alles ueber `/ask`.
- Kurzzeit-Kontext wird live via `channel.messages.fetch()` geholt, nicht selbst
  gespeichert - einfacher, kostet aber pro Antwort einen zusaetzlichen Discord-Call.
  Bei sehr aktiven Channels ggf. `SHORT_TERM_CONTEXT_LIMIT` senken.
- Rate Limiting ist bewusst simpel (In-Memory, pro Prozess) - bei mehreren Instanzen oder
  nach einem Neustart wird der Zaehler nicht geteilt oder persistiert.
- Die Puffer des passiven Lernens liegen nur im Speicher und sind nach einem Neustart weg.
- `/memory list` zeigt die letzten 25 Erinnerungen ohne Blaettern; bei einem Deckel von 50
  sind die aelteren fuer den User selbst also nicht einsehbar oder loeschbar.
- Die vom Modell beim passiven Lernen gelieferte User-ID wird noch nicht gegen die
  tatsaechlichen Autoren des Batches geprueft.

## Datenschutz

Der Bot schickt Channel-Inhalte und gespeicherte Fakten ueber namentlich bekannte Personen
an den konfigurierten API-Anbieter - beim passiven Lernen auch von Leuten, die den Bot nie
angesprochen haben. Wer das nicht will, setzt `LEARNING_ENABLED=false`; die Wahl des
Anbieters ueber `LLM_BASE_URL` bestimmt, wem diese Daten anvertraut werden.
