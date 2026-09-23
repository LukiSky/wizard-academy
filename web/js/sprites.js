/* The wizard.
 *
 * Nineteen folders of frames became nineteen WebM clips with an alpha channel,
 * one per thing he can do. This plays them so the character reads as one
 * continuous person rather than nineteen separate videos:
 *
 * Every clip is cropped to the same rectangle at build time, so the wizard
 * occupies the same pixels in all of them and a switch does not move him.
 *
 * Two elements, not one. Changing `src` on a single <video> blanks it for a
 * frame or two while the new file is demuxed - a white flash on a dark sky,
 * several times a minute. So clips are decoded into their own elements and the
 * switch is a 140 ms opacity crossfade between two of them, which also softens
 * the pose mismatch when a gesture is interrupted before it returns to rest.
 *
 * One-shots run a measured window, not the whole file. The clips are ten
 * seconds each and the game needs a beat of feedback, not a monologue; the
 * window around each gesture's furthest-from-rest moment is in the manifest.
 *
 * A one-shot always hands back to a hold. `play()` resolves when the beat is
 * over, so the game can await a gesture, but the wizard keeps moving either way
 * - a character frozen on his last frame looks like the page crashed.
 */
const FADE_MS = 140;

export class Wizard {
  constructor(stage, manifest) {
    this.stage = stage;
    this.actions = manifest.actions || {};
    this.hold = 'idle';
    this.layers = [this._layer(), this._layer()];
    this.front = 0;
    this.token = 0;
    this.videos = new Map();
    this.current = null;
  }

  _layer() {
    const v = document.createElement('video');
    v.muted = true;            // autoplay is refused otherwise, even with no audio track
    v.playsInline = true;
    v.preload = 'auto';
    v.className = 'wizard-layer';
    this.stage.appendChild(v);
    return v;
  }

  /* Fetch every clip once, up front. Nineteen files is a few seconds on a
   * local server and nothing afterwards; fetching a 1 MB clip at the moment
   * the wizard needs to react would put a visible hole in the reaction. */
  async preload(onProgress) {
    const names = Object.keys(this.actions);
    let done = 0;
    await Promise.all(names.map(async (name) => {
      const url = 'assets/' + this.actions[name].file;
      try {
        const blob = await (await fetch(url)).blob();
        this.videos.set(name, URL.createObjectURL(blob));
      } catch {
        this.videos.set(name, url);            // let the <video> retry it itself
      }
      onProgress?.(++done, names.length, name);
    }));
  }

  has(name) { return !!this.actions[name]; }

  /* Play one action. Loops become the new resting pose; one-shots play their
   * window and return to it. Resolves when the beat ends. */
  play(name, { hold = null } = {}) {
    const meta = this.actions[name];
    if (!meta) return Promise.resolve();
    const mine = ++this.token;
    if (meta.loop) this.hold = name;
    else if (hold) this.hold = hold;

    const back = this.layers[1 - this.front];
    const src = this.videos.get(name) || ('assets/' + meta.file);
    if (back.dataset.clip !== name) {
      back.src = src;
      back.dataset.clip = name;
    }
    back.loop = !!meta.loop;
    back.currentTime = meta.loop ? 0 : (meta.in || 0);
    const p = back.play();
    if (p) p.catch(() => {});                  // a blocked autoplay is not fatal

    this._swap();
    this.current = name;

    if (meta.loop) return Promise.resolve();

    const out = meta.out ?? meta.seconds;
    return new Promise((resolve) => {
      const tick = () => {
        if (mine !== this.token) return resolve();   // something else took over
        if (back.currentTime >= out - 0.02 || back.ended) {
          back.removeEventListener('timeupdate', tick);
          if (mine === this.token) this.play(this.hold);
          return resolve();
        }
      };
      back.addEventListener('timeupdate', tick);
      // timeupdate fires every ~250 ms, which is coarse enough to overshoot a
      // 3.4 s window by a noticeable amount, so a timer closes it precisely.
      setTimeout(tick, Math.max(0, (out - back.currentTime) * 1000));
    });
  }

  /* Bring the back layer forward and let the old one keep playing through the
   * fade - a clip that stops dead mid-crossfade reads as a stutter. */
  _swap() {
    const front = this.layers[this.front];
    const back = this.layers[1 - this.front];
    back.style.opacity = '1';
    front.style.opacity = '0';
    this.front = 1 - this.front;
    setTimeout(() => {
      if (this.layers[this.front] !== front) front.pause();
    }, FADE_MS + 40);
  }

  /* Interrupt whatever is running and settle on a resting pose. */
  rest(name = this.hold) {
    this.token++;
    return this.play(name);
  }
}
