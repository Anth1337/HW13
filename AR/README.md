# AR Dog (web app)

Design your own dog, then deploy it into your real surroundings through the phone camera and play with it: pet it with your hand, make it sit, lie down and come, teach it tricks, and let it follow you around. Everything is built from basic shapes with flat colours (no textures). Nothing to install from an app store and no Mac needed.

## 1. Make your dog (character creator)

The start screen shows your dog in a 3D preview (drag to orbit, pinch / scroll to zoom) above a creator panel (a bottom sheet on phones, a side panel on wide screens and phones held sideways). Every change shows up on the dog straight away and is saved in the browser for next time.

- **Name**: shown on the deploy button ("Deploy Biscuit").
- **🎲 Randomize**: a random breed with plausible colours and proportions, and a random name.
- **Breed**: Labrador, Corgi, Dachshund, Husky, Poodle, Beagle, German Shepherd, Dalmatian, Pug or Mixed breed. Picking a breed loads its typical look (keeping the name and sex); **Reset breed** undoes your tweaks.
- **Body**: sex (male dogs are a bit larger and broader-headed), size (shown as the real shoulder height), build (slim → stocky), leg length.
- **Coat**: colour swatches typical of the breed, or any main / markings colour; pattern (solid, two-tone, saddle, spots, mask, patches); fluff (sleek → fluffy).
- **Face**: snout length, ear style (floppy, pointy, folded, long), eye size, eye and nose colour, brow spots, tongue out.
- **Tail** style and **collar** colour, with or without a name tag.

## 2. Deploy it

| Phone | What you get |
|---|---|
| **Android** (Chrome) | Full AR in the browser (WebXR). **Deploy** starts the camera: scan the floor, a ring shows the surface, tap to place your dog there at real size (with a shadow). |
| **iPhone / iPad** (Safari) | iOS Safari has no WebXR, so **Deploy** shows the dog over the live camera (camera mode) with the same petting, commands and tricks, but without room tracking: hold the phone still. **View in AR** opens Apple's **AR Quick Look** with your custom dog as a still model on your floor (no animation or interaction). |
| **Computer** | The creator and preview; **Deploy** opens camera mode with a webcam. |

## 3. Play

- **Your hand comes first.** Hold your hand out in front of the camera: the dog looks at it and trots over to sniff it, and follows it with its head (and body) as you move it slowly. Put your hand on its **head** (it closes its eyes and leans in) or its **back** (it wiggles and wags like mad) to **pet** it: hearts float up and the phone buzzes. Only your hand is needed, not your whole body.
- **Hand in front of the dog**: when your hand is close to the camera the dog is hidden behind it, so your hand really looks in front of the dog.
- **Moves on its own**: in **Follow** mode it stays near you and trots after you when you walk away; in **Free roam** it wanders and sniffs around nearby. The mode button switches between them.
- **Tap the floor** to send it somewhere; it waits there.
- **Sit**, **Lie down**: it stays put until you give another command. **Come**: it walks to you and follows you again.
- **Tricks**: **Roll over**, **Jump**, **Spin**.
- **Eye contact**: someone looking at the dog gets looked back at (one person at a time).
- **👁** draws what the computer vision sees (hands, faces) on top of the camera. **✕** goes back to the creator.

### How the computer vision works

- [MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/guide) **hand landmarker** (your hand) and **face landmarker** (eyes and gaze, for eye contact) run **on the device**, in the browser (WebAssembly + GPU). **No camera image is uploaded anywhere.**
- The model files are downloaded on first use from Google's model storage (`storage.googleapis.com`) and the jsDelivr CDN, then cached by the browser.
- In WebXR the camera image comes from **WebXR Raw Camera Access** (about 10 frames a second). Hands are placed in 3D using the AR camera pose for that frame and **depth sensing** when the phone has it, otherwise the hand's apparent size.
- In camera mode there's no AR tracking, so the 3D camera is fixed: the phone is assumed to be held still about 1.3 m above the floor, tilted down a little, with a typical ~65° lens.

