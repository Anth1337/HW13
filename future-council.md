# Future Council

> The future looks foggy. Five versions of you walk into it first and report back.

Hack Western 13 · Canada Life Future Me Challenge · Team brief · Revised November 21, 2026, 1pm

---

## Context

- **Event:** Hack Western 13 at Western University, November 20 to 22, 2026. Theme: *Discover the unknown*.
- **Hacking window:** 9pm Friday, Nov 20 to 9am Sunday, Nov 22. Work done outside the window is disqualified. (The AR prototype in `AR/` was committed at 1am Saturday, so it's inside the window and fair to build on.)
- **Team:** 4 people. Goal: done by Saturday night, rehearse Sunday morning. As of 1pm Saturday that's about 10 hours of build.
- **Our track: Canada Life Future Me Challenge.** "Canada Life's research found that many young Canadians are struggling to engage with long-term financial planning due to uncertainty about the world ahead. Design and build a digital solution that helps Gen Z take meaningful action toward their financial future through motivation, visualization, behavioral nudges, education, or innovation. Create a solution that turns uncertainty into confidence and helps young people see that the future is still worth planning for." Prize: a $100 Visa card per member.
- **Also enter:**
  - Overall (iPad / AirPods Pro 3 / Fitbit Air per member).
  - MLH Best Use of Gemini API.
  - Organizer's Choice: Most Adventurous ("enables others to discover the unknown"). Our whole visual is an unknown future you get to explore.
  - Optional: GoDaddy Registry best domain. AR needs an HTTPS address anyway.
- **How judges score** (equal weight, as far as we know): Innovation & Creativity, Technical Complexity, Completeness, Design. Judges penalize unoriginal ideas.
- Past overall winners at Hack Western were polished web apps with Gemini at the core, a pro tool made usable by non-experts, a strong generative moment in the demo, and great design.

---

## What Canada Life's research actually says

The track links to Canada Life's page "How to help Gen Z employees save for an uncertain future." Its one claim: young employees are "struggling with existential dread, which leads to doomscrolling as a way to cope with their growing feelings of helplessness." The full report, *The disappearing horizon* (October 2026), was done with Deloitte's behavioural economics team: about 1,900 Canadians surveyed (around 40% Gen Z), focus groups, and a randomized experiment on which messages change saving.

| Finding | Number |
|---|---|
| Gen Z daily doomscrolling | 74 minutes, about 70% more than everyone else |
| Each extra hour of doomscrolling a day | 4.4% lower chance of setting up automatic contributions |
| Thinking about the end of the world | 16% less likely to own and enrol in long-term savings |
| Believe humanity will go extinct in their lifetime | 1 in 8 |
| RRSP withdrawals, compared at the same age | 12% more than Millennials, 42% more than Gen X |
| People who start contributing at 2–4% | tend to stay there for years |
| Gen Z in full-time roles | 45%, changing jobs about 1.1 times a year |

**What backfired:** fear, dystopian framing, and pop-culture gimmicks. Focus groups called fear messaging "manipulative rather than motivating."

**What worked:** resilience, agency, and "small, concrete steps" that give a sense of control. Saving framed as *flexibility and control*, not a fixed finish line at 65.

**Most effective tools:** auto-enrolment, default contribution rates, and auto-escalation. The report tells employers "something is better than nothing," that starting at 1% is "a great first step," and to show what $20 compounds into.

**Their product answer (October 8, 2026):** your own contributions can go to short- and medium-term goals (a TFSA or FHSA) while the employer match stays in retirement savings. Kate Nazar, SVP Workplace Retirement and Savings: "Asking young employees to plan decades ahead can be difficult when the next 10 years feel uncertain."

*Pitch honesty:* the doomscrolling numbers are correlations, so say "linked to," not "causes." One article quotes 3% instead of 4.4%. Canada Life judges will know their own numbers.

### What this changes

| Old brief | New brief | Why |
|---|---|---|
| Stress tests (recession, layoff, AI disruption, health). Big demo moment: the Experience Maxer's fund hits zero | **Curveballs** that end in recovery: who bounces back, how fast, and what they did. No red "you're ruined" screens | Fear backfires; resilience and agency work |
| Outcome is net worth at the end | **Freedom months**: how long you could cover your costs with no paycheck, at every age | Saving as flexibility and control |
| Agents teach through their stories | **Money Moves**: 8 lesson cards unlocked by what happens in *your* simulation, using your numbers | More teaching, in bite sizes |
| 3 actions for this week | 3 actions that **start tiny and run on autopilot**: $20 a week, 1%, auto-increase | Defaults and small steps work best |
| "Japan trip *or* FHSA?" | "Japan trip *and* FHSA": the council shows a split, like Canada Life's own product | Today's needs and tomorrow's goals |
| Full-time job assumed | Student, part-time, gig, and job switches about once a year | Only 45% are full-time |
| 2D charts only, any 3D cut | A foggy horizon that clears as you plan, plus your council in AR on the table | Visual appeal; the "disappearing horizon" made literal |

---

## The idea

**Who it helps:** Gen Z Canadians (students, new grads, people in their first jobs) who feel the future is too uncertain to plan for.

**Where it could live:** inside a workplace plan's enrolment flow, at the moment a 22-year-old picks a contribution rate they'll probably keep for years. It also works on its own for students with no plan.

### Bring the horizon back

The first screen is your life as a road running to the horizon, age 21 to 50. Everything past next year is covered in fog. Canada Life called it the disappearing horizon, and this is what it looks like.

The fog is math, not decoration. Its thickness at each age is the share of your 1,000 simulated futures where you've hit a cash crunch by then (ran out of cash or had to raid your RRSP). Every move you make thins it. By the end of the demo it's mostly gone. That's "uncertainty into confidence" on screen.

### The council

Each member is a version of the user with one planning philosophy. Each has one color, used everywhere (lanes, cards, AR towers).

| Member | Plans by | Lesson cards it unlocks |
|---|---|---|
| The Safety Net | Three months of emergency fund first, then a low-risk TFSA | Starter emergency fund |
| The Investor | Takes the full employer match and auto-invests in index funds from day one | Free money: the match; Start small, start now |
| The Homebuyer | Maxes the FHSA for a down payment | FHSA + Home Buyers' Plan |
| The Experience Maxer | Spends on travel now and saves whatever is left | Automate it; The RRSP withdrawal trap |
| The Builder | Side hustles and career bets, saves half of every raise | Save more tomorrow; TFSA vs RRSP |

**Faces (stretch):** if the user adds a selfie, Gemini's image model ages it to 40 five different ways, each dressed by that life. Hershfield's studies found people who saw age-progressed images of themselves put about twice as much into a hypothetical retirement account. With no selfie, each member gets an illustrated avatar.

**Custom member (stretch):** the user describes a philosophy in one sentence ("retire at 45 in Lisbon") and Gemini turns it into a sixth member.

### How it works

1. **Onboarding (90 seconds):** age, work (student / part-time / gig / full-time), income, OSAP, savings, and whether your employer matches (a "not sure" answer gets a one-line explainer). Then one goal for the next five years (a trip, a car, moving out) and one for later (a home, freedom). A "Use Maya" button fills in the demo persona.
2. **The fog:** the horizon appears, mostly fogged. "This is your future right now: hard to see."
3. **The council walks in:** five selves, each with a 15-second story told in short swipeable cards, not paragraphs. All five live the same 1,000 futures, with the same market years, inflation, rent, and layoffs.
4. **The horizon view:** five lanes run to the horizon. Each lane shows that self's range of freedom months over time, with its own fog. Drag the age slider to travel down the road.
5. **Curveballs:** drop one onto a year: recession, rent up 20%, layoff, career change, or six months off for health. A storm rolls across all five lanes at once, because they share the same weather. Each self reacts out loud ("I had four months saved, so I didn't touch my RRSP"), and each lane shows its **bounce-back time**.
6. **Money Moves:** when the simulation hits a teachable moment, a lesson card pops up with the user's own numbers. There are 8 to collect.
7. **Ask the council:** "Japan trip or FHSA?" Each self answers with numbers from its own runs. Most land on *both*, with a split.
8. **Your plan:** pick the moves you agree with from any self. You get 3 tiny actions for this week, each with a default amount and a calendar reminder (an `.ics` file). The fog lifts as confidence climbs, for example from 41% to 83%. Then a short note from your 40-year-old self, written about resilience, not fear.
9. **Take it home in AR:** a QR code puts your council on the table as five towers of blocks, one block per freedom month, growing as you scrub through the years.

### Money Moves (the lessons)

We write the facts, check them against CRA pages, and store them as static text. Gemini only fills in the user's numbers and the member's voice. That's our answer if judges ask whether this is financial advice: it's education, every fact has a source, and every number comes from the simulation.

| Card | Pops up when | Teaches (with your numbers) |
|---|---|---|
| Starter emergency fund | A self with no fund hits a curveball | Even $1,000 changes how a layoff plays out |
| Free money: the match | The user's employer matches | "Skipping a 3% match leaves $X on the table by 40" |
| Start small, start now | Right after the council intro | $20 a week from 21 vs. from 31 |
| Automate it | The Experience Maxer has a month with nothing left to save | Pay yourself first; defaults beat willpower |
| TFSA vs RRSP | The first contribution decision | Lower income now usually means TFSA first, because the RRSP deduction is worth more later |
| The RRSP withdrawal trap | A self pulls from its RRSP during a curveball | 10–30% withheld up front, and that contribution room is gone for good. TFSA room comes back next year |
| FHSA + Home Buyers' Plan | The Homebuyer buys | $8,000 a year and $40,000 lifetime, tax-deductible in and tax-free out, plus up to $60,000 from an RRSP |
| Save more tomorrow | The first raise | Commit half of future raises, and auto-increase 1% a year |

The withdrawal trap card ties straight to the stat that Gen Z withdraws from RRSPs 42% more than Gen X did.

### Against Canada Life's brief

| The brief asks for | Future Council |
|---|---|
| Motivation | Your aged faces and a note from your 40-year-old self (Hershfield, MIT Future You) |
| Visualization | The fog horizon, five lanes side by side, AR towers |
| Behavioral nudges | Tiny defaults, 1% auto-increase, reminders, save-more-tomorrow |
| Education | 8 Money Moves cards built from your own simulation |
| Innovation | A council of agents living the same random futures |
| Uncertainty into confidence | The fog lifts and confidence climbs as you commit |
| "The future is still worth planning for" | Every curveball ends in a recovery |

---

## The core trick

**Gemini writes each plan once, then plain code runs it through all 1,000 futures.**

Calling Gemini for every year of every simulated life would take about 150,000 calls (5 agents × 30 years × 1,000 futures). Instead, each agent produces its plan once, as a set of rules:

```json
{
  "agent": "The Homebuyer",
  "savingsRate": 0.2,
  "autoIncreasePerYear": 0.01,
  "takeFullMatch": true,
  "order": ["emergency_fund:1000", "fhsa:8000_per_year", "tfsa", "rrsp"],
  "invest": { "stocks": 0.6, "bonds": 0.2, "cash": 0.2 },
  "buyHomeWhen": { "downPaymentPct": 0.1, "maxPaymentToIncome": 0.32 },
  "onCurveball": { "cutSpendingPct": 0.3, "pauseContributions": true, "drawFrom": ["emergency_fund", "tfsa", "rrsp"] },
  "onRaise": { "saveShareOfRaise": 0.5 }
}
```

`drawFrom` is where a self pulls money in a crunch. The Experience Maxer's is `["cash", "rrsp"]`, which is how the withdrawal trap shows up on its own.

- **Speed:** the simulation runs those rules through all 1,000 futures in milliseconds. Gemini only comes back to tell each story and to re-plan when a curveball lands.
- **Fairness:** every self gets the same random market years and the same layoffs, a technique statisticians call common random numbers. Differences come from choices, not luck. The storm crossing all five lanes at once is this idea made visible.
- **Trust:** every number on screen comes from math, not an AI's guess.

**What the simulation reports** (all computed, never generated):

- **Freedom months** = (cash + emergency fund + TFSA) ÷ monthly essentials. RRSP and FHSA money doesn't count, because locked money isn't freedom yet. That's a lesson in itself.
- **Confidence** = the share of futures where this self never runs out of cash and never raids its RRSP.
- **Fog at age A** = the share of futures with a cash crunch by age A.
- **Bounce-back time** = median months to get back to pre-curveball freedom months.
- **Net worth at 40**, as a 10th to 90th percentile range. Shown second, not first.

**What the simulation models:** TFSA (room returns after a withdrawal), RRSP (employer match, tax withheld on withdrawal, room lost), FHSA ($8,000 a year, $40,000 lifetime), emergency fund, OSAP payments, variable income for part-time and gig work, job switches, raises, and rent growth. Taxes are approximate.

**Show your assumptions:** market returns, inflation, rent growth, and job-switch rate sit in a panel the user can see and change.

---

## AR: your council on the table

Build on `AR/` (Vite + three.js + TypeScript). It already does surface detection and tap-to-place with shadows on Android, USDZ export for iPhone, and an orbit preview on desktop.

- **Scene:** swap `createCube()` for `createCouncil(data)`: five towers on a small base, one colored block per freedom month (a three.js `InstancedMesh`), and a name plate for each. Place it once instead of many times.
- **Android (WebXR):** an age slider in the DOM overlay, so the towers grow and shrink as you scrub the years. A storm cloud is a stretch goal.
- **iPhone (Quick Look):** the age-40 snapshot through the existing USDZ export. Quick Look can't run code, so there's no slider.
- **Laptop:** the existing orbit preview, embedded in the plan screen as an iframe, so the laptop demo gets 3D too.
- **Data handoff, no backend:** the main app puts about 30 numbers (5 selves × 6 ages, median freedom months) into the URL hash and shows a QR code. The AR page reads `location.hash`.
- **Hosting:** phones need HTTPS, so deploy both apps (Vercel or Netlify) before the demo.
- **On stage:** mirror an Android phone to the laptop with `scrcpy` so everyone sees it, or hand the phone to the judge. Record a backup video of the AR by 11pm.

## Design direction

- Hopeful, not scary: a dawn palette (peach, soft gold, sky blue) with warm white fog. Curveballs are grey-blue storms, never red alarms. Recovery shows in green.
- One big number per screen, with short cards instead of paragraphs.
- Every visual has its number next to it, so the fog never carries the meaning alone.
- The opening road can be a flat SVG tilted with CSS `perspective`. The working view stays flat so the lanes are readable. The only real 3D is the AR scene.

---

## What makes it stand out

| Existing | What it does | What's missing |
|---|---|---|
| Typical retirement calculators | One line to age 65 | The fixed finish line Canada Life says Gen Z tunes out |
| TalkTuahFutureYou (a Devpost winner), MIT Future You | Chat with one AI future self | One future, nothing to compare |
| Panze | One AI companion over a long-term projection | One path, one voice |
| Killion Labs, Boldin, WealthStoryLine | Simulated outcome ranges for portfolios | Compares investments, not life plans |
| Settlers of Solana | 100 agents in one shared economy | An economy, not your life |

Future Council puts several versions of you through the same luck, they re-plan out loud, and you learn from what happens to them.

**Technical complexity:** coordinating multiple agents, a 1,000-future simulation with shared random draws and Canadian account rules, turning plans into rules, re-planning when events hit, and a cross-platform AR scene driven by the simulation.

---

## How to build it

**Stack:**
- Next.js and TypeScript.
- Gemini with structured output for plans, stories, re-plans, council answers, and the future-self note. Check the current model names in Gemini's docs before wiring them up.
- Gemini's image model for aged portraits (stretch).
- One plain TypeScript file for the simulation, with a test.
- Plain SVG or a small charting library for the lanes and fog.
- The existing `AR/` app, plus a QR code package.
- No accounts and no database.

**Team split:**

| Role | Owns |
|---|---|
| Simulation | The 1,000-future engine, Canadian accounts, freedom months, fog, confidence, bounce-back, curveballs, the test |
| Agents and story | Gemini prompts, Money Moves copy and fact-checking, pitch, Devpost |
| Frontend | Onboarding, the fog horizon, lanes, curveballs, lesson cards, plan screen, QR code |
| AR and design | Council towers in AR, visual identity, portraits (stretch), backup video |

**Build order (from 1pm Saturday):**
1. **By about 4pm:** the simulation runs 5 hard-coded plans through 1,000 futures and prints freedom months and confidence. The frontend renders lanes from fake data. AR shows five towers from a hard-coded hash.
2. **By about 8pm:** end to end: onboarding, Gemini plans, simulation, horizon with fog, one curveball, plan screen.
3. **By about 11pm:** lesson cards, ask the council, QR to AR, future-self note. Record the backup video.
4. **Sunday morning:** rehearse and finish Devpost. Submissions close at 9am.

**Cut rule:** if checkpoint 2 slips, AR drops to the backup video and the AR person joins frontend. Portraits are the first thing cut.

**Scope:**
- **Must have:** 5 agents, the 1,000-future simulation with Canadian accounts, the fog horizon, 3 curveballs (recession, layoff, rent up 20%), freedom months and bounce-back, at least 6 lesson cards, and the plan with 3 tiny actions, the fog lift, and the future-self note.
- **Should have:** AR towers via QR, ask the council, all 8 cards.
- **Stretch:** aged selfie portraits, a custom sixth member, a storm animation in AR.
- **Cut:** Solana, accounts, a database, exact tax math, and any laptop 3D beyond the AR preview.

**Prizes to enter:** Canada Life Future Me Challenge, Overall, MLH Best Use of Gemini, Organizer's Choice: Most Adventurous, and optionally GoDaddy Registry.

---

## How to demo (3 minutes)

| Time | Beat | Do and say |
|---|---|---|
| 0:00–0:20 | Hook | "Canada Life and Deloitte found Gen Z doomscrolls 74 minutes a day, and more scrolling is linked to less automatic saving. Their research also found that scaring people backfires. So we built the opposite of a doomscroll: a future you can actually see." |
| 0:20–0:50 | Fog and council | Onboard Maya: 21, part-time, $12,000 of OSAP, wants Japan next year and a home by 35. Her horizon is fog. Her council walks in. |
| 0:50–1:30 | Curveball | Drop a recession and a layoff into 2029. The storm crosses all five lanes at once. The Experience Maxer pulls from her RRSP, and the withdrawal trap card pops up with Maya's numbers. The Safety Net bounces back in five months. |
| 1:30–2:00 | Ask the council | "Japan or FHSA?" The council says both and shows the split. |
| 2:00–2:30 | Plan | Maya picks her moves and gets three tiny actions: automate $20 a week, join the match, turn on 1% auto-increase. The fog lifts from 41% to 83% confidence. A note from 40-year-old Maya. |
| 2:30–3:00 | AR and close | Scan the QR and Maya's council stands on the judges' table, one block per month of freedom. Close: "Gen Z doesn't need to be scared into saving. They need to see that the future is still worth planning for." |

---

## Where the idea came from: Settlers of Solana

[Settlers of Solana](https://devpost.com/software/_solanasim), by Kyle Wang, Nigel Loh and Yiming Su, was a Hack the North 2026 finalist and won Best Use of Solana there. Over 100 AI agents with their own personalities run an island economy, all living through the same "weather," with live dials for shocks like forest fires.

**What we borrow:** shared conditions for fair comparisons, live dials for shocks, and agents that explain their decisions.

**What we change:** we shrink an economy of 100 strangers down to one person. The council is all versions of *you*, living through the same simulated future.

**Rules check:** we don't use their code or build on their repo. Hack Western disqualifies outside work, and a copy of a finalist from two months ago would be spotted fast. We build from scratch and credit Settlers of Solana as our inspiration on Devpost.

---

## Sources

**Canada Life research**
- [Canada Life: How to help Gen Z employees save for an uncertain future](https://www.canadalife.com/investing-saving/retirement/group-retirement-savings/gen-z-retirement-planning-savings.html)
- [Wealth Professional: Gen Z retirement savings threatened by existential dread (Oct 13, 2026)](https://www.wealthprofessional.ca/news/industry-news/gen-z-retirement-savings-threatened-by-existential-dread-canada-life-research-finds/393753)
- [Canadian HR Reporter: Doomscrolling vs. the RRSP (Oct 20, 2026)](https://www.hrreporter.com/opinion/editors-desk/doomscrolling-vs-the-rrsp/395041)
- [Insurance Business: Canada Life lets Gen Z save short term while employer match stays for retirement (Oct 12, 2026)](https://www.insurancebusinessmag.com/ca/news/group-benefits/canada-life-lets-gen-z-save-short-term-while-employer-match-stays-for-retirement-593079.aspx)
- [Benefits and Pensions Monitor: Gen Z's existential dread is reshaping workplace savings (Nov 12, 2026)](https://www.benefitsandpensionsmonitor.com/pensions/retirement-planning/gen-zs-existential-dread-is-reshaping-workplace-savings-canada-life/394423)

**Inspiration**
- [Settlers of Solana on Devpost](https://devpost.com/software/_solanasim)

**Similar projects and products**
- [TalkTuahFutureYou](https://devpost.com/software/talktuahfutureyou)
- [Financial Life Simulator](https://devpost.com/software/financial-life-simulator)
- [Funancial](https://devpost.com/software/funancial-cjv240)
- [Panze](https://www.indiehackers.com/product/panze-ai)
- [Killion Labs](https://www.producthunt.com/products/killion-labs)
- [Boldin](https://www.boldin.com/features)
- [WealthStoryLine](https://chatgpt.com/plugins/plugin_asdk_app_6ac07fbbe2f8819186948d82d1828ce6)
- [Berkeley Financial Freedom Agent](https://www.ischool.berkeley.edu/projects/2024/financial-freedom-agent)

**Future-self research**
- Hershfield et al., "Increasing Saving Behavior Through Age-Progressed Renderings of the Future Self," *Journal of Marketing Research*, 2011
- [MIT Future You](https://www.media.mit.edu/projects/future-you/oVERVIEW/)
- [MIT News on Future You](https://news.mit.edu/index%2Ephp/2024/ai-simulation-gives-people-glimpse-potential-future-self-1001)
- [UCLA Anderson Review on Hershfield's research](https://anderson-review.ucla.edu/young-adults-with-an-ai-bot-chat-with-their-60-year-old-selves)

**Agent simulation research**
- [Research on 2,500 AI agent personas](https://arxiv.org/pdf/2512.18803v1)
- [Multi-agent debate for trading](https://arxiv.org/pdf/2609.29701)
