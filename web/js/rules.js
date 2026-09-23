/* The EvaluationRules from the design, as one pure function.
 *
 * `decide()` takes a reading and the clock and returns a verdict. It touches no
 * DOM, plays no sound, starts no timer and holds no state, so it can be read
 * against the spec line by line and exercised without a camera - `rules.test.js`
 * runs every branch below in a few milliseconds.
 *
 * Order is the part the spec leaves implicit, and it is where the behaviour
 * actually lives. Two of these rules are about whether the child is *there* at
 * all, and they have to be asked first: judging a handshape is meaningless if
 * nobody is looking at the screen. Then the rules about how the hands are being
 * used, then the letter itself, which is last because it is the only one that
 * needs the hand to have settled.
 *
 * The one rule the spec states twice over is worth spelling out. A hand that is
 * still moving is mid-sign - it is travelling into the shape, and the
 * classifier is reading a pose the child is passing through, not one they are
 * making. Marking that wrong teaches a child to hold still rather than to sign,
 * so nothing is judged until the hand has stopped.
 */

/* How many hands a letter is made with.
 *
 * This is not a detail, it is the difference between the two alphabets. ASL
 * fingerspelling is one-handed throughout. Auslan is *two*-handed - one hand is
 * the base and the other points at it - with exactly two exceptions: C, and the
 * numerals, which are made on one hand alone.
 *
 * So "how many hands should be in frame" is a question about the letter being
 * asked for, not a constant. Hard-coding one hand and telling an Auslan signer
 * off for using two would be telling them off for signing correctly.
 */
export const ALPHABETS = {
  asl:    { hands: 1, oneHanded: null, label: 'ASL' },          // null = all of them
  auslan: { hands: 2, oneHanded: new Set('C0123456789'), label: 'Auslan' },
};

export function handsFor(letter, alphabet = 'asl') {
  const a = ALPHABETS[alphabet] || ALPHABETS.asl;
  if (!a.oneHanded) return 1;
  return a.oneHanded.has(letter) ? 1 : a.hands;
}

export const ATTENTION_GRACE_S = 1.2;   // a glance away is not a lapse

/* How long the wrong number of hands has to persist before it is worth saying.
 *
 * Not a style choice - without it the rule is simply wrong. Measured off the
 * live camera while a child held a two-handed Auslan letter: the tracker keeps
 * both hands for three seconds at a stretch, then drops one for a third of a
 * second, then picks it up again. Seven such gaps in thirty seconds, median
 * 0.50s, shortest 0.28s.
 *
 * Judged per frame, every one of those gaps is "you need both hands" said to a
 * child who has both hands up. The hands are also *closer together* in a
 * two-handed letter than anywhere else, which is exactly when a tracker is
 * most likely to lose one - so the complaint fires hardest at the moment the
 * child is doing it right.
 *
 * 1.5s clears every gap measured with room to spare, and is still well under
 * the time it takes to actually raise a hand on purpose. */
export const HAND_COUNT_GRACE_S = 1.5;
export const HELP_AFTER_S = 10;         // spec: TimeElapsed >= 10s, no letter
export const IDLE_AFTER_S = 15;         // spec: TimeElapsed >= 15s, no hands
export const HELP_AFTER_TRIES = 3;      // see below - an addition, not the spec
export const STRUGGLING = new Set(['confused', 'frustrated']);

/* The gesture that means "I am stuck".
 *
 * Everything else the wizard reacts to is inferred - a face that looks
 * confused, a timer that ran out, three attempts in a row. All of those are
 * guesses about a child who has not asked for anything. This is the one channel
 * where the child gets to say it outright, and a deliberate request has to
 * outrank every guess: it is the difference between a machine that watches you
 * and a machine you can talk to.
 *
 * Victory rather than a thumbs up or an open palm, because neither of those is
 * a handshape in either alphabet - a raised flat hand is Auslan 4 and a thumb
 * is part of half the letters, so either would fire constantly while a child
 * was simply spelling. */
export const HELP_GESTURE = 'victory';

/**
 * @param {object} t   the reading: {letter, hands, moving, gaze, expression}
 * @param {object} ctx {target, alphabet, elapsed, awayFor, attempts, hintOffered}
 * @returns {{do: string, why: string, letter?: string}}
 */
