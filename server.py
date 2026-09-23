#!/usr/bin/env python3
"""The one process the browser talks to: files, voice, telemetry, n8n.

    ./run.sh                      # then open http://localhost:8770

Four endpoints, and the reason each one is here rather than in the page:

**/api/say - the voice.** Pocket TTS is a PyTorch model; it cannot run in a
browser, and loading it costs about fifteen seconds. So it is loaded once at
startup on a background thread and kept warm for the life of the process. Lines
are cached on disk by their text, because a child hears "Now it's your turn!"
once per letter and there is no reason to synthesise it twice - after the first
run of a session the wizard answers from cache in about a millisecond.

**/api/wizard - the words.** n8n writes what the wizard says; this only forwards
the game's state to the webhook and hands back the JSON. It is a proxy rather
than a direct call from the page because the webhook needs a token that must not
sit in a page anyone can view-source, and because a browser calling another
origin needs CORS the n8n instance would have to be configured for. With no
webhook set, `fallback.py` answers instead so the game still runs.

**/api/events - what the camera sees.** `sign-language-demo` already posts its
telemetry to any URL you give it. That lands on /api/telemetry here and is
relayed to the page over Server-Sent Events, which is one-way and reconnects on
its own - the page never asks for telemetry, it just receives it.

**Everything is optional.** No n8n, no Pocket TTS, no camera: the game still
starts, says so on the status line, and falls back to scripted lines, the
browser's own speech synthesis, and the keyboard. A demo that only runs when
four things are up is a demo that does not run.
"""
import argparse
import hashlib
import json
import os
import queue
import re
import threading
import time
import traceback
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import fallback

HERE = Path(__file__).resolve().parent
WEB = HERE / "web"
CACHE = HERE / ".voice-cache"
VENV_TTS = HERE.parent / ".venv-pockettts"

N8N_URL = os.environ.get("N8N_WEBHOOK_URL", "").strip()
N8N_TOKEN = os.environ.get("N8N_WEBHOOK_TOKEN", "").strip()
# Generous, because the page no longer asks for a line at the moment it needs
# one - it asks early and caches. A slow webhook now costs nothing, so the only
# thing a short timeout would buy is throwing away answers that were coming.
N8N_TIMEOUT = float(os.environ.get("N8N_TIMEOUT_S", "22"))
VOICE = os.environ.get("WIZARD_VOICE", "george").strip()
TTS_ON = os.environ.get("WIZARD_TTS", "1") != "0"

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json",
        ".png": "image/png", ".webm": "video/webm", ".wav": "audio/wav",
        ".svg": "image/svg+xml", ".gif": "image/gif", ".ico": "image/x-icon"}


# --------------------------------------------------------------------------
# voice
# --------------------------------------------------------------------------
class Voice:
    """Pocket TTS, loaded once and kept warm, with a disk cache in front."""

    def __init__(self, name):
        self.name = name
        self.state = "off" if not TTS_ON else "loading"
        self.error = None
        self.model = self.speaker = None
        self.lock = threading.Lock()
        CACHE.mkdir(exist_ok=True)
        if TTS_ON:
            threading.Thread(target=self._load, daemon=True).start()

    def _load(self):
        t0 = time.time()
        try:
            from pocket_tts import TTSModel
            self.model = TTSModel.load_model()
            self.speaker = self.model.get_state_for_audio_prompt(self.name)
            self.state = "ready"
            print(f"  voice   ready ({self.name}, {time.time()-t0:.0f}s)", flush=True)
        except Exception as e:                                   # noqa: BLE001
            self.state, self.error = "failed", f"{type(e).__name__}: {e}"
            print(f"  voice   unavailable - {self.error}\n"
                  f"          the page will use the browser's own speech instead",
                  flush=True)

    def path_for(self, text):
        key = hashlib.sha1(f"{self.name} {text}".encode()).hexdigest()[:16]
        return CACHE / f"{key}.wav"

    def render(self, text):
        """-> (path, 'cache'|'tts') or (None, reason). Never raises."""
        out = self.path_for(text)
        if out.exists():
            return out, "cache"
        if self.state != "ready":
            return None, self.state
        try:
            import scipy.io.wavfile
            with self.lock:                    # one generation at a time
                audio = self.model.generate_audio(self.speaker, text)
            tmp = out.with_suffix(".part")
            scipy.io.wavfile.write(tmp, self.model.sample_rate, audio.numpy())
            tmp.replace(out)
            return out, "tts"
        except Exception as e:                                   # noqa: BLE001
            self.error = f"{type(e).__name__}: {e}"
            return None, "failed"

    def warm(self, lines):
        """Synthesise the fixed lines in the background, newest request first.

        The greeting is spoken about two seconds after the page loads, and a
        cold generation takes longer than that, so the first thing a visitor
        hears would be silence followed by a late wizard. Pre-rendering the
        handful of lines that never change costs nothing after the first run.
        """
        def run():
            while self.state == "loading":
                time.sleep(0.5)
            if self.state != "ready":
                return
            todo = [t for t in lines if not self.path_for(t).exists()]
            for n, text in enumerate(todo, 1):
                self.render(text)
                print(f"  voice   pre-rendered {n}/{len(todo)}", end="\r", flush=True)
            if todo:
                print(f"  voice   pre-rendered {len(todo)} lines        ", flush=True)
        threading.Thread(target=run, daemon=True).start()


