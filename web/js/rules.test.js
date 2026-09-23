/* Every branch of the rules, without a camera.
 *
 *     node web/js/rules.test.js
 *
 * The rules are the part of this that is a specification rather than a taste
 * judgement - a child looking away for two seconds either does or does not
 * interrupt the wizard - and they are also the part that is miserable to check
 * by hand, because reproducing "fifteen seconds with no hands in frame while
 * looking at the screen" in front of a webcam takes fifteen seconds and a
 * certain amount of sitting still.
 *
 * `decide()` is pure, so all of it runs in a few milliseconds here instead.
 */
import { decide, Latch, handsFor, HELP_GESTURE, HELP_AFTER_S, IDLE_AFTER_S,
         ATTENTION_GRACE_S, HAND_COUNT_GRACE_S, HELP_AFTER_TRIES } from './rules.js';

let pass = 0, fail = 0;

function is(got, want, what) {
  if (got === want) { pass++; return; }
  fail++;
  console.error(`  FAIL ${what}\n       got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const reading = (o = {}) => ({
  letter: null, letterConf: 0, hands: 1, moving: false,
  gaze: true, expression: 'neutral', ...o,
});
// `handsWrongFor` defaults past the grace period, because most tests are
// about which rule wins rather than about the tracker blinking. The tests that
// care about the grace set it themselves.
const ctx = (o = {}) => ({ target: 'C', elapsed: 0, awayFor: 0, attempts: 0,
                           hintOffered: false, handsWrongFor: 99, ...o });

console.log('rules');

// --- the letter itself -----------------------------------------------------
is(decide(reading({ letter: 'C' }), ctx()).do, 'correct', 'the target letter, hand still');
is(decide(reading({ letter: 'S' }), ctx()).do, 'wrong', 'a different letter, hand still');
is(decide(reading({ letter: null }), ctx()).do, 'wait', 'hand still but nothing read');

// The rule the design states twice: a hand in motion is mid-sign, and a shape
// caught in transit must not be marked wrong.
is(decide(reading({ letter: 'S', moving: true }), ctx()).do, 'wait',
   'a wrong letter while the hand is still moving is not wrong yet');
is(decide(reading({ letter: 'C', moving: true }), ctx()).do, 'wait',
   'nor is a right one right yet');

// --- hands -----------------------------------------------------------------
is(decide(reading({ hands: 2, letter: 'C' }), ctx()).do, 'too_many_hands',
   'in ASL a second hand is mentioned even when the letter is correct');
is(decide(reading({ hands: 0 }), ctx({ elapsed: 3 })).do, 'wait', 'no hands, early');
is(decide(reading({ hands: 0 }), ctx({ elapsed: IDLE_AFTER_S })).do, 'idle_prompt',
   `no hands for ${IDLE_AFTER_S}s`);

// The tracker loses a hand for a third of a second at a time while a child
// holds a two-handed letter - measured, median 0.50s. Judged per frame, each of
// those gaps told a child with both hands up that they needed both hands.
console.log('hand count grace');
const held = (secs) => ctx({ alphabet: 'auslan', target: 'A',
                             handsWrongFor: secs });
is(decide(reading({ hands: 1 }), held(0.3)).do, 'wait',
   'a 0.3s blink is the tracker, not the child');
is(decide(reading({ hands: 1 }), held(0.5)).do, 'wait',
   'nor is the median gap of 0.5s');
is(decide(reading({ hands: 1 }), held(HAND_COUNT_GRACE_S + 0.1)).do,
   'too_few_hands', 'a hand genuinely down for longer is worth saying');
// The other direction, on Auslan's one-handed C: a spurious second hand for
// under the grace is not "too many", it is just not a moment to judge.
is(decide(reading({ hands: 2, letter: 'C' }), ctx({ alphabet: 'auslan',
   target: 'C', handsWrongFor: 0.4 })).do, 'wait',
   'a brief extra hand waits rather than complaining');
is(decide(reading({ hands: 2, letter: 'C' }), ctx({ alphabet: 'auslan',
   target: 'C', handsWrongFor: 3 })).do, 'too_many_hands',
   'but a sustained one is worth saying');
is(decide(reading({ hands: 1, letter: 'C' }), ctx({ alphabet: 'auslan',
   target: 'C' })).do, 'correct',
   'and the right count is judged as normal');

// --- attention -------------------------------------------------------------
is(decide(reading({ gaze: false }), ctx({ awayFor: 0.5 })).do, 'wait',
   'a glance away is not a lapse');
is(decide(reading({ gaze: false }), ctx({ awayFor: ATTENTION_GRACE_S + 0.1 })).do,
   'look_back', 'looking away for longer is');
is(decide(reading({ gaze: false, letter: 'C' }), ctx({ awayFor: 5 })).do, 'look_back',
   'attention is asked about before the letter is judged');

// --- help ------------------------------------------------------------------
is(decide(reading({ expression: 'confused' }), ctx()).do, 'offer_hint',
   'a confused face bypasses the timer');
is(decide(reading({ expression: 'frustrated' }), ctx()).do, 'offer_hint',
   'so does a frustrated one');
is(decide(reading({ expression: 'confused' }), ctx({ hintOffered: true })).do, 'wait',
   'but the hint is only offered once per letter');
is(decide(reading(), ctx({ elapsed: HELP_AFTER_S })).do, 'offer_hint',
   `${HELP_AFTER_S}s with nothing detected`);
is(decide(reading({ letter: 'S' }), ctx({ elapsed: HELP_AFTER_S })).do, 'wrong',
   'a child who is answering is judged, not helped');
is(decide(reading(), ctx({ attempts: HELP_AFTER_TRIES })).do, 'offer_hint',
   `${HELP_AFTER_TRIES} attempts earns a hint`);

// --- precedence ------------------------------------------------------------
// Two conditions true at once: the one about whether the child is present wins.
is(decide(reading({ gaze: false, hands: 2 }), ctx({ awayFor: 3 })).do, 'look_back',
   'looking away outranks a second hand');
is(decide(reading({ hands: 2, expression: 'confused' }), ctx()).do, 'too_many_hands',
   'the wrong hand count outranks a confused face');
is(decide(reading({ expression: 'confused', letter: 'S' }), ctx()).do, 'offer_hint',
   'a confused face outranks marking the letter wrong');

// --- Auslan is two-handed --------------------------------------------------
// The alphabet that made this rule worth generalising. Auslan fingerspelling
// uses a base hand and a pointing hand; C and the numerals are the exceptions.
console.log('auslan');
is(handsFor('A', 'auslan'), 2, 'A needs both hands in Auslan');
is(handsFor('C', 'auslan'), 1, 'C is the one-handed letter');
is(handsFor('7', 'auslan'), 1, 'numerals are one-handed');
is(handsFor('A', 'asl'), 1, 'ASL is one-handed throughout');

const aus = (o = {}) => ctx({ alphabet: 'auslan', target: 'A', ...o });
is(decide(reading({ hands: 2, letter: 'A' }), aus()).do, 'correct',
   'two hands on an Auslan letter is correct, not a complaint');
is(decide(reading({ hands: 1, letter: 'A' }), aus()).do, 'too_few_hands',
   'one hand on a two-handed letter asks for the other');
is(decide(reading({ hands: 0 }), aus({ elapsed: 3 })).do, 'wait',
   'no hands at all is not "you forgot one" - it is not started yet');
is(decide(reading({ hands: 2, letter: 'C' }), aus({ target: 'C' })).do, 'too_many_hands',
   'but C is one-handed even in Auslan');
is(decide(reading({ hands: 1, letter: 'C' }), aus({ target: 'C' })).do, 'correct',
   'and one hand on C is right');
is(decide(reading({ hands: 1, letter: '7' }), aus({ target: '7' })).do, 'correct',
   'as are the numerals');

// --- asking for help -------------------------------------------------------
// The peace sign is the only channel where the child says something outright
// rather than having it inferred about them, so it has to beat every guess.
console.log('asking for help');
const ask = (o = {}) => reading({ gesture: HELP_GESTURE, ...o });
is(decide(ask(), ctx()).do, 'offer_hint', 'a peace sign asks for help');
is(decide(ask(), ctx()).asked, true, 'and is marked as asked, not inferred');
is(decide(ask({ letter: 'S' }), ctx()).do, 'offer_hint',
   'asking outranks being marked wrong');
is(decide(ask({ letter: 'C' }), ctx()).do, 'offer_hint',
   'and outranks being marked right - they asked mid-answer');
is(decide(ask(), ctx({ hintOffered: true })).do, 'offer_hint',
   'asking twice is still asking, even after one hint');
is(decide(ask({ expression: 'happy' }), ctx()).do, 'offer_hint',
   'a cheerful child who asks is still asking');

// The bug this rule was moved to fix: a peace sign is one hand, an Auslan
// letter wants two, and the hand-count rule used to answer first - so a child
// asking for help was told "this spell needs both wands!" instead.
const ausAsk = (o = {}) => ctx({ alphabet: 'auslan', target: 'A', ...o });
is(decide(ask({ hands: 1 }), ausAsk()).do, 'offer_hint',
   'a one-handed peace sign outranks Auslan wanting two hands');
is(decide(ask({ hands: 3 }), ausAsk()).do, 'offer_hint',
   'and outranks having too many');
is(decide(ask({ gaze: false }), ctx({ awayFor: 5 })).do, 'offer_hint',
   'and outranks being told to look at the screen');

// ...but not every gesture is a request, or the wizard would stop the lesson
// every time a hand passed through a shape on its way to a letter.
is(decide(reading({ gesture: 'thumbs up', letter: 'C' }), ctx()).do, 'correct',
   'a thumbs up is not a request for help');
is(decide(reading({ gesture: 'open palm', letter: 'C' }), ctx()).do, 'correct',
   'nor is an open palm - which is Auslan 4, and would fire constantly');

// --- the latch -------------------------------------------------------------
console.log('latch');
{
  const l = new Latch();
  const held = reading({ letter: 'S' });
  is(l.fresh(held), true, 'the first settled reading is judged');
  is(l.fresh(held), false, 'holding the same shape is not judged again');
  is(l.fresh(reading({ letter: 'S', moving: true })), false, 'moving is never a verdict');
  is(l.fresh(held), true, 'settling again after moving is a new attempt');
  is(l.fresh(reading({ letter: 'T' })), true, 'a different letter is a new attempt');
}

// --- a whole letter, tick by tick -----------------------------------------
// The sequence a child actually produces: hand comes up, travels through two
// wrong shapes, settles on one of them, is corrected, then gets it right.
console.log('sequence');
{
  const l = new Latch();
  const seen = [];
  const frames = [
    reading({ hands: 0 }),
    reading({ hands: 1, moving: true }),
    reading({ hands: 1, moving: true, letter: 'A' }),
    reading({ hands: 1, moving: false, letter: 'S' }),
    reading({ hands: 1, moving: false, letter: 'S' }),
    reading({ hands: 1, moving: true, letter: 'S' }),
    reading({ hands: 1, moving: false, letter: 'C' }),
  ];
  for (const f of frames) {
    const v = decide(f, ctx());
    if ((v.do === 'wrong' || v.do === 'correct') && !l.fresh(f)) continue;
    seen.push(v.do);
  }
  is(seen.join(' '), 'wait wait wait wrong wait correct',
     'one wrong verdict for a held mistake, not two');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
