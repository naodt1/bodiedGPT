// nature.js - wind-swayed grass (InstancedMesh), voxel clouds, and the sky dome +
// sun/moon lighting driven by the in-world clock.
import * as THREE from 'three';
import { Rng, clamp, lerp } from './rng.js';
import { Session } from './session.js';

// ------------------------------------------------------------------ grass
export function makeGrass(terrain, shelterPos, count = 17000) {
  // One tuft = 6 thin triangles with a dark base and bright tip.
  const rng = new Rng(5);
  const pos = [], col = [];
  for (let i = 0; i < 6; i++) {
    const ang = rng.float() * Math.PI * 2, ox = rng.range(-0.22, 0.22), oz = rng.range(-0.22, 0.22);
    const h = rng.range(0.5, 1.0), w = rng.range(0.07, 0.11);
    const lx = rng.range(-0.15, 0.15), lz = rng.range(-0.15, 0.15);
    const c = Math.cos(ang), s = Math.sin(ang);
    pos.push(ox - w * c, 0, oz - w * s, ox + lx, h, oz + lz, ox + w * c, 0, oz + w * s);
    col.push(0.55, 0.55, 0.55, 1, 1, 1, 0.55, 0.55, 0.55);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill([0, 1, 0]).flat(), 3));

  const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const uniforms = { uTime: { value: 0 } };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vec3 wpos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
       float ph = wpos.x * 0.35 + wpos.z * 0.27;
       float sw = sin(uTime * 1.6 + ph) + 0.5 * sin(uTime * 3.7 + ph * 1.7);
       float hh = position.y * position.y;
       transformed.x += sw * 0.16 * hh;
       transformed.z += sw * 0.08 * hh;`);
  };

  const mesh = new THREE.InstancedMesh(geo, material, count);
  const light = new THREE.Color(0.34, 0.62, 0.17), dark = new THREE.Color(0.12, 0.34, 0.09);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  const r2 = new Rng(99);
  let placed = 0, tries = 0;
  while (placed < count && tries < count * 6) {
    tries++;
    const r = 74 * Math.sqrt(r2.float()), a = r2.float() * Math.PI * 2;
    const x = Math.cos(a) * r, z = Math.sin(a) * r, h = terrain.heightAt(x, z);
    if (h < 1.05) continue;
    if (Math.hypot(x - shelterPos.x, z - shelterPos.z) < 2.4) continue;
    const s = r2.range(0.35, 0.65);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r2.float() * Math.PI * 2);
    sc.set(s, s * r2.range(0.8, 1.3), s);
    p.set(x, h - 0.05, z);
    m.compose(p, q, sc);
    mesh.setMatrixAt(placed, m);
    mesh.setColorAt(placed, dark.clone().lerp(light, r2.float()));
    placed++;
  }
  mesh.count = placed;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.userData.uniforms = uniforms;
  return mesh;
}

// ------------------------------------------------------------------ clouds
export class Clouds {
  constructor(count = 16) {
    this.group = new THREE.Group();
    this.area = 160;
    const rng = new Rng(3);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.35 });
    const snap = (v) => Math.round(v / 2) * 2;
    for (let i = 0; i < count; i++) {
      const c = new THREE.Group();
      const blocks = 4 + rng.int(5);
      for (let b = 0; b < blocks; b++) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(snap(rng.range(5, 10)) || 2, snap(rng.range(2, 4)) || 2, snap(rng.range(4, 8)) || 2), mat);
        mesh.position.set(snap(b * 3.5 + rng.range(-2, 2)), snap(rng.range(0, 2.5)), snap(rng.range(-3, 3)));
        c.add(mesh);
      }
      c.position.set(rng.range(-this.area, this.area), rng.range(40, 60), rng.range(-this.area, this.area));
      this.group.add(c);
    }
    this.mat = mat;
  }
  update(dt) {
    for (const c of this.group.children) {
      c.position.x += 1.2 * dt;
      if (c.position.x > this.area) c.position.x -= this.area * 2;
    }
  }
}

// ------------------------------------------------------------------ sky + lighting
export class Sky {
  constructor(scene) {
    this.scene = scene;
    this.uniforms = {
      topColor: { value: new THREE.Color() },
      horizonColor: { value: new THREE.Color() },
    };
    const geo = new THREE.SphereGeometry(450, 24, 12);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 topColor; uniform vec3 horizonColor; varying vec3 vDir;
        void main(){ float t = clamp(vDir.y * 1.6, 0.0, 1.0); gl_FragColor = vec4(mix(horizonColor, topColor, t), 1.0); }`,
    });
    this.dome = new THREE.Mesh(geo, mat);
    scene.add(this.dome);

    this.hemi = new THREE.HemisphereLight(0xbcd6ff, 0x4a5a30, 0.6);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2e0, 1.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40; sc.near = 1; sc.far = 200;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    scene.add(this.sun);
    scene.add(this.sun.target);
    scene.fog = new THREE.FogExp2(0xbcd6ff, 0.0045);
    this.lastHour = -100;
  }

  // focus = where the camera looks (shadows follow it)
  update(focus, force = false) {
    this.dome.position.copy(focus);
    const h = Session.hour();
    if (force || Math.abs(h - this.lastHour) > 0.02) {
      this.lastHour = h;
      const elev = Math.sin(((h - 6) / 12) * Math.PI);           // 1 noon, 0 at 6/18, -1 midnight
      const day = clamp(elev * 2.5 + 0.25, 0, 1);
      const dusk = clamp(1 - Math.abs(elev) * 4, 0, 1);
      const top = new THREE.Color(0.01, 0.02, 0.07).lerp(new THREE.Color(0.20, 0.45, 0.85), day);
      const hor = new THREE.Color(0.05, 0.07, 0.16).lerp(new THREE.Color(0.66, 0.80, 0.94), day)
        .lerp(new THREE.Color(0.95, 0.55, 0.35), dusk * 0.6);
      this.uniforms.topColor.value.copy(top);
      this.uniforms.horizonColor.value.copy(hor);
      this.scene.fog.color.copy(hor);
      this.hemi.intensity = lerp(0.15, 0.75, day);
      this.hemi.color.copy(new THREE.Color(0.35, 0.4, 0.7).lerp(new THREE.Color(0.75, 0.84, 1.0), day));
      this.night = elev <= 0;
      if (elev > 0) {
        const pitch = lerp(6, 62, elev) * Math.PI / 180, yaw = (40 + (h - 12) * 10) * Math.PI / 180;
        this.sunDir = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
        this.sun.color.copy(new THREE.Color(1.0, 0.62, 0.42).lerp(new THREE.Color(1.0, 0.95, 0.88), clamp(elev * 2.5, 0, 1)));
        this.sun.intensity = lerp(0.3, 2.0, clamp(elev * 2, 0, 1));
      } else {
        this.sunDir = new THREE.Vector3(-0.4, 0.75, -0.5).normalize();   // moonlight
        this.sun.color.set(0x8ca6ff);
        this.sun.intensity = 0.25;
      }
      this.sun.castShadow = this.sun.intensity > 0.35;
    }
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 90);
    this.sun.target.position.copy(focus);
  }
}
