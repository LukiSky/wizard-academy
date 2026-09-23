/* What the camera sees, reduced to the five things the game asks about.
 *
 * `sign-language-demo` posts a rich snapshot several times a second - letters,
 * words, gestures, expression, attention, head pose, per-hand motion. The rules
 * in the design read five values out of all that:
 *
 *   DetectedLetter    HandCount    HandActiveStatus    GazeFocus    FacialExpression
 *
 * Everything else is carried through under `raw` for the debug panel, but the
 * game is written against those five and nothing more, so the rules stay
 * readable and a change to the perception side cannot quietly alter them.
 *
 * Two sources, one shape. Live telemetry arrives over Server-Sent Events; the
 * keyboard produces the identical object. The game cannot tell which it is
 * getting, which is what makes the demo runnable on a laptop with no webcam and
 * what makes the rules testable without a person in front of the screen.
 *
 * Note on the letter: the perception side already debounces, only reporting a
 * letter once it has been held steadily. A second layer of smoothing here would
 * add lag to something already lagged, so the value is passed straight through
 * and the *rules* decide when it counts - specifically, only once the hand has
 * stopped moving.
 */
/* The five the rules read, and everything else the recogniser reports.
 *
 * The rules still touch only the first five - that separation is the point, and
 * it is what keeps `decide()` readable. The rest is carried because it is worth
 * *seeing*: a child signing at a camera cannot tell whether the machine has
 * lost their left hand, read their face as cross, or stopped believing they are
 * looking at the screen, and nor can anyone watching them. All seven of the
 * recogniser's channels end up on the panel.
 */
export const BLANK = {
  // the five the rules act on
  letter: null, letterConf: 0, hands: 0, moving: false,
  gaze: true, expression: 'neutral',
  // letters
  letterKind: null, text: '',
  // gestures and words
  gesture: null, gestureConf: 0, gestureHand: null,
  sentence: [], recording: false,
  // face
  expressionConf: 0, actions: [], aslMarker: null, exprCalibrating: false,
  // head
  nod: null, headPresent: false, yaw: 0, pitch: 0, roll: 0,
  // eyes
  attention: 'unknown', focus: 0, awaySecs: 0, blinks: 0, gazeCalibrating: false,
  // motion, per hand
  handsDetail: [], motionState: 'STILL', speed: 0,
  readerAlphabet: null, readerHands: null,
  source: 'none', at: 0, raw: null,
};

