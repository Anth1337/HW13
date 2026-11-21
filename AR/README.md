# AR Dog (web app)

A web page that puts a 3D **dog** (and, if you like, a **woman** and a **man**) into your real surroundings through the phone camera, and lets real people play with it. Everything is built from basic shapes with flat colours (no textures). Nothing to install from an app store and no Mac needed.

Pick a character with the **Dog | Woman | Man** switch on the start screen (the dog is the default). In Android AR the same switch sits above the Undo / Clear / Exit buttons, so you can change which character the next tap places.

## Playing with the dog

The phone's camera image goes through on-device computer vision that finds the **people in the frame** (their eyes, where they're looking, and their hands). Each placed dog then:

- **Gets petted.** Reach out and put your hand on the dog's **head** (it half-closes its eyes and leans into your hand) or its **back** (it wiggles and wags like mad). Little hearts float up and the phone buzzes when a petting starts.
- **Makes eye contact** with someone who is looking at it: it turns its head (and, if needed, its whole body) to look back. **Only one person at a time**: it sticks with that person until they look away, then switches to the next one who's looking.
- **Does tricks**: the phone user taps **Roll over**, **Jump** or **Spin** (every placed dog does it).

A status line under the hint says what the dog sees (e.g. "👀 2 people · Making eye contact"). The **👁** button draws what the vision sees on top of the camera (eyes, gaze direction, hands; the person the dog is looking at is pink).

| Phone | What you get |
|---|---|
| **Android** (Chrome) | Full AR in the browser (WebXR): scan the room, a ring shows the surface, tap to place the selected character there at real size, turned to face you (with shadows). Place as many as you like and mix them; they all animate. Dogs see people, get petted, make eye contact and do tricks. Undo / Clear / Exit buttons. |
| **iPhone / iPad** (Safari) | iOS Safari doesn't support WebXR. **Play with the dog (camera)** shows the dog over the live camera with the same petting, eye contact and tricks, but without room tracking: hold the phone still and the dog stays on the screen (drag to move it). **View in AR** opens Apple's built-in **AR Quick Look** viewer instead: a still model on your floor (drag to move, pinch to scale, twist to rotate; no animation or interaction). |
| **Computer** | An animated 3D preview you can orbit, plus **Play with the dog (camera)** with a webcam. |

### How the computer vision works

- [MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/guide) **pose landmarker** (bodies, shoulders, hands) and **face landmarker** (eye corners, head pose and eye-look blendshapes, giving a gaze direction) run **on the device**, in the browser (WebAssembly + GPU). **No camera image is uploaded anywhere.**
- The model files (about 10 MB) are downloaded on first use from Google's model storage (`storage.googleapis.com`) and the jsDelivr CDN, then cached by the browser. In WebXR they only load once the browser actually shares the camera image.
- In WebXR the camera image comes from **WebXR Raw Camera Access**, about 10 frames a second, downscaled. Each person is placed in 3D using the AR camera pose for that frame: the distance comes from **depth sensing** when the phone has it, otherwise from the apparent size of their eyes or shoulders. A hand that reaches towards the dog is placed at the dog, so a hand on the dog counts as petting.
- In camera mode there's no AR tracking, so the 3D camera is fixed: the phone is assumed to be held still about 1.3 m above the floor, tilted down about 20°, with a typical ~65° lens.

