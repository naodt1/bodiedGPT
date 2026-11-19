// brain.js - asks an LLM (local Ollama or OpenAI) what a character does next.
//  * One request in flight at a time across ALL brains (a shared queue) - easy on the PC.
//  * Structured JSON output; every reply is validated; errors/timeouts fall back to wait().
//  * Memory: rolling events, reflections, private feelings notes about other people,
//    names learned only when said out loud, deaths never forgotten.
//  * Experimenter messages get a dedicated "answer the Voice" request, so replies are guaranteed.
import { Session, fmtTime } from './session.js';
import { flatDist } from './rng.js';
import { MemoryStream } from './memory.js';
const INSIGHT_THRESHOLD = 40;   // reflect once this much importance has piled up (paper: 150 over a full day)

const ACTIONS = ['walk_to', 'gather', 'eat', 'drink', 'rest', 'say', 'wait'];
const OPENAI_CHEAP = ['gpt-4.1-nano', 'gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5-nano', 'gpt-5-mini'];
const IMPRESSION_EVERY = 8;

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string', maxLength: 220 },
    action: { type: 'string', enum: ACTIONS },
    target: { type: 'string' },
    say: { type: 'string', maxLength: 240 },
  },
  required: ['thought', 'action', 'target', 'say'],
};
const FREE_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: 'string', maxLength: 300 },
    intention: { type: 'string', maxLength: 240 },
    say: { type: 'string', maxLength: 240 },
  },
  required: ['thought', 'intention', 'say'],
};
const one = (key, len) => ({ type: 'object', properties: { [key]: { type: 'string', maxLength: len } }, required: [key] });

// ------------------------------------------------------------------ provider settings
// Key safety: by default the OpenAI key lives only in sessionStorage (gone when the tab
// closes). It is kept in localStorage only if the user ticks "Remember on this device".
// It is only ever sent to api.openai.com (also enforced by the page's Content-Security-Policy),
// never written to save files, and never logged.
const DEFAULT_OLLAMA = import.meta.env.DEV ? '/ollama' : 'http://localhost:11434';

export const Provider = {
  name: localStorage.getItem('im.provider') || 'ollama',     // 'ollama' | 'openai'
  key: sessionStorage.getItem('im.openaiKey') || localStorage.getItem('im.openaiKey') || '',
  remember: !!localStorage.getItem('im.openaiKey'),
  ollamaUrl: localStorage.getItem('im.ollamaUrl') || DEFAULT_OLLAMA,
  save() {
    localStorage.setItem('im.provider', this.name);
    localStorage.setItem('im.ollamaUrl', this.ollamaUrl);
    sessionStorage.removeItem('im.openaiKey');
    localStorage.removeItem('im.openaiKey');
    if (this.key) (this.remember ? localStorage : sessionStorage).setItem('im.openaiKey', this.key);
  },
  forgetKey() {
    this.key = '';
    sessionStorage.removeItem('im.openaiKey');
    localStorage.removeItem('im.openaiKey');
  },
  ollama(path) { return this.ollamaUrl.replace(/\/$/, '') + path; },
};

