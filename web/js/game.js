/* The seven states, in order, and the clock that drives them.
 *
 * Greeting -> WordSelection -> TeachSigns -> ActiveListening -> (Help/Idle)
 * -> MagicFinale -> Report.
 *
 * Only ActiveListening is really a loop; the rest are a line of dialogue and a
 * gesture. So the shape here is a plain async sequence for the run of the game,
 * with one ticking loop inside the listening state, rather than a state table.
 * A table would make the greeting and the finale look like the interesting part
 * and they are not - the interesting part is the ten lines of `_listen()`.
 *
 * Two clocks, and they are separate for a reason the spec gives directly.
 * `elapsed` drives the help and idle prompts and *stops while the child is
 * looking away*, because ten seconds of not answering means something quite
 * different from ten seconds of not being there. `awayFor` is the one that runs
 * during that, and it drives the call-back.
 *
 * Everything the wizard says goes out to n8n and comes back as a line; every
 * line has a sprite attached. The game never writes dialogue itself - the local
 * script in `fallback.py` is the stand-in, and it lives on the server so that
 * both sources of words are in one place.
 */
import { Wizard } from './sprites.js';
import { Telemetry, keyboardMock } from './telemetry.js';
import { decide, Latch, handsFor, ALPHABETS, HELP_GESTURE,
         ATTENTION_GRACE_S, IDLE_AFTER_S } from './rules.js';
import { Voice } from './voice.js';
import { WizardVoiceover } from './n8n.js';
import { SelfView } from './selfview.js';

/* Short and concrete, and filtered at run time against the alphabet actually
 * loaded - `spellable()` below drops any word using a letter that alphabet has
 * no tile for. That matters because the two alphabets are missing different
 * letters: ASL has no J or Z as *shapes* (both are movements a single frame of
 * a held hand cannot be), and Auslan omits J for the same reason but does have
 * Z. Rather than keep two lists in step, the list is filtered by the tiles. */
const WORDS = ['CAT', 'DOG', 'SUN', 'HAT', 'BAT', 'STAR', 'MOON', 'FROG',
               'BOOK', 'FISH', 'BIRD', 'TREE', 'CAKE', 'MILK', 'DUCK',
               'ZOO', 'JAM', 'BUZZ'];

/* A movement, not a shape - excluded whatever the chart happens to contain. */
const MOVEMENTS = { asl: new Set('JZ'), auslan: new Set('J') };

const TEACH_MS = 5000;          // spec: hide each sign after 5 seconds
const REPEAT_HAND_COUNT_MS = 8000;
const REPEAT_CALLBACK_MS = 6000;
const HINT_SHOW_MS = 3000;      // spec: show the hand sign image for 3 seconds

/* How often the wizard may remark on something that is not the letter. These
 * reactions are what make him feel present - a thumbs up answered, a smile
 * noticed, hands finally coming up - and they are exactly the thing that
 * becomes unbearable if it fires every time the condition holds. One every
 * twelve seconds, and never while he is already speaking. */
