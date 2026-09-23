# The n8n side

n8n writes what the wizard says. That is the whole job — it never decides what
happened, it decides what to say about it.

The split is deliberate. Timing and geometry (was that an A, has the hand
stopped moving, has it been ten seconds) live in `web/js/rules.js` where they
can be tested and must be exact. Words live here, where they can be rewritten
twenty times over a weekend without touching the game.

## The contract

One POST per turn, one line back.

```
POST  <your webhook>
      Content-Type: application/json
      x-wizard-token: <optional, from N8N_WEBHOOK_TOKEN>
```

**In:**

```json
{
  "turn": "wrong",
  "session": "a1b2c3d4",
  "word": "CAT",
  "letter": "A",
  "index": 1,
  "attempts": 2,
  "detected": "S",
  "expression": "confused"
}
```

**Out:**

```json
{
  "say": "Nearly! For A, rest your thumb on the side, not across the front.",
  "action": "try_again_alt"
}
```

`say` is the only required field. `caption` overrides the on-screen text if it
should differ from the spoken line. `action` names one of the 19 animations
(listed in `wizard_prompt.xml`); an unknown name is ignored rather than
breaking the character. `report` appears only on the final turn.

`wizard_prompt.xml` is the system prompt. It documents every turn, every
animation, and the report shape, with the reasoning for each rule — give it to
the model as-is.

## Wiring it up

1. **Webhook** node — POST, "Respond to Webhook" as the response mode.
2. **AI Agent** — `wizard_prompt.xml` as the system message,
   `{{ JSON.stringify($json.body) }}` as the user message. Any fast chat model
   works; the turns are short and latency is the thing that matters. Gemini
   answers these in 1–2 seconds.
3. **Respond to Webhook** — return the model's JSON.

### If you use a structured output parser

Set it to **manual schema** and paste `output_schema.json`, not an example
object. The reason is the `report` turn: an example-based parser infers every
key in the example as *required*, so either

- the example has no `report` — and the parser silently strips it from the one
  turn that needs it, which is what happened here; or
- the example has `report` — and now every turn is forced to invent one.

`output_schema.json` marks only `say` as required and `report` as an optional
nested object, which is the only shape that serves both.

Then point the game at it:

```bash
echo 'N8N_WEBHOOK_URL=https://your-n8n/webhook/wizard' >> ../.env
```

`workflow.json` in this folder is that graph, ready to import — set your own
credentials and webhook path after importing.

## Latency is a design constraint, not a detail

The server waits **3.5 seconds** for a reply and then says its own line instead
(`fallback.py`); the page allows the server 8, so the local script always gets
to speak rather than the page going silent.

That is not a generous timeout and it is not meant to be. The wizard is
answering a child who is holding a handshape in the air. A clever line that
arrives four seconds late is worse than a plain one that arrives now.

Two consequences worth designing around:

- Keep the chain short. One model call. Every extra node is on the critical path
  of a conversation.
- Ask for short output. The prompt caps lines at about fifteen words, which also
  caps how long generation takes.
- Raise `N8N_TIMEOUT_S` if your model is slower, but keep it under 8 seconds or
  the page gives up on the server first.

If the webhook is slow, unreachable, or returns something unparseable, the game
does not fail — it uses the local script and carries on, and the rail in the
page shows `fallback` instead of `n8n` on that turn so you can see it happen.

## What the server forgives

`server.py` unwraps the shapes n8n tends to produce, so the workflow does not
have to be tidy:

- a one-element array around the object
- a single `json`, `output`, `body` or `data` key wrapping the real answer
- a JSON object inside a ```json fence, or with chatter around it
- a reply with extra keys, or missing `say` (the local line fills in, and your
  keys are merged on top)

## Turns

| turn | when | key fields |
|---|---|---|
| `greeting` | the child arrives | — |
| `word` | a word has been chosen | `word` |
| `teach` | demonstrating one letter | `letter`, `index` |
| `prompt` | handing over to the child | `letter` |
| `right` | correct letter | `letter`, `index`, `attempts`, `spelled`, `last` |
| `wrong` | shape did not match | `letter`, `detected`, `attempts`, `expression` |
| `two_hands` | second hand in frame | `letter` |
| `look_back` | looking away | `letter` |
| `idle` | no hands for 15s | `letter`, `second` |
| `hint_offer` | offering the spell book | `letter`, `why` |
| `hint_show` | they said yes | `letter` |
| `finale` | word complete | `word`, `expression`, `happy` |
| `report` | session over | `word`, `seconds`, `letters[]` |

The local script in `fallback.py` handles all of them. If you add a turn to the
game, add it there too — that file is the executable copy of this table.
