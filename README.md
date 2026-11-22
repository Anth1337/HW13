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
| **iPhone / iPad** (Safari) | iOS Safari has no WebXR, so **Deploy** builds its own world tracking (see "iOS" below): the same flow as Android, scan the floor, tap to place the dog at real size, it stays put in the room as you move. |
| **Computer** | The creator and preview; **Deploy** opens camera mode with a webcam. |

## iOS (iPhone / iPad): how it works

iOS Safari has no WebXR, so **Deploy** on iOS runs our own tracker (`src/tracking/`) over the live camera:

- **Rotation** from the phone's gyro + gravity (DeviceOrientation / DeviceMotion).
- **Position** from visual odometry on the **floor plane**: features on the floor are tracked in the (small, rotation-compensated) camera image and solved for metric translation using an **assumed camera height**: 1.3 m, or 0.9 m when **Phone held: sitting** is picked next to Deploy (remembered in this browser). When there is nothing to track, the position is held (the accelerometer is not integrated: it drifts metres within seconds).
- **Video sync:** the camera image on screen is already 60–150 ms old (it varies by phone), while the gyro is current. The tracker measures that delay continuously by matching how far the image shifts against how far the gyro says the phone turned (`src/tracking/videoSync.ts`), and the 3D camera is rendered with the pose of the frame that is actually on screen (`getDisplayPose`), so the pet stays locked to the room when you turn instead of swimming ahead of it. The same measurement gives the odometry the right instant for each frame, which cuts the false drift turning causes. It also measures the lens field of view, which replaces the assumed ~65° once a few estimates agree it is more than 4% off (real phone video is often 5–10% off the guess, which made the pet swim on pans). In simulation (a phone looking around at a textured floor, 50–72° lenses, 70–140 ms camera delay) this cut the misalignment while turning from about 20–35 px to about 5 px on a phone screen, and the drift while turning in place by up to half.
- The dog is placed on the floor plane (tap, as on Android), kept world-anchored, and you tap the floor to send it, long-press to re-place it.
- Tip shown before Deploy and while scanning: hold the phone at chest height, point it at the floor and walk slowly.
- Coming back to the app (app switch, lock screen) restarts the video, re-zeroes the tracker and puts the pet back in front of you.
- iPhone runs lighter: render pixel ratio 1.5, 512 px shadow map, at most 2 hands / 2 faces and no body model, and the detector gets the video scaled down to 384 px.
- `npm run check:tracking` simulates turning, portrait frames and walking while looking around (at least 80% of the walked distance must be tracked; before the fix it was 60–70%).

Honest limits (nobody has verified this on a real iPhone yet):

- **Needs "Motion & Orientation" access.** Safari asks when you tap Deploy; if refused the dog can't stay put (fixed camera). Fix: Settings > Apps > Safari > Advanced > Motion & Orientation Access (path from memory; Safari may remember a refusal, in which case change the setting and reload).
- **Scale and drift:** there is no depth / LiDAR from the web, so scale comes from the camera-height assumption and the position drifts over time; best on **textured floors** and slow movement. Re-place the dog to recentre.
- **No depth-refined hand mask** on iOS (capsule shape only).
- **Voice:** needs **Dictation** on (Settings > General > Keyboard > Enable Dictation; Siri also needs to be on) and microphone access. Without it iOS reports `service-not-allowed` / `not-allowed` and the app says so. Audio goes to Apple's speech service.
- The Deploy tap starts the motion prompt, then the camera prompt. The microphone is not asked in that tap on iPhone (stacked prompts can be auto-denied): tap 🎤 once in camera mode to enable voice.

### Can a web page get native AR on iOS Safari? (checked 2026-11-21)

