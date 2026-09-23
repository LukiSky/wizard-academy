/* Boot: load the clips, wait for a click, start the game.
 *
 * The click is not decoration. Browsers refuse to play audio or an autoplaying
 * video until the page has been interacted with, and both refusals are silent -
 * the wizard would simply stand still and say nothing, which looks like a bug
 * in the game rather than a policy in the browser. So nothing starts until the
 * Begin button is pressed, and that press is also what unlocks the audio
 * element for the rest of the session.
 *
 * The status line under the button reports what is actually wired up - n8n,
 * Pocket TTS, the camera - because at a demo the first question is always which
 * of the three is live, and the honest answer is worth more than a page that
 * pretends all three always are.
 */
import { Game } from './game.js';
import { UI } from './ui.js';

const $ = (s) => document.querySelector(s);

async function main() {
  const ui = new UI();
  const loading = $('#loading');

  let manifest;
  try {
    manifest = await (await fetch('assets/manifest.json')).json();
  } catch {
    loading.textContent = 'No assets found. Run: python3 build_assets.py';
    return;
  }

  const game = new Game({ stage: $('#stage'), ui, manifest });
  window.game = game;                       // handy from the console during a demo

  await game.boot((done, total, name) => {
    loading.textContent = `Loading the wizard… ${done}/${total} (${name})`;
  });
  // Count the alphabet actually in play, not whichever one is listed first.
  const signs = Object.keys(manifest.signs?.[game.alphabet] || {}).length;
  loading.textContent = `${Object.keys(manifest.actions).length} animations, `
    + `${signs} ${game.alphabet === 'auslan' ? 'Auslan' : 'ASL'} handshapes ready.`;

  // The keyboard legend comes from the mock itself, so it cannot drift.
  $('#help').replaceChildren(...game.helpKeys.map(([k, what]) => {
    const li = document.createElement('li');
    li.innerHTML = `<kbd>${k}</kbd><span>${what}</span>`;
    return li;
  }));

  addEventListener('keydown', (e) => {
    if (e.key === '0' && !/^(INPUT|TEXTAREA)$/.test(e.target?.tagName)) {
      game.selfView?.cycle();
    }
  });

  await reportWiring(ui, game);

  const begin = $('#begin');
  begin.disabled = false;
  begin.onclick = async () => {
    $('#gate').hidden = true;
    // One silent play inside the click handler is what actually lifts the
    // autoplay block; without it the first real line is swallowed.
    game.voice.el.play().catch(() => {});
    game.voice.el.pause();
    await game.start();
    $('#gate').hidden = false;
    $('#loading').textContent = 'Thanks for visiting the academy.';
  };
}

async function reportWiring(ui, game) {
  let cfg = {};
  try { cfg = await (await fetch('/api/config')).json(); } catch { /* server-less */ }

  const bits = [];
  bits.push(cfg.n8n ? 'n8n webhook connected'
                    : 'n8n not set — the wizard uses the local script');
  const v = cfg.voice?.state;
  bits.push(v === 'ready' ? 'Pocket TTS ready'
          : v === 'loading' ? 'Pocket TTS still loading — the browser voice covers the start'
          : 'Pocket TTS off — using the browser voice');
  ui.status(bits.join(' · '), cfg.n8n && v === 'ready' ? '' : 'warn');

  // The camera can connect at any point, so this keeps watching rather than
  // taking one reading at startup.
  setInterval(() => {
    const live = game.tele.live;
    const el = document.querySelector('#gate');
    if (!el || el.hidden) return;
    ui.status(bits.join(' · ') + ' · '
      + (live ? 'camera live' : 'no camera — play with the keyboard'),
      cfg.n8n && v === 'ready' && live ? '' : 'warn');
  }, 1500);
}

main();
