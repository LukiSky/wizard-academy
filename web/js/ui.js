/* Everything the child sees, and the panel only the developer sees.
 *
 * Two audiences on one screen, and they want opposite things. The child's half
 * is four elements - the word, the wizard, what he said, and the hand to copy -
 * on the principle that a five-year-old reads a screen by looking at the one
 * thing that just moved. The developer's half is the entire telemetry stream
 * and the rule that fired on it, which would be noise to a child and is the
 * only way to tell, during a demo, whether the wizard is silent because the
 * rules are wrong or because the camera lost the hand.
 *
 * So the debug rail is a peer of the scene rather than an overlay on it: it can
 * be switched off for the child and switched on when something needs
 * explaining, and neither layout disturbs the other.
 *
 * The word strip is the one piece of state the child is expected to track, and
 * it carries four: done, current, pending, and just-wrong. Colour alone would
 * not do it - the shapes change too, since a lot of children this age are
 * still learning their letters and a red C and a green C are the same C.
 */
const $ = (sel, root = document) => root.querySelector(sel);

/* The two the help rule fires on - worth colouring, since a child looking
 * stuck is the one reading that changes what happens next. */
const STRESS = new Set(['confused', 'frustrated', 'sad', 'angry']);

export class UI {
  constructor() {
    this.el = {
      word: $('#word'), caption: $('#caption'), state: $('#state'),
      sign: $('#sign'), signImg: $('#sign-img'), signLetter: $('#sign-letter'),
      signLabel: $('#sign-label'), burst: $('#burst'), target: $('#target'),
      rail: $('#rail'), tele: $('#tele'), verdict: $('#verdict'),
      clock: $('#clock'), log: $('#log'), keys: $('#keys'),
      report: $('#report'), reportBody: $('#report-body'),
      yesno: $('#yesno'), status: $('#status'),
      mismatch: $('#mismatch'),
      helpHint: $('#help-hint'),
      spell: $('#spell'), spellFill: $('#spell-fill'),
      spellPhase: $('#spell-phase'), spellCount: $('#spell-count'),
    };
    this.showRail(localStorage.getItem('wa-rail') !== 'off');
    $('#rail-toggle').onclick = () => this.showRail(this.el.rail.hidden);
  }

  showRail(on) {
    this.el.rail.hidden = !on;
    document.body.classList.toggle('with-rail', on);
    localStorage.setItem('wa-rail', on ? 'on' : 'off');
  }

  /* How much of the spell is cast, and what to be doing about it.
   *
   * The word strip already says which letters are done, but it says it in a
   * way that needs reading - four boxes, three green - and the children this is
   * for are the ones still learning to read. A bar that fills is the same
   * information in a form that can be taken in at a glance and from across a
   * room, which is where a parent or a teacher is standing.
   *
   * The phase line is the other half: a child watching the wizard demonstrate
   * and a child expected to sign look at identical screens otherwise, and
   * "am I supposed to be doing something right now" is the question that
   * stalls a first session.
   */
  PHASES = {
    '1_Greeting':        ['Getting ready', null],
    '2_WordSelection':   ['A new spell!', null],
    '3_TeachSigns':      ['Watch the wizard', 'learning'],
    '4_ActiveListening': ['Your turn - sign it!', 'your-turn'],
    '5_HelpPrompt':      ['Need a hand?', 'helping'],
    '5_IdlePrompt':      ['Still there?', 'helping'],
    '6_MagicFinale':     ['Casting the spell!', 'casting'],
    '7_Report':          ['Spell complete', 'casting'],
  };

  /* Shown only while the child is expected to sign. During the demonstration
   * they are watching, not stuck, and an offer of help then is just another
   * thing on the screen competing with the hand they are supposed to copy. */
  showHelpHint(on) {
    this.el.helpHint.hidden = !on;
  }

  showSpell(state, done = 0, total = 0) {
    const [label, mood] = this.PHASES[state] || ['', null];
    this.el.spellPhase.textContent = label;
    this.el.spell.dataset.mood = mood || '';
    this.showHelpHint(state === '4_ActiveListening');
    const pct = total ? Math.round((done / total) * 100) : 0;
    this.el.spellFill.style.width = `${pct}%`;
    this.el.spellFill.dataset.full = pct >= 100 ? 'yes' : 'no';
    this.el.spellCount.textContent = total
      ? (done >= total ? 'spell complete!' : `${done} of ${total} letters`)
      : '';
  }

