/* Everything the wizard says comes from here.
 *
 * The game decides *that* something happened - a letter was wrong, the child
 * looked away, the word is finished. n8n decides what the wizard says about it.
 * Keeping that split clean is the whole point: the rules in `rules.js` are
 * timing and geometry and want to be exact, the words want to be warm and
 * varied and rewritten twenty times without touching the game.
 *
 * One request per turn, one line back:
 *
 *   ->  { turn, word, letter, index, attempts, detected, expression, ... }
 *   <-  { say, caption?, action?, hint?, report? }
 *
 * The request goes to this page's own server rather than to n8n directly, so
 * the webhook URL and its token stay out of a page a child's browser can read,
 * and so a missing webhook degrades to the local script instead of a CORS error
 * in the console.
 *
 * ## Why this file is mostly a cache
 *
 * A real workflow takes six to fifteen seconds to answer. That is fine for a
 * chatbot and impossible here: the child is holding a handshape in the air, and
 * a wizard who says "nearly!" eight seconds after they moved on is worse than
 * one who says nothing.
 *
 * But almost nothing the wizard says is a surprise. The moment a word is
 * chosen, every teaching line for it is knowable. The moment a letter starts,
 * there are exactly two things that can happen next - it is right or it is
 * wrong - and the child will spend five to thirty seconds signing before either
 * of them does. That is a great deal of time to be sitting idle.
 *
 * So lines are fetched *before* they are needed and answered from memory when
 * they are. `prefetch()` starts a turn in the background and warms its audio as
 * soon as the text lands; `ask()` takes whatever is ready. Fifteen seconds of
 * latency happens during fifteen seconds the child was going to spend signing
 * anyway, and what they experience is instant.
 *
 * It has a second effect worth the trouble on its own: a webhook that fails is
 * now invisible. The prefetch quietly loses, `ask()` uses the local line, and
 * nobody waits for the failure to happen.
 */

/* A live turn - one nobody saw coming - is not allowed to hold up the game.
 * The local script on the server answers in milliseconds, so this only has to
 * cover a server that is genuinely wedged. */
const LIVE_DEADLINE_MS = 2500;

/* A prefetch has time on its side and should use it: it is running during
 * seconds the child is spending on something else. */
const PREFETCH_DEADLINE_MS = 25000;

/* Hosted model APIs meter by the minute, and the free Gemini tier is about
 * fifteen requests in one. Prefetching every branch of every letter asked for
 * roughly twenty per word, so a single four-letter word exhausted the quota and
 * everything afterwards came back 500 - which looks exactly like a broken
 * prompt from the outside, and is not.
 *
 * So requests are spaced, and a burst is capped. This costs nothing the child
 * can perceive: the prefetches are running during seconds they are spending
 * signing anyway, and a line that arrives four seconds early is as good as one
 * that arrives fifteen seconds early. What it buys is that the quota is still
 * there for the turns that cannot wait. */
const MIN_GAP_MS = 1100;        // a shade under one a second
const BURST = 4;                // ...but a few may go straight out

/* Only reached when the server itself is unreachable - it answers every turn
 * from its own script otherwise, and far better than these do. They exist
 * because silence in the middle of a conversation with a child does not read as
 * a network error, it reads as being ignored. */
const LAST_RESORT = {
  greeting: 'Hello, young apprentice!',
  word: "Here comes today's spell!",
  teach: 'Watch my hand.',
  prompt: "Now it's your turn!",
  right: 'Yes! Well done!',
  wrong: 'Almost - have another go.',
  two_hands: 'Just one hand for this spell!',
  look_back: 'Over here! Eyes on the magic!',
  idle: 'Are you still there?',
  hint_offer: 'Shall I show you the spell book?',
  hint_show: 'Look closely at my fingers!',
  finale: 'You cast the whole spell!',
  report: 'That was fine spellwork. Play again?',
};

/* What makes two turns the same line.
 *
 * `wrong` carries `attempts` because the prompt is explicitly told to pitch it
 * differently each time - encourage, then one correction, then gentle. `right`
 * does not: it is about this letter being correct, and it reads the same on the
 * first attempt as on the fourth. */
function cacheKey(turn, p = {}) {
  const parts = [turn, p.letter ?? '', p.index ?? ''];
  if (turn === 'wrong') parts.push(p.attempts ?? '');
  return parts.join('|');
}

