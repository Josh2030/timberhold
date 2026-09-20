/* ============================================================
   CONQUER — Phase 1: the battlefield and one attack.

   Deliberately small. One hand-authored enemy base, one troop type, tap to
   deploy, structures take damage and die, the round is won when the Command
   Center falls. No generator, no roster, no training queue — those are phases
   2 and 3 in claude/conquer-mode-plan.md. The point of this phase is to find
   out how it FEELS to watch, and to settle the camera and the deploy input on
   a real phone, before any of that is designed further.

   Two things here are load-bearing for everything that comes later:

   1. THE SIMULATION IS DETERMINISTIC AND RENDERER-FREE. Fixed 1/60 timestep,
      seeded RNG, no reads of wall-clock time, no DOM. `Conquer.simulate()`
      plays a whole battle with no scene at all, which is what lets verify.js
      assert that the base is beatable instead of hoping. Phase 3's generator
      needs exactly this to prove a generated layout lands in a target win-rate
      band, so it is paid for on day one rather than retrofitted.

   2. IT OWNS NO RENDER LOOP. The battle is stepped from the game's existing
      animate() while `Conquer.active` is true, so there is no second
      requestAnimationFrame to leak — the failure Forest Runner had to be given
      three sabotage-tested checks for. Closing sets one flag.

   Loaded on demand by conquerLoad() in index.html the first time a raid starts,
   so a player who never taps Conquer never downloads it.
   ============================================================ */
