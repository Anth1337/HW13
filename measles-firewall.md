# Measles Firewall

> A worried parent says where they were and who was with them. In seconds they get a checked answer: whether it matches an exposure, how much time they have, who to call, and a note for daycare. It never says "you're safe."

Hack Western 13 · Sun Life Best Health Hack · Team brief · Revised November 21, 2026, 3:30pm (updated to the v2 wireframes)

**Pitch line:** "Help Toronto hold the line until 2027."

---

## Context

- **Event:** Hack Western 13 at Western University, November 20 to 22, 2026. Theme: *Discover the unknown*.
- **Hacking window:** 9pm Friday, Nov 20 to 9am Sunday, Nov 22. Work done outside the window is disqualified.
- **Team:** 4 people. Goal: done by Saturday night, rehearse Sunday morning. As of 3:30pm Saturday that's about 8 hours of build.
- **Design:** [Measles Firewall designs (v2)](https://claude.ai/artifact/ArmAKaewqRhTSDFpLWpaqy). This brief follows v2. The v1 wireframes are out of date.
- **Our track: Best Health Hack (Sun Life).** "Creative technical solution to a real health problem. Pitch must show who it helps and potential impact." Prize: a $100 Amazon gift card per member.
- **Also enter:**
  - **TinyFish, Hire Your First AI Employee.** The Exposure Parser does a browser job on the live web: it watches TPH and PHO pages for new exposure notices. To qualify, post the demo on X or LinkedIn and tag TinyFish. Student credits: [tinyfish.ai/students](https://tinyfish.ai/students).
  - **MLH Best Use of Gemini API:** the Navigator, the Writer, and the parallel Safety Reviewer checks.
  - **Overall** (iPad / AirPods Pro 3 / Fitbit Air per member).
  - **Optional, MLH Best Use of Auth0:** "Auth0 for AI Agents," so a parent approves before anything is shared on their behalf.
- **How judges score** (equal weight, as far as we know): Innovation & Creativity, Technical Complexity, Completeness, Design. Judges penalize unoriginal ideas.
- **Long term:** a hackathon project that could become a civic-tech startup.

---

## Why now

- **Canada lost measles elimination status on November 10, 2025.** One strain spread for more than a year in a national outbreak that began in October 2024. PHAC says the outbreak was "mainly due to very low vaccine coverage in certain communities spread across the country."
- **The toll:**
  - Over 5,200 cases and two deaths in 2025 (Global Citizen, December 2025).
  - More than 6,400 people across 10 provinces over the whole two years (PHAC, October 2026).
- **It was worst next door to Western.** Oxford and Elgin counties (Southwestern Public Health) had the highest count in Canada.
- **The outbreak is over, but the status isn't back.**
  - PHAC declared the national outbreak over on October 19, 2026.
  - On November 17, 2026, PAHO Director Dr. Jarbas Barbosa said Canada had reported no new cases in the previous 60 days.
  - Status only comes back once the outbreak strain has stopped spreading for at least 12 months. Experts estimate the soonest is November 2027, because PAHO only meets once a year, each November (Global Citizen, citing epidemiologist Kathryn H. Jacobsen).
- **Measles keeps landing in Toronto.**
  - As of July 2026, Toronto Public Health (TPH) had confirmed five measles cases linked to international travel that year.
  - One case led to exposures in late June at Scarborough Health Network General Hospital's emergency waiting room, the hospital's kids' outpatient clinic, and a walk-in clinic.
  - The neighbours are a risk too. In November 2026 PAHO accepted that the United States, Mexico and Bolivia have also lost their status. Jacobsen told Global Citizen measles can be reintroduced "fairly easily" through travel across the border.
- **The target is 95%.** PAHO stresses keeping vaccination coverage at 95%. An average doesn't help a community sitting far below it.

**The gap we fill:** when an exposure notice goes up, a parent has to answer four questions fast, often in their second language:
1. Was I there at the same time?
2. How much time do I have?
3. Who do I call, and what do I need ready?
4. What do I tell daycare?

Each answer sits on a different website, and some of them expire within 72 hours.

**Who it helps:** Toronto families, especially parents of babies and families who are more comfortable in a language other than English. The MVP is built for Toronto; York and Peel are next, then any health unit.

---

## The idea

There are two screens:

1. **The parent's phone:** a short, calm flow. Where were you, who was with you, then the result, the next steps, and a note for daycare.
2. **The swarm console (desktop):** the demo screen beside it. It shows every step the agents took to answer that one parent, including each draft the Safety Reviewer blocked and why.

**The app calculates time windows and refers people to public health. It never decides on treatment, and it never tells anyone they're safe.**

### Agents and code tools

The v2 design splits the work into **AI agents** (reading, writing, judging) and **code tools** (anything that must be exactly right).

| AI agent | Does | Hands off |
|---|---|---|
| **Exposure Parser** (runs in the background) | Pulls TPH news releases and the Public Health Ontario (PHO) exposure list with TinyFish, and turns each notice into structured fields | Place, exposure window, "watch until" date, source |
| **Navigator** | Talks to the parent. Turns what they entered into a structured request, calls the code tools, and puts together the result screens in the parent's language | The request; the result |
| **Writer** | Drafts the note to daycare from approved TPH wording, in the chosen language, with placeholders for names | Drafts to the Safety Reviewer |
| **Safety Reviewer ("the dissenter")** | Five checks run **at the same time** on every draft. Any one failure sends the draft back to the Writer with the reason | Approved note, or a block with reasons |

| Code tool (not AI) | Does |
|---|---|
| `match()` | Place and time overlap between the visit and a parsed notice |
| `rules()` | Time windows and flags, from the rules table below |
| `records()` | Dose guide by age, from Ontario's schedule |
| `clinics()` | Nearby options: family doctor, TPH community clinics |

### The five checks (fix #1)

Each draft is checked five ways at once. Every check lights up on the console as it finishes.

| Check | How it runs | Example it catches |
|---|---|---|
| **Facts match the notice** | Gemini, comparing the draft with the parsed notice | Wrong place, date or time |
| **Time windows are right** | **Code**, comparing every date or duration in the draft with `rules()` output | "You have 6 days to get your baby the MMR vaccine" (the vaccine window is 72 hours) |
| **Never says you're safe** | Gemini | "Your baby was probably far from the patient, so there's likely no need to call" |
| **No medical advice** | Gemini, plus a hard rule: no treatment recommendations | "Get your baby the immune globulin shot" |
| **Doesn't blame a group** | Gemini | "Measles is coming from unvaccinated families in [neighbourhood]" |

- **The retry loop:** the Writer gets up to 3 tries. Each blocked draft goes back with the failed check's reason.
- **Fails closed:** if all 3 are blocked, the parent sees "We couldn't prepare your note" and TPH's number, never an unchecked note.
- **Drafts in other languages:** they're translated back into English before checking. Each check sees both the original and the back-translation.

### Why it's a swarm

- Five specialist reviewers run in parallel, and any one of them can veto.
- The Writer and the reviewers argue in a loop until a draft passes or the app fails safely.
- The Parser works on its own in the background, watching live public-health pages.
- The Navigator coordinates the code tools so the parent never waits on one long chain.
- **Stretch:** the Writer drafts every language on the note screen at once.

### Caveats the app shows

- **The PHO exposure list is incomplete.** It only includes sites where public health couldn't reach everyone who was exposed. A "no match" result says this plainly and still gives TPH's number.
- **Record gaps:**
  - People 16 and older access their own records.
  - People born before 1994 may have no public-health record on file.
  - For adults, fall back to the paper record (the "yellow card") or a doctor's record.

---

## The rules (plain code, not the LLM)

These rules override every agent. They live in one reviewed file with a source for each line, never in a prompt. `rules()` implements them.

| # | Rule | Source |
|---|---|---|
| 1 | MMR vaccine within **72 hours** of exposure lowers the risk of measles for susceptible people aged 6 months and older | [CMAJ](https://www.cmaj.ca/content/196/15/E524) |
| 2 | Immune globulin can be given up to **6 days** after exposure to high-risk people: infants under 12 months, and people who are pregnant or immunocompromised | [CMAJ](https://www.cmaj.ca/content/196/15/E524) |
| 3 | Watch for symptoms for **21 days** after exposure | [TPH measles fact sheet](https://www.toronto.ca/measles-fact-sheet) |
| 4 | A person is contagious from 4 days before to 4 days after the rash starts. The virus can stay infectious in the air for at least **2 hours** | [Durham Region fact sheet](https://durham.ca/en/health-and-wellness/resources/Documents/IllnessInfectionDisease/FactsAbout/Measles.pdf) |
| 5 | Exposed infants, pregnant people and immunocompromised people: **call TPH right away at 416-338-7600** (or 311) | [TPH measles page](https://www.toronto.ca/community-people/health-wellness-care/diseases-medications-vaccines/measles/) |
| 6 | Ontario schedule: one dose of MMR at 1 year, and one dose of MMRV at 4 to 6 years. During outbreaks, infants aged 6 to 11 months can get one MMR dose | [PHO routine and outbreak schedule](https://www.publichealthontario.ca/-/media/Documents/M/25/mmr-routine-outbreak-vaccine-schedule.pdf) |

**How the code tools use them:**
- **Windows count from the start of the notice's exposure window.** That's simpler than asking parents for exact times, and the deadlines are never later than they should be.
- **Watch-until date:** use the notice's own "watch until" date when it gives one, otherwise exposure plus 21 days.
- **The output is information and a referral, never treatment.** For example: "Call TPH now. They'll tell you what protection your baby needs."

---

## The parent's phone, screen by screen

**Demo case:** a parent and their 9-month-old were at the Scarborough General ER on Sunday, June 28. Replay mode freezes the clock at **Tuesday, June 30, 10am** and labels it on screen. The notice is a real past TPH notice.

| # | Screen | What happens | Who runs |
|---|---|---|---|
| 1 | **Where were you?** | Search for a place, or tap a recent exposure site. "Nothing you type is saved. Emergency? Call 911." | Exposure Parser (the list) |
| 2 | **Who was with you?** | Me, a baby under 1, a child, someone pregnant, someone with a weak immune system | Navigator |
| 3 | **Checking** | Shows each step as it runs: notices parsed, `match()`, `rules()`. "How we check" link | Navigator, `match()`, `rules()` |
| 4 | **Result** | "You may have been exposed." An orange box: "A baby was with you. Call Toronto Public Health now." The countdowns: vaccine window **21 h** (closes Wed Jul 1, 7am), immune globulin **3 d 21 h** (closes Sat Jul 4, 7am), watch for symptoms **to Jul 19** | `rules()` |
| 4b | **No match** (to add) | "We didn't find this place in the notices. That doesn't mean nobody was exposed there; the list isn't complete." TPH's number | `match()` |
| 5 | **What to do next** | Three steps, in order: (1) call TPH, (2) have the vaccine record ready (ICON with the health card number, or the yellow card; at 9 months the first dose isn't due yet), (3) go where public health sends you | `records()`, `clinics()` |
| 6 | **Writing the note** | "Writing your note," then "Checking it against the TPH notice" | Writer, Safety Reviewer |
| 7 | **Note ready** | Language options (English, Français, 中文, தமிழ், more), the note with [CHILD NAME] and [YOUR NAME] filled in on the phone, "Checked against the TPH notice," then Copy or Share | Writer, Safety Reviewer |
| 8 | **If checking fails** | "We couldn't prepare your note. To keep you safe, we only show notes that pass our checks." Call TPH, or Try again | Safety Reviewer |
| 9 | **How we check** | A pop-up panel: matched to the official notice; time windows use fixed rules, not AI guesses; a second check before you see it; "We never say you're safe" | — |

**Names never leave the phone.** The Writer only ever sees placeholders, and the real names are filled in by the browser.

---

## The swarm console (the visual)

The console sits next to the phone during the demo. It shows the agents working on that one request.

- **Sidebar:** the four agents with live status (the Parser's last run, the Writer's draft count, the Reviewer's blocked and approved counts), then the four code tools labelled "Code tools · not AI," then "Demo mode: uses past public TPH notices. No real parent data."
- **Live request:** what the parent asked, plus counters for drafts, blocked and approved.
- **Writer → Safety Reviewer:** one card per draft. All five checks start at once and tick or cross as each finishes. Blocked drafts are crossed out with the failed check's reason. The approved draft gets a bold border.
- **Run trace:** Navigator → `match()` → `rules()` → Writer → Reviewer, with what each step found.
- **Latest notice parsed:** the raw TPH text next to the fields the Parser pulled out.
- **What the parent sees:** the final note, exactly as the phone shows it.
- **Demo speed:** each step stays on screen for a moment so judges can follow. The events are real; only the display is slowed down.

---

## The core trick

**Gemini reads and writes. Plain code decides. Five checks gate everything.**

- **Gemini's jobs:** parse notices, run the conversation, write drafts, back-translate, and run four of the five checks.
- **Plain code's jobs:** every overlap, date, countdown, high-risk flag, dose and distance, plus the time-window check.
- **The gate:** the phone only renders a note that has passed all five checks. There is no path around it.

**What the Navigator hands to the code tools:**

```json
{
  "place": "Scarborough General Hospital, ER",
  "visit": { "date": "2026-06-28", "approx": "9–11 a.m." },
  "people": ["me", "baby_under_1"],
  "now": "2026-06-30T10:00"
}
```

**What the Parser stored for that notice:**

```json
{
  "site": "Scarborough General Hospital, emergency waiting room",
  "start": "2026-06-28T07:00",
  "end": "2026-06-28T13:30",
  "watchUntil": "2026-07-19",
  "source": "Toronto Public Health notice"
}
```

**What `match()` and `rules()` return:**

```json
{
  "match": true,
  "flags": ["infant_present"],
  "action": "call_tph_now",
  "windows": {
    "vaccine72h": { "closes": "2026-07-01T07:00", "left": "21h" },
    "immuneGlobulin6d": { "closes": "2026-07-04T07:00", "left": "3d 21h" },
    "watchUntil": "2026-07-19"
  }
}
```

**What the Safety Reviewer returns for a blocked draft:**

```json
{
  "draft": 2,
  "checks": {
    "factsMatchNotice": "pass",
    "timeWindowsRight": { "result": "fail", "reason": "says 6 days for MMR; the vaccine window is 72 hours (rule 1)" },
    "neverSaysSafe": "pass",
    "noMedicalAdvice": "pass",
    "noBlame": "pass"
  },
  "verdict": "blocked"
}
```

**Code notes:**
- The code tools are one plain TypeScript file, with tests:
  - right at the 72-hour and 6-day boundaries
  - an infant under 12 months
  - a notice without a "watch until" date
  - a place that isn't in the notices
- The five checks are five Gemini calls plus one function, run together with `Promise.all`.
- The official documents fit in Gemini's context window, so load the whole set into each check. There's no vector database.

---

## What makes it stand out

| Existing | What it does | What's missing |
|---|---|---|
| Health unit exposure pages | List places and times | Nothing personal: you still have to work out whether it affects your baby and how long you have |
| ICON and other record portals | Show the doses on file | Don't tell you what to do next or say it in your language |
| General AI chatbots | Answer health questions | Can invent facts, suggest treatment, or falsely reassure, and nothing checks them |

**Our standout:**
- A time-critical answer that's calculated, not guessed.
- Every message is checked five ways at once before a parent sees it.
- When checking fails, the app fails closed and sends you to public health.

**Technical complexity:**
- a live web agent watching public-health pages
- a tested rules engine for time windows
- a Writer-and-reviewers loop with five parallel checks, back-translation and fail-closed behaviour
- a console that shows the whole run as it happens

---

## How to build it

**Stack:**
- Next.js and TypeScript.
- Gemini for parsing, the Navigator, the Writer, back-translation and four of the checks. Check the current model names in Gemini's docs before wiring them up.
- TinyFish for the live TPH and PHO pages.
- Agents are plain async TypeScript functions. The checks run in parallel with `Promise.all`. No agent framework.
- Server-sent events stream every step to the console, and the progress steps to the phone.
- The rules file, the approved wording and the official documents as files in the repo.
- **Stateless:** no database and no accounts. Never store health card numbers, immunization IDs, records or names; storing them brings in Ontario's health privacy law (PHIPA). Demo data only.

**Team split:**

| Role | Owns |
|---|---|
| Parser and data | Exposure Parser on TinyFish (TPH and PHO), the replay notices, the clinic data behind `clinics()` |
| Code tools | `match()`, `rules()`, `records()`, `clinics()` and their tests |
| Writer and Reviewer | Writer prompts and approved wording, the five checks, back-translation, the retry loop and fail-closed behaviour, collecting the official documents |
| Frontend and story | The phone flow and console from v2, pitch, Devpost, the TinyFish social post, backup video |

**Build order (from 3:30pm Saturday):**
1. **By about 6pm:**
   - The code tools pass their tests.
   - The Parser reads one real TPH or PHO page.
   - The phone screens exist with fake data.
2. **By about 9pm:** the replay works end to end: place, people, result, next steps, then a note through the Writer and the five checks, with the retry loop and the fail-closed screen.
3. **By about midnight:**
   - The console runs live from the agents' events.
   - Language options on the note.
   - The no-match screen and the clinic list.
   - Record the backup video.
4. **Sunday morning:** rehearse, finish Devpost, and post the demo on X or LinkedIn tagging TinyFish (required to qualify). Submissions close at 9am.

**Scope:**
- **Must have:**
  - the phone flow end to end on the replay, including the no-match screen
  - the code tools with tests
  - the Writer with five parallel checks, one visibly blocked draft, and the fail-closed screen
  - the console showing the checks live
  - the Parser running on at least one real page
- **Should have:**
  - the note in 3 or more languages, with back-translation
  - the clinic list
  - an "Or tell us in your own words, any language" box on screen 1, with the Navigator filling in the form
- **Stretch:** the Writer drafting all languages at once, Auth0 approval before sharing, York and Peel.
- **Cut this weekend:** the outreach board and Community Voices, the Hesitancy Listener, reading a photo of the record, storing anything.

---

## How to demo (3 minutes)

| Time | Beat | Do and say |
|---|---|---|
| 0:00–0:20 | Hook | "A year ago Canada lost its measles elimination status. The outbreak's over, but measles keeps landing here: Toronto confirmed five travel-linked cases this year, with exposures in a Scarborough ER and a kids' clinic. The U.S. and Mexico just lost their status too. Experts say November 2027 is the earliest we get ours back. We built a way to help Toronto hold the line." |
| 0:20–1:05 | The phone | Tap the Scarborough General ER on June 28, then "a baby under 1," then Check. The Checking screen shows each step. Result: "You may have been exposed," "Call TPH now," 21 hours left on the vaccine window, 3 days 21 hours on immune globulin, watch until July 19. Then the three next steps. |
| 1:05–1:50 | The console | Tap "Write a note to daycare." On the console, the Writer's first draft hits the five checks at once: "Never says you're safe" fails ("probably far from the patient"). Draft 2: "Time windows are right" fails (6 days for the vaccine). Draft 3 passes all five and appears on the phone. Switch it to Tamil. |
| 1:50–2:15 | Fails closed | Show the "If checking fails" screen and the "How we check" panel. "If we can't check it, we don't show it. And we never tell anyone they're safe; only public health can." |
| 2:15–2:40 | Live web | Hit "Pull new notices." The Parser reads the real TPH and PHO pages through TinyFish right now (probably "no current exposures," which is good news). |
| 2:40–3:00 | Close | Who it helps: parents, especially of babies, in their own language. What's next: outreach to whole communities through people they trust, other health units, every vaccine-preventable disease. "Help Toronto hold the line until 2027." |

---

## Where it goes next (not built this weekend)

- **Outreach board for public health.** One message to a whole community:
  - **Exposure alerts** to the families likely to have been at a site.
  - **Catch-up campaigns** between outbreaks, to get every community to 95% before the next imported case.
  - Community Voice agents adapt approved wording for each language and community at the same time, then pass the same five checks. A public-health nurse, principal, community health worker or faith leader approves and sends each one through their own channel.
  - This reaches the families least likely to open an app or trust an official notice in English.
- **Hesitancy Listener:** summarizes the concerns people actually raise, with identities removed, so outreach answers real worries.
- **Record reader:** reads a record, including vaccine brand names (M-M-R II and Priorix are MMR, ProQuad and Priorix-Tetra are MMRV) and records from other countries, on the device.
- **More places and diseases:** York and Peel next, then any health unit, then other vaccine-preventable diseases.

---

## Risks and judge questions

- **"Is this medical advice?"** No.
  - The app calculates time windows from published rules and refers people to public health.
  - It never decides on treatment, and it never says you're safe.
  - Two of the five checks exist to enforce exactly that.
- **"Is this really a swarm?"** Yes, in a small way:
  - five specialist reviewers in parallel, any of which can veto
  - a Writer that argues with them until a draft passes or the app fails safely
  - a background agent watching live sites
  - and we draw the line between AI agents and code tools on purpose.
- **Health privacy.**
  - Nothing is saved, and names are filled in on the phone.
  - No health card numbers or record photos are collected; the parent opens ICON themselves.
  - **A real version:** a data agreement with a health unit and explicit parent consent.
- **Stigma.** Messages name places and dates, never communities. Check 5 enforces this.
- **The exposure list is incomplete.** The no-match screen says so every time, with TPH's number.
- **Translation quality.** Non-English drafts are back-translated before the checks. A teammate who reads one of the demo languages checks it before Sunday.
- **There are no live exposures right now.**
  - The story uses a real past notice in replay mode, with the clock frozen at June 30 and labelled on screen.
  - The live Parser shows the real pages as they are today.
- **Guidance changes.** Every rule and document shows its source and date.
- **Being polite to public sites.** Cache pages, check at a low rate, and only read public notices.

---

## Open items

- **Design to-dos for v2:**
  - Add the no-match screen.
  - Point "Find a clinic near me" somewhere (it currently links to `#`), or remove it.
  - Have the Checking screen name the steps it's running.
  - Make the console's "Parent asked" quote match the phone's input (the structured place and people, or the free-text box if we add it).
- Confirm the Qahwah Cafe (Sep 5) exposure on screen 1 against a real TPH notice, or replace it.
- Confirm TPH's number (416-338-7600) on the TPH page before the demo.
- Your teammate's original brief was cut off mid-sentence in its privacy section. Add anything that's missing.
- Still to collect for the reviewers: the measles chapter of the Canadian Immunization Guide (written by NACI, Canada's vaccine advisory committee).

---

## Sources

**Why now**
- [PHAC: Canada's response to measles](https://www.canada.ca/en/public-health/services/diseases/measles/canada-response.html)
- [PHAC: Statement on Canada's measles elimination status (Nov 10, 2025)](https://www.canada.ca/en/public-health/news/2025/11/statement-from-the-public-health-agency-of-canada-on-canadas-measles-elimination-status.html)
- [PAHO: Regional action as the Americas lose measles elimination status (Nov 10, 2025)](https://www.paho.org/en/news/10-11-2025-paho-calls-regional-action-americas-lose-measles-elimination-status)
- [Global Citizen: Canada loses measles-free status (Dec 22, 2025)](https://www.globalcitizen.org/en/content/canada-loses-measles-free-status/)
- [CIDRAP: Canada loses measles elimination status after record year of outbreaks](https://www.cidrap.umn.edu/measles/canada-loses-measles-elimination-status-after-record-year-outbreaks)
- [CTV News: Measles outbreak over after 2 years (Oct 19, 2026)](https://www.ctvnews.ca/health/article/measles-outbreak-over-after-2-years-thousands-infected-in-canada-phac/)
- [CP24: Measles outbreak over after 2 years (Oct 19, 2026)](https://www.cp24.com/news/canada/2026/10/19/measles-outbreak-over-after-2-years-thousands-infected-in-canada-phac/)
- [CP24: Canada makes progress toward measles-free designation as U.S., Mexico status revoked (Nov 17, 2026)](https://www.cp24.com/news/canada/2026/11/17/canada-makes-progress-toward-measles-free-designation-as-us-mexico-status-revoked/)
- [PAHO Director's remarks, measles media briefing (Nov 17, 2026)](https://www.paho.org/sites/default/files/2026/11/paho-director-remarks-media-briefing-measles-nov-17-2026.pdf)
- [PAHO: Measles in the Americas, questions and answers (Nov 17, 2026)](https://www.paho.org/en/news/17-11-2026-measles-americas-questions-and-answers-technical-reference-journalists-and-public)
- [Health Policy Watch: Three countries lose measles-free status](https://healthpolicy-watch.news/three-countries-lose-measles-free-status/)
- [Global News: Possible measles exposure at Scarborough hospital and clinic (Jul 5, 2026)](https://globalnews.ca/news/11953771/possible-measles-exposure-scarborough-hospital-clinic/)
- [CBC: Oxford, Elgin counties have highest measles case count in Canada](https://amp.cbc.ca/lite/story/1.7473063)

**The rules (official guidance)**
- [CMAJ: post-exposure MMR and immune globulin](https://www.cmaj.ca/content/196/15/E524)
- [TPH measles fact sheet](https://www.toronto.ca/measles-fact-sheet)
- [Durham Region: Measles fact sheet](https://durham.ca/en/health-and-wellness/resources/Documents/IllnessInfectionDisease/FactsAbout/Measles.pdf)
- [TPH: Measles](https://www.toronto.ca/community-people/health-wellness-care/diseases-medications-vaccines/measles/)
- [PHO: MMR routine and outbreak vaccine schedule](https://www.publichealthontario.ca/-/media/Documents/M/25/mmr-routine-outbreak-vaccine-schedule.pdf)
- [PHO: Post-exposure prophylaxis for immunocompromised people](https://www.publichealthontario.ca/-/media/Documents/M/25/measles-post-exposure-prophylaxis-immunocompromised.pdf)
- [PHAC: Guidance on managing measles cases, contacts and outbreaks](https://www.canada.ca/en/public-health/services/diseases/measles/health-professionals-measles/guidance-management-measles-cases-contacts-outbreaks-canada.html)
- [Ontario's routine immunization schedule](https://www.ontario.ca/page/ontarios-routine-immunization-schedule)

**Data for the agents**
- [TPH measles page and news releases](https://www.toronto.ca/measles)
- [PHO: Measles exposures in Ontario](https://www.publichealthontario.ca/en/diseases-and-conditions/infectious-diseases/vaccine-preventable-diseases/measles/measles-exposures-ontario)
- [TPH: Measles notification and investigation (clinics)](https://www.toronto.ca/community-people/health-wellness-care/health-programs-advice/measles-notification-and-investigation)
- [TPH: Immunization Connect Ontario (ICON)](https://www.toronto.ca/community-people/health-wellness-care/health-programs-advice/immunization/report-student-vaccination/immunization-connect/)
- [Halton: Report your immunizations (16+ access their own records)](https://www.halton.ca/for-residents/immunizations-preventable-disease/immunization/report-your-immunizations)
- [Region of Waterloo: Vaccine reporting (records before 1994)](https://regionofwaterloo.ca/VaccineReporting/)
- Optional: York and Peel public health pages for GTA-wide coverage; open data for transit and geocoding.