export class WizardVoiceover {
  constructor({ session, onTurn = null, onLine = null } = {}) {
    this.session = session;
    this.onTurn = onTurn;
    this.onLine = onLine;          // called as soon as text lands, to warm audio
    this.source = 'unknown';
    this.pending = new Map();      // key -> Promise<data|null>
    this.recent = [];              // the last few lines actually spoken
    this.stats = { prefetched: 0, hits: 0, misses: 0, live: 0, failed: 0 };
  }

  /* A model asked the same question twice writes the same answer twice, and a
   * child hears four "well done"s a word. Sending what was just said turns
   * "write a line" into "write a line that is not one of these", which is a
   * question with a different answer each time. Six is enough to cover a word
   * without spending the context on it. */
  remember(line) {
    if (!line) return;
    this.recent.push(line);
    if (this.recent.length > 6) this.recent.shift();
  }

  /* Start a turn now so it is ready later. Safe to call twice; the second call
   * joins the first rather than sending a second request.
   *
   * `priority` jumps the queue. A turn the game is about to need beats one it
   * only might need - `wrong` matters more than `hint_offer`, which is fetched
   * for a hint most children never ask for. */
  prefetch(turn, payload = {}, { priority = false } = {}) {
    const key = cacheKey(turn, payload);
    if (this.pending.has(key)) return this.pending.get(key);
    this.stats.prefetched++;
    const p = this._queued(turn, payload, priority).then((data) => {
      // Warm the voice the moment the words exist, so the audio is rendered
      // and cached during the same idle stretch the text was.
      if (data?.say) this.onLine?.(data.say);
      return data;
    });
    this.pending.set(key, p);
    return p;
  }

  /* One turn. Always resolves, always with something sayable. */
  async ask(turn, payload = {}, localFallback) {
    const key = cacheKey(turn, payload);
    const t0 = performance.now();
    let data = null;
    let how;

    if (this.pending.has(key)) {
      const p = this.pending.get(key);
      this.pending.delete(key);
      // A prefetch that has not landed yet still must not block: take the
      // local line now and let the request finish into the void.
      data = await Promise.race([p, deadline(LIVE_DEADLINE_MS)]);
      how = data ? 'hit' : 'miss';
      this.stats[data ? 'hits' : 'misses']++;
      // A prefetch still in flight is not a reason to say something generic.
      // The server's script knows this turn's word and letter and answers in
      // about a millisecond, so ask it directly rather than settling for
      // LAST_RESORT - "Here comes today's spell!" instead of naming the word
      // is a real downgrade, and an avoidable one.
      if (!data) data = await this._fetch(turn, { ...payload, local: true }, 1200);
    } else {
      this.stats.live++;
      data = await this._fetch(turn, payload, LIVE_DEADLINE_MS);
      how = 'live';
    }

    if (!data || typeof data.say !== 'string' || !data.say.trim()) {
      data = localFallback?.() || { say: LAST_RESORT[turn] || 'Let us keep going.' };
      this.source = 'page';
    } else {
      this.source = data._source || 'n8n';
    }
    data.caption = data.caption || data.say;
    this.onTurn?.({ turn, body: payload, data, how,
                    ms: Math.round(performance.now() - t0), source: this.source });
    return data;
  }

  /* Nothing in flight is worth keeping across a word. */
  clear() {
    this.pending.clear();
    this.queue = [];
  }

  /* Space prefetches out so a word does not spend a minute's quota in a
   * second. A live `ask()` never comes through here - by then the child is
   * waiting, and a rate limit is a better problem than a silent wizard. */
  _queued(turn, payload, priority) {
    return new Promise((resolve) => {
      const job = () => resolve(this._fetch(turn, payload, PREFETCH_DEADLINE_MS));
      this.queue = this.queue || [];
      if (priority) this.queue.unshift(job);
      else this.queue.push(job);
      this._drain();
    });
  }

  _drain() {
    if (this.draining || !this.queue?.length) return;
    this.draining = true;
    const step = () => {
      const job = this.queue.shift();
      if (!job) { this.draining = false; return; }
      job();
      // The first few go straight out, so the opening of a word is not slow;
      // after that the gap keeps the whole word inside the quota.
      this.sent = (this.sent || 0) + 1;
      setTimeout(step, this.sent <= BURST ? 0 : MIN_GAP_MS);
    };
    step();
  }

  async _fetch(turn, payload, timeoutMs) {
    const body = { turn, session: this.session, recent: this.recent, ...payload };
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch('/api/wizard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) { this.stats.failed++; return null; }
      return await r.json();
    } catch {
      this.stats.failed++;
      return null;
    }
  }
}

function deadline(ms) {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}
