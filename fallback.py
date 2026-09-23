"""What the wizard says when n8n is not answering.

This is not a placeholder to be deleted once the webhook exists. It is the
contract, written out: every turn the game can ask about is handled here, with
the same keys n8n must return, so the page cannot tell the two apart. That has
two uses. It is the spec the prompt in `n8n/wizard_prompt.xml` is written
against - if a turn is missing here it is missing there too. And it is what
keeps a demo alive when the webhook is down, which is the moment a demo is most
likely to be watched.

## Why there are so many lines

An earlier version had three ways of saying "not quite" and three of saying
"yes". That is fine as a stand-in for one turn in twenty. It is *not* fine when
the webhook fails every request, because then this file is the entire
personality, and a child spelling a four-letter word hears the same three
sentences four times a word, every word. It stops sounding like a person inside
about ninety seconds - which is exactly how it was first noticed.

So each turn has a spread of lines, `_pick` never repeats the previous choice
for that turn, and the lines that can name the letter do, because a sentence
with the child's own letter in it is never quite the same sentence twice.

## Near misses

A wrong answer is not one thing. Some handshapes differ only by where the thumb
sits, and those pairs are the ones the reader actually confuses - so when the
letter that was read is a known confusable of the letter that was wanted, the
child is one finger away and deserves to be told that, rather than hearing
"not quite" for the third time.
"""
import random
import threading

# Pre-rendered by the server at startup, so the opening of the game is never
# waiting on a cold model. Only lines with no word or letter in them qualify -
# anything per-letter is synthesised on demand and cached from then on.
FIXED_LINES = [
    "Now it's your turn! Show me the magic sign.",
    "Off you go - show me the shape!",
    "Hello, young apprentice! Ready to cast some spelling magic?",
    "Welcome back to the academy! Let's make some spelling magic.",
    "Ooh, so close! Give it one more go.",
    "Almost! Have another try.",
    "This spell needs both wands. Two hands!",
    "Over here! Keep your eyes on the magic!",
    "Magic can be tricky! Shall I show you the spell book?",
    "There you are! Show me the shape.",
]


GREETINGS = [
    "Hello, young apprentice! Ready to cast some spelling magic?",
    "Welcome back to the academy! Let's make some spelling magic.",
    "Ah, my apprentice returns! The spells are waiting.",
    "Good day, young one! Shall we conjure up some words?",
    "There you are! I have been saving a spell just for you.",
    "Welcome, welcome! The wands are warm and the magic is ready.",
    "My favourite apprentice! Let's spell something wonderful.",
    "Step into the academy! There is magic to be made today.",
    "Greetings! Shall we turn some letters into magic?",
    "Wonderful, you're here! I have a spell that needs your hands.",
    "Hello there! The spell book has been waiting all morning.",
    "Ah, perfect timing! The magic works best with two of us.",
]

# First attempt: encouragement only, nothing about the shape. The reader is
# wrong often enough that a correction here might be correcting a correct hand.
WRONG_FIRST = [
    "Ooh, so close! Give it one more go.",
    "Almost! Have another try.",
    "Nearly there. Once more!",
    "That was close. Try it again!",
    "Not quite yet - again!",
    "Very nearly! Have another go.",
    "Ooh, a whisker away. Try once more.",
    "So close I could almost see the sparks. Again!",
    "Nearly had it! One more time.",
    "Close! The magic is nearly there.",
    "Not this time - but very nearly. Again!",
    "Ooh! Just a little more. Try again.",
]
# Second attempt: one concrete thing to change.
WRONG_SECOND = [
    "Nearly! Check where your thumb is sitting.",
    "Close one. Have a look at my hand again.",
    "Almost - try holding it a little steadier.",
    "So near! Watch your fingers as you shape it.",
    "Nearly! Try holding it still for a moment longer.",
    "Close. Have a peek at how my fingers sit.",
    "Almost! Make the shape a little bigger for me.",
    "So close. Try turning your hand just a touch.",
    "Nearly there. Check your fingers are where you want them.",
    "Almost! Hold it steady and let me have a proper look.",
    "Close one. Try again, nice and slow.",
    "Very near! Let the shape settle before you hold it.",
]
# Third and beyond: by now the problem is discouragement, not knowledge.
WRONG_STUCK = [
    "Ooh, {letter} is a slippery one! Shake your hands out and try again.",
    "This {letter} is putting up a fight! One more go.",
    "{letter} is being stubborn today. We'll get it!",
    "Even wizards wrestle with {letter}. Once more!",
    "{letter} is a tricky customer, isn't it? Let's have another go.",
    "Oh, {letter}! It does this to everyone. Try again.",
    "This one is determined to hide. Shake it out and go again.",
    "{letter} and I have had our arguments too. Once more!",
    "Tricky little letter, that one. Let's try it together.",
    "Deep breath - {letter} always comes right in the end.",
    "You are closer than you think. Another go at {letter}!",
    "{letter} takes practice, even for old wizards. Again!",
]
# When the reader saw a shape it genuinely confuses with the target.
NEAR = [
    "Oooh! That was almost {letter} - I saw {an_saw}. So close!",
    "Nearly {letter}! It came out as {saw}. One little change.",
    "That's {an_saw}, and {letter} is its neighbour. Very close!",
    "So near! {saw} and {letter} are cousins. Just a small change.",
    "Ooh, that shape said {saw}. {letter} is right beside it!",
    "Almost {letter}! The magic read {saw}. You are a whisker away.",
    "That's {an_saw} - and {letter} lives next door to it!",
    "Very close! {saw} today, {letter} next time.",
    "I saw {an_saw} there. {letter} is only a finger away!",
    "Nearly! Those two look so alike. That one was {saw}.",
]

