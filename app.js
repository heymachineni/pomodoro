/* =====================================================================
 * Pomodoro — minimal fullscreen timer
 * ===================================================================== */

(() => {
  "use strict";

  const MIN_MINUTES = 0;
  const MAX_MINUTES = 60;

  const EDGE_INSET = 8;
  const CORNER_RADIUS = 26;
  const TONE_SRC = "./tone.mp3";
  const SILENT_WAV =
    "data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==";

  const body = document.body;
  const stage = document.querySelector(".stage");
  const svg = document.querySelector(".border");
  const trackPath = svg.querySelector(".border-track");
  const fillPath = svg.querySelector(".border-fill");
  const trackEl = document.getElementById("track");
  const timelineEl = document.querySelector(".timeline");
  const tlabel = document.getElementById("tlabel");
  const timerHint = document.getElementById("timer-hint");
  const srTime = document.getElementById("sr-time");

  const HINT_HOLD_MS = 2500;
  const HINT_FADE_MS = 600;

  let hintHoldTimer = 0;
  let audioUnlocked = false;

  const completionTone = new Audio(TONE_SRC);
  completionTone.preload = "metadata";

  const touchPrimary =
    window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
  const keyboardPrimary = window.matchMedia("(pointer: fine)").matches;
  document.documentElement.classList.toggle("touch-primary", touchPrimary);

  /** @type {"idle"|"running"|"paused"} */
  let mode = "idle";
  let durationMs = 0;
  let remainingMs = 0;
  let endAt = 0;

  let perimeterLength = 0;
  let viewportSize = { w: 0, h: 0 };
  let resizeRaf = 0;

  /** @type {WakeLockSentinel|null} */
  let wakeLock = null;

  function strokeWidth() {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue("--stroke")
      .trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : 8;
  }

  function buildPerimeter(w, h) {
    const stroke = strokeWidth();
    const inset = EDGE_INSET + stroke / 2;
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

  function setBorderProgress(p) {
    if (durationMs <= 0 || mode === "idle") {
      fillPath.setAttribute("stroke-dasharray", `0 ${perimeterLength}`);
      return;
    }
    const clamped = Math.max(0, Math.min(1, p));
    const visible = (1 - clamped) * perimeterLength;
    fillPath.setAttribute("stroke-dasharray", `${visible} ${perimeterLength}`);
    fillPath.setAttribute("stroke-dashoffset", `${-clamped * perimeterLength}`);
  }

  function currentProgress() {
    if (durationMs <= 0) return 0;
    const elapsed = durationMs - remainingMs;
    return Math.max(0, Math.min(1, elapsed / durationMs));
  }

  function minutesValue() {
    return Math.round(durationMs / 60_000);
  }

  const digits = [
    { el: query("[data-pos='m10']"), prev: -1 },
    { el: query("[data-pos='m1']"), prev: -1 },
    { el: query("[data-pos='s10']"), prev: -1 },
    { el: query("[data-pos='s1']"), prev: -1 },
  ];

  function query(sel) {
    return /** @type {HTMLElement} */ (document.querySelector(sel));
  }

  function setDigit(d, next) {
    if (d.prev === next) return;
    d.el.textContent = String(next);
    d.prev = next;
  }

  function setDigits(ms) {
    const totalSec = Math.ceil(Math.max(0, ms) / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    setDigit(digits[0], Math.floor(m / 10));
    setDigit(digits[1], m % 10);
    setDigit(digits[2], Math.floor(s / 10));
    setDigit(digits[3], s % 10);
  }

  function frame() {
    if (mode === "running") {
      remainingMs = Math.max(0, endAt - performance.now());
      if (remainingMs === 0) finishCountdown();
    }
    setDigits(remainingMs);
    setBorderProgress(currentProgress());
    requestAnimationFrame(frame);
  }

  function setMode(next) {
    const prev = mode;
    mode = next;
    body.dataset.state = next;
    if (next === "running") acquireWakeLock();
    else releaseWakeLock();
    syncTimerHint(prev, next);
  }

  function clearHintTimer() {
    clearTimeout(hintHoldTimer);
    hintHoldTimer = 0;
  }

  function hideTimerHint() {
    clearHintTimer();
    timerHint.classList.remove("is-visible", "is-fading");
    timerHint.removeAttribute("data-hint");
  }

  function showIdleTimerHint() {
    clearHintTimer();
    if (!touchPrimary || mode !== "idle") {
      hideTimerHint();
      return;
    }
    timerHint.dataset.hint = "idle";
    timerHint.classList.remove("is-fading");
    timerHint.classList.add("is-visible");
  }

  function showTransientTimerHint(kind) {
    clearHintTimer();
    timerHint.dataset.hint = kind;
    timerHint.classList.remove("is-fading");
    void timerHint.offsetWidth;
    timerHint.classList.add("is-visible");
    hintHoldTimer = setTimeout(() => {
      timerHint.classList.add("is-fading");
    }, HINT_HOLD_MS);
  }

  function syncTimerHint(prev, next) {
    if (next === "idle") {
      showIdleTimerHint();
      return;
    }
    if (next === "running" && prev !== "paused") {
      showTransientTimerHint("pause");
      return;
    }
    if (next === "paused") {
      showTransientTimerHint("resume");
      return;
    }
    if (next === "running" && prev === "paused") {
      hideTimerHint();
    }
  }

  function onTimerHintTransitionEnd(e) {
    if (e.target !== timerHint || e.propertyName !== "opacity") return;
    if (!timerHint.classList.contains("is-fading")) return;
    timerHint.classList.remove("is-visible", "is-fading");
    timerHint.removeAttribute("data-hint");
    if (mode === "idle") showIdleTimerHint();
  }

  function unlockAudio() {
    if (audioUnlocked) return;

    try {
      const nav = /** @type {Navigator & { audioSession?: { type: string } }} */ (
        navigator
      );
      if (nav.audioSession) nav.audioSession.type = "playback";
    } catch (_) {}

    completionTone.src = SILENT_WAV;
    const attempt = completionTone.play();
    if (!attempt) {
      completionTone.src = TONE_SRC;
      completionTone.load();
      audioUnlocked = true;
      return;
    }
    attempt
      .then(() => {
        completionTone.pause();
        completionTone.currentTime = 0;
        completionTone.src = TONE_SRC;
        completionTone.load();
        audioUnlocked = true;
      })
      .catch(() => {
        completionTone.src = TONE_SRC;
        completionTone.load();
      });
  }

  function stopCompletionTone() {
    completionTone.pause();
    completionTone.currentTime = 0;
  }

  function playCompletionTone() {
    if (!audioUnlocked) return;
    stopCompletionTone();
    if (!completionTone.src.includes("tone.mp3")) {
      completionTone.src = TONE_SRC;
      completionTone.load();
    }
    completionTone.play().catch(() => {});
  }

  function enterIdle({ playTone = false } = {}) {
    durationMs = 0;
    remainingMs = 0;
    endAt = 0;
    setMode("idle");
    setDigits(0);
    setBorderProgress(0);
    srTime.textContent = "Idle.";
    if (playTone) playCompletionTone();
  }

  function startTimer(minutes) {
    if (minutes < 1) return;
    stopCompletionTone();
    durationMs = minutes * 60_000;
    remainingMs = durationMs;
    endAt = performance.now() + remainingMs;
    setMode("running");
    srTime.textContent = `${minutes} minutes.`;
  }

  function finishCountdown() {
    if (mode !== "running") return;
    enterIdle({ playTone: true });
    paintTimeline();
    srTime.textContent = "Timer complete.";
  }

  function togglePause() {
    if (mode === "running") {
      remainingMs = Math.max(0, endAt - performance.now());
      setMode("paused");
      srTime.textContent = "Paused.";
    } else if (mode === "paused") {
      endAt = performance.now() + remainingMs;
      setMode("running");
      srTime.textContent = `${minutesValue()} minutes.`;
    }
  }

  function adjust(delta) {
    requestImmersive();
    stopCompletionTone();

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

    if (next === 0) {
      enterIdle();
      paintTimeline();
      haptic(6);
      return;
    }

    const ddur = (next - cur) * 60_000;
    durationMs = next * 60_000;

    if (mode === "running") {
      endAt += ddur;
      remainingMs = Math.max(0, endAt - performance.now());
      if (remainingMs <= 0) {
        finishCountdown();
        return;
      }
    } else if (mode === "paused") {
      remainingMs = Math.max(0, remainingMs + ddur);
      remainingMs = Math.min(remainingMs, durationMs);
    } else {
      startTimer(next);
      paintTimeline();
      haptic(6);
      return;
    }

    haptic(6);
    paintTimeline();
    srTime.textContent = `${next} minutes.`;
  }

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

  function setIdleLabel() {
    if (touchPrimary) {
      tlabel.textContent = "00";
      tlabel.classList.remove("is-hint");
      return;
    }
    tlabel.innerHTML =
      '<span class="hint-line">Scroll to</span><span class="hint-line">start</span>';
    tlabel.classList.add("is-hint");
  }

  function paintTimeline(immediate = false) {
    const active = minutesValue();
    const ticks = trackEl.children;
    if (!ticks.length) return;
    const activeTick = /** @type {HTMLElement} */ (ticks[active]);
    if (!activeTick) return;

    if (immediate) trackEl.style.transition = "none";
    else
      trackEl.style.transition =
        "transform 360ms cubic-bezier(0.34, 1.16, 0.42, 1)";

    for (let i = 0; i < ticks.length; i++) {
      const el = /** @type {HTMLElement} */ (ticks[i]);
      const dist = Math.abs(i - active);
      const isActive = dist === 0;
      el.classList.toggle("active", isActive);

      if (isActive) {
        el.style.setProperty("--len", "36px");
        el.style.setProperty("--o", "1");
        el.style.setProperty("--s", "1");
      } else {
        const t = Math.min(dist / 6, 1);
        el.style.setProperty("--len", `${(28 - t * 14).toFixed(1)}px`);
        el.style.setProperty("--o", (0.85 - t * 0.78).toFixed(3));
        el.style.setProperty("--s", (1 - t * 0.28).toFixed(3));
      }
    }

    if (active === 0) {
      setIdleLabel();
    } else {
      tlabel.textContent = String(active).padStart(2, "0");
      tlabel.classList.remove("is-hint");
    }

    const tickCenter = activeTick.offsetTop + activeTick.offsetHeight / 2;
    trackEl.style.transform = `translateY(${-tickCenter}px)`;

    if (immediate) {
      void trackEl.offsetHeight;
      trackEl.style.transition = "";
      timelineEl.classList.add("ready");
    }
  }

  function canTogglePause() {
    return minutesValue() > 0 && (mode === "running" || mode === "paused");
  }

  // ---- Pause (tap / space) -------------------------------------------- //

  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === " " || e.code === "Space") {
      if (!keyboardPrimary || !canTogglePause()) return;
      e.preventDefault();
      requestImmersive();
      togglePause();
      return;
    }
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
    }
  });

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
  let touchMaxDist = 0;
  const SWIPE_STEP = 36;
  const TAP_SLOP = 14;

  function onTouchStart(e) {
    if (e.touches.length !== 1) return;
    unlockAudio();
    requestImmersive();
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    touchAccum = 0;
    touchMaxDist = 0;
  }

  function onTouchMove(e) {
    if (touchStartY == null || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const x = e.touches[0].clientX;
    const dy = touchStartY - y;
    const dx = x - touchStartX;
    const dist = Math.hypot(dx, dy);
    if (dist > touchMaxDist) touchMaxDist = dist;
    if (Math.abs(dx) > Math.abs(dy) * 1.4) return;

    const steps = Math.trunc(dy / SWIPE_STEP) - touchAccum;
    if (steps !== 0) {
      const dir = steps > 0 ? +1 : -1;
      for (let i = 0; i < Math.abs(steps); i++) adjust(dir);
      touchAccum += steps;
    }
  }

  function clearSelection() {
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
  }

  function onTouchEnd() {
    if (
      touchPrimary &&
      canTogglePause() &&
      touchStartY != null &&
      touchMaxDist < TAP_SLOP
    ) {
      requestImmersive();
      togglePause();
      clearSelection();
    }
    touchStartY = null;
    touchStartX = null;
    touchAccum = 0;
    touchMaxDist = 0;
  }

  window.addEventListener("touchstart", onTouchStart, { passive: true });
  window.addEventListener("touchmove", onTouchMove, { passive: true });
  window.addEventListener("touchend", onTouchEnd, { passive: true });
  window.addEventListener("touchcancel", onTouchEnd, { passive: true });

  stage.addEventListener("selectstart", (e) => e.preventDefault());
  timerHint.addEventListener("transitionend", onTimerHintTransitionEnd);

  // ---- Resize --------------------------------------------------------- //

  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      refreshBorder();
      paintTimeline(true);
    });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (mode === "running") {
      remainingMs = Math.max(0, endAt - performance.now());
      acquireWakeLock();
    }
  });

  // ---- Immersive ------------------------------------------------------ //

  function isFullscreen() {
    return !!(
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.msFullscreenElement
    );
  }

  function isStandalonePWA() {
    return (
      /** @type {Window & { navigator: Navigator & { standalone?: boolean } }} */ (
        window
      ).navigator.standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches
    );
  }

  function enableImmersiveLayout() {
    document.documentElement.classList.add("immersive");
  }

  function requestImmersive() {
    unlockAudio();

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

    enableImmersiveLayout();
    minimizeMobileChrome();
  }

  function minimizeMobileChrome() {
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const touch = navigator.maxTouchPoints > 0;
    if (!coarse && !touch) return;
    window.scrollTo(0, 1);
    setTimeout(() => window.scrollTo(0, 0), 0);
  }

  function onFullscreenChange() {
    if (isFullscreen()) enableImmersiveLayout();
    refreshBorder();
    paintTimeline(true);
  }

  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  window.addEventListener("pointerdown", requestImmersive, {
    capture: true,
    passive: true,
  });

  // ---- Helpers -------------------------------------------------------- //

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

  // ---- Boot ----------------------------------------------------------- //

  function init() {
    window.scrollTo(0, 0);

    try {
      localStorage.removeItem("pomodoro.duration");
    } catch (_) {}

    if (isStandalonePWA()) enableImmersiveLayout();

    enterIdle();
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