(function(){
'use strict';

/* ---------- the world, in world units ----------
   A wide, shallow field: this is a landscape game on a phone held sideways, and
   the camera frames the whole thing at once rather than scrolling. */
/* The field has to be meaningfully bigger than the keepout ring, or the band
   you are allowed to drop into is a sliver. It was: at 40x30 the ring's outer
   edge landed exactly on the field boundary, so a perfectly sensible drop at
   z = -14 failed `|z| > FIELD_D/2 - 1` by 5e-7 and the whole front of the ring
   was silently unusable. Found by tapping it (2026-09-20); rnDeployBand below
   is the check that stops it coming back. */
const FIELD_W = 52, FIELD_D = 38;
const BASE_KEEPOUT  = 12.5;       // no dropping inside the enemy's ground
const DEPLOY_BAND   = 4;          // usable depth of the ring, all the way round

/* ---------- balance, all of it, in one block ----------
   Not tuned by feel — nothing here has been played by a person yet. It IS tuned
   against the headless auto-battler, which is a different and weaker claim:
   with these numbers, dropping the whole army at the gap in the south wall wins
   in ~47s with six of ten raiders lost, while dropping into the solid north
   wall, or scattering them around the ring, loses outright. That is the shape
   the plan asks for — "a real chance of failing" — and these are the numbers to
   turn when Joshua has actually played it and disagrees. */
const TROOP = { hp: 120, dmg: 22, speed: 3.4, reach: 1.5, cost: 1 };
const ARMY  = 10;                 // troops per raid
const ROUND_SECONDS = 150;
const KIND = {
  cc:    { hp: 2600, r: 2.4, label: 'Command Center' },
  wall:  { hp: 420,  r: 1.1, label: 'Wall' },
  tower: { hp: 1200, r: 1.3, label: 'Watchtower', range: 13, dps: 50 },
};

/* ---------- the one base, hand-authored ----------
   A square perimeter with a gap, the Command Center dead centre, one tower
   covering the open side. Phase 3 replaces this with a seeded generator; the
   shape is written out longhand here so it is obvious what a generated one has
   to produce. */
function buildBase(){
  const s = [];
  let id = 0;
  const add = (kind, x, z) => { s.push({ id: id++, kind, x, z, hp: KIND[kind].hp, maxHp: KIND[kind].hp, r: KIND[kind].r, dead: false }); };
  add('cc', 0, 0);
  /* Spaced at 3 units against a wall piece that renders about 2.8 wide: a
     perimeter you can read as separate pieces rather than the single grey slab
     the first render produced. */
  for (let i = -3; i <= 3; i++){
    add('wall', i * 3.0,  9.0);
    if (i !== 0) add('wall', i * 3.0, -9.0);   // the gap the attackers are meant to find
  }
  for (let j = -2; j <= 2; j++){
    add('wall', -9.0, j * 3.0);
    add('wall',  9.0, j * 3.0);
  }
  add('tower', 0, -4.6);
  return s;
}

/* ---------- seeded RNG ---------- */
function rngFrom(seed){
  let a = (seed >>> 0) || 1;
  return function(){
    a += 0x6D2B79F5; a |= 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ============================================================
   THE SIMULATION — no DOM, no THREE, no Date.now()
   ============================================================ */
const DT = 1 / 60;

function newBattle(seed){
  return {
    seed: seed >>> 0,
    rng: rngFrom(seed),
    t: 0,
    structures: buildBase(),
    units: [],
    left: ARMY,
    over: false,
    won: false,
    log: [],
  };
}

function aliveStructures(b){ return b.structures.filter(s => !s.dead); }

function destroyedPct(b){
  const total = b.structures.length;
  const dead = b.structures.filter(s => s.dead).length;
  return total ? Math.round(dead / total * 100) : 0;
}

/* A drop is legal outside the enemy's ground and inside the field. The check is
   here rather than in the tap handler so the headless sim obeys the same rule a
   finger does — the "prove it works AND that it doesn't when it shouldn't"
   pairing this project keeps learning the hard way. */
function canDeploy(b, x, z){
  if (b.over || b.left <= 0) return false;
  if (Math.abs(x) > FIELD_W / 2 - 1 || Math.abs(z) > FIELD_D / 2 - 1) return false;
  if (Math.hypot(x, z) < BASE_KEEPOUT) return false;
  return true;
}

function deploy(b, x, z){
  if (!canDeploy(b, x, z)) return null;
  b.left--;
  const u = { x, z, hp: TROOP.hp, maxHp: TROOP.hp, dead: false, target: null, swing: 0 };
  b.units.push(u);
  return u;
}

/* Targeting, and it is the whole feel of the mode.

   The first version simply sent everyone at the nearest structure of any kind.
   The headless auto-battler said 92% destroyed, Command Center untouched, every
   raider dead: they ate all twenty-four walls one at a time while the tower
   picked them off, and the round could never be won. That is precisely the
   "generated puzzle that cannot be solved" failure this project already learned
   from Maji-Forest, arriving a phase early — and it was invisible from the code.

   So: raiders head for something that MATTERS (the Command Center, or a tower
   shooting at them) and only stop for a wall that is actually in the way. Walls
   are an obstacle, not a menu. Real pathfinding around them is a later phase;
   a corridor test along the straight line is the honest Phase 1 version of the
   same idea and it makes the base beatable without making walls pointless. */
function nearestTarget(b, u){
  let best = null, bestD = Infinity;
  for (const s of b.structures){
    if (s.dead || s.kind === 'wall') continue;
    const d = Math.hypot(s.x - u.x, s.z - u.z) - s.r;
    if (d < bestD){ bestD = d; best = s; }
  }
  if (best) return best;
  for (const s of b.structures){                 // walls only: nothing else left
    if (s.dead) continue;
    const d = Math.hypot(s.x - u.x, s.z - u.z) - s.r;
    if (d < bestD){ bestD = d; best = s; }
  }
  return best;
}

const CORRIDOR = 0.9;
function blockingWall(b, u, target){
  const dx = target.x - u.x, dz = target.z - u.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.001) return null;
  const nx = dx / len, nz = dz / len;
  let best = null, bestAlong = Infinity;
  for (const s of b.structures){
    if (s.dead || s.kind !== 'wall') continue;
    const px = s.x - u.x, pz = s.z - u.z;
    const along = px * nx + pz * nz;
    if (along < -0.5 || along > len) continue;               // behind, or past the target
    const off = Math.abs(px * -nz + pz * nx);
    if (off > s.r + CORRIDOR) continue;                      // not in the way
    if (along < bestAlong){ bestAlong = along; best = s; }
  }
  return best;
}

function nearestStructure(b, u){
  const t = nearestTarget(b, u);
  if (!t) return null;
  return blockingWall(b, u, t) || t;
}

function nearestUnit(b, s){
  let best = null, bestD = Infinity;
  for (const u of b.units){
    if (u.dead) continue;
    const d = Math.hypot(s.x - u.x, s.z - u.z);
    if (d < bestD){ bestD = d; best = u; }
  }
  return { unit: best, d: bestD };
}

/* One fixed tick. Everything that decides the outcome happens in here and
   nowhere else, so a battle run with a renderer and a battle run without one
   are the same battle. */
function step(b){
  if (b.over) return;
  b.t += DT;

  for (const u of b.units){
    if (u.dead) continue;
    const s = nearestStructure(b, u);
    if (!s){ continue; }
    u.target = s.id;
    const dx = s.x - u.x, dz = s.z - u.z;
    const d = Math.hypot(dx, dz);
    const stop = s.r + TROOP.reach;
    /* The epsilon is not cosmetic. A unit that arrives at EXACTLY its stop
       distance fails `d > stop` by one float ulp, steps 4e-16 units, and never
       reaches the attack branch — it stands there for the rest of the round
       looking for all the world like it is fighting. Found by the headless sim
       timing out at 150s with a full-HP survivor and zero progress; nothing on
       screen would ever have said which unit was doing nothing. */
    if (d > stop + 0.01){
      const step2 = Math.min(d - stop, TROOP.speed * DT);
      u.x += dx / d * step2;
      u.z += dz / d * step2;
      u.swing = 0;
    } else {
      u.swing += DT;
      s.hp -= TROOP.dmg * DT;
      if (s.hp <= 0){
        s.hp = 0; s.dead = true;
        b.log.push({ t: b.t, kind: 'destroyed', id: s.id, structure: s.kind });
        if (s.kind === 'cc'){ b.over = true; b.won = true; }
      }
    }
  }

  for (const s of b.structures){
    if (s.dead || s.kind !== 'tower') continue;
    const k = KIND.tower;
    const near = nearestUnit(b, s);
    if (near.unit && near.d <= k.range){
      near.unit.hp -= k.dps * DT;
      if (near.unit.hp <= 0){ near.unit.hp = 0; near.unit.dead = true; }
    }
  }

  b.units = b.units.filter(u => !u.dead);

  if (!b.over){
    if (b.t >= ROUND_SECONDS){ b.over = true; b.won = false; }
    else if (b.left <= 0 && b.units.length === 0){ b.over = true; b.won = false; }
  }
}

/* Play a whole battle with no renderer. `plan` decides where each troop lands
   and when — the default drops the whole army at the open side straight away,
   which is the "standard army" a beatability check should use. */
function simulate(opts){
  opts = opts || {};
  const b = newBattle(opts.seed === undefined ? 1 : opts.seed);
  const plan = opts.plan || defaultPlan;
  let ticks = 0;
  const maxTicks = Math.ceil(ROUND_SECONDS / DT) + 10;
  while (!b.over && ticks < maxTicks){
    plan(b, ticks);
    step(b);
    ticks++;
  }
  return { won: b.won, seconds: Math.round(b.t * 10) / 10, pct: destroyedPct(b),
           left: b.left, alive: b.units.length, battle: b };
}

function defaultPlan(b, tick){
  if (tick % 12 !== 0 || b.left <= 0) return;
  const i = ARMY - b.left;
  const x = (i - (ARMY - 1) / 2) * 1.6;
  deploy(b, x, -(BASE_KEEPOUT + 1.5));
}

/* ============================================================
   REWARD — the only place a Raid Medal is ever created.

   Same boundary as Timber Tokens: minted in one function, spent in one place
   (nowhere yet — the shop is Phase 2). The camp economy took a whole session to
   balance and nothing here is allowed to become a faucet into it, so a raid
   pays in its own currency and touches no camp resource at all.
   ============================================================ */
function reward(result){
  if (result.won) return 3;
  if (result.pct >= 50) return 1;
  return 0;
}

/* ============================================================
   THE VIEW — created on open, thrown away on close
   ============================================================ */
const view = { scene: null, camera: null, root: null, marks: {}, units: new Map(), ground: null };
let battle = null, acc = 0, overlay = null, hpLayer = null, onEnd = null;

function mat(hex){ return new THREE.MeshLambertMaterial({ color: hex }); }

function buildScene(){
  const sc = new THREE.Scene();
  sc.background = new THREE.Color(0x091209);
  sc.fog = new THREE.Fog(0x091209, 46, 104);

  sc.add(new THREE.HemisphereLight(0x7fa489, 0x10201a, 0.62));
  const sun = new THREE.DirectionalLight(0xffe7bd, 0.85);
  sun.position.set(14, 26, -12);
  sc.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(FIELD_W + 14, FIELD_D + 14),
    new THREE.MeshLambertMaterial({ color: 0x16301c })
  );
  ground.rotation.x = -Math.PI / 2;
  sc.add(ground);
  view.ground = ground;

  /* the enemy's ground, so "you cannot drop in there" is visible rather than
     something the player discovers by being told no */
  const keep = new THREE.Mesh(
    new THREE.RingGeometry(BASE_KEEPOUT - 0.55, BASE_KEEPOUT, 72),
    new THREE.MeshBasicMaterial({ color: 0xff1008, transparent: true, opacity: 0.92, depthWrite: false })
  );
  keep.rotation.x = -Math.PI / 2;
  keep.position.y = 0.02;
  sc.add(keep);

  const cam = new THREE.PerspectiveCamera(46, 16 / 9, 0.5, 240);
  view.scene = sc;
  view.camera = cam;
  view.root = new THREE.Group();
  sc.add(view.root);
  return sc;
}

/* Kit pieces where the kit has one, primitives where it does not. The troops
   are deliberately primitive: `character-archer` is a SkinnedMesh and cloning
   one in three r128 does not bring its skeleton with it — the camp crowd needed
   a per-bone rebuild to animate at all (2026-09-03(a)). That is a phase-2
   problem, not a reason to hold up finding out whether the battle is fun. */
function structureMesh(s){
  const g = new THREE.Group();
  if (s.kind === 'cc'){
    const body = (typeof inst === 'function' && inst('pk-castle-gate', 2.1)) || null;
    if (body && body.children.length) g.add(body);
    else {
      const m = new THREE.Mesh(new THREE.BoxGeometry(3.6, 3.2, 3.6), mat(0x8a6a42));
      m.position.y = 1.6; g.add(m);
    }
  } else if (s.kind === 'tower'){
    const body = (typeof inst === 'function' && inst('pk-tower-watch', 1.6)) || null;
    if (body && body.children.length) g.add(body);
    else {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.2, 4.2, 8), mat(0x9a9a9a));
      m.position.y = 2.1; g.add(m);
    }
  } else {
    const body = (typeof inst === 'function' && inst('pk-castle-wall', 1.35)) || null;
    if (body && body.children.length) g.add(body);
    else {
      const m = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.5, 0.9), mat(0x7d7d85));
      m.position.y = 0.75; g.add(m);
    }
  }
  g.position.set(s.x, 0, s.z);
  return g;
}