# Letter names, not letters: "an F" because it is said "eff", "a U" because it
# is said "yoo". Every line here is read aloud by a speech synthesiser, so "a S"
# is not a typo you can leave in - it is something a child hears.
VOWEL_SOUNDED = set("AEFHILMNORSX")


def article(letter):
    return f"an {letter}" if letter in VOWEL_SOUNDED else f"a {letter}"


RIGHT = [
    "Yes! {letter}!",
    "Perfect {letter}!",
    "That's the one - {letter}!",
    "{letter}! Beautifully done.",
    "Got it. {letter}!",
    "Sparkling! That's {letter}.",
    "{letter}, exactly right!",
    "Marvellous. {letter}!",
    "That is a fine {letter}!",
    "Yes indeed - {letter}!",
    "Splendid {letter}!",
    "Bravo! {letter}.",
    "{letter}! The magic felt that one.",
    "Beautiful shape. That's {letter}!",
]
STREAK = [
    "Three in a row! The magic is really flowing now.",
    "Look at you go - three perfect signs!",
    "You're on a roll, apprentice!",
    "Three first-time spells! The wand is humming.",
    "Three in a row - that is proper wizardry.",
    "My word, three perfect letters! Keep going.",
    "The magic is listening to you now. Three in a row!",
    "Three clean signs! You make this look easy.",
    "Wonderful! Three right, one after another.",
    "That is three in a row. The academy is impressed!",
]
TEACH = [
    "This is {letter}. Watch my hand.",
    "Here comes {letter}. Look closely.",
    "{letter}, like this. See my fingers?",
    "Now, {letter}. Watch carefully.",
    "Next is {letter}. Keep your eyes on my hands.",
    "Here is {letter}. Look at how it sits.",
    "This one is {letter}. See the shape?",
    "{letter} goes like this. Watch.",
    "Now for {letter}. Have a good look.",
    "Here we are - {letter}. Study my fingers.",
    "{letter}! Watch me make it.",
    "This is how {letter} looks. Ready?",
]
PROMPT = [
    "Now it's your turn! Show me the magic sign.",
    "Your turn, apprentice. Show me {letter}.",
    "Off you go - show me the shape!",
    "Let's see your {letter}!",
    "Over to you! Make me {letter}.",
    "Your hands now. Show me {letter}.",
    "Go on then - let's see {letter}!",
    "Time to cast it. Show me {letter}.",
    "Your turn to make the magic. {letter}, please!",
    "Show me what you have got. {letter}!",
    "Now you try. Make the shape for {letter}.",
    "The wand is yours. Show me {letter}!",
]

