// character.js - a blocky person. Executes actions chosen by the Brain with normal game
// code (walk_to, gather, eat, drink, rest, say, wait) or, in free will, acts out plain
// wishes the body can do (walk somewhere, wander, sit). Reports outcomes as events.
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { mat, box } from './mesh.js';
import { Needs } from './needs.js';
import { REACH } from './objects.js';
import { flatDist, lerp, Rng } from './rng.js';
import { Session } from './session.js';
import { fmtTime } from './session.js';

const WALK_SPEED = 3.4, TIRED_SPEED = 1.8, WATER_REACH = 2.5;

export class Character {
  constructor({ name, id, shirt, hair, gender, looks, terrain, world }) {
    this.charName = name; this.id = id; this.gender = gender; this.looks = looks;
    this.terrain = terrain; this.world = world;
    this.kind = 'person'; this.amount = 0; this.bodyRadius = 0;
    this.needs = new Needs();
    this.needsActive = true;
    this.inventory = { wood: 0, stone: 0, berries: 0 };
    this.survivalTime = 0;
    this.state = 'idle';
    this.actionText = 'thinking...';
    this.bubbleText = ''; this.bubbleLeft = 0;
    // callbacks set by main.js
    this.onEvent = () => {}; this.onFinished = () => {}; this.onDied = () => {}; this.onSpoke = () => {};
    this.needs.onWarning = (t) => this.onEvent(t);

    this.group = new THREE.Group();
    this.rig = new THREE.Group();
    this.group.add(this.rig);
    this.buildModel(shirt, hair);
    this.walkPhase = 0; this.animT = 0; this.yawTarget = 0;
    this.dest = new THREE.Vector3(); this.arrive = 1.3; this.targetId = '';
    this.timer = 0; this.walkTime = 0; this.stuckT = 0; this.stuckPos = new THREE.Vector3(); this.side = 1;
    this.sayText = ''; this.intention = ''; this.placeLabel = '';
    this.rng = new Rng((Session.seed + id.length * 7919 + id.charCodeAt(id.length - 1)) >>> 0);   // reproducible wandering
  }

  get position() { return this.group.position; }
  isGatherable() { return false; }
  headPos() { return this.position.clone().add(new THREE.Vector3(0, 2.75, 0)); }

  setName(n) { this.charName = n; this.nameLabel.textContent = n; }

  describe(dist) {
    const s = `${this.looks} whom you don't know, ${dist.toFixed(1)}m`;
    if (this.state === 'dead') return s + ', lying motionless';
    return s + ', ' + this.activity();
  }
  activity() {
    return { walk: 'walking', gather: 'picking something', eat: 'eating', drink: 'drinking water',
      rest: 'sitting down', sit: 'sitting down', say: 'talking' }[this.state] || 'standing still';
  }

  showSay(text) {
    this.bubbleText = String(text).trim().slice(0, 240);
    this.bubbleLeft = Math.min(9, Math.max(3, 2.5 + this.bubbleText.length * 0.06));
    this.bubbleEl.textContent = this.bubbleText;
    if (this.bubbleText) this.onSpoke(this.bubbleText);
  }

  // ------------------------------------------------------------------ predefined actions
  // Returns true if started; on failure an event is logged and the character waits briefly.
  perform(action, target, text) {
    if (this.state === 'dead') return false;
    let err = '';
    switch (action) {
      case 'walk_to': err = this.startWalk(target); break;
      case 'gather': err = this.startGather(target); break;
      case 'eat': err = this.inventory.berries <= 0 ? 'you have no berries. Gather from a berry bush first' : (this.begin('eat', 1.2, 'eat()'), ''); break;
      case 'drink': err = this.startDrink(); break;
      case 'rest': this.begin('rest', 5, 'rest()'); break;
      case 'say': this.sayText = text?.trim() || '...'; this.showSay(this.sayText); this.begin('say', 1.8, 'say()'); break;
      case 'wait': this.begin('wait', 2.5, 'wait()'); break;
      default: err = 'unknown action';
    }
    if (err) {
      this.onEvent(`FAILED ${action}(${target}): ${err}`);
      this.begin('wait', 1.5, 'confused...');
      return false;
    }
    return true;
  }

