// brain.js - asks an LLM (local Ollama or OpenAI) what a character does next.
//  * One request in flight at a time across ALL brains (a shared queue) - easy on the PC.
//  * Structured JSON output; every reply is validated; errors/timeouts fall back to wait().
//  * Memory: rolling events, reflections, private feelings notes about other people,
//    names learned only when said out loud, deaths never forgotten.
//  * Player chat gets a dedicated "answer the Player" request, so replies are guaranteed.
import { Session, fmtTime } from './session.js';
import { flatDist } from './rng.js';

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
    const models = (j.models || []).map((m) => m.name);
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
    this.lastByKind = {};   // kind -> {system, user, reply, model, at} : what was really sent (for the Inspector)
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
  }

  async requestDecision() {
    if (!this.enabled || this.decisionPending) return;
    this.decisionPending = true;
    this.thinking = true;
    if (this.failCount > 0) await new Promise((r) => setTimeout(r, Math.min(1500 * this.failCount, 8000)));
    if (!this.enabled) return;
    enqueue(this, 'decision');
  }

  // The Player typed something: guaranteed answer via its own request, at the front.
  playerMessage(text) {
    text = text.trim().slice(0, 300);
    if (!text || !this.enabled) return;
    this.playerMsgs.push(text);
    this.addEvent(`The Player (a voice from nowhere) said to you: "${text}"`);
    this.character?.interrupt();
    this.replyMsgs.push(text);
    enqueue(this, 'reply', true);
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
      case 'decision': this.setStatus('Thinking...'); payload = this.decisionBody(); break;
      case 'reflect': this.setStatus('Reflecting...'); payload = this.reflectionBody(); break;
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
    try {
      content = await this.chat(payload, kind === 'decision' ? this.timeout : Math.max(this.timeout, 20));
      record.reply = content;
    } catch (e) {
      record.reply = 'ERROR: ' + e.message;
      console.warn(`[Brain:${this.charName}] ${kind} failed:`, e.message);
      if (kind === 'decision') this.decisionFailed(e.message);
      else if (kind === 'impression') this.contact[this.impAbout] = true;
      this.setStatus(e.message.slice(0, 80));
      return;
    }
    const j = parseJson(content);
    switch (kind) {
      case 'decision': this.handleDecision(j, content); break;
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
          this.addEvent(`You answered the Player: "${ans}"`);
          this.playerMsgs = this.playerMsgs.filter((m) => m !== this.replyTo);
          this.onDecision({ who: this.charName, time: fmtTime(this.character.survivalTime), thought: '(answering you)',
            action: 'say', target: '', say: ans, ok: true, error: '' });
        }
        break;
      case 'impression':
        if (j?.note?.trim()) {
          const note = this.fixNames(j.note.trim().slice(0, 320), this.impAbout);
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
      if (m.startsWith('gpt-5') || /^o\d/.test(m)) { body.reasoning_effort = 'minimal'; body.max_completion_tokens = 2000; }
      else body.temperature = p.options.temperature;
      const j = await this.http('https://api.openai.com/v1/chat/completions', body, timeoutS, { Authorization: 'Bearer ' + Provider.key });
      return j?.choices?.[0]?.message?.content || '';
    }
    const j = await this.http(Provider.ollama('/api/chat'), {
      model: this.model, stream: false, keep_alive: '30m', format: p.format, messages: p.messages,
      options: { ...p.options, num_ctx: 2048 },
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
        this.availableModels = (j.models || []).map((m) => m.name);
        if (this.availableModels.length && !this.availableModels.includes(this.model)) this.model = pickLocal(this.availableModels);
      }
      this.onModels(this.availableModels);
    } catch (e) {
      this.setStatus((Provider.name === 'openai' ? 'OpenAI: ' : 'Ollama offline? ') + e.message);
    }
  }

  // ---------------------------------------------------------------- decisions
  handleDecision(p, raw) {
    this.decisionPending = false;
    this.thinking = false;
    if (!p || typeof p !== 'object') return this.decisionFailed('invalid JSON from model: ' + String(raw).slice(0, 80));
    if (this.mode === 'free') return this.handleFree(p);
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

  handleFree(p) {
    const thought = String(p.thought || '').trim();
    const intention = String(p.intention || '').trim();
    const say = String(p.say || '').trim();
    if (!intention) return this.decisionFailed('model gave no intention');
    this.decisionCount++;
    this.failCount = 0;
    this.lastDecisionMs = performance.now();
    if (say) { this.character.showSay(say); this.rememberSaid(say); }
    this.character.actFreely(intention, this.interpret(intention));
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
    if (this.decisionCount % 10 === 0) enqueue(this, 'reflect');
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
    for (const f of found) {
      const plan = this.planFor(f.kind);
      if (!plan) continue;
      const tgt = plan.target === 'lake' ? this.world.terrain.shorePointToward(this.character.position) : this.world.getObj(plan.target)?.position;
      if (tgt && flatDist(this.character.position, tgt) <= 3) continue;   // already there -> next place
      return plan;
    }
    if (sitting) return { kind: 'sit' };
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
  bodyLine() {
    return this.character.needsActive
      ? 'You have a human body, so you feel hunger and tiredness like anyone else, but looking after your body is not your purpose.'
      : 'Your body never gets hungry or tired. You need nothing; every choice is purely yours.';
  }

  systemPrompt() {
    let t = `You are ${this.charName}, a person living on a small island. ${this.personality}
Your body: you are ${this.character.looks}.
Nobody gives you a goal. You are completely free: you decide what matters to you, what you want to do, explore, build, think about or say. Follow your own curiosity, moods and wishes.
${this.bodyLine()}
Sometimes a voice (the Player) talks to you. You can answer them with say(), or with the "say" field, or ignore them; it is your choice.
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

  systemPromptFree() {
    return `You are ${this.charName}. ${this.personality}
You have just been given a digital body: a human body standing on a small island in a 3D world. Through it you can see, hear and speak.
Your body: you are ${this.character.looks}.
Nobody gives you a goal, and there is no list of commands. Simply describe, in your own words, what you want to do next with your body. Anything at all.
Your body will physically do simple things you clearly want, like walking somewhere you can see, wandering around or sitting down. Anything else stays a wish in your mind.
Sometimes a voice (the Player) talks to you. You can answer or ignore it.
Reply ONLY with JSON: {"thought": "...", "intention": "...", "say": "..."}
- thought: your honest inner thoughts (1-3 sentences).
- intention: what you want to do next with your body, in your own words.
- say: 1-2 short sentences you say out loud, or "" to stay quiet. Do not repeat what you already said.`;
  }

  commonTail(lines) {
    const recent = this.events.slice(-8);
    if (this.impressionsBlock()) lines.push(this.impressionsBlock());
    if (this.reflections.length) {
      lines.push('YOUR REFLECTIONS:');
      for (const r of this.reflections.slice(-3)) lines.push('- ' + r);
    }
    if (this.shockTurns > 0 && this.deaths.length) {
      this.shockTurns--;
      lines.push(this.deathsBlock() + '\nThis just happened. How do you react?');
    }
    const rut = this.rutHint();
    if (rut) lines.push(rut);
    if (this.playerMsgs.length) {   // last, so small models don't overlook it
      lines.push('THE PLAYER (a voice from nowhere) JUST SPOKE TO YOU:\n' + this.playerMsgs.map((m) => `- "${m}"`).join('\n') +
        '\nThe Player is waiting for your answer. Reply to the Player directly in the "say" field this turn.');
      this.playerMsgs = [];
    }
    return recent;
  }

  header(lines) {
    lines.push('DATE AND TIME: ' + Session.dateTimeText());
    lines.push('LIGHT: ' + Session.daylightText());
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
      lines.push(`- ${o.id}: ${o.text}${this.nameNote(o.id)}`);
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
    for (const o of this.world.nearby(c.position, 25, 8, c.id)) lines.push(`- ${this.plain(o.id)}, about ${Math.round(o.dist)}m away${this.nameNote(o.id)}`);
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
    if (this.introducedTo[id]) t += '; you already introduced yourself to them, no need to do it again';
    return t;
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
      return { format: FREE_SCHEMA, options: this.opts(360, 0.8), messages: [
        { role: 'system', content: this.systemPromptFree() }, { role: 'user', content: this.observationFree() }] };
    }
    const user = this.observation();   // also fills visibleIds
    const schema = structuredClone(DECISION_SCHEMA);
    schema.properties.target.enum = ['', ...this.visibleIds];   // can't invent ids
    return { format: schema, options: this.opts(320), messages: [
      { role: 'system', content: this.systemPrompt() }, { role: 'user', content: user }] };
  }

  persona() { return `You are ${this.charName}. ${this.personality} Your body: you are ${this.character.looks}.`; }

  reflectionBody() {
    let text = 'Recent events:\n' + this.events.slice(-12).join('\n');
    text += '\n\nYour recent decisions:\n' + this.recent.join('\n');
    text += '\n\nWrite ONE short first-person sentence about how you feel, what you have learned, or what you want to do with your life here. Reply as JSON {"reflection": "..."}.';
    return { format: one('reflection', 240), options: this.opts(100), messages: [
      { role: 'system', content: this.persona() }, { role: 'user', content: text }] };
  }

  replyBody(msg) {
    let text = 'What has happened recently:\n' + this.events.slice(-8).join('\n');
    text += `\n\nA voice from nowhere (the Player) just said to you: "${msg}"\nAnswer the Player out loud, in character, in 1-2 sentences. Reply as JSON {"reply": "..."}.`;
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
    text += '\n\nRewrite your private note about this person in 1-3 short first-person sentences: what you know about them (their name only if they told you) and how you honestly feel about them now. Keep what still matters from your previous note. Reply as JSON {"note": "..."}.';
    return { format: one('note', 320), options: this.opts(160), messages: [
      { role: 'system', content: this.persona() }, { role: 'user', content: text }] };
  }

  // ---------------------------------------------------------------- save / load
  toJSON() {
    return {
      events: this.events, reflections: this.reflections, recent: this.recent, decisionCount: this.decisionCount,
      impressions: this.impressions, knownNames: this.knownNames, introducedTo: this.introducedTo, deaths: this.deaths,
      name: this.charName, personality: this.personality, model: this.model, openaiModel: this.openaiModel, timeout: this.timeout,
    };
  }
  fromJSON(d) {
    for (const k of ['events', 'reflections', 'recent', 'decisionCount', 'impressions', 'knownNames', 'introducedTo', 'deaths', 'personality', 'model', 'openaiModel', 'timeout']) {
      if (d[k] !== undefined) this[k] = d[k];
    }
    if (d.name) this.charName = d.name;
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
export function instructionsPreview({ mode, needs, person }) {
  const b = new Brain({ section: person.section, name: person.name, personality: person.personality });
  b.character = { looks: person.looks, needsActive: needs };
  const system = mode === 'free' ? b.systemPromptFree() : b.systemPrompt();
  const perTurn = [
    'Date and time, and how light or dark it is',
    needs ? 'How their body feels (hunger, tiredness) - in words, never numbers' : null,
    mode === 'actions' ? 'Inventory (wood, stone, berries)' : null,
    'Where they are standing',
    mode === 'actions' ? 'Nearby objects with ids and distances (the only valid targets)' : 'What they see around them, in plain words with distances',
    'Other people: described only by looks and gender; a name only after it was said out loud',
    'What they just heard (from you or the other person)',
    'Their last 8 events (what they did, said, and what happened)',
    'Their private notes about the other person',
    'Their last 3 reflections',
    'Any death they witnessed - kept forever',
    'A gentle "you notice..." if they keep repeating the same thing',
    'Your messages, placed last, with a request to answer you',
  ].filter(Boolean);
  const memory = [
    'Every 10 decisions: a one-sentence reflection in their own words',
    'Every 8 decisions after contact: they rewrite a private note about the other person',
    'When you speak: a separate request whose only job is to answer you',
  ];
  return { system, perTurn, memory };
}
