// objects.js - trees, rocks, berry bushes, the shelter and landmarks (campfire, pier,
// lookout, bench, boat, flowers). Ids look like tree_3, rock_1, bush_2, plus "lake",
// "shelter", "campfire", "pier", "lookout", "bench", "boat", "flowers_1".
import * as THREE from 'three';
import { Rng, flatDist } from './rng.js';
import { mat, box, cone, cylinder, blob, tint } from './mesh.js';

export const REACH = 2.8;   // how close you must be to gather

class WorldObject {
  constructor(kind, id, variant, seed) {
    this.kind = kind; this.id = id; this.variant = variant;
    this.rng = new Rng(seed);
    this.group = new THREE.Group();
    this.amount = 0; this.maxAmount = 0; this.bodyRadius = 0; this.regrowTime = 90;
    this._regrow = 0; this.gfx = null; this.light = null;
    this.group.rotation.y = this.rng.float() * Math.PI * 2;
    const build = {
      tree: this.buildTree, rock: this.buildRock, bush: this.buildBush, shelter: this.buildShelter,
      campfire: this.buildCampfire, pier: this.buildPier, lookout: this.buildLookout,
      bench: this.buildBench, boat: this.buildBoat, flowers: this.buildFlowers,
    }[kind];
    build.call(this);
  }

  get position() { return this.group.position; }
  isGatherable() { return ['tree', 'rock', 'bush'].includes(this.kind); }
  itemName() { return { tree: 'wood', rock: 'stone', bush: 'berries' }[this.kind] || ''; }

  harvest() {
    if (!this.isGatherable() || this.amount <= 0) return null;
    this.amount -= 1;
    if (this.amount === 0) { this._regrow = 0; if (this.gfx) this.gfx.visible = false; }
    return { item: this.itemName(), qty: 1 };
  }

  describe(dist) {
    const d = dist.toFixed(1);
    let s = '';
    switch (this.kind) {
      case 'tree': s = `tree, ${d}m, ${this.amount > 0 ? this.amount + ' wood left' : 'no wood left (regrowing)'}`; break;
      case 'rock': s = `rock, ${d}m, ${this.amount > 0 ? this.amount + ' stone left' : 'no stone left (regrowing)'}`; break;
      case 'bush': s = `berry bush, ${d}m, ${this.amount > 0 ? this.amount + ' berries left' : 'no berries (regrowing)'}`; break;
      case 'shelter': s = `your shelter, ${d}m (rest here for faster recovery)`; break;
      case 'campfire': s = `a campfire in a ring of stones, ${d}m`; break;
      case 'pier': s = `a wooden pier reaching out over the lake, ${d}m`; break;
      case 'lookout': s = `a hilltop lookout with a stone cairn and a view over the whole island, ${d}m`; break;
      case 'bench': s = `a wooden bench on the coast facing the sea, ${d}m`; break;
      case 'boat': s = `an old wooden rowboat lying upside down on the beach, ${d}m`; break;
      case 'flowers': s = `a meadow of colourful wildflowers, ${d}m`; break;
    }
    if (this.isGatherable() && this.amount > 0 && dist <= REACH) s += ' - IN REACH';
    return s;
  }

  update(dt) {
    if (this.light) {
      const t = performance.now();
      this.light.intensity = 6 + Math.sin(t * 0.013) * 1.2 + Math.sin(t * 0.031) * 0.7;
    }
    if (this.maxAmount > 0 && this.amount === 0) {
      this._regrow += dt;
      if (this._regrow >= this.regrowTime) { this.amount = this.maxAmount; if (this.gfx) this.gfx.visible = true; }
    }
  }

  // ---------------------------------------------------------------- visuals
  buildTree() {
    this.amount = this.maxAmount = 3; this.regrowTime = 120; this.bodyRadius = 0.55;
    const s = this.rng.range(0.85, 1.35);
    this.group.scale.setScalar(s);
    const cols = [0x4db838, 0x298c4d, 0xfa851f];
    const leaf = mat(tint(cols[this.variant % 3], this.rng.range(0.9, 1.1)));
    this.group.add(cylinder(0.16, 0.26, 1.6, 6, mat(0x73471f), 0, 0.8, 0));
    this.gfx = new THREE.Group();
    this.gfx.position.y = 1.3;
    this.group.add(this.gfx);
    if (this.rng.float() < 0.55) {
      this.gfx.add(cone(1.45, 1.7, 7, leaf, 0, 0.75, 0));
      this.gfx.add(cone(1.1, 1.5, 7, leaf, 0, 1.6, 0));
      this.gfx.add(cone(0.75, 1.3, 7, leaf, 0, 2.4, 0));
    } else {
      this.gfx.add(blob(1.3, 0.85, 6, 4, leaf, 0, 1.3, 0));
      this.gfx.add(blob(0.85, 0.9, 6, 3, leaf, 0.6, 1.9, 0.3));
    }
  }