# Things the child does that used to go entirely unanswered.
HANDS_UP = [
    "There you are! Show me the shape.",
    "Hands at the ready. Good!",
    "That's it - let me see.",
    "Ah, hands up! Off you go.",
    "Good, I can see you. Show me.",
    "There we go. Let's see that shape.",
    "Perfect, hands in the air. Go on!",
    "I see them! Make me a letter.",
    "Ready when you are, apprentice.",
    "Lovely, I can see your hands now.",
]
THUMBS = [
    "Ha! A thumbs up from a true apprentice.",
    "I'll take that as a yes!",
    "That's the spirit!",
    "A thumbs up! You and I are going to get along.",
    "Excellent. Onwards then!",
    "Ha! Confidence. I like it.",
    "Right you are! Let's carry on.",
    "A thumbs up from my apprentice. Wonderful.",
    "That is the face of someone ready for magic.",
    "Good! Now show me the letter.",
]
WAVE = [
    "Hello to you too!",
    "A wave! Very polite, for a wizard.",
    "Hello there! Now, where were we?",
    "Oh, hello! Lovely to be waved at.",
    "A greeting! I shall wave back.",
    "Hello, hello! Ready for the letter?",
    "How nice. Hello, apprentice!",
    "A wave from you and a wave from me.",
    "Hello! Now let's get back to the spell.",
    "Very friendly! Now, the letter.",
]
GOT_HAPPY = [
    "That smile is half the magic!",
    "I do like seeing that grin.",
    "Now there's a happy wizard.",
    "A smile! The spell likes that.",
    "That grin is worth a whole spell book.",
    "Lovely smile! It makes the magic brighter.",
    "There it is - a proper wizard's smile.",
    "You look pleased, and so am I.",
    "That smile could light a lantern!",
    "Happy hands make good magic.",
]
DECLINED = [
    "Righto! Off you go then.",
    "Fair enough - you've got this.",
    "As you wish, apprentice!",
    "Very well! I shall keep the book shut.",
    "Understood. Show me what you can do.",
    "No help needed? Good. Carry on!",
    "Right you are. Over to you.",
    "Suit yourself, clever one!",
    "Fair enough. The book stays closed.",
    "Good. I like a wizard who tries first.",
]