/* Bigger and brighter than scale alone would suggest. Seen from a camera that
   has to hold a 20-unit base in frame, a person-sized figure is a few pixels
   and the first render simply had no visible troops in it. */
function unitMesh(){
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.52, 1.5, 8), mat(0xe8503f));
  body.position.y = 0.75;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.38, 10, 8), mat(0xffd9a8));
  head.position.y = 1.78;
  const plume = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.5, 8), mat(0xffe45b));
  plume.position.y = 2.2;
  g.add(body); g.add(head); g.add(plume);
  return g;
}

function frameCamera(){
  const aspect = Math.max(0.45, innerWidth / Math.max(1, innerHeight));
  view.camera.aspect = aspect;
  /* Pull back until the whole field fits whichever way the phone is held. Held
     upright the field is wider than the screen, so distance is driven by width
     rather than by a constant. */
  /* Frame the fight: the base plus the ring you deploy into, not the whole
     empty field it sits on. */
  const halfW = BASE_KEEPOUT + DEPLOY_BAND + 3, halfD = BASE_KEEPOUT + DEPLOY_BAND + 2;
  const vFov = view.camera.fov * Math.PI / 180;
  const distForH = halfD / Math.tan(vFov / 2);
  const distForW = halfW / (Math.tan(vFov / 2) * aspect);
  const dist = Math.max(distForH, distForW) * 1.12;
  /* Looking from -z, which is the side the wall has its gap in: raiders walk
     TOWARD the camera instead of arriving behind the base where the first
     render hid them completely. */
  view.camera.position.set(0, dist * 0.82, -dist * 0.72);
  view.camera.lookAt(0, 0, 0);
  view.camera.updateProjectionMatrix();
}