  /* ------------------------------------------------------------- the word */
  showWord(word, current = -1, done = 0) {
    this.el.word.replaceChildren(...[...word].map((ch, i) => {
      const s = document.createElement('span');
      s.className = 'letter'
        + (i < done ? ' done' : '')
        + (i === current ? ' current' : '')
        + (i >= done && i !== current ? ' pending' : '');
      s.textContent = ch;
      s.dataset.i = i;
      return s;
    }));
  }

  _letterEl(i) { return this.el.word.querySelector(`.letter[data-i="${i}"]`); }

  markCorrect(i) {
    const el = this._letterEl(i);
    if (!el) return;
    el.classList.remove('pending', 'current', 'wrong');
    el.classList.add('done', 'pop');
    setTimeout(() => el.classList.remove('pop'), 600);
  }

  markWrong(i, saw) {
    const el = this._letterEl(i);
    if (!el) return;
    el.classList.add('wrong');
    el.dataset.saw = saw || '';
    setTimeout(() => el.classList.remove('wrong'), 900);
  }

  setTarget(letter, need = 1, alphabet = '') {
    this.el.target.innerHTML = `${letter || '-'}`
      + `<small>${alphabet}${need ? ` · ${need} hand${need > 1 ? 's' : ''}` : ''}</small>`;
  }

  /* ------------------------------------------------------- what he says */
  caption(text) {
    if (!text) return;
    this.el.caption.textContent = text;
    this.el.caption.classList.remove('show');
    void this.el.caption.offsetWidth;             // restart the entrance
    this.el.caption.classList.add('show');
  }

  /* --------------------------------------------------------- the hand */
  showSign(letter, src, { hint = false } = {}) {
    if (!src) return this.hideSign();
    this.el.signImg.src = 'assets/' + src;
    this.el.signLetter.textContent = letter;
    this.el.signLabel.textContent = hint ? 'from the spell book' : 'copy this';
    this.el.sign.classList.toggle('hint', hint);
    this.el.sign.hidden = false;
  }

  hideSign() { this.el.sign.hidden = true; }

  /* ------------------------------------------------------- the finale */
  burst(word) {
    const box = this.el.burst;
    box.replaceChildren();
    box.hidden = false;
    for (let i = 0; i < 64; i++) {
      const p = document.createElement('i');
      const a = Math.random() * Math.PI * 2;
      const d = 120 + Math.random() * 340;
      p.style.setProperty('--x', `${Math.cos(a) * d}px`);
      p.style.setProperty('--y', `${Math.sin(a) * d}px`);
      p.style.setProperty('--t', `${600 + Math.random() * 900}ms`);
      p.style.setProperty('--h', `${38 + Math.random() * 26}`);
      box.appendChild(p);
    }
    const w = document.createElement('strong');
    w.textContent = word;
    box.appendChild(w);
    setTimeout(() => { box.hidden = true; }, 2600);
  }