  begin(state, duration, label) { this.state = state; this.timer = duration; this.animT = 0; this.actionText = label; }

  startWalk(target) {
    if (!target) return 'no target given';
    let dest;
    if (target === 'lake') { dest = this.terrain.shorePointToward(this.position); this.arrive = 0.6; }
    else {
      const o = this.world.getObj(target);
      if (!o) return `there is no object called '${target}'`;
      dest = o.position.clone();
      this.arrive = o.kind === 'shelter' ? 0.9 : o.kind === 'person' ? 1.6 : 1.3;
    }
    this.targetId = target;
    if (flatDist(this.position, dest) <= this.arrive + 0.1) {
      if (this.placeLabel) {
        this.onEvent(`You are already at ${this.placeLabel}.`);
        this.placeLabel = '';
        this.begin('intend', 2, 'looking around');
        return '';
      }
      const hint = target === 'shelter' ? ' Walking there again does nothing; you could rest() here.'
        : target === 'lake' ? ' Walking there again does nothing; you could drink() here.'
        : ' Walking there again does nothing; try a different action.';
      this.onEvent(`You are already at ${target}.${hint}`);
      this.begin('wait', 0.8, `walk_to(${target})`);
      return '';
    }
    this.dest.copy(dest);
    this.walkTime = 0; this.stuckT = 0; this.stuckPos.copy(this.position);
    this.state = 'walk';
    this.actionText = `walk_to(${target})`;
    return '';
  }

  startGather(target) {
    const o = this.world.getObj(target);
    if (!o) return `there is no object called '${target}'`;
    if (!o.isGatherable()) return `${target} cannot be gathered`;
    const d = flatDist(this.position, o.position);
    if (d > REACH) return `${target} is ${d.toFixed(1)}m away, too far. Use walk_to(${target}) first`;
    if (o.amount <= 0) return `${target} is depleted, it is regrowing`;
    this.targetId = target;
    this.face(o.position);
    this.begin('gather', 1.6, `gather(${target})`);
    return '';
  }

  startDrink() {
    const w = this.terrain.nearestWater(this.position, 6);
    if (w.dist > WATER_REACH) return 'you are not next to water. Use walk_to(lake) first';
    this.face(w.point);
    this.begin('drink', 2, 'drink()');
    return '';
  }

  finishTimed() {
    switch (this.state) {
      case 'gather': {
        const o = this.world.getObj(this.targetId);
        const r = o ? o.harvest() : null;
        if (!r) this.onEvent(`FAILED gather(${this.targetId}): nothing left`);
        else {
          this.inventory[r.item] += r.qty;
          this.onEvent(`Gathered 1 ${r.item} from ${this.targetId} (you now have ${this.inventory[r.item]} ${r.item}; ${o.amount} left there).`);
        }
        break;
      }
      case 'eat':
        this.inventory.berries -= 1; this.needs.add('hunger', 25); this.needs.add('health', 2);
        this.onEvent(`Ate a berry (${this.inventory.berries} berries left).`); break;
      case 'drink':
        this.needs.add('hunger', 4); this.needs.add('health', 6); this.needs.add('stamina', 5);
        this.onEvent('Drank from the lake.'); break;
      case 'rest': this.onEvent(`Rested${this.nearShelter() ? ' in the shelter' : ''}.`); break;
      case 'say': this.onEvent(`You said: "${this.sayText}"`); break;
      case 'intend': this.onEvent('Your body did not do it; you stayed where you were.'); break;
      case 'sit': this.onEvent('You sat on the grass for a while. Nothing else you wanted happened.'); break;
      case 'wait': if (this.actionText === 'wait()') this.onEvent('Waited.'); break;
    }
    this.endAction();
  }

