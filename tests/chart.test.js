import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stackedBars, CHART_BOX, SEG_GAP, RADIUS, MIN_LABEL_PX } from '../public/chart.js';

// Minimales DOM: reicht, um die erzeugte Geometrie zu pruefen. Es geht hier nicht um
// Rendering, sondern darum, dass nichts aus der Zeichenflaeche laeuft oder kollidiert.
function fakeDom() {
  const make = (tag) => ({
    tag,
    attrs: {},
    children: [],
    textContent: '',
    style: '',
    className: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    append(...kids) { this.children.push(...kids); },
    replaceChildren(...kids) { this.children = kids; },
    classList: { add() {}, remove() {} }
  });
  return {
    doc: { createElementNS: (_ns, tag) => make(tag), createElement: make, createTextNode: (t) => ({ tag: '#text', textContent: t }) },
    body: make('body')
  };
}

function render(rows) {
  const { doc, body } = fakeDom();
  const series = [
    { key: 'prompt_tokens', label: 'Prompt', color: 'var(--series-prompt)' },
    { key: 'completion_tokens', label: 'Completion', color: 'var(--series-completion)' }
  ];
  return stackedBars(rows, series, (r) => r.day.slice(5), { doc, body });
}

const flatten = (node, out = []) => {
  out.push(node);
  for (const kid of node.children ?? []) flatten(kid, out);
  return out;
};
const nodesOfType = (svg, tag) => flatten(svg).filter((n) => n.tag === tag);

