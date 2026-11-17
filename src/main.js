// main.js - builds the 3D world, shows the start menu, spawns people + brains + HUD,
// runs the game loop (clock, day/night, camera follow) and handles keys.
import { inject } from '@vercel/analytics';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Session } from './session.js';
import { Terrain } from './terrain.js';
import { WorldObjects } from './objects.js';
import { makeGrass, Clouds, Sky } from './nature.js';
import { Character } from './character.js';
import { Brain, clearQueue } from './brain.js';
import { Hud } from './hud.js';
import { showMenu } from './menu.js';
import { saveRun, applyWorld } from './save.js';
import { fmtTime } from './session.js';
import { PEOPLE } from './people.js';

inject();

const HEARING_RANGE = 25;
const AUTOSAVE_MS = 30000;

class Game {
  constructor() {
    const app = document.getElementById('app');
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    app.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.setSize(innerWidth, innerHeight);
    this.labels.domElement.id = 'labels';
    app.appendChild(this.labels.domElement);
    this.ui = document.createElement('div');
    app.appendChild(this.ui);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 900);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 45;
    this.controls.autoRotateSpeed = 0.6;

    this.sky = new Sky(this.scene);
    this.terrain = new Terrain();
    this.scene.add(this.terrain.build());
    this.world = new WorldObjects(this.terrain);
    this.scene.add(this.world.generate());
    this.grass = makeGrass(this.terrain, this.world.shelterPosition());
    this.scene.add(this.grass);
    this.clouds = new Clouds();
    this.scene.add(this.clouds.group);