/* ---------- HP bars, projected ---------- */
function syncHpBars(){
  if (!hpLayer || !battle) return;
  const v = new THREE.Vector3();
  for (const s of battle.structures){
    let el = view.marks[s.id];
    if (!el){
      el = document.createElement('div');
      el.className = 'cqHp';
      el.innerHTML = '<i></i>';
      hpLayer.appendChild(el);
      view.marks[s.id] = el;
    }
    /* A bar over every wall at full health is twenty-four bars saying nothing,
       and together they drew a red grid over the whole base. A wall gets one
       once it has been hit; the Command Center and the tower always have one,
       because those are the two things worth watching. */
    const worthShowing = s.kind !== 'wall' || s.hp < s.maxHp;
    if (s.dead || !worthShowing){ el.style.display = 'none'; continue; }
    v.set(s.x, s.kind === 'cc' ? 3.6 : 2.2, s.z).project(view.camera);
    if (v.z > 1){ el.style.display = 'none'; continue; }
    el.style.display = 'block';
    el.style.left = ((v.x * 0.5 + 0.5) * innerWidth) + 'px';
    el.style.top  = ((-v.y * 0.5 + 0.5) * innerHeight) + 'px';
    el.firstChild.style.width = Math.max(0, s.hp / s.maxHp * 100) + '%';
    el.classList.toggle('cqHpCc', s.kind === 'cc');
  }
}

