import { stackedBars } from '/chart.js';

// ---------- Hilfen ----------
const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) node.append(k?.nodeType ? k : document.createTextNode(String(k ?? '')));
  return node;
};
const nf = new Intl.NumberFormat('de-DE');
const num = (v) => (v === null || v === undefined ? '–' : nf.format(v));

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).message || msg; } catch { /* Fehlertext war kein JSON */ }
    throw new Error(msg);
  }
  return res.json();
}

function toast(text, isError = false) {
  const t = $('#toast');
  t.textContent = text;
  t.style.background = isError ? 'var(--critical)' : 'var(--text-primary)';
  t.style.color = isError ? '#fff' : 'var(--surface-1)';
  t.classList.add('is-visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('is-visible'), 2600);
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '–';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function fmtTime(sqlDate) {
  if (!sqlDate) return '–';
  // SQLite liefert "YYYY-MM-DD HH:MM:SS" in UTC, ohne Zonenangabe
  const d = new Date(sqlDate.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? sqlDate : d.toLocaleString('de-DE');
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '–';
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`;
}

const clip = (text, max = 160) => {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max) + '…' : s;
};

function table(headers, rows, emptyText = 'Keine Einträge.') {
  const t = el('table');
  t.append(el('thead', {}, el('tr', {}, headers.map((h) =>
    el('th', { className: h.num ? 'num' : '' }, h.label ?? h)))));
  if (rows.length === 0) {
    t.append(el('tbody', {}, el('tr', {}, el('td', { className: 'empty', colSpan: headers.length }, emptyText))));
  } else {
    t.append(el('tbody', {}, rows));
  }
  return t;
}
const swap = (selector, node) => { const old = $(selector); old.replaceWith(node); node.id = selector.slice(1); };

// ---------- Theme ----------
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('dash-theme'); } catch { /* private mode o.ae. */ }
  if (saved) document.documentElement.dataset.theme = saved;

  $('#themeToggle').addEventListener('click', () => {
    const isDark = document.documentElement.dataset.theme === 'dark'
      || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    const next = isDark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('dash-theme', next); } catch { /* egal */ }
    if (currentView === 'tokens') loadTokens(); // Diagramm liest die Farben aus den Tokens
  });
})();

// ---------- Tabs ----------
let currentView = 'overview';
const loaders = {};
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    currentView = tab.dataset.view;
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${currentView}`));
    loaders[currentView]?.();
  });
});
$('#refreshBtn').addEventListener('click', () => loaders[currentView]?.());

// ---------- Übersicht ----------
function kpi(label, value, hint, swatchColor) {
  return el('div', { className: 'kpi' },
    el('div', { className: 'kpi-label' }, label),
    el('div', { className: 'kpi-value' },
      swatchColor ? el('span', { className: 'kpi-swatch', style: `background:${swatchColor}` }) : '',
      String(value)),
    hint ? el('div', { className: 'kpi-hint' }, hint) : '');
}

