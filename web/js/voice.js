/* The wizard's voice: Pocket TTS through the server, the browser if it cannot.
 *
 * Lines are queued, never mixed. Two wizards talking over each other is the
 * fastest way to make a character stop reading as a character, and the game
 * legitimately produces overlapping speech - a child can get a letter right
 * while the wizard is still saying "not quite" about the last one. The queue
 * has a depth of one on purpose: if a line arrives while another is waiting,
 * the *waiting* one is dropped rather than the new one, because the newer line
 * is about what just happened and the older one is already stale.
 *
 * `speak()` resolves when the audio finishes, so the game can wait for the
 * wizard to stop talking before it starts listening - otherwise his own voice
 * is still playing while the child is being timed on their answer.
 *
 * Pocket TTS runs on the CPU and a cold line takes a second or two. The server
 * pre-renders the fixed lines and caches everything it generates, so that cost
 * is paid once per line ever rather than once per line spoken. Anything still
 * uncached falls through to the browser's own synthesiser rather than making
 * the game wait, which sounds worse but never sounds late.
 */
const COLD_MS = 1500;         // how long to wait when the line is needed NOW
const WARM_MS = 30000;        // ...and when it is being rendered ahead of time

export class Voice {
  constructor({ enabled = true } = {}) {
    this.enabled = enabled;
    this.el = new Audio();
    this.queued = null;
    this.speaking = false;
    this.mode = 'unknown';    // 'pocket' | 'browser' | 'silent'
    this.onLine = null;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.stop();
  }

  stop() {
    this.queued = null;
    this.el.pause();
    this.el.currentTime = 0;
    speechSynthesis?.cancel();
    this.speaking = false;
  }

  /* Render a line's audio ahead of time and leave it in the server's cache.
   *
   * Pocket TTS is the second half of the same latency problem n8n is the first
   * half of: a cold line takes a second or two to generate. Since the words now
   * arrive well before they are spoken, the audio can be made in that same gap
   * - and by the time the wizard opens his mouth both halves are already done.
   *
   * Fire and forget. A failure here costs nothing: the line is simply generated
   * on demand later, exactly as it would have been. */
  warm(text) {
    if (!text || !this.enabled) return;
    this._fetchAudio(text, WARM_MS).catch(() => {});
  }

  /** Say one line. Resolves when it has finished (or immediately if muted). */
  async speak(text) {
    if (!text) return;
    this.onLine?.(text);
    if (!this.enabled) return;

    if (this.speaking) {
      this.queued = text;                 // the newest line wins, see above
      return;
    }
    this.speaking = true;
    try {
      await this._say(text);
    } finally {
      this.speaking = false;
      const next = this.queued;
      this.queued = null;
      if (next) await this.speak(next);
    }
  }

  async _say(text) {
    const url = await this._fetchAudio(text);
    if (url) {
      this.mode = 'pocket';
      return this._playFile(url);
    }
    return this._browser(text);
  }

  async _fetchAudio(text, timeoutMs = COLD_MS) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch('/api/say', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) return null;
      const data = await r.json();
      return data.ok ? data.url : null;
    } catch {
      // Aborted, offline, or the model is still loading. The line still gets
      // said - and the server caches it, so the next time it is instant.
      return null;
    }
  }

  _playFile(url) {
    return new Promise((resolve) => {
      const done = () => {
        this.el.removeEventListener('ended', done);
        this.el.removeEventListener('error', done);
        resolve();
      };
      this.el.addEventListener('ended', done);
      this.el.addEventListener('error', done);
      this.el.src = url;
      this.el.play().catch(done);      // autoplay blocked until the first click
    });
  }

  _browser(text) {
    if (!('speechSynthesis' in window)) { this.mode = 'silent'; return; }
    this.mode = 'browser';
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.95;
      u.pitch = 1.15;                  // a shade brighter, for a young wizard
      u.onend = u.onerror = resolve;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      // Chrome silently drops utterances when the tab is backgrounded and the
      // callbacks then never fire, which would hang the turn that awaits them.
      setTimeout(resolve, 1200 + text.length * 70);
    });
  }
}