  buildRock() {
    this.amount = this.maxAmount = 3; this.regrowTime = 150; this.bodyRadius = 0.9;
    this.gfx = new THREE.Group();
    this.group.add(this.gfx);
    const n = 2 + this.rng.int(2);
    for (let i = 0; i < n; i++) {
      const g = this.rng.range(0.5, 0.65);
      const r = this.rng.range(0.45, 0.85) * (i === 0 ? 1 : 0.7);
      const b = blob(r, 0.75, 5, 3, mat(new THREE.Color(g, g + 0.01, g + 0.04).getHex()),
        i ? this.rng.range(-0.5, 0.5) : 0, r * 0.35, i ? this.rng.range(-0.5, 0.5) : 0);
      b.rotation.set(this.rng.float() * 0.6, this.rng.float() * 6, this.rng.float() * 0.6);
      this.gfx.add(b);
    }
  }

  buildBush() {
    this.amount = this.maxAmount = 3; this.regrowTime = 60; this.bodyRadius = 0.8;
    const leaf = mat(0x2e8c38);
    this.group.add(blob(0.75, 0.7, 6, 3, leaf, 0, 0.45, 0));
    this.group.add(blob(0.5, 0.8, 6, 3, leaf, 0.45, 0.35, 0.2));
    this.gfx = new THREE.Group();
    this.group.add(this.gfx);
    const berry = mat(0xeb1f38, 0.35);
    for (let i = 0; i < 8; i++) {
      const a = this.rng.float() * Math.PI * 2, y = this.rng.range(0.15, 0.85), r = Math.sqrt(1 - y * y);
      this.gfx.add(blob(0.11, 1, 5, 3, berry, Math.cos(a) * r * 0.75, 0.45 + y * 0.5, Math.sin(a) * r * 0.75));
    }
  }

  buildShelter() {
    this.group.rotation.y = 0;
    const wood = mat(0x946638), dark = mat(0x664224);
    this.group.add(box(3.4, 0.4, 3.4, wood, 0, 0.05, 0));
    for (const x of [-1.5, 1.5]) for (const z of [-1.5, 1.5]) this.group.add(box(0.18, 2.2, 0.18, dark, x, 1.2, z));
    this.group.add(box(3.2, 1.6, 0.12, wood, 0, 1.0, 1.5));
    const roof = cone(2.7, 1.4, 4, mat(0xcc4733), 0, 3.0, 0);
    roof.rotation.y = Math.PI / 4;
    this.group.add(roof);
    this.group.add(box(1.3, 0.2, 0.75, mat(0x4d80d9), 0, 0.35, 0.8));
    this.group.add(box(0.4, 0.12, 0.5, mat(0xf2f2f2), -0.45, 0.5, 0.8));
  }

  buildCampfire() {
    const stone = mat(0x80808a);
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI * 2 * i) / 8;
      this.group.add(blob(0.18, 0.7, 5, 3, stone, Math.cos(a) * 0.7, 0.08, Math.sin(a) * 0.7));
    }
    for (let i = 0; i < 3; i++) {
      const l = cylinder(0.07, 0.08, 1.0, 5, mat(0x59381f), 0, 0.15, 0);
      l.rotation.set(Math.PI / 2, (Math.PI * 2 * i) / 3, 0.25);
      this.group.add(l);
    }
    this.group.add(cone(0.32, 0.8, 5, mat(0xff731a, 2.5), 0, 0.5, 0));
    this.group.add(cone(0.18, 0.55, 5, mat(0xffd94d, 2.5), 0, 0.45, 0));
    this.light = new THREE.PointLight(0xff9a4d, 6, 9, 1.5);
    this.light.position.y = 0.9;
    this.group.add(this.light);
  }

  buildPier() {
    const wood = mat(0x8c6138), dark = mat(0x593d24);
    this.group.add(box(1.6, 0.14, 8, wood, 0, 0.35, -3.5));
    for (const z of [-0.5, -3.5, -6.5]) for (const x of [-0.7, 0.7]) this.group.add(box(0.16, 2, 0.16, dark, x, -0.6, z));
  }

  buildLookout() {
    const stone = mat(0x8c8c94);
    this.group.add(blob(0.6, 0.6, 6, 3, stone, 0, 0.25, 0));
    this.group.add(blob(0.45, 0.6, 6, 3, stone, 0.05, 0.65, 0));
    this.group.add(blob(0.3, 0.7, 5, 3, stone, -0.03, 0.95, 0.02));
    this.group.add(blob(0.18, 0.8, 5, 3, stone, 0, 1.18, 0));
    this.addBench(0, 1.8);
  }

  buildBench() { this.addBench(0, 0); }

  addBench(x, z) {
    const wood = mat(0x8c6138), dark = mat(0x593d24);
    this.group.add(box(1.8, 0.1, 0.5, wood, x, 0.45, z));
    this.group.add(box(1.8, 0.45, 0.08, wood, x, 0.75, z + 0.24));
    for (const lx of [-0.75, 0.75]) this.group.add(box(0.1, 0.45, 0.45, dark, x + lx, 0.22, z));
  }

  buildBoat() {
    const hull = mat(0x734d33);
    this.group.add(box(1.3, 0.45, 3.2, hull, 0, 0.25, 0));
    this.group.add(box(1.32, 0.12, 3.22, mat(0x40739a), 0, 0.08, 0));
    this.group.add(box(0.12, 0.1, 3.3, hull, 0, 0.52, 0));
    const oar = box(0.08, 0.05, 2.2, hull, 1.0, 0.04, 0.3);
    oar.rotation.y = 0.4;
    this.group.add(oar);
  }

  buildFlowers() {
    const cols = [0xf2669a, 0xffd940, 0xf2f2ff, 0xa673f2];
    for (let i = 0; i < 40; i++) {
      const a = this.rng.float() * Math.PI * 2, r = Math.sqrt(this.rng.float()) * 2.6;
      const f = blob(0.09, 1, 5, 3, mat(cols[this.rng.int(cols.length)], 0.15), Math.cos(a) * r, 0.28, Math.sin(a) * r);
      f.castShadow = false;
      this.group.add(f);
    }
  }
}

