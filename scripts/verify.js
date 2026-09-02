#!/usr/bin/env node
/*
 * Timberhold pre-publish check.
 *
 * The game is one big self-contained index.html, so there is no build step to
 * catch a mistake — a bad edit would go straight to the live link. This boots
 * the real page in a headless browser and refuses to publish if anything that
 * matters is broken.
 *
 *   node scripts/verify.js          check only
 *   node scripts/verify.js --site   check, then assemble _site/ for deployment
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');

/* Files that make up the published site. Anything not listed here never
   reaches the live link — which is how .git stays unpublished. */
const SITE_FILES = [
  'index.html',
  'version.json',
  'logo.gif',
  'manifest.webmanifest',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
  'icon-512-maskable.png',
];

let failed = 0;
const ok   = m => console.log('  ✓ ' + m);
const bad  = m => { console.log('  ✗ ' + m); failed++; };
const step = m => console.log('\n' + m);

function check(cond, good, msg) { cond ? ok(good) : bad(msg || good); return cond; }

(async () => {
  console.log('Timberhold verification');

  /* ---------- 0. build stamp ----------
     version.json is what a running copy polls to find out it is out of date, so
     it is generated here from the page itself rather than maintained by hand.
     A stale version.json would tell every phone it is up to date forever. */
  step('Build stamp');
  const html = fs.readFileSync(INDEX, 'utf8');
  const bm = html.match(/const BUILD = '([^']+)'/);
  if (!bm) { bad('index.html has no BUILD constant'); }
  else {
    const build = bm[1];
    fs.writeFileSync(path.join(ROOT, 'version.json'), JSON.stringify({ build }) + '\n');
    ok('build ' + build + ' (version.json regenerated to match)');
  }

  /* ---------- 1. the files the page references must exist ---------- */
  step('Files');
  for (const f of SITE_FILES) {
    check(fs.existsSync(path.join(ROOT, f)), f, 'MISSING: ' + f);
  }
  const mb = Buffer.byteLength(html) / 1048576;
  check(mb > 0.5 && mb < 25, `index.html is ${mb.toFixed(2)} MB`,
        `index.html is ${mb.toFixed(2)} MB — suspicious, check it built correctly`);

  /* every local href/src in the page has to resolve, or it 404s in production */
  const refs = [...html.matchAll(/(?:href|src)="([^"#?:]+\.(?:png|webmanifest|json|js|css))"/g)]
    .map(m => m[1]).filter(u => !u.startsWith('//'));
  for (const r of [...new Set(refs)]) {
    check(fs.existsSync(path.join(ROOT, r)), 'referenced ' + r, 'referenced but missing: ' + r);
  }

  /* ---------- 2. manifest ---------- */
  step('Web app manifest');
  try {
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
    check(man.display === 'standalone', 'display is standalone');
    check(Array.isArray(man.icons) && man.icons.length > 0, `${man.icons.length} icons declared`);
    for (const i of man.icons) {
      check(fs.existsSync(path.join(ROOT, i.src)), 'icon ' + i.src, 'icon missing: ' + i.src);
    }
  } catch (e) { bad('manifest.webmanifest is not valid JSON: ' + e.message); }

  /* ---------- 3. the iOS home-screen tags ---------- */
  step('Home-screen app tags');
  check(/name="apple-mobile-web-app-capable"\s+content="yes"/.test(html),
        'apple-mobile-web-app-capable (launches standalone, not in Safari)');
  check(/viewport-fit=cover/.test(html), 'viewport-fit=cover');
  check(/rel="apple-touch-icon"/.test(html), 'apple-touch-icon');
  check(/env\(safe-area-inset-top/.test(html) && /env\(safe-area-inset-bottom/.test(html),
        'safe-area insets (HUD clears the notch and home indicator)');

  /* ---------- 4. every inline script parses ---------- */
  step('JavaScript syntax');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  check(blocks.length >= 4, `${blocks.length} inline script blocks found`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'th-'));
  blocks.forEach((b, i) => {
    const f = path.join(tmp, `block${i}.js`);
    fs.writeFileSync(f, b);
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
          ok(`block ${i} parses (${(b.length/1024).toFixed(0)} KB)`); }
    catch (e) { bad(`block ${i} has a syntax error:\n${e.stderr.toString().slice(0, 800)}`); }
  });

    /* ---------- 4b. every sound cue has a file ----------
     playSfx() fails silent by design, which is right at runtime and useless in
     a check: a typo in SFX would simply never make a noise and nobody would
     know. So the names are read out of the source and matched against disk. */
  step('Sound files');
  const sfxBlock = html.match(/const SFX = \{([\s\S]*?)\};/);
  if (!sfxBlock) {
    bad('could not find the SFX table in index.html');
  } else {
    const names = [...sfxBlock[1].matchAll(/'([a-z0-9_]+)'/g)].map(m => m[1]);
    check(names.length > 0, `${names.length} sound cues declared`, 'SFX table is empty');
    /* Both formats have to be present. Shipping only ogg would leave every cue
       silent on Safari, and silence is what a broken cue looks like anyway —
       so nothing but this check would ever catch it. */
    for (const ext of ['m4a', 'ogg']) {
      const missing = names.filter(f => !fs.existsSync(path.join(ROOT, 'audio', f + '.' + ext)));
      check(missing.length === 0, `every sound cue has a .${ext}`,
            `missing .${ext} files: ` + missing.map(m => m + '.' + ext).join(', '));
    }
  }

/* ---------- 5. boot the real game ---------- */
  step('Game boot (headless Chromium, software WebGL)');
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { bad('playwright is not installed — run: npm ci && npx playwright install chromium'); finish(); return; }

  /* CI and the sandbox that runs these checks often already have a Chromium on
     disk under a different build number than the installed Playwright expects.
     TIMBERHOLD_CHROME points at it directly rather than downloading a second
     copy; unset, Playwright resolves the browser itself exactly as before. */
  const browser = await chromium.launch({
    executablePath: process.env.TIMBERHOLD_CHROME || undefined,
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-gpu-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  try {
    await page.goto('file://' + INDEX);
    await page.waitForFunction(() => typeof worldReady !== 'undefined' && worldReady, { timeout: 180000 });
    await page.waitForTimeout(2000);

    const r = await page.evaluate(() => ({
      missing:   [...MODEL_NAMES, ...MODEL_NAMES_FT, ...MODEL_NAMES_PK].filter(n => !MODELS[n]),
      total:     MODEL_NAMES.length + MODEL_NAMES_FT.length + MODEL_NAMES_PK.length,
      atlases:   [COLORMAP.ready, COLORMAP_FT.ready, COLORMAP_PK.ready],
      buildings: interactiveBuildings.map(b => b.data.name),
      meshes:    (() => { let n = 0; scene.traverse(o => { if (o.isMesh) n++; }); return n; })(),
    }));

    check(r.missing.length === 0, `all ${r.total} models loaded`,
          'models failed to load: ' + r.missing.join(', '));
    check(r.atlases.every(Boolean), 'all texture atlases decoded',
          'a texture atlas failed to decode: ' + JSON.stringify(r.atlases));
    check(r.meshes > 100, `${r.meshes} meshes in the scene`,
          `only ${r.meshes} meshes — the world looks empty`);

    /* Saves match buildings by position, so the order of this list is load-bearing:
       reordering it or inserting in the middle would move existing players' camps. */
    const EXPECTED = ['Great Hall','Lodge','Sawmill','Lodge','Granary','Camp Tent','Camp Tent',
                      'Camp Tent','Camp Tent','Watch Platform','Mill','Market','Bakery',
                      'Trading Post'];
    check(JSON.stringify(r.buildings) === JSON.stringify(EXPECTED),
          'building order unchanged (saves stay compatible)',
          'BUILDING ORDER CHANGED — existing saves would load into the wrong plots.\n' +
          '      expected: ' + EXPECTED.join(', ') + '\n' +
          '      got:      ' + r.buildings.join(', '));

    check(pageErrors.length === 0, 'no JavaScript errors on load',
          'JavaScript errors on load:\n      ' + pageErrors.join('\n      '));

    /* ---------- placement rules ----------
       The river, the rockface and every building claim ground through the same
       blocked() call that the scatter loops ask before they place anything.
       These assertions read the world back out and check that actually held:
       a tree standing in the water is the exact bug this replaced, and it is
       invisible to every other check in this file. */
    const place = await page.evaluate(() => {
      const out = { inWater: [], inRock: [], pastBeach: [], bridgeOff: null, banked: 0 };
      const note = (list, x, z) => { if (list.length < 6) list.push([+x.toFixed(1), +z.toFixed(1)]); };

      /* the 50-odd choppable trees are real objects */
      choppableTrees.forEach(t => {
        if (inRiver(t.x, t.z, -0.5)) note(out.inWater, t.x, t.z);
        if (Math.hypot(t.x - mountain.x, t.z - mountain.z) < 6.5) note(out.inRock, t.x, t.z);
        if (t.x < BEACH_EDGE) note(out.pastBeach, t.x, t.z);
      });
      /* the backdrop forest is instanced, so its placements are the record */
      forestGroups.forEach(g => g.placements.forEach(p => {
        if (inRiver(p.x, p.z, -0.5)) note(out.inWater, p.x, p.z);
        if (Math.hypot(p.x - mountain.x, p.z - mountain.z) < 6.5) note(out.inRock, p.x, p.z);
        if (p.x < BEACH_EDGE) note(out.pastBeach, p.x, p.z);
        out.banked++;
      }));
      return out;
    });

    check(place.inWater.length === 0, `no trees standing in the river (${place.banked} backdrop placements checked)`,
          'TREES IN THE WATER at ' + JSON.stringify(place.inWater));
    check(place.inRock.length === 0, 'no trees growing out of the rockface',
          'TREES INSIDE THE ROCKFACE at ' + JSON.stringify(place.inRock));
    check(place.pastBeach.length === 0, 'no trees out on the beach or in the sea',
          'TREES PAST THE BEACH at ' + JSON.stringify(place.pastBeach));

    /* The river has to actually cross the map rather than stopping short, and
       the bridge has to sit on it. */
    const river = await page.evaluate(() => ({
      span: RIVER_X1 - RIVER_X0,
      fordWidth: riverHalfWidth(0) * 2,
      crossing: riverCentre(0),
    }));
    check(river.span > 250, `river spans ${river.span.toFixed(0)} units, right across the map`,
          `river only spans ${river.span.toFixed(0)} units — it stops short of the map edge`);
    check(river.fordWidth > 4 && river.fordWidth < 12,
          `ford at the crossing is ${river.fordWidth.toFixed(1)} units wide (the bridge has to reach)`,
          `ford is ${river.fordWidth.toFixed(1)} units — the bridge will not span it`);

    /* ---------- the economy actually drains ----------
       Bread outran every sink in the game because production compounds and the
       sinks did not. The blessing curve is the fix, so it has to be checked:
       if blessing cost ever grows slower than the camp's bread income, the pile
       comes back and the Trading Post is decoration. */
    const econ = await page.evaluate(() => {
      const out = { rows: [], goldScales: false };
      const hall = interactiveBuildings[0];
      const setAll = lv => interactiveBuildings.forEach(b => { b.data.level = lv; });
      const before = interactiveBuildings.map(b => b.data.level);
      [1, 8, 18, 30].forEach(lv => {
        setAll(lv);
        const foodPerDay = (campRates().food || 0) * 60 * 24;
        /* how many trades a day of bread buys, and what that many trades is
           worth against the next blessing */
        const trades = foodPerDay / tradeCost();
        const amberPerDay = trades * (1 + Math.floor(lv / 2));
        out.rows.push({ lv, foodPerDay, tradeCost: tradeCost(), amberPerDay,
                        blessing20: blessingCost(20) });
      });
      /* gold has to track the camp now rather than sitting flat forever */
      setAll(1);  const g1 = goldScale();
      setAll(30); const g30 = goldScale();
      out.goldScales = g30 > g1 * 2;
      interactiveBuildings.forEach((b, i) => { b.data.level = before[i]; });
      return out;
    });

    /* A day of bread should buy real progress but never max a blessing track
       outright — somewhere between "pointless" and "instantly over". */
    const worstRatio = Math.max(...econ.rows.map(r => r.amberPerDay / r.blessing20));
    check(worstRatio < 1,
          `a full day of bread never buys out the blessing curve (peak ${(worstRatio*100).toFixed(0)}% of a Lv20 blessing)`,
          `blessings are too cheap — a day of bread covers ${(worstRatio*100).toFixed(0)}% of a Lv20 blessing, so the pile comes back`);
    const leanest = Math.min(...econ.rows.map(r => r.amberPerDay));
    check(leanest >= 1,
          `bread buys at least ${leanest.toFixed(1)} amber a day at every camp level checked`,
          `at some camp level a day of bread earns only ${leanest.toFixed(2)} amber — the sink is unreachable`);
    check(econ.goldScales, 'mining gold scales with the camp',
          'goldScale() is flat — mining will stop mattering as costs grow');

    /* ---------- Maji-Forest ----------
       A generated board that cannot be finished is the failure that matters
       here, and it is invisible from the outside: it looks like a normal board
       right up until the player runs out of moves through no fault of their
       own. So the check is not "does it deal tiles" but "play the solution the
       generator recorded, through the same tap handler a finger goes through,
       and does the board actually empty". */
    const mj = await page.evaluate(() => {
      const out = { registered: false, boards: [], cover: null, stuck: null, fit: null };
      out.registered = ARCADE_GAMES.some(g => g.id === 'maji' && g.ready);

      ['easy', 'medium', 'hard'].forEach(d => {
        majiStart(d, false);
        const counts = {};
        maji.tiles.forEach(t => { counts[t.sym] = (counts[t.sym] || 0) + 1; });
        const odd = Object.keys(counts).filter(k => counts[k] % 2);
        const sol = maji.solution ? maji.solution.slice() : null;
        let left = -1, grade = null;
        if (sol){
          sol.forEach(p => { majiTap(p[0]); majiTap(p[1]); });
          left = maji.tiles.filter(t => t.state !== 'removed').length;
          grade = maji.result && maji.result.grade;
        }
        out.boards.push({ d, dealt: maji.dealt, total: maji.tiles.length,
                          want: MAJI_LAYOUTS[d].tiles, odd, left, grade,
                          reshuffles: maji.reshuffles });
      });

      /* Both sides open, one tile resting on the other: only the cover rule can
         block the lower one. Picking a tile out of a real board proves nothing,
         because those are walled in sideways as well. */
      maji.phase = 'playing'; maji.picked = null;
      maji.tiles = [{ i:0, x:0, y:0, z:0, sym:'leaf', state:'board' },
                    { i:1, x:0, y:0, z:1, sym:'axe',  state:'board' }];
      let live = maji.tiles.slice();
      out.cover = { under: majiIsFree(live[0], live), over: majiIsFree(live[1], live),
                    sidesOpen: majiSideOpen(live[0], live, -1) && majiSideOpen(live[0], live, 1) };

      /* Four in a row, ends free, symbols A B A B: no legal pair exists. */
      maji.picked = null; maji.reshuffles = 0; maji.score = 500;
      maji.tiles = [{ i:0, x:0, y:0, z:0, sym:'leaf', state:'board' },
                    { i:1, x:2, y:0, z:0, sym:'axe',  state:'board' },
                    { i:2, x:4, y:0, z:0, sym:'leaf', state:'board' },
                    { i:3, x:6, y:0, z:0, sym:'axe',  state:'board' }];
      live = maji.tiles.slice();
      const before = majiFindMatch();
      const free = live.filter(t => majiIsFree(t, live)).map(t => t.i);
      majiReshuffle(true);
      out.stuck = { before, free, after: majiFindMatch(), reshuffles: maji.reshuffles };

      /* The board being drawn wider than its canvas is silently clipped by the
         wrapper, so no amount of game logic notices it. */
      maji.phase = 'menu';
      openTab('arcade'); openArcadeGame('maji');
      majiStart('hard', false); majiRender();
      const c = document.getElementById('majiCanvas');
      if (c && maji.geom){
        let l = 1e9, t = 1e9, r = -1e9, b = -1e9;
        maji.tiles.forEach(x => {
          const q = majiTileRect(x, maji.geom);
          l = Math.min(l, q.x); t = Math.min(t, q.y);
          r = Math.max(r, q.x + q.w); b = Math.max(b, q.y + q.h);
        });
        const box = c.getBoundingClientRect(), par = c.parentNode.getBoundingClientRect();
        const pad = window.getComputedStyle(c.parentNode);
        out.fit = { l, t, r, b, w: maji.geom.w, h: maji.geom.h,
                    over: Math.round(box.right - (par.right - (parseFloat(pad.paddingRight) || 0))) };
      }
      closeTab();
      return out;
    });

    check(mj.registered, 'Maji-Forest is in the Arcade', 'Maji-Forest is not registered or not ready');
    mj.boards.forEach(b => {
      check(b.dealt && b.total === b.want, `Maji-Forest ${b.d}: ${b.total} tiles dealt`,
            `Maji-Forest ${b.d}: dealt ${b.total}, layout says ${b.want}`);
      check(b.odd.length === 0, `Maji-Forest ${b.d}: every symbol pairs`,
            `Maji-Forest ${b.d}: UNPAIRABLE symbols ${JSON.stringify(b.odd)}`);
      check(b.left === 0 && b.grade === 'perfect clear',
            `Maji-Forest ${b.d}: the dealt board plays through to a clear`,
            `MAJI-FOREST ${b.d.toUpperCase()} DEALT AN UNSOLVABLE BOARD — ` +
            `${b.left} tiles could not be reached (grade ${b.grade})`);
    });
    check(mj.cover && mj.cover.sidesOpen && mj.cover.under === false && mj.cover.over === true,
          'Maji-Forest: a tile with another on top of it is blocked',
          'MAJI-FOREST COVER RULE BROKEN — a buried tile reads as free: ' + JSON.stringify(mj.cover));
    check(mj.stuck && mj.stuck.before === null && JSON.stringify(mj.stuck.free) === '[0,3]',
          'Maji-Forest: a board with no legal pair is detected',
          'Maji-Forest failed to notice a stuck board: ' + JSON.stringify(mj.stuck));
    check(mj.stuck && mj.stuck.after !== null && mj.stuck.reshuffles === 1,
          'Maji-Forest: reshuffling puts a legal pair back',
          'Maji-Forest reshuffle left the board stuck: ' + JSON.stringify(mj.stuck));
    check(mj.fit && mj.fit.r <= mj.fit.w + 0.5 && mj.fit.b <= mj.fit.h + 0.5 &&
          mj.fit.l >= -0.5 && mj.fit.t >= -0.5 && mj.fit.over <= 1,
          'Maji-Forest: the board fits its canvas and its panel',
          'MAJI-FOREST BOARD IS BEING CLIPPED: ' + JSON.stringify(mj.fit));
  } catch (e) {
    bad('the game did not finish loading: ' + e.message);
    if (pageErrors.length) console.log('      page errors: ' + pageErrors.join(' | '));
  } finally {
    await browser.close();
  }

  finish();

  function finish() {
    if (failed === 0 && process.argv.includes('--site')) {
      step('Assembling _site/');
      const out = path.join(ROOT, '_site');
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      for (const f of SITE_FILES) fs.copyFileSync(path.join(ROOT, f), path.join(out, f));
      /* Sound clips ship as files rather than inlined, so the whole folder has
         to come with them or every cue silently no-ops on the live site. */
      const audioSrc = path.join(ROOT, 'audio');
      let audioCount = 0;
      if (fs.existsSync(audioSrc)) {
        fs.mkdirSync(path.join(out, 'audio'), { recursive: true });
        for (const f of fs.readdirSync(audioSrc)) {
          fs.copyFileSync(path.join(audioSrc, f), path.join(out, 'audio', f));
          audioCount++;
        }
      }
      ok(`${SITE_FILES.length} files + ${audioCount} audio clips staged for publishing`);
    }
    console.log('\n' + (failed === 0
      ? 'PASS — safe to publish.'
      : `FAIL — ${failed} problem(s). Not publishing.`));
    process.exit(failed === 0 ? 0 : 1);
  }
})();