# The hands. Which of these a child hears depends on the letter, not the game.
TOO_FEW = [
    "This spell needs both wands. Two hands!",
    "Both hands for this one, apprentice!",
    "Bring your other hand up - this letter needs two.",
    "Two hands for this shape! Where's the other one?",
    "This one takes both wands. Up with the other hand!",
    "Almost - but this letter wants two hands.",
    "Your other hand too, please! Two for this one.",
    "Both hands needed here. Up they come!",
    "This shape is a two-handed spell. One more hand!",
    "One hand is a good start. Now the other!",
]
TOO_MANY_ONE = [
    "Just one wand for this letter. One hand!",
    "One hand only for this one - pop the other down.",
    "This letter takes a single hand. Just the one!",
    "Only one wand needed here. Rest the other.",
    "One hand for this shape, apprentice!",
    "Down with one hand - this letter is a solo spell.",
    "Just the one hand, please!",
    "This one is single-handed. Let the other rest.",
    "One wand is plenty for this letter.",
    "Tuck one hand away - this shape only wants one.",
]
TOO_MANY_TWO = [
    "Steady - two hands for this one, no more.",
    "Two hands is plenty, apprentice!",
    "Just the two wands for this spell.",
    "Two hands only! Let's keep it tidy.",
    "That is more hands than this letter needs.",
    "Two is the number for this one.",
    "Easy now - two hands is all it takes.",
    "This shape wants exactly two hands.",
    "Two wands, no more! Let's try again.",
    "Keep it to two hands for this letter.",
]
LOOK_BACK = [
    "Over here! Keep your eyes on the magic!",
    "Up here, apprentice! The spell needs your eyes.",
    "This way! I am over here.",
    "Eyes on the wand, please!",
    "Don't wander off - the magic is this way!",
    "Over here! I have not finished being magical.",
    "Look this way and the spell will keep going.",
    "Your eyes, apprentice! Right here.",
    "Come back to me! The magic is waiting.",
    "This way, this way! Eyes on the spell.",
]
IDLE = [
    "Are you still there? The magic is fading!",
    "Hello? The spell is going cold without you.",
    "Still with me, apprentice? The wand is getting sleepy.",
    "Where have you gone? The magic misses you!",
    "Anyone there? The sparks are running out.",
    "Apprentice? The spell book is getting dusty.",
    "Still there? I shall wait a little longer.",
    "The magic is dimming without your hands!",
    "Have you wandered off? Come back and we'll finish.",
    "Hello? Come back and cast with me!",
]
HINT_OFFER = [
    "Magic can be tricky! Shall I show you the spell book?",
    "Would you like a peek at the spell book?",
    "Shall I open the book and show you?",
    "This one is tricky. Want me to show you the shape?",
    "Shall I remind you how this one goes?",
    "Would a look at my hands help?",
    "Want me to show you again?",
    "Shall we open the spell book together?",
    "Would you like a little hint?",
    "Need a hand? Shall I show you the shape?",
]
HINT_SHOW = [
    "Here it is. {letter}. Look closely at my fingers!",
    "There you go - {letter}. See how it sits?",
    "This is {letter}. Have a good long look.",
    "Here is {letter} from the spell book. Study it!",
    "{letter}, right here. Copy my hands.",
    "Look - {letter}. That is the shape.",
    "There. {letter}. Take your time with it.",
    "Here comes {letter}, straight from the book.",
    "This is what {letter} looks like. Have a look!",
    "{letter}! Watch my fingers and match them.",
]
# When the child asked with a peace sign, the question is already answered.
ASKED = [
    "Of course! Here is {letter}. Look at my hands.",
    "Right away! This is {letter}.",
    "Certainly! {letter} goes like this.",
    "Good asking! Here is {letter}.",
    "At once, apprentice. {letter}, like so.",
    "Happy to help! Here is {letter}.",
    "Of course you may. This is {letter}.",
    "Say no more! {letter}, right here.",
    "Absolutely. Watch my hands for {letter}.",
    "Coming right up - {letter}!",
]
WORD_INTRO = [
    "Today's spell is {spelled}. {word}!",
    "Our word today is {spelled}. {word}!",
    "Here comes the spell: {spelled}. {word}!",
    "The magic word is {spelled}. {word}!",
    "Behold! {spelled}. {word}!",
    "Today we cast {spelled}. {word}!",
    "The spell book says {spelled}. {word}!",
    "Let's conjure {spelled}. {word}!",
    "Our spell is {spelled}. That spells {word}!",
    "Ready? {spelled}. {word}!",
]
FINALE = [
    "{spelled}. {word}! You cast the whole spell!",
    "{spelled}. {word}! The magic is done!",
    "{spelled} - {word}! Beautifully cast.",
    "{spelled}. That spells {word}! Wonderful!",
    "{spelled}. {word}! Look what you made!",
    "{spelled}. {word}! The whole spell, start to finish.",
    "{spelled}. {word}! That was proper magic.",
    "{spelled}. {word}! I knew you had it in you.",
    "{spelled}. {word}! The academy will hear of this.",
    "{spelled}. {word}! Every letter, perfectly cast.",
]
GESTURE_OTHER = [
    "Ooh, a gesture! Now the letter.",
    "I saw that! Back to the spell.",
    "Very expressive! Now show me the shape.",
    "Ha! Now, the letter please.",
    "Noted, apprentice. On with the magic!",
    "Lovely. Now the letter.",
    "I see you! Let's have that shape.",
    "Message received. Back to spelling!",
    "Good hands! Now make me a letter.",
    "Right then - the letter, please.",
]
# Anything the game asks about that has no line of its own.
ONWARDS = [
    "Let's keep going.",
    "Onwards, apprentice!",
    "Right then - where were we?",
    "On with the magic!",
    "Let's carry on.",
    "Back to the spell!",
    "Shall we continue?",
    "Onwards and upwards!",
    "Let's press on.",
    "Keep going, you're doing well.",
]
HAPPY_FINALE = [
    " What a magical smile! You did it!",
    " And that smile finishes it perfectly!",
    " Look at that grin - the best part of the spell!",
    " That smile is the finest magic of all!",
]

# Pairs the reader genuinely confuses. These are per-alphabet and they are not
# interchangeable: ASL confusions are between one-handed shapes that differ by a
# thumb, Auslan's are between two-handed configurations, and the two lists have
# almost nothing in common. Telling an Auslan signer that O and D are
# neighbours is simply false, and "so close!" about a letter that was not close
# is worse than saying nothing.
#
# ASL: measured on this project's classifier over 9,135 real hands.
CONFUSABLE_ASL = [
    ("O", "D"), ("G", "Q"), ("P", "Q"), ("R", "U"), ("V", "R"),
    ("E", "M"), ("F", "W"), ("A", "B"), ("M", "N"), ("S", "T"),
    ("A", "S"), ("M", "S"), ("N", "T"), ("K", "V"), ("U", "H"),
]