export class WorldObjects {
  constructor(terrain) {
    this.terrain = terrain;
    this.objects = {};   // id -> WorldObject
    this.people = {};    // id -> Character
    this.solids = [];
    this.group = new THREE.Group();
  }

  generate(seed = 42) {
    const rng = new Rng(seed);
    this.spawn('shelter', 'shelter', this.findSpot(rng, 0, new THREE.Vector2(-8, 6), 8), 0, rng);
    this.spawnLandmarks(rng);
    const centers = [];
    for (let i = 0; i < 9; i++) centers.push(this.findSpot(rng, 0));
    for (let i = 0; i < 60; i++) {
      let p = null;
      if (rng.float() < 0.7) p = this.findSpot(rng, 3, centers[rng.int(centers.length)], 9);
      if (!p) p = this.findSpot(rng, 3);
      const v = rng.float() < 0.5 ? 0 : rng.float() < 0.5 ? 1 : 2;
      this.spawn('tree', `tree_${i + 1}`, p, v, rng);
    }
    for (let i = 0; i < 24; i++) this.spawn('rock', `rock_${i + 1}`, this.findSpot(rng, 3), 0, rng);
    for (let i = 0; i < 14; i++) {
      const near = i < 2 ? new THREE.Vector2(-8, 6) : null;
      this.spawn('bush', `bush_${i + 1}`, this.findSpot(rng, 3, near, 14), 0, rng);
    }
    return this.group;
  }