# --------------------------------------------------------------------------
# telemetry fan-out
# --------------------------------------------------------------------------
class Telemetry:
    """One inbox from the camera, N outboxes to whatever pages are open."""

    def __init__(self):
        self.clients = set()
        self.lock = threading.Lock()
        self.last = None
        self.count = 0

    def publish(self, rec):
        self.count += 1
        self.last = rec
        line = f"data: {json.dumps(rec)}\n\n".encode()
        with self.lock:
            dead = set()
            for q in self.clients:
                try:
                    q.put_nowait(line)
                except queue.Full:
                    dead.add(q)            # a page that stopped reading
            self.clients -= dead

    def subscribe(self):
        q = queue.Queue(maxsize=64)
        with self.lock:
            self.clients.add(q)
        return q

    def unsubscribe(self, q):
        with self.lock:
            self.clients.discard(q)


# --------------------------------------------------------------------------
# the self-view
# --------------------------------------------------------------------------
class Camera:
    """The latest frame from the recogniser, and a way to watch it go by.

    The page cannot open the webcam itself while the recogniser is running - a
    V4L2 device opens once, and the second `VideoCapture` just fails. So the
    frames come the other way: the recogniser POSTs the picture it already drew
    to /api/frame, and this hands it out as MJPEG.

    That turns out to be the better picture anyway. The recogniser's frame has
    the hand landmarks drawn on it, so a child comparing their hand to the card
    is seeing what the classifier sees rather than a plain mirror - which is the
    difference between "my hand looks like that" and "the model agrees".

    Only the newest frame is kept. A viewer that falls behind should skip to the
    present, not play catch-up through a backlog of stale hands.
    """

    def __init__(self):
        self.frame = None
        self.seq = 0
        self.at = 0.0
        self.cond = threading.Condition()

    def put(self, jpeg):
        with self.cond:
            self.frame = jpeg
            self.seq += 1
            self.at = time.time()
            self.cond.notify_all()

    def wait(self, seen, timeout=2.0):
        """Block until a frame newer than `seen` arrives. -> (jpeg, seq) or None."""
        with self.cond:
            if self.seq <= seen:
                self.cond.wait(timeout)
            if self.frame is None or self.seq <= seen:
                return None
            return self.frame, self.seq

    @property
    def live(self):
        return self.frame is not None and time.time() - self.at < 3.0


