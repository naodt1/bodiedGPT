// save.js - save a run and continue it later with the same memories and in-world time.
// Saves live in this browser's localStorage (key "im.save.<name>"). Never contains the API key.
import { Session } from './session.js';

const PREFIX = 'im.save.';

export function listSaves() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k.startsWith(PREFIX)) continue;
    try {
      const d = JSON.parse(localStorage.getItem(k));
      const when = new Date(d.clockMs);
      out.push({
        key: k, savedAt: d.savedAt, name: d.name,
        meta: `${d.people === 1 ? '1 subject' : '2 subjects'} · ${d.needs ? 'needs' : 'no needs'} · ${d.mode === 'free' ? 'free will' : 'action list'} · ` +
          `in-world ${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${when.toTimeString().slice(0, 5)}`,
      });
    } catch { /* skip broken */ }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

export function loadSave(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

export function saveRun(game) {
  if (!Session.saveName || !game.characters.length) return false;
  const data = {
    version: 1, name: Session.saveName, savedAt: Date.now(),
    mode: Session.mode, people: Session.people, needs: Session.needs, death: Session.death,
    clockMs: Session.clockMs, clockRate: Session.clockRate,
    characters: game.characters.map((c, i) => ({
      brain: game.brains[i].toJSON(),
      pos: [c.position.x, c.position.y, c.position.z], rot: c.group.rotation.y,
      inventory: c.inventory, needs: [c.needs.health, c.needs.hunger, c.needs.stamina],
      survivalTime: c.survivalTime, dead: c.state === 'dead',
    })),
    objects: Object.fromEntries(Object.entries(game.world.objects).map(([id, o]) => [id, o.amount])),
    log: game.hud ? game.hud.entries.slice(-200) : [],
  };
  try { localStorage.setItem(PREFIX + Session.saveName, JSON.stringify(data)); return true; } catch { return false; }
}

export function applySession(d) {
  Object.assign(Session, { mode: d.mode, people: d.people, needs: d.needs, death: d.death, clockMs: d.clockMs, clockRate: d.clockRate, saveName: d.name });
}

export function applyWorld(game, d) {
  d.characters.forEach((p, i) => {
    const c = game.characters[i], b = game.brains[i];
    if (!c) return;
    b.fromJSON(p.brain);
    c.setName(b.charName);
    c.position.set(...p.pos);
    c.group.rotation.y = p.rot;
    Object.assign(c.inventory, p.inventory);
    [c.needs.health, c.needs.hunger, c.needs.stamina] = p.needs;
    c.survivalTime = p.survivalTime;
    if (p.dead) { c.state = 'dead'; c.actionText = 'dead'; b.stop(); }
  });
  for (const [id, amount] of Object.entries(d.objects)) {
    const o = game.world.objects[id];
    if (o && o.isGatherable()) { o.amount = amount; if (amount === 0 && o.gfx) o.gfx.visible = false; }
  }
  for (const e of d.log || []) game.hud.add(e);
}