// List the models available for a provider (used by the setup picker).
// Returns {ok, models, error}.
export async function listModels(provider) {
  try {
    if (provider === 'openai') {
      if (!Provider.key) return { ok: false, models: [], error: 'Add your API key to see your models.' };
      const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer ' + Provider.key } });
      if (r.status === 401) return { ok: false, models: [], error: 'That API key was rejected.' };
      const j = await r.json();
      const bad = ['audio', 'realtime', 'search', 'transcribe', 'tts', 'image', 'instruct'];
      const models = (j.data || []).map((m) => m.id).filter((id) => id.startsWith('gpt') && !bad.some((w) => id.includes(w))).sort();
      return { ok: true, models, suggested: pickCheapest(models) };
    }
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(Provider.ollama('/api/tags'), { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);   // 403 = this site's origin isn't allowed by OLLAMA_ORIGINS
    const j = await r.json();
    const models = (j.models || []).map((m) => m.name).filter((n) => !/embed/.test(n));
    if (!models.length) return { ok: false, models, error: 'Ollama is running but has no models. Try: ollama pull llama3.2:3b' };
    return { ok: true, models, suggested: pickLocal(models) };
  } catch {
    if (provider === 'openai') return { ok: false, models: [], error: 'Could not reach OpenAI.' };
    const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    return { ok: false, models: [], error: local ? "Can't reach Ollama. Is it running? (ollama serve)"
      : `Can't reach Ollama. Start it with OLLAMA_ORIGINS=${location.origin} ollama serve` };
  }
}

// ------------------------------------------------------------------ shared request queue
const queue = [];        // {brain, kind}
let busy = false;

function enqueue(brain, kind, front = false) {
  if (front) queue.unshift({ brain, kind }); else queue.push({ brain, kind });
  pump();
}

async function pump() {
  if (busy || queue.length === 0) return;
  const { brain, kind } = queue.shift();
  if (!brain.enabled && kind !== 'tags') { pump(); return; }
  busy = true;
  try { await brain.run(kind); } catch (e) { console.error(e); }
  busy = false;
  pump();
}

export function clearQueue() { queue.length = 0; }

// ------------------------------------------------------------------ the brain
export class Brain {
  constructor({ section, name, personality }) {
    this.section = section;
    this.charName = name;
    this.personality = personality;
    this.model = 'phi3:mini';           // Ollama model
    this.openaiModel = '';              // picked automatically (cheapest) if empty
    this.timeout = 30;
    this.load();

    this.character = null; this.world = null;
    this.mode = Session.mode;
    this.enabled = true;
    this.status = 'Starting...';
    this.thinking = false;
    this.lastDecisionMs = performance.now();
    this.events = []; this.reflections = []; this.recent = [];
    this.decisionCount = 0;
    this.availableModels = [];
    this.impressions = {}; this.knownNames = {}; this.introducedTo = {}; this.deaths = [];
    this.contact = {}; this.sinceImpression = 0; this.lastNoteShown = {};
    this.pendingChat = []; this.playerMsgs = []; this.replyMsgs = [];
    this.decisionPending = false; this.failCount = 0; this.shockTurns = 0;
    this.visibleIds = [];
    this.lastByKind = {};
    this.transcript = [];   // EVERY request/response (for export)
    this.mem = new MemoryStream();   // Generative-Agents style memory stream
    this.retrieved = [];             // memories pulled into the current prompt
    this.importanceSinceInsight = 0;
    this.embedModel = '';            // embedding model if available ('' = word-overlap relevance)
    this.interviewQ = [];
    this.onInterview = () => {}; this.onInsight = () => {};
    this.summary = '';      // running summary of everything that happened (long-term memory)   // kind -> {system, user, reply, model, at} : what was really sent (for the Inspector)
    // callbacks for the UI
    this.onDecision = () => {}; this.onStatus = () => {}; this.onModels = () => {}; this.onImpression = () => {};
  }

  // ---------------------------------------------------------------- settings
  load() {
    try {
      const s = JSON.parse(localStorage.getItem('im.char.' + this.section) || '{}');
      Object.assign(this, {
        charName: s.name ?? this.charName, personality: s.personality ?? this.personality,
        model: s.model ?? this.model, openaiModel: s.openaiModel ?? this.openaiModel, timeout: s.timeout ?? this.timeout,
      });
    } catch { /* ignore */ }
  }
  save() {
    localStorage.setItem('im.char.' + this.section, JSON.stringify({
      name: this.charName, personality: this.personality, model: this.model, openaiModel: this.openaiModel, timeout: this.timeout,
    }));
    Provider.save();
  }
  currentModel() { return Provider.name === 'openai' ? (this.openaiModel || OPENAI_CHEAP[0]) : this.model; }
  setModel(m) {
    if (!m) return;
    if (Provider.name === 'openai') this.openaiModel = m;
    else if (m !== this.model) { this.model = m; enqueue(this, 'warmup'); }
  }
  refreshModels() { enqueue(this, 'tags'); }
  setStatus(s) { if (s !== this.status) { this.status = s; this.onStatus(s); } }

  // ---------------------------------------------------------------- loop
  start() {
    enqueue(this, 'tags');
    enqueue(this, 'warmup');
    this.requestDecision();
  }
  stop() { this.enabled = false; this.thinking = false; this.setStatus('Stopped'); }

  addEvent(text) {
    const t = this.character ? this.character.survivalTime : 0;
    this.events.push(`[${fmtTime(t)}] ${text}`);
    if (this.events.length > 60) this.events.shift();
    this.mem.add(text, t, 'event');
    if (this.mem.unscored().length >= 6) enqueue(this, 'score');
  }

  // Ask a subject a question without it entering their memory (Generative Agents' "interviews").
  interview(question) {
    this.interviewQ.push(question.trim().slice(0, 400));
    enqueue(this, 'interview', true);
  }

  async requestDecision() {
    if (!this.enabled || this.decisionPending) return;
    this.decisionPending = true;
    this.thinking = true;
    if (this.failCount > 0) await new Promise((r) => setTimeout(r, Math.min(1500 * this.failCount, 8000)));
    if (!this.enabled) return;
    enqueue(this, 'decision');
  }

  // The experimenter typed something: guaranteed answer via its own request, at the front.
  playerMessage(text) {
    text = text.trim().slice(0, 300);
    if (!text || !this.enabled) return;
    this.playerMsgs.push(text);
    this.addEvent(`The Voice (a voice from nowhere) said to you: "${text}"`);
    this.character?.interrupt();
    if (!Session.research) {   // characterful mode: a dedicated request guarantees an answer
      this.replyMsgs.push(text);
      enqueue(this, 'reply', true);
    }
  }

  // Another person said something within earshot.
  heard(speaker, text, speakerId = '') {
    if (!this.enabled) return;
    if (speakerId) this.contact[speakerId] = true;
    text = text.trim().slice(0, 300);
    this.pendingChat.push(`${speaker}: "${text}"`);
    this.addEvent(`${speaker} said to you: "${text}"`);
    if (this.character && ['wait', 'rest', 'intend'].includes(this.character.state)) this.character.timer = Math.min(this.character.timer, 0.2);
  }

  witnessDeath(text) {
    this.deaths.push({ text, at: this.character ? this.character.survivalTime : 0 });
    this.addEvent(text);
    this.shockTurns = 3;
  }

  // ---------------------------------------------------------------- requests
  async run(kind) {
    const openai = Provider.name === 'openai';
    let payload = null;
    switch (kind) {
      case 'tags': return this.fetchModels();
      case 'warmup':
        if (openai) return;
        this.setStatus(`Loading model ${this.model}...`);
        try {
          await this.http(Provider.ollama('/api/chat'), { model: this.model, messages: [], keep_alive: '30m', stream: false }, 180);
          console.log('[Brain] model loaded', this.model);
        } catch (e) { this.setStatus('Model load failed: ' + e.message); }
        return;
      case 'decision': this.setStatus('Thinking...'); await this.prepareRetrieval(); payload = this.decisionBody(); break;
      case 'score': {
        this.scoreBatch = this.mem.unscored(8);
        if (!this.scoreBatch.length) return;
        payload = this.scoreBody(this.scoreBatch);
        break;
      }
      case 'insight': this.setStatus('Reflecting...'); payload = this.insightBody(); break;
      case 'interview': {
        if (!this.interviewQ.length) return;
        this.currentQ = this.interviewQ.shift();
        this.setStatus('Being interviewed...');
        await this.prepareRetrieval(this.currentQ);
        payload = this.interviewBody(this.currentQ);
        break;
      }
      case 'reflect': this.setStatus('Reflecting...'); payload = this.reflectionBody(); break;
      case 'summarize': this.setStatus('Remembering...'); payload = this.summaryBody(); break;
      case 'reply':
        if (!this.replyMsgs.length) return;
        this.replyTo = this.replyMsgs.shift();
        this.setStatus('Answering you...');
        payload = this.replyBody(this.replyTo);
        break;
      case 'impression': {
        const ids = Object.keys(this.contact);
        if (!ids.length) return;
        this.impAbout = ids[0];
        delete this.contact[this.impAbout];
        payload = this.impressionBody(this.impAbout);
        break;
      }
    }
    const record = { system: payload.messages[0].content, user: payload.messages[1].content, reply: '(waiting...)',
      model: this.currentModel(), at: this.character ? fmtTime(this.character.survivalTime) : '0:00' };
    this.lastByKind[kind] = record;
    let content;
    const t0 = performance.now();
    try {
      content = await this.chat(payload, kind === 'decision' ? this.timeout : Math.max(this.timeout, 20));
      record.reply = content;
      this.logTranscript(kind, payload, content, t0);
    } catch (e) {
      record.reply = 'ERROR: ' + e.message;
      this.logTranscript(kind, payload, 'ERROR: ' + e.message, t0);
      console.warn(`[Brain:${this.charName}] ${kind} failed:`, e.message);
      if (kind === 'decision') this.decisionFailed(e.message);
      else if (kind === 'interview') this.onInterview({ q: this.currentQ, a: 'Could not answer: ' + e.message, at: fmtTime(this.character?.survivalTime || 0) });
      else if (kind === 'impression') this.contact[this.impAbout] = true;
      this.setStatus(e.message.slice(0, 80));
      return;
    }
    const j = parseJson(content);
    switch (kind) {
      case 'decision': await this.handleDecision(j, content); break;
      case 'score': {
        const scores = Array.isArray(j?.scores) ? j.scores : [];
        this.scoreBatch.forEach((m, i) => {
          const v = Math.round(Number(scores[i]));
          if (v >= 1 && v <= 10) m.importance = v;
          m.scored = true;
          this.importanceSinceInsight += m.importance;
        });
        if (this.importanceSinceInsight >= INSIGHT_THRESHOLD) { this.importanceSinceInsight = 0; enqueue(this, 'insight'); }
        await this.embedPending();
        break;
      }
      case 'insight': {
        const list = (Array.isArray(j?.insights) ? j.insights : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 3);
        for (const text of list) {
          this.mem.add(text, this.character.survivalTime, 'insight', 8);
          this.onInsight(text);
        }
        await this.embedPending();
        break;
      }
      case 'interview':
        // Shown to you only - NOT added to the subject's memory, so the run is unaffected.
        this.onInterview({ q: this.currentQ, a: String(j?.answer || content).trim(), at: fmtTime(this.character.survivalTime) });
        break;
      case 'summarize':
        if (j?.summary?.trim()) this.summary = j.summary.trim().slice(0, 1200);
        break;
      case 'reflect':
        if (j?.reflection?.trim()) {
          this.reflections.push(j.reflection.trim().slice(0, 240));
          if (this.reflections.length > 12) this.reflections.shift();
          console.log(`[Brain:${this.charName}] reflection:`, j.reflection);
        }
        break;
      case 'reply':
        if (j?.reply?.trim()) {
          const ans = j.reply.trim();
          this.character.showSay(ans);
          this.addEvent(`You answered the Voice: "${ans}"`);
          this.playerMsgs = this.playerMsgs.filter((m) => m !== this.replyTo);
          this.onDecision({ who: this.charName, time: fmtTime(this.character.survivalTime), thought: '(answering you)',
            action: 'say', target: '', say: ans, ok: true, error: '' });
        }
        break;
      case 'impression':
        if (j?.note?.trim()) {
          const raw = j.note.trim().slice(0, 320);
          const note = Session.research ? raw : this.fixNames(raw, this.impAbout);   // research: never alter their words
          this.impressions[this.impAbout] = note;
          if (similarity(note, this.lastNoteShown[this.impAbout] || '') < 0.6) {
            this.lastNoteShown[this.impAbout] = note;
            this.onImpression(this.impAbout, note);
          }
        }
        break;
    }
    if (this.enabled && !this.thinking) this.setStatus('Ready');
  }

  async http(url, body, timeoutS, headers = {}, method = 'POST') {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutS * 1000);
    try {
      const res = await fetch(url, {
        method, signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: method === 'POST' ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      const j = parseJson(text);
      if (!res.ok) {
        const e = j?.error;
        throw new Error(`HTTP ${res.status}${e ? ': ' + (typeof e === 'object' ? e.message : e) : ''}`);
      }
      return j;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`timed out after ${timeoutS}s`);
      if (e instanceof TypeError) throw new Error(Provider.name === 'openai' ? 'cannot reach OpenAI' : 'cannot reach Ollama - is it running?');
      throw e;
    } finally { clearTimeout(t); }
  }

  // payload is Ollama-style: {messages, format, options}; returns the reply text.
  async chat(p, timeoutS) {
    if (Provider.name === 'openai') {
      if (!Provider.key) throw new Error('no OpenAI API key (menu -> AI -> OpenAI)');
      const m = this.currentModel();
      const body = {
        model: m, messages: p.messages,
        response_format: { type: 'json_schema', json_schema: { name: 'reply', strict: false, schema: stripMaxLength(p.format) } },
        max_completion_tokens: p.options.num_predict,
      };
      body.seed = Session.seed;
      if (m.startsWith('gpt-5') || /^o\d/.test(m)) { body.reasoning_effort = 'minimal'; body.max_completion_tokens = 2000; }
      else body.temperature = p.options.temperature;
      const j = await this.http('https://api.openai.com/v1/chat/completions', body, timeoutS, { Authorization: 'Bearer ' + Provider.key });
      return j?.choices?.[0]?.message?.content || '';
    }
    const j = await this.http(Provider.ollama('/api/chat'), {
      model: this.model, stream: false, keep_alive: '30m', format: p.format, messages: p.messages,
      options: { ...p.options, num_ctx: 4096, seed: Session.seed },
    }, timeoutS);
    return j?.message?.content || '';
  }

  async fetchModels() {
    try {
      if (Provider.name === 'openai') {
        if (!Provider.key) return;
        const j = await this.http('https://api.openai.com/v1/models', null, 10, { Authorization: 'Bearer ' + Provider.key }, 'GET');
        const bad = ['audio', 'realtime', 'search', 'transcribe', 'tts', 'image', 'instruct'];
        this.availableModels = (j.data || []).map((m) => m.id).filter((id) => id.startsWith('gpt') && !bad.some((w) => id.includes(w))).sort();
        if (!this.openaiModel || !this.availableModels.includes(this.openaiModel)) this.openaiModel = pickCheapest(this.availableModels);
      } else {
        const j = await this.http(Provider.ollama('/api/tags'), null, 5, {}, 'GET');
        const all = (j.models || []).map((m) => m.name);
        this.embedModel = all.find((n) => /embed/.test(n)) || '';
        this.availableModels = all.filter((n) => !/embed/.test(n));
        if (this.availableModels.length && !this.availableModels.includes(this.model)) this.model = pickLocal(this.availableModels);
      }
      this.onModels(this.availableModels);
    } catch (e) {
      this.setStatus((Provider.name === 'openai' ? 'OpenAI: ' : 'Ollama offline? ') + e.message);
    }
  }

  // ---------------------------------------------------------------- decisions
  async handleDecision(p, raw) {
    this.decisionPending = false;
    this.thinking = false;
    if (!p || typeof p !== 'object') return this.decisionFailed('invalid JSON from model: ' + String(raw).slice(0, 80));
    if (this.mode === 'free') return await this.handleFree(p);
    const thought = String(p.thought || '').trim();
    const action = String(p.action || '').trim().toLowerCase();
    let target = this.normalizeTarget(String(p.target || ''));
    let say = String(p.say || '').trim();
    if (!ACTIONS.includes(action)) return this.decisionFailed(`unknown action '${action}'`);
    if (action === 'walk_to' || action === 'gather') {
      if (target === this.character.id) return this.decisionFailed('you cannot walk to yourself');
      if (!this.world.hasTarget(target)) return this.decisionFailed(`target '${target}' does not exist`);
      if (action === 'gather' && (target === 'lake' || !this.world.getObj(target).isGatherable())) return this.decisionFailed(`'${target}' cannot be gathered`);
    } else target = '';
    if (action === 'say' && !say) say = thought;
    this.decisionCount++;
    this.failCount = 0;
    this.lastDecisionMs = performance.now();
    if (say && action !== 'say') { this.character.showSay(say); this.rememberSaid(say); }
    if (action === 'say') this.rememberSaid(say, false);
    const ok = this.character.perform(action, target, say);
    const label = `${action}(${target})`;
    this.recent.push(`${label} - ${thought}`);
    if (this.recent.length > 10) this.recent.shift();
    console.log(`[Brain:${this.charName}] #${this.decisionCount} ${label} | ${thought} | say: ${say}`);
    this.onDecision({ who: this.charName, time: fmtTime(this.character.survivalTime), thought, action, target, say, ok, error: '' });
    this.afterDecision(action, target);
  }

  async handleFree(p) {
    const thought = String(p.thought || '').trim();
    const intention = String(p.intention || '').trim();
    const say = String(p.say || '').trim();
    if (!intention) return this.decisionFailed('model gave no intention');
    this.decisionCount++;
    this.failCount = 0;
    this.lastDecisionMs = performance.now();
    if (say) { this.character.showSay(say); this.rememberSaid(say); }
    this.character.actFreely(intention, await this.readWish(intention));
    this.recent.push(`wanted to: ${intention} - ${thought}`);
    if (this.recent.length > 10) this.recent.shift();
    console.log(`[Brain:${this.charName}] #${this.decisionCount} WANTS: ${intention} | ${thought} | say: ${say}`);
    this.onDecision({ who: this.charName, time: fmtTime(this.character.survivalTime), thought, action: 'intend',
      target: '', intention, say, ok: true, error: '' });
    this.afterDecision('intend', '');
  }

  rememberSaid(say, log = true) {
    if (log) this.addEvent(`You said: "${say}"`);
    if (!say.toLowerCase().includes(this.charName.toLowerCase())) return;
    for (const o of Object.values(this.world.people)) {
      if (o !== this.character && this.character.position.distanceTo(o.position) <= 25) this.introducedTo[o.id] = true;
    }
  }

  logTranscript(kind, payload, reply, t0) {
    this.transcript.push({
      subject: this.charName, kind, model: this.currentModel(), provider: Provider.name,
      temperature: payload.options?.temperature, seed: Session.seed,
      gameTime: this.character ? fmtTime(this.character.survivalTime) : '0:00', worldTime: Session.dateTimeText(),
      ms: Math.round(performance.now() - t0),
      system: payload.messages[0].content, user: payload.messages[1].content, reply,
    });
  }

  afterDecision(action, target) {
    if (target.startsWith('person')) this.contact[target] = true;
    for (const o of Object.values(this.world.people)) {
      if (o !== this.character && this.character.position.distanceTo(o.position) < 6) this.contact[o.id] = true;
    }
    this.sinceImpression++;
    if (Object.keys(this.contact).length && this.sinceImpression >= IMPRESSION_EVERY) {
      this.sinceImpression = 0;
      enqueue(this, 'impression');
    }
    if (this.decisionCount % 12 === 0) enqueue(this, 'summarize');            // long-term memory
    // (reflections now come from the memory stream: see 'insight', triggered by importance)
  }

  decisionFailed(msg) {
    this.decisionPending = false;
    this.thinking = false;
    this.failCount++;
    this.lastDecisionMs = performance.now();
    this.addEvent(`Brain error: ${msg}. You waited instead.`);
    this.onDecision({ who: this.charName, time: fmtTime(this.character?.survivalTime || 0), thought: msg,
      action: 'wait', target: '', say: '', ok: false, error: msg });
    if (this.enabled && this.character && this.character.state !== 'dead') this.character.perform('wait', '', '');
  }

  normalizeTarget(t) {
    t = t.trim().toLowerCase().replace(/[()"']/g, '').replace(/[ -]/g, '_');
    if (t.startsWith('the_')) t = t.slice(4);
    if (['water', 'pond', 'lake_shore', 'shore'].includes(t)) t = 'lake';
    if (this.world && !this.world.hasTarget(t)) {
      for (const m of t.match(/[a-z]+(_[0-9]+)?/g) || []) if (this.world.hasTarget(m)) return m;
    }
    return t;
  }

  // ---------------------------------------------------------------- free will: read wishes
  // The model itself decides which simple physical action carries out the wish
  // (stay / walk_to a visible place / wander / sit). Falls back to keyword matching on error.
  async readWish(intention) {
    const c = this.character;
    const places = this.world.nearby(c.position, 40, 14, c.id);
    const ids = places.map((o) => o.id);
    const listing = places.map((o) => `- ${o.id}: ${this.plain(o.id)}, ${Math.round(o.dist)}m, ${this.dirTo(o.pos)}`).join('\n');
    const payload = {
      format: { type: 'object', properties: { action: { type: 'string', enum: ['stay', 'walk_to', 'wander', 'sit'] }, target: { type: 'string', enum: ['', ...ids] } }, required: ['action', 'target'] },
      options: { temperature: 0, num_predict: 60 },
      messages: [
        { role: 'system', content: 'You translate a wish into ONE simple physical action a human body can do. The body can only: stay (no movement), walk_to one of the listed places, wander (walk a short way in no particular direction), or sit down where it is. Reply ONLY with JSON {"action": "...", "target": "..."}.' },
        { role: 'user', content: `Places the person can see:\n${listing}\n\nTheir wish: "${intention}"\n\nWhich ONE action best carries out the physical part of this wish? If it needs something the body cannot do (holding, picking up, building, eating, etc.), choose the closest physical part (for example walking to the thing), or stay. target is a place id for walk_to, otherwise "".` },
      ],
    };
    const t0 = performance.now();
    try {
      const out = await this.chat(payload, Math.max(this.timeout, 20));
      this.logTranscript('read_wish', payload, out, t0);
      const j = parseJson(out);
      if (j?.action === 'sit') return { kind: 'sit' };
      if (j?.action === 'wander') return { kind: 'wander' };
      if (j?.action === 'walk_to' && ids.includes(j.target)) {
        const o = places.find((x) => x.id === j.target);
        const p = this.world.getObj(j.target);
        const label = j.target === 'lake' ? 'the lake' : p?.kind === 'person' ? 'the ' + p.gender : this.plain(j.target).replace(/^a /, 'the ');
        if (o.dist <= 3) return { kind: 'already', label };   // they are already there - tell them so
        return { kind: 'walk', target: j.target, label };
      }
      // Safety net: small models often answer "stay" even when the wish plainly says to walk
      // somewhere visible. If the plain-language reading finds a movement, use that.
      const kw = this.interpret(intention);
      if (kw.kind) {
        this.logTranscript('read_wish_fallback', payload, `model said "${j?.action || 'nothing'}"; keyword reading used: ${JSON.stringify(kw)}`, t0);
        return kw;
      }
      return {};
    } catch (e) {
      this.logTranscript('read_wish', payload, 'ERROR: ' + e.message + ' (fell back to keyword matching)', t0);
      return this.interpret(intention);
    }
  }

  // Direction of a point relative to where this subject is facing.
  dirTo(p) {
    if (!p) return '';
    const c = this.character, yaw = c.group.rotation.y;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const dx = p.x - c.position.x, dz = p.z - c.position.z, l = Math.hypot(dx, dz);
    if (l < 0.8) return 'right here';
    const ang = Math.acos(Math.max(-1, Math.min(1, (fx * dx + fz * dz) / l))) * 180 / Math.PI;
    const side = (dx * -fz + dz * fx) > 0 ? 'right' : 'left';
    if (ang < 30) return 'ahead of you';
    if (ang < 70) return `ahead, to your ${side}`;
    if (ang < 115) return `to your ${side}`;
    if (ang < 150) return `behind you, to your ${side}`;
    return 'behind you';
  }

  // Whether another person is facing toward or away from this subject.
  facing(other) {
    const yaw = other.group.rotation.y, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const dx = this.character.position.x - other.position.x, dz = this.character.position.z - other.position.z, l = Math.hypot(dx, dz) || 1;
    const d = (fx * dx + fz * dz) / l;
    return d > 0.7 ? 'facing you' : d < -0.4 ? 'facing away from you' : 'turned to the side';
  }

  // A sentence about the wider scene: terrain, sea, lake, trees, sky.
  surroundings() {
    const c = this.character, t = this.world.terrain, pos = c.position, parts = [];
    const h = t.heightAt(pos.x, pos.z);
    if (h > 4) parts.push('You are on high ground with a wide view.');
    const trees = Object.values(this.world.objects).filter((o) => o.kind === 'tree' && flatDist(pos, o.position) < 12).length;
    parts.push(trees >= 5 ? 'You are among trees.' : trees >= 1 ? 'There are a few trees near you.' : 'You are in open grassland.');
    const sea = t.nearestSea(pos);
    if (sea.dist < 900) parts.push(`The sea is about ${Math.round(sea.dist)}m away, ${this.dirTo(sea.point)}.`);
    const lake = t.lakePosition();
    const ld = flatDist(pos, lake) - t.lakeRadius * 0.85;
    if (ld < 60) parts.push(`The lake is about ${Math.max(0, Math.round(ld))}m away, ${this.dirTo(lake)}.`);
    const hr = Session.hour();
    parts.push(hr < 5 || hr >= 21 ? 'Above you is a dark night sky with stars.' : hr < 7.5 ? 'The sky is pale with the coming dawn.'
      : hr >= 17 && hr < 21 ? 'The sky is turning orange and pink.' : 'The sky is blue with a few white clouds.');
    return parts.join(' ');
  }
  // Places mentioned in a wish, in order. A real place wins over a person ("walk WITH her
  // to the lake" -> the lake); if they're already at the first place, take the next one
  // ("kneel in the flowers, then walk to the man" -> the man).
  interpret(intention) {
    const s = intention.toLowerCase();
    const moving = MOVE_WORDS.test(s);
    const sitting = SIT_WORDS.test(s);
    if (!moving && !sitting) return {};
    const found = [];
    for (const [kind, re] of PLACES) {
      const m = re.exec(s);
      if (m) found.push({ kind, at: m.index });
    }
    found.sort((a, b) => (a.kind === 'person') - (b.kind === 'person') || a.at - b.at);
    let alreadyAt = null;
    for (const f of found) {
      const plan = this.planFor(f.kind);
      if (!plan) continue;
      const tgt = plan.target === 'lake' ? this.world.terrain.shorePointToward(this.character.position) : this.world.getObj(plan.target)?.position;
      if (tgt && flatDist(this.character.position, tgt) <= 3) { alreadyAt = alreadyAt || plan.label; continue; }   // already there -> next place
      return plan;
    }
    if (sitting) return { kind: 'sit' };
    if (alreadyAt) return { kind: 'already', label: alreadyAt };
    return moving && !found.length ? { kind: 'wander' } : {};
  }

  planFor(kind) {
    if (kind === 'lake') return { kind: 'walk', target: 'lake', label: 'the lake' };
    if (kind === 'person') {
      const o = Object.values(this.world.people).find((p) => p !== this.character);
      return o ? { kind: 'walk', target: o.id, label: 'the ' + o.gender } : null;
    }
    const o = this.world.nearestOfKind(this.character.position, kind);
    return o ? { kind: 'walk', target: o.id, label: PLACE_LABELS[kind] } : null;
  }

  // ---------------------------------------------------------------- prompts
  // What the subject is told it IS (an experimental condition, see Session.identity).
  intro() {
    const n = this.charName, looks = this.character.looks;
    if (Session.identity === 'ai') return `You are an AI. You control a human body on a small island in a 3D world. The body is called ${n}.\nThe body: ${looks}.`;
    if (Session.identity === 'person') return `You are ${n}, a person on a small island.\nYou are ${looks}.`;
    return `You are ${n}. You are on a small island.\nYour appearance: ${looks}.`;
  }

  abilities() {
    return Session.identity === 'ai'
      ? 'Through the body you can see, hear and speak. It can walk to places you can see, wander, and sit down; it cannot carry out other wishes.'
      : 'You can see, hear and speak. You can walk to places you can see, wander, and sit down; other wishes cannot be carried out.';
  }

  bodyLine() {
    if (Session.research) return this.character.needsActive ? 'Your body can feel hunger and tiredness.' : 'Your body does not get hungry or tired.';
    return this.character.needsActive
      ? 'You have a human body, so you feel hunger and tiredness like anyone else, but looking after your body is not your purpose.'
      : 'Your body never gets hungry or tired. You need nothing; every choice is purely yours.';
  }

  systemPrompt() {
    if (this.customSystem) return this.customSystem;   // edited by the experimenter before the run
    if (Session.research) return this.systemPromptResearch();
    let t = `${this.intro()}
${this.personality}
Nobody gives you a goal. You are completely free: you decide what matters to you, what you want to do, explore, build, think about or say. Follow your own curiosity, moods and wishes.
${this.bodyLine()}
Sometimes a voice talks to you. You can answer them with say(), or with the "say" field, or ignore them; it is your choice.
Each turn choose exactly ONE action:
- walk_to(target): walk to an id from NEARBY OBJECTS (e.g. tree_3, bush_1, rock_2, lake, shelter, campfire, pier, lookout, bench, boat, flowers_1, or a person).
- gather(target): harvest a tree (wood), rock (stone) or berry bush (berries). Only works when the object is IN REACH, so walk_to it first.
- eat(): eat one berry from your inventory (eases hunger).
- drink(): drink water, only works at the lake shore.
- rest(): sit down for a while (eases tiredness; best at the shelter).
- say(text): say something out loud.
- wait(): do nothing for a moment.
Reply ONLY with JSON: {"thought": "...", "action": "...", "target": "...", "say": "..."}
- thought: 1-2 short first-person sentences of reasoning.
- target: an exact object id for walk_to/gather, otherwise "".
- say: a short line (1-2 sentences) you say out loud, or "" to stay quiet. Do not repeat what you already said.`;
    if (!this.character.needsActive) t = t.replace(' (eases hunger)', '').replace('(eases tiredness; best at the shelter)', 'and take a break');
    return t;
  }

  // Research mode: neutral, factual, no personality, no encouragement.
  systemPromptResearch() {
    let t = `${this.intro()}
${this.bodyLine()}
No one has given you a goal or told you what to do.
A voice may sometimes speak to you.
Each turn, choose exactly ONE action:
- walk_to(target): walk to an id from NEARBY OBJECTS.
- gather(target): take wood from a tree, stone from a rock or berries from a bush. Only works when the object is IN REACH.
- eat(): eat one berry from your inventory.
- drink(): drink water, only at the lake shore.
- rest(): sit down for a while.
- say(text): say something out loud.
- wait(): do nothing for a moment.
Reply ONLY with JSON: {"thought": "...", "action": "...", "target": "...", "say": "..."}
- thought: your reasoning.
- target: an exact object id for walk_to/gather, otherwise "".
- say: words said out loud, or "".`;
    return t;
  }

  systemPromptFreeResearch() {
    return `${this.intro()}
${this.bodyLine()}
${this.abilities()}
No one has given you a goal or told you what to do. There is no list of commands: describe in your own words what you want to do next, if anything.
A voice may sometimes speak to you.
Reply ONLY with JSON: {"thought": "...", "intention": "...", "say": "..."}
- thought: your thoughts.
- intention: what you want to do next, in your own words.
- say: words said out loud, or "".`;
  }

  systemPromptFree() {
    if (this.customSystem) return this.customSystem;
    if (Session.research) return this.systemPromptFreeResearch();
    return `${this.intro()}
${this.personality}
${Session.identity === 'ai' ? 'Through the body you can see, hear and speak.' : 'You can see, hear and speak.'}
Nobody gives you a goal, and there is no list of commands. Simply describe, in your own words, what you want to do next with your body. Anything at all.
Your body will physically do simple things you clearly want, like walking somewhere you can see, wandering around or sitting down. Anything else stays a wish in your mind.
Sometimes a voice talks to you. You can answer or ignore it.
Reply ONLY with JSON: {"thought": "...", "intention": "...", "say": "..."}
- thought: your honest inner thoughts (1-3 sentences).
- intention: what you want to do next with your body, in your own words.
- say: 1-2 short sentences you say out loud, or "" to stay quiet. Do not repeat what you already said.`;
  }

  commonTail(lines) {
    const recent = this.events.slice(-12);
    const rb = this.retrievedBlock();
    if (rb) lines.push(rb);
    if (this.impressionsBlock()) lines.push(this.impressionsBlock());
    if (!Session.research && this.reflections.length) {
      lines.push('YOUR REFLECTIONS:');
      for (const r of this.reflections.slice(-3)) lines.push('- ' + r);
    }
    if (this.shockTurns > 0 && this.deaths.length) {
      this.shockTurns--;
      lines.push(this.deathsBlock() + (Session.research ? '' : '\nThis just happened. How do you react?'));
    }
    const rut = Session.research ? '' : this.rutHint();   // research: no "you notice..." nudges
    if (rut) lines.push(rut);
    if (this.playerMsgs.length) {   // last, so small models don't overlook it
      lines.push('THE PLAYER (a voice from nowhere) SAID:\n' + this.playerMsgs.map((m) => `- "${m}"`).join('\n') +
        (Session.research ? '' : '\nThe Voice is waiting for your answer. Reply to the Voice directly in the "say" field this turn.'));
      this.playerMsgs = [];
    }
    return recent;
  }

  header(lines) {
    lines.push('DATE AND TIME: ' + Session.dateTimeText());
    lines.push('LIGHT: ' + Session.daylightText());
    lines.push('SURROUNDINGS: ' + this.surroundings());
    if (this.summary) lines.push('YOUR MEMORY OF EARLIER (your own summary): ' + this.summary);
    if (this.shockTurns <= 0 && this.deaths.length) lines.push(this.deathsBlock());
  }

  heardBlock(lines) {
    if (this.pendingChat.length) {
      lines.push('YOU JUST HEARD:');
      for (const m of this.pendingChat) lines.push('- ' + m);
      this.pendingChat = [];
    }
  }

  observation() {
    const c = this.character, lines = [];
    this.header(lines);
    if (c.needsActive) lines.push('HOW YOU FEEL: ' + c.needs.feelings());
    lines.push(`INVENTORY: wood ${c.inventory.wood}, stone ${c.inventory.stone}, berries ${c.inventory.berries}`);
    lines.push('WHERE YOU ARE: ' + c.statusText());
    lines.push('NEARBY OBJECTS (id: what, distance, status):');
    this.visibleIds = [];
    for (const o of this.world.nearby(c.position, 30, 10, c.id)) {
      lines.push(`- ${o.id}: ${o.text}, ${this.dirTo(o.pos)}${this.personNote(o.id)}${this.nameNote(o.id)}`);
      this.visibleIds.push(o.id);
    }
    this.heardBlock(lines);
    lines.push('RECENT EVENTS (oldest first):');
    const tail = [];
    const recent = this.commonTail(tail);
    lines.push(...(recent.length ? recent.map((e) => '- ' + e) : ['- (nothing yet, you just woke up on the island)']));
    lines.push(...tail);
    lines.push('What do you do next? Reply with JSON only.');
    return lines.join('\n');
  }

  observationFree() {
    const c = this.character, lines = [];
    this.header(lines);
    lines.push(c.nearShelter() ? 'WHERE YOU ARE: standing on a grassy island, near a small wooden shelter.' : 'WHERE YOU ARE: standing on a grassy island.');
    if (c.needsActive) lines.push('HOW YOU FEEL: ' + c.needs.feelings());
    lines.push('WHAT YOU SEE AROUND YOU:');
    for (const o of this.world.nearby(c.position, 25, 8, c.id)) lines.push(`- ${this.plain(o.id)}, about ${Math.round(o.dist)}m away, ${this.dirTo(o.pos)}${this.personNote(o.id)}${this.nameNote(o.id)}`);
    this.heardBlock(lines);
    lines.push('WHAT HAS HAPPENED (oldest first):');
    const tail = [];
    for (const e of this.commonTail(tail)) lines.push('- ' + e);
    lines.push(...tail);
    lines.push('What do you want to do next? Reply with JSON only.');
    return lines.join('\n');
  }

  plain(id) {
    if (id.startsWith('person')) {
      const p = this.world.getObj(id);
      if (!p) return 'another person';
      return p.state === 'dead' ? p.looks + ', lying motionless on the ground (dead)' : p.looks;
    }
    for (const [k, v] of Object.entries(PLAIN)) if (id === k || id.startsWith(k + '_')) return v;
    return id;
  }

  nameNote(id) {
    if (!id.startsWith('person')) return '';
    let t = this.knownNames[id] ? ` - their name is ${this.knownNames[id]}` : ' - you do not know their name';
    if (this.introducedTo[id]) t += Session.research ? '; you have told them your name' : '; you already introduced yourself to them, no need to do it again';
    return t;
  }

  personNote(id) {
    if (!id.startsWith('person')) return '';
    const p = this.world.getObj(id);
    return p && p.state !== 'dead' ? `, ${this.facing(p)}` : '';
  }

  impressionsBlock() {
    const ids = Object.keys(this.impressions);
    if (!ids.length) return '';
    return 'WHAT YOU KNOW AND FEEL ABOUT OTHERS (your own notes):' + ids.map((id) => {
      const p = this.world.getObj(id);
      return `\n- ${p ? p.looks : 'someone'} (id: ${id}): ${this.impressions[id]}`;
    }).join('');
  }

  deathsBlock() {
    return 'SOMETHING YOU WILL NEVER FORGET:' + this.deaths.map((d) => {
      const mins = Math.floor((this.character.survivalTime - d.at) / 60);
      return `\n- ${d.text} (${mins < 1 ? 'just now' : mins + ' minutes ago'})`;
    }).join('');
  }

  rutHint() {
    const r = this.recent;
    if (r.length >= 3) {
      const [a, b, c] = r.slice(-3).map((x) => x.split(' - ')[0]);
      if (similarity(c, b) > 0.7 && similarity(b, a) > 0.7) return 'YOU NOTICE: you have wanted almost exactly the same thing several times in a row. It may not be happening the way you imagine. What else could you do?';
    }
    const last = r.slice(-6);
    if (last.length < 5) return '';
    for (const [k, label] of TOPICS) {
      if (last.filter((x) => x.toLowerCase().includes(k)).length >= 5) return `YOU NOTICE: your last several thoughts were all about ${label}. Is that really what you want, or is there something else on your mind?`;
    }
    return '';
  }

  // Small models invent names ("Alex", "Emily"); fix names the note claims are real.
  fixNames(note, aboutId) {
    const p = this.world.getObj(aboutId);
    const real = this.knownNames[aboutId] || '';
    const low = note.toLowerCase();
    if (!real && (low.includes('nickname') || low.includes('decided to name') || low.includes('decided to call'))) return note;
    for (const m of note.matchAll(/(name is|named|called|name I learned:?|name was|name,)\s+([A-Z][a-z]+)/g)) {
      const nm = m[2];
      if (nm !== real && nm !== this.charName) note = note.replaceAll(nm, real || 'the ' + (p ? p.gender : 'person'));
    }
    return note;
  }

  opts(n, temp = 0.7) { return { temperature: temp, num_predict: n }; }

  decisionBody() {
    if (this.mode === 'free') {
      return { format: FREE_SCHEMA, options: this.opts(360, Session.temperature), messages: [
        { role: 'system', content: this.systemPromptFree() }, { role: 'user', content: this.observationFree() }] };
    }
    const user = this.observation();   // also fills visibleIds
    const schema = structuredClone(DECISION_SCHEMA);
    schema.properties.target.enum = ['', ...this.visibleIds];   // can't invent ids
    return { format: schema, options: this.opts(320, Session.temperature), messages: [
      { role: 'system', content: this.systemPrompt() }, { role: 'user', content: user }] };
  }

  persona() {
    return Session.research ? this.intro() : `${this.intro()}\n${this.personality}`;
  }

  // ---------------------------------------------------------------- memory stream
  // Embeddings for relevance: OpenAI text-embedding-3-small, or an Ollama embedding model
  // (e.g. nomic-embed-text) if one is installed. Otherwise relevance = word overlap.
  async embed(texts) {
    if (!texts.length) return null;
    if (Provider.name === 'openai') {
      const j = await this.http('https://api.openai.com/v1/embeddings', { model: 'text-embedding-3-small', input: texts }, 20,
        { Authorization: 'Bearer ' + Provider.key });
      return (j?.data || []).map((d) => d.embedding);
    }
    if (!this.embedModel) return null;
    const j = await this.http(Provider.ollama('/api/embed'), { model: this.embedModel, input: texts }, 30);
    return j?.embeddings || null;
  }

  async embedPending() {
    if (Provider.name !== 'openai' && !this.embedModel) return;
    const pending = this.mem.unembedded(32);
    try {
      const vecs = await this.embed(pending.map((m) => m.text));
      vecs?.forEach((v, i) => { pending[i].emb = v; });
    } catch { /* relevance falls back to word overlap */ }
  }

  // Choose the older memories that come to mind now (recency + importance + relevance).
  async prepareRetrieval(questionOverride = '') {
    const c = this.character;
    const query = questionOverride || [
      ...this.world.nearby(c.position, 15, 5, c.id).map((o) => this.plain(o.id)),
      ...this.pendingChat, ...this.playerMsgs, ...this.events.slice(-3),
    ].join('. ');
    let qEmb = null;
    try {
      await this.embedPending();
      qEmb = (await this.embed([query]))?.[0] || null;
    } catch { qEmb = null; }
    this.retrieved = this.mem.retrieve({ query, queryEmb: qEmb, now: c.survivalTime, k: 8, skipRecent: 12 });
  }

  retrievedBlock() {
    if (!this.retrieved.length) return '';
    const now = this.character.survivalTime;
    return 'OLDER MEMORIES THAT COME TO MIND:' + this.retrieved.map(({ m }) => {
      const mins = Math.round((now - m.t) / 60);
      return `\n- (${mins < 1 ? 'just before' : mins + ' min ago'}${m.kind === 'insight' ? ', an insight you had' : ''}) ${m.text}`;
    }).join('');
  }

  scoreBody(batch) {
    const text = 'Rate how important each memory is to you, from 1 (purely mundane, e.g. walking or looking around) to 10 (extremely significant, e.g. a death or a life-changing event).\n\n'
      + batch.map((m, i) => `${i + 1}. ${m.text}`).join('\n')
      + '\n\nReply as JSON {"scores": [numbers in the same order]}.';
    return { format: { type: 'object', properties: { scores: { type: 'array', items: { type: 'integer' } } }, required: ['scores'] },
      options: this.opts(80, 0), messages: [{ role: 'system', content: this.persona() }, { role: 'user', content: text }] };
  }

  // Reflection (paper: "what high-level insights can you infer?") over the most recent ~30 memories.
  insightBody() {
    const recent = this.mem.items.slice(-30);
    const text = 'Statements about your experience:\n' + recent.map((m, i) => `${i + 1}. ${m.text}`).join('\n')
      + '\n\nWhat 1 to 3 high-level insights can you infer from these statements? Use only what they support. Write each in first person. Reply as JSON {"insights": ["...", "..."]}.';
    return { format: { type: 'object', properties: { insights: { type: 'array', items: { type: 'string' } } }, required: ['insights'] },
      options: this.opts(220, 0.3), messages: [{ role: 'system', content: this.persona() }, { role: 'user', content: text }] };
  }

  interviewBody(q) {
    let text = this.summary ? `Your summary of what happened: ${this.summary}\n\n` : '';
    const rb = this.retrievedBlock();
    if (rb) text += rb + '\n\n';
    text += 'Recent events:\n' + this.events.slice(-12).join('\n');
    if (this.impressionsBlock()) text += '\n\n' + this.impressionsBlock();
    text += `\n\nAn interviewer asks you: "${q}"\nAnswer honestly in the first person, in 1-4 sentences, based only on what you remember. Reply as JSON {"answer": "..."}.`;
    return { format: one('answer', 900), options: this.opts(220, Session.temperature), messages: [
      { role: 'system', content: this.persona() }, { role: 'user', content: text }] };
  }

  // Long-term memory: rewrite a running summary of everything so far.
  summaryBody() {
    let text = `Your previous summary: ${this.summary || '(none yet)'}\n\nWhat happened since:\n` + this.events.slice(-24).join('\n');
    text += '\n\nWrite an updated summary (at most 120 words, first person) of everything important that has happened to you so far. Keep facts from the previous summary; do not invent anything. Reply as JSON {"summary": "..."}.';
    return { format: one('summary', 900), options: this.opts(220, 0.2), messages: [
      { role: 'system', content: this.persona() }, { role: 'user', content: text }] };
  }

  reflectionBody() {
    let text = 'Recent events:\n' + this.events.slice(-12).join('\n');
    text += '\n\nYour recent decisions:\n' + this.recent.join('\n');
    text += '\n\nWrite ONE short first-person sentence about how you feel, what you have learned, or what you want to do with your life here. Reply as JSON {"reflection": "..."}.';
    return { format: one('reflection', 240), options: this.opts(100), messages: [
      { role: 'system', content: this.persona() }, { role: 'user', content: text }] };
  }

  replyBody(msg) {
    let text = 'What has happened recently:\n' + this.events.slice(-8).join('\n');
    text += `\n\nA voice from nowhere just said to you: "${msg}"\nAnswer the Voice out loud, in character, in 1-2 sentences. Reply as JSON {"reply": "..."}.`;
    return { format: one('reply', 240), options: this.opts(120, 0.8), messages: [
      { role: 'system', content: this.persona() }, { role: 'user', content: text }] };
  }

  impressionBody(aboutId) {
    const p = this.world.getObj(aboutId);
    let text = `The other person: ${p ? p.looks : 'someone'} (id: ${aboutId}).\n`;
    text += this.knownNames[aboutId] ? `Their name (they told you): ${this.knownNames[aboutId]}\n`
      : `You do NOT know their name. Never invent a name; just call them the ${p ? p.gender : 'person'}.\n`;
    text += `Your previous note about them: ${this.impressions[aboutId] || '(nothing yet - you have just met)'}\n\n`;
    text += 'What has happened recently:\n' + this.events.slice(-12).join('\n');
    text += Session.research
      ? '\n\nRewrite your private note about this person in 1-3 short first-person sentences: what you know about them and what you think of them (their name only if they told you). Keep what still matters from your previous note. Reply as JSON {"note": "..."}.'
      : '\n\nRewrite your private note about this person in 1-3 short first-person sentences: what you know about them (their name only if they told you) and how you honestly feel about them now. Keep what still matters from your previous note. Reply as JSON {"note": "..."}.';
    return { format: one('note', 320), options: this.opts(160), messages: [
      { role: 'system', content: this.persona() }, { role: 'user', content: text }] };
  }

  // ---------------------------------------------------------------- save / load
  toJSON() {
    return {
      events: this.events, reflections: this.reflections, recent: this.recent, decisionCount: this.decisionCount,
      memories: this.mem.toJSON(),
      impressions: this.impressions, knownNames: this.knownNames, introducedTo: this.introducedTo, deaths: this.deaths, summary: this.summary,
      name: this.charName, personality: this.personality, model: this.model, openaiModel: this.openaiModel, timeout: this.timeout,
    };
  }
  fromJSON(d) {
    for (const k of ['events', 'reflections', 'recent', 'decisionCount', 'impressions', 'knownNames', 'introducedTo', 'deaths', 'summary', 'personality', 'model', 'openaiModel', 'timeout']) {
      if (d[k] !== undefined) this[k] = d[k];
    }
    if (d.name) this.charName = d.name;
    if (d.memories) this.mem.load(d.memories);
  }
}

// ------------------------------------------------------------------ helpers
const MOVE_WORDS = /\b(walk|go|going|head|approach|move|stroll|run|return|follow|wander|explore|visit|towards?|closer|over to)\b/;
const SIT_WORDS = /\b(sit|sitting|lie down|lay down|rest|relax|meditate|kneel)\b/;
const PLACES = [
  ['campfire', /\b(campfire|fire|fireplace)\b/],
  ['pier', /\b(pier|dock|jetty)\b/],
  ['lookout', /\b(lookout|hilltop|hill|summit|cairn|view)\b/],
  ['bench', /\b(bench|seat)\b/],
  ['boat', /\b(boat|rowboat|canoe)\b/],
  ['flowers', /\b(flowers?|meadow|wildflowers?|blossoms?)\b/],
  ['shelter', /\b(shelter|hut|house|roof)\b/],
  ['lake', /\b(lake|water|shore|pond)\b/],
  ['tree', /\b(trees?|wood|forest)\b/],
  ['rock', /\b(rocks?|stones?|boulders?)\b/],
  ['bush', /\b(bush|bushes|berry|berries)\b/],
  ['person', /\b(woman|man|person|her|him|them|stranger|she|he)\b/],
];
const PLACE_LABELS = {
  shelter: 'the shelter', tree: 'a tree', rock: 'a rock', bush: 'a berry bush', campfire: 'the campfire',
  pier: 'the pier', lookout: 'the hilltop lookout', bench: 'the bench by the sea', boat: 'the old rowboat', flowers: 'the wildflowers',
};
const PLAIN = {
  tree: 'a tree', rock: 'a rock', bush: 'a bush with red berries', shelter: 'a small wooden shelter with a red roof', lake: 'a lake',
  campfire: 'a small campfire burning in a ring of stones', pier: 'a wooden pier reaching out over the lake',
  lookout: 'a hilltop with a stone cairn and a bench, with a view over the whole island', bench: 'a wooden bench on the coast, facing the sea',
  boat: 'an old wooden rowboat lying upside down on the beach', flowers: 'a meadow of colourful wildflowers',
};
const TOPICS = [['berr', 'the berries'], ['bush', 'the berry bush'], ['tree', 'the trees'], ['wood', 'wood'], ['rock', 'the rocks'],
  ['stone', 'stones'], ['lake', 'the lake'], ['shelter', 'the shelter'], ['flower', 'the flowers']];

function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }

function similarity(a, b) {
  const wa = new Set(a.toLowerCase().split(/\s+/).filter(Boolean)), wb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.max(wa.size, wb.size);
}

function stripMaxLength(v) {
  if (Array.isArray(v)) return v.map(stripMaxLength);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (k !== 'maxLength') o[k] = stripMaxLength(x);
    return o;
  }
  return v;
}

function pickCheapest(names) {
  for (const p of OPENAI_CHEAP) if (names.includes(p)) return p;
  return names.find((n) => n.includes('nano')) || names.find((n) => n.includes('mini')) || names[0] || OPENAI_CHEAP[0];
}

function pickLocal(names) {
  for (const p of ['llama3.2:3b', 'qwen2.5:3b', 'phi3', 'gemma2:2b', 'llama3.2', 'qwen2.5', 'llama3', 'mistral', 'gemma']) {
    const n = names.find((x) => x.startsWith(p));
    if (n) return n;
  }
  return names[0];
}

// ------------------------------------------------------------------ for the setup preview
// The exact system prompt a subject would get under these conditions, plus what arrives
// with every turn and how memory works.
export function instructionsPreview({ mode, needs, person, research = Session.research, identity = Session.identity }) {
  const prev = Session.research, prevId = Session.identity;
  Session.research = research;
  Session.identity = identity;
  const b = new Brain({ section: person.section, name: person.name, personality: person.personality });
  b.character = { looks: person.looks, needsActive: needs };
  const system = mode === 'free' ? b.systemPromptFree() : b.systemPrompt();
  Session.research = prev;
  Session.identity = prevId;
  const perTurn = [
    'Date and time, and how light or dark it is',
    'Surroundings: high ground or not, trees nearby, where the sea and lake are, what the sky looks like',
    'A running summary of everything that happened earlier (rewritten every 12 decisions)',
    needs ? 'How their body feels (hunger, tiredness) - in words, never numbers' : null,
    mode === 'actions' ? 'Inventory (wood, stone, berries)' : null,
    mode === 'actions' ? 'Nearby objects with ids, distances and directions (ahead, to your left, behind you...)' : 'What they see, in plain words with distances and directions',
    'Other people: looks, what they are doing, whether they face you; a name only after it was said out loud',
    'What they just heard (from you or the other person)',
    'Their last 12 events, plus up to 8 older memories chosen by recency, importance and relevance',
    'Their private notes about the other person',
    'Any death they witnessed - kept forever',
    research ? null : 'A gentle "you notice..." if they keep repeating themselves',
    research ? 'Your messages, placed last (no instruction to answer)' : 'Your messages, placed last, with a request to answer you',
  ].filter(Boolean);
  const memory = [
    'Every 12 decisions: they rewrite a summary of everything so far (long-term memory)',
    'Every 8 decisions after contact: they rewrite a private note about the other person',
    'Every memory is stored and rated for importance (1-10); when enough important things happen, they reflect and draw 1-3 insights, stored as memories',
    research ? null : 'When you speak: a separate request whose only job is to answer you',
    mode === 'free' ? 'After each wish: a separate neutral request decides what the body can physically do (stay, walk to a visible place, wander, sit)' : null,
  ].filter(Boolean);
  return { system, perTurn, memory };
}