# Auslan: measured by wobbling each of the 24 letter poses and recording what
# the reader then called them. Only the low-noise results are here, and that
# distinction is the whole point - under heavy noise almost everything decays
# into K or G, but that is the classifier giving up rather than two letters
# resembling each other, and a child told "that was nearly a K" about a shape
# that was not nearly a K learns nothing.
CONFUSABLE_AUSLAN = [
    ("A", "Y"),     # by far the biggest: Y scores 67% with A at 24% behind it
    ("K", "X"),
    ("L", "R"),
    ("M", "Z"),
    ("R", "Y"),
    ("L", "Y"),
    ("R", "T"),
    ("U", "V"),
    ("B", "D"),     # B is the second weakest letter, at 82% with D behind it
]


def _bidir(pairs):
    out = {}
    for a, b in pairs:
        out.setdefault(a, set()).add(b)
        out.setdefault(b, set()).add(a)
    return out


NEAR_BY_ALPHABET = {
    "asl": _bidir(CONFUSABLE_ASL),
    "auslan": _bidir(CONFUSABLE_AUSLAN),
}
CONFUSABLE = CONFUSABLE_ASL          # kept for anything importing the old name


def is_near(target, saw, alphabet="auslan"):
    """Is `saw` a handshape this reader genuinely confuses with `target`?"""
    near = NEAR_BY_ALPHABET.get(alphabet, NEAR_BY_ALPHABET["auslan"])
    return bool(target and saw and saw in near.get(target, ()))


# Which line each turn used last, so the next one differs. Keyed by turn rather
# than globally: hearing "Yes!" twice running is what grates, and two different
# turns happening to sit next to each other is not.
_last = {}
_lock = threading.Lock()


def _pick(key, options, **fmt):
    """A random line, never the same one twice running for this key."""
    with _lock:
        prev = _last.get(key)
        choices = [o for o in options if o != prev] or list(options)
        chosen = random.choice(choices)
        _last[key] = chosen
    return chosen.format(**fmt)


def answer(p):
    """One game turn in, one wizard line out. Mirrors the n8n output exactly."""
    turn = (p.get("turn") or "").lower()
    word = (p.get("word") or "").upper()
    letter = (p.get("letter") or "").upper()
    detected = (p.get("detected") or "").upper()
    attempts = int(p.get("attempts") or 0)
    alphabet = (p.get("alphabet") or "auslan").lower()
    spelled = word[:int(p.get("index") or 0)]

    if turn == "greeting":
        return _say(_pick("greeting", GREETINGS), "hello")

    if turn == "word":
        # The letters spoken separately, then the word whole - the letters are
        # the content of a spelling game, and this is where a child first hears
        # which ones are coming.
        return _say(_pick("word", WORD_INTRO,
                          spelled=". ".join(word), word=word), "magic")

    if turn == "teach":
        return _say(_pick("teach", TEACH, letter=letter), "teach")

    if turn == "prompt":
        line = _pick("prompt", PROMPT, letter=letter or "it")
        if p.get("mention_help"):
            line += HELP_OFFER
        return _say(line, "listening")

    # --- the hands ------------------------------------------------------
    if turn == "too_many_hands":
        if int(p.get("need") or 1) == 1:
            return _say(_pick("many1", TOO_MANY_ONE), "one_hand")
        return _say(_pick("many2", TOO_MANY_TWO), "one_hand")

    if turn == "too_few_hands":
        return _say(_pick("few", TOO_FEW), "one_hand")

    if turn == "two_hands":            # the old name, for an older workflow
        return _say(_pick("many1", TOO_MANY_ONE), "one_hand")

    # --- attention and help ---------------------------------------------
    if turn == "look_back":
        return _say(_pick("look_back", LOOK_BACK), "call_back")

    if turn == "idle":
        return _say(_pick("idle", IDLE), "fading")

    if turn == "hint_offer":
        # A peace sign already answered the question, so this is not a question.
        if p.get("why", "").startswith("the child asked"):
            return _say(_pick("asked", ASKED, letter=letter), "teach", hint=True)
        return _say(_pick("hint_offer", HINT_OFFER), "thinking", hint_offer=True)

    if turn == "hint_show":
        return _say(_pick("hint_show", HINT_SHOW, letter=letter),
                    "teach", hint=True)

    # --- reactions to what the child just did ---------------------------
    if turn == "hands_up":
        return _say(_pick("hands_up", HANDS_UP), "listening")

    if turn == "gesture":
        g = (p.get("gesture") or "").lower()
        if "thumb" in g:
            return _say(_pick("thumbs", THUMBS), "laugh")
        if "palm" in g or "wave" in g:
            return _say(_pick("wave", WAVE), "hello")
        return _say(_pick("gesture", GESTURE_OTHER), "listening")

    if turn == "got_happy":
        return _say(_pick("got_happy", GOT_HAPPY), "laugh")

    if turn == "declined":
        return _say(_pick("declined", DECLINED), "listening")

    if turn == "streak":
        return _say(_pick("streak", STREAK), "celebrate")

    # --- the letter ------------------------------------------------------
    if turn == "wrong":
        if is_near(letter, detected, alphabet):
            return _say(_pick("near", NEAR, letter=letter, saw=detected,
                              an_saw=article(detected)), "try_again_alt")
        if attempts >= 3:
            return _say(_pick("stuck", WRONG_STUCK, letter=letter), "groan")
        if attempts >= 2:
            return _say(_pick("wrong2", WRONG_SECOND), "try_again_alt")
        return _say(_pick("wrong1", WRONG_FIRST), "try_again")

    if turn == "right":
        done = len(spelled) >= len(word)
        line = _pick("right", RIGHT, letter=letter)
        # Reading the word back is only worth it once there is a word to read:
        # after the first letter it comes out as "Perfect D! D. Keep going!"
        if not done and len(spelled) >= 2:
            line += f" {'-'.join(spelled)}. Keep going!"
        elif not done:
            line += " Keep going!"
        return _say(line, "correct" if attempts <= 1 else "correct_alt")

    if turn == "finale":
        happy = (p.get("expression") or "") == "happy"
        line = _pick("finale", FINALE, spelled="-".join(word), word=word)
        if happy:
            line += _pick("happy_finale", HAPPY_FINALE)
        return _say(line, "celebrate" if happy else "charge")

    if turn == "report":
        return _report(p)

    return _say(_pick("onwards", ONWARDS), "idle")


