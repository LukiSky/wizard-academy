# Wizard Academy

A wizard asks a child to spell a word in sign language. The child signs it at a
webcam, one letter at a time, and the wizard reacts — to the letter, to how many
tries it took, to whether they are still looking at the screen, and to whether
they look like they are enjoying it. At the end he hands them a report card.

```bash
./run.sh          # then open http://localhost:8770
```

No webcam and no n8n needed to try it: press letter keys to sign.

---

## What is doing what

Four pieces, and the split between them is the design:

| | does | lives in |
|---|---|---|
| **the camera** | reads handshapes, hands, gaze, expression | `../sign-language-demo` |
| **the rules** | decides *what happened* — right, wrong, away, stuck | `web/js/rules.js` |
| **n8n** | decides *what the wizard says about it* | `n8n/` |
| **Pocket TTS** | says it out loud | `server.py`, `../.venv-pockettts` |

The line between the third and the second is the one that matters. Timing and
geometry — was that an A, has the hand stopped moving, has it been ten seconds —
have to be exact and have to be testable, so they are a pure function with no
network in it. The words want to be warm and varied and rewritten twenty times
over a weekend, so they are a prompt.

The wizard's voice is local. n8n never carries audio; it carries about forty
words per turn. That keeps a turn under a second on a good connection, and it
means a dropped webhook costs you a better sentence rather than a silent wizard.

## Running it

```bash
./run.sh                              # game + voice, on http://localhost:8770
./run.sh --no-tts                     # skip Pocket TTS, use the browser voice
./run.sh --port 9000
```

With a webcam, in a second terminal:

```bash
cd ../sign-language-demo
./run.sh all --alphabet auslan --hands 2 --state-every 0.2 \
    --webhook http://localhost:8770/api/telemetry \
    --mirror-to http://localhost:8770/api/frame
```

`--alphabet auslan` and `--hands 2` are not optional extras — the game defaults
to Auslan, which is two-handed, and the recogniser will not track a second hand
unless asked. For ASL instead, pass `--alphabet asl --hands 1` here and
`alphabet: 'asl'` to the `Game` constructor.

`--mirror-to` is what puts your own hands on screen; see below.

With n8n, copy `.env.example` to `.env` and set `N8N_WEBHOOK_URL`. See
[`n8n/README.md`](n8n/README.md) for the contract and an importable workflow.

Everything degrades on its own: no n8n falls back to a local script, no Pocket
TTS falls back to the browser's voice, no camera falls back to the keyboard. The
status line under **Begin** tells you which of the three you are actually
running.

## Playing with the keyboard

The mock produces exactly the readings the camera produces, so every rule can be
triggered without a webcam.

| key | |
|---|---|
| `A` – `Z` | sign that letter, hand at rest |
| `Space` | hands down, nothing detected |
| `1` | toggle hand moving — mid-sign, nothing is judged |
| `2` | toggle a second hand in frame |
| `3` | toggle looking at the screen |
| `4` `5` `6` `7` | confused / frustrated / happy / neutral |
| `Enter` | nod yes |
| `8` | cycle hand gesture |
| `9` | nod yes / shake no |
| `0` | self-view: small / large / off |

A letter key puts up as many hands as *that letter* needs, so pressing `A` in
Auslan reports two hands and is read as the letter rather than tripping the
"both wands" rule.

The modifiers are on the digit row because they used to be on letters, and that
made M, G, C, F, H, N and Y unsignable — the word DOG could not be finished,
because G toggled the gaze.

## Seeing your own hands

Copying a handshape off a card is hard without watching what your hand is doing,
so there is a self-view. Click it to enlarge, `0` to cycle, and the choice is
remembered.

| size | |
|---|---|
| **small** | out of the way in the corner |
| **large** | for when a letter is difficult — but it covers the wizard |
| **side** | docked in its own column. **Nothing overlaps** — the wizard, the word and the hands are all visible at once |
| **off** | for when a child finds their own face more interesting than the wizard, which they will |

`side` is the one for showing somebody the thing, or for checking whether the
reader is seeing what you think it is. The scene shrinks to make room rather
than having the camera sit on top of it.

Pair it with `--no-window` on the recogniser and the whole thing is one window
instead of two:

```bash
./run.sh all --alphabet auslan --hands 2 --state-every 0.2 --no-window \
    --webhook http://localhost:8770/api/telemetry \
    --mirror-to http://localhost:8770/api/frame
```

Without a window there is no `q` to press, so stop it with ctrl-c.