export function decide(t, ctx) {
  const { target, alphabet = 'asl', elapsed = 0, awayFor = 0,
          handsWrongFor = 0, attempts = 0, hintOffered = false } = ctx;
  const need = handsFor(target, alphabet);

  // --- has the child asked for help? --------------------------------------
  // First, above every other rule, and that position is the whole rule.
  //
  // It began lower down, under the hand-count checks, and did not work at all:
  // a peace sign is *one hand*, Auslan letters want two, so a child asking for
  // help was told "this spell needs both wands!" - the game answering a
  // question nobody asked while ignoring the one they did. The same would go
  // for being marked wrong, or being told to look at the screen.
  //
  // Everything else here is inferred about the child. This is the one thing
  // they say outright, so nothing the game merely suspects can outrank it. It
  // fires after a hint has already been given, too: asking twice is asking.
  if (t.gesture === HELP_GESTURE) {
    return { do: 'offer_hint', why: 'the child asked - peace sign', asked: true };
  }

  // --- is the child here? ------------------------------------------------
  // GazeFocus == false -> pause the timer and call them back. The grace period
  // is not in the spec: without it the wizard interrupts every time a child
  // looks at their own hands, which is exactly what you want them doing.
  if (t.gaze === false && awayFor >= ATTENTION_GRACE_S) {
    return { do: 'look_back', why: 'GazeFocus == false' };
  }

  // TimeElapsed >= 15s AND HandCount == 0.
  if (t.hands === 0 && elapsed >= IDLE_AFTER_S) {
    return { do: 'idle_prompt', why: `no hands for ${IDLE_AFTER_S}s` };
  }

  // --- how are the hands being used? -------------------------------------
  // The wrong number of hands for *this letter*. Said once and then dropped: a
  // child whose hands are in the wrong place is not being disobedient, and a
  // wizard who says so every half second is unbearable. The game rate-limits
  // these; the rule only reports that the condition holds.
  // ...but only once it has held. A tracker that blinks is not a child who
  // put a hand down; see HAND_COUNT_GRACE_S.
  const settled = handsWrongFor >= HAND_COUNT_GRACE_S;
  if (t.hands > need && settled) {
    return { do: 'too_many_hands', why: `HandCount ${t.hands} > ${need}`
             + ` for ${handsWrongFor.toFixed(1)}s`, need };
  }
  // Only once a hand is actually up. Nought hands is "not started yet", which
  // the idle prompt already covers and which is not a mistake to correct.
  if (t.hands > 0 && t.hands < need && settled) {
    return { do: 'too_few_hands', why: `HandCount ${t.hands} < ${need}`
             + ` for ${handsWrongFor.toFixed(1)}s`, need };
  }

  // --- does the child need help? -----------------------------------------
  // FacialExpression confused or frustrated bypasses the 10 second wait. This
  // is the rule that makes the face camera worth having: a child who is stuck
  // looks stuck several seconds before a timer would notice.
  if (STRUGGLING.has(t.expression) && !hintOffered) {
    return { do: 'offer_hint', why: `FacialExpression == '${t.expression}'` };
  }

  // TimeElapsed >= 10s AND DetectedLetter == null.
  if (elapsed >= HELP_AFTER_S && t.letter == null && !hintOffered) {
    return { do: 'offer_hint', why: `${HELP_AFTER_S}s with no letter detected` };
  }

  // Not in the spec. Three wrong attempts is the same child in the same trouble
  // as ten silent seconds, and the spec's two help triggers both miss it: they
  // are trying, so the timer keeps being reset, and a child can be stuck
  // without their face showing it.
  if (attempts >= HELP_AFTER_TRIES && !hintOffered) {
    return { do: 'offer_hint', why: `${attempts} attempts` };
  }

  // --- the letter --------------------------------------------------------
  // HandActiveStatus == true -> do not evaluate. The child is mid-sign.
  if (t.moving) {
    return { do: 'wait', why: 'HandActiveStatus == true (forming the sign)' };
  }

  // HandActiveStatus == false AND the letter's own hand count -> evaluate.
  if (t.hands === need && !t.moving) {
    if (t.letter == null) return { do: 'wait', why: 'hand still, no letter read' };
    if (t.letter === target) {
      return { do: 'correct', why: `DetectedLetter == ${target}`, letter: t.letter };
    }
    return { do: 'wrong', why: `DetectedLetter ${t.letter} != ${target}`, letter: t.letter };
  }

  return { do: 'wait', why: t.hands === 0 ? 'no hand in frame' : 'waiting' };
}

/* A wrong answer must be judged once, not sixty times a second.
 *
 * The child holds the shape while the wizard reacts, so the same reading is
 * still true on the next frame and the frame after that. This latches a verdict
 * until the reading genuinely changes - the hand moves again, or it settles
 * into a different letter. Without it the wizard talks over himself and a
 * single mistake is counted as forty.
 */
export class Latch {
  constructor() { this.key = null; }

  /** True the first time a given settled reading is seen. */
  fresh(t) {
    const key = t.moving ? null : `${t.letter}/${t.hands}`;
    if (key === null) { this.key = null; return false; }   // moving clears it
    if (key === this.key) return false;
    this.key = key;
    return true;
  }

  clear() { this.key = null; }
}