  endAction() {
    this.placeLabel = '';
    this.state = 'idle';
    this.actionText = 'thinking...';
    this.onFinished();
  }

  // ------------------------------------------------------------------ free will
  // Act out a wish if the body plainly can (walk somewhere, wander, sit). Else stand still.
  actFreely(intention, plan) {
    if (this.state === 'dead') return;
    this.intention = intention;
    this.onEvent(`You wanted to: ${intention}`);
    if (plan.kind === 'walk') {
      this.placeLabel = plan.label;
      if (this.startWalk(plan.target) === '') {
        if (this.state === 'walk') this.actionText = 'walking to ' + plan.label;
        return;
      }
    } else if (plan.kind === 'wander') {
      const p = this.wanderPoint();
      if (p) {
        this.placeLabel = 'a new spot'; this.targetId = ''; this.dest.copy(p); this.arrive = 0.6;
        this.walkTime = 0; this.stuckT = 0; this.stuckPos.copy(this.position);
        this.state = 'walk'; this.actionText = 'wandering';
        return;
      }
    } else if (plan.kind === 'already') {
      this.placeLabel = '';
      this.onEvent(`You are already at ${plan.label}.`);
      this.begin('wait', 3, 'at ' + plan.label);
      return;
    } else if (plan.kind === 'sit') {
      this.begin('sit', 8, 'sitting');
      return;
    }
    this.placeLabel = '';
    this.begin('intend', 4, 'wants to: ' + intention.slice(0, 60));
  }

  wanderPoint() {
    for (let i = 0; i < 12; i++) {
      const a = this.rng.float() * Math.PI * 2, r = 8 + this.rng.float() * 8;
      const x = this.position.x + Math.cos(a) * r, z = this.position.z + Math.sin(a) * r;
      if (this.terrain.heightAt(x, z) > 0.6 && Math.hypot(x, z) < 64) return new THREE.Vector3(x, this.terrain.heightAt(x, z), z);
    }
    return null;
  }

  // Stop what you're doing (the experimenter spoke / someone died) so the brain decides again soon.
  interrupt() {
    if (this.state === 'walk') { this.onEvent('You stopped walking.'); this.endAction(); }
    else if (this.state !== 'idle' && this.state !== 'dead') this.timer = Math.min(this.timer, 0.2);
  }

  kill() {
    if (this.state === 'dead') return;
    this.needs.health = 0;
    this.die();
  }

  die() {
    this.state = 'dead';
    this.actionText = 'dead';
    this.bubbleText = ''; this.bubbleEl.textContent = '';
    this.onEvent(`${this.charName} died after ${fmtTime(this.survivalTime)}.`);
    this.onDied();
  }

  nearShelter() { return flatDist(this.position, this.world.shelterPosition()) < 3.2; }

  statusText() {
    const parts = [];
    for (const p of Object.values(this.world.people)) {
      if (p !== this && flatDist(this.position, p.position) <= 3) parts.push(`${p.looks[0].toUpperCase() + p.looks.slice(1)} (id: ${p.id}) is right here with you.`);
    }
    const n = this.world.nearest(this.position);
    parts.push(n.dist <= 3 ? `You are standing next to ${n.id} (${n.dist.toFixed(1)}m).` : 'You are out in the open.');
    if (this.nearShelter()) parts.push('You are at your shelter.');
    if (this.terrain.nearestWater(this.position, 4).dist <= WATER_REACH) parts.push("You are at the water's edge and can drink.");
    if (this.needsActive && this.needs.stamina <= 0) parts.push('You are too exhausted to walk fast.');
    return parts.join(' ');
  }

  face(p) {
    const dx = p.x - this.position.x, dz = p.z - this.position.z;
    if (Math.hypot(dx, dz) > 0.01) this.yawTarget = Math.atan2(-dx, -dz);
  }