# --------------------------------------------------------------------------
# n8n
# --------------------------------------------------------------------------
def ask_n8n(payload):
    """Forward one turn to the webhook. -> (dict, source). Never raises."""
    # `local` means the page already knows it cannot wait - a prefetch that did
    # not land in time. Going to the webhook now would just miss the deadline
    # again; the script here answers in under a millisecond and says something
    # specific, which is the whole reason it exists.
    if payload.get("local") or not N8N_URL:
        return fallback.answer(payload), "fallback"
    body = json.dumps(payload).encode()
    headers = {"Content-Type": "application/json"}
    if N8N_TOKEN:
        headers["x-wizard-token"] = N8N_TOKEN
    raw = _post(body, headers)
    if raw is None:
        return fallback.answer(payload), "fallback"

    data = _loads_loose(raw)
    if data is None:
        print(f"  n8n     unparseable answer: {raw[:160]!r}", flush=True)
        return fallback.answer(payload), "fallback"
    # n8n hands back a one-item array as often as an object, and often wraps
    # the real body in "json" or "output". Unwrap rather than make the page
    # care which node happened to be last in the workflow.
    if isinstance(data, list):
        data = data[0] if data else {}
    for key in ("json", "output", "body", "data"):
        if isinstance(data, dict) and set(data) == {key} and isinstance(data[key], (dict, str)):
            data = _loads_loose(data[key]) if isinstance(data[key], str) else data[key]
            if data is None:
                return fallback.answer(payload), "fallback"
    if not isinstance(data, dict) or "say" not in data:
        merged = fallback.answer(payload)
        merged.update(data if isinstance(data, dict) else {})
        return merged, "n8n+fallback"
    return data, "n8n"


def _post(body, headers, tries=2):
    """POST to the webhook, retrying a fast 5xx once. -> str or None.

    A workflow that fails in under a second failed before it reached the model -
    a rate limit, a credential hiccup, an expired session. Those are transient
    and worth one retry. A failure that took ten seconds is the model itself and
    retrying only doubles the wait, so it is not retried.
    """
    for attempt in range(tries):
        t0 = time.time()
        req = urllib.request.Request(N8N_URL, data=body, headers=headers,
                                     method="POST")
        try:
            with urllib.request.urlopen(req, timeout=N8N_TIMEOUT) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            took = time.time() - t0
            detail = e.read()[:120].decode("utf-8", "replace")
            fast = took < 2.0 and 500 <= e.code < 600
            print(f"  n8n     HTTP {e.code} after {took:.1f}s: {detail}", flush=True)
            if not (fast and attempt < tries - 1):
                return None
            time.sleep(0.8)
        except (urllib.error.URLError, OSError) as e:
            print(f"  n8n     unreachable ({e}); using the local script", flush=True)
            return None
    return None


