# Pomodoro

A minimal fullscreen timer.

## Interactions

| Input          | Action                         |
| -------------- | ------------------------------ |
| Mouse wheel    | ±1 minute                      |
| Trackpad       | ±1 minute                      |
| Vertical swipe | ±1 minute                      |
| `↑`            | +1 minute                      |
| `↓`            | −1 minute                      |
| Pause / Play   | Pause or resume (when active)  |

Range is **00–60**. **00** is idle — no timer runs. Select **01–60** to start automatically. Scroll back to **00** to reset.

## Run it

```bash
python3 -m http.server 4173
```

Open `index.html` or install as a PWA.

## License

MIT
