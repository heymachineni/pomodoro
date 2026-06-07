/* =====================================================================
 * Pomodoro — minimal fullscreen timer
 *
 * Behavior model:
 *   - The full perimeter is the "time bank". The orange depletes
 *     clockwise from top-center. At 00:00 the orange is gone; the
 *     subtle inactive-color track remains.
 *   - Any adjustment (wheel / swipe / arrow key) auto-starts the
 *     countdown. Adjustments while running shift the endpoint live.
 *   - Tapping the screen does nothing. The timer cannot be paused.
 *   - Esc resets to idle.
 *   - First interaction requests fullscreen; running timers keep
 *     the screen awake via the Screen Wake Lock API.
 * ===================================================================== */

(() => {
  "use strict";

  // ------------------------------- Config ------------------------------ //

  const MIN_MINUTES = 1;
  const MAX_MINUTES = 60;
  const DEFAULT_MINUTES = 25;
  const STORAGE_KEY = "pomodoro.duration";

  const STROKE = 8;
  const EDGE_INSET = 8;
  const CORNER_RADIUS = 26;

  const DIGIT_DURATION = 280; // keep in sync with --digit-dur in CSS

  // ------------------------------ Elements ----------------------------- //

  const body = document.body;
  const stage = document.querySelector(".stage");
  const svg = document.querySelector(".border");
  const trackPath = svg.querySelector(".border-track");
  const fillPath = svg.querySelector(".border-fill");
  const timeEl = document.getElementById("time");
  const trackEl = document.getElementById("track");
  const timelineEl = document.querySelector(".timeline");
  const tlabel = document.getElementById("tlabel");
  const srTime = document.getElementById("sr-time");

  // ------------------------------- State ------------------------------- //

  /** @type {"idle"|"running"|"complete"} */
  let mode = "idle";
  let durationMs = loadDuration() * 60_000;
  let remainingMs = durationMs;
  let endAt = 0;

  let perimeterLength = 0;
  let viewportSize = { w: 0, h: 0 };
  let resizeRaf = 0;

  /** @type {WakeLockSentinel|null} */
  let wakeLock = null;

  // ----------------------------- Persistence --------------------------- //

  function loadDuration() {
    try {
      let raw = localStorage.getItem(STORAGE_KEY);
      if (raw == null) raw = localStorage.getItem("focus.duration");
      const v = raw == null ? NaN : parseInt(raw, 10);
      if (Number.isFinite(v) && v >= MIN_MINUTES && v <= MAX_MINUTES) return v;
    } catch (_) {}
    return DEFAULT_MINUTES;
  }

  function saveDuration(min) {
    try {
      localStorage.setItem(STORAGE_KEY, String(min));
    } catch (_) {}
  }

  // ------------------------------ Border ------------------------------- //

  function buildPerimeter(w, h) {
    const inset = EDGE_INSET + STROKE / 2;
    const r = Math.min(CORNER_RADIUS, Math.min(w, h) / 2 - inset - 4);
    const x0 = inset;
    const y0 = inset;
    const x1 = w - inset;
    const y1 = h - inset;
    const cx = w / 2;

    return [
      `M ${cx} ${y0}`,
      `H ${x1 - r}`,
      `A ${r} ${r} 0 0 1 ${x1} ${y0 + r}`,
      `V ${y1 - r}`,
      `A ${r} ${r} 0 0 1 ${x1 - r} ${y1}`,
      `H ${x0 + r}`,
      `A ${r} ${r} 0 0 1 ${x0} ${y1 - r}`,
      `V ${y0 + r}`,
      `A ${r} ${r} 0 0 1 ${x0 + r} ${y0}`,
      `H ${cx}`,
    ].join(" ");
  }

  function refreshBorder() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (w === viewportSize.w && h === viewportSize.h) return;
    viewportSize = { w, h };

    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const d = buildPerimeter(w, h);
    trackPath.setAttribute("d", d);
    fillPath.setAttribute("d", d);
    perimeterLength = fillPath.getTotalLength();
    setBorderProgress(currentProgress());
  }

  /**
   * progress 0 → 1 (elapsed / duration)
   * Visible orange = remaining portion of the path, drawn from
   * (progress * pl) through (pl), via dasharray + dashoffset.
   */
  function setBorderProgress(p) {
    const clamped = Math.max(0, Math.min(1, p));
    const visible = (1 - clamped) * perimeterLength;
    fillPath.setAttribute("stroke-dasharray", `${visible} ${perimeterLength}`);
    fillPath.setAttribute("stroke-dashoffset", `${-clamped * perimeterLength}`);
  }

  // --------------------------- Timer math ------------------------------ //

  function currentProgress() {
    if (durationMs <= 0) return 0;
    const elapsed = durationMs - remainingMs;
    return Math.max(0, Math.min(1, elapsed / durationMs));
  }

  function minutesValue() {
    return Math.round(durationMs / 60_000);
  }

  // --------------------------- Rolling digits -------------------------- //

  /**
   * Each strip's structure: [wrap_below=max, 0, 1, ..., max, wrap_above=0].
   * `prev` tracks the canonical digit value so we can detect wraparounds.
   */
  const strips = [
    { el: query("[data-pos='m10']"), mod: 7, max: 6, prev: -1, snap: 0 },
    { el: query("[data-pos='m1']"),  mod: 10, max: 9, prev: -1, snap: 0 },
    { el: query("[data-pos='s10']"), mod: 6, max: 5, prev: -1, snap: 0 },
    { el: query("[data-pos='s1']"),  mod: 10, max: 9, prev: -1, snap: 0 },
  ];

  function query(sel) {
    return /** @type {HTMLElement} */ (document.querySelector(sel));
  }

  function buildStrips() {
    for (const s of strips) {
      // [max, 0, 1, ..., max, 0]
      const items = [s.max];
      for (let i = 0; i <= s.max; i++) items.push(i);
      items.push(0);
      s.el.innerHTML = items.map((n) => `<span>${n}</span>`).join("");
    }
  }

  function snapStripTo(s, n) {
    s.el.classList.add("snap");
    s.el.style.setProperty("--n", String(n));
    // force reflow so the no-transition state is committed
    void s.el.offsetWidth;
    s.el.classList.remove("snap");
  }

  function setStripDigit(s, next, immediate) {
    if (s.prev === next && !immediate) return;
    if (immediate || s.prev === -1) {
      snapStripTo(s, next);
      s.prev = next;
      return;
    }

    // If a snap-back from a previous wraparound is still pending, finalize
    // it instantly — otherwise the new transition would start from the
    // wrap row and look like a long reverse spin.
    if (s.snap) {
      clearTimeout(s.snap);
      s.snap = 0;
      snapStripTo(s, s.prev);
    }

    const prev = s.prev;
    let target = next;

    // Detect adjacent wraparounds (only ±1 boundary crossings)
    if (prev === 0 && next === s.max) {
      target = -1; // wrap below: render the "max" duplicate above row 0
    } else if (prev === s.max && next === 0) {
      target = s.mod; // wrap above: render the "0" duplicate after row max
    }

    s.el.style.setProperty("--n", String(target));
    s.prev = next;

    if (target !== next) {
      // Snap silently to canonical position once the visual transition
      // has had time to land on the wrap row.
      s.snap = setTimeout(() => {
        s.snap = 0;
        snapStripTo(s, next);
      }, DIGIT_DURATION + 30);
    }
  }

  function setDigits(remainingMs, immediate) {
    const totalSec = Math.ceil(Math.max(0, remainingMs) / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    setStripDigit(strips[0], Math.floor(m / 10), immediate);
    setStripDigit(strips[1], m % 10, immediate);
    setStripDigit(strips[2], Math.floor(s / 10), immediate);
    setStripDigit(strips[3], s % 10, immediate);
  }

  // ---------------------------- Render loop ---------------------------- //

  function frame() {
    if (mode === "running") {
      remainingMs = Math.max(0, endAt - performance.now());
      if (remainingMs === 0) complete();
    }
    setDigits(remainingMs, false);
    setBorderProgress(currentProgress());
    requestAnimationFrame(frame);
  }

  // ------------------------------ Modes -------------------------------- //

  function setMode(next) {
    mode = next;
    body.dataset.state = next;
    if (next === "running") {
      acquireWakeLock();
    } else {
      releaseWakeLock();
    }
  }

  function complete() {
    remainingMs = 0;
    setMode("complete");
    srTime.textContent = "Timer complete.";
  }

  function resetIdle() {
    durationMs = minutesValue() * 60_000;
    remainingMs = durationMs;
    setMode("idle");
    setDigits(remainingMs, true);
    paintTimeline();
  }

  // --------------------------- Adjust minutes -------------------------- //

  function adjust(delta) {
    requestImmersive();

    const cur = minutesValue();
    const next = cur + delta;

    if (next < MIN_MINUTES || next > MAX_MINUTES) {
      body.dataset.bump = delta > 0 ? "up" : "down";
      haptic(8);
      setTimeout(() => {
        if (body.dataset.bump) delete body.dataset.bump;
      }, 300);
      return;
    }

    const oldDuration = durationMs;
    durationMs = next * 60_000;
    const ddur = durationMs - oldDuration;

    if (mode === "running") {
      // Live adjustment: shift endpoint. Elapsed time is preserved.
      endAt += ddur;
      remainingMs = Math.max(0, endAt - performance.now());
      if (remainingMs <= 0) complete();
    } else {
      // Idle / complete → set fresh duration and auto-start.
      remainingMs = durationMs;
      endAt = performance.now() + remainingMs;
      setMode("running");
    }

    saveDuration(next);
    haptic(6);
    paintTimeline();
    srTime.textContent = `${next} minutes.`;
  }

  // --------------------------- Right timeline -------------------------- //

  function buildTimeline() {
    const frag = document.createDocumentFragment();
    for (let i = MIN_MINUTES; i <= MAX_MINUTES; i++) {
      const tick = document.createElement("span");
      tick.className = "tick";
      tick.dataset.minute = String(i);
      frag.appendChild(tick);
    }
    trackEl.appendChild(frag);
  }

  function paintTimeline(immediate = false) {
    const active = minutesValue();
    const ticks = trackEl.children;
    if (!ticks.length) return;
    const activeTick = /** @type {HTMLElement} */ (ticks[active - 1]);
    if (!activeTick) return;

    if (immediate) {
      trackEl.style.transition = "none";
    } else {
      trackEl.style.transition =
        "transform 360ms cubic-bezier(0.34, 1.16, 0.42, 1)";
    }

    for (let i = 0; i < ticks.length; i++) {
      const el = /** @type {HTMLElement} */ (ticks[i]);
      const dist = Math.abs(i + 1 - active);
      const isActive = dist === 0;
      el.classList.toggle("active", isActive);

      if (isActive) {
        el.style.setProperty("--w", "36px");
        el.style.setProperty("--o", "1");
        el.style.setProperty("--s", "1");
      } else {
        const t = Math.min(dist / 6, 1);
        const width = 28 - t * 14;
        const opacity = 0.85 - t * 0.78;
        const scale = 1 - t * 0.28;
        el.style.setProperty("--w", `${width.toFixed(1)}px`);
        el.style.setProperty("--o", opacity.toFixed(3));
        el.style.setProperty("--s", scale.toFixed(3));
      }
    }

    tlabel.textContent = String(active);

    const tickCenter = activeTick.offsetTop + activeTick.offsetHeight / 2;
    trackEl.style.transform = `translateY(${-tickCenter}px)`;

    if (immediate) {
      // Commit final layout before first visible paint; then enable motion.
      void trackEl.offsetHeight;
      trackEl.style.transition = "";
      timelineEl.classList.add("ready");
    }
  }

  // ------------------------------ Inputs ------------------------------- //

  // ---- Mouse wheel / trackpad ----------------------------------------- //

  let wheelAcc = 0;
  let wheelLast = 0;
  const WHEEL_THRESHOLD = 24;
  window.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      requestImmersive();
      const now = performance.now();
      if (now - wheelLast > 220) wheelAcc = 0;
      wheelLast = now;

      const dy = e.deltaY;
      if (Math.abs(dy) >= 80) {
        adjust(dy < 0 ? +1 : -1);
        wheelAcc = 0;
        return;
      }

      wheelAcc += -dy;
      while (wheelAcc >= WHEEL_THRESHOLD) {
        adjust(+1);
        wheelAcc -= WHEEL_THRESHOLD;
      }
      while (wheelAcc <= -WHEEL_THRESHOLD) {
        adjust(-1);
        wheelAcc += WHEEL_THRESHOLD;
      }
    },
    { passive: false }
  );

  // ---- Touch swipe ---------------------------------------------------- //

  let touchStartY = null;
  let touchStartX = null;
  let touchAccum = 0;
  const SWIPE_STEP = 36;

  function onTouchStart(e) {
    if (e.touches.length !== 1) return;
    requestImmersive();
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    touchAccum = 0;
  }

  function onTouchMove(e) {
    if (touchStartY == null) return;
    if (e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const x = e.touches[0].clientX;
    const dy = touchStartY - y; // up positive
    const dx = x - touchStartX;
    if (Math.abs(dx) > Math.abs(dy) * 1.4) return; // mostly horizontal

    const steps = Math.trunc(dy / SWIPE_STEP) - touchAccum;
    if (steps !== 0) {
      const dir = steps > 0 ? +1 : -1;
      for (let i = 0; i < Math.abs(steps); i++) adjust(dir);
      touchAccum += steps;
    }
  }

  function onTouchEnd() {
    touchStartY = null;
    touchStartX = null;
    touchAccum = 0;
  }

  window.addEventListener("touchstart", onTouchStart, { passive: true });
  window.addEventListener("touchmove", onTouchMove, { passive: true });
  window.addEventListener("touchend", onTouchEnd, { passive: true });
  window.addEventListener("touchcancel", onTouchEnd, { passive: true });

  // ---- Keyboard ------------------------------------------------------- //

  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        requestImmersive();
        adjust(+1);
        break;
      case "ArrowDown":
        e.preventDefault();
        requestImmersive();
        adjust(-1);
        break;
      case "Escape":
        if (mode !== "idle") {
          e.preventDefault();
          resetIdle();
        }
        break;
    }
  });

  // ---- Resize --------------------------------------------------------- //

  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      refreshBorder();
      paintTimeline();
    });
  });

  // ---- Visibility ----------------------------------------------------- //

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (mode === "running") {
      remainingMs = Math.max(0, endAt - performance.now());
      acquireWakeLock();
    }
  });

  // ------------------------------ Immersive ---------------------------- //

  function isFullscreen() {
    return !!(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.msFullscreenElement
    );
  }

  function enableImmersiveLayout() {
    document.documentElement.classList.add("immersive");
  }

  /** Synchronous — must run inside the user-gesture handler (no await). */
  function requestImmersive() {
    if (isFullscreen()) {
      enableImmersiveLayout();
      return;
    }

    const opts = { navigationUI: "hide" };
    const candidates = [stage, document.documentElement, body];

    for (const el of candidates) {
      try {
        if (typeof el.requestFullscreen === "function") {
          const p = el.requestFullscreen(opts);
          if (p && typeof p.then === "function") {
            p.then(() => enableImmersiveLayout()).catch(() => enableImmersiveLayout());
          } else {
            enableImmersiveLayout();
          }
          return;
        }
      } catch (_) {}
    }

    for (const el of candidates) {
      try {
        if (typeof el.webkitRequestFullscreen === "function") {
          el.webkitRequestFullscreen();
          enableImmersiveLayout();
          return;
        }
      } catch (_) {}
    }

    for (const el of candidates) {
      try {
        if (typeof el.msRequestFullscreen === "function") {
          el.msRequestFullscreen();
          enableImmersiveLayout();
          return;
        }
      } catch (_) {}
    }

    // Wheel/trackpad cannot call requestFullscreen (no user activation).
    // iOS Safari has no Fullscreen API. CSS immersive fills the viewport.
    enableImmersiveLayout();
    minimizeMobileChrome();
  }

  function minimizeMobileChrome() {
    window.scrollTo(0, 1);
    setTimeout(() => window.scrollTo(0, 0), 0);
  }

  function onFullscreenChange() {
    if (isFullscreen()) enableImmersiveLayout();
    refreshBorder();
    paintTimeline();
  }

  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);

  // pointerdown / touchstart grant user activation for requestFullscreen.
  window.addEventListener("pointerdown", requestImmersive, {
    capture: true,
    passive: true,
  });

  // ------------------------------ Helpers ------------------------------ //

  async function acquireWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      if (wakeLock && !wakeLock.released) return;
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    } catch (_) {}
  }

  async function releaseWakeLock() {
    try {
      if (wakeLock && !wakeLock.released) await wakeLock.release();
    } catch (_) {}
    wakeLock = null;
  }

  function haptic(ms) {
    try {
      if (navigator.vibrate) navigator.vibrate(ms);
    } catch (_) {}
  }

  // ----------------------------- Boot ---------------------------------- //

  function init() {
    durationMs = loadDuration() * 60_000;
    remainingMs = durationMs;
    setMode("idle");

    buildStrips();
    setDigits(remainingMs, true);
    buildTimeline();
    refreshBorder();
    paintTimeline(true);
    requestAnimationFrame(frame);

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("sw.js").catch(() => {});
      });
    }
  }

  init();
})();
