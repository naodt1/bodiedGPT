// needs.js - hunger & tiredness (stamina) and hidden health. With death off, health
// never goes below 10: starving only makes them weak.
import { Session } from './session.js';
import { clamp } from './rng.js';

const HUNGER_DRAIN = 0.06, WALK_DRAIN = 0.25, IDLE_REGEN = 0.15, REST_REGEN = 5, SHELTER_REGEN = 9;
const STARVE_DAMAGE = 0.2, MIN_HEALTH = 10, HEAL_RATE = 0.4;

export class Needs {
  constructor() {
    this.health = 100; this.hunger = 100; this.stamina = 100;
    this.warned = {};
    this.onWarning = () => {};
  }

  static isNight() { const h = Session.hour(); return h >= 22 || h < 5; }

  tick(dt, walking, resting, inShelter) {
    this.hunger = Math.max(0, this.hunger - HUNGER_DRAIN * dt);
    if (walking) this.stamina -= WALK_DRAIN * dt;
    else if (resting) this.stamina += (inShelter ? SHELTER_REGEN : REST_REGEN) * dt;
    else if (Needs.isNight()) this.stamina -= 0.05 * dt;    // sleepy at night
    else this.stamina += IDLE_REGEN * dt;
    this.stamina = clamp(this.stamina, 0, 100);
    if (this.hunger <= 0) this.health -= STARVE_DAMAGE * dt;
    else if (this.hunger > 50 && this.health < 100) this.health += HEAL_RATE * (resting ? 2 : 1) * dt;
    this.health = clamp(this.health, Session.death ? 0 : MIN_HEALTH, 100);
    this.edge('hunger', this.hunger < 30, this.hunger > 45, 'Your stomach growls. You are getting hungry.');
    this.edge('starving', this.hunger <= 0, this.hunger > 10, 'You are starving and feel weak and faint.');
    this.edge('stamina', this.stamina < 20, this.stamina > 40, 'You are exhausted and need to rest.');
    this.edge('health', this.health < 40, this.health > 60, 'You feel unwell.');
  }

  edge(key, trigger, rearm, text) {
    if (trigger && !this.warned[key]) { this.warned[key] = true; this.onWarning(text); }
    else if (rearm) this.warned[key] = false;
  }

  add(stat, v) { this[stat] = clamp(this[stat] + v, 0, 100); }
  isDead() { return Session.death && this.health <= 0; }

  // How the body feels, in words (the AI never gets numbers).
  feelings() {
    const p = [];
    const h = this.hunger, t = 100 - this.stamina;
    p.push(h > 80 ? 'You are not hungry.' : h > 55 ? 'You are a little hungry.' : h > 30 ? 'You are hungry.' : h > 5 ? 'You are very hungry; your stomach hurts.' : 'You are starving and feel weak.');
    p.push(t < 20 ? 'You feel well rested.' : t < 45 ? 'You feel slightly tired.' : t < 70 ? 'You feel tired.' : t < 90 ? 'You feel very tired; your legs are heavy.' : 'You are exhausted.');
    if (Needs.isNight() && t > 30) p.push('It is late and you feel sleepy.');
    if (this.health < 25) p.push('You feel very unwell.'); else if (this.health < 50) p.push('You feel unwell.');
    return p.join(' ');
  }

  static hungerWord(v) { return v > 80 ? 'full' : v > 55 ? 'peckish' : v > 30 ? 'hungry' : v > 5 ? 'very hungry' : 'starving'; }
  static tiredWord(stam) { const t = 100 - stam; return t < 20 ? 'rested' : t < 45 ? 'a bit tired' : t < 70 ? 'tired' : t < 90 ? 'very tired' : 'exhausted'; }
}