def _loads_loose(raw):
    """JSON, even when a model wrapped it in a ```json fence or chatter."""
    if isinstance(raw, (dict, list)):
        return raw
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        pass
    m = re.search(r"\{.*\}", str(raw), re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


# --------------------------------------------------------------------------
# http
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "WizardAcademy"

    voice: Voice
    telemetry: Telemetry
    camera: Camera

    def log_message(self, fmt, *a):
        pass                                   # the console belongs to the game

    # -- helpers ---------------------------------------------------------
    def _send(self, code, body=b"", ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj).encode())

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        return _loads_loose(self.rfile.read(n).decode("utf-8", "replace")) or {}

    # -- routes ----------------------------------------------------------
    def do_GET(self):
        path = self.path.split("?")[0]
        try:
            if path == "/api/config":
                return self._json({
                    "n8n": bool(N8N_URL),
                    "n8n_url": _redact(N8N_URL),
                    "voice": {"state": self.voice.state, "name": self.voice.name,
                              "error": self.voice.error},
                    "telemetry": {"received": self.telemetry.count,
                                  "listeners": len(self.telemetry.clients)},
                    "camera": {"live": self.camera.live, "frames": self.camera.seq},
                })
            if path == "/api/events":
                return self._sse()
            if path == "/api/camera.mjpg":
                return self._mjpeg()
            return self._static(path)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:                                        # noqa: BLE001
            traceback.print_exc()
            self._json({"error": "server"}, 500)

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            if path == "/api/wizard":
                payload = self._body()
                t0 = time.time()
                data, source = ask_n8n(payload)
                data["_source"] = source
                data["_ms"] = int((time.time() - t0) * 1000)
                return self._json(data)

            if path == "/api/say":
                text = (self._body().get("text") or "").strip()
                if not text:
                    return self._json({"error": "no text"}, 400)
                path_, how = self.voice.render(text)
                if path_ is None:
                    return self._json({"ok": False, "reason": how}, 503)
                return self._json({"ok": True, "url": f"/voice/{path_.name}",
                                   "source": how})

            if path == "/api/frame":
                n = int(self.headers.get("Content-Length") or 0)
                if n:
                    self.camera.put(self.rfile.read(n))
                return self._send(204)

            if path == "/api/telemetry":
                self.telemetry.publish(self._body())
                return self._json({"ok": True})

            return self._json({"error": "not found"}, 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:                                        # noqa: BLE001
            traceback.print_exc()
            self._json({"error": "server"}, 500)

    # -- server-sent events ----------------------------------------------
    def _sse(self):
        # Same framing problem as the MJPEG stream above: an unbounded body
        # needs the connection to delimit it. Browsers are forgiving about
        # text/event-stream, but claiming keep-alive on a response nothing can
        # measure is wrong however well it happens to work.
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")   # in case a proxy is added
        self.send_header("Connection", "close")
        self.end_headers()
        q = self.telemetry.subscribe()
        try:
            self.wfile.write(b": open\n\n")
            self.wfile.flush()
            while True:
                try:
                    self.wfile.write(q.get(timeout=15))
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")   # keep proxies from closing it
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.telemetry.unsubscribe(q)

    # -- the self-view ---------------------------------------------------
    def _mjpeg(self):
        """multipart/x-mixed-replace, which <img src> plays natively.

        `Connection: close` is not optional here, and leaving it out is why the
        picture appeared in some browsers and not in Chrome. This response has
        no Content-Length and is not chunked - it runs until the socket does -
        and under HTTP/1.1 the only way to say that is to close the connection
        at the end. Without it the server is implicitly claiming keep-alive, so
        a strict client has no way to know where the body ends and waits for a
        message that never completes. A lenient one guesses correctly; Chrome
        does not guess.
        """
        self.close_connection = True        # and actually mean it
        self.send_response(200)
        self.send_header("Content-Type",
                         "multipart/x-mixed-replace; boundary=wizardframe")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        seen = 0
        try:
            while True:
                got = self.camera.wait(seen)
                if got is None:
                    continue                 # no camera yet; hold the connection
                jpeg, seen = got
                self.wfile.write(b"--wizardframe\r\nContent-Type: image/jpeg\r\n"
                                 + f"Content-Length: {len(jpeg)}\r\n\r\n".encode()
                                 + jpeg + b"\r\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    # -- files -----------------------------------------------------------
    def _static(self, path):
        if path.startswith("/voice/"):
            root, rel = CACHE, path[len("/voice/"):]
        else:
            root, rel = WEB, path.lstrip("/") or "index.html"
        try:
            target = (root / rel).resolve()
            target.relative_to(root.resolve())
        except (ValueError, OSError):
            return self._json({"error": "not found"}, 404)
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            return self._json({"error": "not found"}, 404)

        data = target.read_bytes()
        ctype = MIME.get(target.suffix, "application/octet-stream")
        # Assets are content-addressed by the build, the page is not.
        cache = "public, max-age=86400" if target.suffix in (
            ".webm", ".png", ".wav", ".gif") else "no-store"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.send_header("Accept-Ranges", "none")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)


def _redact(url):
    return re.sub(r"//[^@/]+@", "//***@", url) if url else ""


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8770)))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-tts", action="store_true", help="skip loading Pocket TTS")
    a = ap.parse_args()

    global TTS_ON
    TTS_ON = TTS_ON and not a.no_tts

    print("\n  Wizard Academy")
    print(f"  page    http://{a.host}:{a.port}")
    print(f"  n8n     {_redact(N8N_URL) if N8N_URL else 'not set - using the local script'}")
    print(f"  voice   {'Pocket TTS, loading in the background' if TTS_ON else 'off'}")
    print(f"  camera  post telemetry to http://{a.host}:{a.port}/api/telemetry")
    print(f"          ../sign-language-demo/run.sh all --alphabet auslan --hands 2 \\")
    print(f"              --state-every 0.2 --webhook http://{a.host}:{a.port}/api/telemetry \\")
    print(f"              --mirror-to http://{a.host}:{a.port}/api/frame")
    print()

    Handler.voice = Voice(VOICE)
    Handler.telemetry = Telemetry()
    Handler.camera = Camera()
    Handler.voice.warm(fallback.FIXED_LINES)

    httpd = ThreadingHTTPServer((a.host, a.port), Handler)
    httpd.daemon_threads = True
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  bye")


if __name__ == "__main__":
    main()
