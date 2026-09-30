// Diagramm-Modul, bewusst getrennt von app.js: app.js zieht beim Import sofort DOM und API
// hoch und ist damit nicht testbar. Hier wird das Dokument injiziert, also laeuft die
// Geometrie auch unter node:test gegen ein minimales DOM.

export const CHART_BOX = { W: 900, H: 260, PAD: { top: 22, right: 8, bottom: 26, left: 52 } };
export const SEG_GAP = 2;   // Flaeche-gegen-Flaeche: 2px Oberflaechenluecke zwischen Segmenten
export const RADIUS = 4;    // gerundetes Datenende, nur am oberen Stapelende

// Mindestabstand, den eine Beschriftung braucht, ohne in die naechste zu laufen: "MM-DD" bzw.
// "12.5k" sind 5 Zeichen, bei 11px Schrift ca. 30px. Bei 30 Tagen ist step nur 28px breit -
// dann wird jede n-te Beschriftung gezeichnet statt alle uebereinander zu stapeln. Das deckt
// sich mit der Regel, Direktlabels selektiv zu setzen und nie an jeden Datenpunkt.
export const MIN_LABEL_PX = 34;
const SVG_NS = 'http://www.w3.org/2000/svg';

const nf = new Intl.NumberFormat('de-DE');
const num = (v) => (v === null || v === undefined ? '–' : nf.format(v));
const short = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)));

/**
 * Gestapelte Balken als Inline-SVG.
 *
 * Mark-Specs: 2px Luecke zwischen gestapelten Segmenten, 4px gerundetes Datenende nur oben
 * (die Basislinie bleibt flach), zurueckgenommenes Raster, die Summe als Direktlabel statt
 * jedes Segment zu beschriften, Hover-Tooltip pro Balken mit Trefferflaeche breiter als der
 * Balken. Die Serienfarben kommen als Rollen-Tokens vom Aufrufer, nicht als Hex hier drin.
 *
 * @param {Array<object>} rows chronologisch aufsteigend
 * @param {Array<{key: string, label: string, color: string}>} series von unten nach oben
 * @param {(row: object) => string} labelFn Beschriftung der x-Achse
 * @param {{doc?: Document, body?: Element}} env injizierbares DOM
 */
