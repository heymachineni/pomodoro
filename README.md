# Pomodoro

A minimal fullscreen timer.

The interface is the timer. There are no buttons, panels, or settings —
just a black canvas, a number in the middle, a perimeter that depletes
clockwise as time runs out, and a faint dial of minutes on the right edge.

## Run it

It's static. Open `index.html` directly, or run any local server:

```bash
python3 -m http.server 4173
# then open http://127.0.0.1:4173
```

Add it to your home screen — it installs as a PWA and works offline.

## Interactions

The timer is _set in motion_, not played. Any adjustment kicks off the
countdown immediately. There is no play, no pause, and no tap target.

| Input          | Action                  |
| -------------- | ----------------------- |
| Mouse wheel    | ±1 minute               |
| Trackpad       | ±1 minute               |
| Vertical swipe | ±1 minute               |
| `↑`            | +1 minute               |
| `↓`            | −1 minute               |
| `Esc`          | Reset to idle           |

Range is 1–60. The default is 25. Your last duration is saved locally.

While the timer is running, adjusting shifts the endpoint live —
elapsed time is preserved, never reset.

The first interaction also enters fullscreen. While running, the screen
stays awake via the Screen Wake Lock API where supported.

## Build

There is no build step. Vanilla HTML, CSS, and one JavaScript file.

```
.
├── index.html              # markup + meta
├── styles.css              # design system
├── app.js                  # state machine + RAF render loop
├── manifest.webmanifest    # PWA manifest
├── sw.js                   # offline service worker
└── icon.svg                # app icon
```

## Design

- Background: pure `#000000`. No gradients, textures, or noise.
- One accent: `#FF5C00`, used for the timer, the depleting border, and
  the active dial marker. No glow, no bloom, no shadows.
- One typeface: Inter, weight 700, with tabular numerals.
- Border: an 8 px rounded path inset 8 px from the viewport edge.
  - The full perimeter is the time bank.
  - As time elapses, the orange depletes clockwise from top-center,
    leaving behind a subtle inactive-color track underneath.
  - Both ends of the moving stroke are round-capped.
  - At 00:00 the orange is gone; only the quiet track remains.
- Right-edge dial: 60 horizontal markers; the active one centered in
  accent color with a small numeric label beside it.
- **Rolling digits**: each digit is a vertical column with wraparound
  rows. Transitions use a 280 ms mechanical ease — countdown digits roll
  downward, count-up digits roll upward. Boundary borrows happen as
  single-step rolls instead of long spins.

## Accessibility

- `aria-live` region announces the current minutes when changed.
- Keyboard‑first: arrows adjust, Esc resets.
- Honors `prefers-reduced-motion`.
- Color-scheme is dark-only by design.

## License

MIT — do whatever you'd like with it.
