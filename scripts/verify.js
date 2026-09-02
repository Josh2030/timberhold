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
                      'Camp Tent','Camp Tent','Watch Platform','Mill','Market','Bakery'];
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
      ok(`${SITE_FILES.length} files staged for publishing`);
    }
    console.log('\n' + (failed === 0
      ? 'PASS — safe to publish.'
      : `FAIL — ${failed} problem(s). Not publishing.`));
    process.exit(failed === 0 ? 0 : 1);
  }
})();