Built with [Vite](https://vite.dev) + [three.js](https://threejs.org) + TypeScript + [MediaPipe Tasks Vision](https://www.npmjs.com/package/@mediapipe/tasks-vision).

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

**Option C: share the built app through a tunnel (any phone, no account).**
```sh
npm run build
npm run preview   # serves dist/ at https://localhost:4173
cloudflared tunnel --url https://localhost:4173 --no-tls-verify
```
Open the printed `https://….trycloudflare.com` address on your phone. Same caveats as option B: it lasts only while both commands run.

## Phone requirements

- **Android**: Chrome with **Google Play Services for AR** (ARCore) installed. Most phones from the last ~5 years support it. Chrome offers to install it if it's missing.
  - For the dog to **see people**, Chrome must share the camera image with the page (**WebXR Raw Camera Access, Chrome 107+**). If it doesn't, the status line says so; placing the dog and tricks still work. If your Chrome doesn't offer it, try enabling **WebXR Incubations** in `chrome://flags`.
  - **Depth sensing** (ARCore Depth API) is optional; it makes people's distances more accurate.
- **iPhone**: **Safari**. Camera mode needs iOS 14.3+; Quick Look needs iOS 12+ (Quick Look from Chrome on iOS is unreliable).
- **Computer**: any modern browser with a webcam, for camera mode (over HTTPS or localhost).

## Files

| File | What it does |
|---|---|
| `index.html` | Page layout: start screen (title, status text, character picker, AR and camera buttons), the camera-mode video, and the AR overlay (hint, status line, trick buttons, picker, vision toggle, toolbar, vision canvas) |
| `src/main.ts` | Detects the device and picks WebXR, Quick Look + camera mode, or preview + camera mode; builds the pickers; shows the centered "Checking AR support…" screen until it knows |
| `src/selection.ts` | The shared "selected character" state used by both pickers, the preview, AR and Quick Look |
| `src/webxr.ts` | Android AR session: surface detection (hit-test), reticle, tap to place the selected character facing you, idle animation, shadows, buttons; camera access + depth for the dog's vision |
| `src/cameraMode.ts` | Fallback without WebXR (iPhone, computer): live camera video behind the 3D view, one dog on a virtual floor, drag to move it |
| `src/dogPlay.ts` | Shared by both modes: the cached people detector, one brain per dog, hearts, trick buttons, status line, vision drawing |
| `src/dog/types.ts` | The dog contracts: tricks, `DogControls` (what the brain tells the model), petting zones, `DogBrain` |
| `src/dog/brain.ts` | The dog's behaviour: who to look at (one person at a time), petting detection, tricks, all smoothed |
| `src/dog/fx.ts` | Flat-colour hearts that float up when the dog is petted |
| `src/vision/types.ts` | The vision contracts: people in image space (`Human2D`), `CameraModel`, people in world space (`PerceivedHuman`) |
| `src/vision/detector.ts` | MediaPipe pose + face landmarkers → people with eyes, gaze, shoulders and hands, tracked across frames |
| `src/vision/lift.ts` | Places people in 3D (depth, or eye / shoulder size) and snaps reaching hands to the dog |
| `src/vision/xrCamera.ts` | Reads the WebXR camera image (Raw Camera Access) and depth buffer into snapshots for the detector |
| `src/quicklook.ts` | iPhone path: exports the selected character to `.usdz` in the browser (re-exported when you switch) and opens Apple's AR viewer |
| `src/preview.ts` | The orbitable, animated 3D preview on the start screen, framed to fit each character |
| `src/shadow.ts` | The invisible shadow-catcher plane under each character |
| `src/models/types.ts` | The shared `Character` / `ModelInfo` contract every model follows |
| `src/models/woman.ts`, `man.ts`, `dog.ts` | The three characters: shapes, colours, sizes and idle animation (the dog also poses itself from its brain's controls: looking, petting, tricks) |
| `src/models/index.ts` | The list of characters (`MODELS`, in picker order) and the default one |

## Tweaks

- **Sizes and colours**: each character's file in `src/models/` (meters; colours are plain hex values on `MeshStandardMaterial`).
- **Idle animation**: the `update(t)` function in each character's file.
- **Default character / picker order**: `DEFAULT_MODEL_ID` and `MODELS` in `src/models/index.ts`.
- **Add a character**: write a new file in `src/models/` that exports a `ModelInfo` (see `types.ts`), add its id to `ModelId`, and add it to `MODELS`.
- **Shadow size**: `shadowSizeFor` in `src/shadow.ts`.
- **Dog behaviour** (how long someone must look before eye contact, petting timing, turn speed): the constants at the top of `src/dog/brain.ts`. Trick lengths: `TRICK_DURATION` in `src/dog/types.ts`.
- **Camera mode framing** (assumed lens field of view, floor height, dog distance): the constants at the top of `src/cameraMode.ts`.