It has two sources, because a V4L2 device opens exactly **once**: while the
recogniser has the webcam, `getUserMedia` in the page fails with
`NotReadableError`, and no amount of permission granting changes that. So:

- **The recogniser is running** — it posts the frame it already drew to
  `/api/frame` (that is what `--mirror-to` does) and the server relays it as
  MJPEG, which an `<img>` plays natively. This is the better picture anyway: it
  carries the hand landmarks, so a child is seeing *what the classifier sees*
  rather than a plain mirror. Labelled "what the wizard sees".
- **Nothing else has the camera** — the page opens it directly, mirrored,
  because an unmirrored self-view makes people move the wrong hand. Labelled
  "you".

The recogniser wins when both are possible. The page re-picks its source every
few seconds, so you can start or stop the recogniser without reloading. If
neither works — no camera, or permission declined — the panel just does not
appear; the game is entirely playable without it.

The panel sits bottom-left and the handshape card sits right, on purpose: a
child comparing the two is looking back and forth, and that is easier across the
screen than between two things stacked in the same corner.

## The spell meter

Under the word is a bar that fills as the spell is cast, and a line saying what
the child should be doing right now:

| phase | line | colour |
|---|---|---|
| teaching | *Watch the wizard* | teal |
| listening | *Your turn - sign it!* | gold, and it moves |
| help or idle | *Need a hand?* / *Still there?* | pink |
| finale | *Casting the spell!* | white |

Both halves earn their place. The word strip already says which letters are
done, but it says it in a form that needs reading - four boxes, three green -
and these are children still learning to read. A bar that fills is the same
fact at a glance, and from across a room, which is where the adult is standing.

The phase line answers the other question. A child watching the wizard
demonstrate and a child expected to sign are looking at almost identical
screens, and *am I supposed to be doing something right now* is what stalls a
first session. Only the "your turn" state animates, because that is the only
one where the answer is yes.

## What the child can say back

Two gestures, and they are the only channel where the child says something
outright rather than having it inferred about them:

| | |
|---|---|
| **peace sign** | I'm stuck — show me. Works at any time, even after a hint, even mid-answer. |
| **shake your head** | No thanks. Declines the spell book without sitting through the six-second offer. |
| nod | Yes, show me |

The wizard teaches the peace sign on the first prompt of a session — once,
because being told every word is nagging — and a chip stays on screen while the
child is expected to sign.

Victory rather than a thumbs up or an open palm, deliberately: an open palm is
Auslan 4 and a thumb is part of half the letters, so either would fire
constantly while a child was simply spelling.

## Two alphabets, and why it is not a flag

The game defaults to **Auslan**. That is not a label swap, because Auslan
fingerspelling is **two-handed** — one hand is the base, the other points at it —
and the original design had a rule that said *"we only need one wand for this
spell"*. Shipping that rule with Auslan letters would tell a child off for
signing correctly.

So the hand count is a property of the letter, not a constant:

| | hands | exceptions |
|---|---|---|
| **Auslan** (default) | 2 | **C** and the numerals **0–9** are one-handed |
| ASL | 1 | — |

`handsFor(letter, alphabet)` in [`rules.js`](web/js/rules.js) answers it, and the
one rule became two — `too_many_hands` and `too_few_hands` — because with Auslan
both are real and which one a child hears depends on the letter in front of
them. C is one-handed *within* Auslan, so the correction reverses mid-word.

The word list is filtered against the tiles actually loaded rather than
hard-coded per alphabet: `J` is a movement in both and drops out, `Z` is a
movement in ASL but a shape in Auslan, so `ZOO` and `BUZZ` are askable here and
would not be under ASL.

## Everything the camera reads

The rules use five values. The panel shows all seven of the recogniser's
channels, because a child signing at a camera cannot tell whether the machine
has lost their left hand, read their face as cross, or quietly stopped believing
they are looking at the screen — and nor can anyone watching them. Each of those
looks identical from outside: a wrong answer with no visible cause.

| channel | shown |
|---|---|
| **letters** | current letter, confidence, letter vs number, text so far |
| **hands** | count against what the letter needs, moving or still, per hand: direction and speed |
| **gesture** | fist, open palm, pointing, thumbs up/down, victory, I-love-you — with confidence and which hand |
| **expression** | the seven universal expressions, confidence, facial actions as chips, ASL grammatical marker |
| **head** | nod = yes, shake = no, plus live yaw / pitch / roll |
| **eyes** | on screen or away, share of the session watching, seconds away, blinks per minute |
| **words** | the sentence so far, and whether a word sign is recording |