def _say(text, action, **extra):
    out = {"say": text, "caption": text, "action": action}
    out.update(extra)
    return out


def _report(p):
    """The end-of-session evaluation, from the game's own counters.

    n8n writes a warmer version of this from the same numbers. The shape is
    fixed here because the report card in the page reads these keys.
    """
    letters = p.get("letters") or []
    total = len(letters)
    first_try = sum(1 for x in letters if (x.get("attempts") or 1) <= 1)
    hinted = [x["letter"] for x in letters if x.get("hinted")]
    struggled = sorted({x["letter"] for x in letters if (x.get("attempts") or 1) >= 3})
    secs = float(p.get("seconds") or 0)
    accuracy = first_try / total if total else 0.0
    stars = 3 if accuracy >= 0.8 else 2 if accuracy >= 0.5 else 1

    strengths, practice = [], []
    clean = [x["letter"] for x in letters if (x.get("attempts") or 1) <= 1]
    if clean:
        strengths.append(f"{', '.join(clean)} came out right first time")
    if not hinted and total:
        strengths.append("finished without opening the spell book")
    if secs and total:
        strengths.append(f"about {secs/total:.0f} seconds a letter")
    for l in struggled:
        practice.append(f"{l} took a few tries")
    for l in hinted:
        if l not in struggled:
            practice.append(f"{l} needed the spell book")

    # Which confusions actually happened - the most useful line for an adult,
    # because these are the pairs worth practising side by side.
    alphabet = (p.get("alphabet") or "auslan").lower()
    confused = sorted({f"{x['letter']} read as {saw}"
                       for x in letters
                       for saw in (x.get("misread") or [])
                       if is_near(x["letter"], saw, alphabet)})

    headline = ("A fine bit of spellwork!" if stars == 3
                else "Good magic today." if stars == 2
                else "That was a tricky spell.")
    note = f"{first_try} of {total} letters were right on the first attempt"
    note += f". Worth practising: {', '.join(struggled)}." if struggled else "."
    if confused:
        note += (" These are shapes the reader genuinely confuses, so they are"
                 f" worth practising side by side: {'; '.join(confused)}.")
    return {
        "say": f"{headline} You spelled {p.get('word', '')}.",
        "caption": headline,
        "action": "laugh" if stars == 3 else "celebrate",
        "report": {
            "stars": stars,
            "headline": headline,
            "word": (p.get("word") or "").upper(),
            "first_try": first_try,
            "total": total,
            "seconds": round(secs),
            "strengths": strengths or ["you stayed with it to the end"],
            "practice": practice or ["nothing - that was clean"],
            "note_for_grownups": note,
        },
    }
