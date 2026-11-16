// menu.js - the launch screen: an "about" card next to a step-by-step setup.
//   Start -> Subjects (who, names) -> Experiment (name, conditions) -> World -> AI -> Review & start
import { Session } from './session.js';
import { Provider, instructionsPreview, listModels } from './brain.js';
import { PEOPLE } from './people.js';
import { icon } from './icons.js';
import { listSaves, loadSave, applySession } from './save.js';

const TIMES = [['Morning', '08:00'], ['Midday', '12:30'], ['Evening', '18:30'], ['Night', '22:30']];
const RATES = [[1, 'Real time'], [60, '1 min / s'], [600, '10 min / s'], [3600, '1 hour / s']];

const STEPS = [
  { id: 'start', title: 'Welcome', sub: 'Start a new experiment or continue one.' },
  { id: 'subjects', title: 'Subjects', sub: 'Who lives on the island?' },
  { id: 'experiment', title: 'Experiment', sub: 'Name it and set the conditions.' },
  { id: 'world', title: 'World', sub: 'When does it begin?' },
  { id: 'ai', title: 'AI', sub: 'Which model controls the subjects?' },
  { id: 'review', title: 'Review', sub: 'Check the configuration, then start.' },
];

export function showMenu(root, onStart) {
  Session.ensureClock();
  const now = new Date();
  const savedChar = (p) => { try { return JSON.parse(localStorage.getItem('im.char.' + p.section) || '{}'); } catch { return {}; } };
  const st = {
    step: 0,
    people: Session.people, names: PEOPLE.map((p) => savedChar(p).name || p.name),
    experiment: `Experiment ${now.toISOString().slice(0, 10)} ${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')}`,
    needs: Session.needs, mode: Session.mode, death: Session.death,
    time: closestTime(), date: Session.dateString(), clock: TIMES[closestTime()][1], rate: Session.clockRate,
    provider: Provider.name, model: '', models: null, modelStatus: '', modelOk: false,
    ollamaUrl: Provider.ollamaUrl, remember: Provider.remember,
  };
  const saves = listSaves();

  const wrap = document.createElement('div');
  wrap.className = 'launch';
  wrap.innerHTML = `
    <section class="about">
      <h1 class="wordmark"><i>Bodied</i>GPT</h1>
      <p class="tagline">What does an AI do if it's given a body and freedom?</p>
      <p class="blurb">A language model gets a body on a small island. Nobody tells it what to do. You watch what it thinks, wants and does, and you can read exactly what it was told.</p>
      <ul class="facts">
        <li>${badge('users', '#0a84ff')}<span><b>Alone or with a stranger</b><small>A second AI it is never told about.</small></span></li>
        <li>${badge('sparkles', '#bf5af2')}<span><b>Action list or free will</b><small>Choose from a list, or say anything.</small></span></li>
        <li>${badge('eye', '#30d158')}<span><b>Fully transparent</b><small>Every prompt and reply can be inspected.</small></span></li>
        <li>${badge('history', '#ff9f0a')}<span><b>Saved as you go</b><small>Continue any run later.</small></span></li>
      </ul>
      <p class="fine">Runs in your browser · no account · your API key stays with you</p>
    </section>
    <section class="wizard">
      <div class="wiz-head"><div class="wiz-step" id="w-count"></div><h2 id="w-title"></h2><p id="w-sub"></p></div>
      <div class="wiz-body" id="w-body"></div>
      <div class="err" id="w-err"></div>
      <div class="wiz-foot">
        <button class="ghost" id="w-back">Back</button>
        <div class="dots" id="w-dots"></div>
        <button class="next" id="w-next">Next</button>
      </div>
    </section>`;
  root.appendChild(wrap);
  const $ = (s) => wrap.querySelector(s);

  // ---------------------------------------------------------------- steps
  function render() {
    const s = STEPS[st.step];
    $('#w-count').textContent = st.step === 0 ? '' : `Step ${st.step} of ${STEPS.length - 1}`;
    $('#w-title').textContent = s.title;
    $('#w-sub').textContent = s.sub;
    $('#w-err').textContent = '';
    $('#w-dots').innerHTML = STEPS.slice(1).map((_, i) => `<span class="${i + 1 === st.step ? 'on' : i + 1 < st.step ? 'done' : ''}"></span>`).join('');
    $('#w-back').style.visibility = st.step === 0 ? 'hidden' : 'visible';
    $('#w-next').classList.toggle('hidden', st.step === 0);
    $('#w-next').innerHTML = st.step === STEPS.length - 1 ? `${icon('play', 13)} Start experiment` : 'Next';
    $('#w-next').classList.toggle('go', st.step === STEPS.length - 1);
    const body = $('#w-body');
    body.innerHTML = VIEWS[s.id]();
    body.scrollTop = 0;
    BIND[s.id]?.();
  }

  const seg = (key, opts) => `<div class="seg" data-k="${key}">${opts.map(([v, l]) =>
    `<button data-v="${v}" class="${String(st[key]) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const bindSegs = (after) => wrap.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    const k = b.parentElement.dataset.k, v = b.dataset.v;
    st[k] = k === 'people' || k === 'time' || k === 'rate' ? +v : k === 'needs' ? v === 'true' : v;
    if (k === 'time') st.clock = TIMES[+v][1];
    after ? after(k) : render();
  }));
  const bindInput = (id, key) => $(id)?.addEventListener('input', (e) => { st[key] = e.target.value; });

  const VIEWS = {
    start: () => `
      <button class="big-choice" id="w-new">${badge('play', '#0a84ff')}<span><b>New experiment</b><small>Set up subjects and conditions</small></span>${icon('chevron', 14)}</button>
      ${saves.length ? `<div class="group-title">Continue a previous run</div><div class="group">${saves.slice(0, 6).map((s) => `
        <button class="cell run-item" data-key="${s.key}">${badge('history', '#48484a')}
          <span class="run-text"><span>${esc(s.name)}</span><small>${esc(s.meta)}</small></span><span class="chev">${icon('chevron', 14)}</span></button>`).join('')}</div>`
        : '<p class="empty-note">No previous runs yet.</p>'}`,

    subjects: () => `
      <div class="group"><div class="cell">
        <div class="cell-top">${badge('users', '#0a84ff')}<span class="cell-label">How many?</span></div>
        ${seg('people', [[1, 'One person'], [2, 'Two people']])}
        <div class="note">${st.people === 2 ? 'They are not told the other exists. They only see how the other looks.' : 'Alone on the island.'}</div>
      </div></div>
      <div class="group-title">Names</div>
      <div class="group">${PEOPLE.slice(0, st.people).map((p, i) => `
        <div class="cell">
          <div class="cell-top"><span class="swatch" style="background:${p.ui}"></span><input type="text" class="bare" data-name="${i}" value="${esc(st.names[i])}" placeholder="Name"></div>
          <div class="note">${esc(p.looks[0].toUpperCase() + p.looks.slice(1))}.</div>
        </div>`).join('')}</div>
      <p class="hint-small">Each subject knows its own name. Others learn it only if it's said out loud.</p>`,

    experiment: () => `
      <div class="group"><div class="cell"><div class="cell-top">${badge('tag', '#64d2ff')}
        <input type="text" class="bare" id="w-exp" value="${esc(st.experiment)}" placeholder="Experiment name"></div></div></div>
      <div class="group-title">Conditions</div>
      <div class="group">
        <div class="cell">
          <div class="cell-top">${badge('heart', '#ff375f')}<span class="cell-label">Body needs</span></div>
          ${seg('needs', [[true, 'Hunger & tiredness'], [false, 'No needs']])}
          <div class="note">${st.needs ? 'They feel hunger and tiredness, described in words.' : 'No stats at all. Nothing they have to do.'}</div>
        </div>
        <div class="cell">
          <div class="cell-top">${badge('sparkles', '#bf5af2')}<span class="cell-label">Behaviour</span></div>
          ${seg('mode', [['actions', 'Action list'], ['free', 'Free will']])}
          <div class="note">${st.mode === 'actions' ? 'Picks one action at a time: walk, gather, eat, drink, rest, talk, wait.' : 'No list. It says what it wants; the body does what a body can (walk, wander, sit).'}</div>
        </div>
        ${st.needs ? `<div class="cell"><label class="cell-top switch-row">${badge('alert', '#636366')}<span class="cell-label">Allow death from starvation</span>
          <input type="checkbox" id="w-death" class="switch" ${st.death ? 'checked' : ''}></label></div>` : ''}
      </div>`,

    world: () => `
      <div class="group">
        <div class="cell">
          <div class="cell-top">${badge(st.time === 3 ? 'moon' : 'sun', st.time === 3 ? '#5e5ce6' : '#ff9f0a')}<span class="cell-label">Start time</span></div>
          ${seg('time', TIMES.map((t, i) => [i, t[0]]))}
        </div>
        <div class="cell"><div class="cell-top">${badge('calendar', '#ff453a')}
          <input type="text" class="bare" id="w-date" value="${esc(st.date)}" title="Date (YYYY-MM-DD)">
          <input type="text" class="bare narrow" id="w-clock" value="${esc(st.clock)}" title="Time (HH:MM)"></div></div>
        <div class="cell">
          <div class="cell-top">${badge('clock', '#30d158')}<span class="cell-label">Clock speed</span></div>
          ${seg('rate', RATES)}
        </div>
      </div>
      <p class="hint-small">The sun follows the clock, and the subjects are told the date, time and how light it is. You can change the date mid-run.</p>`,

    ai: () => `
      <div class="group">
        <div class="cell">
          <div class="cell-top">${badge('cpu', '#8e8e93')}<span class="cell-label">Provider</span></div>
          ${seg('provider', [['ollama', 'Local (Ollama)'], ['openai', 'OpenAI']])}
          <div class="note">${st.provider === 'ollama' ? 'Runs on this computer. Free.' : 'Uses your API key. About $0.10-0.20 per hour per subject on the cheapest models.'}</div>
        </div>
        ${st.provider === 'openai' ? `
        <div class="cell">
          <div class="cell-top">${badge('key', '#ff9f0a')}<input type="password" class="bare" id="w-key" autocomplete="off" spellcheck="false"
            placeholder="OpenAI API key" value="${Provider.key ? '••••••••' : ''}"><button class="link" id="w-forget">Forget</button></div>
          <label class="cell-top switch-row"><span class="cell-label small">Remember on this device</span>
            <input type="checkbox" id="w-remember" class="switch" ${st.remember ? 'checked' : ''}></label>
          <div class="note">Sent only from your browser to api.openai.com. Never saved in runs or sent anywhere else.</div>
        </div>` : `
        <div class="cell"><div class="cell-top">${badge('cpu', '#30d158')}<span class="cell-label small">Ollama address</span>
          <input type="text" class="bare right-text" id="w-ollama" value="${esc(st.ollamaUrl)}" spellcheck="false"></div></div>`}
        <div class="cell">
          <div class="cell-top">${badge('sparkles', '#5e5ce6')}<span class="cell-label">Model</span>
            <select class="bare right" id="w-model">${(st.models || []).map((m) => `<option ${m === st.model ? 'selected' : ''}>${esc(m)}</option>`).join('') || '<option value="">checking...</option>'}</select></div>
          <div class="note ${st.modelStatus ? (st.modelOk ? 'ok' : 'bad') : ''}" id="w-mstatus">${esc(st.modelStatus)}</div>
        </div>
      </div>`,

    review: () => {
      const names = st.names.slice(0, st.people).join(' and ');
      const row = (ic, color, label, value) => `<div class="cell"><div class="cell-top">${badge(ic, color)}<span class="cell-label small">${label}</span><span class="value">${esc(value)}</span></div></div>`;
      return `
      <div class="group">
        ${row('tag', '#64d2ff', 'Experiment', st.experiment)}
        ${row('users', '#0a84ff', 'Subjects', names)}
        ${row('heart', '#ff375f', 'Body needs', st.needs ? (st.death ? 'Hunger & tiredness · can die' : 'Hunger & tiredness') : 'None')}
        ${row('sparkles', '#bf5af2', 'Behaviour', st.mode === 'actions' ? 'Action list' : 'Free will')}
        ${row('sun', '#ff9f0a', 'Starts', `${st.date} ${st.clock} · ${RATES.find(([v]) => v === st.rate)?.[1] || ''}`)}
        ${row('cpu', '#8e8e93', 'Model', `${st.provider === 'openai' ? 'OpenAI' : 'Ollama'} · ${st.model || 'auto'}`)}
      </div>
      <div class="group-title">What each subject is told</div>
      ${PEOPLE.slice(0, st.people).map((p, i) => {
        const t = instructionsPreview({ mode: st.mode, needs: st.needs, person: { ...p, name: st.names[i] } });
        return `<details class="told-block"><summary>${esc(st.names[i])} ${icon('chevron', 12)}</summary>
          <div class="told-h">Instructions (system prompt)</div><pre>${esc(t.system)}</pre>
          <div class="told-h">Every turn they also receive</div><ul>${t.perTurn.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
          <div class="told-h">Memory</div><ul>${t.memory.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>`;
      }).join('')}`;
    },
  };

  const BIND = {
    start: () => {
      $('#w-new').addEventListener('click', () => { st.step = 1; render(); });
      wrap.querySelectorAll('.run-item[data-key]').forEach((b) => b.addEventListener('click', () => {
        const d = loadSave(b.dataset.key);
        if (!d) { $('#w-err').textContent = 'Could not read that run.'; return; }
        Provider.save();
        applySession(d);
        Session.pendingLoad = d;
        finish();
      }));
    },
    subjects: () => {
      bindSegs();
      wrap.querySelectorAll('[data-name]').forEach((inp) => inp.addEventListener('input', () => { st.names[+inp.dataset.name] = inp.value; }));
    },
    experiment: () => {
      bindSegs();
      bindInput('#w-exp', 'experiment');
      $('#w-death')?.addEventListener('change', (e) => { st.death = e.target.checked; });
    },
    world: () => { bindSegs(); bindInput('#w-date', 'date'); bindInput('#w-clock', 'clock'); },
    ai: () => {
      bindSegs((k) => { if (k === 'provider') { st.models = null; st.model = ''; } render(); });
      $('#w-model').addEventListener('change', (e) => { st.model = e.target.value; });
      $('#w-ollama')?.addEventListener('change', (e) => { st.ollamaUrl = e.target.value.trim() || st.ollamaUrl; Provider.ollamaUrl = st.ollamaUrl; st.models = null; render(); });
      $('#w-key')?.addEventListener('change', (e) => { const v = e.target.value.trim(); if (v && !v.startsWith('•')) Provider.key = v; st.models = null; render(); });
      $('#w-remember')?.addEventListener('change', (e) => { st.remember = e.target.checked; });
      $('#w-forget')?.addEventListener('click', () => { Provider.forgetKey(); st.remember = false; st.models = null; render(); });
      if (st.models === null) loadModels();
    },
    review: () => {},
  };

  // Ask the provider which models exist (installed in Ollama / available on the key).
  async function loadModels() {
    const prov = st.provider;
    st.models = [];
    Provider.ollamaUrl = st.ollamaUrl;
    const r = await listModels(prov);
    if (prov !== st.provider) return;
    st.models = r.models;
    const saved = prov === 'openai' ? savedChar(PEOPLE[0]).openaiModel : savedChar(PEOPLE[0]).model;
    st.model = r.models.includes(saved) ? saved : (r.suggested || '');
    st.modelOk = r.ok;
    st.modelStatus = r.ok ? `● Connected · ${r.models.length} model${r.models.length === 1 ? '' : 's'}${prov === 'openai' ? ' · cheapest selected' : ''}` : '● ' + r.error;
    if (STEPS[st.step].id === 'ai') render();
  }

  // ---------------------------------------------------------------- navigation
  function validate() {
    const id = STEPS[st.step].id;
    if (id === 'subjects' && st.names.slice(0, st.people).some((n) => !n.trim())) return 'Give every subject a name.';
    if (id === 'experiment' && !st.experiment.trim()) return 'Give the experiment a name.';
    if (id === 'world' && !Session.setDateTime(st.date, st.clock)) return 'Date like 2026-12-25 and time like 14:30.';
    if (id === 'ai') {
      if (st.provider === 'openai' && !Provider.key) return 'Add your OpenAI API key, or use Local.';
      if (!st.model) return st.modelStatus ? 'No model available - see the message above.' : 'Still checking for models...';
    }
    return '';
  }

  $('#w-back').addEventListener('click', () => { if (st.step > 0) { st.step--; render(); } });
  $('#w-next').addEventListener('click', () => {
    const err = validate();
    if (err) { $('#w-err').textContent = err; return; }
    if (st.step < STEPS.length - 1) { st.step++; render(); return; }
    start();
  });

  function start() {
    Session.setDateTime(st.date, st.clock);
    // Names and model are stored per subject; the brains read them when they're created.
    PEOPLE.forEach((p, i) => {
      const c = savedChar(p);
      c.name = st.names[i].trim() || p.name;
      if (st.provider === 'openai') c.openaiModel = st.model; else c.model = st.model;
      localStorage.setItem('im.char.' + p.section, JSON.stringify(c));
    });
    Provider.name = st.provider;
    Provider.remember = st.remember;
    Provider.ollamaUrl = st.ollamaUrl;
    Provider.save();
    Object.assign(Session, {
      people: st.people, needs: st.needs, mode: st.mode, death: st.needs && st.death,
      clockRate: st.rate, saveName: st.experiment.trim(), pendingLoad: null,
    });
    finish();
  }

  function finish() { wrap.remove(); onStart(); }

  render();

  // Dev shortcut: ?auto=free:2:off&provider=ollama  (behaviour : subjects : needs) - skips the steps.
  const q = new URLSearchParams(location.search), auto = q.get('auto');
  if (auto) {
    const [m, p, n] = auto.split(':');
    st.mode = m === 'free' ? 'free' : 'actions';
    if (p) st.people = Math.min(2, Math.max(1, +p));
    if (n) st.needs = n !== 'off';
    st.provider = q.get('provider') || st.provider;
    (async () => {
      const r = await listModels(st.provider);
      st.model = r.suggested || '';
      start();
    })();
  }
}

const badge = (name, color) => `<span class="badge" style="background:${color}">${icon(name, 15)}</span>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function closestTime() {
  const h = Session.hour();
  if (h >= 5 && h < 11) return 0;
  if (h >= 11 && h < 16) return 1;
  if (h >= 16 && h < 21) return 2;
  return 3;
}