export class Telemetry {
  constructor() {
    this.state = { ...BLANK };
    this.listeners = new Set();
    this.connected = false;
    this.received = 0;
    this.lastLive = 0;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  _emit() {
    this.state.at = performance.now();
    for (const fn of this.listeners) fn(this.state);
  }

  /* Merge a partial reading and tell everyone. The keyboard sends one key at a
   * time, so a patch must not wipe the fields it does not mention.
   *
   * A keypress also buys a couple of seconds of quiet from the camera. Without
   * that the keyboard is unusable whenever the recogniser is running: it posts
   * a full snapshot five times a second, so a typed letter is overwritten with
   * "no hands" before the next tick of the rules can read it. The window is
   * short and only a keypress opens one, so it cannot affect real play. */
  push(patch, source = 'mock') {
    if (source === 'keyboard') this.overrideUntil = performance.now() + 2500;
    Object.assign(this.state, patch, { source });
    this._emit();
  }

  /** True while a keypress is deliberately holding the camera off. */
  get overridden() {
    return performance.now() < (this.overrideUntil || 0);
  }

  connect(url = '/api/events') {
    const es = new EventSource(url);
    es.onopen = () => { this.connected = true; };
    es.onerror = () => { this.connected = false; };   // EventSource retries itself
    es.onmessage = (e) => {
      let rec;
      try { rec = JSON.parse(e.data); } catch { return; }
      const flat = normalise(rec);
      if (!flat) return;
      this.received++;
      this.lastLive = performance.now();
      if (this.overridden) return;      // a keypress has the floor
      Object.assign(this.state, flat, { source: 'camera', raw: rec });
      this._emit();
    };
    this.es = es;
  }

  /* True when live telemetry has arrived recently. The camera process can be
   * closed without closing the socket, so "connected" is not the same question
   * as "is anything actually coming through". */
  get live() {
    return this.connected && performance.now() - this.lastLive < 3000;
  }
}

/* One snapshot from the perception side -> the five values, or null.
 *
 * Both record kinds arrive on the same socket: `state` is the full picture and
 * `event` is a single channel that just changed. Events are folded in as
 * partial updates so a fast expression change is not held back waiting for the
 * next snapshot. */
export function normalise(rec) {
  if (!rec || typeof rec !== 'object') return null;

  if (rec.kind === 'event') {
    switch (rec.channel) {
      case 'expression':
        return { expression: rec.value || 'neutral',
                 expressionConf: rec.confidence ?? 0,
                 actions: rec.actions || [], aslMarker: rec.asl_marker ?? null };
      case 'attention':
        return { gaze: rec.value === 'on screen', attention: rec.value,
                 focus: rec.focus ?? 0, awaySecs: rec.away_secs ?? 0 };
      case 'head': return { nod: rec.value };                 // "yes" / "no"
      case 'gesture':
        return { gesture: rec.value, gestureConf: rec.confidence ?? 0 };
      case 'letter': return { letter: up(rec.value), letterConf: rec.confidence ?? 0 };
      case 'motion': return { motionState: rec.value === 'start' ? 'MOVING' : 'STILL' };
      case 'word': return { sentence: rec.sentence || [] };
      default: return null;
    }
  }
  if (rec.kind !== 'state') return null;

  const hands = rec.motion?.hands || [];
  const present = hands.filter((h) => h.present);
  return {
    letter: up(rec.letters?.current),
    letterConf: rec.letters?.confidence ?? 0,
    readerAlphabet: rec.reader?.alphabet ?? null,
    readerHands: rec.reader?.hands ?? null,
    letterKind: rec.letters?.kind ?? null,
    text: rec.letters?.text ?? '',
    hands: present.length,
    handsDetail: hands,
    motionState: rec.motion?.state ?? 'STILL',
    speed: rec.motion?.speed ?? 0,
    gestureConf: rec.gesture?.confidence ?? 0,
    gestureHand: rec.gesture?.hand ?? null,
    expressionConf: rec.expression?.confidence ?? 0,
    actions: rec.expression?.actions || [],
    aslMarker: rec.expression?.asl_marker ?? null,
    exprCalibrating: !!rec.expression?.calibrating,
    headPresent: !!rec.head?.present,
    yaw: rec.head?.yaw ?? 0,
    pitch: rec.head?.pitch ?? 0,
    roll: rec.head?.roll ?? 0,
    attention: rec.attention?.value ?? 'unknown',
    focus: rec.attention?.focus ?? 0,
    awaySecs: rec.attention?.away_secs ?? 0,
    blinks: rec.attention?.blinks_per_min ?? 0,
    gazeCalibrating: !!rec.attention?.calibrating,
    sentence: rec.words?.sentence || [],
    recording: !!rec.words?.recording,
    // "Active" is the design's word for mid-sign: the hand is still travelling
    // into or out of a shape, so whatever the classifier reads right now is a
    // shape in transit and must not be marked wrong.
    moving: present.some((h) => h.moving) || rec.motion?.state === 'MOVING',
    gaze: rec.attention?.on_screen !== false,
    expression: rec.expression?.value || 'neutral',
    nod: rec.head?.answer ?? null,
    gesture: rec.gesture?.value ?? null,
  };
}

function up(v) {
  if (!v) return null;
  const s = String(v).trim().toUpperCase();
  return /^[A-Z0-9]$/.test(s) ? s : null;    // the demo also reports words here
}

/* The keyboard stands in for the camera.
 *
 * A-Z signs that letter with the hand at rest, which is the reading the rules
 * act on. Everything else is on the digit row, and that is not a style choice:
 * the modifiers were on letter keys first, and it meant M, G, C, F, H, N and Y
 * could not be signed at all - the word DOG was unwinnable, because G toggled
 * the gaze. The alphabet is the one namespace here that is already spoken for.
 *
 * The modifiers matter as much as the letters. Most of the rules are about the
 * other four values rather than the letter, and a rule that can only be
 * triggered in front of a webcam is a rule that nobody checks. */
export function keyboardMock(tele, onKey) {
  const help = [
    ['A - Z', 'sign that letter (hand still)'],
    ['Space', 'hands down / nothing detected'],
    ['1', 'toggle hand moving (mid-sign)'],
    ['2', 'toggle a second hand in frame'],
    ['3', 'toggle looking at the screen'],
    ['4', 'look confused'],
    ['5', 'look frustrated'],
    ['6', 'look happy'],
    ['7', 'look neutral'],
    ['Enter', 'nod yes'],
    ['8', 'cycle hand gesture'],
    ['9', 'nod yes / shake no'],
    ['0', 'self-view: small / large / off'],
  ];

  // The pretrained gesture channel's own vocabulary.
  const GESTURES = ['fist', 'open palm', 'pointing up', 'thumbs up',
                    'thumbs down', 'victory', 'I love you'];
  const nextGesture = (g) =>
    GESTURES[(GESTURES.indexOf(g) + 1) % GESTURES.length];

  const MOOD = { 4: 'confused', 5: 'frustrated', 6: 'happy', 7: 'neutral' };

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA)$/.test(e.target?.tagName)) return;
    const k = e.key.toUpperCase();
    const s = tele.state;
    let patch = null;

    // Auslan is two-handed, so a letter key has to put up the number of hands
    // that letter actually needs - otherwise every keypress trips the
    // "you need both wands" rule instead of being read as the letter.
    if (/^[A-Z]$/.test(k)) {
      patch = { letter: k, letterConf: 0.95, moving: false,
                hands: tele.expectHands || 1 };
    }
    else if (k === '2') patch = { hands: s.hands > 1 ? 1 : 2 };
    else if (k === '1') patch = { moving: !s.moving, hands: Math.max(1, s.hands),
                                  motionState: s.moving ? 'STILL' : 'MOVING' };
    else if (k === '3') patch = { gaze: !s.gaze };
    else if (MOOD[k]) patch = { expression: MOOD[k] };
    else if (k === 'ENTER') patch = { nod: 'yes', gesture: 'thumbs up', headPresent: true };
    else if (k === '8') patch = { gesture: nextGesture(s.gesture), gestureConf: 0.88,
                                  gestureHand: 'right' };
    else if (k === '9') patch = { nod: s.nod === 'yes' ? 'no' : 'yes', headPresent: true };
    else if (k === '0') { onKey?.('0'); return; }   // handled by the self-view
    else if (e.code === 'Space') patch = { letter: null, hands: 0, moving: false,
                                           handsDetail: [] };
    else return;

    e.preventDefault();
    tele.push(patch, 'keyboard');
    onKey?.(e.code === 'Space' ? 'Space' : k === 'ENTER' ? '⏎' : k, patch);
  });

  return help;
}