- **WebXR `immersive-ar` on iPhone / iPad Safari: no.** Several 2026 web sources (not Apple primary docs, so treat as secondary) say iOS Safari has no `immersive-ar`/`immersive-vr` and no native AR access; we also feature-detect at runtime, so if Apple ships it the Android WebXR path is used automatically. visionOS Safari has WebXR (VR; `immersive-ar` support reported inconsistently), not relevant for phones. No experimental flag for iOS `immersive-ar` was found (from memory, unverified: the flag list has WebXR Device API entries that expose nothing on iPhone).
- **WebAR SDKs with SLAM:** 8th Wall's hosted services were shut down by Niantic; the engine went open source at 8thwall.org (transition complete 2026-02-28, hosted projects live until 2027-02-28), but its core tracking is a proprietary binary and not open source (per Niantic Spatial's blog). Zappar (Mattercraft / Universal AR), Variant Launch: commercial / licensed, from memory, not checked here. MindAR is open source (MIT) but does image and face tracking, not world SLAM (from memory). We build our own instead.

## 3. Play

The **dog** and the **cat** share the same play modes; the buttons change to suit the animal.

- **Your hand comes first.** Hold your hand out in front of the camera: the dog looks at it and trots over to sniff it, and follows it with its head (and body) as you move it slowly. Put your hand on its **head** (it closes its eyes and leans in) or its **back** (it wiggles and wags like mad) to **pet** it: hearts float up and the phone buzzes. Only your hand is needed, not your whole body.
- **Hand in front of the dog**: when your hand is close to the camera the dog is hidden behind it, so your hand really looks in front of the dog.
- **Moves on its own**: in **Follow** mode it stays near you and trots after you when you walk away; in **Free roam** it wanders and sniffs around nearby. The mode button switches between them.
- **Tap the floor** to send it somewhere; it waits there.
- **Sit**, **Lie down**: it stays put until you give another command. **Come**: it walks to you and follows you again.
- **Tricks**: **Roll over**, **Jump**, **Spin**.
- **Cats** get cat commands: **Sit**, **Loaf** (tucked-up paws), **Here kitty** (it comes over... when it feels like it, so it may ignore you), **Follow** / **Free roam**, and the tricks **Pounce**, **Stretch** and **Groom**. Petting a cat makes it purr, slow-blink and rub its head on your hand, or arch its back with its tail up.
- **Voice commands**: tap **🎤** and talk to the dog (see below).
- **Several people**: the dog tells people apart and keeps them straight (see below).
- **Friends' pets**: several phones in one room, each with its own pet (see below).
- **Eye contact**: someone looking at the dog gets looked back at (one person at a time, and it doesn't flip-flop between two lookers).
- **Screen layout**: commands (top row) and tricks (bottom row) sit at the bottom of the screen; **✕** (top-left) goes back to the creator; the small tools are stacked top-right: **🐾** (in a room), **🎤** and **👁**.
- **👁** draws what the computer vision sees (hands, bodies, faces, person ids, who is speaking, depth / mask state) on top of the camera.

### Play together (multiplayer)

Every phone brings its own pet to the party, and everyone sees everyone's pets.

- On the start screen, tap **👥 Friends**: it opens a room and shows a **QR code**, the room code and a link (big enough to show on a projector from a laptop). Friends scan it with the phone camera, make their dog (a first-time guest starts with a random one, so the room isn't full of identical labradors) and **Deploy**. The button shows how many are in the room ("👥 3 here").
- In AR / camera mode, friends' pets stand around yours with their name above them, doing exactly what they do on their owner's phone: walking, sitting, tricks, being petted.
- **Pet a friend's pet** with your hand: it leans in here, on its owner's phone and on everyone else's, and the owner sees "💕 …'s human is petting …".
- **Pets meet each other.** Now and then an idle pet (following or roaming) walks over to a friend's pet to say hi, and **🐾** sends yours right away (to the friend's pet it met least recently). The two walk up nose to nose, sniff, then each does a trick that suits the other: two dogs spin and jump, a dog and a cat jump and pounce, two cats stretch and groom. A pet that is sitting or lying stays put and the other one comes to it. Every phone shows the meeting from where the pets stand on that phone.
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
| "pounce", "stretch", "groom" / "wash" | the cat's tricks |
| "here kitty", "kitty kitty", "pspsps" | a cat comes (when it feels like it) |

Each animal only knows its own tricks: saying "roll over" to a cat (or "pounce" to a dog) shows a chip saying it doesn't know that one instead of doing anything.

Filler like "please", "good boy" or "kitty" is ignored, and if several commands are in one sentence the last wins. Saying the dog's name ("Biscuit, sit") always counts; without the name only short, command-like phrases count, so a conversation about sitting down doesn't make the dog sit. Any speech makes the dog perk up and look at the speaker. Commands act as soon as the browser has heard them, before you finish the sentence.

Support: **Chrome on Android** and **Safari on iPhone** have the Web Speech API; Firefox doesn't. On iPhone, Dictation must be enabled in iOS Settings. **Privacy: unlike the camera, speech recognition does not stay on the device.** In these browsers the audio is normally sent to the browser vendor's speech service (Google for Chrome, Apple for Safari) to be turned into text, so it needs a network connection. The app itself never records or uploads audio. Android Chrome may beep each time the recogniser restarts, and inside the Android AR session the browser may refuse the microphone; if so the 🎤 button shows it is blocked and everything else still works.

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
- Without WebXR (iPhone) the 3D camera comes from our own tracker (`src/tracking/`, see "iOS"). With no motion sensors (desktop webcam) it stays fixed: the phone/webcam is assumed to be about 1.3 m above the floor, tilted down a little, with a typical ~65° lens.

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

### Multiplayer while developing

The rooms run in a local copy of the Cloudflare Worker, next to Vite. Use two terminals:

```sh
npm run dev         # terminal 1: the app; it forwards /party to the rooms
npm run dev:rooms   # terminal 2: builds once, then runs the rooms on http://127.0.0.1:8787
```

Phones reach the rooms through the same address as the page, so options A, B and C above work unchanged. To use the deployed rooms from a local front-end instead, put `VITE_ROOM_SERVER=wss://hw13-pets.<your-subdomain>.workers.dev` in `.env.local`.

No second phone? `npm run fake-friend -- <invite link>` (or `-- <room code>` for the local rooms) adds Mochi, a scripted corgi who walks, sits, does tricks, pets your pet now and then and walks over to say hi to it every 24 s. It works against the deployed site too.

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
- **iPhone**: **Safari**, iOS 14.5+, HTTPS, Motion & Orientation access allowed.
- **Computer**: any modern browser with a webcam, for camera mode (over HTTPS or localhost).

## Files

| File | What it does |
|---|---|
| `index.html` | Page layout: start screen (title, status, My pets menu, back button, creator panel, Deploy), the camera-mode video, and the AR overlay (hint and status chips at the top, Exit top-left, voice / vision / say-hi tools top-right, command and trick rows docked at the bottom, vision canvas) |
| `src/main.ts` | Detects the device and picks WebXR, camera mode or the creator alone; switches the panel between the menu and the creator; shows the centered "Checking AR support…" screen until it knows |
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
| `src/dog/brain.ts` | Behaviour for both species (per-species profiles): hand reactions and petting, follow / free roam / stay, go-to, commands, tricks, eye contact, per-person attention, listening to voice |
| `src/dog/fx.ts` | Flat-colour hearts when the dog is petted |
| `src/webxr.ts` | Android AR session: hit-test reticle, tap to place / send the dog, buttons, camera access + depth for vision |
| `src/cameraMode.ts` | Without WebXR (iPhone, desktop): live camera video behind the 3D view; world-tracked scan / tap-to-place flow when motion sensors exist, a fixed camera otherwise |
| `src/tracking/*` | iOS world tracking: `types.ts` (contract), motion permission, gyro / gravity fusion, floor-plane visual odometry with assumed camera height, `videoSync.ts` (measures camera delay and field of view so the render pose matches the frame on screen) |
| `src/dogPlay.ts` | Shared by both modes: the detector, people tracker, brain, voice button and chip, command / trick buttons, status line, vision drawing |
| `src/vision/detector.ts` | MediaPipe hands / faces / pose and the id tracker (global assignment, velocity prediction) |
| `src/vision/lift.ts` | Lifts detections into 3D world space (hand, face and body depth) |
| `src/vision/people.ts` | Groups hands, faces and bodies into stable people; works out who is speaking |
| `src/vision/handOccluder.ts` | The depth-only hand mask (under-sized capsules + palm slab, depth-refined when available) |
| `src/vision/xrCamera.ts` | WebXR camera image and (cpu) depth map reader |
| `src/voice/commands.ts` | Pure parser: transcript to dog command (phrases, filler, false-positive guards) |
| `src/voice/listener.ts` | Web Speech API wrapper: auto-restart, permission / unsupported states |
| `src/shadow.ts` | The invisible shadow-catcher plane under the dog |
| `src/net/protocol.ts` | The room messages, shared by the app and the Worker |
| `src/net/room.ts` | One phone's connection to a room: roster, reconnects, pings |
| `src/net/index.ts` | The page's room: `?room=` links, invite URL, room codes, a random dog in slot 1 for first-time guests |
| `src/net/sync.ts` | The pet state sent about 10 times a second and the events (commands, petting, pets meeting), checked on arrival |
| `src/net/remotePet.ts` | A friend's pet on this phone: built from their pet card, posed from their states (smoothed), name tag and shadow |
| `src/net/party.ts` | Multiplayer inside one AR / camera session: sends this pet, places friends' pets, petting them, pets meeting each other, the feed and 🐾 |
| `src/net/kinds.ts` | The pet card this phone sends (its active dog or cat), building a friend's dog or cat from theirs, names, emoji, petting haptics |
| `src/net/ui.ts`, `src/net/net.css` | The 👥 button, the invite sheet with the QR code, the feed chips, the 🐾 button |
| `worker/index.ts` | The Cloudflare Worker: serves `dist/`, and a `Room` Durable Object per room code relays messages between its phones |
| `wrangler.jsonc` | Cloudflare config: Worker name (`hw13-pets`), static files, the `Room` Durable Object |
| `scripts/fake-friend.mjs` | A scripted friend (Mochi the corgi) for trying multiplayer without a second phone |

## Tweaks

- **Breeds** (sizes, default looks, colour swatches, names for the dice): `src/dog/config.ts` and `src/cat/config.ts`.
- **Number of slots / species in the menu**: `SLOT_COUNT` and `SPECIES` in `src/pets.ts`.
- **Dog behaviour** (follow distances, petting timing, turn speed): the constants at the top of `src/dog/brain.ts`. Trick lengths: `TRICK_DURATION` in `src/dog/types.ts`.
- **Camera mode framing** (assumed lens field of view, floor height, dog distance): the constants at the top of `src/cameraMode.ts`.
- **Voice phrases**: the tables at the top of `src/voice/commands.ts`; false-positive limits (max words without the dog's name) are there too.
- **Who is speaking / person grouping** (arm-reach gates, speaking thresholds, how long a person is remembered): constants at the top of `src/vision/people.ts`. Body / face / hand counts: `createVisionDetector({ maxHands, maxFaces, maxBodies })` in `src/dogPlay.ts`.
- **Hand mask size**: `BIAS` in `src/vision/handOccluder.ts` (lower = cuts out less of the dog, higher = bigger mask).
- **Shadow size**: `shadowSizeFor` in `src/shadow.ts`.
- **Multiplayer**: where friends' pets stand (`SLOTS`) and how often this pet is sent (`SEND_EVERY_MS`): top of `src/net/party.ts`. Smoothing delay (`INTERP_DELAY_MS`) and how far a friend's pet strays from its spot (`WANDER_RADIUS`): top of `src/net/remotePet.ts`. Players per room: `MAX_PLAYERS` in `src/net/protocol.ts`.
- **Pets meeting**: how often an idle pet goes to say hi (`MEET_AUTO_MIN_S` / `MEET_AUTO_MAX_S`), the timeline (`MEET_SNIFF_S`, `MEET_TRICK_S`, `MEET_END_S`) and which tricks each species pair does (`MEET_TRICKS`): top of `src/net/party.ts`.
- **New species in multiplayer**: a pet card's `kind` is the species from `src/pets.ts`, so a species `sanitizePet()` and `createPetCharacter()` know joins rooms automatically (`src/net/kinds.ts`). Friends' phones pose it from the same `PetControls`. A trick a friend sends to your pet is replaced by your animal's trick in the same button slot.
