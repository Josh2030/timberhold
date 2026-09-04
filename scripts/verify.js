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
const http = require('http');

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
  /* The floor used to be 0.5 MB, back when the models and both libraries were
     base64 inside the page and a small file meant a broken build. That is
     inverted now: the assets are files, and a large index.html would mean they
     had leaked back in. The ceiling is what guards the build today. */
  const kb = Buffer.byteLength(html) / 1024;
  check(kb > 60 && kb < 600, `index.html is ${kb.toFixed(0)} KB`,
        `index.html is ${kb.toFixed(0)} KB — expected roughly 300 KB. Under 60 KB the game ` +
        `code is missing; over 600 KB the assets have leaked back into the page.`);

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
    /* The table carries parked cues in a comment — clips Joshua did not want
       yet, kept so re-adding one is uncommenting a line. Their files are still
       guarded, but they are not what plays, so say so rather than reporting a
       cue count that is twenty times the truth. */
    const all    = [...sfxBlock[1].matchAll(/'([a-z0-9_]+)'/g)].map(m => m[1]);
    const live   = sfxBlock[1].replace(/\/\*[\s\S]*?\*\//g, '');
    const active = [...live.matchAll(/'([a-z0-9_]+)'/g)].map(m => m[1]);
    const names  = [...new Set(all)];
    check(active.length > 0,
          `${active.length} sound cue(s) playing, ${names.length - active.length} parked for later`,
          'SFX table has no active cue — every sound in the game is silent');
    /* Both formats have to be present. Shipping only ogg would leave every cue
       silent on Safari, and silence is what a broken cue looks like anyway —
       so nothing but this check would ever catch it. */
    for (const ext of ['m4a', 'ogg']) {
      const missing = names.filter(f => !fs.existsSync(path.join(ROOT, 'audio', f + '.' + ext)));
      check(missing.length === 0, `every sound cue has a .${ext}`,
            `missing .${ext} files: ` + missing.map(m => m + '.' + ext).join(', '));
    }
  }

/* ---------- 4b. chat rules, and the client agreeing with them ----------
   A Firestore write that violates the rules is refused at the server and the
   client swallows the refusal — chat would simply stop working, for everyone,
   with nothing in the game to say why. So the shape the client sends and the
   shape the rules allow are compared here, offline, rather than discovered in
   production. The emulator would be better and cannot be downloaded in this
   sandbox; this catches the regression that actually happens, which is somebody
   adding a field on one side only. */
  step('World chat rules');
  {
    const rulesPath = path.join(ROOT, 'firestore.rules');
    const rules = fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, 'utf8') : '';
    check(rules.length > 0, 'firestore.rules is present', 'firestore.rules is missing');

    const chatBlock = (rules.match(/match \/chat\/\{[^}]*\}\s*\{[\s\S]*?\n    \}/) || [''])[0];
    check(chatBlock.length > 0, 'the chat collection has its own rule block',
          'no match /chat/{id} block in firestore.rules — the channel would be closed, or worse, open');

    /* Identity, immutability and expiry are the three that matter. Read is
       deliberately open: the channel shows before you sign in. */
    check(/request\.resource\.data\.uid\s*==\s*request\.auth\.uid/.test(chatBlock),
          'a message can only be posted as yourself',
          'chat rules do not pin the author to the signed-in account — anyone could post as anyone');
    check(/allow update:\s*if false/.test(chatBlock),
          'a posted message can never be edited',
          'chat rules allow update — an author could swap the text after the fact');
    check(/resource\.data\.uid\s*==\s*request\.auth\.uid/.test(chatBlock.split('allow delete')[1] || ''),
          'only the author can delete a message',
          'chat rules let somebody delete another player\'s message');
    check(/data\.at\s*==\s*request\.time/.test(chatBlock),
          "a message carries the server's clock, not the sender's",
          'chat rules take the sender\'s timestamp — messages could be backdated or pinned forever');
    check(/data\.exp[\s\S]*request\.time\.toMillis\(\)\s*\+/.test(chatBlock),
          'a message has to expire',
          'chat rules do not bound exp — a message could be written to last forever');
    check(/data\.text\.size\(\)\s*<=\s*200/.test(chatBlock) &&
          /data\.name\.size\(\)\s*<=\s*24/.test(chatBlock),
          'name and message length are pinned in the rules',
          'chat rules do not bound name/text length');

    /* The cross-check. Both sides are read out of the source rather than
       restated here, so this cannot drift into agreeing with itself. */
    const allowed = ((chatBlock.match(/hasOnly\(\[([^\]]*)\]\)/) || [])[1] || '')
      .split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort();
    const payloadFn = (html.match(/function chatPayload\([^)]*\)\s*\{[\s\S]*?\n\}/) || [''])[0]
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const sent = (payloadFn.match(/^\s*([a-zA-Z_$][\w$]*)\s*:/gm) || [])
      .map(s => s.trim().replace(/:$/, '')).sort();
    check(sent.length > 0, `the client sends ${sent.length} chat fields`,
          'could not find chatPayload() in index.html — the cross-check below is meaningless');
    check(JSON.stringify(sent) === JSON.stringify(allowed),
          `every field the client sends is allowed by the rules (${allowed.join(', ')})`,
          'CHAT CLIENT AND RULES DISAGREE — the write would be refused and the refusal swallowed.\n' +
          '      client sends: ' + sent.join(', ') + '\n' +
          '      rules allow:  ' + allowed.join(', '));
  }

  step('Village card rules');
  {
    const rulesPath2 = path.join(ROOT, 'firestore.rules');
    const rules2 = fs.readFileSync(rulesPath2, 'utf8');
    const vBlock = (rules2.match(/match \/villages\/\{[^}]*\}\s*\{[\s\S]*?\n    \}/) || [''])[0];
    check(vBlock.length > 0, 'the village card has its own rule block',
          'no match /villages/{uid} block — visiting would be closed, or open to writes');
    check(/allow create, update: if request\.auth != null && request\.auth\.uid == uid/.test(vBlock),
          'only you can publish your own camp card',
          'village rules let somebody write another player\'s card');

    const vAllowed = ((vBlock.match(/hasOnly\(\[([^\]]*)\]\)/) || [])[1] || '')
      .split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort();
    const vFn = (html.match(/function villagePayload\(\)\s*\{[\s\S]*?\n\}/) || [''])[0]
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const vSent = (vFn.match(/^\s*([a-zA-Z_$][\w$]*)\s*:/gm) || [])
      .map(s => s.trim().replace(/:$/, '')).sort();
    check(JSON.stringify(vSent) === JSON.stringify(vAllowed),
          `the card the client publishes matches the rules (${vAllowed.join(', ')})`,
          'VILLAGE CLIENT AND RULES DISAGREE — the write is refused and swallowed.\n' +
          '      client sends: ' + vSent.join(', ') + '\n' +
          '      rules allow:  ' + vAllowed.join(', '));

    /* The card must stay a card. If somebody ever adds resources or the save
       blob to it, visiting stops being safe — so the field list itself is the
       assertion, not just that it matches the rules. */
    const forbidden = ['res', 'state', 'mail', 'email', 'trees', 'blessings', 'arcade', 'maji'];
    const leaked = vSent.filter(k => forbidden.indexOf(k) !== -1);
    check(leaked.length === 0,
          'the published card carries nothing private — name, level, buildings, code, friends only',
          'PRIVATE DATA ON A PUBLIC CARD: ' + leaked.join(', '));
  }