Built with [Vite](https://vite.dev) + [three.js](https://threejs.org) + TypeScript + [MediaPipe Tasks Vision](https://www.npmjs.com/package/@mediapipe/tasks-vision).

## Run it

Node.js 22 is installed. From the `AR/` folder:

```sh
npm install      # first time only
npm run dev
```

Vite prints a local URL and a `Network:` URL like `https://192.168.1.23:5173`.

### Open it on your phone

AR in the browser **requires HTTPS**, so a plain `http://` address won't work.

**Option A: same Wi-Fi (quick, Android only).** Open the `Network:` URL in Chrome on your phone. The certificate is self-signed, so tap **Advanced → Proceed**. iPhones handle self-signed certificates poorly; use option B for them.

**Option B: free HTTPS quick tunnel (any phone, any network, no account).** With `npm run dev` running in `AR/`, in a second terminal:

```sh
winget install --id Cloudflare.cloudflared   # first time only
cloudflared tunnel --url https://localhost:5173 --no-tls-verify
```

It prints an address like `https://random-words.trycloudflare.com`. Open it on your phone. The address changes every time, and anyone who has it can open the page while the tunnel runs.

**Option C: tunnel the built app.** From `AR/`:

```sh
npm run build
npm run preview   # serves AR/dist/ at https://localhost:4173
cloudflared tunnel --url https://localhost:4173 --no-tls-verify
```

## Phone requirements

- **Android**: Chrome with **Google Play Services for AR** (ARCore). Chrome offers to install it if it's missing.
  - For the dog to **see your hand**, Chrome must share the camera image with the page (**WebXR Raw Camera Access, Chrome 107+**). If it doesn't, the status line says so; placing the dog, commands, following and tricks still work. If your Chrome doesn't offer it, try enabling **WebXR Incubations** in `chrome://flags`.
  - **Depth sensing** (ARCore Depth API) is optional; it makes hand distances (petting, hiding the dog behind your hand) more accurate.
- **iPhone**: **Safari**. Camera mode needs iOS 14.3+; Quick Look needs iOS 12+.
- **Computer**: any modern browser with a webcam, for camera mode (over HTTPS or localhost).

## Files (in `AR/`)

| File | What it does |
|---|---|
| `index.html` | Page layout: start screen (title, status, creator panel, Deploy / Quick Look), the camera-mode video, and the AR overlay (hint, status, command / trick buttons, vision toggle, exit, vision canvas) |
| `src/main.ts` | Detects the device and picks WebXR, camera mode (+ Quick Look on iOS) or the creator alone; mounts the creator; shows the centered "Checking AR support…" screen until it knows |
| `src/creator.ts` | The character creator panel, bound to `dogConfigStore` |
| `src/preview.ts` | The orbitable 3D preview of the current dog, rebuilt on every change and framed beside / above the panel |
| `src/dog/types.ts` | The dog contracts: `DogConfig`, breed presets, `DogControls` (what the brain tells the model), `DogCharacter`, `DogBrain`, commands and modes |
| `src/dog/config.ts` | Breed presets, defaults, the dice (`randomDogConfig`), validation, and the saved config store |
| `src/models/dog.ts` | Builds the dog from a `DogConfig` (shapes, colours, real size) and poses it from the brain's controls |
| `src/dog/brain.ts` | Behaviour: hand reactions and petting, follow / free roam / stay, go-to, commands, tricks, eye contact |
| `src/dog/fx.ts` | Flat-colour hearts when the dog is petted |
| `src/webxr.ts` | Android AR session: hit-test reticle, tap to place / send the dog, buttons, camera access + depth for vision |
| `src/cameraMode.ts` | Fallback without WebXR: live camera video behind the 3D view, the dog on a virtual floor |
| `src/dogPlay.ts` | Shared by both modes: the detector, the brain, command / trick buttons, status line, vision drawing |
| `src/vision/*.ts` | Hand + face detection (MediaPipe), lifting them into 3D, the hand occluder, and the WebXR camera reader |
| `src/quicklook.ts` | iPhone path: exports the current dog to `.usdz` in the browser (re-exported when it changes) for AR Quick Look |
| `src/shadow.ts` | The invisible shadow-catcher plane under the dog |

## Tweaks

- **Breeds** (sizes, default looks, colour swatches, names for the dice): `src/dog/config.ts`.
- **Dog behaviour** (follow distances, petting timing, turn speed): the constants at the top of `src/dog/brain.ts`. Trick lengths: `TRICK_DURATION` in `src/dog/types.ts`.
- **Camera mode framing** (assumed lens field of view, floor height, dog distance): the constants at the top of `src/cameraMode.ts`.
- **Shadow size**: `shadowSizeFor` in `src/shadow.ts`.
