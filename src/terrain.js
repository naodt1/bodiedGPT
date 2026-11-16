// terrain.js - procedural island: rolling hills, a lake, sand shoreline, ocean.
// Everything that needs ground height calls heightAt(x, z); there is no physics.
import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { mulberry32, smoothstep, lerp, clamp } from './rng.js';

const SIZE = 220;
const CELLS = 150;
const ISLAND_RADIUS = 80;
const SEABED = -3;
export const LAND_MIN = 0.12;

export class Terrain {
  constructor() {
    this.noise = createNoise2D(mulberry32(11));
    this.lakeCenter = new THREE.Vector2(15, -9);
    this.lakeRadius = 10;
    this.group = new THREE.Group();
  }

  n(x, z) { return this.noise(x * 0.03, z * 0.03) * 0.6; }   // ~ Godot FastNoiseLite range

  heightAt(x, z) {
    const d = Math.hypot(x, z) / ISLAND_RADIUS;
    const land = 1 - smoothstep(0.55, 1.0, d);
    let h = 2.3 + this.n(x, z) * 3.0 + this.n(x * 2.3 + 50, z * 2.3) * 0.5;
    const ld = Math.hypot(x - this.lakeCenter.x, z - this.lakeCenter.y);
    h -= (1 - smoothstep(this.lakeRadius * 0.45, this.lakeRadius * 1.15, ld)) * 7.0;
    return lerp(SEABED, h, land);
  }

  isDry(x, z) { return this.heightAt(x, z) > LAND_MIN; }
  lakePosition() { return new THREE.Vector3(this.lakeCenter.x, 0, this.lakeCenter.y); }

  // Last dry point on the straight line from `from` toward the lake centre.
  shorePointToward(from) {
    const c = this.lakePosition();
    const dir = new THREE.Vector3(c.x - from.x, 0, c.z - from.z);
    const len = dir.length();
    dir.normalize();
    let last = from.clone();
    for (let t = 0; t < len; t += 0.4) {
      const p = from.clone().addScaledVector(dir, t);
      if (this.heightAt(p.x, p.z) < 0.25) break;
      last = p;
    }
    last.y = this.heightAt(last.x, last.z);
    return last;
  }

  // Nearest water by ray-marching in 24 directions -> {dist, point}
  nearestWater(pos, maxDist = 40) {
    let best = { dist: 999, point: pos.clone() };
    for (let i = 0; i < 24; i++) {
      const a = (Math.PI * 2 * i) / 24;
      const dx = Math.cos(a), dz = Math.sin(a);
      for (let t = 0; t <= Math.min(maxDist, best.dist); t += 0.5) {
        const x = pos.x + dx * t, z = pos.z + dz * t;
        if (this.heightAt(x, z) < 0) {
          if (t < best.dist) best = { dist: t, point: new THREE.Vector3(x, 0, z) };
          break;
        }
      }
    }
    return best;
  }

  build() {
    this.group.add(this.buildGround());
    this.group.add(this.buildWater());
    return this.group;
  }

  groundColor(cx, cy, cz) {
    const jitter = this.noise(cx * 9 * 0.03 + 100, cz * 9 * 0.03) * 0.025;
    let sand = new THREE.Color(0.80, 0.70, 0.44);
    if (cy < -0.3) sand = new THREE.Color(0.55, 0.50, 0.34);
    const ga = new THREE.Color(0.26, 0.55, 0.16);
    const gb = new THREE.Color(0.17, 0.42, 0.13);
    const g = ga.clone().lerp(gb, clamp(this.noise(cx * 0.0045, cz * 0.0045) * 0.8 + 0.5, 0, 1));
    const c = sand.clone().lerp(g, smoothstep(0.55, 1.1, cy));
    return new THREE.Color(c.r + jitter, c.g + jitter, c.b + jitter * 0.5);
  }

  buildGround() {
    const step = SIZE / CELLS, half = SIZE / 2;
    const grid = [];
    for (let i = 0; i <= CELLS; i++) {
      grid.push(new Float32Array(CELLS + 1));
      for (let j = 0; j <= CELLS; j++) grid[i][j] = this.heightAt(-half + i * step, -half + j * step);
    }
    const pos = [], col = [];
    const tri = (a, b, c) => {
      const cy = (a[1] + b[1] + c[1]) / 3;
      const color = this.groundColor((a[0] + b[0] + c[0]) / 3, cy, (a[2] + b[2] + c[2]) / 3);
      for (const v of [a, b, c]) { pos.push(...v); col.push(color.r, color.g, color.b); }
    };
    for (let i = 0; i < CELLS; i++) {
      for (let j = 0; j < CELLS; j++) {
        const x0 = -half + i * step, z0 = -half + j * step;
        const a = [x0, grid[i][j], z0];
        const b = [x0 + step, grid[i + 1][j], z0];
        const c = [x0 + step, grid[i + 1][j + 1], z0 + step];
        const d = [x0, grid[i][j + 1], z0 + step];
        // counter-clockwise from above (three.js front faces)
        if ((i + j) % 2 === 0) { tri(a, c, b); tri(a, d, c); }
        else { tri(a, d, b); tri(b, d, c); }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();   // non-indexed -> one normal per triangle (flat)
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    return mesh;
  }

  buildWater() {
    const geo = new THREE.PlaneGeometry(900, 900);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.18, 0.6, 0.9), transparent: true, opacity: 0.72, roughness: 0.15, metalness: 0.1,
    });
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    return m;
  }
}