## The seven states

1. **Greeting** — the wizard waves. `hello`
2. **Word selection** — a word is chosen, the wand gathers. `magic`
3. **Teach signs** — each letter demonstrated for five seconds, with its ASL
   handshape on a card
4. **Active listening** — the loop the rules run in
5. **Help & idle prompts** — the spell book, or "are you still there?"
6. **Magic finale** — the grand spell, particles, the word
7. **Report** — the evaluation, then the offer to play again

The greeting waves before anything else happens and the wand only charges once a
word exists: hello first, then the magic.

## The rules

`web/js/rules.js` is one pure function. It takes a reading and the clock and
returns a verdict; it touches no DOM, starts no timer and holds no state.

```bash
node web/js/rules.test.js      # 26 assertions, a few milliseconds
```

Order is where the behaviour actually lives, and it is not what the spec's
ordering suggests. Whether the child is *present* is asked first, because
judging a handshape is meaningless if nobody is looking at the screen. Then how
the hands are being used. Then the letter — last, because it is the only rule
that needs the hand to have settled.

Three details that are easy to get wrong and change everything:

**A moving hand is never judged.** It is travelling into the shape, so the
classifier is reading a pose the child is passing through. Marking that wrong
teaches a child to hold still rather than to sign.

**A held mistake is one mistake.** The child keeps the shape up while the wizard
reacts, so the same reading is true on the next tick and the one after. `Latch`
holds a verdict until the reading genuinely changes — otherwise a single wrong
letter is counted forty times and the wizard talks over himself.

**A blinking tracker is not a child putting a hand down.** Measured off the live
camera while a two-handed Auslan letter was held: the reader keeps both hands
for three seconds at a stretch, then drops one for a third of a second, then
picks it up again — seven such gaps in thirty seconds, median 0.50s. Judged per
frame, every one of them told a child with both hands up that they needed both
hands. Worse, the hands are *closest together* in a two-handed letter, which is
exactly when a tracker is most likely to lose one — so the complaint fired
hardest at the moment the child was doing it right. `HAND_COUNT_GRACE_S` makes
the count hold for 1.5s first; replaying that same recording, 41 complaints
become 2, and both survivors are real.

**A request outranks everything the game merely suspects.** The peace sign sits
above every other rule, and that position *is* the rule. It began below the
hand-count checks and did not work at all: a peace sign is one hand, an Auslan
letter wants two, so a child asking for help was told "this spell needs both
wands!"

**The answering clock stops when they look away.** Ten seconds of not answering
and ten seconds of not being there are different problems with different
prompts, so they are two separate clocks.

## Assets

```bash
python3 build_assets.py        # ~40s, needs ffmpeg
```

Reads `../video/*/frame_*.png` and the two charts in `../sign-language-demo`,
writes `web/assets/`.

**19 animations.** Each folder of 240 transparent frames becomes one VP9/WebM
clip with a real alpha channel — 21 MB for the whole cast against 1.6 GB of
PNGs. Every clip is cropped to the *same* rectangle, the union of all 19
bounding boxes, so the wizard does not jump half a body width when the animation
changes.

Each clip is ten seconds and the character moves for nearly all of it, so a
one-shot plays a measured 3.4-second window around its furthest-from-rest moment
rather than the whole file. Freezing the game for ten seconds to say "not quite"
is not feedback.

**61 handshape tiles.** The ASL alphabet A–Z and the Auslan A–Z (bar J) plus
0–9, sliced from the charts the recogniser's own scripts draw, so the hint a
child is shown is the shape the model was trained on rather than a stock photo
of somebody else's hand.

The paper is keyed out by flood-filling from the edge, not by colour. Every
knuckle in those charts is a white disc with a coloured ring; a plain colour key
punches all of them through, which is invisible on a white chart and turns every
joint into a black hole on a night sky.

## Layout

```
build_assets.py     frames + charts -> web/assets
server.py           static files, /api/say, /api/wizard, /api/events
fallback.py         what the wizard says when n8n is not answering
n8n/                the prompt, the contract, an importable workflow
web/js/
  rules.js          the evaluation rules, pure
  rules.test.js     26 assertions over them
  game.js           the seven states and the two clocks
  sprites.js        19 clips, crossfaded, one-shots return to a hold
  telemetry.js      camera -> five values, and the keyboard that fakes them
  voice.js          Pocket TTS, queued, browser fallback
  n8n.js            one turn out, one line back
  ui.js             the child's half and the developer's half
```
