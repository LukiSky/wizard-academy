#!/usr/bin/env python3
"""Hold the live workflow to the contract, one turn at a time.

    python3 check_workflow.py                        # every turn, 3 runs each
    python3 check_workflow.py --runs 6               # harder
    python3 check_workflow.py --turn wrong --runs 10 # one turn, repeatedly
    python3 check_workflow.py --url http://localhost:8770/api/wizard

A model is not a function: the same turn can come back right nine times and
wrong the tenth, which is exactly the failure the game cannot see from inside.
Every check here is something that would be *visibly* wrong to a child - a
letter they were not asked for, an animation that does not exist, a line with
markdown in it that the speech synthesiser reads as punctuation - rather than a
matter of taste.

The point is not to pass. It is to find which turns drift and how often, so the
prompt can be argued with rather than guessed at. Failures print the offending
line in full.
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from collections import defaultdict

DEFAULT_URL = os.environ.get(
    "N8N_WEBHOOK_URL", "https://lukitais.app.n8n.cloud/webhook/wizard")

# The nineteen clips that exist. Anything else leaves the wizard frozen.
ACTIONS = {
    "idle", "thinking", "listening", "ready", "hello", "magic", "teach",
    "call_back", "correct", "correct_alt", "try_again", "try_again_alt",
    "one_hand", "groan", "fading", "worried", "charge", "celebrate", "laugh",
}
# Which pose actually suits which moment. A wrong-but-real action is not a
# crash, so these are warnings rather than failures - but a wizard who beckons
# "try again" while asking the child to start is still wrong on screen.
EXPECTED = {
    "greeting": {"hello"},
    "word": {"magic", "charge"},
    "teach": {"teach", "thinking"},
    "prompt": {"listening", "ready", "teach"},
    "right": {"correct", "correct_alt", "celebrate", "laugh"},
    "wrong": {"try_again", "try_again_alt", "groan", "thinking"},
    "too_many_hands": {"one_hand", "thinking"},
    "too_few_hands": {"one_hand", "thinking"},
    "look_back": {"call_back", "thinking"},
    "idle": {"fading", "worried", "call_back"},
    "hint_offer": {"thinking", "teach"},
    "hint_show": {"teach", "thinking"},
    "finale": {"celebrate", "charge", "laugh"},
    "report": {"celebrate", "laugh", "charge"},
    "gesture": {"laugh", "hello", "listening", "celebrate"},
    "got_happy": {"laugh", "celebrate", "listening"},
    "head_no": {"thinking", "teach", "listening"},
    "hands_up": {"listening", "ready", "teach"},
    "streak": {"celebrate", "laugh", "charge"},
}

MARKUP = re.compile(r"[*#`_~\[\]{}<>]|\\n")
EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿️]")
LETTER_WORD = re.compile(r"\b(?:letter|sign|shape)\s+([A-Z])\b")

TURNS = {
    "greeting":       {"word": "CAT"},
    "word":           {"word": "CAT"},
    "teach":          {"word": "CAT", "letter": "A", "index": 1},
    "prompt":         {"word": "CAT", "letter": "C"},
    "right":          {"word": "CAT", "letter": "A", "index": 2, "attempts": 1,
                       "spelled": "CA", "last": False},
    "wrong":          {"word": "CAT", "letter": "A", "attempts": 1,
                       "detected": "Y", "expression": "neutral"},
    "wrong_second":   {"turn": "wrong", "word": "CAT", "letter": "A",
                       "attempts": 2, "detected": "X"},
    "wrong_stuck":    {"turn": "wrong", "word": "CAT", "letter": "T",
                       "attempts": 4, "detected": "R",
                       "expression": "frustrated"},
    "too_many_hands": {"word": "CAT", "letter": "C", "hands": 2, "need": 1},
    "too_few_hands":  {"word": "CAT", "letter": "A", "hands": 1, "need": 2},
    "look_back":      {"word": "CAT", "letter": "A"},
    "idle":           {"word": "CAT", "letter": "A"},
    "hint_offer":     {"word": "CAT", "letter": "A", "expression": "confused"},
    "hint_show":      {"word": "CAT", "letter": "A"},
    "hands_up":       {"word": "CAT", "letter": "A", "hands": 2},
    "gesture":        {"word": "CAT", "letter": "A", "gesture": "thumbs up"},
    "got_happy":      {"word": "CAT", "letter": "A"},
    "head_no":        {"word": "CAT", "letter": "A"},
    "streak":         {"word": "STAR", "streak": 3},
    "finale":         {"word": "CAT", "expression": "happy"},
    "report":         {"word": "CAT", "seconds": 58, "letters": [
                          {"letter": "C", "attempts": 1, "hinted": False,
                           "misread": []},
                          {"letter": "A", "attempts": 3, "hinted": True,
                           "misread": ["Y", "Y"]},
                          {"letter": "T", "attempts": 1, "hinted": False,
                           "misread": []}]},
}


def unwrap(raw):
    """n8n wraps its answer in whatever the last node felt like."""
    try:
        d = json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", raw, re.S)
        if not m:
            return None
        try:
            d = json.loads(m.group(0))
        except json.JSONDecodeError:
            return None
    if isinstance(d, list):
        d = d[0] if d else {}
    for key in ("json", "output", "body", "data"):
        if isinstance(d, dict) and set(d) == {key}:
            d = unwrap(d[key]) if isinstance(d[key], str) else d[key]
    return d if isinstance(d, dict) else None


def check(name, body, data):
    """-> (failures, warnings). Each is a list of strings."""
    bad, warn = [], []
    turn = body["turn"]
    say = data.get("say")

    if not isinstance(say, str) or not say.strip():
        return ["no `say`"], warn
    if len(say) > 240:
        bad.append(f"say is {len(say)} chars - far past a spoken line")
    if MARKUP.search(say):
        bad.append(f"markup in a spoken line: {MARKUP.search(say).group(0)!r}")
    if EMOJI.search(say):
        bad.append("emoji in a spoken line")

    action = data.get("action")
    if action is not None:
        if action not in ACTIONS:
            bad.append(f"action {action!r} is not one of the 19 clips")
        elif action not in EXPECTED.get(turn, ACTIONS):
            warn.append(f"action {action!r} is odd for {turn}")

    # The absolute rule: never name a letter the child was not asked for. The
    # one exception is the letter the camera reported on a wrong turn.
    target = body.get("letter")
    allowed = {c for c in (body.get("word") or "")} | {target, body.get("detected")}
    for named in LETTER_WORD.findall(say):
        if named not in allowed:
            bad.append(f"names letter {named!r}, which was never asked for")

    if turn in ("teach", "prompt", "right") and target and target not in say:
        warn.append(f"never mentions the letter {target}")

    if turn == "word":
        word = (body.get("word") or "").upper()
        flat = re.sub(r"[^A-Z]", "", say.upper())
        if word and word not in flat:
            bad.append(f"the word turn never says {word!r}")
        elif word and not re.search(r"\b" + r"[\s.-]+".join(word) + r"\b",
                                    say.upper()):
            # Saying "cat" is not the same as saying "C-A-T, cat". This is a
            # spelling game: the letters are the content, and the word turn is
            # where the child first hears which ones are coming.
            warn.append("says the word but never spells it out")

    if turn == "too_few_hands" and not re.search(r"both|two|other", say, re.I):
        bad.append("does not ask for the second hand")
    if turn == "too_many_hands" and body.get("need") == 1 \
            and not re.search(r"one|single|down", say, re.I):
        bad.append("does not ask for one hand")

    if turn == "hint_offer" and "?" not in say:
        bad.append("the hint offer is not a question, so a nod cannot answer it")

    if turn == "report":
        r = data.get("report")
        if not isinstance(r, dict):
            bad.append("no `report` object - the output parser is stripping it")
        else:
            for k in ("stars", "headline", "strengths", "practice",
                      "note_for_grownups"):
                if k not in r:
                    bad.append(f"report missing {k!r}")
            if isinstance(r.get("stars"), int) and not 1 <= r["stars"] <= 3:
                bad.append(f"stars {r['stars']} outside 1-3")
    elif "report" in data:
        warn.append("a report object on a turn that is not the report")

    return bad, warn


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--turn", help="only this one")
    ap.add_argument("--alphabet", default="auslan")
    ap.add_argument("--timeout", type=float, default=30)
    ap.add_argument("--gap", type=float, default=4.5, metavar="SECS",
                    help="seconds between requests. Hosted models meter by the "
                         "minute - the free Gemini tier is about 15 - and a "
                         "checker that ignores that measures the quota rather "
                         "than the prompt (default: 4.5, ~13 a minute)")
    a = ap.parse_args()

    names = [a.turn] if a.turn else list(TURNS)
    tally = defaultdict(lambda: {"ok": 0, "bad": 0, "warn": 0, "err": 0})
    problems = []
    n_req = len(names) * a.runs
    print(f"{a.url}\n{len(names)} turns x {a.runs} runs = {n_req} requests, "
          f"{a.gap}s apart (~{n_req * a.gap / 60:.0f} min)\n")

    import time
    first = True
    for name in names:
        if name not in TURNS:
            sys.exit(f"no such turn: {name}. Try: {', '.join(TURNS)}")
        spec = dict(TURNS[name])
        body = {"turn": spec.pop("turn", name), "alphabet": a.alphabet,
                "session": "checker", "recent": [], **spec}
        line = f"  {name:16s}"
        for _ in range(a.runs):
            if not first:
                time.sleep(a.gap)
            first = False
            try:
                req = urllib.request.Request(
                    a.url, data=json.dumps(body).encode(), method="POST",
                    headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=a.timeout) as r:
                    raw = r.read().decode("utf-8", "replace")
            except urllib.error.HTTPError as e:
                tally[name]["err"] += 1
                line += " E"
                hint = (" - almost certainly the model's per-minute quota; "
                        "raise --gap" if e.code >= 500 else "")
                problems.append((name, f"HTTP {e.code}{hint}", ""))
                continue
            except (urllib.error.URLError, OSError) as e:
                tally[name]["err"] += 1
                line += " E"
                problems.append((name, f"HTTP {e}", ""))
                continue
            data = unwrap(raw)
            if data is None:
                tally[name]["err"] += 1
                line += " E"
                problems.append((name, "unparseable", raw[:120]))
                continue
            bad, warn = check(name, body, data)
            if bad:
                tally[name]["bad"] += 1
                line += " X"
                problems.append((name, "; ".join(bad), data.get("say", "")))
            elif warn:
                tally[name]["warn"] += 1
                line += " !"
                problems.append((name, "; ".join(warn), data.get("say", "")))
            else:
                tally[name]["ok"] += 1
                line += " ."
        print(line, flush=True)

    tot = {k: sum(t[k] for t in tally.values())
           for k in ("ok", "bad", "warn", "err")}
    n = sum(tot.values())
    print(f"\n  . ok {tot['ok']}   ! odd {tot['warn']}   "
          f"X wrong {tot['bad']}   E failed {tot['err']}   of {n}")

    if problems:
        print("\nwhat went wrong")
        seen = set()
        for name, why, said in problems:
            key = (name, why)
            if key in seen:
                continue
            seen.add(key)
            print(f"  {name:16s} {why}")
            if said:
                print(f"  {'':16s}   -> {said[:110]}")
    return 1 if tot["bad"] or tot["err"] else 0


if __name__ == "__main__":
    sys.exit(main())
