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

### Qualitaetsfilter

Ohne Filter frisst sich der Bestand selbst auf. Gemessen an einem echten Bestand von 50
Eintraegen: 78 % drehten sich um dasselbe Thema, 38 Paare waren Dubletten (eines bei 0.92
Wortueberlappung, also praktisch derselbe Satz), 33 von 50 begannen mit einem Verhaltensadverb
("consistently demonstrates ...") und trugen damit keine Information. Ein Eintrag war 3276
Zeichen lang – ein einzelner Satz, in dem das Modell in eine Schleife geraten war, und der
allein rund ein Drittel des Prompts gefressen hat.

Das ist ein Rueckkopplungseffekt: Das Modell sieht im Prompt lauter solche Eintraege und
schreibt beim naechsten Mal mehr davon. Zusammen mit dem Deckel verdraengt die Monokultur dann
ueber die Eviction die echten Fakten. Auf "halte es kurz" im Prompt ist dabei kein Verlass,
deshalb greift `src/memoryHygiene.js` beim Schreiben:

- **Laengengrenze** (300 Zeichen) in der DB-Schicht erzwungen, nicht nur beim Modell-Pfad.
- **Ausgeufertes wird verworfen, nicht gekuerzt** (ab 600 Zeichen oder bei erkennbarer
  Wortschleife). Ein solcher Eintrag ist keine lange Information, sondern eine kaputte
  Generierung – wer den kuerzt, behaelt ein sinnloses Fragment, das im naechsten Prompt steht
  und den Effekt stuetzt.
- **Dubletten** werden vor dem Schreiben abgelehnt (Jaccard ab 0.45; bei kurzen Eintraegen gilt
  0.8, weil die Metrik dort zu grob ist). Die Schwelle ist an echten Daten kalibriert: bei 0.50
  rutschten eindeutige Dubletten durch. Manuelle Eintraege ueber `/memory admin add-user`
  umgehen die Pruefung, da hat ein Mensch bewusst entschieden.
- **Behauptungen ueber Rechte, Rollen oder Befugnisse** ("ist Admin", "darf alles") werden nie
  gespeichert. Zur Einordnung: die `/memory admin`-Befehle haengen an `TRUSTED_USER_IDS` aus der
  `.env`, nicht am Gedaechtnis – eine solche Erinnerung kann also keine Befehle freischalten.
  Der Schaden waere, dass der Bot die Behauptung anderen gegenueber als gegeben vertritt.

Erinnerungen werden im Prompt als **Gespraechsstand** gelabelt, nicht als gesicherte Fakten. Die
frueher dort stehende Anweisung, ihnen nicht zu widersprechen, machte jede einmal gespeicherte
Behauptung fuer den Bot unumstoesslich wahr. Die Kontinuitaet bleibt (der Bot leugnet den
Gespraechsstand nicht), aber er behandelt ihn nicht mehr als geprueft, und Rechte folgen daraus
nie.

### Altbestand aufraeumen

Die Filter greifen nur beim Schreiben. Fuer einen bereits entarteten Bestand:

```bash
npm run memories:clean              # Trockenlauf: zeigt nur, was passieren wuerde
npm run memories:clean -- --apply   # loescht, nach einer Sicherung der SQLite-Datei
```

Das Skript entfernt Ausgeufertes und Rechtebehauptungen und fuehrt Dubletten zusammen, wobei je
Gruppe die **kuerzeste** Fassung bleibt: der Bestand wird mit der Zeit geschwaetziger, die
knappste Fassung derselben Aussage traegt also am meisten Information pro Zeichen.

## Dashboard

Beim Start laeuft eine Weboberflaeche auf **http://127.0.0.1:1267** (`DASHBOARD_PORT`):

- **Uebersicht** - Verbindungsstatus, Gateway-Ping, Laufzeit, Serverliste, aktives Modell und
  Endpoint, Structured-Output-Modus, Rate-Limit-Rest, Stand der Lernpuffer, Persona.
- **Nachrichten** - die letzten gesehenen Nachrichten mit der jeweiligen Antwort des Bots,
  getrennt nach "angesprochen" und "passiv mitgelesen", filterbar nach Server.
- **Erinnerungen** - Manager ueber beide Arten (User und Server) in einer Liste: nach Besitzer
  und Inhalt filtern, einzeln loeschen, manuell anlegen. Zeigt auch, wer den Deckel erreicht hat.
- **Verlauf** - jeder Request an die API zum Aufklappen: der rausgegangene System-Prompt und die
  Konversation, die reingekommene Antwort, Tokenzahlen, Laufzeit, `finish_reason`, die
  **Antwort-Header** und der vollstaendige Request/Response als JSON. Fehlversuche stehen mit
  drin, damit die Abrechnung stimmt. Weicht die gemeldete Completion-Token-Zahl um mehr als das
  Doppelte von der Laenge der Antwort ab und liefert der Anbieter kein `reasoning_tokens` mit,
  weist die Ansicht darauf hin - dann laeuft entweder verstecktes Reasoning oder die Zaehlung
  stimmt nicht. Bei einem Proxy-Endpoint sind die Header ausserdem die einzige Spur, aus der
  sich ablesen laesst, was zwischen dem Bot und dem eigentlichen Modell sitzt.
- **Tokens** - Aufschluesselung nach Prompt/Completion, nach Art (`reply` vs. `extract`), nach
  Modell und nach Tag.