  /* -------------------------------------------------------- questions */
  /* A yes/no the child can answer four ways: nod for yes, shake for no, click
   * either, or wait.
   *
   * The shake matters as much as the nod. Without it the only way to decline
   * was to sit through the timeout, so a child who did not want help got six
   * seconds of the wizard waiting on them - which reads as being made to
   * explain yourself. Waiting still counts as no, but now it is the fallback
   * rather than the only route. */
  askYesNo({ nod, shake, timeout = 6000 }) {
    return new Promise((resolve) => {
      const box = this.el.yesno;
      box.hidden = false;
      let done = false;
      const end = (v) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timer);
        box.hidden = true;
        box.onclick = null;
        resolve(v);
      };
      box.onclick = (e) => {
        const b = e.target.closest('button');
        if (b) end(b.dataset.v === 'yes');
      };
      const poll = setInterval(() => {
        if (nod?.()) end(true);
        else if (shake?.()) end(false);
      }, 120);
      const timer = setTimeout(() => end(false), timeout);
    });
  }

  askPlayAgain() {
    return new Promise((resolve) => {
      const b = $('#again');
      const s = $('#stop');
      b.onclick = () => resolve(true);
      s.onclick = () => resolve(false);
    });
  }

  /* ----------------------------------------------------- the report card */
  showReport(report, record, word, seconds, signs) {
    const r = report || {};
    const stars = Math.max(1, Math.min(3, r.stars || 1));
    const rows = record.filter(Boolean).map((e) => {
      const tries = e.attempts || 1;
      const tag = tries <= 1 ? 'clean' : tries <= 2 ? 'ok' : 'work';
      const img = signs?.[e.letter]
        ? `<img src="assets/${signs[e.letter]}" alt="">` : '';
      const saw = e.misread?.length
        ? `<span class="saw">read as ${[...new Set(e.misread)].join(', ')}</span>` : '';
      return `<li class="${tag}">${img}
        <b>${e.letter}</b>
        <span class="tries">${tries} ${tries === 1 ? 'try' : 'tries'}</span>
        ${e.hinted ? '<span class="saw">used the spell book</span>' : ''}${saw}</li>`;
    }).join('');

    const list = (items) => (items || []).map((s) => `<li>${esc(s)}</li>`).join('');
    this.el.reportBody.innerHTML = `
      <div class="rating">${'★'.repeat(stars)}<span>${'★'.repeat(3 - stars)}</span></div>
      <h2>${esc(r.headline || 'Spell complete!')}</h2>
      <p class="spelled">${[...word].join(' ')}</p>
      <ul class="letters">${rows}</ul>
      <div class="cols">
        <section><h3>What went well</h3><ul>${list(r.strengths)}</ul></section>
        <section><h3>Worth practising</h3><ul>${list(r.practice)}</ul></section>
      </div>
      <p class="grown-ups"><b>For grown-ups:</b> ${esc(r.note_for_grownups
        || `${record.filter((e) => (e?.attempts || 1) <= 1).length} of ${record.length}`
           + ` letters on the first try, in ${Math.round(seconds)} seconds.`)}</p>`;
    this.el.report.hidden = false;
  }

  hideReport() { this.el.report.hidden = true; }

  /* ------------------------------------------------------- the debug rail */
  /* The one misconfiguration that looks exactly like the game being broken.
   *
   * An ASL "A" and an Auslan "A" are different handshapes with the same name,
   * so if the reader and the game disagree about the alphabet every letter is
   * simply wrong, with nothing on screen to say why. This is worth a banner
   * rather than a log line - it costs half an hour to find otherwise. */
  showMismatch(reader, game) {
    const el = this.el.mismatch;
    if (!reader || reader === game) { el.hidden = true; return; }
    el.innerHTML = `The camera is reading <b>${esc(reader)}</b> but the game is `
      + `asking for <b>${esc(game)}</b>. Restart the recogniser with `
      + `<code>--alphabet ${esc(game)} --hands ${game === 'auslan' ? 2 : 1}</code>.`;
    el.hidden = false;
  }

  showState(s) {
    this.el.state.textContent = s.replace(/^\d+_/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
    this.el.state.dataset.state = s;
  }

  /* All seven channels the recogniser reports, not just the five the rules use.
   *
   * A child signing at a camera has no way to tell whether the machine has lost
   * their left hand, read their face as cross, or quietly decided they are not
   * looking at the screen - and neither does anyone watching them. Every one of
   * those shows up here as a wrong answer with no visible cause, so the panel
   * shows the lot: what it read, how sure it is, and what it thinks the rest of
   * the body is doing. */
  showTelemetry(t, tele, need = 1) {
    const pct = (v) => `${Math.round((v || 0) * 100)}%`;
    const conf = (v) => v ? `<small>${pct(v)}</small>` : '';
    const dot = (on, cls = '') => `<i class="dot ${on ? 'on' : 'off'} ${cls}"></i>`;
    const chips = (xs) => (xs || []).length
      ? `<p class="chips">${xs.map((x) => `<span>${esc(x)}</span>`).join('')}</p>` : '';

    const handRow = (h, i) => {
      const side = i === 0 ? 'left' : 'right';
      if (!h?.present) return `<dt>${side}</dt><dd class="off">—</dd>`;
      return `<dt>${side}</dt><dd>${dot(h.moving, 'move')}`
        + `${h.moving ? esc(h.direction || 'moving') : 'still'}`
        + `${h.speed ? ` <small>${h.speed.toFixed(1)}</small>` : ''}</dd>`;
    };

    const detail = t.handsDetail?.length ? t.handsDetail
      : Array.from({ length: 2 }, (_, i) => ({ present: i < (t.hands || 0),
                                               moving: t.moving }));

    this.el.tele.innerHTML = `
      <section class="ch">
        <h4>letters <em>${esc(t.letterKind || '')}</em></h4>
        <dl>
          <dt>DetectedLetter</dt>
          <dd class="big">${t.letter || '—'}${conf(t.letterConf)}</dd>
          ${t.text ? `<dt>spelled</dt><dd class="mono-val">${esc(tail(t.text, 16))}</dd>` : ''}
        </dl>
      </section>

      <section class="ch">
        <h4>hands <em>${t.hands}/${need} needed</em></h4>
        <dl>
          <dt>HandCount</dt>
          <dd class="${t.hands === need ? 'good' : t.hands ? 'warn' : ''}">${t.hands}</dd>
          <dt>HandActiveStatus</dt>
          <dd>${dot(t.moving, 'move')}${t.moving ? 'moving' : 'still'}</dd>
          ${detail.map(handRow).join('')}
        </dl>
      </section>

      <section class="ch">
        <h4>gesture</h4>
        <dl>
          <dt>value</dt>
          <dd>${t.gesture ? esc(t.gesture) : '—'}${conf(t.gestureConf)}</dd>
          ${t.gestureHand ? `<dt>hand</dt><dd>${esc(t.gestureHand)}</dd>` : ''}
        </dl>
      </section>

      <section class="ch">
        <h4>expression ${t.exprCalibrating ? '<em>calibrating</em>' : ''}</h4>
        <dl>
          <dt>FacialExpression</dt>
          <dd class="${STRESS.has(t.expression) ? 'warn' : ''}">${esc(t.expression || 'neutral')}${conf(t.expressionConf)}</dd>
          ${t.aslMarker ? `<dt>marker</dt><dd>${esc(t.aslMarker)}</dd>` : ''}
        </dl>
        ${chips(t.actions)}
      </section>

      <section class="ch">
        <h4>head</h4>
        <dl>
          <dt>nod / shake</dt>
          <dd class="${t.nod === 'yes' ? 'good' : t.nod === 'no' ? 'warn' : ''}">${t.nod ? (t.nod === 'yes' ? 'YES' : 'NO') : '—'}</dd>
          <dt>yaw / pitch / roll</dt>
          <dd class="mono-val">${t.headPresent
            ? `${t.yaw.toFixed(0)}° ${t.pitch.toFixed(0)}° ${t.roll.toFixed(0)}°`
            : 'no face'}</dd>
        </dl>
      </section>

      <section class="ch">
        <h4>eyes ${t.gazeCalibrating ? '<em>calibrating</em>' : ''}</h4>
        <dl>
          <dt>GazeFocus</dt>
          <dd>${dot(t.gaze)}${t.gaze ? 'on screen' : 'away'}</dd>
          <dt>watching</dt>
          <dd>${pct(t.focus)}${t.awaySecs > 0.3 ? ` <small>away ${t.awaySecs.toFixed(1)}s</small>` : ''}</dd>
          ${t.blinks ? `<dt>blinks/min</dt><dd>${t.blinks.toFixed(0)}</dd>` : ''}
        </dl>
      </section>

      ${t.sentence?.length || t.recording ? `
      <section class="ch">
        <h4>words ${t.recording ? '<em class="rec">recording</em>' : ''}</h4>
        ${chips(t.sentence)}
      </section>` : ''}

      <p class="src">${tele.overridden
        ? `keyboard has the floor · camera held off`
        : tele.live
        ? `camera · ${tele.received} readings`
        : `keyboard · camera ${tele.connected ? 'connected, quiet' : 'not connected'}`}</p>`;
  }

  showVerdict(v) {
    this.el.verdict.innerHTML =
      `<b class="v-${v.do}">${v.do}</b><span>${esc(v.why)}</span>`;
  }

  showClock(elapsed, awayFor) {
    this.el.clock.textContent = awayFor > 0.3
      ? `away ${awayFor.toFixed(1)}s (answering clock paused)`
      : `${elapsed.toFixed(1)}s on this letter`;
  }

  logTurn({ turn, data, ms, source, how }) {
    const li = document.createElement('li');
    const tag = how === 'hit' ? 'ready' : how === 'miss' ? 'too slow' : how || '';
    li.innerHTML = `<b>${turn}</b> <em class="h-${how}">${source} · ${tag} · ${ms}ms</em>`
      + `<span>${esc(data.say)}</span>`;
    this.el.log.prepend(li);
    while (this.el.log.children.length > 30) this.el.log.lastChild.remove();
  }

  flashKey(k) {
    this.el.keys.textContent = k;
    this.el.keys.classList.remove('hit');
    void this.el.keys.offsetWidth;
    this.el.keys.classList.add('hit');
  }

  status(text, kind = '') {
    this.el.status.textContent = text;
    this.el.status.className = kind;
  }
}

/* The recogniser's spelled text accumulates all session; only the end of it is
 * what the child just did, and the rest pushes the panel sideways. */
function tail(str, n) {
  const v = String(str ?? '');
  return v.length > n ? '…' + v.slice(-n) : v;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