loaders.overview = async function loadOverview() {
  let d;
  try { d = await api('/api/overview'); } catch (e) { return toast(`Übersicht: ${e.message}`, true); }

  $('#botTag').textContent = d.bot.tag || 'nicht eingeloggt';
  $('#botSub').textContent = d.bot.ready
    ? `online · ${d.bot.guildCount} Server · Ping ${num(d.bot.wsPing)} ms · seit ${fmtDuration(d.bot.uptimeMs)}`
    : 'nicht verbunden';
  $('#readyDot').className = `dot ${d.bot.ready ? 'is-ready' : 'is-down'}`;

  const tk = d.tokens.totals;
  swap('#overviewKpis', el('div', { className: 'kpi-row' },
    kpi('API-Calls', num(tk.calls), `${num(tk.ok_calls ?? 0)} erfolgreich`),
    kpi('Tokens gesamt', num(tk.total_tokens), `aus ${num(tk.calls_with_usage)} Calls mit usage`),
    kpi('Ø Latenz', tk.avg_latency_ms ? `${num(tk.avg_latency_ms)} ms` : '–'),
    kpi('Erinnerungen', num(d.memories.totals.total), `${num(d.memories.totals.distinct_users)} User · ${num(d.memories.totals.distinct_guilds)} Server`),
    kpi('Rate-Limit', `${num(d.limits.rateLimitRemaining)}/${num(d.limits.rateLimitRpm)}`, 'frei in diesem Minutenfenster')));

  swap('#apiInfo', el('dl', { className: 'deflist' },
    el('dt', {}, 'Endpoint'), el('dd', { className: 'mono' }, d.api.baseUrl),
    el('dt', {}, 'Modell'), el('dd', { className: 'mono' }, d.api.model || '(nicht gesetzt!)'),
    el('dt', {}, 'API-Key'), el('dd', { className: 'mono' }, d.api.keyConfigured ? d.api.keyPreview : '(nicht gesetzt!)'),
    el('dt', {}, 'Structured Output'), el('dd', { className: 'mono' }, d.api.structuredOutputMode || '–'),
    el('dt', {}, 'Reasoning Effort'), el('dd', { className: 'mono' }, d.api.reasoningEffort || '(aus)')));

  swap('#botInfo', el('dl', { className: 'deflist' },
    el('dt', {}, 'Bot-ID'), el('dd', { className: 'mono' }, d.bot.id || '–'),
    el('dt', {}, 'Gateway-Ping'), el('dd', {}, `${num(d.bot.wsPing)} ms`),
    el('dt', {}, 'Laufzeit'), el('dd', {}, fmtDuration(d.bot.uptimeMs)),
    el('dt', {}, 'Kurzzeit-Kontext'), el('dd', {}, `${num(d.limits.shortTermContextLimit)} Nachrichten`),
    el('dt', {}, 'Passives Lernen'), el('dd', {}, d.learning.enabled ? 'an' : 'aus'),
    el('dt', {}, 'Lernpuffer'), el('dd', {}, `${num(d.learning.bufferedMessages)} Nachrichten in ${num(d.learning.bufferedChannels)} Channels`),
    el('dt', {}, 'Batch / Sweep'), el('dd', {}, `${num(d.learning.batchSize)} / alle ${num(d.learning.sweepIntervalMinutes)} min`)));

  $('#guildCount').textContent = `(${d.bot.guildCount})`;

  // Server-Filter der Nachrichtenansicht mitziehen, ohne eine bestehende Auswahl zu verlieren
  const guildSelect = $('#msgGuild');
  const picked = guildSelect.value;
  guildSelect.replaceChildren(
    el('option', { value: '' }, 'alle Server'),
    ...d.bot.guilds.map((g) => el('option', { value: g.id }, g.name))
  );
  if ([...guildSelect.options].some((o) => o.value === picked)) guildSelect.value = picked;
  swap('#guildTable', table(
    ['Server', 'ID', { label: 'Mitglieder', num: true }, { label: 'Channels', num: true }],
    d.bot.guilds.map((g) => el('tr', {},
      el('td', {}, g.name),
      el('td', { className: 'mono' }, g.id),
      el('td', { className: 'num' }, num(g.memberCount)),
      el('td', { className: 'num' }, num(g.channels)))),
    'Der Bot ist auf keinem Server.'));

  const m = d.memories;
  swap('#memInfo', el('dl', { className: 'deflist' },
    el('dt', {}, 'Gesamt'), el('dd', {}, num(m.totals.total)),
    ...m.byScope.flatMap((s) => [el('dt', {}, s.scope === 'user' ? 'User-Fakten' : 'Server-Fakten'), el('dd', {}, num(s.count))]),
    el('dt', {}, 'Ø Länge'), el('dd', {}, `${num(m.totals.avg_length)} Zeichen`),
    el('dt', {}, 'Längste'), el('dd', {}, `${num(m.totals.longest)} Zeichen`),
    el('dt', {}, 'Deckel'), el('dd', {}, `${num(m.cap)} pro User bzw. Server`),
    el('dt', {}, 'Neueste'), el('dd', {}, fmtTime(m.totals.newest_at))));

  $('#capWarning').replaceChildren(m.atCap.length
    ? el('div', { className: 'warn-box' },
        `${m.atCap.length} ${m.atCap.length === 1 ? 'Besitzer hat' : 'Besitzer haben'} den Deckel von ${m.cap} erreicht – dort fällt bei jedem neuen Fakt der älteste raus.`)
    : '');

  $('#personaBox').textContent = d.persona || '(BOT_PERSONA nicht gesetzt)';
};

