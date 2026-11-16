// main.js - builds the 3D world, shows the start menu, spawns people + brains + HUD,
// runs the game loop (clock, day/night, camera follow) and handles keys.
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
    showMenu(this.ui, () => this.startExperiment());
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
      this.hud.system(`Run '${Session.saveName}': ${Session.people === 1 ? 'solo' : 'with another person'}, ${Session.needs ? 'hunger & tiredness' : 'no needs'}, ${Session.mode === 'actions' ? 'predefined actions' : 'free will'}. ${Session.dateTimeText()}`);
    }
    this.camTarget.copy(this.focused().position).add(new THREE.Vector3(0, 1.4, 0));
    this.controls.target.copy(this.camTarget);
    this.camera.position.copy(this.camTarget).add(new THREE.Vector3(6, 4, 7));
    this.started = true;
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
    brain.addEvent(Session.mode === 'free' ? 'You open your eyes. You are inside a body for the first time.' : 'You wake up on a small island.');
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

new Game();
