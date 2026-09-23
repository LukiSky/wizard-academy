/* Seeing your own hands.
 *
 * Copying a handshape off a card is hard without watching what your hand is
 * actually doing, so the child gets a view of themselves. Two ways to get one,
 * and which is available depends on who has the camera:
 *
 * **The recogniser's frame**, when it is running. A V4L2 device opens exactly
 * once, so while `sign-language-demo` has the webcam the page physically cannot
 * open it - `getUserMedia` fails with NotReadableError. Instead the recogniser
 * posts the frame it already drew and the server relays it as MJPEG, which an
 * <img> plays natively with no decoding on our side. This is also the *better*
 * picture: it carries the hand landmarks, so a child is comparing their hand to
 * the card while seeing what the classifier sees.
 *
 * **The browser's own camera**, when nothing else has it - keyboard practice,
 * or a machine with no recogniser running. Full framerate, and mirrored,
 * because an unmirrored self-view makes people move the wrong hand.
 *
 * The recogniser wins when both are possible: its frame is more useful, and
 * opening a second camera would be a second camera light for no reason.
 *
 * Four sizes rather than a checkbox, and the fourth is the one that matters for
 * anybody watching over a shoulder:
 *
 *   small  out of the way in the corner
 *   large  for when a letter is difficult and the hand needs a proper look -
 *          but it covers the wizard, which is the point and also the problem
 *   side   docked in its own column. Nothing overlaps: the wizard, the word and
 *          the hands are all visible at once, which is what you want when
 *          demonstrating the thing to somebody, or checking whether the reader
 *          is seeing what you think it is
 *   off    for when a child finds their own face more interesting than the
 *          wizard, which they will
 *
 * The choice is remembered. It is a preference about how somebody learns and
 * how somebody watches, not a per-session whim.
 */
const SIZES = ['small', 'large', 'side', 'off'];

export class SelfView {
  constructor(el, { onSize = null } = {}) {
    this.el = el;
    this.img = el.querySelector('img');
    this.video = el.querySelector('video');
    this.label = el.querySelector('.sv-label');
    this.onSize = onSize;
    this.mode = 'none';                 // 'mirror' | 'webcam' | 'none'
    this.stream = null;

    this.size = localStorage.getItem('wa-selfview') || 'small';
    if (!SIZES.includes(this.size)) this.size = 'small';
    this.apply();

    el.querySelector('.sv-resize').onclick = (e) => { e.stopPropagation(); this.cycle(); };
    el.querySelector('.sv-close').onclick = (e) => { e.stopPropagation(); this.set('off'); };
    el.onclick = () => { if (this.size === 'small') this.set('large'); };
  }

  cycle() {
    this.set(SIZES[(SIZES.indexOf(this.size) + 1) % SIZES.length]);
  }

  set(size) {
    this.size = size;
    localStorage.setItem('wa-selfview', size);
    this.apply();
  }

  apply() {
    this.el.dataset.size = this.size;
    // The docked column is a change to the page layout, not just to this
    // panel, so the body has to know about it too.
    document.body.classList.toggle('side-camera',
      this.size === 'side' && this.mode !== 'none');
    this.el.hidden = this.size === 'off' || this.mode === 'none';
    this.onSize?.(this.size);

    // Switching off has to actually stop the stream, not just hide it.
    //
    // A hidden webcam stream is still a lit camera light, which is not a thing
    // to leave on in a child's room because a panel is collapsed. And a hidden
    // <img> pointed at an MJPEG endpoint carries on downloading and decoding
    // frames forever, holding one of the six connections a browser allows per
    // origin - which, with the event stream holding a second, is how three
    // open tabs stop the whole page loading anything at all.
    if (this.size === 'off') {
      this.stopWebcam();
      this.stopMirror();
    } else {
      if (this.mode === 'webcam' && !this.stream) this.startWebcam();
      if (this.mode === 'mirror' && !this.img.getAttribute('src')) this.startMirror();
    }
  }

  /* Pick a source. Called once at boot and again whenever the recogniser
   * appears or disappears, since it can be started after the page is open. */
  async attach({ mirrorLive }) {
    if (mirrorLive) {
      if (this.mode !== 'mirror') {
        this.stopWebcam();
        this.mode = 'mirror';
        this.video.hidden = true;
        this.label.textContent = 'what the wizard sees';
        if (this.size !== 'off') this.startMirror();
      }
    } else if (this.mode !== 'webcam') {
      this.stopMirror();
      const ok = await this.startWebcam();
      if (!ok) { this.mode = 'none'; this.el.hidden = true; return; }
      this.mode = 'webcam';
      this.video.hidden = false;
      this.label.textContent = 'you';
    }
    // Through apply() rather than by setting `hidden` here: the docked layout
    // is a body class, and a source arriving after the page loaded has to
    // bring the column with it.
    this.apply();
  }

  async startWebcam() {
    if (this.stream || this.size === 'off') return !!this.stream;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play().catch(() => {});
      return true;
    } catch {
      // NotReadableError (the recogniser has it), NotAllowedError (declined),
      // or no camera at all. None of them are worth a dialog: the game is
      // entirely playable without a self-view.
      this.stream = null;
      return false;
    }
  }

  startMirror() {
    // A fresh query each time, so switching back on opens a new stream rather
    // than resuming a connection the browser may already have torn down.
    this.img.src = `/api/camera.mjpg?t=${Date.now()}`;
    this.img.hidden = false;
  }

  stopMirror() {
    // Clearing src is what actually closes the socket; `hidden` does not.
    this.img.removeAttribute('src');
    this.img.hidden = true;
  }

  stopWebcam() {
    if (!this.stream) return;
    for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.video.srcObject = null;
  }
}