// ---------- Nachrichten ----------
loaders.messages = async function loadMessages() {
  const params = new URLSearchParams({
    limit: $('#msgLimit').value,
    addressedOnly: $('#msgAddressedOnly').checked ? '1' : '0'
  });
  if ($('#msgGuild').value) params.set('guildId', $('#msgGuild').value);

  let d;
  try { d = await api(`/api/messages?${params}`); } catch (e) { return toast(`Nachrichten: ${e.message}`, true); }

  $('#msgTotal').textContent = `${num(d.rows.length)} von ${num(d.total)}`;
  swap('#msgTable', table(
    ['Zeit', 'Server / Channel', 'Autor', 'Nachricht', 'Antwort des Bots'],
    d.rows.map((r) => el('tr', {},
      el('td', { className: 'mono' }, fmtTime(r.created_at)),
      el('td', {}, r.guild_name || '–', el('br'), el('span', { className: 'muted small' }, r.channel_name ? `#${r.channel_name}` : '')),
      el('td', {},
        el('div', {}, r.author_name || '–'),
        el('div', { className: 'muted mono' }, r.author_id || ''),
        r.addressed ? el('span', { className: 'badge badge-addressed' }, r.source === 'ask' ? '/ask' : 'angesprochen') : el('span', { className: 'badge' }, 'passiv')),
      el('td', {}, clip(r.content, 220)),
      el('td', { className: 'muted' }, clip(r.bot_reply, 220)))),
    'Noch keine Nachrichten protokolliert.'));
};
$('#msgAddressedOnly').addEventListener('change', () => loaders.messages());
$('#msgGuild').addEventListener('change', () => loaders.messages());
$('#msgLimit').addEventListener('change', () => loaders.messages());
$('#msgClear').addEventListener('click', async () => {
  if (!confirm('Das Nachrichten-Log wirklich leeren?')) return;
  try {
    const r = await api('/api/messages', { method: 'DELETE' });
    toast(`${num(r.deleted)} Zeilen gelöscht`);
    loaders.messages();
  } catch (e) { toast(e.message, true); }
});

// ---------- Erinnerungen ----------
let activeOwner = null;