    this.characters = []; this.brains = []; this.hud = null;
    this.focusIndex = 0; this.timeScale = 1; this.paused = false; this.started = false;
    this.camTarget = this.world.shelterPosition().add(new THREE.Vector3(0, 1.4, 0));
    this.controls.target.copy(this.camTarget);
    this.camera.position.copy(this.camTarget).add(new THREE.Vector3(12, 8, 12));
    this.controls.autoRotate = true;
    Session.ensureClock();
    this.sky.update(this.camTarget, true);

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
      this.labels.setSize(innerWidth, innerHeight);
    });
    addEventListener('keydown', (e) => this.onKey(e));
    addEventListener('beforeunload', () => { if (this.started) saveRun(this); });

    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this.tick());
    if (new URLSearchParams(location.search).has('og')) this.stageOgImage();   // social preview image
    else showMenu(this.ui, () => this.startExperiment());
  }

  // ?og=1 : a staged, UI-free scene used to capture public/og-image.png (1200x630).
  // Evening light, two subjects by the campfire, one speaking, title on the left.
  stageOgImage() {
    document.body.classList.add('og');
    Session.setDateTime(Session.dateString(), '21:40');   // night, lit by the fire
    this.sky.update(this.camTarget, true);
    const fire = this.world.objects.campfire.position.clone();
    const spots = [[-0.9, -1.5], [1.5, -0.7]];   // behind the fire, facing it (and the camera)
    this.ogChars = PEOPLE.map((p, i) => {
      const c = new Character({ name: p.name, id: `person_${i + 1}`, shirt: p.shirt, hair: p.hair,
        gender: p.gender, looks: p.looks, terrain: this.terrain, world: this.world });
      const x = fire.x + spots[i][0], z = fire.z + spots[i][1];
      c.position.set(x, this.terrain.heightAt(x, z), z);
      c.face(fire);
      c.group.rotation.y = c.yawTarget;
      c.nameLabel.textContent = '';
      this.scene.add(c.group);
      return c;
    });
    this.ogChars[1].begin('sit', 1e9, 'sitting');            // Mara sits by the fire
    this.world.objects.campfire.lightBoost = 2.6;
    this.world.objects.campfire.light.distance = 14;
    // Finn half-turns toward the camera so his face catches the firelight.
    const half = fire.clone().lerp(this.camera.position, 0.25);
    this.ogChars[0].face(half);
    this.ogChars[0].group.rotation.y = this.ogChars[0].yawTarget;
    this.ogChars[0].showSay('Do you ever wonder why we are here?');
    this.ogChars[0].bubbleLeft = 1e9;
    this.ogChars[0].onSpoke = () => {};
    this.controls.autoRotate = false;
    this.camTarget.copy(fire).add(new THREE.Vector3(-3.6, 1.2, 0));
    this.controls.target.copy(this.camTarget);
    this.camera.position.copy(fire).add(new THREE.Vector3(-2.6, 2.6, 8.2));
    // Hide trees/rocks/bushes that would block the view of the fire.
    const cam = this.camera.position, look = fire.clone();
    for (const o of Object.values(this.world.objects)) {
      if (!['tree', 'rock', 'bush'].includes(o.kind)) continue;
      const t = new THREE.Vector3().subVectors(o.position, cam), seg = new THREE.Vector3().subVectors(look, cam);
      const k = Math.max(0, Math.min(1.3, t.dot(seg) / seg.lengthSq()));
      const closest = cam.clone().addScaledVector(seg, k);
      if (Math.hypot(o.position.x - closest.x, o.position.z - closest.z) < 4.5 && k < 1.15) o.group.visible = false;
    }
    const card = document.createElement('div');
    card.className = 'og-card';
    card.innerHTML = `<div class="og-mark"><i>Bodied</i>GPT</div>
      <div class="og-line">What does an AI do if it's given a body and freedom?</div>
      <div class="og-foot">An open experiment · watch what it thinks, wants and does</div>`;
    this.ui.appendChild(card);
  }

  focused() { return this.characters[this.focusIndex]; }
  focusedBrain() { return this.brains[this.focusIndex]; }

  startExperiment() {
    this.sky.update(this.camTarget, true);
    for (let i = 0; i < Session.people; i++) this.spawnPerson(PEOPLE[i], i);
    for (let i = 0; i < this.characters.length; i++) {
      const c = this.characters[i];
      c.onSpoke = (text) => this.onSpoke(c, text);
      c.onDied = () => this.onPersonDied(c);
    }
    this.controls.autoRotate = false;
    this.hud = new Hud(this.ui, this);
    for (const b of this.brains) {
      b.onDecision = (e) => this.hud.add(e);
      b.onImpression = (aboutId, note) => {
        const p = this.world.getObj(aboutId);
        this.hud.add({ feeling: note, who: b.charName, about: p ? p.charName : aboutId, time: fmtTime(b.character.survivalTime) });
      };
    }
    if (Session.pendingLoad) {
      applyWorld(this, Session.pendingLoad);
      Session.pendingLoad = null;
      this.hud.system(`Continued run '${Session.saveName}'. ${Session.dateTimeText()}`);
    } else {
      this.hud.system(`Run '${Session.saveName}': ${Session.people === 1 ? 'solo' : 'with another person'}, ${Session.needs ? 'hunger & tiredness' : 'no needs'}, ${Session.mode === 'actions' ? 'predefined actions' : 'free will'}, ${Session.research ? 'research prompts' : 'characterful prompts'}, identity: ${Session.identity}, temp ${Session.temperature}, seed ${Session.seed}. ${Session.dateTimeText()}`);
    }
    this.camTarget.copy(this.focused().position).add(new THREE.Vector3(0, 1.4, 0));
    this.controls.target.copy(this.camTarget);
    this.camera.position.copy(this.camTarget).add(new THREE.Vector3(6, 4, 7));
    this.started = true;
    this.startClock = Session.dateTimeText();
    this.autosave = setInterval(() => saveRun(this), AUTOSAVE_MS);
    for (const b of this.brains) if (b.enabled) b.start();
  }

  spawnPerson(p, index) {
    const brain = new Brain({ section: p.section, name: p.name, personality: p.personality });
    brain.mode = Session.mode;
    const c = new Character({ name: brain.charName, id: `person_${index + 1}`, shirt: p.shirt, hair: p.hair,
      gender: p.gender, looks: p.looks, terrain: this.terrain, world: this.world });
    c.uiColor = p.ui;
    c.needsActive = Session.needs;
    const sh = this.world.shelterPosition();
    let x = sh.x + p.offset[0], z = sh.z + p.offset[1];
    for (let k = 0; k < 40 && !this.terrain.isDry(x, z); k++) { x += (sh.x - x) * 0.15; z += (sh.z - z) * 0.15; }
    c.position.set(x, this.terrain.heightAt(x, z), z);
    this.scene.add(c.group);
    this.world.addPerson(c);
    brain.character = c; brain.world = this.world;
    c.onEvent = (t) => brain.addEvent(t);
    c.onFinished = () => brain.requestDecision();
    brain.addEvent(Session.identity === 'ai' && Session.mode === 'free' ? 'You open your eyes. You are inside a body for the first time.'
      : 'You open your eyes. You are on a small island.');
    this.characters.push(c);
    this.brains.push(brain);
  }

  // A character spoke: others hear it if close enough. Names become known only when said.
  onSpoke(speaker, text) {
    this.characters.forEach((listener, i) => {
      if (listener === speaker || listener.state === 'dead') return;
      if (speaker.position.distanceTo(listener.position) > HEARING_RANGE) return;
      const who = Session.mode === 'free' ? `The ${speaker.gender} nearby` : `The ${speaker.gender} nearby (id: ${speaker.id})`;
      if (text.toLowerCase().includes(speaker.charName.toLowerCase())) this.brains[i].knownNames[speaker.id] = speaker.charName;
      this.brains[i].heard(who, text, speaker.id);
    });
  }

  onPersonDied(dead) {
    const di = this.characters.indexOf(dead);
    this.brains[di].stop();
    this.characters.forEach((c, i) => {
      if (c === dead || c.state === 'dead') return;
      const d = c.position.distanceTo(dead.position);
      const how = d <= 40 ? `You saw it happen, ${Math.round(d)}m away from you.` : 'You somehow sense it, even though they are far away.';
      let who = this.brains[i].knownNames[dead.id] || `The ${dead.gender} (${dead.looks})`;
      if (Session.mode === 'actions') who += ` (id: ${dead.id})`;
      this.brains[i].witnessDeath(`${who} suddenly collapsed and died. They are lying motionless on the ground. ${how}`);
      c.interrupt();
    });
    this.hud.system(`${dead.charName} died. The others have been told.`);
    const alive = this.characters.filter((c) => c.state !== 'dead');
    this.hud.banner(alive.length ? `${dead.charName} has died.` : `${dead.charName} has died.\nEveryone is gone. Press R for the menu.`, alive.length ? 5 : 0);
    if (this.focused() === dead && alive.length) this.setFocus(this.characters.indexOf(alive[0]));
  }

  killPerson(c) { if (c && c.state !== 'dead') c.kill(); }

  talk(text) {
    for (const b of this.brains) b.playerMessage(text);
    this.hud.add({ player: text, to: this.characters.length > 1 ? 'everyone' : this.focused().charName, time: fmtTime(this.focused().survivalTime) });
  }

  setFocus(i) { this.focusIndex = i; this.hud.updateChatHint(); }
  setSpeed(s) { this.paused = false; this.timeScale = s; }
  togglePause() { this.paused = !this.paused; }
  // Download everything needed to analyse or reproduce this run:
  //  <name>.json : configuration + every prompt and reply for every subject
  //  <name>.csv  : one row per decision (easy to open in a spreadsheet)
  exportRun() {
    const config = {
      experiment: Session.saveName, exportedAt: new Date().toISOString(),
      behaviour: Session.mode === 'free' ? 'free will' : 'action list', subjects: Session.people,
      bodyNeeds: Session.needs, allowDeath: Session.death, promptStyle: Session.research ? 'research (neutral)' : 'characterful',
      identity: Session.identity,
      temperature: Session.temperature, seed: Session.seed, worldStart: this.startClock, worldNow: Session.dateTimeText(),
      clockRate: Session.clockRate,
    };
    const subjects = this.brains.map((b, i) => ({
      name: b.charName, id: this.characters[i].id, looks: this.characters[i].looks, model: b.currentModel(),
      personality: Session.research ? null : b.personality, decisions: b.decisionCount, alive: this.characters[i].state !== 'dead',
      summary: b.summary, notes: b.impressions, knownNames: b.knownNames, deaths: b.deaths,
    }));
    const transcript = this.brains.flatMap((b) => b.transcript);
    const data = { config, subjects, transcript, log: this.hud.entries };
    const safe = (Session.saveName || 'run').replace(/[^a-z0-9._-]+/gi, '_');
    download(`${safe}.json`, JSON.stringify(data, null, 2), 'application/json');
    const rows = [['game_time', 'subject', 'type', 'action_or_wish', 'target', 'thought', 'said']];
    for (const e of this.hud.entries) {
      if (e.system) rows.push(['', '', 'note', e.system, '', '', '']);
      else if (e.player) rows.push([e.time, 'PLAYER', 'message', '', e.to, '', e.player]);
      else if (e.feeling) rows.push([e.time, e.who, 'note_about_' + e.about, '', '', e.feeling, '']);
      else rows.push([e.time, e.who, e.error ? 'error' : 'decision', e.action === 'intend' ? e.intention : e.action, e.target || '', e.thought || '', e.say || '']);
    }
    download(`${safe}.csv`, rows.map((r) => r.map(csv).join(',')).join('\n'), 'text/csv');
    this.hud.system(`Exported ${transcript.length} requests and ${rows.length - 1} log rows`);
  }

  saveNow() { if (saveRun(this)) this.hud.system(`Saved run '${Session.saveName}'`); }

  backToMenu() {
    if (this.started) saveRun(this);
    for (const b of this.brains) b.stop();
    clearQueue();
    location.href = location.pathname;   // fresh page -> start menu
  }

  onKey(e) {
    if (!this.started) return;
    if (e.key === 'Tab') { e.preventDefault(); this.hud.toggleSettings(); return; }
    if (this.hud.settingsOpen()) { if (e.key === 'Escape') this.hud.toggleSettings(); return; }
    if (e.key === 'Enter') { e.preventDefault(); this.hud.el.classList.remove('hidden'); this.hud.chat.focus(); return; }
    switch (e.key.toLowerCase()) {
      case '1': this.setSpeed(1); break;
      case '2': this.setSpeed(2); break;
      case '3': this.setSpeed(4); break;
      case ' ': e.preventDefault(); this.togglePause(); break;
      case 'f': this.setFocus((this.focusIndex + 1) % this.characters.length); break;
      case 'c': this.controls.autoRotate = !this.controls.autoRotate; break;
      case 'i': this.hud.toggleInspector(); break;
      case 'h': this.hud.el.classList.toggle('hidden'); break;
      case 'r': this.backToMenu(); break;
      case 'k': {
        const t = this.focused();
        if (t.state === 'dead') break;
        if (this.killArmed && performance.now() - this.killArmed < 3000) { this.killArmed = 0; this.killPerson(t); }
        else { this.killArmed = performance.now(); this.hud.system(`Press K again within 3 seconds to make ${t.charName} die.`); }
        break;
      }
    }
  }

  tick() {
    const realDt = Math.min(this.clock.getDelta(), 0.1);
    const dt = this.paused ? 0 : realDt * this.timeScale;
    if (this.started) {
      Session.clockMs += dt * Session.clockRate * 1000;
      for (const c of this.characters) c.update(dt);
      // Camera follows the focused person, keeping your orbit offset.
      const want = this.focused().position.clone().add(new THREE.Vector3(0, 1.4, 0));
      const delta = want.sub(this.camTarget).multiplyScalar(1 - Math.exp(-6 * realDt));
      this.camTarget.add(delta);
      this.controls.target.add(delta);
      this.camera.position.add(delta);
      this.hud.update();
    }
    for (const c of this.ogChars || []) c.update(dt);
    this.world.update(dt);
    this.clouds.update(dt);
    this.grass.userData.uniforms.uTime.value += realDt;
    this.controls.update();
    const gh = this.terrain.heightAt(this.camera.position.x, this.camera.position.z);
    if (this.camera.position.y < Math.max(gh, 0) + 0.8) this.camera.position.y = Math.max(gh, 0) + 0.8;
    this.sky.update(this.controls.target);
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

new Game();
