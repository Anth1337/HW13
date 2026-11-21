# Measles Firewall

> One worried parent's question goes in. The whole public-health response comes out: in their language, on the clock, and checked before anything is sent.

Hack Western 13 · Sun Life Best Health Hack · Team brief · Revised November 21, 2026, 3pm (merged with a teammate's brief)

**Pitch line:** "Help Toronto hold the line until 2027."

---

## Context

- **Event:** Hack Western 13 at Western University, November 20 to 22, 2026. Theme: *Discover the unknown*.
- **Hacking window:** 9pm Friday, Nov 20 to 9am Sunday, Nov 22. Work done outside the window is disqualified.
- **Team:** 4 people. Goal: done by Saturday night, rehearse Sunday morning. As of 3pm Saturday that's about 9 hours of build.
- **Wireframes (in progress):** [Measles Firewall wireframes](https://claude.ai/artifact/K4o73XKtbskoLfrbqpx3i2)
- **Our track: Best Health Hack (Sun Life).** "Creative technical solution to a real health problem. Pitch must show who it helps and potential impact." Prize: a $100 Amazon gift card per member.
- **Also enter:**
  - **TinyFish, Hire Your First AI Employee.** The Exposure Scout and Clinic Finder do browser jobs on the live web: watching public-health pages for changes and checking clinic pages. To qualify, post the demo on X or LinkedIn and tag TinyFish. Student credits: [tinyfish.ai/students](https://tinyfish.ai/students).
  - **MLH Best Use of Gemini API:** multilingual agents, reading records, and the safety reviewer.
  - **Overall** (iPad / AirPods Pro 3 / Fitbit Air per member).
  - **Optional, MLH Best Use of Auth0:** "Auth0 for AI Agents," so a parent approves before an agent sends anything on their behalf.
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
1. Was my kid there?
2. How much time do I have?
3. Is my kid protected?
4. Where do I go, and what do I tell the school?

Each answer sits on a different website, and some of the answers expire within 72 hours. Meanwhile, public-health teams have to reach each community in its own language, through messengers it trusts, without stigmatizing anyone.

**Who it helps:**
- Toronto families, especially newcomers and families in under-vaccinated communities.
- The TPH and community health workers who have to reach them.
- **The MVP is built for Toronto.** York and Peel are next, then any health unit.

---

## The idea

Measles Firewall is a neighbourhood-level measles response cell made of AI agents. It has two screens.

1. **Parent mode:** a parent asks one question in any language and gets one answer: whether they were exposed, how long they have, whether their kids are protected, where to go, and a note for the school.
2. **Response cell mode:** for public-health and community workers. A live exposure feed, outreach drafts for every community at once, the concerns people are actually raising, and a reviewer that every message must get past.

**The swarm calculates time windows and refers people to public health. It never decides on treatment.**

### The agents

| Agent | Does | Uses | Hands off |
|---|---|---|---|
| **Exposure Scout** | Pulls exposure sites from TPH news releases and the Public Health Ontario (PHO) exposure list | TinyFish on live pages; Gemini to extract fields | Location, date, time window, "monitor until" date |
| **Exposure Matcher** (plain code) | Matches "I was at X on day Y" against the exposure records and applies the time-window rules: hours since exposure, which windows are still open | The rules file | Overlap yes/no, open windows with closing times, who is high-risk |
| **Record Detective** | Helps the parent *find* their child's record, then *reads* it and checks it against the schedule | Guidance on Ontario's online system (ICON); Gemini to read typed dates or a photo of the record; **plain code** for the schedule check | Doses found, doses due |
| **Clinic Finder** | Finds the nearest place to get the measles vaccine, with transit and language information | Doctor's offices (anyone), TPH community clinics (school-aged kids); TinyFish to check live clinic pages | 3 options with hours and links |
| **Community Voice** (one per language or community, running in parallel) | Adapts approved public-health wording for its community: a school newsletter blurb, a voice-note script, a flyer | Approved TPH and PHO text, each community's framing guide, Gemini | Drafts to the dissenter |
| **Hesitancy Listener** | Summarizes the concerns people actually raise, with identities removed, so outreach answers real worries | Anonymized questions from parent mode, notes from outreach workers | Weekly themes that shape the Voices' drafts |
| **Clinical Safety Reviewer ("the dissenter")** | Checks every message against official guidance and the rules before it can be shown or sent. It can block anything, and every objection is logged and shown | The rules file, official guidance documents, hard rules | Pass with citations, fix, or block, plus the objection log |

**Why a swarm:**
- Every community needs different messengers and framing, so the Voices work in parallel instead of in one long queue.
- The dissenter can say no to any agent, including the others' best drafts. That is what makes this a swarm and not a single chatbot.

**Important caveats the app shows:**
- **The PHO exposure list is incomplete.** It only includes sites where public health couldn't reach everyone who was exposed. If a place isn't listed, the app says plainly that this doesn't mean nobody was exposed there, and still gives TPH's number.
- **Record gaps:**
  - People 16 and older have to access their own records.
  - People born before 1994 may have no public-health record on file.
  - For adults, fall back to the paper record (the "yellow card") or a doctor's record.

---

## The rules (plain code, not the LLM)

These rules override every agent. They live in one reviewed file with a source for each line, never in a prompt.

| # | Rule | Source |
|---|---|---|
| 1 | MMR vaccine within **72 hours** of exposure lowers the risk of measles for susceptible people aged 6 months and older | [CMAJ](https://www.cmaj.ca/content/196/15/E524) |
| 2 | Immune globulin can be given up to **6 days** after exposure to high-risk people: infants under 12 months, and people who are pregnant or immunocompromised | [CMAJ](https://www.cmaj.ca/content/196/15/E524) |
| 3 | Watch for symptoms for **21 days** after exposure | [TPH measles fact sheet](https://www.toronto.ca/measles-fact-sheet) |
| 4 | A person is contagious from 4 days before to 4 days after the rash starts. The virus can stay infectious in the air for at least **2 hours** | [Durham Region fact sheet](https://durham.ca/en/health-and-wellness/resources/Documents/IllnessInfectionDisease/FactsAbout/Measles.pdf) |
| 5 | Exposed infants, pregnant people and immunocompromised people: **call TPH right away at 416-338-7600** (or 311) | [TPH measles page](https://www.toronto.ca/community-people/health-wellness-care/diseases-medications-vaccines/measles/) |
| 6 | Ontario schedule: one dose of MMR at 1 year, and one dose of MMRV at 4 to 6 years. During outbreaks, infants aged 6 to 11 months can get one MMR dose | [PHO routine and outbreak schedule](https://www.publichealthontario.ca/-/media/Documents/M/25/mmr-routine-outbreak-vaccine-schedule.pdf) |

**How the Matcher uses them:**
- **Count from the earliest possible exposure.** Windows start at the earliest time the person could have been exposed (the start of the overlap with the notice), so deadlines are never later than they should be.
- **Watch-until date.** Use the notice's own "monitor until" date when it gives one. Otherwise use exposure plus 21 days.
- **The 2-hour rule.** If a notice only gives when the sick person was there, add 2 hours to the end of the window (rule 4). Check how TPH writes its windows first; most notices already include this.
- **Output is information and a referral, never treatment.** For example: "Your 72-hour window closes tomorrow at 2pm. Call TPH now; they'll tell you what's right for your baby."

---

## Parent mode, step by step

**The demo case:** a mom types in Tagalog (use whichever language a teammate can check): *"I was at the kids' clinic at Scarborough General on Friday afternoon with my 9-month-old and my 5-year-old. Are they protected?"*

1. **Exposure Scout** finds the matching notice. In the demo this is a replay modelled on the real June 2026 Scarborough exposures, labelled "replay" on screen.
2. **Exposure Matcher** confirms the visit overlaps the exposure window. Then it starts the clocks:
   - 44 hours since exposure.
   - The 72-hour window closes **tomorrow at 2pm**.
   - The 6-day window closes Thursday.
   - Watch for symptoms until December 11.
3. **The baby is under 12 months, so they're high-risk.** The top of the screen, before anything else: **"Call Toronto Public Health now: 416-338-7600."** The countdowns sit underneath.
4. **Record Detective**, for the 5-year-old:
   - **Finding the record:** explains where it is. ICON needs the child's Ontario health card number or 10-digit immunization ID, and the app never logs in for the parent. Other options are the yellow card or the family doctor.
   - **Reading it:** finds one dose of Priorix (a measles vaccine).
   - **Checking it:** plain code compares it to the Ontario schedule. The second dose is due now.
5. **Clinic Finder** returns the nearest options: a TPH community clinic for the 5-year-old and the family doctor, with transit directions and whether Tagalog is spoken there.
6. A **Community Voice** agent writes the note to the 5-year-old's school: an English copy to send, and a Tagalog copy so the mom knows what it says. It's built from approved TPH wording.
7. **The dissenter** stamps everything with citations, and its objection log is one tap away.

---

## Response cell mode

- **Exposure feed and map:** every active notice from TPH and PHO, with clinics plotted around it.
- **Outreach board:**
  - When a notice lands, one Community Voice agent per language starts adapting TPH's approved wording at the same time. For example: Tamil, Tagalog, Traditional Chinese, Punjabi and Spanish.
  - Each draft is translated back into English and checked again, so a meaning that drifted in translation gets caught.
  - **Languages Gemini handles poorly** go to a human translator. For example Low German, spoken by many of the Mennonite families hit hardest in 2025. The system knows when not to trust itself.
- **Hesitancy themes:** this week's concerns with counts and anonymized example questions. These feed straight into the Voices' drafts.
- **The dissenter's column:** every draft marked passed, fixed or blocked, with the objection and the source it checked against.

### What the outreach drafts are for

Parent mode is one parent asking one question. Outreach goes the other way: public health sends one message to a whole community.

**What they are:**
- a school newsletter blurb
- a voice-note script a community leader can send to a WhatsApp group
- a flyer for a community centre or place of worship

**There are two kinds:**

| Kind | When | Example |
|---|---|---|
| Exposure alert | A notice goes up | "If you were at the kids' clinic at Scarborough General on Friday between 8am and 3pm, check your family's vaccines and watch for symptoms until December 11. If you have a baby under one, or you're pregnant or immunocompromised, call TPH now." Sent to families likely to have been there. |
| Catch-up campaign | Any time, but especially now, between outbreaks | "Kids need two doses of measles vaccine. Free TPH clinic this Saturday." The "firewall" part: get every community to 95% before the next imported case. |

**Who uses them:** a public-health nurse, a school principal, a community health worker, or a faith leader. The app only drafts. A person edits, approves and sends it through their own channel. Nothing goes out automatically.

**Why they matter:**
- Parent mode only helps parents who are already worried enough to ask.
- The outbreak spread mostly in under-vaccinated communities, where people are least likely to open an app or trust an official notice in English.
- Outreach reaches them through people they already trust, in their own language.
- A health unit can't adapt and translate ten versions of every message by hand in an afternoon. The Community Voice agents can.

**Why it matters for the build:** the Voices drafting for several communities at once, plus a dissenter that can block any of them, are what make this a swarm and not a pipeline of agents in a row.

**If time runs short:** the school note in parent mode is already one outreach draft. Shrink the response cell to a single 30-second moment: one alert, five Voices drafting it at once, each getting past the dissenter.

---

## The core trick

**Gemini reads and writes. Plain code decides. The dissenter gates.**

- **Gemini's jobs:** pull fields out of messy notices and records, adapt approved wording, translate, summarize concerns, and act as the dissenter.
- **Plain code's jobs:** every date, countdown, dose count, exposure overlap, "high-risk," "due now" and distance, computed from the rules file and official data. A model never decides whether a child is protected or what treatment they need.
- **The gate:** a send or export button only exists on a message that has passed review. There is no path around it.

**What the Scout and the Record Detective hand to the code:**

```json
{
  "exposure": {
    "site": "Scarborough General Hospital, kids' outpatient clinic (replay)",
    "start": "2026-11-20T08:00",
    "end": "2026-11-20T15:00",
    "monitorUntil": "2026-12-11",
    "healthUnit": "Toronto Public Health",
    "noticeQuote": "Anyone exposed should check that they've been fully vaccinated...",
    "sourceUrl": "https://..."
  },
  "visit": { "start": "2026-11-20T14:00", "end": "2026-11-20T15:00" },
  "now": "2026-11-22T10:00",
  "people": [
    { "label": "baby", "born": "2026-02-10", "doses": [] },
    { "label": "older child", "born": "2021-03-02", "doses": [{ "date": "2022-03-10", "product": "Priorix" }] }
  ]
}
```

**What the code returns:**

```json
{
  "visitOverlapsExposure": true,
  "hoursSinceExposure": 44,
  "windows": {
    "mmr72h": { "closes": "2026-11-23T14:00", "open": true },
    "immuneGlobulin6d": { "closes": "2026-11-26T14:00", "open": true },
    "watchSymptomsUntil": "2026-12-11"
  },
  "people": [
    { "label": "baby", "ageMonths": 9, "highRisk": true, "action": "call_tph_now" },
    { "label": "older child", "measlesDoses": 1, "status": "due", "next": "second dose (routine at 4 to 6 years)" }
  ]
}
```

**The rules code:**
- It's one plain TypeScript file, with tests.
- **The Matcher's tests:**
  - right at the 72-hour and 6-day boundaries
  - an infant under 12 months
  - a notice without a "monitor until" date
  - a visit that only touches the 2-hour tail of a window
- **The schedule checker:**
  - Maps vaccine brand names: M-M-R II and Priorix are MMR, ProQuad and Priorix-Tetra are MMRV.
  - Applies rule 6.
  - Checks minimum ages and minimum gaps between doses.
  - Reads records from other countries after Gemini extracts them. It shows a "confirm with your doctor or TPH" note.

**How the dissenter works:**
1. It splits each message into claims.
2. Each claim must match the approved wording, the rules file, or a passage in the official guidance. Otherwise it's blocked.
3. Hard rules on top:
   - Exposure messages must include TPH's contact.
   - Nothing recommends a treatment. "Get the immune globulin shot" is blocked and replaced with "call TPH; they'll tell you whether preventive treatment is right."
   - No message names a community as the cause.
   - Every number must match its source.
4. Every objection is logged with the claim, the reason, and the source.
5. **No vector database.** The official documents fit in Gemini's context window, so load the whole set into every review call.

---

## What makes it stand out

| Existing | What it does | What's missing |
|---|---|---|
| Health unit exposure pages | List places and times | Nothing personal: you still have to work out whether it affects your kid and how long you have |
| ICON and other record portals | Show the doses on file | Don't tell you what's due, where to go, or say it in your language |
| General AI chatbots | Answer health questions | Can invent facts or suggest treatment, and nothing checks them before you act |
| Translation services | Translate one message at a time | Slow, and blind to framing and trusted messengers |

**Our standout:** one question goes in and the whole response comes out at once, in your language, with the clock running. Nothing reaches a parent or a community without getting past a dissenter that cites its sources.

**Technical complexity:**
- agents running in parallel with a hard review gate and an objection log
- a tested rules engine for time windows and schedules
- structured extraction from live web pages and from photos of records, including records from other countries
- back-translation checks
- live checks on real public-health and clinic sites

---

## How to build it

**Stack:**
- Next.js and TypeScript.
- Gemini for structured output (extraction), vision (records), multilingual adaptation, and the dissenter. Check the current model names in Gemini's docs before wiring them up.
- TinyFish for the live pages: TPH news releases, the PHO exposure list, and clinic pages.
- Agents are plain async TypeScript functions. Voices run in parallel with `Promise.all`. No agent framework.
- Server-sent events stream each agent's progress to the screen, so the swarm visibly works in parallel.
- The rules file, the approved wording and the official documents as files in the repo.
- **Stateless:** no database, no accounts. Never store health card numbers, immunization IDs or records, because storing them brings in Ontario's health privacy law (PHIPA). Demo data only.

**Team split:**

| Role | Owns |
|---|---|
| Scouts | Exposure Scout and Clinic Finder on TinyFish, the TPH and PHO parsers, the replay notice, the clinic list with transit and languages |
| Rules and records | The rules file, the Exposure Matcher, the schedule checker and their tests, the Record Detective (finding and reading records) |
| Voices and the dissenter | Community Voice agents and the approved-wording library, back-translation, Hesitancy Listener, the dissenter and its objection log, collecting the official documents |
| Frontend and story | Parent mode and response cell from the wireframes, the map, pitch, Devpost, the TinyFish social post, backup video |

**Build order (from 3pm Saturday):**
1. **By about 5:30pm:**
   - The rules file and Matcher pass their tests.
   - The official documents and approved wording are collected.
   - The Scout parses one real TPH or PHO page.
   - Parent mode renders fake agent events, following the wireframes.
2. **By about 9pm:** parent mode works end to end on the replay: notice, countdowns, high-risk banner, record, clinic, school note, dissenter.
3. **By about midnight:** response cell mode with parallel Voices, back-translation, Hesitancy Listener themes, the live clinic check. Record the backup video.
4. **Sunday morning:** rehearse, finish Devpost, and post the demo on X or LinkedIn tagging TinyFish (required to qualify). Submissions close at 9am.

**Scope:**
- **Must have:**
  - parent mode end to end on the replay, including both kids
  - the rules file, Matcher and schedule checker, with tests
  - the dissenter, with citations and one visibly blocked draft
  - at least 3 languages
  - the Scout running on at least one real TPH or PHO page
- **Should have:** response cell mode, the Hesitancy Listener, back-translation, reading records from other countries, the live clinic check.
- **Stretch:** Auth0 consent before sending, WhatsApp or SMS export, York and Peel coverage.
- **Cut:** storing anything, accounts, real personal health information, scraping social media, any treatment decision.

---

## How to demo (3 minutes)

| Time | Beat | Do and say |
|---|---|---|
| 0:00–0:20 | Hook | "A year ago Canada lost its measles elimination status. The outbreak's over, but measles keeps landing here: Toronto confirmed five travel-linked cases this year, with exposures in a Scarborough ER and a kids' clinic. The U.S. and Mexico just lost their status too. Experts say November 2027 is the earliest we get ours back. We built a way to help Toronto hold the line." |
| 0:20–1:20 | Parent mode | The mom's Tagalog question. The agents light up in parallel: notice found (labelled replay), 44 hours since exposure, the 72-hour window closes tomorrow at 2pm, and the baby is under one, so the screen leads with "Call TPH now: 416-338-7600." Meanwhile the 5-year-old's record shows one dose, the second is due, there's a TPH clinic nearby, and the school note is ready in English and Tagalog. |
| 1:20–1:50 | The dissenter | Open the objection log. A Voice wrote "get your baby the immune globulin shot." Blocked: we never recommend treatment, so it was replaced with "call TPH; they'll tell you whether preventive treatment is right," citing rules 2 and 5. A second draft was flagged for wording that blamed a community. |
| 1:50–2:35 | Response cell | The notice triggers five Voices at once: Tamil, Tagalog, Traditional Chinese, Punjabi and Spanish, all adapting TPH's approved wording. Each is back-translated and checked. One language goes to a human translator. The Hesitancy Listener's top concern this week (time off work for appointments) is already in the drafts. |
| 2:35–3:00 | Close | Who it helps: Toronto families and the public-health teams reaching them. Where it goes: other health units, school boards, community health centres, and every vaccine-preventable disease after measles. "Help Toronto hold the line until 2027." |

---

## Risks and judge questions

- **"Is this medical advice?"** No.
  - The swarm calculates time windows from published rules and refers people to public health. It never decides on treatment.
  - Every message cites official guidance.
  - The dissenter blocks anything that recommends treatment.
- **Health privacy.**
  - **In the hackathon:** stateless, sample records only, nothing stored. Never store health card numbers, immunization IDs or records; storing them brings in PHIPA.
  - **A real version:** a data agreement with a health unit, explicit parent consent, and either reading the record on the device or a privacy-compliant agreement that covers the AI provider.
- **Stigma.**
  - Messages never name a community as the cause, and they use person-first language. The dissenter checks for both.
  - A real deployment writes each community's framing guide with community partners. The agents draft *for* trusted messengers, not *as* them.
  - The Hesitancy Listener summarizes concerns respectfully. It never mocks them.
- **The exposure list is incomplete.** The PHO list only includes sites where public health couldn't reach everyone exposed. The app says so whenever a place isn't found.
- **Translation quality.** Back-translation plus a human translator for languages Gemini handles poorly. A teammate who reads one of the demo languages checks those drafts before Sunday.
- **There are no live exposures right now.**
  - The live Scout shows the real TPH and PHO pages, probably "no current exposures," which is good news.
  - The story uses a replay modelled on the real June 2026 Scarborough exposures, labelled on screen.
- **Guidance changes.** Every rule and document shows its source and date, and the dissenter cites the version it checked against.
- **Being polite to public sites.** Cache pages, check at a low rate, and only read public notices.

---

## Open items

- The teammate's original brief was cut off mid-sentence in its privacy section ("Your 72-hour window closes Tuesday..."). Add anything missing.
- Confirm TPH's number (416-338-7600) on the TPH page before the demo.
- Confirm the "two doses are about 97% effective" figure against an official source if any message uses it.
- Still to collect for the dissenter: the measles chapter of the Canadian Immunization Guide (written by NACI, Canada's vaccine advisory committee).
- Line the build up with the wireframes once they're done.

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
