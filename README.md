# Discord Gemini Bot

Discord-Bot der auf Mention oder Reply antwortet, dabei den letzten Channel-Verlauf
als Kurzzeit-Kontext nutzt und sich dauerhaft Fakten ueber einzelne User merken kann
(Langzeitgedaechtnis in SQLite). Antworten kommen von der Google Gemini API.

## Setup

### 1. Discord Application anlegen
1. Auf https://discord.com/developers/applications eine neue Application erstellen.
2. Unter "Bot" einen Bot hinzufuegen, Token kopieren.
3. Unter "Bot" -> "Privileged Gateway Intents": **MESSAGE CONTENT INTENT** aktivieren
   (sonst sieht der Bot keinen Nachrichtentext).
4. Unter "OAuth2 -> URL Generator": Scopes `bot` und `applications.commands` anhaken,
   bei Bot-Permissions mindestens `Send Messages`, `Read Message History`, `View Channel`.
   Die generierte URL nutzen um den Bot auf deinen Server einzuladen.

### 2. Gemini API Key
Auf https://aistudio.google.com einen API Key erzeugen.

Modellnamen bei Google aendern sich ab und zu - unter
https://ai.google.dev/gemini-api/docs/models nachschauen welches Modell aktuell
empfohlen wird, falls `gemini-2.5-flash` (Default in `.env.example`) nicht mehr existiert.

### 3. Installation

```bash
cp .env.example .env
# .env ausfuellen: DISCORD_TOKEN, CLIENT_ID, GEMINI_API_KEY, optional GUILD_ID

npm install
npm run deploy-commands   # registriert /memory Slash-Command
npm start
```

Mit `GUILD_ID` in der `.env` gesetzt sind die Slash-Commands sofort auf deinem Server
sichtbar. Ohne `GUILD_ID` (globale Registrierung) kann es bis zu einer Stunde dauern.

## Nutzung

- **Bot ansprechen**: `@BotName was denkst du ueber X?` oder direkt auf eine Bot-Nachricht antworten.
- **`/memory list`**: zeigt was der Bot sich ueber dich merkt (nur fuer dich sichtbar).
- **`/memory forget <id>`**: loescht eine einzelne Erinnerung.
- **`/memory clear`**: loescht alle Erinnerungen ueber dich.

Der Bot entscheidet selbst (via Gemini) was merkenswert ist - z.B. wiederkehrende
Themen, Vorlieben, Projekte die du erwaehnst. Das laeuft automatisch im Hintergrund,
es gibt keinen manuellen "merk dir das"-Befehl. Wenn du den brauchst, sag Bescheid,
der laesst sich leicht ergaenzen.

## Aufbau

```
src/
  index.js           Bot-Client, Message-Handler, Slash-Command-Handler
  gemini.js          Gemini API Call inkl. strukturiertem JSON-Response
  db.js              SQLite Layer fuer Langzeitgedaechtnis
  commands.js        Definition der /memory Slash-Commands
  deploy-commands.js Registriert die Slash-Commands bei Discord
data/
  memory.sqlite      wird automatisch angelegt
```

## Rate Limiting

Der Bot begrenzt sich selbst clientseitig auf `RATE_LIMIT_RPM` Anfragen pro Minute
an Gemini (Default: 10, siehe `.env.example`). Das ist bewusst etwas konservativer
als das tatsaechliche Google-Limit, das aktuell (Stand Juli 2026) fuer Flash-Modelle
im Free Tier bei ca. 10-15 RPM liegt - dein genauer Wert steht live unter
https://aistudio.google.com/rate-limit fuer dein Projekt.

Zwei Faelle werden abgedeckt:

1. **Eigenes Limit erreicht**: der Bot wartet intern (Queue), und wenn's laenger
   dauert bekommt der User kurz eine Nachricht dass er warten muss, statt einfach
   nichts zu sehen.
2. **Gemini selbst gibt 429 zurueck** (z.B. weil das echte Google-Limit doch niedriger
   ist als angenommen, oder das Tageslimit erreicht wurde): der Bot faengt das ab und
   gibt eine klare Nachricht statt eines generischen Fehlers, inkl. Retry-Hinweis
   falls Google einen `retryDelay` mitliefert.

Wichtig: Google aendert diese Limits ohne grosse Ankuendigung. Wenn du oefter
Rate-Limit-Nachrichten siehst, `RATE_LIMIT_RPM` in der `.env` senken oder auf ein
zahlendes Tier upgraden.

## Grenzen / moegliche Erweiterungen

- Aktuell nur Server-Channels, keine DMs (laesst sich in `index.js` leicht ergaenzen).
- Kurzzeit-Kontext wird live via `channel.messages.fetch()` geholt, nicht selbst
  gespeichert - einfacher, aber kostet bei jeder Antwort einen zusaetzlichen API-Call
  an Discord. Bei sehr aktiven Channels ggf. `SHORT_TERM_CONTEXT_LIMIT` senken.
- Rate Limiting ist bewusst simpel gehalten (In-Memory, pro Prozess) - bei mehreren
  Bot-Instanzen oder Neustarts wird der Zaehler nicht geteilt/persistiert.
- Pro User max. 50 Langzeit-Erinnerungen (aelteste fliegen automatisch raus), in
  `src/db.js` als `MAX_MEMORIES_PER_USER` anpassbar.