  // ------------------------------------------------------------------ per frame
  update(dt) {
    if (this.state !== 'dead') {
      this.survivalTime += dt;
      if (this.needsActive) this.needs.tick(dt, this.state === 'walk', this.state === 'rest', this.nearShelter());
      if (this.bubbleLeft > 0) {
        this.bubbleLeft -= dt;
        if (this.bubbleLeft <= 0) { this.bubbleText = ''; this.bubbleEl.textContent = ''; }
      }
      if (this.state === 'walk') this.updateWalk(dt);
      else if (this.state !== 'idle') { this.timer -= dt; if (this.timer <= 0) this.finishTimed(); }
      if (this.needs.isDead()) this.die();
    }
    this.bubbleObj.visible = !!this.bubbleText;
    this.animate(dt);
  }

  updateWalk(dt) {
    this.walkTime += dt;
    const tgt = this.targetId && this.targetId !== 'lake' ? this.world.getObj(this.targetId) : null;
    if (tgt && tgt.kind === 'person') this.dest.copy(tgt.position);    // people move: follow them
    const to = new THREE.Vector3(this.dest.x - this.position.x, 0, this.dest.z - this.position.z);
    const dist = to.length();
    if (dist <= this.arrive) {
      this.onEvent(this.placeLabel ? `You walked to ${this.placeLabel}. Nothing else you wanted happened.` : `Arrived at ${this.targetId}.`);
      this.endAction();
      return;
    }
    if (this.walkTime > 60) return this.failWalk('it took too long');
    this.stuckT += dt;
    if (this.stuckT >= 2) {
      if (flatDist(this.position, this.stuckPos) < 0.6) return this.failWalk('the path is blocked');
      this.stuckT = 0; this.stuckPos.copy(this.position);
    }
    let dir = this.steer(to.divideScalar(dist));
    if (!dir) return this.failWalk('water is in the way');
    dir.add(this.world.avoidance(this.position, this.targetId).multiplyScalar(1.5)).normalize();
    const speed = !this.needsActive || this.needs.stamina > 0 ? WALK_SPEED : TIRED_SPEED;
    const nx = this.position.x + dir.x * speed * dt, nz = this.position.z + dir.z * speed * dt;
    if (this.terrain.isDry(nx, nz)) this.position.set(nx, this.terrain.heightAt(nx, nz), nz);
    this.yawTarget = Math.atan2(-dir.x, -dir.z);
  }