function syncMeshes(){
  const seen = new Set();
  for (const u of battle.units){
    seen.add(u);
    let m = view.units.get(u);
    if (!m){ m = unitMesh(); view.root.add(m); view.units.set(u, m); }
    m.position.set(u.x, 0, u.z);
    m.scale.setScalar(0.85 + 0.15 * (u.hp / u.maxHp));
  }
  for (const [u, m] of view.units){
    if (!seen.has(u)){ view.root.remove(m); view.units.delete(u); }
  }
  for (const s of battle.structures){
    const m = view.marks['mesh' + s.id];
    if (m) m.visible = !s.dead;
  }
}

/* ---------- HUD ---------- */
function hud(){
  if (!battle) return;
  const left = document.getElementById('cqLeft');
  const pct  = document.getElementById('cqPct');
  const time = document.getElementById('cqTime');
  if (left) left.textContent = battle.left;
  if (pct)  pct.textContent = destroyedPct(battle) + '%';
  if (time) time.textContent = Math.max(0, Math.ceil(ROUND_SECONDS - battle.t)) + 's';
}

function showResult(){
  const r = { won: battle.won, pct: destroyedPct(battle), seconds: Math.round(battle.t) };
  const medals = reward(r);
  if (typeof conquerReward === 'function') conquerReward(r, medals);
  const el = document.getElementById('cqResult');
  if (!el) return;
  el.querySelector('.cqRt').textContent = r.won ? 'BASE DESTROYED' : 'RAID FAILED';
  el.querySelector('.cqRs').textContent = r.pct + '% destroyed · ' + r.seconds + 's';
  el.querySelector('.cqRm').textContent = medals ? ('🎖️ +' + medals + ' Raid Medal' + (medals > 1 ? 's' : '')) : 'No medals this time';
  el.classList.add('cqOpen');
}