**Export** (oben rechts): Erinnerungen, Verlauf oder alles als JSON. Der Verlauf-Export traegt
pro Eintrag Request **und** Antwort samt Tokenzahlen - genug, um den Verbrauch nachzurechnen.

### Zugriff und Daten

Das Dashboard hat **bewusst keine Authentifizierung** und bindet deshalb standardmaessig nur auf
`127.0.0.1`. Es zeigt komplette Chatverlaeufe, System-Prompts und persoenliche Fakten ueber
Dritte. Fuer Zugriff von aussen `DASHBOARD_HOST=0.0.0.0` setzen **und** selbst etwas davorstellen
(Reverse Proxy mit Auth, SSH-Tunnel, VPN). Der API-Key wird nie ausgeliefert, nur maskiert
(`cc_ab...xyz`), und steht in keinem Export.

Beide Logs sind Ringpuffer (`API_LOG_MAX_ROWS`, `MESSAGE_LOG_MAX_ROWS`) und lassen sich in der
Oberflaeche leeren. Discord bleibt die Quelle der Wahrheit fuer den Chatverlauf - das
Nachrichten-Log ist eine Ansicht der letzten Aktivitaet, kein Archiv.

## Aufbau

```
src/
  index.js           Bot-Client, Message-Handler, Slash-Command-Handler, passives Lernen
  llm.js             Call an die OpenAI-kompatible API inkl. strukturiertem JSON-Response
  memoryHygiene.js   Laengen-, Schleifen-, Dubletten- und Rechtebehauptungs-Filter
  db.js              SQLite Layer fuer das Langzeitgedaechtnis + Dashboard-Queries
  apiLog.js          Ringpuffer aller API-Calls (Request, Antwort, Tokens, Laufzeit)
  messageLog.js      Ringpuffer der zuletzt gesehenen Nachrichten
  dashboard.js       HTTP-Server (node:http) fuer Oberflaeche und JSON-API
  commands.js        Definition der Slash-Commands
  deploy-commands.js Registriert die Slash-Commands bei Discord
  pagination.js      Components-V2-Seiten + Blaetter-Buttons fuer die Admin-Listen
  rateLimiter.js     Clientseitiges Sliding-Window-Limit
  statusEmbed.js     Rote Embeds fuer System-/Statusmeldungen
  textChunking.js    Laengenlimits: Aufteilen und Kuerzen fuer Discord
public/
  index.html         Dashboard-Oberflaeche
  app.css            Farbrollen als Tokens, Light + Dark eigens gesetzt
  app.js             Ansichten, Filter, Export
  chart.js           Gestapeltes Balkendiagramm (DOM injizierbar, damit testbar)
scripts/
  clean-memories.js  raeumt einen bereits entarteten Bestand auf (Trockenlauf als Standard)
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
4. **Transienter Ausfall des Endpoints** (502/503/504, Verbindungsabbruch): Der Standard-Endpoint
   sitzt hinter Cloudflare, und ein 502 heisst dort, dass Cloudflare erreichbar ist, der Origin
   dahinter aber nicht antwortet. Beobachtet im Betrieb, Minuten spaeter lief derselbe Endpoint
   wieder - ohne Wiederholung kostet jeder solche Blip eine Antwort. Der Bot wiederholt deshalb
   `LLM_RETRY_ATTEMPTS` mal mit steigender Wartezeit und sagt erst danach, dass der Anbieter
   nicht erreichbar ist - ausdruecklich ohne "schau in die Logs", denn es ist kein Fehler im Bot.
   `429` und `500` werden absichtlich nicht wiederholt: das eine regelt der Rate Limiter, das
   andere ist die Anwendung des Anbieters selbst und meist deterministisch.

Jeder Versuch steht einzeln im Verlauf, auch die fehlgeschlagenen. Wie oft der Endpoint wackelt,
ist bei einem Proxy-Anbieter die interessantere Zahl als die Erfolgsquote. HTML-Fehlerseiten
werden dabei auf eine Zeile zusammengefasst (der beobachtete 502 war 6442 Zeichen) - sonst
frisst ein einzelner Ausfall mehrere Kilobyte im Ringpuffer und im Export.

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
- Die Dublettenerkennung ist lexikalisch (Wortueberlappung). Sie faengt Neuformulierungen mit
  aehnlichem Wortlaut, aber keine echten Paraphrasen in ganz anderen Worten - dafuer braeuchte
  es Embeddings.
- Die vom Modell beim passiven Lernen gelieferte User-ID wird noch nicht gegen die
  tatsaechlichen Autoren des Batches geprueft.
- Das Dashboard hat keine Authentifizierung und ist deshalb auf localhost beschraenkt.
- Erinnerungen haengen an IDs, nicht an Namen - der Manager listet Besitzer also per ID.

## Datenschutz

Der Bot schickt Channel-Inhalte und gespeicherte Fakten ueber namentlich bekannte Personen
an den konfigurierten API-Anbieter - beim passiven Lernen auch von Leuten, die den Bot nie
angesprochen haben. Wer das nicht will, setzt `LEARNING_ENABLED=false`; die Wahl des
Anbieters ueber `LLM_BASE_URL` bestimmt, wem diese Daten anvertraut werden.

Dieselben Daten liegen lokal in der SQLite-Datei und sind im Dashboard einsehbar: das
Nachrichten-Log haelt Inhalte mit, das API-Log die vollstaendigen Prompts. Wer das nicht will,
setzt die Ringpuffer klein oder leert die Logs in der Oberflaeche.
