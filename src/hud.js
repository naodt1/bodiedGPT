// hud.js - filming HUD: top bar (date, person, model, speed buttons), scrollable thought
// log, hotbar, hunger/tiredness bars, chat box, banner, and the Tab settings panel.
import { Session, fmtTime } from './session.js';
import { Needs } from './needs.js';
import { Provider } from './brain.js';
import { icon } from './icons.js';

const ACTION_COLORS = { walk_to: '#7cc7ff', gather: '#ffd166', eat: '#ff8fa3', drink: '#5ad1e6', rest: '#b69cff', say: '#a8e6a1', wait: '#b0b0b0', intend: '#ffcf8a' };
const MAX_ENTRIES = 500;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class Hud {
  constructor(root, game) {
    this.game = game;
    this.entries = [];
    this.el = document.createElement('div');
    this.el.id = 'hud';
    this.el.innerHTML = `
      <div id="topbar" class="panel">
        <span id="tb-text"></span>
        <span class="tb-div"></span>
        <div class="seg" role="group" aria-label="Speed"><button data-speed="1">1×</button><button data-speed="2">2×</button><button data-speed="4">4×</button></div>
        <button id="tb-pause" class="b-primary b-icon" title="Pause (Space)">${icon('pause', 15)}</button>
        <span class="tb-div"></span>
        <button id="tb-inspect" class="b-outline" title="Inspector (I)">${icon('eye', 14)} Inspect</button>
        <button id="tb-export" class="b-outline" title="Export the full transcript (JSON + CSV)">${icon('download', 14)} Export</button>
        <button id="tb-save" class="b-ghost b-icon" title="Save">${icon('save', 15)}</button>
        <button id="tb-menu" class="b-ghost b-icon" title="Back to setup (R)">${icon('sidebar', 15)}</button>
      </div>
      <div id="log" class="panel"><h4 id="log-title">THOUGHT LOG</h4><div id="log-body"></div></div>
      <div id="hotbar" class="panel">
        ${[['wood', '#9e6633'], ['stone', '#9ea3ad'], ['berries', '#e6263f']].map(([n, c]) =>
          `<div class="slot"><div class="icon" style="background:${c}"></div><div class="n" id="inv-${n}">0</div><div class="l">${n}</div></div>`).join('')}
      </div>
      <div id="bars" class="panel">
        <span>Hunger</span><div class="bar"><div id="bar-hunger" style="background:#f2a33a"></div></div><span class="bar-word" id="w-hunger"></span>
        <span>Tiredness</span><div class="bar"><div id="bar-tired" style="background:#8fa8ff"></div></div><span class="bar-word" id="w-tired"></span>
      </div>
      <input id="chat" type="text" autocomplete="off">
      <div id="banner" class="hidden"></div>
      <div id="insp" class="insp panel hidden">
        <div class="head"><b id="insp-who"></b><span id="insp-meta"></span></div>
        <div class="tabs">
          <button data-tab="instructions">Instructions</button><button data-tab="context">Context</button>
          <button data-tab="memory">Memory</button><button data-tab="interview">Interview</button><button data-tab="reply">Last reply</button>
        </div>
        <div class="body" id="insp-body"></div>
      </div>
      <div id="settings" class="overlay hidden"></div>`;
    root.appendChild(this.el);
    this.$ = (s) => this.el.querySelector(s);
    this.log = this.$('#log-body');
    this.chat = this.$('#chat');

    this.el.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => game.setSpeed(+b.dataset.speed)));
    this.inspTab = 'instructions';
    this.$('#tb-inspect').addEventListener('click', () => this.toggleInspector());
    this.el.querySelectorAll('#insp [data-tab]').forEach((b) => b.addEventListener('click', () => { this.inspTab = b.dataset.tab; this._inspKey = ''; this._ivFor = null; this._ivKey = ''; this.renderInspector(); }));
    this.$('#tb-pause').addEventListener('click', () => game.togglePause());
    this.$('#tb-save').addEventListener('click', () => game.saveNow());
    this.$('#tb-export').addEventListener('click', () => game.exportRun());
    this.$('#tb-menu').addEventListener('click', () => game.backToMenu());
    this.chat.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { const t = this.chat.value.trim(); this.chat.value = ''; this.chat.blur(); if (t) game.talk(t); }
      if (e.key === 'Escape') this.chat.blur();
    });
    this.$('#hotbar').classList.toggle('hidden', Session.mode !== 'actions');
    this.$('#bars').classList.toggle('hidden', !Session.needs);
    this.updateChatHint();
  }

  updateChatHint() {
    const c = this.game.focused();
    this.chat.placeholder = (this.game.characters.length > 1 ? 'Enter: talk to everyone' : `Enter: talk to ${c.charName}`) +
      '   |   F focus subject · drag orbit · 1/2/3 clock rate · Space pause · Tab settings · H hide HUD · K K intervene: end subject · R end run';
  }

  // ---------------------------------------------------------------- log
  add(e) {
    this.entries.push(e);
    const atBottom = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 30;
    if (this.entries.length > MAX_ENTRIES) { this.entries = this.entries.slice(-MAX_ENTRIES); this.render(); }
    else this.log.insertAdjacentHTML('beforeend', this.format(e));
    if (atBottom) this.log.scrollTop = this.log.scrollHeight;   // only follow if you were at the bottom
  }
  render() { this.log.innerHTML = this.entries.map((e) => this.format(e)).join(''); }
  system(text) { this.add({ system: text }); }

  nameColor(n) {
    const c = this.game.characters.find((x) => x.charName === n);
    return c ? c.uiColor : '#fff';
  }

  format(e) {
    if (e.system) return `<div class="entry sys">— ${esc(e.system)} —</div>`;
    if (e.player) return `<div class="entry player"><span class="t">${e.time}</span><b>Experimenter → ${esc(e.to)}:</b> ${esc(e.player)}</div>`;
    const who = `<span class="who" style="color:${this.nameColor(e.who)}">${esc(e.who)}</span>`;
    if (e.insight) return `<div class="entry feel"><span class="t">${e.time}</span>${who}<span class="act">insight:</span><div class="thought">${esc(e.insight)}</div></div>`;
    if (e.feeling) return `<div class="entry feel"><span class="t">${e.time}</span>${who}<span class="act">feelings about ${esc(e.about)}:</span><div class="thought">${esc(e.feeling)}</div></div>`;
    if (e.error) return `<div class="entry err"><span class="t">${e.time}</span>${who}<span class="act">brain error → wait()</span><div class="thought">${esc(e.thought)}</div></div>`;
    const col = ACTION_COLORS[e.action] || '#fff';
    const head = e.action === 'intend'
      ? `<span class="act" style="color:${col}">wants to:</span> <span style="color:${col}">${esc(e.intention)}</span>`
      : `<span class="act" style="color:${col}">${e.action}(${esc(e.target)})</span>${e.ok ? '' : ' <span style="color:#ff6b6b">(failed)</span>'}`;
    return `<div class="entry"><span class="t">${e.time}</span>${who}${head}<div class="thought">${esc(e.thought)}</div>${e.say ? `<div class="say">"${esc(e.say)}"</div>` : ''}</div>`;
  }

  // ---------------------------------------------------------------- per frame
  update() {
    const g = this.game, c = g.focused(), b = g.focusedBrain();
    const since = ((performance.now() - b.lastDecisionMs) / 1000).toFixed(1);
    const st = ['Ready', 'Thinking...'].includes(b.status) ? '' : `<span class="tb-status">${esc(b.status)}</span>`;
    const nDec = g.brains.reduce((n, x) => n + (x.decisionCount || 0), 0);
    const cond = `${Session.people === 1 ? 'solo' : 'pair'} · ${Session.mode === 'actions' ? 'action list' : 'free will'} · ${Session.research ? 'research' : 'characterful'}`;
    this.$('#tb-text').innerHTML = `<span class="tb-run" title="${esc(cond)}">RUN · ${esc(Session.saveName)}</span><span class="tb-meta">${nDec} decision${nDec === 1 ? '' : 's'} · ${fmtTime(c.survivalTime)}</span><span class="tb-div"></span><span class="tb-date">${Session.dateTimeText()}</span><span class="tb-who">${esc(c.charName)}</span><span class="tb-chip">${esc(b.currentModel())}</span><span class="tb-since" title="Since last decision">${g.paused ? 'paused' : since + 's'}</span>${st}`;
    const pb = this.$('#tb-pause'), pi = g.paused ? 'play' : 'pause';
    if (pb.dataset.ic !== pi) { pb.dataset.ic = pi; pb.innerHTML = icon(pi, 15); pb.title = g.paused ? 'Resume (Space)' : 'Pause (Space)'; }
    this.el.querySelectorAll('[data-speed]').forEach((x) => x.classList.toggle('active', !g.paused && +x.dataset.speed === g.timeScale));
    this.$('#tb-pause').classList.toggle('active', g.paused);
    for (const k of ['wood', 'stone', 'berries']) this.$('#inv-' + k).textContent = c.inventory[k];
    this.$('#bar-hunger').style.width = (100 - c.needs.hunger) + '%';
    this.$('#bar-tired').style.width = (100 - c.needs.stamina) + '%';
    this.$('#w-hunger').textContent = Needs.hungerWord(c.needs.hunger);
    this.$('#w-tired').textContent = Needs.tiredWord(c.needs.stamina);
    const thinking = g.brains.filter((x) => x.thinking).map((x) => x.charName).join(', ');
    if (!this.$('#insp').classList.contains('hidden') && performance.now() - (this._inspAt || 0) > 500) {
      this._inspAt = performance.now();
      this.renderInspector();
    }
    this.$('#log-title').textContent = 'THOUGHT LOG' + (thinking ? `  ·  ${thinking} thinking...` : '');
  }

  // ---------------------------------------------------------------- inspector (I)
  toggleInspector() {
    const el = this.$('#insp');
    el.classList.toggle('hidden');
    this.$('#tb-inspect').classList.toggle('active', !el.classList.contains('hidden'));
    this._inspKey = '';
    this.renderInspector();
  }

  // What the followed subject is really told and remembers. Re-renders only on change,
  // so you can scroll and select text while it is open.
  renderInspector() {
    const g = this.game, b = g.focusedBrain(), c = g.focused();
    this.el.querySelectorAll('#insp [data-tab]').forEach((x) => x.classList.toggle('on', x.dataset.tab === this.inspTab));
    const dec = b.lastByKind.decision;
    let html = '';
    if (this.inspTab === 'instructions') {
      const sys = Session.mode === 'free' ? b.systemPromptFree() : b.systemPrompt();
      html = `<div class="insp-h">System prompt - sent with every decision</div><pre>${esc(sys)}</pre>`;
    } else if (this.inspTab === 'context') {
      html = dec ? `<div class="insp-h">Everything they were shown at ${dec.at} (last decision)</div><pre>${esc(dec.user)}</pre>`
        : '<div class="empty">No decision yet.</div>';
    } else if (this.inspTab === 'interview') {
      return this.renderInterview(b, c);
    } else if (this.inspTab === 'memory') {
      const list = (arr) => arr.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<div class="empty">nothing yet</div>';
      const people = Object.values(g.world.people).filter((p) => p !== c);
      html = `<div class="insp-h">What they know about others</div>` + (people.length ? `<ul>${people.map((p) =>
        `<li><b>${esc(p.looks)}</b> (${p.id})<br>name: ${esc(b.knownNames[p.id] || 'unknown - never told')}${b.introducedTo[p.id] ? ' · introduced themselves' : ''}<br>
         note: ${esc(b.impressions[p.id] || '(none yet)')}</li>`).join('')}</ul>` : '<div class="empty">alone on the island</div>') +
        `<div class="insp-h">Never forgotten</div>${list(b.deaths.map((d) => d.text))}` +
        `<div class="insp-h">Summary (rewritten every 12 decisions)</div>${list(b.summary ? [b.summary] : [])}` +
        `<div class="insp-h">Older memories in the last prompt (recency + importance + relevance)</div>${list(b.retrieved.map(({ m }) => `[${m.importance}] ${m.text}`))}` +
        `<div class="insp-h">Memory stream: ${b.mem.items.length} memories, newest first · [importance 1-10] · ${b.embedModel || Provider.name === 'openai' ? 'embeddings' : 'word-overlap'} relevance</div>` +
        list(b.mem.items.slice().reverse().slice(0, 80).map((m) => `[${m.importance}${m.scored ? '' : '?'}] ${m.kind === 'insight' ? 'INSIGHT: ' : ''}${m.text}`));
    } else {
      const rows = Object.entries(b.lastByKind).map(([k, r]) => `<div class="insp-h">${k} · ${r.at} · ${esc(r.model)}</div><pre>${esc(r.reply)}</pre>`);
      html = rows.length ? rows.join('') : '<div class="empty">No replies yet.</div>';
    }
    this.$('#insp-who').textContent = c.charName;
    this.$('#insp-meta').textContent = `${b.currentModel()} · ${b.decisionCount} decisions`;
    if (html !== this._inspKey) { this._inspKey = html; this.$('#insp-body').innerHTML = html; }
  }

  // Interview: questions are answered from the subject's memories and are NOT stored in them.
  renderInterview(b, c) {
    const body = this.$('#insp-body');
    if (this._ivFor !== b) {
      this._ivFor = b;
      this._inspKey = 'interview';
      body.innerHTML = `<div class="insp-h">Ask ${esc(c.charName)} anything. The answer comes from their memories; the question does not enter their memory, so the experiment is not affected.</div>
        <div class="iv-form"><input type="text" id="iv-q" placeholder="e.g. What do you think of the person you met?" autocomplete="off"><button class="btn" id="iv-ask">Ask</button></div>
        <div id="iv-history"></div>`;
      const ask = () => {
        const q = this.$('#iv-q').value.trim();
        if (!q) return;
        this.$('#iv-q').value = '';
        b.interviews = b.interviews || [];
        b.interviews.push({ q, a: null, at: '' });
        b.interview(q);
        this._ivKey = '';
      };
      this.$('#iv-ask').addEventListener('click', ask);
      this.$('#iv-q').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') ask(); });
    }
    const hist = (b.interviews || []).slice().reverse().map((x) => `<div class="iv-item"><div class="iv-q">Q: ${esc(x.q)}</div>
      <div class="iv-a">${x.a == null ? '<i>thinking...</i>' : esc(x.a)}</div>${x.at ? `<div class="iv-t">at ${x.at}</div>` : ''}</div>`).join('') || '<div class="empty">No questions yet.</div>';
    if (hist !== this._ivKey) { this._ivKey = hist; this.$('#iv-history').innerHTML = hist; }
    this.$('#insp-who').textContent = c.charName;
  }

  banner(text, seconds = 0) {
    const b = this.$('#banner');
    b.textContent = text;
    b.classList.remove('hidden');
    clearTimeout(this._bt);
    if (seconds) this._bt = setTimeout(() => b.classList.add('hidden'), seconds * 1000);
  }

  // ---------------------------------------------------------------- settings (Tab)
  toggleSettings() {
    const s = this.$('#settings');
    if (!s.classList.contains('hidden')) { s.classList.add('hidden'); return; }
    this.openSettings(this.game.focusIndex);
  }

  settingsOpen() { return !this.$('#settings').classList.contains('hidden'); }

  openSettings(i) {
    const g = this.game, b = g.brains[i], c = g.characters[i];
    const s = this.$('#settings');
    const models = [...new Set([b.currentModel(), ...b.availableModels])];
    s.innerHTML = `<div class="card" style="width:min(620px,94vw)">
      <h1 style="font-size:24px">Settings</h1>
      <div class="sec" style="margin-top:14px"><h3>Character</h3>
        <select id="s-who">${g.characters.map((x, k) => `<option value="${k}" ${k === i ? 'selected' : ''}>${esc(x.charName)}</option>`).join('')}</select></div>
      <div class="sec"><h3>Name</h3><input type="text" id="s-name" value="${esc(b.charName)}" style="width:100%"></div>
      <div class="sec"><h3>AI (shared by everyone)</h3><div class="row" style="margin:0">
        <select id="s-prov"><option value="ollama">Ollama (local)</option><option value="openai" ${Provider.name === 'openai' ? 'selected' : ''}>OpenAI (cloud)</option></select>
        <input type="password" id="s-key" class="grow ${Provider.name === 'openai' ? '' : 'hidden'}" placeholder="OpenAI API key" value="${Provider.key ? '••••••••' : ''}">
      </div></div>
      <div class="sec"><h3>Model</h3><div class="row" style="margin:0"><select id="s-model" class="grow">${models.map((m) => `<option ${m === b.currentModel() ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
        <button class="btn" id="s-refresh">Refresh</button></div></div>
      <div class="sec"><h3>Personality</h3><textarea id="s-pers">${esc(b.personality)}</textarea></div>
      <div class="sec"><h3>Decision timeout (seconds)</h3><input type="text" id="s-tmo" value="${b.timeout}" size="4"></div>
      <div class="sec"><h3>World date and time — change it and watch the reaction</h3>
        <div class="row" style="margin:0"><input type="text" id="s-date" value="${Session.dateString()}" size="11"><input type="text" id="s-time" value="${Session.timeString()}" size="5"></div></div>
      <div class="err" id="s-err"></div>
      <div class="row" style="justify-content:flex-end">
        <button class="btn danger" id="s-kill">Make this person die</button>
        <button class="btn" id="s-close">Close</button>
        <button class="btn" id="s-apply" style="background:var(--accent);border-color:var(--accent)">Apply</button>
      </div></div>`;
    s.classList.remove('hidden');
    const $ = (q) => s.querySelector(q);
    const shownDT = $('#s-date').value + ' ' + $('#s-time').value;
    s.querySelectorAll('input,textarea,select').forEach((x) => x.addEventListener('keydown', (e) => { if (e.key !== 'Tab' && e.key !== 'Escape') e.stopPropagation(); }));
    $('#s-who').addEventListener('change', () => this.openSettings(+$('#s-who').value));
    $('#s-prov').addEventListener('change', () => $('#s-key').classList.toggle('hidden', $('#s-prov').value !== 'openai'));
    $('#s-refresh').addEventListener('click', () => {
      b.onModels = (list) => { $('#s-model').innerHTML = [...new Set([b.currentModel(), ...list])].map((m) => `<option ${m === b.currentModel() ? 'selected' : ''}>${esc(m)}</option>`).join(''); };
      b.refreshModels();
    });
    $('#s-close').addEventListener('click', () => s.classList.add('hidden'));
    $('#s-kill').addEventListener('click', () => { s.classList.add('hidden'); g.killPerson(c); });
    $('#s-apply').addEventListener('click', () => {
      const key = $('#s-key').value.trim();
      if (key && !key.startsWith('•')) Provider.key = key;
      const provChanged = Provider.name !== $('#s-prov').value;
      Provider.name = $('#s-prov').value;
      if (Provider.name === 'openai' && !Provider.key) { $('#s-err').textContent = 'Paste your OpenAI API key.'; return; }
      if ($('#s-date').value + ' ' + $('#s-time').value !== shownDT) {
        if (!Session.setDateTime($('#s-date').value, $('#s-time').value)) { $('#s-err').textContent = 'Date must look like 2026-12-25 and time like 14:30.'; return; }
        this.system('Date/time changed to ' + Session.dateTimeText());
        g.sky.update(g.camTarget, true);
      }
      const name = $('#s-name').value.trim();
      if (name) { b.charName = name; c.setName(name); }
      b.personality = $('#s-pers').value.trim();
      b.timeout = Math.max(3, +$('#s-tmo').value || 30);
      if (!provChanged) b.setModel($('#s-model').value);
      for (const x of g.brains) { x.save(); if (provChanged) x.refreshModels(); }
      this.updateChatHint();
      s.classList.add('hidden');
    });
  }
}