  // Pick a dry direction close to `dir`; sticks to one side to avoid jitter around water.
  steer(dir) {
    const p = this.position, probe = 1.2;
    if (this.terrain.isDry(p.x + dir.x * probe, p.z + dir.z * probe)) return dir.clone();
    for (const a of [25, 50, 75, 100, 130, 160]) {
      for (const sgn of [this.side, -this.side]) {
        const d = dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), (a * sgn * Math.PI) / 180);
        if (this.terrain.isDry(p.x + d.x * probe, p.z + d.z * probe)) { this.side = sgn; return d; }
      }
    }
    return null;
  }

  failWalk(reason) {
    this.onEvent(`You could not get to ${this.placeLabel || this.targetId}: ${reason}.`);
    this.endAction();
  }

  // ------------------------------------------------------------------ model & animation
  buildModel(shirtHex, hairHex) {
    const skin = mat(0xf5c294), shirt = mat(shirtHex), pants = mat(0x334d9e), hair = mat(hairHex);
    const black = mat(0x0d0d0d), bag = mat(0x805429);
    const r = this.rig;
    r.add(box(0.62, 0.8, 0.34, shirt, 0, 1.15, 0));
    r.add(box(0.5, 0.5, 0.5, skin, 0, 1.82, 0));
    r.add(box(0.54, 0.14, 0.54, hair, 0, 2.1, 0));
    if (this.gender === 'woman') {
      r.add(box(0.56, 0.75, 0.12, hair, 0, 1.72, 0.23));
      r.add(box(0.08, 0.5, 0.4, hair, -0.27, 1.8, 0.06));
      r.add(box(0.08, 0.5, 0.4, hair, 0.27, 1.8, 0.06));
    } else r.add(box(0.54, 0.32, 0.12, hair, 0, 1.94, 0.22));
    r.add(box(0.08, 0.1, 0.04, black, -0.12, 1.86, -0.26));
    r.add(box(0.08, 0.1, 0.04, black, 0.12, 1.86, -0.26));
    r.add(box(0.42, 0.5, 0.2, bag, 0, 1.2, 0.27));
    const limb = (x, y, upper, end, w, h, d, endH) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      pivot.add(box(w, h, d, upper, 0, -h / 2, 0));
      pivot.add(box(w + 0.02, endH, d + 0.04, end, 0, -h - endH / 2, -0.02));
      r.add(pivot);
      return pivot;
    };
    this.armL = limb(-0.42, 1.5, shirt, skin, 0.2, 0.5, 0.2, 0.2);
    this.armR = limb(0.42, 1.5, shirt, skin, 0.2, 0.5, 0.2, 0.2);
    this.legL = limb(-0.15, 0.75, pants, black, 0.26, 0.62, 0.26, 0.13);
    this.legR = limb(0.15, 0.75, pants, black, 0.26, 0.62, 0.26, 0.13);

    // Floating name label + speech bubble (HTML, positioned by CSS2DRenderer).
    this.nameLabel = document.createElement('div');
    this.nameLabel.className = 'name-label';
    this.nameLabel.textContent = this.charName;
    const nl = new CSS2DObject(this.nameLabel);
    nl.position.set(0, 2.45, 0);
    this.group.add(nl);
    this.bubbleEl = document.createElement('div');
    this.bubbleEl.className = 'bubble';
    this.bubbleObj = new CSS2DObject(this.bubbleEl);
    this.bubbleObj.position.set(0, 2.8, 0);
    this.bubbleObj.center.set(0.5, 1);
    this.bubbleObj.visible = false;
    this.group.add(this.bubbleObj);
  }

  animate(dt) {
    this.animT += dt;
    let ll = 0, lr = 0, al = 0, ar = 0, rigY = 0, lean = 0;
    switch (this.state) {
      case 'walk': {
        this.walkPhase += dt * (!this.needsActive || this.needs.stamina > 0 ? 9 : 6);
        const s = Math.sin(this.walkPhase);
        ll = s * 0.8; lr = -s * 0.8; al = -s * 0.7; ar = s * 0.7; rigY = Math.abs(Math.cos(this.walkPhase)) * 0.06; break;
      }
      case 'gather': ar = 1.1 + Math.sin(this.animT * 9) * 0.9; al = 0.3; lean = -0.15; break;
      case 'eat': ar = 2.3 + Math.sin(this.animT * 12) * 0.15; break;
      case 'drink': lean = -0.7; al = ar = 0.9; break;
      case 'rest': case 'sit': rigY = -0.62; ll = lr = 1.45; al = ar = 0.4; break;
      case 'say': ar = 2.6 + Math.sin(this.animT * 8) * 0.35; break;
      case 'intend': ar = 2.0 + Math.sin(this.animT * 1.5) * 0.1; al = Math.sin(this.animT * 1.2) * 0.1; break;
      case 'dead': lean = -1.5; break;
      default: al = Math.sin(this.animT * 1.5) * 0.05; ar = -al;
    }
    // Same right-handed rotation as the Godot version: positive X swings a limb forward (-Z).
    const k = Math.min(1, dt * 12);
    this.legL.rotation.x = lerp(this.legL.rotation.x, ll, k);
    this.legR.rotation.x = lerp(this.legR.rotation.x, lr, k);
    this.armL.rotation.x = lerp(this.armL.rotation.x, al, k);
    this.armR.rotation.x = lerp(this.armR.rotation.x, ar, k);
    this.rig.position.y = lerp(this.rig.position.y, rigY, k);
    this.rig.rotation.x = lerp(this.rig.rotation.x, lean, Math.min(1, dt * 6));
    let d = this.yawTarget - this.group.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.group.rotation.y += d * Math.min(1, dt * 10);
  }
}
