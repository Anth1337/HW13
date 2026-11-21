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
- **Voice commands**: tap **🎤** and talk to the dog (see below).
- **Several people**: the dog tells people apart and keeps them straight (see below).
- **Friends' pets**: several phones in one room, each with its own pet (see below).
- **Eye contact**: someone looking at the dog gets looked back at (one person at a time, and it doesn't flip-flop between two lookers).
- **👁** draws what the computer vision sees (hands, bodies, faces, person ids, who is speaking, depth / mask state) on top of the camera. **✕** goes back to the creator.

### Play together (multiplayer)

Every phone brings its own pet to the party, and everyone sees everyone's pets.

- On the start screen, tap **👥 Friends**: it opens a room and shows a **QR code**, the room code and a link (big enough to show on a projector from a laptop). Friends scan it with the phone camera, make their dog (a first-time guest starts with a random one, so the room isn't full of identical labradors) and **Deploy**. The button shows how many are in the room ("👥 3 here").
- In AR / camera mode, friends' pets stand around yours with their name above them, doing exactly what they do on their owner's phone: walking, sitting, tricks, being petted.
- **Pet a friend's pet** with your hand: it leans in here, on its owner's phone and on everyone else's, and the owner sees "💕 …'s human is petting …".
- **🎉** makes every pet in the room do the same random trick at once.
- A feed under the hint says who joined or left, who is petting whom and which tricks friends asked for.
- Up to 8 phones per room. A phone that loses the connection reconnects on its own (a 📡 chip says so); meanwhile friends' pets disappear and then come back.

What is shared: each pet's look and name, where it is and what it's doing (about 10 updates a second, only while someone else is in the room). The camera image and audio never leave the phone. The room server only relays messages between the phones in a room and stores nothing.

**Limit:** browsers can't share AR anchors between phones, so each phone shows friends' pets around its own pet rather than at the same real-world spot. For a demo, have everyone place their pet on the same spot (the table, or the printed QR code) and it looks shared.

### Voice commands

Tap **🎤** (it pulses while listening; a chip shows what was heard and the command it matched). It remembers on/off, but a browser only lets a tap start the microphone, so after a reload tap 🎤 (or any command button) once to resume.

| Say | The dog |
|---|---|
| "sit", "stay", "wait", "stop", "hold" | sits and stays |
| "lie down", "down" | lies down |
| "stand", "up" | stands up |
| "come", "come here" | walks to whoever said it, then follows them |
| "follow me" | follows |
| "go play", "free" | free roam |
| "roll over", "jump", "spin" ("up up" also jumps) | does the trick |

Filler like "please" or "good boy" is ignored, and if several commands are in one sentence the last wins. Saying the dog's name ("Biscuit, sit") always counts; without the name only short, command-like phrases count, so a conversation about sitting down doesn't make the dog sit. Any speech makes the dog perk up and look at the speaker. Commands act as soon as the browser has heard them, before you finish the sentence.

Support: **Chrome on Android** and **Safari on iPhone** have the Web Speech API; Firefox doesn't. **Privacy: unlike the camera, speech recognition does not stay on the device.** In these browsers the audio is normally sent to the browser vendor's speech service (Google for Chrome, Apple for Safari) to be turned into text, so it needs a network connection. The app itself never records or uploads audio. Android Chrome may beep each time the recogniser restarts, and inside the Android AR session the browser may refuse the microphone; if so the 🎤 button shows it is blocked and everything else still works.

### Several people

The dog keeps a list of **people**, each with a stable id that survives walking past each other and short dropouts (about 3 s). A person is a body (MediaPipe pose), a face and up to two hands tied together by position; a lone hand with no body or face visible is still a person, so the one-hand experience is unchanged. Consequences:

- Petting belongs to the hand that started it: a second person's hand can't hijack it.
- The dog's hand attention and eye contact stay with one person; it only switches when that person looks away or leaves, and glances at a second looker now and then.
- **Come** goes to the person who said it. Who spoke is guessed from whose mouth was moving in the last second or so (jaw movement); if nobody clearly was speaking it's taken to be the phone holder.
- Your own hands (very close to the camera) count as the phone holder.

### How the computer vision works

- [MediaPipe](https://ai.google.dev/edge/mediapipe/solutions/guide) **hand landmarker** (your hand, the priority: it runs on every detection), **face landmarker** (eyes, gaze, mouth) and the lite **pose landmarker** (full body, up to 3 people) run **on the device**, in the browser (WebAssembly + GPU). Faces and bodies run on alternate frames so they never all run at once. **No camera image is uploaded anywhere.** (Voice is different, see above.)
- The model files are downloaded on first use from Google's model storage (`storage.googleapis.com`) and the jsDelivr CDN, then cached by the browser.
- In WebXR the camera image comes from **WebXR Raw Camera Access** (about 10 frames a second). Hands, faces and bodies are placed in 3D using the AR camera pose for that frame and **depth sensing** when the phone has it, otherwise apparent size (hand span, eye distance, shoulder width).

### Hand masking (the dog hides behind your hand)

The dog is hidden behind a depth-only shape of your hand. It deliberately **errs on the small side**: finger capsules are thinner than real fingers and the palm is a thin slab, so you may see a sliver of dog over a finger edge rather than a fat "glove" cut out of it. When the phone gives a depth map (**Android with the ARCore Depth API** in WebXR; shown as `depth ✓` in the 👁 view) the mask is also snapped to the measured palm distance and a small patch of forearm behind the wrist is masked from the depth data, only where depth is consistent. **Limits:** iPhone LiDAR is **not exposed to web pages** (Safari has no WebXR), so iPhones, and any phone without ARCore depth, get the capsule shape only; the depth map is low resolution and noisy at hand edges, which is why it is only used conservatively.
- In camera mode there's no AR tracking, so the 3D camera is fixed: the phone is assumed to be held still about 1.3 m above the floor, tilted down a little, with a typical ~65° lens.

Built with [Vite](https://vite.dev) + [three.js](https://threejs.org) + TypeScript + [MediaPipe Tasks Vision](https://www.npmjs.com/package/@mediapipe/tasks-vision).

## Run it

Node.js 22 is installed. From the project folder:

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

**Option C: tunnel the built app.** From the project folder:

```sh
npm run build
npm run preview   # serves dist/ at https://localhost:4173
cloudflared tunnel --url https://localhost:4173 --no-tls-verify
```

### Multiplayer while developing

The rooms run in a local copy of the Cloudflare Worker, next to Vite. Use two terminals:

```sh
npm run dev         # terminal 1: the app; it forwards /party to the rooms
npm run dev:rooms   # terminal 2: builds once, then runs the rooms on http://127.0.0.1:8787
```

Phones reach the rooms through the same address as the page, so options A, B and C above work unchanged. To use the deployed rooms from a local front-end instead, put `VITE_ROOM_SERVER=wss://hw13-pets.<your-subdomain>.workers.dev` in `.env.local`.

No second phone? `npm run fake-friend -- <invite link>` (or `-- <room code>` for the local rooms) adds Mochi, a scripted corgi who walks, sits, does tricks and pets your dog now and then. It works against the deployed site too.

## Put it online (Cloudflare, free)

For the demo, deploy instead of tunnelling. You get a stable `https://` address that works on any phone and any network, without the laptop in the loop. One Cloudflare Worker serves the built site and runs the rooms (one Durable Object per room code).

First time only (needs a free Cloudflare account):

```sh
npx wrangler login   # opens the browser to authorise this computer
```

Then, each time you want to publish the current code:

```sh
npm run deploy       # typecheck, build, upload
```

It prints the address, e.g. `https://hw13-pets.<your-subdomain>.workers.dev`. Open it, tap **👥 Friends** and let people scan the QR code.

- The site's files don't count against the free plan. Room traffic does: 100,000 requests a day, where each room join is one and every 20 room messages are one. That's several hours of a full 8-phone room. The count resets at 00:00 UTC (7 pm Eastern). `npx wrangler tail` shows live logs.
- `.env` is not uploaded. Never put an API key in a `VITE_` variable: those are built into the page, where anyone can read them. A key the app needs at runtime belongs in the Worker (`npx wrangler secret put NAME`).

## Phone requirements

- **Android**: Chrome with **Google Play Services for AR** (ARCore). Chrome offers to install it if it's missing.
  - For the dog to **see your hand**, Chrome must share the camera image with the page (**WebXR Raw Camera Access, Chrome 107+**). If it doesn't, the status line says so; placing the dog, commands, following and tricks still work. If your Chrome doesn't offer it, try enabling **WebXR Incubations** in `chrome://flags`.
  - **Depth sensing** (ARCore Depth API) is optional; it makes hand distances (petting, hiding the dog behind your hand) more accurate.
- **iPhone**: **Safari**. Camera mode needs iOS 14.3+; Quick Look needs iOS 12+.
- **Computer**: any modern browser with a webcam, for camera mode (over HTTPS or localhost).

## Files

| File | What it does |
|---|---|
| `index.html` | Page layout: start screen (title, status, creator panel, Deploy / Quick Look), the camera-mode video, and the AR overlay (hint, status, command / trick buttons, vision toggle, exit, vision canvas) |
| `src/main.ts` | Detects the device and picks WebXR, camera mode (+ Quick Look on iOS) or the creator alone; mounts the creator; shows the centered "Checking AR support…" screen until it knows |
| `src/creator.ts` | The character creator panel, bound to `dogConfigStore` |
| `src/preview.ts` | The orbitable 3D preview of the current dog, rebuilt on every change and framed beside / above the panel |
| `src/dog/types.ts` | The dog contracts: `DogConfig`, breed presets, `DogControls` (what the brain tells the model), `DogCharacter`, `DogBrain`, commands and modes |
| `src/dog/config.ts` | Breed presets, defaults, the dice (`randomDogConfig`), validation, and the saved config store |
| `src/models/dog.ts` | Builds the dog from a `DogConfig` (shapes, colours, real size) and poses it from the brain's controls |
| `src/dog/brain.ts` | Behaviour: hand reactions and petting, follow / free roam / stay, go-to, commands, tricks, eye contact, per-person attention, listening to voice |
| `src/dog/fx.ts` | Flat-colour hearts when the dog is petted |
| `src/webxr.ts` | Android AR session: hit-test reticle, tap to place / send the dog, buttons, camera access + depth for vision |
| `src/cameraMode.ts` | Fallback without WebXR: live camera video behind the 3D view, the dog on a virtual floor |
| `src/dogPlay.ts` | Shared by both modes: the detector, people tracker, brain, voice button and chip, command / trick buttons, status line, vision drawing |
| `src/vision/detector.ts` | MediaPipe hands / faces / pose and the id tracker (global assignment, velocity prediction) |
| `src/vision/lift.ts` | Lifts detections into 3D world space (hand, face and body depth) |
| `src/vision/people.ts` | Groups hands, faces and bodies into stable people; works out who is speaking |
| `src/vision/handOccluder.ts` | The depth-only hand mask (under-sized capsules + palm slab, depth-refined when available) |
| `src/vision/xrCamera.ts` | WebXR camera image and (cpu) depth map reader |
| `src/voice/commands.ts` | Pure parser: transcript to dog command (phrases, filler, false-positive guards) |
| `src/voice/listener.ts` | Web Speech API wrapper: auto-restart, permission / unsupported states |
| `src/quicklook.ts` | iPhone path: exports the current dog to `.usdz` in the browser (re-exported when it changes) for AR Quick Look |
| `src/shadow.ts` | The invisible shadow-catcher plane under the dog |
| `src/net/protocol.ts` | The room messages, shared by the app and the Worker |
| `src/net/room.ts` | One phone's connection to a room: roster, reconnects, pings |
| `src/net/index.ts` | The page's room: `?room=` links, invite URL, room codes, a random dog for first-time guests |
| `src/net/sync.ts` | The pet state sent about 10 times a second and the events (commands, petting, party trick), checked on arrival |
| `src/net/remotePet.ts` | A friend's pet on this phone: built from their pet card, posed from their states (smoothed), name tag and shadow |
| `src/net/party.ts` | Multiplayer inside one AR / camera session: sends this pet, places friends' pets, petting them, the feed and 🎉 |
| `src/net/kinds.ts` | Which kinds of pet can join a room and how to build them (add cats here) |
| `src/net/ui.ts`, `src/net/net.css` | The 👥 button, the invite sheet with the QR code, the feed chips, the 🎉 button |
| `worker/index.ts` | The Cloudflare Worker: serves `dist/`, and a `Room` Durable Object per room code relays messages between its phones |
| `wrangler.jsonc` | Cloudflare config: Worker name (`hw13-pets`), static files, the `Room` Durable Object |
| `scripts/fake-friend.mjs` | A scripted friend (Mochi the corgi) for trying multiplayer without a second phone |

## Tweaks

- **Breeds** (sizes, default looks, colour swatches, names for the dice): `src/dog/config.ts`.
- **Dog behaviour** (follow distances, petting timing, turn speed): the constants at the top of `src/dog/brain.ts`. Trick lengths: `TRICK_DURATION` in `src/dog/types.ts`.
- **Camera mode framing** (assumed lens field of view, floor height, dog distance): the constants at the top of `src/cameraMode.ts`.
- **Voice phrases**: the tables at the top of `src/voice/commands.ts`; false-positive limits (max words without the dog's name) are there too.
- **Who is speaking / person grouping** (arm-reach gates, speaking thresholds, how long a person is remembered): constants at the top of `src/vision/people.ts`. Body / face / hand counts: `createVisionDetector({ maxHands, maxFaces, maxBodies })` in `src/dogPlay.ts`.
- **Hand mask size**: `BIAS` in `src/vision/handOccluder.ts` (lower = cuts out less of the dog, higher = bigger mask).
- **Shadow size**: `shadowSizeFor` in `src/shadow.ts`.
- **Multiplayer**: where friends' pets stand (`SLOTS`) and how often this pet is sent (`SEND_EVERY_MS`): top of `src/net/party.ts`. Smoothing delay (`INTERP_DELAY_MS`) and how far a friend's pet strays from its spot (`WANDER_RADIUS`): top of `src/net/remotePet.ts`. Players per room: `MAX_PLAYERS` in `src/net/protocol.ts`.
- **Cats in multiplayer**: in `src/net/kinds.ts`, send a `{ kind: "cat", config }` card from `localPetCard()` and build it in `createPetModel()`. The model must work like the dog's (`root`, `controls`, `update`, `getZones`, `height`, `length`, `dispose`), because friends' phones pose it from the same `DogControls`.