function day(i, prompt, completion) {
  const d = String(i + 1).padStart(2, '0');
  return { day: `2026-09-${d}`, calls: 3, prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

test('stackedBars haelt alle Koordinaten innerhalb der Zeichenflaeche', () => {
  const svg = render([day(0, 800, 200), day(1, 1200, 400), day(2, 300, 90)]);
  const { W, H } = CHART_BOX;

  for (const rect of nodesOfType(svg, 'rect')) {
    assert.ok(Number(rect.attrs.x) >= 0, `rect.x ${rect.attrs.x} < 0`);
    assert.ok(Number(rect.attrs.x) + Number(rect.attrs.width) <= W + 0.01, 'rect laeuft rechts raus');
    assert.ok(Number(rect.attrs.y) + Number(rect.attrs.height) <= H + 0.01, 'rect laeuft unten raus');
  }
  for (const text of nodesOfType(svg, 'text')) {
    const x = Number(text.attrs.x), y = Number(text.attrs.y);
    assert.ok(x >= 0 && x <= W, `Textlabel x=${x} ausserhalb 0..${W}`);
    assert.ok(y >= 0 && y <= H, `Textlabel y=${y} ausserhalb 0..${H}`);
  }
  // Pfad-Koordinaten einsammeln und gegen die Flaeche pruefen
  for (const p of nodesOfType(svg, 'path')) {
    for (const [, nx, ny] of p.attrs.d.matchAll(/([-\d.]+),([-\d.]+)/g)) {
      assert.ok(Number(nx) >= 0 && Number(nx) <= W, `Pfad-x ${nx} ausserhalb`);
      assert.ok(Number(ny) >= 0 && Number(ny) <= H, `Pfad-y ${ny} ausserhalb`);
    }
  }
});

test('stackedBars laesst zwischen gestapelten Segmenten eine Oberflaechenluecke', () => {
  const svg = render([day(0, 1000, 500)]);
  const paths = nodesOfType(svg, 'path');
  assert.equal(paths.length, 2, 'zwei Segmente erwartet');

  // Unterstes Segment: Oberkante minus Unterkante des oberen ergibt die Luecke
  const yOf = (p) => [...p.attrs.d.matchAll(/([-\d.]+),([-\d.]+)/g)].map((m) => Number(m[2]));
  const lower = yOf(paths[0]);
  const upper = yOf(paths[1]);
  const gap = Math.min(...lower) - Math.max(...upper);
  assert.ok(Math.abs(gap - SEG_GAP) < 0.01, `Luecke ${gap} statt ${SEG_GAP}px`);
});

test('nur das obere Stapelende ist gerundet, die Basislinie bleibt flach', () => {
  const svg = render([day(0, 1000, 500)]);
  const [lower, upper] = nodesOfType(svg, 'path');
  // Q = Rundung. Das untere Segment hat r=0, seine Q-Kontrollpunkte fallen zusammen.
  assert.ok(upper.attrs.d.includes('Q'), 'oberes Segment sollte gerundet sein');
  assert.match(upper.attrs.d, /V(\d|\.)+ Q/, 'Rundung sitzt am Datenende');
  const lowerRadius = lower.attrs.d.match(/H([-\d.]+)/);
  assert.ok(lowerRadius, 'unteres Segment hat eine flache Oberkante');
});

test('bei einem einzigen sichtbaren Segment wird dieses gerundet (keine Luecke ins Leere)', () => {
  const svg = render([day(0, 1000, 0)]);
  const paths = nodesOfType(svg, 'path');
  assert.equal(paths.length, 1, 'ein Segment mit Wert 0 wird nicht gezeichnet');
  assert.ok(paths[0].attrs.d.includes('Q'), 'das einzige Segment ist das oberste und damit gerundet');
});

test('Direktlabels werden ausgeduennt, wenn die Balken zu dicht stehen', () => {
  const many = Array.from({ length: 30 }, (_, i) => day(i, 900, 200));
  const svg = render(many);
  const { W, PAD } = CHART_BOX;
  const step = (W - PAD.left - PAD.right) / many.length;
  assert.ok(step < MIN_LABEL_PX, 'Testvoraussetzung: 30 Balken stehen enger als das Labelbudget');

  // x-Achsenlabels sitzen am unteren Rand; ihr Abstand muss das Budget einhalten
  const axis = nodesOfType(svg, 'text')
    .filter((t) => t.attrs.class === 'axis-label' && t.attrs['text-anchor'] === 'middle')
    .map((t) => Number(t.attrs.x))
    .sort((a, b) => a - b);

  assert.ok(axis.length < many.length, `es sollten nicht alle ${many.length} Labels gezeichnet werden`);
  for (let i = 1; i < axis.length; i++) {
    assert.ok(axis[i] - axis[i - 1] >= MIN_LABEL_PX - 0.01,
      `Labels kollidieren: Abstand ${(axis[i] - axis[i - 1]).toFixed(1)}px < ${MIN_LABEL_PX}px`);
  }
});

test('bei wenigen Balken wird jedes Label gezeichnet', () => {
  const svg = render([day(0, 100, 50), day(1, 200, 60), day(2, 150, 40)]);
  const axis = nodesOfType(svg, 'text').filter((t) => t.attrs.class === 'axis-label' && t.attrs['text-anchor'] === 'middle');
  assert.equal(axis.length, 3);
});

test('stackedBars vertraegt Nullwerte ohne NaN in der Geometrie', () => {
  const svg = render([day(0, 0, 0), day(1, 0, 0)]);
  for (const node of flatten(svg)) {
    for (const [key, value] of Object.entries(node.attrs ?? {})) {
      assert.ok(!String(value).includes('NaN'), `${node.tag}.${key} enthaelt NaN: ${value}`);
    }
    if (node.attrs?.d) assert.ok(!node.attrs.d.includes('Infinity'), 'Pfad enthaelt Infinity');
  }
});

test('genau ein Summenlabel pro beschriftetem Balken, nicht eines pro Segment', () => {
  const svg = render([day(0, 800, 200), day(1, 900, 300)]);
  const totals = nodesOfType(svg, 'text').filter((t) => t.attrs.class === 'bar-total');
  assert.equal(totals.length, 2, 'ein Label pro Balken');
  assert.equal(totals[0].textContent, '1.0k');
});