loaders.memories = async function loadMemories() {
  const params = new URLSearchParams({ limit: '250' });
  if ($('#memScope').value) params.set('scope', $('#memScope').value);
  if ($('#memSearch').value.trim()) params.set('q', $('#memSearch').value.trim());
  if (activeOwner) params.set('ownerId', activeOwner);

  let d, owners;
  try {
    [d, owners] = await Promise.all([api(`/api/memories?${params}`), api('/api/memories/owners')]);
  } catch (e) { return toast(`Erinnerungen: ${e.message}`, true); }

  $('#memTotal').textContent = `${num(d.rows.length)} von ${num(d.total)}`;

  const ownerBtn = (o, label) => el('button', {
    className: `owner${activeOwner === o.id ? ' is-active' : ''}`,
    onclick: () => { activeOwner = activeOwner === o.id ? null : o.id; loaders.memories(); }
  }, el('span', { className: 'owner-id', title: o.id }, o.id), el('span', { className: 'muted' }, String(o.count)));

  const list = el('div', { className: 'owner-list' });
  list.append(el('div', { className: 'owner-group' }, `User (${owners.users.length})`));
  if (!owners.users.length) list.append(el('div', { className: 'muted small' }, 'keine'));
  owners.users.forEach((o) => list.append(ownerBtn(o)));
  list.append(el('div', { className: 'owner-group' }, `Server (${owners.guilds.length})`));
  if (!owners.guilds.length) list.append(el('div', { className: 'muted small' }, 'keine'));
  owners.guilds.forEach((o) => list.append(ownerBtn(o)));
  swap('#ownerList', list);

  swap('#memTable', table(
    [{ label: 'ID', num: true }, 'Art', 'Besitzer', 'Inhalt', { label: 'Zeichen', num: true }, 'Erstellt', ''],
    d.rows.map((r) => el('tr', {},
      el('td', { className: 'num mono' }, r.id),
      el('td', {}, el('span', { className: 'badge' }, r.scope === 'user' ? 'User' : 'Server')),
      el('td', { className: 'mono' }, r.user_id || r.guild_id || '–'),
      el('td', {}, r.content),
      el('td', { className: 'num' }, num(r.length)),
      el('td', { className: 'mono muted' }, fmtTime(r.created_at)),
      el('td', {}, el('button', {
        className: 'btn btn-danger',
        onclick: async () => {
          if (!confirm(`Erinnerung ${r.id} löschen?\n\n${clip(r.content, 200)}`)) return;
          try { await api(`/api/memories/${r.id}`, { method: 'DELETE' }); toast(`Erinnerung ${r.id} gelöscht`); loaders.memories(); }
          catch (e) { toast(e.message, true); }
        }
      }, 'Löschen')))),
    activeOwner || $('#memSearch').value ? 'Keine Treffer für diesen Filter.' : 'Noch keine Erinnerungen.'));

  $('#addHint').textContent =
    'Neue Einträge zählen gegen den Deckel pro Besitzer – ist er erreicht, fällt der älteste Eintrag raus.';
};
$('#memScope').addEventListener('change', () => loaders.memories());
$('#memSearch').addEventListener('input', debounce(() => loaders.memories(), 250));
$('#memClearFilter').addEventListener('click', () => {
  activeOwner = null; $('#memScope').value = ''; $('#memSearch').value = ''; loaders.memories();
});
$('#memAddForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await api('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: $('#addScope').value, ownerId: $('#addOwner').value, content: $('#addContent').value })
    });
    $('#addOwner').value = ''; $('#addContent').value = '';
    toast('Erinnerung gespeichert');
    loaders.memories();
  } catch (e) { toast(e.message, true); }
});

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------- Verlauf ----------
loaders.calls = async function loadCalls() {
  const params = new URLSearchParams({
    limit: $('#callLimit').value,
    onlyErrors: $('#callErrorsOnly').checked ? '1' : '0'
  });
  if ($('#callKind').value) params.set('kind', $('#callKind').value);

  let d;
  try { d = await api(`/api/calls?${params}`); } catch (e) { return toast(`Verlauf: ${e.message}`, true); }

  $('#callTotal').textContent = `${num(d.rows.length)} von ${num(d.total)}`;

  const rows = [];
  for (const r of d.rows) {
    const detailRow = el('tr', { style: 'display:none' });
    const detailCell = el('td', { colSpan: 9, className: 'detail' });
    detailRow.append(detailCell);

    let loaded = false;
    const caret = el('span', { className: 'caret' }, '▸');
    const mainRow = el('tr', { className: 'row-toggle' },
      el('td', { className: 'num mono' }, caret, ' ', r.id),
      el('td', { className: 'mono' }, fmtTime(r.created_at)),
      el('td', {}, el('span', { className: 'badge' }, r.kind)),
      el('td', {}, r.ok
        ? el('span', { className: 'badge badge-ok' }, r.status ?? 'ok')
        : el('span', { className: 'badge badge-err' }, r.status ?? 'Fehler')),
      el('td', { className: 'num' }, num(r.prompt_tokens)),
      el('td', { className: 'num' }, num(r.completion_tokens)),
      el('td', { className: 'num' }, num(r.total_tokens)),
      el('td', { className: 'num' }, r.latency_ms === null ? '–' : `${num(r.latency_ms)} ms`),
      el('td', { className: 'muted small' }, r.error ? clip(r.error, 70) : `${r.structured_mode} · ${fmtBytes(r.request_bytes)}`));

    mainRow.addEventListener('click', async () => {
      const open = detailRow.style.display !== 'none';
      detailRow.style.display = open ? 'none' : '';
      caret.textContent = open ? '▸' : '▾';
      if (open || loaded) return;
      detailCell.replaceChildren(el('div', { className: 'muted small', style: 'padding:12px 0' }, 'lade...'));
      try {
        const full = await api(`/api/calls/${r.id}`);
        detailCell.replaceChildren(renderCallDetail(full));
        loaded = true;
      } catch (e) {
        detailCell.replaceChildren(el('div', { className: 'warn-box' }, e.message));
      }
    });

    rows.push(mainRow, detailRow);
  }

  swap('#callTable', table(
    [{ label: 'ID', num: true }, 'Zeit', 'Art', 'Status',
     { label: 'Prompt', num: true }, { label: 'Completion', num: true }, { label: 'Total', num: true },
     { label: 'Dauer', num: true }, 'Hinweis'],
    rows, 'Noch keine API-Calls protokolliert.'));
};
['#callKind', '#callErrorsOnly', '#callLimit'].forEach((s) =>
  $(s).addEventListener('change', () => loaders.calls()));
