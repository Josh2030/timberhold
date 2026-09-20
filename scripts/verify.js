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

    /* Forest Runner's sprite/background art moved out to files too (2026-09-12) --
       runner/*.png loaded by relative path via CSS background-image, not through
       ASSET_MANIFEST. A missing file here renders as a blank monster or a hole in
       the parallax, silently -- same failure mode as a missing model. */
    const grabObj = (marker) => {
      const i = html.indexOf(marker);
      if (i < 0) return null;
      let start = i + marker.length, depth = 0, j = start, inStr = false, esc = false;
      for (; j < html.length; j++) {
        const c = html[j];
        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
        else if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { j++; break; } }
      }
      try { return JSON.parse(html.slice(start, j)); } catch (e) { return null; }
    };
    const rnAnim = grabObj('const ANIM=');
    const rnBg = grabObj('const BG=');
    const runnerUrls = [];
    if (rnAnim) for (const clips of Object.values(rnAnim)) for (const clip of Object.values(clips)) runnerUrls.push(clip.u);
    if (rnBg) for (const layer of Object.values(rnBg)) runnerUrls.push(layer.u);
    check(runnerUrls.length === 22, `Forest Runner's art manifest lists ${runnerUrls.length} sprite/background images`,
          `expected 22 ANIM+BG images (6 monsters x walk/attack, plus hero and 10 background layers) but found ${runnerUrls.length} -- did ANIM/BG change shape?`);
    const runnerInlined = runnerUrls.filter(u => u.startsWith('data:'));
    check(runnerInlined.length === 0, 'none of Forest Runner\'s art is inlined as base64 anymore',
          `${runnerInlined.length} image(s) are back to base64 -- this is exactly what blew the byte budget before`);
    const runnerMissing = [];
    let runnerBytes = 0;
    for (const rel of runnerUrls) {
      if (rel.startsWith('data:')) continue;
      const p = path.join(ROOT, rel);
      if (!fs.existsSync(p)) runnerMissing.push(rel); else runnerBytes += fs.statSync(p).size;
    }
    check(runnerMissing.length === 0,
          `all ${runnerUrls.length - runnerMissing.length} Forest Runner art files are on disk (${(runnerBytes / 1024).toFixed(0)} KB)`,
          'FOREST RUNNER ART MISSING -- these render as blank sprites/tiles, with nothing said:\n      ' + runnerMissing.join('\n      '));

    /* the whole point of the exercise */
    const kb = Buffer.byteLength(html) / 1024;
    check(kb < 500, `index.html is ${kb.toFixed(0)} KB, parsed on every load`,
          `index.html is back up to ${kb.toFixed(0)} KB — the assets have leaked into the page again`);

    /* every asset folder the page actually reaches has to be part of the
       --site staging too, or GitHub Pages ships fine locally and blank for
       real: exactly the bug that would have shipped here if runner/ had been
       added without teaching the --site copyTree() list about it. */
    const referencedFolders = new Set(['audio']);
    if (manifest) for (const kit of Object.values(manifest)) referencedFolders.add(kit.dir.split('/')[0]);
    for (const rel of runnerUrls) if (!rel.startsWith('data:')) referencedFolders.add(rel.split('/')[0]);
    const selfSrc = fs.readFileSync(__filename, 'utf8');
    const stagedFolders = new Set([...selfSrc.matchAll(/copyTree\('([^']+)'\)/g)].map(m => m[1]));
    const unstagedFolders = [...referencedFolders].filter(f => !stagedFolders.has(f));
    check(unstagedFolders.length === 0,
          `site staging covers every referenced asset folder (${[...stagedFolders].join(', ')})`,
          'ASSET FOLDER NOT IN --site STAGING: ' + unstagedFolders.join(', ') +
          ' -- Firebase deploy would still work, GitHub Pages would ship without it');
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
    /* This used to assert the hero's Box3 height landed in 3.8-4.2, and that
       assertion is what makes this whole area dangerous rather than safe.

       The hero is a SkinnedMesh, and in three r128 Box3 measures a skinned
       mesh from its unposed geometry and node transform -- not from where the
       skinning puts the vertices. On this Mixamo rig, which arrives rotated by
       its own import transform, that number is somewhere between meaningless
       and actively misleading. A hero that renders perfectly measures 9.3
       "tall" with its "feet" 2.1 below zero, and a hero rescaled until those
       numbers read 3.99 and +0.004 renders as a screen-filling blob.

       2026-09-08 followed the numbers into exactly that trap: made them
       beautiful, made the game worse, and only caught it by rendering the camp
       and looking. So the height is no longer asserted at all -- it is only
       reported. What is asserted is the thing that was wrong both times the
       hero broke: how much of the frame the hero actually covers. A correctly
       sized hero is a person standing in a camp, a few percent of the shot; a
       blob is most of it. That is measured by rendering the camp twice, once
       with the hero hidden, and counting the pixels that changed. */
    const heroPix = await page.evaluate(() => {
      if (!hero) return null;
      const W = 300, H = 300;
      const rt = new THREE.WebGLRenderTarget(W, H);
      rt.texture.encoding = renderer.outputEncoding;   // a target renders LINEAR otherwise
      const shot = () => {
        const was = renderer.getRenderTarget();
        renderer.setRenderTarget(rt);
        renderer.render(scene, camera);
        const buf = new Uint8Array(W*H*4);
        renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
        renderer.setRenderTarget(was);
        return buf;
      };
      hero.root.visible = true;  const withHero = shot();
      hero.root.visible = false; const without  = shot();
      hero.root.visible = true;
      rt.dispose();
      let changed = 0;
      for (let i = 0; i < W*H; i++){
        const o = i*4;
        if (Math.abs(withHero[o]-without[o]) + Math.abs(withHero[o+1]-without[o+1])
          + Math.abs(withHero[o+2]-without[o+2]) > 12) changed++;
      }
      return { pct: (changed / (W*H)) * 100, scale: hero.root.scale.x };
    });
    check(heroPix && heroPix.pct > 0.02 && heroPix.pct < 12,
          `the hero reads as a person in the camp, covering ${heroPix ? heroPix.pct.toFixed(2) : '?'}% of the view`,
          'THE HERO IS NOT A PERSON-SIZED THING ON SCREEN: it covers '
          + (heroPix ? heroPix.pct.toFixed(2) : '?') + '% of the frame (scale '
          + (heroPix ? heroPix.scale.toFixed(0) : '?') + '). Over ~12% is the blob bug '
          + 'from 2026-09-04 and 2026-09-08; under 0.02% means it is invisible or gone. '
          + 'Do NOT chase the Box3 height here -- see the comment in addHero().');
    if (r.hero) console.log(`    · hero Box3 height ${r.hero.height.toFixed(2)}, feet ${r.hero.feet.toFixed(2)} ` +
                            '(reported only — this rig\'s Box3 does not describe what renders)');

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

      /* Walk every level and record where the tier number actually changes,
         then compare that against the list the sheet quotes. Computed from
         visualTier rather than from TIER_LEVELS, so the two really are being
         checked against each other. */
      const realSteps = [];
      for (let l = 1; l <= 20; l++)
        if (visualTier(l, 'lodge') !== visualTier(l - 1, 'lodge')) realSteps.push(l);
      const promised = TIER_LEVELS.slice();
      const disagree = [];
      realSteps.forEach(l => { if (promised.indexOf(l) === -1) disagree.push('visualTier steps at ' + l + ' unannounced'); });
      promised.forEach(l => { if (realSteps.indexOf(l) === -1) disagree.push('sheet promises ' + l + ' but nothing changes'); });

      return {
        lodgeCadence:  sample('lodge'),
        marketCadence: sample('market'),
        cap: visualTier(999, 'lodge'),
        lodgeStep, marketStep,
        tierLevels: promised,
        tierLevelsAgree: disagree,
      };
    });

    check(JSON.stringify(tiers.lodgeCadence) === JSON.stringify([1,1,3,3,4,4,5,5,5]),
          'visualTier climbs 1..5 across levels 1-24 on the ~3-level cadence',
          'visualTier CADENCE CHANGED for ordinary buildings: got ' + JSON.stringify(tiers.lodgeCadence));
    check(JSON.stringify(tiers.marketCadence) === JSON.stringify(tiers.lodgeCadence),
          'the Market steps on the same cadence as every other building',
          'MARKET IS BACK ON ITS OWN CADENCE: market ' + JSON.stringify(tiers.marketCadence)
          + ' vs ordinary ' + JSON.stringify(tiers.lodgeCadence));
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

    /* The Market used to be the one building on its own cadence, and the check
       here forced it through 7 -> 8 to prove a second rhythm still crossed a
       tier. Every building shares one rhythm now, so that sabotage no longer
       separates this check from the Lodge's — and a check with no sabotage of
       its own is not a check.

       Aimed at the thing that IS newly true and newly breakable instead: the
       building sheet promises the player "next major upgrade at level N" out of
       TIER_LEVELS, while the geometry is decided by visualTier(). Those are two
       separate pieces of code that have to agree, and if they drift the game
       lies to the player with nothing else in the suite noticing. */
    check(tiers.tierLevelsAgree.length === 0,
          'the levels the sheet promises are exactly the levels visualTier actually steps on',
          'THE SHEET LIES ABOUT UPGRADES: TIER_LEVELS and visualTier disagree at '
          + JSON.stringify(tiers.tierLevelsAgree));
    check(JSON.stringify(tiers.tierLevels) === JSON.stringify([1,4,7,10,13]),
          'the shape-changing levels are 1, 4, 7, 10 and 13',
          'TIER LEVELS CHANGED: ' + JSON.stringify(tiers.tierLevels));


    /* ---------- construction, gating and the crowd's legs ----------
       Everything below mutates live buildings, so the block snapshots the camp
       first and puts it back through applyState() at the end -- the later
       checks (walkable spots, villager counts, claimed plots) all count on the
       world being in its normal freshly-booted shape. */
    const cons = await page.evaluate(() => {
      const meshes = r => { let n = 0; r.traverse(o => { if (o.isMesh) n++; }); return n; };
      const snapshot = buildSaveObject();
      const resBefore = Object.assign({}, res);
      const out = {};

      const lodge = interactiveBuildings.find(b => b.data.kind === 'lodge');
      const hall  = greatHall();
      const idx   = interactiveBuildings.indexOf(lodge);

      /* ---- the clock ---- */
      out.durations = [1, 5, 10, 20, 40].map(l => buildMs(l));
      out.skipCosts = [1000, 8000, 15000].map(ms => buildSkipCost(ms));

      res.wood = 1e9; res.gold = 1e9; res.food = 1e9; res.gems = 500;
      hall.data.level = 20;                       // so the gate is not what stops us
      lodge.data.level = 9; rebuildBuilding(lodge);
      out.tierBefore   = lodge.root.userData.vtier;
      out.meshesBefore = meshes(lodge.root);

      openSheet(lodge.data);                      // the real path a finger takes
      out.btnDisabledBefore = sheetUpgradeBtn.disabled;
      sheetUpgradeBtn.click();

      out.levelAfterTap   = lodge.data.level;            // economy moves at once
      out.timerSet        = lodge.data.buildUntil > Date.now();
      out.tierDuringBuild = lodge.root.userData.vtier;   // the look does NOT
      out.meshesDuring    = meshes(lodge.root);
      out.scaffolds       = buildEffects.filter(f => f.owner === lodge).length;
      out.noteWorking     = /Building/.test(sheetBuild.innerHTML);

      /* a second tap while the scaffold is up must not buy another level */
      const gemsHeld = res.gems; res.gems = 0;
      openSheet(lodge.data);
      sheetUpgradeBtn.click();
      out.levelAfterSecondTap = lodge.data.level;
      res.gems = gemsHeld;

      /* the same button finishes it for gems */
      openSheet(lodge.data);
      out.buttonSaysFinish = sheetUpgradeLabel.textContent;
      const gemsWas = res.gems;
      sheetUpgradeBtn.click();
      out.gemsSpent      = gemsWas - res.gems;
      out.finishedByGems = !lodge.data.buildUntil;
      out.tierAfter      = lodge.root.userData.vtier;
      out.meshesAfter    = meshes(lodge.root);
      out.scaffoldsAfter = buildEffects.filter(f => f.owner === lodge).length;

      /* ---- the clock finishes on its own too, without the gem path ---- */
      lodge.data.level = 9; rebuildBuilding(lodge);
      openSheet(lodge.data); sheetUpgradeBtn.click();
      const tierMid = lodge.root.userData.vtier;
      lodge.data.buildUntil = Date.now() - 1;     // wind it forward
      stepBuildEffects(0.016);
      out.selfFinished   = !lodge.data.buildUntil && lodge.root.userData.vtier !== tierMid;
      out.scaffoldsEnd   = buildEffects.filter(f => f.owner === lodge).length;

      /* ---- closing the app mid-build ---- */
      lodge.data.level = 9; rebuildBuilding(lodge);
      openSheet(lodge.data); sheetUpgradeBtn.click();
      const midSave = buildSaveObject();
      const levelInSave = midSave.b[idx].level;
      /* deadline already passed while the app was shut: comes back finished */
      const past = JSON.parse(JSON.stringify(midSave));
      past.bt[idx] = Date.now() - 60000;
      applyState(past);
      out.awayFinished = !interactiveBuildings[idx].data.buildUntil;
      out.awayKeptLevel = interactiveBuildings[idx].data.level === levelInSave;
      /* deadline still ahead: the scaffold goes back up with the remainder */
      const future = JSON.parse(JSON.stringify(midSave));
      future.bt[idx] = Date.now() + 30000;
      applyState(future);
      out.resumedTimer = interactiveBuildings[idx].data.buildUntil > Date.now();
      out.resumedScaffold = buildEffects.filter(f => f.owner === interactiveBuildings[idx]).length;
      out.savesTimers = Array.isArray(midSave.bt) && midSave.bt.length === interactiveBuildings.length;
      out.saveVersion = midSave.v;
      interactiveBuildings[idx].data.buildUntil = 0;
      dropBuildEffect(interactiveBuildings[idx]);

      /* ---- the gate, both ways ---- */
      const other = interactiveBuildings.filter(b => b !== hall && b.data.kind !== 'lodge');
      hall.data.level = 5;
      lodge.data.level = 5; lodge.data.buildUntil = 0;
      out.blockedAtHall = upgradeBlockReason(lodge.data);      // may not pass the Hall
      lodge.data.level = 3;
      out.freeBelowHall = upgradeBlockReason(lodge.data);      // room to grow: ''
      out.hallHeld = upgradeBlockReason(hall.data);            // held by the Lodge at 3
      out.hallBlockerCount = hallBlockers().length;
      /* unbuilt plots must not hold the Hall hostage */
      other.forEach(b => { b.data.level = 0; });
      lodge.data.level = 5;
      out.hallFreeWhenCaughtUp = upgradeBlockReason(hall.data);
      out.unbuiltIgnored = hallBlockers().length === 0;
      /* a brand new plot is never gated */
      lodge.data.level = 0;
      out.newPlotFree = upgradeBlockReason(lodge.data);

      /* ---- grandfathering: a save above the cap keeps every level ---- */
      const over = JSON.parse(JSON.stringify(snapshot));
      over.bt = [];
      over.b.forEach(b => { b.level = b.name === 'Great Hall' ? 4 : 12; });
      applyState(over);
      out.grandfathered = interactiveBuildings
        .filter(b => b.data.name !== 'Great Hall')
        .every(b => b.data.level === 12);
      out.grandfatheredHall = greatHall().data.level === 4;

      /* ---- put the camp back exactly as it was found ---- */
      applyState(snapshot);
      Object.assign(res, resBefore);
      interactiveBuildings.forEach(b => { b.data.buildUntil = 0; dropBuildEffect(b); });
      sheet.classList.remove('show');
      currentData = null;
      refreshVillage();
      refreshResourceUI();
      return out;
    });

    check(cons.durations[0] < cons.durations[2] && cons.durations[2] < cons.durations[3] &&
          cons.durations[4] === cons.durations[3] && cons.durations[0] >= 4000,
          `a build runs ${(cons.durations[0]/1000).toFixed(1)}s at level 1 up to a ${(cons.durations[4]/1000).toFixed(0)}s cap`,
          'BUILD TIMES ARE NOT SCALING: ' + JSON.stringify(cons.durations));
    check(cons.skipCosts[0] === 1 && cons.skipCosts[2] > cons.skipCosts[0],
          'finishing early costs more gems the more time is left on the clock',
          'SKIP PRICING IS FLAT OR BACKWARDS: ' + JSON.stringify(cons.skipCosts));
    check(cons.levelAfterTap === 10 && cons.timerSet,
          'tapping Upgrade takes the level and the resources at once and starts the clock',
          `level went to ${cons.levelAfterTap}, timer set = ${cons.timerSet}`);
    /* The whole design rests on this one: state moves on the tap, the animation
       is only decoration over it. If the level waited for the scaffold, a
       closed app would strand the upgrade the player already paid for. */
    check(cons.tierDuringBuild === cons.tierBefore && cons.meshesDuring === cons.meshesBefore,
          'the new shape is held back until the scaffold comes down, while the level is already banked',
          `THE REVEAL LEAKED: tier ${cons.tierBefore} -> ${cons.tierDuringBuild}, meshes ${cons.meshesBefore} -> ${cons.meshesDuring}`);
    check(cons.scaffolds === 1 && cons.noteWorking,
          'a scaffold goes up over the building and the sheet says it is building',
          `scaffolds=${cons.scaffolds}, sheet note working=${cons.noteWorking}`);
    check(cons.levelAfterSecondTap === 10,
          'tapping again while it is still going up does not buy a second level',
          `DOUBLE UPGRADE: level ran to ${cons.levelAfterSecondTap} on a second tap`);
    check(/Finish/.test(cons.buttonSaysFinish) && cons.gemsSpent > 0 && cons.finishedByGems,
          `gems finish a build early (spent ${cons.gemsSpent})`,
          `button said "${cons.buttonSaysFinish}", gems spent ${cons.gemsSpent}, finished=${cons.finishedByGems}`);
    check(cons.tierAfter !== cons.tierBefore && cons.meshesAfter !== cons.meshesBefore &&
          cons.scaffoldsAfter === 0,
          'finishing reveals the new shape and takes the scaffold away',
          `tier ${cons.tierBefore} -> ${cons.tierAfter}, meshes ${cons.meshesBefore} -> ${cons.meshesAfter}, scaffolds left ${cons.scaffoldsAfter}`);
    check(cons.selfFinished && cons.scaffoldsEnd === 0,
          'a build left alone finishes itself on the clock and clears its scaffold',
          `self-finish=${cons.selfFinished}, scaffolds left ${cons.scaffoldsEnd}`);
    check(cons.savesTimers && cons.saveVersion === 10,
          'the deadlines are written into the save at v10, one slot per plot',
          `save v${cons.saveVersion}, timers array ok = ${cons.savesTimers}`);
    check(cons.awayFinished && cons.awayKeptLevel,
          'a build whose clock ran out while the app was shut is simply finished on reload',
          `still building = ${!cons.awayFinished}, level kept = ${cons.awayKeptLevel}`);
    check(cons.resumedTimer && cons.resumedScaffold === 1,
          'a build still running on reload puts its scaffold back up with the time that is left',
          `timer restored = ${cons.resumedTimer}, scaffolds = ${cons.resumedScaffold}`);
    check(!!cons.blockedAtHall && !cons.freeBelowHall,
          'nothing may pass the Great Hall, and anything below it is free to grow',
          `at the cap: "${cons.blockedAtHall}" | below it: "${cons.freeBelowHall}"`);
    check(!!cons.hallHeld && cons.hallBlockerCount > 0 && !cons.hallFreeWhenCaughtUp,
          'the Great Hall waits until every building that is up has caught up to it',
          `held="${cons.hallHeld}" blockers=${cons.hallBlockerCount} once caught up="${cons.hallFreeWhenCaughtUp}"`);
    check(cons.unbuiltIgnored && !cons.newPlotFree,
          'an empty plot neither holds the Hall back nor is gated itself',
          `unbuilt ignored = ${cons.unbuiltIgnored}, new plot reason = "${cons.newPlotFree}"`);
    /* Joshua's own camp is level 27 with buildings already past what these
       rules would ever have allowed. The gates stop the NEXT upgrade; they must
       never reach back and take a level away. */
    check(cons.grandfathered && cons.grandfatheredHall,
          'a camp loaded with buildings above the new cap keeps every level it earned',
          `buildings kept = ${cons.grandfathered}, hall kept = ${cons.grandfatheredHall}`);

    /* ---------- the crowd's legs ---------- */
    const walkRig = await page.evaluate(() => {
      const parts = villagerParts || [];
      const posed = parts.filter(p => p.poses && p.poses.walk);
      const diff = (a, b) => {
        let d = 0;
        for (let i = 0; i < 16; i++) d += Math.abs(a.elements[i] - b.elements[i]);
        return d;
      };
      /* Does the baked table actually hold different poses, or 24 copies of
         one? This is the difference between a walk cycle and a statue. */
      let maxSwing = 0;
      posed.forEach(p => {
        for (let f = 1; f < p.poses.walk.length; f++)
          maxSwing = Math.max(maxSwing, diff(p.poses.walk[0], p.poses.walk[f]));
      });
      /* And does a walking villager get drawn differently from a standing one? */
      /* Walk and idle share their first frame -- both clips start from the
         same neutral stance -- so comparing frame 0 to frame 0 measures
         nothing and reads 0.0000 even when everything is working. The question
         worth asking is whether the two tables differ ANYWHERE: if the idle
         clip were missing, bakeVillagerRig() would fall back to the walk clip
         and hand back two identical tables. */
      let walkIdleGap = 0;
      posed.forEach(p => {
        if (!p.poses.idle) return;
        for (let f = 0; f < p.poses.walk.length; f++)
          walkIdleGap = Math.max(walkIdleGap, diff(p.poses.walk[f], p.poses.idle[f]));
      });
      let idleMotion = 0;
      posed.forEach(p => {
        if (!p.poses.idle) return;
        for (let f = 1; f < p.poses.idle.length; f++)
          idleMotion = Math.max(idleMotion, diff(p.poses.idle[0], p.poses.idle[f]));
      });
      const v = villagers[0];
      const before = { moving:v.moving, frame:v.frame };
      const grab = () => {
        const m = new THREE.Matrix4();
        villagerMeshes[0].getMatrixAt(0, m);
        return m.clone();
      };
      v.moving = true;  v.frame = 0;  drawVillagers(); const a = grab();
      v.moving = true;  v.frame = 12; drawVillagers(); const b = grab();
      v.moving = false; v.frame = 12; drawVillagers(); const c = grab();
      v.moving = before.moving; v.frame = before.frame; drawVillagers();
      return {
        partCount: parts.length,
        posedCount: posed.length,
        clips: posed.length ? Object.keys(posed[0].poses) : [],
        frames: posed.length ? posed[0].poses.walk.length : 0,
        maxSwing,
        walkIdleGap,
        idleMotion,
        midStrideDiff: diff(a, b),
        walkVsIdleDiff: diff(b, c),
      };
    });

    check(walkRig.posedCount === walkRig.partCount && walkRig.partCount >= 5,
          `the villager model is split into ${walkRig.partCount} rigid bone parts, all of them posed`,
          `THE CROWD FELL BACK TO A STATIC POSE: ${walkRig.posedCount}/${walkRig.partCount} parts carry a pose — ` +
          'either the character stopped being rigidly weighted or the walk clip went missing');
    check(walkRig.frames === 24 && walkRig.clips.indexOf('walk') !== -1 && walkRig.clips.indexOf('idle') !== -1,
          'both walk and idle are baked, 24 frames each',
          `baked clips ${JSON.stringify(walkRig.clips)} at ${walkRig.frames} frames`);
    check(walkRig.maxSwing > 0.1,
          'the baked walk really moves the bones rather than holding one pose',
          `THE WALK IS A STATUE: the biggest difference between frame 0 and any other frame is ${walkRig.maxSwing.toFixed(4)}`);
    check(walkRig.midStrideDiff > 0.01,
          'a villager is drawn in a different pose mid-stride than at the start of it',
          `THE POSE IS NOT REACHING THE DRAW: frame 0 vs frame 12 differs by ${walkRig.midStrideDiff.toFixed(4)}`);
    check(walkRig.walkIdleGap > 0.05 && walkRig.walkVsIdleDiff > 0.01,
          'standing still is a different pose from walking, at the table and on screen',
          `WALK AND IDLE ARE THE SAME CLIP: tables differ by ${walkRig.walkIdleGap.toFixed(4)}, ` +
          `drawn poses by ${walkRig.walkVsIdleDiff.toFixed(4)} — the idle clip probably went missing ` +
          'and bakeVillagerRig() fell back to the walk');
    check(walkRig.idleMotion > 0.001,
          'the idle pose breathes rather than freezing solid',
          `the idle table holds one pose in all 24 frames (max change ${walkRig.idleMotion.toFixed(5)})`);

    /* ---------- the loose rocks ---------- */
    const rocks = await page.evaluate(() => {
      const kinds = {};
      pebbles.forEach(p => { const m = (p.rock && p.rock.model) || 'stones'; kinds[m] = (kinds[m]||0)+1; });
      /* Mine one of each size with the dice pinned, so the payouts can be
         compared rather than guessed at. */
      const realRandom = Math.random;
      const pay = model => {
        const pb = pebbles.find(p => p.rock && p.rock.model === model && p.alive);
        if (!pb) return null;
        Math.random = () => 0.5;
        const before = res.gold;
        const held = pb.regrowAt;
        minePebble(pb.data);
        /* taskBar's callback is what actually pays; run its body by winding the
           bar's own clock is fiddly, so read the configured range instead. */
        Math.random = realRandom;
        pb.busy = false; pb.regrowAt = held;
        return { min: pb.rock.gMin, max: pb.rock.gMax, regrow: pb.rock.regrow, gained: res.gold - before };
      };
      const small = pay('stones'), mid = pay('rocks-low'), big = pay('rocks-high');
      Math.random = realRandom;
      const short = ROCK_KINDS
        .map(k => ({ model: k.model, want: k.count, got: kinds[k.model] || 0 }))
        .filter(s => s.got < s.want);
      return { kinds, short, total: pebbles.length, small, mid, big,
               allTappable: pebbles.every(p => p.data && p.data.kind === 'pebble'),
               named: pebbles.map(p => p.data.name).filter((v,i,a) => a.indexOf(v)===i) };
    });

    /* Counts, not just presence. The first version of this only asked whether
       each kind existed at all, which made it a dice roll: placement dropped
       any rock that landed on blocked ground, so a crowded map could produce
       zero spires and fail this check on one boot and pass it on the next.
       That is worse than no check — it failed on Joshua's machine at deploy
       time, having passed on mine. Asserting the intended count is both a
       stronger claim and a stable one. */
    check(rocks.short.length === 0,
          `every rock kind placed in full — ${JSON.stringify(rocks.kinds)}`,
          'ROCKS ARE BEING LOST TO BLOCKED GROUND: ' + rocks.short.map(s =>
            `${s.model} placed ${s.got}/${s.want}`).join(', ') +
          ' — buildPebbles() gave up before reaching the intended count, so the ' +
          'world quietly has fewer rocks than it should (and a different number every boot)');
    check(rocks.allTappable,
          'every rock routes through the same tap handler',
          'a rock is in the list without the kind that makes tapAt() mine it');
    check(rocks.small && rocks.mid && rocks.big &&
          rocks.small.max < rocks.mid.max && rocks.mid.max < rocks.big.max &&
          rocks.small.regrow < rocks.mid.regrow && rocks.mid.regrow < rocks.big.regrow,
          'a bigger rock pays more gold and takes longer to come back',
          'ROCK PAYOUTS ARE NOT ORDERED BY SIZE: ' + JSON.stringify([rocks.small, rocks.mid, rocks.big]));

    /* ---------- the camp got wider ---------- */
    const spread = await page.evaluate(() => {
      const d = b => Math.hypot(b.root.position.x, b.root.position.z);
      const away = interactiveBuildings.filter(b => d(b) > 0.1);
      /* The Lodge sits at (-7.4, -5.3) in buildWorld's own numbers. Its real
         distance has to be that, multiplied through by the spread. */
      const raw = Math.hypot(7.4, 5.3);
      const lodge = interactiveBuildings.find(b => b.data.kind === 'lodge');
      return { spread: CAMP_SPREAD, plots: away.length,
               lodgeDist: d(lodge), expected: raw * CAMP_SPREAD, raw };
    });
    check(spread.spread > 1 && Math.abs(spread.lodgeDist - spread.expected) < 0.05,
          `the camp is spread ${spread.spread}x wider (the Lodge moved ${spread.raw.toFixed(1)} -> ${spread.lodgeDist.toFixed(1)})`,
          `THE SPREAD IS NOT REACHING THE PLOTS: lodge at ${spread.lodgeDist.toFixed(2)}, expected ${spread.expected.toFixed(2)}`);

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

    /* ---------- the river ---------- */
    const river = await page.evaluate(() => {
      const g = riverEdgeMesh && riverEdgeMesh.geometry.getAttribute('position');
      /* Read the drawn edge back and ask inRiver() about it. The 2026-09-02 bug
         was a river drawn from one shape and excluded by another, so checking
         the water against the same two functions that draw it would prove
         nothing -- this walks the actual vertices that ended up in the mesh. */
      let mismatch = 0, sampled = 0;
      if (g){
        /* Stepped as a fraction of the vertex count, not by a fixed stride, so
           the number of samples does not depend on how long the river is —
           otherwise shortening the river trips this check's own "not enough
           samples" guard first and buries the real complaint. */
        const step = Math.max(1, Math.floor(g.count / 60));
        for (let i = 0; i < g.count; i += step){
          const x = g.getX(i), z = g.getZ(i);
          const side = z > riverCentre(x) ? 1 : -1;
          sampled++;
          if (!inRiver(x, z - side * 0.25)) mismatch++;   // just inside is water
          if ( inRiver(x, z + side * 0.25)) mismatch++;   // just outside is not
        }
      }
      let closest = null;
      interactiveBuildings.forEach(b => {
        const x = b.root.position.x, z = b.root.position.z;
        const d = Math.abs(z - riverCentre(x)) - riverHalfWidth(x);
        if (!closest || d < closest.d) closest = { d: +d.toFixed(2), name: b.data.name };
      });
      const zs = [], ws = [];
      for (let x = RIVER_X0; x <= RIVER_X1; x += 2){ zs.push(riverCentre(x)); ws.push(riverHalfWidth(x)); }
      return {
        x0: RIVER_X0, x1: RIVER_X1, beach: BEACH_EDGE,
        sampled, mismatch,
        crossing: +riverCentre(0).toFixed(4), z0: RIVER_Z0,
        windAtZero: riverWind(0),
        swing: +(Math.max(...zs) - Math.min(...zs)).toFixed(1),
        closest,
        fordWidth: +(riverHalfWidth(0) * 2).toFixed(2),
      };
    });

    check(river.sampled > 50 && river.mismatch === 0,
          `the drawn water edge is exactly the inRiver() boundary (${river.sampled} vertices checked)`,
          river.sampled <= 50
            ? `the edge mesh only yielded ${river.sampled} sample vertices — riverEdgeMesh is missing or tiny, so this check proved nothing`
            : `THE RIVER IS DRAWN SOMEWHERE IT IS NOT EXCLUDED: ${river.mismatch} of ${river.sampled*2} ` +
              'edge probes disagreed — this is the 2026-09-02 "trees in the water" bug coming back');
    check(river.x0 < river.beach && river.x1 > 230,
          `the river runs off both ends of the map (${river.x0} to ${river.x1})`,
          `THE RIVER STOPS ON DRY LAND: spans ${river.x0} to ${river.x1}, but the beach starts at ` +
          `${river.beach} and the ground plane reaches 230`);
    /* The meander terms added for the long run carry phase offsets, which would
       normally move the crossing. They are multiplied by riverWind(), which is
       zero at x=0 — so this is the check that the bridge cannot drift. */
    check(river.windAtZero === 0 && Math.abs(river.crossing - river.z0) < 1e-9,
          'the crossing in front of the camp is still exactly where the bridge is',
          `THE BRIDGE NO LONGER MEETS THE RIVER: riverCentre(0) is ${river.crossing}, ` +
          `RIVER_Z0 is ${river.z0}, riverWind(0) is ${river.windAtZero}`);
    check(river.swing > 20,
          `the river meanders ${river.swing} units across its length`,
          `THE RIVER IS BACK TO A CANAL: the centreline only swings ${river.swing} units`);
    /* The Trading Post sat 0.13 units from the water before 2026-09-09 — close
       enough that the building overhung it. Nothing should be that close. */
    check(river.closest && river.closest.d > 2,
          `no building stands in the river (closest is the ${river.closest.name}, ${river.closest.d} clear)`,
          `A BUILDING IS IN THE WATER: ${river.closest && river.closest.name} is ` +
          `${river.closest && river.closest.d} from the water's edge`);
    check(river.x1 - river.x0 > 250,
          `river spans ${river.x1 - river.x0} units, right across the map`,
          `river only spans ${river.x1 - river.x0} units — it stops short of the map edge`);
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

    /* The fit check above runs at the same 900px viewport as everything else,
       which is roughly a phone's width and never exercised what happens on a
       real desktop window. .maji-wrap sized itself off clientWidth alone, so a
       1800px window fed straight through into tiles ~4x too big, spilling the
       board off the bottom of the panel -- reported on Joshua's desktop, never
       caught here. Widen the real page and measure the real board it draws. */
    await page.setViewportSize({ width: 1800, height: 1000 });
    const majiWide = await page.evaluate(() => {
      openTab('arcade'); openArcadeGame('maji');
      majiStart('hard', false); majiRender();
      const c = document.getElementById('majiCanvas');
      const out = { canvasW: c && maji.geom ? maji.geom.w : null };
      closeTab();
      return out;
    });
    await page.setViewportSize({ width: 900, height: 1000 });
    check(majiWide.canvasW && majiWide.canvasW <= 420,
          'Maji-Forest: a wide desktop window does not balloon the board',
          'MAJI-FOREST BOARD IGNORES THE DESKTOP WINDOW -- at 1800px wide the ' +
          'board sized itself to ' + majiWide.canvasW + 'px instead of staying ' +
          'capped, which is what made tiles oversized and the board taller than ' +
          'the panel on a desktop screen');

    /* ---------- Forest Runner ----------
       Unlike Maji-Forest and Conquer, this game owns a live
       requestAnimationFrame loop and mutates real DOM nodes every frame
       instead of re-rendering from state on demand -- loop() reschedules
       itself unconditionally at the end of every frame, so the only thing
       that actually stops it is runnerStop()'s cancelAnimationFrame call,
       wired into openTab()/closeTab() and into runnerWire() on every game
       switch. Skip that call and the loop keeps running against a
       torn-down panel: draining HP, killing enemies, and writing saves
       off-screen after the player has already left. */
    /* 2026-09-12: Joshua looked at the deployed fix next to the standalone
       endless_loot_runner.html reference he originally built this from --
       that file fills the whole browser window in a wide layout, because
       its HUD and world are laid out wide, not portrait. Told to keep the
       420px phone-shaped cap Maji-Forest/Conquer use, or go wide on a
       desktop window instead, he chose "go wide". So the assertion below is
       now the opposite of the 2026-09-11 one it replaces: a landscape tab
       body should let the panel fill it, roughly 16:9, not stay capped. */
    await page.setViewportSize({ width: 1800, height: 1000 });
    const runnerWide = await page.evaluate(() => {
      openTab('arcade'); openArcadeGame('runner');
      const el = document.getElementById('rnGame');
      const hud = document.getElementById('rnHud');
      const r = el.getBoundingClientRect();
      const out = { w: r.width, h: r.height, ratio: r.width / r.height,
                    narrowHud: el.classList.contains('rnNarrowHud'),
                    hudOverflow: hud.scrollWidth - hud.clientWidth };
      closeTab();
      return out;
    });
    await page.setViewportSize({ width: 900, height: 1000 });
    check(runnerWide.w > 420 && runnerWide.w <= 1101,
          'Forest Runner: a wide desktop window lets the panel go wide, not stay phone-shaped',
          `FOREST RUNNER STAYED PHONE-SHAPED -- at 1800px wide the panel measured only ` +
          `${runnerWide.w.toFixed(0)}px, capped like Maji-Forest/Conquer instead of filling ` +
          'the landscape tab the way the standalone reference does');
    check(Math.abs(runnerWide.ratio - 16 / 9) < 0.02,
          'Forest Runner: the wide panel keeps a landscape (16:9) shape',
          `FOREST RUNNER WIDE PANEL WRONG SHAPE -- measured ${runnerWide.w.toFixed(0)}x` +
          `${runnerWide.h.toFixed(0)} (ratio ${runnerWide.ratio.toFixed(3)} instead of ` +
          `${(16 / 9).toFixed(3)})`);
    check(runnerWide.hudOverflow <= 1,
          'Forest Runner: the HUD row fits the wide panel too',
          `FOREST RUNNER HUD OVERFLOWS THE WIDE PANEL by ${runnerWide.hudOverflow}px`);

    /* The check that matters most: does leaving actually cancel the frame,
       not just clear the variable that happens to track it. Patching
       cancelAnimationFrame and recording what it is called with proves the
       real browser API fired on the real handle -- asserting on the
       mechanism rather than on a few frames of wall-clock timing, which
       this box cannot render reliably (see the software-WebGL note above). */
    const rn = await page.evaluate(() => {
      const out = {};
      const cancelled = [];
      const origCancel = window.cancelAnimationFrame;
      window.cancelAnimationFrame = function(id){ cancelled.push(id); return origCancel.call(window, id); };

      openTab('arcade'); openArcadeGame('runner');
      out.hasEl = !!document.getElementById('rnGame');
      out.mountedRaf = rnRafId;

      /* the highest-risk path: leaving the Arcade tab entirely */
      closeTab();
      out.closedRaf = rnRafId;
      out.cancelledOnClose = cancelled.indexOf(out.mountedRaf) !== -1;

      /* switching to a different game from inside the Arcade must stop it too */
      openTab('arcade'); openArcadeGame('runner');
      const secondRaf = rnRafId;
      cancelled.length = 0;
      openArcadeGame('maji');
      out.switchedRaf = rnRafId;
      out.cancelledOnSwitch = cancelled.indexOf(secondRaf) !== -1;

      closeTab();
      window.cancelAnimationFrame = origCancel;
      return out;
    });
    check(rn.hasEl && !!rn.mountedRaf,
          'Forest Runner mounts its panel and starts its render loop',
          `mount failed: element present=${rn.hasEl}, raf id=${rn.mountedRaf}`);
    check(!rn.closedRaf && rn.cancelledOnClose,
          "leaving the Arcade tab cancels the runner's render loop",
          `THE LOOP OUTLIVED THE PANEL: raf id after closeTab()=${rn.closedRaf}, ` +
          `cancelAnimationFrame(${rn.mountedRaf}) called=${rn.cancelledOnClose} -- ` +
          'a loop left running would keep draining HP and writing saves off-screen');
    check(!rn.switchedRaf && rn.cancelledOnSwitch,
          "switching to another Arcade game also cancels the runner's loop",
          `THE LOOP OUTLIVED THE GAME SWITCH: raf id=${rn.switchedRaf}, ` +
          `cancelled=${rn.cancelledOnSwitch}`);

    /* The production tick fires every second and, whenever it grants any
       resources, rebuilds whichever tab is open -- already special-cased once
       for the alliance tab's live text inputs (2026-09-03(d)). Forest Runner
       hit the same class of bug on 2026-09-11: with the Arcade tab open on
       'runner', the tick's rebuild replaced #rnGame's DOM and
       wireProfileRows() -> wireArcadeRows() -> runnerWire() then called
       runnerInit() again -- discarding the run in progress every tick it
       fired, reported as the game "restarting every 2 seconds". Let one real
       tick fire (this drives the actual setInterval, not a stand-in) and
       prove runnerInit isn't called again while the tab just sits open. */
    const rnTick = await page.evaluate(() => new Promise(resolve => {
      openTab('arcade'); openArcadeGame('runner');
      let calls = 0;
      const origInit = window.runnerInit;
      window.runnerInit = function(...args){ calls++; return origInit.apply(this, args); };
      /* the tick returns immediately unless gameActive, which is only ever
         true after entering a camp from the home screen -- force it so the
         real setInterval actually reaches the rebuild line being tested */
      const wasActive = gameActive;
      gameActive = true;
      lastProdTick = Date.now() - 5 * 60000; // guarantee grantProduction() has minutes banked
      setTimeout(() => {
        window.runnerInit = origInit;
        gameActive = wasActive;
        closeTab();
        resolve({ calls });
      }, 1300);
    }));
    check(rnTick.calls === 0,
          'Forest Runner: the production tick does not reinitialise a game already open',
          `THE PRODUCTION TICK RESTARTED FOREST RUNNER -- runnerInit() was called ${rnTick.calls} more ` +
          'time(s) by a single 1s tick. This is the "restarts every couple of seconds" bug: HP, gear, ' +
          'position and the current encounter all wiped.');

    /* A short, wide window (1280x720) should still be landscape mode -- both
       axes matter, per the 2026-09-02(c)/2026-09-09(b) lesson that a check
       at only one viewport size is a check of that viewport. Height-bound
       here instead of width-bound: the panel must shrink to fit under 720px
       tall rather than overflowing the tab body it's fit to. */
    await page.setViewportSize({ width: 1280, height: 720 });
    const runnerShort = await page.evaluate(() => {
      openTab('arcade'); openArcadeGame('runner');
      const el = document.getElementById('rnGame');
      const hud = document.getElementById('rnHud');
      const tb = document.getElementById('tabBody').getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const out = { w: r.width, h: r.height, ratio: r.width / r.height,
                    hudOverflow: hud.scrollWidth - hud.clientWidth,
                    fitsH: r.height <= tb.height + 1 };
      closeTab();
      return out;
    });
    await page.setViewportSize({ width: 900, height: 1000 });
    check(runnerShort.w > 420 && Math.abs(runnerShort.ratio - 16 / 9) < 0.02,
          'Forest Runner: a short, wide desktop window still gets the landscape panel',
          `FOREST RUNNER SHORT-WINDOW SHAPE WRONG -- at 1280x720 it measured ` +
          `${runnerShort.w.toFixed(0)}x${runnerShort.h.toFixed(0)} (ratio ` +
          `${runnerShort.ratio.toFixed(3)} instead of ${(16 / 9).toFixed(3)})`);
    check(runnerShort.fitsH,
          "Forest Runner: the landscape panel doesn't overflow a short tab body",
          'FOREST RUNNER PANEL TALLER THAN ITS OWN TAB BODY on a short window');
    check(runnerShort.hudOverflow <= 1,
          'Forest Runner: the HUD row (stats/pause/Inventory) fits the panel it was just fit to',
          `FOREST RUNNER HUD OVERFLOWS ITS OWN PANEL by ${runnerShort.hudOverflow}px -- the panel was ` +
          "sized narrower than the HUD row it has to hold");

    /* And a phone held upright must NOT go wide -- the "go wide" fix is
       specifically for a landscape (PC/tablet) tab body; a portrait one
       (a phone) keeps the 9:16 panel already confirmed good on Joshua's
       iPhone. Without this check, a bug that made rnFit() always pick the
       landscape branch would pass every check above and break the phone. */
    await page.setViewportSize({ width: 390, height: 844 });
    const runnerPhone = await page.evaluate(() => {
      openTab('arcade'); openArcadeGame('runner');
      const el = document.getElementById('rnGame');
      const hud = document.getElementById('rnHud');
      const tb = document.getElementById('tabBody').getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const out = { w: r.width, ratio: r.width / r.height,
                    overW: Math.round(r.right - window.innerWidth),
                    overH: Math.round(r.height - tb.height),
                    narrowHud: el.classList.contains('rnNarrowHud') };
      closeTab();
      return out;
    });
    await page.setViewportSize({ width: 900, height: 1000 });
    check(runnerPhone.w > 0 && runnerPhone.w <= 420 && Math.abs(runnerPhone.ratio - 9 / 16) < 0.02,
          'Forest Runner: a phone held upright still gets the proven portrait panel',
          `FOREST RUNNER WENT WIDE ON A PHONE -- at 390x844 (portrait) it measured ` +
          `${runnerPhone.w.toFixed(0)}px wide, ratio ${runnerPhone.ratio.toFixed(3)} ` +
          `instead of ${(9 / 16).toFixed(3)})`);
    /* "<= 420px and 9:16" is NOT the same claim as "fits the phone", and the
       difference is the bug Joshua reported on 2026-09-20: rnFit() used the HUD
       row's own unconstrained width as a floor with no ceiling, so a 390px phone
       got a 420x747 panel inside a 390x694 tab body -- passing the check above
       while the game was cropped and scrolling, which reads as "zoomed in".
       Measure against the screen, not against a constant. */
    check(runnerPhone.overW <= 1 && runnerPhone.overH <= 1,
          'Forest Runner: the portrait panel actually fits inside the phone it is on',
          `FOREST RUNNER PANEL OVERFLOWS THE PHONE -- at 390x844 it measured ` +
          `${runnerPhone.w.toFixed(0)}px wide: ${runnerPhone.overW}px past the right edge of the ` +
          `viewport and ${runnerPhone.overH}px taller than its own tab body`);
    /* The other half of that fix: the HUD is what wanted the extra width, so on
       a panel too narrow for it the HUD goes compact (.rnNarrowHud) instead of
       the game box growing past the screen. Asserted as "the right form for the
       panel", not as an overflow measurement -- the HUD flex-shrinks rather than
       overflowing, so scrollWidth never exceeds clientWidth no matter how badly
       the compact rules are broken, and a check that cannot fail is not a check.
       Both halves matter: removing the toggle reddens the phone half, forcing it
       on always reddens the desktop half. */
    check(runnerPhone.narrowHud === true && runnerWide.narrowHud === false,
          'Forest Runner: the HUD takes its compact form on a phone panel and its full form on a wide one',
          'FOREST RUNNER HUD IS IN THE WRONG FORM -- compact on the 390px phone panel: ' +
          `${runnerPhone.narrowHud}, compact on the 1800px desktop panel: ${runnerWide.narrowHud} ` +
          '(wanted true / false)');

    /* Forest Runner's own save step is Object.assign(runnerCamp, save), and it
       runs inside the rAF loop -- which reschedules only on its last line, so a
       throw in there does not lose one save, it freezes the whole game mid-frame.
       normaliseRunnerCamp() used to hand back null for a camp with no `runner`
       block, and since buildSaveObject() only ever stores runnerCamp back, null
       was self-perpetuating: the game died on the first kill or first hit taken,
       about ten seconds in, on every camp (2026-09-20). Reproduced here by doing
       exactly what persist() does, on a camp that has never played. */
    const rnCamp = await page.evaluate(() => {
      const snap = buildSaveObject();
      const st = JSON.parse(JSON.stringify(snap));
      delete st.runner;                       // a camp that has never opened Forest Runner
      applyState(st);
      openTab('arcade'); openArcadeGame('runner');
      const out = { kind: runnerCamp === null ? 'null' : typeof runnerCamp, threw: null };
      try { Object.assign(runnerCamp, { hp: 1 }); } catch (e){ out.threw = e.message; }
      closeTab();
      applyState(snap);                        // put the camp back for later checks
      return out;
    });
    check(rnCamp.kind === 'object' && rnCamp.threw === null,
          "Forest Runner: a camp that has never played it can still save (its loop cannot be thrown out of)",
          `FOREST RUNNER WOULD FREEZE ON ITS FIRST SAVE -- runnerCamp is ${rnCamp.kind}` +
          (rnCamp.threw ? `, and the assignment persist() makes threw: ${rnCamp.threw}` : '') +
          ' -- the throw happens inside the rAF loop, so the game stops rescheduling and locks mid-frame');

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
    /* These two carry the save version as a literal on purpose. Reading
       SAVE_VERSION out of the page instead would make them pass forever without
       anyone thinking about migration -- a check that asks the code what the
       answer is cannot fail. Bumping the number by hand is the point. */
    check(tok.saveV === 10 && tok.saveTokens === 321 &&
          tok.saveArcade && tok.saveArcade.boards.indexOf('cairn') !== -1,
          'tokens and shop purchases are written into the save at v10',
          `save v${tok.saveV} tokens=${tok.saveTokens} arcade=${JSON.stringify(tok.saveArcade)}`);
    check(tok.migV === 10 && tok.migTokens === 0 &&
          Array.isArray(tok.migBoards) && tok.migBoards.length === 0,
          'a v6 camp migrates to v10 with no tokens and nothing bought',
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
      copyTree('runner');
      copyTree('vendor');
      ok(`${SITE_FILES.length} files + ${extra} assets staged for publishing`);
    }
    console.log('\n' + (failed === 0
      ? 'PASS — safe to publish.'
      : `FAIL — ${failed} problem(s). Not publishing.`));
    process.exit(failed === 0 ? 0 : 1);
  }
})();