/* ---------- tap to deploy ---------- */
function groundPoint(clientX, clientY){
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, view.camera);
  const hit = ray.intersectObject(view.ground, false)[0];
  return hit ? { x: hit.point.x, z: hit.point.z } : null;
}

function onTap(ev){
  if (!battle || battle.over) return;
  const t = ev.changedTouches ? ev.changedTouches[0] : ev;
  const p = groundPoint(t.clientX, t.clientY);
  /* kept so a harness can ask what the last real tap actually resolved to --
     a refused deploy and a missed raycast look identical from outside */
  API.lastTap = { cx: t.clientX, cy: t.clientY, p: p, ok: !!(p && canDeploy(battle, p.x, p.z)) };
  if (!p) return;
  if (!canDeploy(battle, p.x, p.z)){
    if (typeof toast === 'function') toast(battle.left <= 0 ? 'No troops left' : 'Too close — drop outside the red ring');
    return;
  }
  deploy(battle, p.x, p.z);
  hud();
}

/* ---------- the frame, called from the game's own animate() ---------- */
function frame(dt){
  if (!battle) return;
  acc += Math.min(0.25, dt);
  let guard = 0;
  while (acc >= DT && guard < 12){ step(battle); acc -= DT; guard++; }
  if (acc > DT) acc = 0;                 // a long stall must not fast-forward the battle
  syncMeshes();
  syncHpBars();
  hud();
  if (battle.over && !battle._shown){ battle._shown = true; showResult(); }
}

/* ---------- open / close ---------- */
function open(opts){
  opts = opts || {};
  onEnd = opts.onEnd || null;
  battle = newBattle(opts.seed === undefined ? (Date.now() & 0x7fffffff) : opts.seed);
  acc = 0;

  buildScene();
  for (const s of battle.structures){
    const m = structureMesh(s);
    view.root.add(m);
    view.marks['mesh' + s.id] = m;
  }
  frameCamera();

  document.body.classList.add('cqRaid');
  overlay = document.getElementById('cqOverlay');
  hpLayer = document.getElementById('cqHpLayer');
  if (overlay){
    overlay.classList.add('cqOpen');
    overlay.addEventListener('pointerdown', onTap);
  }
  addEventListener('resize', frameCamera);
  API.active = true;
  hud();
}

function close(){
  API.active = false;
  document.body.classList.remove('cqRaid');
  if (overlay){
    overlay.classList.remove('cqOpen');
    overlay.removeEventListener('pointerdown', onTap);
  }
  removeEventListener('resize', frameCamera);
  const res = document.getElementById('cqResult');
  if (res) res.classList.remove('cqOpen');
  if (hpLayer) hpLayer.innerHTML = '';
  view.marks = {};
  view.units.clear();
  /* Give the GPU its memory back rather than leaving a whole battlefield
     resident behind a closed panel. */
  if (view.scene){
    view.scene.traverse(o => {
      if (o.isMesh){
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m && m.dispose && m.dispose());
      }
    });
  }
  view.scene = null; view.camera = null; view.root = null; view.ground = null;
  const b = battle; battle = null;
  if (onEnd) { const f = onEnd; onEnd = null; f(b); }
}

const API = {
  active: false,
  open, close, frame,
  simulate, newBattle, step, deploy, canDeploy, destroyedPct, reward, groundPoint,
  get scene(){ return view.scene; },
  get camera(){ return view.camera; },
  get battle(){ return battle; },
  constants: { FIELD_W, FIELD_D, BASE_KEEPOUT, DEPLOY_BAND, TROOP, ARMY, ROUND_SECONDS, KIND, DT },
};
window.Conquer = API;
})();