$('#callClear').addEventListener('click', async () => {
  if (!confirm('Den Verlauf wirklich leeren? Damit ist auch die Token-Auswertung weg.')) return;
  try {
    const r = await api('/api/calls', { method: 'DELETE' });
    toast(`${num(r.deleted)} Zeilen gelöscht`);
    loaders.calls();
  } catch (e) { toast(e.message, true); }
});

/** Zeigt die Completion-Tokens und, falls vorhanden, den Reasoning-Anteil daran. */
function completionCell(c) {
  const reasoning = c.tokenCheck?.reasoningTokens;
  if (!Number.isFinite(reasoning)) return num(c.completion_tokens);
  return `${num(c.completion_tokens)} (davon ${num(reasoning)} Reasoning)`;
}

function renderCallDetail(c) {
  const box = el('div');
  const req = c.request || {};
  const messages = Array.isArray(req.messages) ? req.messages : [];

  box.append(el('div', { className: 'detail-grid' },
    el('dl', { className: 'deflist' },
      el('dt', {}, 'Modell'), el('dd', { className: 'mono' }, req.model || c.model || '–'),
      el('dt', {}, 'Temperature'), el('dd', {}, String(req.temperature ?? '–')),
      el('dt', {}, 'max_tokens'), el('dd', {}, num(req.max_tokens)),
      el('dt', {}, 'response_format'), el('dd', { className: 'mono' }, req.response_format?.type || '–')),
    el('dl', { className: 'deflist' },
      el('dt', {}, 'Prompt-Tokens'), el('dd', {}, num(c.prompt_tokens)),
      el('dt', {}, 'Completion-Tokens'), el('dd', {}, completionCell(c)),
      el('dt', {}, 'Total'), el('dd', {}, num(c.total_tokens)),
      el('dt', {}, 'finish_reason'), el('dd', { className: 'mono' }, c.finish_reason || '–'))));

  if (c.error) box.append(el('h3', {}, 'Fehler'), el('div', { className: 'warn-box' }, c.error));

  // Gemeldete Completion-Tokens gegen die Laenge der Antwort: weicht das um mehr als das
  // Doppelte ab und liefert der Anbieter kein reasoning_tokens mit, stimmt entweder die
  // Zaehlung nicht oder es laeuft verstecktes Reasoning mit.
  const tc = c.tokenCheck;
  if (tc?.suspicious) {
    box.append(el('div', { className: 'warn-box' },
      `Gemeldet werden ${num(tc.reported)} Completion-Tokens, die Antwort ist aber nur rund `
      + `${num(tc.estimate)} Tokens lang (Faktor ${tc.ratio}). Der Anbieter liefert kein `
      + 'reasoning_tokens mit - entweder laeuft verstecktes Reasoning oder die Zaehlung stimmt nicht.'));
  }

  // Antwort-Header: bei einem Proxy die interessanteste Spur zur Herkunft
  if (c.headers) {
    const rows = Object.entries(c.headers);
    box.append(el('h3', {}, `Antwort-Header (${rows.length})`),
      el('dl', { className: 'deflist' },
        ...rows.flatMap(([k, v]) => [el('dt', { className: 'mono' }, k), el('dd', { className: 'mono' }, v)])));
  }

  if (c.usage) {
    box.append(el('h3', {}, 'usage (vollstaendig, wie vom Anbieter geliefert)'),
      el('pre', { className: 'pre' }, JSON.stringify(c.usage, null, 2)));
  }

  // Was rausgegangen ist: System-Prompt und Konversation getrennt, das ist der Punkt der Ansicht
  const system = messages.find((m) => m.role === 'system');
  if (system) box.append(el('h3', {}, 'System-Prompt (raus)'), el('pre', { className: 'pre' }, system.content));

  const convo = messages.filter((m) => m.role !== 'system');
  if (convo.length) {
    box.append(el('h3', {}, `Konversation (raus, ${convo.length} Nachrichten)`),
      el('pre', { className: 'pre' }, convo.map((m) => `[${m.role}] ${m.content}`).join('\n\n')));
  }

  if (c.content) box.append(el('h3', {}, 'Antwort des Modells (rein)'), el('pre', { className: 'pre' }, c.content));

  box.append(el('h3', {}, 'Vollständiger Request (JSON)'),
    el('pre', { className: 'pre' }, JSON.stringify(c.request, null, 2)));
  box.append(el('h3', {}, 'Vollständige Antwort (JSON)'),
    el('pre', { className: 'pre' }, typeof c.response === 'string' ? c.response : JSON.stringify(c.response, null, 2)));

  return box;
}

