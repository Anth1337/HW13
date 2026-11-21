# AR Pets (web app)

Design your own dog or cat, then deploy it into your real surroundings through the phone camera and play with it: pet it with your hand, give it commands, teach it tricks, and let it follow you around. Everything is built from basic shapes with flat colours (no textures). Nothing to install from an app store and no Mac needed.

## 1. Make your pets

### My pets (the start menu)

The start screen shows a **My pets** menu with **3 slots** in a panel (a bottom sheet on phones, a side panel on wide screens and phones held sideways) over a 3D preview (drag to orbit, pinch / scroll to zoom).

- **Empty slot → + Create**: pick the kind of animal (**Dog 🐕** or **Cat 🐈**), and you go straight into the creator for your new pet.
- **Filled slot**: tap it to select it (the preview shows it, and **Deploy** deploys it), then **Customise** to open the creator or **Delete** (asks to confirm first).
- **← My pets** in the creator goes back to the menu.
- Your pets, and which one was selected, are saved in the browser (`localStorage`, not cookies: there's no 4 KB limit and nothing is sent to a server), so the slots fill back in when you come back. They live in this browser on this device only; clearing site data deletes them. A dog saved by the older single-dog version is moved into slot 1.

### Dog creator

Every change shows up on the pet straight away and is saved.

- **Name**: shown on the deploy button ("Deploy Biscuit").
- **🎲 Randomize**: a random breed with plausible colours and proportions, and a random name.
- **Breed**: Labrador, Corgi, Dachshund, Husky, Poodle, Beagle, German Shepherd, Dalmatian, Pug or Mixed breed. Picking a breed loads its typical look (keeping the name and sex); **Reset breed** undoes your tweaks.
- **Body**: sex (male dogs are a bit larger and broader-headed), size (shown as the real shoulder height), build (slim → stocky), leg length.
- **Coat**: colour swatches typical of the breed, or any main / markings colour; pattern (solid, two-tone, saddle, spots, mask, patches); fluff (sleek → fluffy).
- **Face**: snout length, ear style (floppy, pointy, folded, long), eye size, eye and nose colour, brow spots, tongue out.
- **Tail** style and **collar** colour, with or without a name tag.

### Cat creator

- **Name** and **🎲 Randomize**, as for dogs.
- **Breed**: Domestic shorthair, Siamese, Maine Coon, Persian, British Shorthair, Sphynx, Bengal, Ragdoll, Scottish Fold or Moggy (mixed). Picking a breed loads its typical look; **Reset breed** undoes your tweaks.
- **Body**: sex (toms are a bit larger with broader cheeks), size (real shoulder height), build (slim → chonky), leg length.
- **Coat**: breed colour swatches or any main / markings colour; pattern (solid, tabby, bicolour, tuxedo, colourpoint, calico, spotted); fluff (hairless → long-haired).
- **Face**: muzzle (flat → wedge), ears (upright, folded, tufted, large), eye size, eye and nose colour, whiskers.
- **Tail** (long, plume, bob, ringed) and **collar** (on / off, colour, bell).

## 2. Deploy it

| Phone | What you get |
|---|---|
| **Android** (Chrome) | Full AR in the browser (WebXR). **Deploy** starts the camera: scan the floor, a ring shows the surface, tap to place your dog there at real size (with a shadow). |
| **iPhone / iPad** (Safari) | iOS Safari has no WebXR, so **Deploy** shows the dog over the live camera (camera mode) with the same petting, commands and tricks, but without room tracking: hold the phone still. **View in AR** opens Apple's **AR Quick Look** with your custom dog as a still model on your floor (no animation or interaction). |
| **Computer** | The creator and preview; **Deploy** opens camera mode with a webcam. |

## 3. Play

The **dog** and the **cat** share the same play modes; the buttons change to suit the animal.

- **Your hand comes first.** Hold your hand out in front of the camera: the dog looks at it and trots over to sniff it, and follows it with its head (and body) as you move it slowly. Put your hand on its **head** (it closes its eyes and leans in) or its **back** (it wiggles and wags like mad) to **pet** it: hearts float up and the phone buzzes. Only your hand is needed, not your whole body.
- **Hand in front of the dog**: when your hand is close to the camera the dog is hidden behind it, so your hand really looks in front of the dog.
- **Moves on its own**: in **Follow** mode it stays near you and trots after you when you walk away; in **Free roam** it wanders and sniffs around nearby. The mode button switches between them.
- **Tap the floor** to send it somewhere; it waits there.
- **Sit**, **Lie down**: it stays put until you give another command. **Come**: it walks to you and follows you again.
- **Tricks**: **Roll over**, **Jump**, **Spin**.
- **Cats** get cat commands: **Sit**, **Loaf** (tucked-up paws), **Here kitty** (it comes over... when it feels like it, so it may ignore you), **Follow** / **Free roam**, and the tricks **Pounce**, **Stretch** and **Groom**. Petting a cat makes it purr, slow-blink and rub its head on your hand, or arch its back with its tail up.
- **Eye contact**: someone looking at the dog gets looked back at (one person at a time).
- **👁** draws what the computer vision sees (hands, faces) on top of the camera. **✕** goes back to the creator.

### How the computer vision works

- [MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/guide) **hand landmarker** (your hand) and **face landmarker** (eyes and gaze, for eye contact) run **on the device**, in the browser (WebAssembly + GPU). **No camera image is uploaded anywhere.**
- The model files are downloaded on first use from Google's model storage (`storage.googleapis.com`) and the jsDelivr CDN, then cached by the browser.
- In WebXR the camera image comes from **WebXR Raw Camera Access** (about 10 frames a second). Hands are placed in 3D using the AR camera pose for that frame and **depth sensing** when the phone has it, otherwise the hand's apparent size.
- In camera mode there's no AR tracking, so the 3D camera is fixed: the phone is assumed to be held still about 1.3 m above the floor, tilted down a little, with a typical ~65° lens.

Built with [Vite](https://vite.dev) + [three.js](https://threejs.org) + TypeScript + [MediaPipe Tasks Vision](https://www.npmjs.com/package/@mediapipe/tasks-vision).

## Run it

Node.js 22 is installed. From the repo root:

```sh
npm install      # first time only
npm run dev
```

Vite prints a local URL and a `Network:` URL like `https://192.168.1.23:5173`.

### Open it on your phone

AR in the browser **requires HTTPS**, so a plain `http://` address won't work.

**Option A: same Wi-Fi (quick, Android only).** Open the `Network:` URL in Chrome on your phone. The certificate is self-signed, so tap **Advanced → Proceed**. iPhones handle self-signed certificates poorly; use option B for them.

**Option B: free HTTPS quick tunnel (any phone, any network, no account).** With `npm run dev` running, in a second terminal:

```sh
winget install --id Cloudflare.cloudflared   # first time only
cloudflared tunnel --url https://localhost:5173 --no-tls-verify
```

It prints an address like `https://random-words.trycloudflare.com`. Open it on your phone. The address changes every time, and anyone who has it can open the page while the tunnel runs.

**Option C: tunnel the built app.**

```sh
npm run build
npm run preview   # serves dist/ at https://localhost:4173
cloudflared tunnel --url https://localhost:4173 --no-tls-verify
```

`npm run check:pets` runs a small self-check of the slot storage (`src/pets.ts`: legacy migration, reload, delete, corrupt data).

## Phone requirements

- **Android**: Chrome with **Google Play Services for AR** (ARCore). Chrome offers to install it if it's missing.
  - For the dog to **see your hand**, Chrome must share the camera image with the page (**WebXR Raw Camera Access, Chrome 107+**). If it doesn't, the status line says so; placing the dog, commands, following and tricks still work. If your Chrome doesn't offer it, try enabling **WebXR Incubations** in `chrome://flags`.
  - **Depth sensing** (ARCore Depth API) is optional; it makes hand distances (petting, hiding the dog behind your hand) more accurate.
- **iPhone**: **Safari**. Camera mode needs iOS 14.3+; Quick Look needs iOS 12+.
- **Computer**: any modern browser with a webcam, for camera mode (over HTTPS or localhost).

## Files

| File | What it does |
|---|---|
| `index.html` | Page layout: start screen (title, status, My pets menu, back button, creator panel, Deploy / Quick Look), the camera-mode video, and the AR overlay (hint, status, command / trick buttons, vision toggle, exit, vision canvas) |
| `src/main.ts` | Detects the device and picks WebXR, camera mode (+ Quick Look on iOS) or the creator alone; switches the panel between the menu and the creator; shows the centered "Checking AR support…" screen until it knows |
| `src/pets.ts` | The 3 pet slots (`petStore`): species list, create / delete / select, the active pet, saved in `localStorage` |
| `src/menu.ts` | The "My pets" menu: slot cards, species picker, select / customise / delete with confirm |
| `src/creator.ts` | The character creator panel for the active pet (dog or cat controls from shared building blocks), bound to `petStore` |
| `src/preview.ts` | The orbitable 3D preview of the active pet, rebuilt on every change and framed beside / above the panel |
| `src/dog/types.ts` | The dog contracts: `DogConfig`, breed presets, `DogControls` (what the brain tells the model), `DogCharacter`, `DogBrain`, commands and modes |
| `src/dog/config.ts` | Breed presets, defaults, the dice (`randomDogConfig`), and validation (saving lives in `src/pets.ts`) |
| `src/models/dog.ts` | Builds the dog from a `DogConfig` (shapes, colours, real size) and poses it from the brain's controls |
| `src/cat/types.ts` | The cat contracts: `CatConfig`, cat breed presets, `CatCharacter` |
| `src/cat/config.ts` | Cat breed presets, defaults, the dice (`randomCatConfig`) and validation |
| `src/models/cat.ts` | Builds the cat from a `CatConfig` and poses it from the same controls as the dog (loaf, pounce, stretch, groom) |
| `src/models/pet.ts` | `createPetCharacter(pet)`: builds a dog or a cat for a slot's pet |
| `src/dog/brain.ts` | Behaviour: hand reactions and petting, follow / free roam / stay, go-to, commands, tricks, eye contact |
| `src/dog/fx.ts` | Flat-colour hearts when the dog is petted |
| `src/webxr.ts` | Android AR session: hit-test reticle, tap to place / send the dog, buttons, camera access + depth for vision |
| `src/cameraMode.ts` | Fallback without WebXR: live camera video behind the 3D view, the dog on a virtual floor |
| `src/dogPlay.ts` | Shared by both modes: the detector, the brain, command / trick buttons, status line, vision drawing |
| `src/vision/*.ts` | Hand + face detection (MediaPipe), lifting them into 3D, the hand occluder, and the WebXR camera reader |
| `src/quicklook.ts` | iPhone path: exports the current dog to `.usdz` in the browser (re-exported when it changes) for AR Quick Look |
| `src/shadow.ts` | The invisible shadow-catcher plane under the dog |

## Tweaks

- **Breeds** (sizes, default looks, colour swatches, names for the dice): `src/dog/config.ts` and `src/cat/config.ts`.
- **Number of slots / species in the menu**: `SLOT_COUNT` and `SPECIES` in `src/pets.ts`.
- **Dog behaviour** (follow distances, petting timing, turn speed): the constants at the top of `src/dog/brain.ts`. Trick lengths: `TRICK_DURATION` in `src/dog/types.ts`.
- **Camera mode framing** (assumed lens field of view, floor height, dog distance): the constants at the top of `src/cameraMode.ts`.
- **Shadow size**: `shadowSizeFor` in `src/shadow.ts`.