const REACT_EVERY_MS = 12000;
const STREAK_AT = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Game {
  constructor({ stage, ui, manifest, alphabet = 'auslan' }) {
    this.ui = ui;
    this.manifest = manifest;
    this.alphabet = manifest.signs?.[alphabet] ? alphabet : 'asl';
    this.signs = manifest.signs?.[this.alphabet] || {};
    this.words = spellable(WORDS, this.signs, this.alphabet);

    this.session = Math.random().toString(36).slice(2, 10);
    this.wizard = new Wizard(stage, manifest);
    this.tele = new Telemetry();
    this.voice = new Voice();
    this.lines = new WizardVoiceover({
      session: this.session,
      onTurn: (t) => this.ui.logTurn(t),
      // As soon as a line's text exists, render its audio too. Both halves of
      // the latency then happen during the same idle stretch.
      onLine: (text) => this.voice.warm(text),
    });

    this.state = 'boot';
    this.running = false;
    this.word = '';
    this.index = 0;
    this.record = [];            // one entry per letter, for the report
    this.startedAt = 0;
    this.needHands = ALPHABETS[this.alphabet].hands;
    this.tele.expectHands = this.needHands;
    this.lastReact = -1e9;
    this.lastHandsDown = 0;
    this.streak = 0;
    this.toldAboutHelp = false;
  }

  async boot(onProgress) {
    await this.wizard.preload(onProgress);
    this.tele.connect();
    this.helpKeys = keyboardMock(this.tele, (k) => this.ui.flashKey(k));
    this.tele.on((t) => {
      this.ui.showTelemetry(t, this.tele, this.needHands);
      this.ui.showMismatch(t.readerAlphabet, this.alphabet);
    });

    // The recogniser can be started or stopped at any point, so the self-view
    // re-picks its source rather than deciding once at boot.
    this.selfView = new SelfView(document.querySelector('#selfview'));
    const pickSource = async () => {
      let live = false;
      try { live = (await (await fetch('/api/config')).json()).camera?.live; } catch {}
      await this.selfView.attach({ mirrorLive: !!live });
    };
    pickSource();
    setInterval(pickSource, 4000);
    this.ui.showTelemetry(this.tele.state, this.tele, this.needHands);
    this.voice.onLine = (text) => this.ui.caption(text);
    // The greeting is spoken about two seconds after Begin is pressed, and the
    // webhook takes longer than that, so it starts now - during the click.
    this.lines.prefetch('greeting', {});
    await this.wizard.play('idle');
  }

  /* ---------------------------------------------------------------- turns */
  /* Ask n8n for a line, say it, and play the sprite it chose. The sprite is
   * started before the audio is awaited so the gesture and the voice run
   * together; a wizard who gestures and then speaks looks dubbed. */
  async turn(name, payload = {}, { fallbackAction = null, wait = true } = {}) {
    const data = await this.lines.ask(name, {
      word: this.word, alphabet: this.alphabet, ...payload,
    });
    const action = this.wizard.has(data.action) ? data.action : fallbackAction;
    this.ui.caption(data.caption);
    this.lines.remember(data.say);
    const gesture = action ? this.wizard.play(action) : Promise.resolve();
    const spoken = this.voice.speak(data.say);
    if (wait) await Promise.all([gesture, spoken]);
    return data;
  }

  /* ------------------------------------------------------------ 1..7 */
  async start() {
    this.running = true;
    this.record = [];
    this.startedAt = performance.now();
    await this.greeting();
    while (this.running) {
      await this.wordSelection();
      await this.teachSigns();
      const done = await this.activeListening();
      if (!this.running) return;
      if (done) {
        await this.magicFinale();
        const again = await this.report();
        if (!again) return;
      }
    }
  }

  /* 1_Greeting - the wizard appears and waves. */
  async greeting() {
    this.setState('1_Greeting');
    await this.wizard.play('hello', { hold: 'idle' });
    await this.turn('greeting', {}, { fallbackAction: 'hello' });
  }

  /* 2_WordSelection - a word is chosen and the wand gathers the magic. */
  async wordSelection() {
    this.setState('2_WordSelection');
    this.word = this.words[Math.floor(Math.random() * this.words.length)];
    this.index = 0;
    this.record = [];
    this.ui.showWord(this.word, -1);

    // The next thirty seconds of dialogue are all decided by the word, and the
    // wizard is about to spend five seconds per letter demonstrating it. Start
    // the lot now; every one of them lands long before it is wanted.
    this.lines.clear();
    this.lines.prefetch('word', { word: this.word });
    for (let i = 0; i < this.word.length; i++) {
      this.lines.prefetch('teach', { word: this.word, letter: this.word[i], index: i });
    }
    this.lines.prefetch('prompt', { word: this.word, letter: this.word[0] });

    await this.turn('word', {}, { fallbackAction: 'magic' });
  }

  /* 3_TeachSigns - each letter demonstrated, five seconds apiece. */
  async teachSigns() {
    this.setState('3_TeachSigns');
    for (let i = 0; i < this.word.length && this.running; i++) {
      const letter = this.word[i];
      this.ui.showWord(this.word, i);
      this.ui.showSpell(this.state, i, this.word.length);
      this.ui.showSign(letter, this.signs[letter]);
      this.turn('teach', { letter, index: i }, { fallbackAction: 'teach', wait: false });
      await sleep(TEACH_MS);
    }
    this.ui.hideSign();
    this.ui.showWord(this.word, -1);
  }

  /* 4_ActiveListening - the loop the rules actually run in.
   * Resolves true when the whole word has been spelled. */
  async activeListening() {
    this.setState('4_ActiveListening');
    await this.turn('prompt', {
      letter: this.word[this.index],
      // Said on the first word only. A child needs telling once; being told
      // every word turns the offer into nagging.
      mention_help: !this.toldAboutHelp,
    }, { fallbackAction: 'listening' });
    this.toldAboutHelp = true;
    this.wizard.play('listening');

    while (this.running && this.index < this.word.length) {
      const ok = await this._listen(this.word[this.index], this.index);
      if (!this.running) return false;
      if (ok) this.index++;
    }
    return this.index >= this.word.length;
  }

  /* Things the child does that are not the letter.
   *
   * The recogniser reports seven channels and the rules read five; the other
   * two - gestures, and the finer expression work - were being displayed and
   * then ignored, which is the worst of both. A child who gives the wizard a
   * thumbs up and gets nothing back has learned he is not really watching.
   *
   * These are interjections rather than turns: short, rate-limited, and they
   * never interrupt. The caller only consults this while the verdict is
   * 'wait', so a reaction can land only in a gap where the wizard would
   * otherwise have been silent.
   *
   * Returns {turn, payload} to fire, or null. */
  _reaction(t, prev, now) {
    if (now - this.lastReact < REACT_EVERY_MS) return null;

    // A gesture is deliberate in a way an expression is not - the child made a
    // shape *at* the wizard - so it outranks the rest.
    // Victory is spoken for - it is a request for help, handled by the rules
    // before this is ever consulted, and remarking on it would be the wizard
    // admiring the question instead of answering it.
    if (t.gesture && t.gesture !== prev.gesture && t.gestureConf > 0.6
        && t.gesture !== HELP_GESTURE) {
      return { turn: 'gesture', payload: { gesture: t.gesture } };
    }
    // A head shake used to bring up the spell book here, which directly
    // contradicts what it means everywhere else in the game - the child is
    // saying no, and being handed help for it is the wizard not listening.
    // Declining is now handled where the question is actually asked, so a
    // shake out of the blue is left alone.
    // Happiness mid-word, which the design only ever checks at the finale.
    if (t.expression === 'happy' && prev.expression !== 'happy') {
      return { turn: 'got_happy', payload: {} };
    }
    // Hands arriving after a stretch of nothing - the first evidence a child
    // gets that the camera can see them at all.
    if (t.hands > 0 && prev.hands === 0 && now - this.lastHandsDown > 4000) {
      return { turn: 'hands_up', payload: { hands: t.hands } };
    }
    return null;
  }

  /* One letter. Returns true once it is signed correctly. */
  async _listen(target, index) {
    const latch = new Latch();
    const entry = { letter: target, attempts: 0, hinted: false, misread: [] };
    this.record[index] = entry;
    this.ui.showWord(this.word, index, this.index);
    this.needHands = handsFor(target, this.alphabet);
    this.tele.expectHands = this.needHands;
    this.ui.setTarget(target, this.needHands, this.alphabet);

    // Only two things can happen to this letter, and the child is about to
    // spend several seconds deciding which. Fetch both answers meanwhile.
    const last = index === this.word.length - 1;
    this.lines.prefetch('right', {
      word: this.word, letter: target, index: index + 1, attempts: 1,
      spelled: this.word.slice(0, index + 1), last,
    }, { priority: true });
    this.lines.prefetch('wrong', {
      word: this.word, letter: target, index, attempts: 1,
    }, { priority: true });
    // `hint_offer` is deliberately not prefetched. Most letters never need one,
    // and fetching it for every letter spent four calls a word out of a budget
    // of about fifteen a minute - on a line that, when it is finally wanted,
    // the child has already waited ten seconds for anyway.
    if (last) this.lines.prefetch('finale', { word: this.word });

    let elapsed = 0, awayFor = 0, hintOffered = false, busy = false;
    let lastHandCount = -1e9, lastCallBack = -1e9, lastTick = performance.now();
    let prev = { ...this.tele.state };
    let handsWrongFor = 0;

    return new Promise((resolve) => {
      const finish = (ok) => { clearInterval(this.timer); this.timer = null; resolve(ok); };

      this.timer = setInterval(async () => {
        if (!this.running) return finish(false);
        const now = performance.now();
        const dt = (now - lastTick) / 1000;
        lastTick = now;
        const t = this.tele.state;

        // The two clocks. `elapsed` is the answering clock and stops while the
        // child is not looking; `awayFor` is the one that runs instead.
        if (t.gaze === false) awayFor += dt;
        else { awayFor = 0; elapsed += dt; }
        this.ui.showClock(elapsed, awayFor);

        // How long the hand count has been wrong, so a tracker losing a hand
        // for a third of a second is not reported as the child putting one
        // down. Reset the instant it is right again.
        handsWrongFor = t.hands === handsFor(target, this.alphabet)
          ? 0 : handsWrongFor + dt;
        if (t.hands === 0) this.lastHandsDown = now;
        if (busy) { prev = { ...t }; return; }   // the wizard is mid-sentence
        const v = decide(t, { target, alphabet: this.alphabet, elapsed, awayFor,
                              handsWrongFor, attempts: entry.attempts,
                              hintOffered });
        this.ui.showVerdict(v);

        switch (v.do) {
          case 'look_back': {
            if (now - lastCallBack < REPEAT_CALLBACK_MS) return;
            lastCallBack = now;
            busy = true;
            await this.turn('look_back', { letter: target },
                            { fallbackAction: 'call_back' });
            this.wizard.play('listening');
            busy = false;
            return;
          }
          case 'too_many_hands':
          case 'too_few_hands': {
            // Said at most once every eight seconds: the condition stays true
            // for as long as the hands are wrong, and a wizard repeating
            // himself every tick is a wizard nobody listens to.
            if (now - lastHandCount < REPEAT_HAND_COUNT_MS) return;
            lastHandCount = now;
            busy = true;
            await this.turn(v.do, {
              letter: target, hands: t.hands, need: v.need,
              alphabet: this.alphabet,
            }, { fallbackAction: 'one_hand' });
            this.wizard.play('listening');
            busy = false;
            return;
          }
          case 'idle_prompt': {
            busy = true;
            elapsed = 0;
            await this.idlePrompt();
            busy = false;
            return;
          }
          case 'offer_hint': {
            hintOffered = true;
            entry.hinted = true;
            busy = true;
            // A child who made the peace sign has already answered the
            // question, so asking it again is just a delay between them asking
            // for help and getting it.
            await this.helpPrompt(target, v.why, v.asked === true);
            this.tele.push({ gesture: null });
            elapsed = 0;
            latch.clear();
            busy = false;
            return;
          }
          case 'correct': {
            if (!latch.fresh(t)) return;
            entry.attempts++;
            busy = true;
            this.ui.markCorrect(index);
            this.ui.showSpell(this.state, index + 1, this.word.length);
            this.streak = entry.attempts <= 1 ? (this.streak || 0) + 1 : 0;
            await this.turn('right', {
              letter: target, index: index + 1, attempts: entry.attempts,
              spelled: this.word.slice(0, index + 1), last,
            }, { fallbackAction: 'correct' });
            // Three clean letters running is the one bit of praise that is
            // about the child rather than the letter. It cannot become
            // repetitive, because a single slip resets the counter.
            if (this.streak === STREAK_AT && !last) {
              await this.turn('streak', { streak: this.streak },
                              { fallbackAction: 'celebrate' });
            }
            return finish(true);
          }
          case 'wrong': {
            if (!latch.fresh(t)) return;
            entry.attempts++;
            entry.misread.push(v.letter);
            busy = true;
            this.ui.markWrong(index, v.letter);
            await this.turn('wrong', {
              letter: target, detected: v.letter, index,
              attempts: entry.attempts, expression: t.expression,
            }, { fallbackAction: 'try_again' });
            // The prompt pitches each attempt differently, so the next miss is
            // a different line. Start it while they try again.
            this.lines.prefetch('wrong', {
              word: this.word, letter: target, index,
              attempts: entry.attempts + 1,
            });
            this.wizard.play('listening');
            busy = false;
            return;
          }
          default: {
            // 'wait' - the child is working, which is the only moment a
            // reaction can land without talking over something that matters.
            const r = this._reaction(t, prev, now);
            prev = { ...t };
            if (!r) return;
            this.lastReact = now;
            busy = true;
            await this.turn(r.turn, { letter: target, ...r.payload },
                            { fallbackAction: 'listening' });
            this.wizard.play('listening');
            busy = false;
            return;
          }
        }
        prev = { ...t };
      }, 120);
    });
  }

  /* 5_Help_And_Idle_Prompts, idle branch. */
  async idlePrompt() {
    this.setState('5_IdlePrompt');
    await this.turn('idle', { letter: this.word[this.index], seconds: IDLE_AFTER_S },
                    { fallbackAction: 'fading' });
    // Spec: when GazeFocus returns, reset the timers and carry on. The wizard
    // waits rather than nagging - if the child has walked off, a second prompt
    // into an empty room helps nobody.
    const cameBack = await this._waitFor(() => this.tele.state.gaze !== false
                                              || this.tele.state.hands > 0, 12000);
    if (!cameBack && this.running) {
      await this.turn('idle', { letter: this.word[this.index], second: true },
                      { fallbackAction: 'worried' });
    }
    this.setState('4_ActiveListening');
    this.wizard.play('listening');
  }

  /* 5_Help_And_Idle_Prompts, help branch. */
  async helpPrompt(letter, why, asked = false) {
    this.setState('5_HelpPrompt');
    let yes = asked;
    if (!asked) {
      await this.turn('hint_offer', { letter, why }, { fallbackAction: 'thinking' });
      // Spec: "if the user nods or clicks yes". Both, plus a thumbs up, because
      // a child who is stuck is not reliably going to find a button - and the
      // point of the face camera is that they should not have to.
      yes = await this.ui.askYesNo({
        nod: () => this.tele.state.nod === 'yes'
                   || this.tele.state.gesture === 'thumbs up',
        shake: () => this.tele.state.nod === 'no',
        timeout: 6000,
      });
    }
    this.tele.push({ nod: null, gesture: null });

    if (yes) {
      this.ui.showSign(letter, this.signs[letter], { hint: true });
      await this.turn('hint_show', { letter }, { fallbackAction: 'teach', wait: false });
      await sleep(HINT_SHOW_MS);
      this.ui.hideSign();
    } else if (this.tele.state.nod === 'no') {
      // Answered, rather than timed out. A child who said no deserves an
      // acknowledgement; a child who said nothing is best left to get on.
      await this.turn('declined', { letter }, { fallbackAction: 'listening' });
    }
    this.setState('4_ActiveListening');
    this.wizard.play('listening');
  }

  /* 6_MagicFinale - the grand spell. */
  async magicFinale() {
    this.setState('6_MagicFinale');
    this.ui.showWord(this.word, -1, this.word.length);
    await this.wizard.play('charge', { hold: 'idle' });
    this.ui.burst(this.word);
    this.lines.prefetch('report', {
      word: this.word,
      letters: this.record.map(({ letter, attempts, hinted, misread }) =>
        ({ letter, attempts, hinted, misread })),
      seconds: Math.round((performance.now() - this.startedAt) / 1000),
    });
    const happy = this.tele.state.expression === 'happy';
    await this.turn('finale', { expression: this.tele.state.expression, happy },
                    { fallbackAction: happy ? 'laugh' : 'celebrate' });
  }

  /* 7_Report - the evaluation, then the offer to play again. */
  async report() {
    this.setState('7_Report');
    const seconds = (performance.now() - this.startedAt) / 1000;
    const data = await this.turn('report', {
      letters: this.record.map(({ letter, attempts, hinted, misread }) =>
        ({ letter, attempts, hinted, misread })),
      seconds: Math.round(seconds),
      expression: this.tele.state.expression,
    }, { fallbackAction: 'celebrate', wait: false });

    this.ui.showReport(data.report || null, this.record, this.word, seconds, this.signs);
    const again = await this.ui.askPlayAgain();
    this.ui.hideReport();
    if (again) {
      this.startedAt = performance.now();
      await this.wizard.play('ready', { hold: 'idle' });
    }
    return again;
  }

  /* ------------------------------------------------------------- plumbing */
  _waitFor(pred, ms) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const id = setInterval(() => {
        if (!this.running || pred()) { clearInterval(id); resolve(true); }
        else if (performance.now() - t0 > ms) { clearInterval(id); resolve(false); }
      }, 150);
    });
  }

  setState(s) {
    this.state = s;
    this.ui.showState(s);
    this.ui.showSpell(s, this.index, this.word.length);
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.voice.stop();
  }
}

/* Keep only the words this alphabet can actually ask for. A word containing a
 * letter with no tile would be taught with a blank card, and one containing a
 * letter that is a movement would be asked for and never awarded. */
function spellable(words, signs, alphabet) {
  const moves = MOVEMENTS[alphabet] || new Set();
  const ok = words.filter((w) =>
    [...w].every((ch) => signs[ch] && !moves.has(ch)));
  return ok.length ? ok : words;      // never leave the game with nothing to ask
}

export { WORDS, spellable, ATTENTION_GRACE_S };