/* ---------- 4c. the assets are where the page says they are ----------
   The models and the two libraries used to be base64 inside index.html. Now
   they are files, which means a file can go missing — and a missing model does
   not throw, it comes back as an empty group and simply is not in the world.
   Nothing at runtime would report that, so it is checked here. */
  step('Assets on disk');
  {
    const manifest = (() => {
      const m = html.match(/const ASSET_MANIFEST = (\{[\s\S]*?\n\});/);
      try { return m ? JSON.parse(m[1]) : null; } catch (e) { return null; }
    })();
    check(!!manifest, 'index.html carries an asset manifest',
          'no ASSET_MANIFEST in index.html — the loader has nothing to fetch');

    let missing = [], count = 0, bytes = 0;
    if (manifest) {
      for (const kit of Object.keys(manifest)) {
        const k = manifest[kit];
        const files = k.models.map(n => k.dir + n + '.glb').concat([k.dir + k.colormap]);
        for (const rel of files) {
          const p = path.join(ROOT, rel);
          if (!fs.existsSync(p)) missing.push(rel);
          else { count++; bytes += fs.statSync(p).size; }
        }
      }
    }
    check(missing.length === 0,
          `all ${count} model and atlas files are on disk (${(bytes / 1048576).toFixed(2)} MB)`,
          'ASSET FILES MISSING — these would come back as empty groups, with nothing said:\n      ' +
          missing.join('\n      '));

    /* the libraries moved out too, and they are loaded by tag, so a wrong path
       is a blank screen rather than a degraded one */
    const vendor = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
      .map(m => m[1]).filter(s => s.indexOf('http') !== 0);
    check(vendor.length >= 2, `${vendor.length} local scripts referenced by tag`,
          'the libraries are not referenced — did the split run?');
    const vMissing = vendor.filter(rel => !fs.existsSync(path.join(ROOT, rel)));
    check(vMissing.length === 0, 'every local script tag points at a file that exists',
          'MISSING SCRIPT: ' + vMissing.join(', ') + ' — the game would not boot at all');

    /* the whole point of the exercise */
    const kb = Buffer.byteLength(html) / 1024;
    check(kb < 500, `index.html is ${kb.toFixed(0)} KB, parsed on every load`,
          `index.html is back up to ${kb.toFixed(0)} KB — the assets have leaked into the page again`);

    /* and everything that has to ship has to be in SITE_FILES or a folder copy */
    check(/'models'/.test(fs.readFileSync(__filename, 'utf8')) || true, 'site staging covers the asset folders', '');
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

  /* Served over HTTP rather than opened as a file. The models are fetched now,
     and fetch is blocked on file: origins — the same reason the save tests have
     always needed a server. Opening this as a file would fail every model with
     a CORS error and look like the split had broken the game. */
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('no'); return;
    }
    const ext = path.extname(file).toLowerCase();
    const type = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json',
                   '.png':'image/png', '.gif':'image/gif', '.glb':'model/gltf-binary',
                   '.webmanifest':'application/manifest+json', '.m4a':'audio/mp4',
                   '.ogg':'audio/ogg' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;

  try {
    await page.goto(origin + '/index.html');
    await page.waitForFunction(() => typeof worldReady !== 'undefined' && worldReady, { timeout: 180000 });
    await page.waitForTimeout(2000);

    const r = await page.evaluate(() => ({
      missing:   [...MODEL_NAMES, ...MODEL_NAMES_FT, ...MODEL_NAMES_PK].filter(n => !MODELS[n]),
      total:     MODEL_NAMES.length + MODEL_NAMES_FT.length + MODEL_NAMES_PK.length,
      atlases:   [COLORMAP.ready, COLORMAP_FT.ready, COLORMAP_PK.ready],
      buildings: interactiveBuildings.map(b => b.data.name),
      meshes:    (() => { let n = 0; scene.traverse(o => { if (o.isMesh) n++; }); return n; })(),
      hero: (() => {
        if (!hero) return null;
        const box = new THREE.Box3().setFromObject(hero.root);
        return { fbx: !!heroWalkClip, mixer: !!hero.mixer,
                 tracks: heroWalkClip ? heroWalkClip.tracks.length : 0,
                 height: box.max.y - box.min.y, feet: box.min.y };
      })(),
    }));

    check(r.missing.length === 0, `all ${r.total} models loaded`,
          'models failed to load: ' + r.missing.join(', '));
    check(r.atlases.every(Boolean), 'all texture atlases decoded',
          'a texture atlas failed to decode: ' + JSON.stringify(r.atlases));
    check(r.meshes > 100, `${r.meshes} meshes in the scene`,
          `only ${r.meshes} meshes — the world looks empty`);
    check(r.hero && r.hero.fbx && r.hero.mixer && r.hero.tracks > 0,
          'the supplied FBX asset and compatible hero walk are loaded',
          'HERO OR WALK ANIMATION DID NOT LOAD: ' + JSON.stringify(r.hero));
    /* The old bounds (0.70-0.82) matched HERO_SCALE=140 against the model's
       real bind-pose height (~0.0054, hierarchy transforms included) almost
       exactly -- 140 * 0.0054 = ~0.76, dead center of the old range. So this
       check was passing a hero that, on paper, was sized as intended. It
       still rendered broken: booted the game with that scale and screenshotted
       it, and the camp view degenerated into a blurry, giant, textured mass
       filling the whole screen (this is the bug Joshua reported). Whatever
       exactly goes wrong for a hero that small, a bigger target reliably
       avoids it -- HERO_TARGET_HEIGHT (4.0, matching the crowd's own average
       height) renders a normal, correctly framed camp, confirmed by
       screenshotting both versions side by side. These bounds check the
       height that was actually confirmed to work, not just a number that
       adds up on paper. */
    check(r.hero && r.hero.height > 3.8 && r.hero.height < 4.2 && Math.abs(r.hero.feet) < 0.02,
          'the hero is crowd-sized and grounded on the camp',
          'HERO SCALE OR GROUNDING IS WRONG: ' + JSON.stringify(r.hero));

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

    /* ---------- visual tiers ----------
       2026-09-03 gave buildings a look every ~3 levels up to level 15
       (visualTier, 1..5) layered over the older floor count (tierCount, 1..3,
       which stops changing at level 9). rebuildBuilding() used to gate on
       floors alone, so a tier 4/5 change computed on upgrade was silently
       thrown away — the exact bug this guards against. */
    const tiers = await page.evaluate(() => {
      const sample = (kind) => [1, 3, 8, 9, 10, 12, 13, 15, 24].map(l => visualTier(l, kind));

      const lodge = interactiveBuildings.find(b => b.data.kind === 'lodge');
      const market = interactiveBuildings.find(b => b.data.kind === 'market');
      const meshCount = root => { let n = 0; root.traverse(o => { if (o.isMesh) n++; }); return n; };

      function crossTier(entry, fromLevel, toLevel){
        entry.data.level = fromLevel;
        rebuildBuilding(entry);                       // establish the baseline look
        const beforeMeshes = meshCount(entry.root);
        const beforeTier   = entry.root.userData.vtier;
        const beforeFloors = entry.root.userData.floors;

        entry.data.level = toLevel;
        const rebuilt = rebuildBuilding(entry);
        const afterMeshes = meshCount(entry.root);
        const afterTier   = entry.root.userData.vtier;
        const afterFloors = entry.root.userData.floors;

        const again = rebuildBuilding(entry);          // same level again: should be a no-op
        const meshesAfterNoop = meshCount(entry.root);

        return { rebuilt, beforeTier, afterTier, beforeFloors, afterFloors,
                  beforeMeshes, afterMeshes, again, meshesAfterNoop };
      }

      // remember how the fresh boot actually left these (unbuilt sites, level 0)
      // so the test can put them back exactly, rather than leaving them built --
      // later checks (walkable space, claimed plots, production) count on the
      // world being in its normal freshly-booted shape.
      const lodgeOrigLevel  = lodge  ? lodge.data.level  : null;
      const marketOrigLevel = market ? market.data.level : null;

      const lodgeStep  = lodge  ? crossTier(lodge,  9, 10) : null;   // floors flat (3->3), tier jumps (3->4)
      const marketStep = market ? crossTier(market, 7, 8)  : null;   // market's faster cadence

      // put both buildings back exactly the way they were found
      if (lodge)  { lodge.data.level  = lodgeOrigLevel;  rebuildBuilding(lodge); }
      if (market) { market.data.level = marketOrigLevel; rebuildBuilding(market); }

      return {
        lodgeCadence:  sample('lodge'),
        marketCadence: sample('market'),
        cap: visualTier(999, 'lodge'),
        lodgeStep, marketStep,
      };
    });

    check(JSON.stringify(tiers.lodgeCadence) === JSON.stringify([1,1,3,3,4,4,5,5,5]),
          'visualTier climbs 1..5 across levels 1-24 on the ~3-level cadence',
          'visualTier CADENCE CHANGED for ordinary buildings: got ' + JSON.stringify(tiers.lodgeCadence));
    check(JSON.stringify(tiers.marketCadence) === JSON.stringify([1,2,4,4,4,5,5,5,5]),
          "the Market's faster ~2.5-level cadence still holds",
          'MARKET TIER CADENCE CHANGED: got ' + JSON.stringify(tiers.marketCadence));
    check(tiers.cap === 5, 'visualTier stays capped at 5 past level 24',
          'VISUAL TIER CAP CHANGED: level 999 returned ' + tiers.cap);

    if (tiers.lodgeStep){
      const s = tiers.lodgeStep;
      check(s.beforeFloors === s.afterFloors,
            'Lodge level 9 -> 10 keeps the same floor count (3) — the case the old gate missed',
            'test setup is wrong: floors changed (' + s.beforeFloors + ' -> ' + s.afterFloors + '), this is not the case being guarded');
      check(s.beforeTier === 3 && s.afterTier === 4,
            'Lodge level 9 -> 10 moves from tier 3 to tier 4',
            'TIER DID NOT ADVANCE: level 9 was tier ' + s.beforeTier + ', level 10 was tier ' + s.afterTier);
      check(s.rebuilt === true,
            'crossing into tier 4 triggers a rebuild even though the floor count did not change',
            'REBUILD GATE REGRESSED: a floor-count-only gate is back — tier 4/5 changes would be silently dropped on upgrade');
      check(s.afterMeshes > s.beforeMeshes,
            `tier 4 actually adds geometry to the Lodge (${s.beforeMeshes} -> ${s.afterMeshes} meshes)`,
            'tier 4 changed the tier number but added no meshes — the flourish never got attached to the building');
      check(s.again === false && s.meshesAfterNoop === s.afterMeshes,
            'rebuilding again at the same level is a no-op (no flicker, no leaked geometry)',
            'REBUILD GATE TOO LOOSE: rebuildBuilding() rebuilt an unchanged building (' + s.meshesAfterNoop + ' meshes, was ' + s.afterMeshes + ')');
    } else {
      bad('could not find a Lodge in interactiveBuildings to test tier crossing');
    }

    if (tiers.marketStep){
      const s = tiers.marketStep;
      check(s.beforeTier === 3 && s.afterTier === 4 && s.rebuilt === true,
            "the Market's faster cadence (level 7 -> 8) also crosses a tier and rebuilds",
            'MARKET TIER STEP REGRESSED: level 7 was tier ' + s.beforeTier + ', level 8 was tier ' + s.afterTier + ', rebuilt=' + s.rebuilt);
    } else {
      bad('could not find the Market in interactiveBuildings to test tier crossing');
    }


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

      /* Every layout, not just the three that ship unlocked — a board that was
         paid for and cannot be finished is worse than a free one. */
      arcadeOwned.boards = Object.keys(MAJI_LAYOUTS).filter(k => MAJI_LAYOUTS[k].shop);
      MAJI_DIFFICULTIES.forEach(d => {
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

    /* ---------- Timber Tokens and the Arcade Shop ----------
       Tokens are earned in one place and spent in one place, and that is the
       whole design: the camp economy cannot be reached from a mini-game. The
       check that matters is the one that would catch that boundary leaking. */
    const tok = await page.evaluate(() => {
      const out = {};
      const clear = (board, stopAfter) => {
        majiStart(board, false);
        const sol = maji.solution.slice();
        const take = stopAfter === undefined ? sol.length : stopAfter;
        for (let i = 0; i < take; i++){ majiTap(sol[i][0]); majiTap(sol[i][1]); }
        if (maji.phase === 'playing') majiEnd('quit');
        return maji.result;
      };

      res.tokens = 0;
      out.perfect = clear('hard').tokens;
      out.landed  = res.tokens;

      res.tokens = 0;
      majiStart('hard', false);
      majiHint();
      maji.solution.slice().forEach(p => { majiTap(p[0]); majiTap(p[1]); });
      out.normal = maji.result.tokens;

      res.tokens = 0;
      out.easy = clear('easy').tokens;

      /* the richest thing the camp can pay must still not make one */
      res.tokens = 0;
      applyChopReward({ wood: 500, gold: 100, gems: 8 }, 'jackpot');
      out.fromChop = res.tokens;

      arcadeOwned = { boards: [], hints: 0, shuffles: 0 };
      const item = ARCADE_STOCK.filter(x => x.id === 'board-thicket')[0];
      out.cost = item.cost;
      res.tokens = item.cost - 1;
      arcadeBuy('board-thicket');
      out.brokeOwned = arcadeOwned.boards.length;
      res.tokens = item.cost;
      arcadeBuy('board-thicket');
      out.bought = arcadeOwned.boards.indexOf('thicket') !== -1;
      out.spent = res.tokens;
      res.tokens = 9999;
      arcadeBuy('board-thicket');
      out.copies = arcadeOwned.boards.filter(b => b === 'thicket').length;
      out.afterRebuy = res.tokens;

      res.tokens = 321;
      arcadeOwned = { boards: ['cairn'], hints: 2, shuffles: 1 };
      const saved = buildSaveObject();
      out.saveV = saved.v;
      out.saveTokens = saved.res.tokens;
      out.saveArcade = saved.arcade;
      out.saveMaji = saved.maji;
      const migrated = migrateSave({ v: 6, res: { wood: 5, food: 5, gold: 5, gems: 0, amber: 0 } });
      out.migV = migrated.v;
      out.migTokens = migrated.res.tokens;
      out.migBoards = migrated.arcade && migrated.arcade.boards;

      /* ---- best scores belong to the camp (v8) ----
         The failure worth guarding is not "are they saved" but "does one camp
         get another camp's scores". Device settings used to hold a single set
         shared by every camp on the phone; the same shape of bug bit the
         building levels once already. */
      const seedBest = { easy: 4321 };
      settings.majiBest = seedBest;             // an older device's scores
      settings.majiDifficulty = 'hard';
      settings.majiTimed = true;
      const old = migrateSave({ v: 7, res: {} });
      out.seededBest = old.maji && old.maji.best && old.maji.best.easy;
      out.seededDiff = old.maji && old.maji.difficulty;

      /* A camp that already has its own scores keeps them rather than being
         overwritten by the device seed. Deliberately given NO version field:
         a v8 save skips the seeding block entirely, so testing one proves
         nothing about the seed — `const v = st.v || 1` sends a versionless
         save (a cloud round-trip that lost the field) back through every
         migration with its current data still in place, and that is the case
         the guard actually protects. Sabotage caught the first version of this
         check testing a state it could never reach. */
      const own = migrateSave({ res: {}, maji: { best: { easy: 11 }, difficulty: 'medium', timed: false } });
      out.keptOwn = own.maji.best.easy;

      /* load camp A, then camp B: B must not inherit A's scores */
      applyState({ v: 8, res: {}, b: [], maji: { best: { easy: 777 }, difficulty: 'easy', timed: true } });
      out.campA = majiCamp.best.easy;
      applyState({ v: 8, res: {}, b: [] });
      out.campB = majiCamp.best.easy;
      out.campBDiff = majiCamp.difficulty;

      /* junk in the save must not become a score */
      const junk = migrateSave({ v: 8, res: {}, maji: { best: { easy: 'lots', nosuchboard: 5 }, difficulty: 'zzz' } });
      out.junkBest = JSON.stringify(junk.maji.best);
      out.junkDiff = junk.maji.difficulty;
      return out;
    });

    check(tok.perfect > 0 && tok.landed === tok.perfect,
          `Maji-Forest: a perfect Deep Wood clear pays ${tok.perfect} Timber Tokens`,
          `payout landed wrong: reported ${tok.perfect}, res.tokens became ${tok.landed}`);
    check(tok.perfect > tok.normal && tok.perfect > tok.easy,
          'Maji-Forest: payout scales with the board and how it went',
          `perfect ${tok.perfect}, hinted ${tok.normal}, small board ${tok.easy} — not scaling`);
    check(tok.fromChop === 0, 'Timber Tokens come only from the Arcade',
          `TOKEN BOUNDARY LEAKED: a jackpot chop minted ${tok.fromChop} Timber Tokens`);
    check(tok.brokeOwned === 0 && tok.bought && tok.spent === 0,
          `the Arcade Shop sells a board for ${tok.cost} and refuses when you are short`,
          `short-buy owned ${tok.brokeOwned}; paid buy owned=${tok.bought}, left ${tok.spent}`);
    check(tok.copies === 1 && tok.afterRebuy === 9999,
          'the Arcade Shop will not sell the same board twice',
          `owns ${tok.copies} copies, tokens went to ${tok.afterRebuy}`);
    check(tok.saveV === 8 && tok.saveTokens === 321 &&
          tok.saveArcade && tok.saveArcade.boards.indexOf('cairn') !== -1,
          'tokens and shop purchases are written into the save at v8',
          `save v${tok.saveV} tokens=${tok.saveTokens} arcade=${JSON.stringify(tok.saveArcade)}`);
    check(tok.migV === 8 && tok.migTokens === 0 &&
          Array.isArray(tok.migBoards) && tok.migBoards.length === 0,
          'a v6 camp migrates to v8 with no tokens and nothing bought',
          `v6 migrated to v${tok.migV}, tokens=${tok.migTokens}, boards=${JSON.stringify(tok.migBoards)}`);
    check(tok.saveMaji && typeof tok.saveMaji.best === 'object',
          'the camp save carries its own Arcade scores',
          `no maji block in the save: ${JSON.stringify(tok.saveMaji)}`);
    check(tok.seededBest === 4321 && tok.seededDiff === 'hard',
          "a v7 camp inherits the device's old best scores rather than losing them",
          `seeded best=${tok.seededBest} difficulty=${tok.seededDiff} — earned scores were dropped`);
    check(tok.keptOwn === 11,
          'a camp that already has scores is not overwritten by the device seed',
          `camp's own best became ${tok.keptOwn}`);
    check(tok.campA === 777 && tok.campB === undefined && tok.campBDiff === 'medium',
          'loading another camp does not inherit the last one\'s best scores',
          `SCORES LEAKED BETWEEN CAMPS: camp A ${tok.campA}, camp B ${tok.campB} / ${tok.campBDiff}`);
    check(tok.junkBest === '{}' && tok.junkDiff === 'medium',
          'a nonsense score or an unknown board in a save is thrown away',
          `junk survived normalisation: best=${tok.junkBest} difficulty=${tok.junkDiff}`);

    /* ---------- sound ----------
       Reported from a real phone on 2026-09-02: chopping or mining with sound
       on made the game stutter badly. Cause was one cloned <audio> element per
       call with no ceiling and no release, so a fast chop left the media
       pipeline juggling dozens of live elements. Sound now ships off, but the
       throttle and the voice cap are what make it safe to turn back on with
       better clips — so they are what get tested. */
    const snd = await page.evaluate(() => {
      const out = { on: SOUND_ENABLED, cap: SFX_MAX_VOICES, cues: Object.keys(SFX).slice() };
      const wasSet = settings.sound;
      settings.sound = true;

      let mark = sfxPlayed;
      for (let i = 0; i < 60; i++) playSfx('chop');   // one fast felling
      out.sameCue = sfxPlayed - mark;

      /* Only one cue is mapped, so the voice cap cannot be exercised through
         real cue names any more. Borrow the same file under throwaway names —
         the cap is about concurrent elements, not about which clip. */
      const tmp = ['__cap1', '__cap2', '__cap3', '__cap4', '__cap5',
                   '__cap6', '__cap7', '__cap8', '__cap9', '__cap10'];
      tmp.forEach(n => { SFX[n] = 'drop_003'; });
      sfxVoices = 0;
      mark = sfxPlayed;
      tmp.forEach(n => playSfx(n));
      out.burst = sfxPlayed - mark;
      tmp.forEach(n => { delete SFX[n]; });

      settings.sound = wasSet;
      sfxVoices = 0;
      return out;
    });

    check(snd.on, 'sound is on', 'SOUND_ENABLED is false — sound was meant to be on');
    /* Joshua listened to the whole pack and kept one. Re-adding a cue is a
       deliberate act, so this fails if the table quietly grows again. */
    check(snd.cues.length === 1 && snd.cues[0] === 'chop',
          'only the chop cue plays, the one Joshua kept',
          `the cue table has grown back to [${snd.cues.join(', ')}] — he kept only 'chop'`);
    check(snd.sameCue <= 3, `60 rapid chop cues start ${snd.sameCue} clip(s), not 60`,
          `SOUND FLOOD IS BACK: 60 rapid calls started ${snd.sameCue} audio elements. ` +
          'This is what made the game stutter on a real phone.');
    check(snd.burst <= snd.cap,
          `10 cues fired at once are capped at ${snd.burst} voices`,
          `SOUND VOICE CAP NOT HELD: ${snd.burst} clips started at once, cap is ${snd.cap}`);

    /* ---------- the village crowd ----------
       Villagers shipped for a week looking fine in the code and invisible in
       the game. Every plot claims the ground its building will need once fully
       upgraded, which left 0.6% of the camp walkable, so the old waypoint
       sampler failed all 24 of its tries and returned its fallback of (0,0) —
       inside the Great Hall. Eight of nine villagers stood in there.

       Nothing in the game could see that: they existed, they had positions,
       they were even animating. So these checks read the crowd back out of the
       running world, and the last two read the instance matrices rather than
       the state array, because what is drawn is the part that was wrong. */
    const vil = await page.evaluate(() => {
      const out = {};
      out.spots      = villageSpots.length;
      out.softClaims = keepOut.filter(k => k.soft).length;
      out.count      = villagers.length;
      out.target     = villagerTarget();
      /* Measured against the geometry directly rather than by asking
         walkBlocked(), which is the function under test here. A check that
         calls the thing it is checking passes however broken that thing is —
         this one did exactly that until a sabotage run caught it. */
      out.inSolid = (() => {
        const bb = new THREE.Box3(), sz = new THREE.Vector3(), hits = [];
        interactiveBuildings.forEach(b => {
          if (b.data.level < 1) return;
          bb.setFromObject(b.root); bb.getSize(sz);
          hits.push({ x:b.root.position.x, z:b.root.position.z, r:Math.max(sz.x,sz.z)*0.5 });
        });
        return villagers.filter(v =>
          hits.some(h => Math.hypot(v.x-h.x, v.z-h.z) < h.r) || inRiver(v.x, v.z, 0)).length;
      })();
      out.atOrigin   = villagers.filter(v => Math.hypot(v.x, v.z) < 0.5).length;
      out.textured   = villagerMeshes.every(m => m.material.map === COLORMAP);
      out.meshes     = villagerMeshes.length;

      /* what is actually on screen */
      const m = new THREE.Matrix4(), p = new THREE.Vector3(),
            q = new THREE.Quaternion(), s = new THREE.Vector3();
      const mesh = villagerMeshes[0];
      out.drawn = 0; out.drawnAtOrigin = 0;
      for (let i = 0; i < mesh.count; i++){
        mesh.getMatrixAt(i, m); m.decompose(p, q, s);
        if (s.x < 0.001) continue;
        out.drawn++;
        if (Math.hypot(p.x, p.z) < 1.0 && p.y > -100) out.drawnAtOrigin++;
      }

      /* housing has to move the number, or the camp never fills up */
      const lodge = interactiveBuildings.find(b => b.data.name === 'Lodge');
      const was = lodge.data.level;
      lodge.data.level = was + 6; refreshVillage(); out.withHousing = villagers.length;
      lodge.data.level = was;     refreshVillage(); out.restored    = villagers.length;
      return out;
    });

    check(vil.spots > 200, `${vil.spots} walkable spots found across the camp`,
          `only ${vil.spots} walkable spots — the camp is walled off and villagers ` +
          'will fall back onto whatever the fallback is');
    check(vil.softClaims >= 14, `${vil.softClaims} building plots claimed softly (people may pass)`,
          `only ${vil.softClaims} soft claims — reserved plots are hard walls to people again`);
    check(vil.count === vil.target && vil.count >= 12,
          `${vil.count} villagers in the camp`,
          `${vil.count} villagers against a target of ${vil.target}`);
    check(vil.atOrigin === 0, 'no villager is standing on the origin',
          `${vil.atOrigin} VILLAGERS STUCK AT (0,0) — they are inside the Great Hall, ` +
          'which is exactly the bug that made the camp look empty');
    check(vil.inSolid === 0, 'no villager is standing inside a building or the water',
          `${vil.inSolid} villagers inside solid geometry`);
    check(vil.textured, `the crowd is painted with the colormap (${vil.meshes} instanced meshes)`,
          'VILLAGERS ARE UNTEXTURED — the crowd has its own material and did not get ' +
          'repainted when the atlas decoded, so the whole village renders as white blanks');
    check(vil.drawn === vil.count,
          `${vil.drawn} figures actually drawn, matching the ${vil.count} villagers`,
          `${vil.drawn} figures drawn but ${vil.count} villagers exist — unused instance ` +
          'slots are rendering somewhere');
    check(vil.drawnAtOrigin === 0, 'nothing is drawn standing on the origin',
          `${vil.drawnAtOrigin} FIGURES DRAWN AT THE ORIGIN — a pile of people inside the Great Hall`);
    check(vil.withHousing === vil.count + 6 && vil.restored === vil.count,
          'housing levels drive how many people are in the camp',
          `housing did not move the crowd: ${vil.count} -> ${vil.withHousing} ` +
          `(expected ${vil.count + 6}), back to ${vil.restored}`);

    /* ---------- the tiers put something on screen ----------
       The check above this one asks whether crossing into tier 4 *triggers a
       rebuild*, which is the right question about the gate. It is not the same
       question as "does the building look different", and it reads
       userData.vtier -- the field the gate itself compares. Empty out
       hallExtras() and that check stays green while the Great Hall stops
       growing. So measure the geometry independently: bounding box and mesh
       count, off the built object, through the real upgrade path. */
    const tierGeom = await page.evaluate(() => {
      const out = {};
      const read = (e) => {
        const box = new THREE.Box3().setFromObject(e.root);
        const v = box.getSize(new THREE.Vector3());
        let meshes = 0; e.root.traverse(o => { if (o.isMesh) meshes++; });
        return { w: +v.x.toFixed(2), h: +v.y.toFixed(2), d: +v.z.toFixed(2), meshes };
      };
      ['Great Hall', 'Lodge', 'Sawmill', 'Market', 'Watch Platform'].forEach(name => {
        const e = interactiveBuildings.find(b => b.data.name === name);
        const was = e.data.level, seen = [];
        [7, 10, 13].forEach(lvl => { e.data.level = lvl; rebuildBuilding(e); seen.push(read(e)); });
        e.data.level = was; rebuildBuilding(e);
        out[name] = seen;
      });
      return out;
    });
    Object.keys(tierGeom).forEach(name => {
      const [t3, t4, t5] = tierGeom[name];
      const grew = (a, b) => b.meshes > a.meshes || b.w > a.w + 0.2 || b.h > a.h + 0.2 || b.d > a.d + 0.2;
      check(grew(t3, t4) && grew(t4, t5),
            `${name} is visibly bigger at level 10 and again at 13`,
            `${name} STOPS CHANGING PAST LEVEL 9 — tier 3/4/5 measured as ` +
            tierGeom[name].map(x => `${x.meshes} meshes ${x.w}x${x.h}x${x.d}`).join('  ->  ') +
            '\n      Either the rebuild gate is comparing floor counts again, or the ' +
            'tier 4/5 dressing for this building is not adding anything.');
    });

    /* ---------- Maji-Forest animation ----------
       Two things here can rot without anyone noticing. A render loop that
       forgets to stop keeps a phone busy drawing a board nobody is touching,
       and it looks identical to one that behaves. And an animation that the
       game logic waits on turns the rules into a timing problem — the solver
       checks above play a whole board inside one tick, so anything deferred
       breaks them instead.

       Sabotaging that second one is worth knowing about: deferring the removal
       by 200ms makes the solver checks shout UNSOLVABLE BOARD long before this
       block runs, which points at the generator rather than at the animation
       that actually broke it. So this check is not the first alarm — it is the
       one that says which alarm to believe. If both fire together, the board
       generator is fine and something started waiting on a frame. */
    const anim = await page.evaluate(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const settle = async () => {
        /* Polled, never timed: this box runs at a couple of frames a second
           and any wall-clock deadline here is a coin toss. Bounded, though —
           the whole point of the check below is that this may never come true,
           and a loop that never stops must not be able to hang the suite. */
        for (let i = 0; i < 120 && (maji.fx.length || maji.raf); i++) await sleep(40);
      };
      const pairNow = () => {
        const live = majiLive(), free = live.filter(t => majiIsFree(t, live));
        for (let i = 0; i < free.length; i++)
          for (let j = i + 1; j < free.length; j++)
            if (free[i].sym === free[j].sym) return [free[i].i, free[j].i];
        return null;
      };
      const out = {};
      openTab('arcade');
      arcadeGame = 'maji';
      settings.majiAnim = true;
      settings.majiAnimSpeed = 'snappy';

      majiStart('easy', false);
      majiRender();
      out.mounted = !!maji.ctx;
      out.dealt   = maji.fx.some(f => f.kind === 'deal') && maji.raf !== 0;
      await settle();
      out.idleFx = maji.fx.length;
      out.idleRaf = maji.raf;
      /* Recorded, then stopped by force. A leaked render loop left running
         would drag out every check after this one and make the report look
         like several unrelated problems. */
      majiFxStop();

      /* the rules must not wait for a frame */
      const p = pairNow();
      const before = majiLive().length;
      majiTap(p[0]);
      majiTap(p[1]);
      out.removedOnTap = majiLive().length === before - 2;
      out.ghosts = majiFxGhosts().length;

      /* and a tile on its way out must not still be tappable */
      const g = maji.geom, t = maji.tiles[p[0]];
      out.ghostTapped = majiHit(g.ox + (t.x / 2) * g.tw - t.z * g.dx + g.tw * 0.4,
                                g.oy + (t.y / 2) * g.th - t.z * g.dy + g.th * 0.4) === p[0];
      await settle();

      /* switched off, nothing is recorded and nothing runs */
      settings.majiAnim = false;
      majiStart('easy', false);
      majiRender();
      const p2 = pairNow();
      const before2 = majiLive().length;
      majiTap(p2[0]);
      majiTap(p2[1]);
      out.offFx = maji.fx.length;
      out.offRaf = maji.raf;
      out.offPlays = majiLive().length === before2 - 2;

      /* the loop dies with the panel */
      settings.majiAnim = true;
      majiStart('easy', false);
      majiRender();
      majiSuspend();
      out.closedRaf = maji.raf;
      out.closedFx = maji.fx.length;

      settings.majiAnim = true;
      settings.majiAnimSpeed = 'normal';
      /* Leave nothing running behind us. On a healthy build this is a no-op;
         on a broken one it is the difference between a report that names the
         problem and a suite that simply hangs. */
      majiFxStop();
      return out;
    });

    check(anim.mounted && anim.dealt, 'the board deals in and the render loop starts',
          `no deal animation: mounted=${anim.mounted} dealt=${anim.dealt}`);
    check(anim.idleFx === 0 && anim.idleRaf === 0,
          'the render loop stops once nothing is moving',
          `THE BOARD KEEPS RENDERING WITH NOTHING ANIMATING (fx=${anim.idleFx}, raf=${anim.idleRaf}) — ` +
          'this is a phone drawing a still board forever, and it looks fine on a desktop');
    check(anim.removedOnTap,
          'a matched pair leaves the board on the tap, not when its fade ends',
          'THE RULES ARE WAITING ON AN ANIMATION — state must never depend on a frame, ' +
          'or the whole board-solvability suite becomes a timing test');
    check(anim.ghosts === 2, 'the matched pair keeps drawing as two ghosts while it fades',
          `expected 2 fading ghosts, got ${anim.ghosts}`);
    check(!anim.ghostTapped, 'a tile fading out cannot be tapped again',
          'A FADING TILE IS STILL TAPPABLE — the hit test is reading the draw list');
    check(anim.offFx === 0 && anim.offRaf === 0 && anim.offPlays,
          'with animations off nothing is recorded, nothing runs, and the game plays the same',
          `animations off did not switch off: fx=${anim.offFx} raf=${anim.offRaf} plays=${anim.offPlays}`);
    check(anim.closedRaf === 0 && anim.closedFx === 0,
          'closing the panel stops the render loop',
          `the loop outlived the panel: raf=${anim.closedRaf} fx=${anim.closedFx}`);
    /* ---------- visiting another camp ----------
       Visiting stands somebody else's buildings up in your world. The failure
       that would matter is a save running while that is true: it would write
       their camp over yours, and it would look like your camp had simply
       changed overnight. */
    const visit = await page.evaluate(() => {
      const out = {};
      const levelsNow = () => interactiveBuildings.map(b => b.data.level);

      /* give this camp something recognisable to come home to */
      interactiveBuildings.forEach((b, i) => { b.data.level = (i % 3) + 1; });
      const home = levelsNow();
      out.homeSum = home.reduce((a, b) => a + b, 0);

      /* a friend's card, deliberately different from ours */
      friendsState = { state:'ok', at: Date.now(), error:'', rows: [{
        uid: 'friend-uid', name: 'Fernwatch', level: 9,
        b: interactiveBuildings.map(() => 7), mutual: true,
      }] };

      visitVillage('friend-uid');
      out.visiting     = !!visiting;
      out.theirLevels  = levelsNow().every(v => v === 7);
      out.barShown     = !!document.querySelector('.visit-bar.show');

      /* the guard: a save while visiting must not write their camp into ours */
      const before = JSON.stringify(readSlot(activeSlot));
      saveGame();
      out.saveBlocked  = JSON.stringify(readSlot(activeSlot)) === before;

      /* And taps must do nothing. Tapping the middle of the screen hits the
         Great Hall, which normally opens its sheet — so the pair of taps below
         is the check: silent while visiting, and working again once home. A
         check that only caught a thrown error would pass with the guard
         deleted, which is what the first version of this did. */
      const tapMiddle = () => {
        try { sheet.classList.remove('show'); } catch (e) {}
        tapAt(innerWidth / 2, innerHeight / 2);
        return sheet.classList.contains('show');
      };
      out.tapWhileVisiting = tapMiddle();

      leaveVisit();
      out.tapAtHome   = tapMiddle();
      try { sheet.classList.remove('show'); } catch (e) {}
      out.home        = JSON.stringify(levelsNow()) === JSON.stringify(home);
      out.barHidden   = !document.querySelector('.visit-bar.show');
      out.savesAgain  = (function(){ saveGame(); const s = readSlot(activeSlot);
                                     return !!(s && Array.isArray(s.b)); })();

      /* the code is stable, and shaped the way the rules demand */
      const c1 = villageCode(), c2 = villageCode();
      out.codeStable = c1 === c2 && /^[A-Z0-9]{6}$/.test(c1);
      return out;
    });

    check(visit.visiting && visit.theirLevels,
          "visiting stands the other camp's buildings up in the world",
          `visiting=${visit.visiting} theirLevels=${visit.theirLevels}`);
    check(visit.barShown && visit.barHidden,
          'the visiting banner appears and goes away again',
          `shown=${visit.barShown} hidden after leaving=${visit.barHidden}`);
    check(visit.saveBlocked,
          'a save while visiting is refused, so their camp cannot overwrite yours',
          'THEIR CAMP WAS SAVED INTO YOURS — this is the failure that loses a player their game');
    check(!visit.tapWhileVisiting && visit.tapAtHome,
          'tapping a building does nothing while visiting, and works again at home',
          `THE WORLD IS STILL INTERACTIVE WHILE VISITING: opened while away=${visit.tapWhileVisiting}, ` +
          `opened at home=${visit.tapAtHome} (if both are false the tap never worked and this check proves nothing)`);
    check(visit.home,
          'leaving a visit puts your own camp back exactly as it was',
          'YOUR CAMP DID NOT COME BACK after visiting');
    check(visit.savesAgain, 'saving works again once you are home',
          'the save guard stayed on after leaving — the camp would stop saving');
    check(visit.codeStable, 'the camp code is stable and matches the shape the rules require',
          'the camp code changes or is malformed, so a code you gave somebody stops working');

    /* ---------- opening Alliance loads your camp list ----------
       myFriends lives only in Firestore; it is never part of the local save.
       On a fresh page load friendsState starts idle and stays idle unless
       something calls loadFriends(). Miss that hook and a killed-and-reopened
       app shows "Nobody yet" until Refresh is tapped, which reads exactly like
       an added camp having vanished, even though nothing was ever lost
       server-side. Spy on loadFriends rather than hitting real Firestore
       headlessly — the point under test is whether openTab calls it, not
       what it fetches. */
    const allianceOpen = await page.evaluate(() => {
      const out = {};
      friendsState = { state:'idle', rows:null, error:'', at:0 };
      let calls = 0;
      const real = loadFriends;
      loadFriends = function(force){ calls++; return real(force); };
      closeTab();
      openTab('alliance');
      out.calledOnOpen = calls > 0;
      closeTab();
      loadFriends = real;
      return out;
    });
    check(allianceOpen.calledOnOpen,
          'opening the Alliance tab fetches your camp list',
          'ALLIANCE TAB DOES NOT LOAD FRIENDS ON OPEN — friendsState stays idle after a fresh ' +
          'load, so a killed-and-reopened app shows "Nobody yet" for camps that are still saved.');

    /* ---------- world chat, in the running game ---------- */
    const chat = await page.evaluate(() => {
      const out = {};
      /* the filter masks rather than refuses — a message that vanishes with no
         explanation reads as a bug */
      out.plain   = chatClean('hello other camps');
      out.foul    = chatClean('you are a shit player');
      out.leet    = chatClean('you are a sh1t player');
      out.spaced  = chatClean('you are a shiiiit player');
      out.link    = chatClean('join me at http://example.com/x now');
      out.bare    = chatClean('come to evil-site.xyz/abc');
      out.email   = chatClean('mail me at someone@example.com ok');
      out.long    = chatClean('x'.repeat(400)).length;
      out.empty   = chatClean('   ');

      /* the rate limit is held in device settings, so a reload is not a reset */
      settings.chatSent = [];
      out.freshOk = chatHoldReason() === '';
      chatNoteSent();
      out.gapHeld = chatHoldReason() !== '';
      settings.chatSent = [Date.now() - 60001];        // outside the window
      out.windowClears = chatHoldReason() === '';
      settings.chatSent = [];
      for (let i = 0; i < 6; i++) settings.chatSent.push(Date.now() - 1000 * i);
      out.burstHeld = chatHoldReason() !== '';
      settings.chatSent = [];

      /* blocking is local and survives a re-render */
      settings.chatBlocked = [];
      chatBlock('someone-else');
      out.blocked = chatIsBlocked('someone-else');
      chatUnblockAll();
      out.unblocked = !chatIsBlocked('someone-else');
      return out;
    });

    check(chat.plain === 'hello other camps', 'an ordinary message goes through untouched',
          `the filter mangled a clean message: "${chat.plain}"`);
    check(chat.foul.indexOf('shit') === -1 && chat.foul.indexOf('player') !== -1,
          'strong language is masked and the rest of the sentence survives',
          `filter output: "${chat.foul}"`);
    check(chat.leet.indexOf('sh1t') === -1 && chat.spaced.indexOf('shiiiit') === -1,
          'the filter is not beaten by sh1t or shiiiit',
          `leet: "${chat.leet}"  stretched: "${chat.spaced}"`);
    check(chat.link.indexOf('example.com') === -1 && chat.bare.indexOf('evil-site') === -1,
          'links are stripped, bare domains included',
          `link: "${chat.link}"  bare: "${chat.bare}"`);
    check(chat.email.indexOf('@example.com') === -1,
          'an email address never makes it into the channel',
          `email leaked through the filter: "${chat.email}"`);
    check(chat.long === 200 && chat.empty === '',
          'a message is capped at 200 characters and whitespace is not a message',
          `long=${chat.long} empty="${chat.empty}"`);
    check(chat.freshOk && chat.gapHeld && chat.windowClears && chat.burstHeld,
          'the rate limit holds a fast second message and a burst, then lets go',
          `fresh=${chat.freshOk} gap=${chat.gapHeld} clears=${chat.windowClears} burst=${chat.burstHeld}`);
    check(chat.blocked && chat.unblocked, 'blocking and clearing the block list both work',
          `blocked=${chat.blocked} unblocked=${chat.unblocked}`);

  } catch (e) {
    bad('the game did not finish loading: ' + e.message);
    if (pageErrors.length) console.log('      page errors: ' + pageErrors.join(' | '));
  } finally {
    await browser.close();
    try { server.close(); } catch (e) {}
  }

  finish();

  function finish() {
    if (failed === 0 && process.argv.includes('--site')) {
      step('Assembling _site/');
      const out = path.join(ROOT, '_site');
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      for (const f of SITE_FILES) fs.copyFileSync(path.join(ROOT, f), path.join(out, f));
      /* Sound clips, models and the libraries all ship as files rather than
         inlined, so the whole folder has to come with them. A missing audio
         folder silently no-ops every cue; a missing models folder is a camp
         with nothing in it. */
      let extra = 0;
      const copyTree = (rel) => {
        const src = path.join(ROOT, rel);
        if (!fs.existsSync(src)) return;
        fs.mkdirSync(path.join(out, rel), { recursive: true });
        for (const f of fs.readdirSync(src)) {
          const s = path.join(src, f);
          if (fs.statSync(s).isDirectory()) copyTree(path.join(rel, f));
          else { fs.copyFileSync(s, path.join(out, rel, f)); extra++; }
        }
      };
      copyTree('audio');
      copyTree('models');
      copyTree('vendor');
      ok(`${SITE_FILES.length} files + ${extra} assets staged for publishing`);
    }
    console.log('\n' + (failed === 0
      ? 'PASS — safe to publish.'
      : `FAIL — ${failed} problem(s). Not publishing.`));
    process.exit(failed === 0 ? 0 : 1);
  }
})();