export function stackedBars(rows, series, labelFn, env = {}) {
  const doc = env.doc ?? globalThis.document;
  const body = env.body ?? doc.body;
  const { W, H, PAD } = CHART_BOX;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const totals = rows.map((r) => series.reduce((sum, s) => sum + (r[s.key] || 0), 0));
  const max = Math.max(1, ...totals);
  const step = plotW / rows.length;
  const barW = Math.max(6, Math.min(46, step * 0.62));
  // Vom Ende her ausduennen: der neueste Balken ist der interessanteste und bekommt so immer
  // ein Label, und die Abstaende bleiben gleichmaessig (vom Anfang her waere das letzte Label
  // sonst der direkte Nachbar des vorletzten).
  const labelEvery = Math.max(1, Math.ceil(MIN_LABEL_PX / step));

  const mk = (tag, attrs = {}, text = null) => {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (text !== null) node.textContent = text;
    return node;
  };

  const svg = mk('svg', {
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': `Tokenverbrauch pro Tag, gestapelt nach ${series.map((s) => s.label).join(' und ')}`
  });

  // Raster + y-Achse, absichtlich zurueckgenommen
  const TICKS = 4;
  for (let i = 0; i <= TICKS; i++) {
    const value = (max / TICKS) * i;
    const y = PAD.top + plotH - (value / max) * plotH;
    svg.append(mk('line', { class: 'gridline', x1: PAD.left, x2: W - PAD.right, y1: y, y2: y }));
    svg.append(mk('text', { class: 'axis-label', x: PAD.left - 8, y: y + 4, 'text-anchor': 'end' }, short(value)));
  }

  const tip = makeTooltip(doc, body);

  rows.forEach((row, i) => {
    const x = PAD.left + step * i + (step - barW) / 2;
    const total = totals[i];
    const group = mk('g', { class: 'bar-group' });

    // Von unten nach oben stapeln; nur das oberste sichtbare Segment wird gerundet
    const visible = series.filter((s) => (row[s.key] || 0) > 0);
    let stacked = 0;
    visible.forEach((s, idx) => {
      const rawH = ((row[s.key] || 0) / max) * plotH;
      const isTop = idx === visible.length - 1;
      // Die Luecke wird OBEN abgezogen, nie unten: die Unterkante bleibt damit exakt auf der
      // Grundlinie bzw. auf dem Segment darunter, statt darueber zu schweben.
      const gap = isTop ? 0 : SEG_GAP;
      const h = Math.max(1, rawH - gap);
      const y = PAD.top + plotH - stacked - rawH + gap;
      const r = isTop ? Math.min(RADIUS, h / 2, barW / 2) : 0;

      // Pfad statt rect: so ist nur das Datenende gerundet, die Basis bleibt flach
      group.append(mk('path', {
        class: 'bar-seg',
        fill: s.color,
        d: `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${y + h} Z`
      }));
      stacked += rawH;
    });

    // Direktlabel: nur die Summe, nie jedes einzelne Segment - und nur so dicht, wie es
    // ohne Ueberlappung passt (der Hover-Tooltip liefert jeden Wert exakt).
    const labelThisBar = (rows.length - 1 - i) % labelEvery === 0;
    if (total > 0 && labelThisBar) {
      group.append(mk('text', {
        class: 'bar-total',
        x: x + barW / 2,
        y: PAD.top + plotH - stacked - 6,
        'text-anchor': 'middle'
      }, short(total)));
    }

    if (labelThisBar) {
      svg.append(mk('text', { class: 'axis-label', x: x + barW / 2, y: H - 8, 'text-anchor': 'middle' }, labelFn(row)));
    }

    // Trefferflaeche ueber die ganze Spalte, nicht nur ueber den Balken
    const hit = mk('rect', { x: PAD.left + step * i, y: PAD.top, width: step, height: plotH, fill: 'transparent' });
    hit.addEventListener?.('mousemove', (ev) => showTooltip(tip, doc, ev, row, series, total, labelFn));
    hit.addEventListener?.('mouseleave', () => tip.classList.remove('is-visible'));
    group.append(hit);
    svg.append(group);
  });

  svg.addEventListener?.('mouseleave', () => tip.classList.remove('is-visible'));
  return svg;
}

function makeTooltip(doc, body) {
  const tip = doc.createElement('div');
  tip.className = 'chart-tip';
  body?.append?.(tip);
  return tip;
}

function showTooltip(tip, doc, ev, row, series, total, labelFn) {
  const line = (label, value, color, bold) => {
    const rowEl = doc.createElement('div');
    rowEl.className = 'tip-row';
    const left = doc.createElement('span');
    if (color) {
      const sw = doc.createElement('span');
      sw.className = 'legend-swatch';
      sw.style = `background:${color};display:inline-block;margin-right:6px`;
      left.append(sw);
    }
    left.append(doc.createTextNode(label));
    const right = doc.createElement('span');
    right.textContent = value;
    if (bold) rowEl.style = 'font-weight:650;margin-top:4px';
    rowEl.append(left, right);
    return rowEl;
  };

  const title = doc.createElement('div');
  title.className = 'tip-title';
  title.textContent = row.day ?? labelFn(row);

  tip.replaceChildren(
    title,
    ...series.map((s) => line(s.label, num(row[s.key] || 0), s.color)),
    line('Gesamt', num(total), null, true),
    line('Calls', num(row.calls), null)
  );

  tip.style.left = `${Math.min(ev.clientX + 14, (globalThis.innerWidth ?? 1200) - 250)}px`;
  tip.style.top = `${ev.clientY + 14}px`;
  tip.classList.add('is-visible');
}