  findSpot(rng, minGap, around = null, aroundR = 0) {
    const t = this.terrain;
    for (let attempt = 0; attempt < 300; attempt++) {
      let p;
      if (around) p = new THREE.Vector2(around.x + rng.range(-aroundR, aroundR), around.y + rng.range(-aroundR, aroundR));
      else { const r = 64 * Math.sqrt(rng.float()), a = rng.float() * Math.PI * 2; p = new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r); }
      if (t.heightAt(p.x, p.y) < 1.3) continue;
      if (p.distanceTo(t.lakeCenter) < t.lakeRadius + 3.5) continue;
      let ok = true;
      for (const o of Object.values(this.objects)) {
        const gap = Math.max(minGap, o.kind === 'shelter' ? 3.5 : 0);
        if (Math.hypot(o.position.x - p.x, o.position.z - p.y) < gap) { ok = false; break; }
      }
      if (ok) return p;
    }
    return around ? null : new THREE.Vector2(0, 0);
  }

  spawn(kind, id, p, variant, rng) {
    if (!p) p = this.findSpot(rng, 3);
    const o = new WorldObject(kind, id, variant, Math.floor(rng.float() * 1e9));
    o.group.position.set(p.x, this.terrain.heightAt(p.x, p.y) - 0.05, p.y);
    this.group.add(o.group);
    this.objects[id] = o;
    if (o.bodyRadius > 0) this.solids.push(o);
    return o;
  }

  spawnLandmarks(rng) {
    const sh = this.objects.shelter.position;
    const home = new THREE.Vector2(sh.x, sh.z);
    this.spawn('campfire', 'campfire', this.findSpot(rng, 2.5, new THREE.Vector2(home.x + 5, home.y + 3), 3), 0, rng);
    const shore = this.terrain.shorePointToward(new THREE.Vector3(home.x, 0, home.y));
    this.face(this.spawn('pier', 'pier', new THREE.Vector2(shore.x, shore.z), 0, rng), this.terrain.lakePosition());
    let best = new THREE.Vector2(), bestH = -99;
    for (let x = -70; x <= 70; x += 3) for (let z = -70; z <= 70; z += 3) {
      const h = this.terrain.heightAt(x, z);
      if (h > bestH && Math.hypot(x - this.terrain.lakeCenter.x, z - this.terrain.lakeCenter.y) > this.terrain.lakeRadius + 4) { bestH = h; best = new THREE.Vector2(x, z); }
    }
    this.spawn('lookout', 'lookout', best, 0, rng);
    const bench = this.coastSpot(Math.PI, 0.9, 1.6);
    this.face(this.spawn('bench', 'bench', bench, 0, rng), new THREE.Vector3(bench.x * 2, 0, bench.y * 2));
    this.spawn('boat', 'boat', this.coastSpot(0.2, 0.25, 0.7), 0, rng);
    for (let i = 0; i < 3; i++) this.spawn('flowers', `flowers_${i + 1}`, this.findSpot(rng, 4), 0, rng);
  }

  coastSpot(angle, lo, hi) {
    for (let k = 0; k < 40; k++) {
      const a = angle + ((k % 2) * 2 - 1) * Math.floor(k / 2) * 0.08;
      for (let r = 40; r < 90; r++) {
        const x = Math.cos(a) * r, z = Math.sin(a) * r, h = this.terrain.heightAt(x, z);
        if (h >= lo && h <= hi) return new THREE.Vector2(x, z);
      }
    }
    return new THREE.Vector2(-30, 0);
  }

  // Rotate so the object's local -Z faces the target.
  face(o, target) {
    const dx = target.x - o.position.x, dz = target.z - o.position.z;
    o.group.rotation.y = Math.atan2(-dx, -dz);
  }

  update(dt) { for (const o of Object.values(this.objects)) o.update(dt); }

  getObj(id) { return this.objects[id] || this.people[id] || null; }
  hasTarget(id) { return id === 'lake' || !!this.objects[id] || !!this.people[id]; }
  addPerson(c) { this.people[c.id] = c; }
  shelterPosition() { return this.objects.shelter.position.clone(); }

  nearestOfKind(pos, kind) {
    let best = null, bd = 1e9;
    for (const o of Object.values(this.objects)) {
      if (o.kind !== kind) continue;
      const d = flatDist(pos, o.position);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  nearest(pos) {
    let best = { id: '', dist: 9999 };
    for (const [id, o] of Object.entries(this.objects)) {
      const d = flatDist(pos, o.position);
      if (d < best.dist) best = { id, dist: d };
    }
    return best;
  }

  // For the observation: closest objects within radius + nearest of each kind + people + lake.
  nearby(pos, radius, maxN, selfId = '') {
    const list = Object.entries(this.objects).map(([id, o]) => ({ id, dist: flatDist(pos, o.position) }));
    list.sort((a, b) => a.dist - b.dist);
    const out = [], seenKind = new Set();
    for (const e of list) {
      const kind = this.objects[e.id].kind;
      if ((e.dist <= radius && out.length < maxN) || !seenKind.has(kind)) {
        out.push({ id: e.id, dist: e.dist, text: this.objects[e.id].describe(e.dist) });
      }
      seenKind.add(kind);
    }
    for (const [pid, p] of Object.entries(this.people)) {
      if (pid === selfId) continue;
      const pd = flatDist(pos, p.position);
      out.push({ id: pid, dist: pd, text: p.describe(pd) });
    }
    const wd = this.terrain.nearestWater(pos).dist;
    if (wd < 900) out.push({ id: 'lake', dist: wd, text: `lake (fresh water), ${wd.toFixed(1)}m to the shore${wd <= 2.5 ? ' - you can drink here' : ''}` });
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  // Push-away vector from solid objects (except the walk target).
  avoidance(pos, excludeId) {
    const push = new THREE.Vector3();
    for (const o of this.solids) {
      if (o.id === excludeId || (o.amount === 0 && o.kind === 'rock')) continue;
      const dx = pos.x - o.position.x, dz = pos.z - o.position.z;
      const r = o.bodyRadius * o.group.scale.x + 0.6, l = Math.hypot(dx, dz);
      if (l < r && l > 0.001) push.add(new THREE.Vector3(dx / l, 0, dz / l).multiplyScalar((r - l) / r));
    }
    return push;
  }
}
