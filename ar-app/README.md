# AR Cube (web app)

A web page that puts a Blender-style default cube into your real surroundings through the phone camera. Nothing to install from an app store and no Mac needed.

| Phone | What you get |
|---|---|
| **Android** (Chrome) | Full AR in the browser (WebXR): scan the room, a ring shows the surface, tap to place as many cubes as you like (with shadows). Undo / Clear / Exit buttons. |
| **iPhone / iPad** (Safari) | iOS Safari doesn't support WebXR, so the page uses Apple's built-in **AR Quick Look** viewer instead: tap **View in AR**, point at the floor, and the cube lands on it. Drag to move, pinch to scale, twist to rotate. One cube at a time. |
| **Computer** | A 3D preview of the cube you can orbit. |

Built with [Vite](https://vite.dev) + [three.js](https://threejs.org) + TypeScript.

## Run it

Node.js 22 is installed. In this folder:

```sh
npm install      # first time only
npm run dev
```

Vite prints a local URL and a `Network:` URL like `https://192.168.1.23:5173`.

### Open it on your phone

AR in the browser **requires HTTPS**, so a plain `http://` address won't work.

**Option A: same Wi-Fi (quick, Android only).** Open the `Network:` URL in Chrome on your phone. The certificate is self-signed, so tap **Advanced → Proceed**. iPhones handle self-signed certificates poorly; use option B for them.

**Option B: free HTTPS tunnel (works on any phone, any network).**
```sh
winget install --id Cloudflare.cloudflared   # first time only
cloudflared tunnel --url https://localhost:5173 --no-tls-verify
```
It prints an address like `https://random-words.trycloudflare.com`. Open it on your phone. No account is needed. The address changes every time you run it, and anyone who has the address can open the page while the tunnel runs.

**Option C: put it online permanently (free).**
```sh
npm run build
```
Then drag the `dist` folder onto https://app.netlify.com/drop (or upload it to GitHub Pages or Cloudflare Pages). You get a permanent HTTPS address to open on any phone.

## Phone requirements

- **Android**: Chrome with **Google Play Services for AR** (ARCore) installed. Most phones from the last ~5 years support it. Chrome offers to install it if it's missing.
- **iPhone**: iOS 12+ in **Safari**. Quick Look from Chrome on iOS is unreliable.

## Files

| File | What it does |
|---|---|
| `index.html` | Page layout: start screen and the AR overlay (hint and buttons) |
| `src/main.ts` | Detects the device and picks WebXR, Quick Look or preview |
| `src/webxr.ts` | Android AR session: surface detection (hit-test), reticle, tap to place, shadows, buttons |
| `src/quicklook.ts` | iPhone path: exports the cube to `.usdz` in the browser and opens Apple's AR viewer |
| `src/preview.ts` | The orbitable 3D preview on the start screen |
| `src/cube.ts` | The cube (size and color) and its shadow catcher |

## Tweaks

- **Cube size**: `CUBE_SIZE` in `src/cube.ts` (meters, default 0.2 = 20 cm).
- **Cube color**: `color` in `src/cube.ts`.
