// mesh.js - tiny helpers for flat-shaded low-poly props built from primitives.
import * as THREE from 'three';

const matCache = new Map();

// Lambert material with flat shading (cached per colour).
export function mat(color, glow = 0) {
  const key = `${color}|${glow}`;
  if (!matCache.has(key)) {
    const c = new THREE.Color(color);
    const m = new THREE.MeshLambertMaterial({ color: c, flatShading: true });
    if (glow > 0) { m.emissive = c.clone(); m.emissiveIntensity = glow; }
    matCache.set(key, m);
  }
  return matCache.get(key);
}

function shadowed(m) { m.castShadow = true; m.receiveShadow = true; return m; }

export function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  return shadowed(m);
}

export function cone(radius, height, segments, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.ConeGeometry(radius, height, segments, 1), material);
  m.position.set(x, y, z);
  return shadowed(m);
}

export function cylinder(rTop, rBottom, height, segments, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, height, segments, 1), material);
  m.position.set(x, y, z);
  return shadowed(m);
}

// Faceted blob (low-res sphere, squashed vertically).
export function blob(radius, squash, wSeg, hSeg, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(radius, wSeg, hSeg), material);
  m.scale.set(1, squash, 1);
  m.position.set(x, y, z);
  return shadowed(m);
}

export function tint(hex, f) {
  const c = new THREE.Color(hex);
  return new THREE.Color(Math.min(1, c.r * f), Math.min(1, c.g * f), Math.min(1, c.b * f)).getHex();
}
