// memory.js - a memory stream in the style of "Generative Agents" (Park et al., Stanford 2023).
// Every observation is stored with a time and an importance (1-10, rated by the model).
// Each turn, the most useful older memories are retrieved by recency + importance + relevance.
// Relevance uses embeddings when available, otherwise word overlap.

const STOP = new Set('a an the and or but of to in on at for with is are was were be been i you he she it they we my your his her its their our me him them this that there here as by from up down out about into over then than so just very not no yes do did does have has had what who'.split(' '));

export function words(text) {
  return new Set(String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
}

function lexical(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.sqrt(a.size * b.size);
}

function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}

// Rough importance before the model has rated a memory.
export function guessImportance(text) {
  const t = text.toLowerCase();
  if (/died|collapsed|dead/.test(t)) return 9;
  if (/said to you|player/.test(t)) return 5;
  if (/you said|answered/.test(t)) return 4;
  if (/wanted to|walked to|arrived|waited|sat on|stopped walking/.test(t)) return 2;
  return 3;
}

export class MemoryStream {
  constructor() {
    this.items = [];   // {id, text, t (game seconds), kind: 'event'|'insight', importance, scored, emb}
    this.nextId = 1;
  }

  add(text, t, kind = 'event', importance = null) {
    const m = { id: this.nextId++, text, t, kind, importance: importance ?? guessImportance(text), scored: importance != null, emb: null, words: words(text) };
    this.items.push(m);
    return m;
  }

  unscored(max = 8) { return this.items.filter((m) => !m.scored).slice(0, max); }
  unembedded(max = 32) { return this.items.filter((m) => !m.emb).slice(-max); }

  // Top-k memories for a query, skipping the newest `skipRecent` events (already shown).
  // score = recency + importance + relevance, each normalised to 0..1 (as in the paper).
  retrieve({ query, queryEmb = null, now, k = 8, skipRecent = 12 }) {
    const recentEvents = this.items.filter((m) => m.kind === 'event').slice(-skipRecent);
    const skip = new Set(recentEvents.map((m) => m.id));
    const pool = this.items.filter((m) => !skip.has(m.id));
    if (!pool.length) return [];
    const qw = words(query);
    const rows = pool.map((m) => ({
      m,
      recency: Math.pow(0.995, Math.max(0, now - m.t) / 60 * 10),   // decays over game minutes
      importance: m.importance / 10,
      relevance: queryEmb && m.emb ? cosine(queryEmb, m.emb) : lexical(qw, m.words),
    }));
    for (const key of ['recency', 'importance', 'relevance']) {
      const vals = rows.map((r) => r[key]), lo = Math.min(...vals), hi = Math.max(...vals);
      for (const r of rows) r[key + 'N'] = hi > lo ? (r[key] - lo) / (hi - lo) : 0.5;
    }
    for (const r of rows) r.score = r.recencyN + r.importanceN + r.relevanceN;
    return rows.sort((a, b) => b.score - a.score).slice(0, k).sort((a, b) => a.m.t - b.m.t);
  }

  toJSON() { return this.items.map(({ id, text, t, kind, importance, scored }) => ({ id, text, t, kind, importance, scored })); }
  load(arr) {
    this.items = (arr || []).map((m) => ({ ...m, emb: null, words: words(m.text) }));
    this.nextId = this.items.reduce((a, m) => Math.max(a, m.id), 0) + 1;
  }
}