// ---------- Tokens ----------
loaders.tokens = async function loadTokens() {
  let d;
  try { d = await api('/api/tokens'); } catch (e) { return toast(`Tokens: ${e.message}`, true); }

  const t = d.totals;
  const css = getComputedStyle(document.documentElement);
  const cPrompt = css.getPropertyValue('--series-prompt').trim();
  const cCompletion = css.getPropertyValue('--series-completion').trim();

  const share = t.total_tokens ? Math.round((t.prompt_tokens / t.total_tokens) * 100) : null;
  swap('#tokenKpis', el('div', { className: 'kpi-row' },
    kpi('Tokens gesamt', num(t.total_tokens), `${num(t.calls_with_usage)} von ${num(t.calls)} Calls melden usage`),
    kpi('Prompt', num(t.prompt_tokens), share === null ? '' : `${share} % des Verbrauchs`, cPrompt),
    kpi('Completion', num(t.completion_tokens), share === null ? '' : `${100 - share} % des Verbrauchs`, cCompletion),
    kpi('Calls', num(t.calls), `${num(t.calls - (t.ok_calls ?? 0))} fehlgeschlagen`),
    kpi('Ø Latenz', t.avg_latency_ms ? `${num(t.avg_latency_ms)} ms` : '–')));

  swap('#tokenLegend', el('div', { className: 'legend' },
    el('div', { className: 'legend-item' }, el('span', { className: 'legend-swatch', style: `background:${cPrompt}` }), 'Prompt'),
    el('div', { className: 'legend-item' }, el('span', { className: 'legend-swatch', style: `background:${cCompletion}` }), 'Completion')));

  // Chronologisch aufsteigend zeichnen (die Query liefert neueste zuerst)
  const days = [...d.byDay].reverse();
  $('#tokenChart').replaceChildren(days.length
    ? stackedBars(days, [
        { key: 'prompt_tokens', label: 'Prompt', color: cPrompt },
        { key: 'completion_tokens', label: 'Completion', color: cCompletion }
      ], (row) => row.day.slice(5))
    : el('div', { className: 'empty' }, 'Noch keine Daten – sobald der Bot antwortet, füllt sich das hier.'));

  swap('#tokenDayTable', table(
    ['Tag', { label: 'Calls', num: true }, { label: 'Prompt', num: true }, { label: 'Completion', num: true }, { label: 'Total', num: true }],
    d.byDay.map((r) => el('tr', {},
      el('td', { className: 'mono' }, r.day),
      el('td', { className: 'num' }, num(r.calls)),
      el('td', { className: 'num' }, num(r.prompt_tokens)),
      el('td', { className: 'num' }, num(r.completion_tokens)),
      el('td', { className: 'num' }, num(r.total_tokens))))));

  swap('#tokenKindTable', table(
    ['Art', { label: 'Calls', num: true }, { label: 'Prompt', num: true }, { label: 'Completion', num: true }, { label: 'Total', num: true }],
    d.byKind.map((r) => el('tr', {},
      el('td', {}, el('span', { className: 'badge' }, r.kind)),
      el('td', { className: 'num' }, num(r.calls)),
      el('td', { className: 'num' }, num(r.prompt_tokens)),
      el('td', { className: 'num' }, num(r.completion_tokens)),
      el('td', { className: 'num' }, num(r.total_tokens))))));

  swap('#tokenModelTable', table(
    ['Modell', { label: 'Calls', num: true }, { label: 'Total', num: true }],
    d.byModel.map((r) => el('tr', {},
      el('td', { className: 'mono' }, r.model || '–'),
      el('td', { className: 'num' }, num(r.calls)),
      el('td', { className: 'num' }, num(r.total_tokens))))));
};

// ---------- Start ----------
loaders.overview();
setInterval(() => { if (currentView === 'overview') loaders.overview(); }, 15000);
