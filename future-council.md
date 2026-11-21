# Future Council

> Five versions of you live the next 30 years five different ways. Same world, same bad luck, different plans.

Hack Western 13 · Canada Life Future Me Challenge · Team brief · Written November 21, 2026

---

## Context

- **Event:** Hack Western 13 at Western University, November 20 to 22, 2026.
- **Hacking window:** 9pm Friday, Nov 20 to 9am Sunday, Nov 22. Work done outside the window is disqualified.
- **Team:** 4 people. Goal: done by Saturday night, rehearse Sunday morning.
- **Our track: Canada Life Future Me Challenge.** The brief: "Many young Canadians struggle with long-term financial planning because of uncertainty about the world ahead. Build a digital solution that helps Gen Z take meaningful action on their financial future through motivation, visualization, behavioral nudges, education, or innovation. Turn uncertainty into confidence." Prize: a $100 Visa card per member.
- **Also enter:** Overall (iPad / AirPods Pro 3 / Fitbit Air per member for 1st / 2nd / 3rd) and MLH Best Use of Gemini API.
- **How judges score** (equal weight, as far as we know):
  - **Innovation & Creativity:** how original is the idea?
  - **Technical Complexity:** algorithms, integrations, hardware.
  - **Completeness:** does it work, with no major bugs?
  - **Design:** is it intuitive and good to look at?
- Judges penalize unoriginal ideas.
- Past overall winners at Hack Western were polished web apps with Gemini at the core, a pro tool made usable by non-experts, a strong generative moment in the demo, and great design.

---

## Where the idea came from: Settlers of Solana

[Settlers of Solana](https://devpost.com/software/_solanasim) was a Hack the North 2026 finalist and won Best Use of Solana there. It was built by Kyle Wang, Nigel Loh and Yiming Su.

- **What it does:** over 100 AI agents, each with its own personality, talents and appetite for risk, run an island economy. Every round they choose to fish, cut wood, craft, build a house or rest. Prices come from supply and demand, agents can take out collateralized loans and get foreclosed on, and every trade settles on Solana.
- **How it looks:** a 3D island in Three.js, plus a dashboard tracking GDP, inflation, employment, wellbeing, inequality and credit, with 55 dials (35 adjustable live) that let you trigger forest fires or poisoned fish.
- **The part worth borrowing:** every agent lives in the same world with the same "weather," so each run is a fair head-to-head comparison.

**Rules check:** we can't use their code or build on their repo.
- Hack Western disqualifies work done outside the hacking window.
- It was a finalist at Canada's biggest hackathon two months ago, so a copy would get spotted fast.
- Borrow the idea, build from scratch, and credit Settlers of Solana as our inspiration on Devpost.

**What we borrow:** shared conditions for fair comparisons, live dials for shocks, and agents that explain their decisions.

**What we change:** we shrink it from an economy of 100 strangers down to one person. Future Council is a council of AI agents who are all versions of *you*, each planning your life a different way, all living through the same simulated future. That matches Canada Life's brief closely.

---

## The idea

**Who it helps:** Gen Z Canadians (students and new grads) who feel too unsure about the future to plan, and can't picture where different choices lead.

### The council

Each agent is a version of the user with one planning philosophy, and each one teaches a Canadian money concept through its own story.

| Agent | Plans by | Teaches |
|---|---|---|
| The Safety Net | Emergency fund first, insurance, low risk | Emergency funds, disability coverage |
| The Investor | Automating index investing from day one | Compounding, TFSA vs RRSP |
| The Homebuyer | Maxing the FHSA for a down payment | FHSA ($8,000 a year, $40,000 lifetime) |
| The Experience Maxer | Spending on travel and experiences now | Opportunity cost, and that experiences count too |
| The Builder | Side hustles and career bets | Variable income, investing in skills |

Users can also describe their own philosophy in one sentence ("retire at 45 in Lisbon"), and Gemini turns it into a sixth agent.

### How it works

1. **Onboarding (two minutes):** age, school or job, income, debts like OSAP, savings, goals, and what matters to them.
2. **The council appears:** each agent explains its plan in its own words.
3. **The simulation:** all agents live the same 1,000 simulated futures, with the same market years, inflation, rent increases, recessions and layoffs. The screen shows a timeline for each agent side by side, plus a chart of each agent's range of outcomes instead of a single line.
4. **Stress tests:** sliders add a recession in year 3, rent up 20%, a layoff, AI disruption in your field, or six months off work for health reasons. Agents re-plan and explain why: "I had four months saved, so I didn't touch my TFSA."
5. **Ask the council:** "Japan trip or FHSA?" Each agent answers with numbers from its own simulation.
6. **Your plan:** mix together the agents you agree with. You get 3 actions for this week (open an FHSA, automate $40 a week, build a $1,000 starter fund) and a short note from your 40-year-old self.

### The core trick

**Gemini writes the plan once, then plain code runs it through all 1,000 futures.**

Calling Gemini for every year of every simulated life would take about 150,000 calls (5 agents × 30 years × 1,000 futures). Instead, each agent produces its plan once, as a set of rules:

```json
{
  "agent": "The Homebuyer",
  "savingsRate": 0.25,
  "order": ["emergency_fund:3_months", "fhsa:8000_per_year", "tfsa", "rrsp"],
  "invest": { "stocks": 0.6, "bonds": 0.2, "cash": 0.2 },
  "buyHomeWhen": { "downPaymentPct": 0.1, "maxPaymentToIncome": 0.32 },
  "onJobLoss": { "cutSpendingPct": 0.3, "pauseContributions": true, "useEmergencyFund": true },
  "onRaise": { "saveShareOfRaise": 0.5 }
}
```

- **Speed:** the simulation runs those rules through all 1,000 futures in milliseconds. Gemini only comes back to tell each agent's story and to re-plan when a slider moves.
- **Fairness:** every agent gets the same random market years and the same layoffs, a technique statisticians call common random numbers. Differences come from choices, not luck.
- **Trust:** every number on screen comes from math, not an AI's guess. That's our answer when judges ask whether this counts as financial advice.

### Against Canada Life's brief

- **Turning uncertainty into confidence:** stress tests show which plans hold up, for example "your emergency fund stays positive in 92% of futures."
- **Visualization:** lives side by side, and ranges of outcomes.
- **Education:** each agent teaches a Canadian account through its own story.
- **Behavioral nudges:** three concrete actions for this week.
- **Motivation:** the note from your future self. Hal Hershfield's research found bank customers who "met" their future selves saved more for retirement, and MIT's Future You study found a single chat with an AI future self reduced anxiety.

---

## What makes it stand out

| Existing | What it does | What's missing |
|---|---|---|
| TalkTuahFutureYou (a Devpost winner), MIT Future You | Chat with one AI future self | One future, nothing to compare |
| Panze | One AI companion over a long-term projection | One path, one voice |
| Killion Labs, Boldin, WealthStoryLine | Simulated outcome ranges for portfolios | Compares investments, not life plans |
| Settlers of Solana | 100 agents in one shared economy | An economy, not your life |

Future Council puts several versions of you through the same luck, and they re-plan out loud.

**Technical complexity** comes from coordinating multiple agents, the 1,000-future simulation with shared random draws, turning plans into rules, and re-planning when events hit.

---

## How to build it

**Stack:**
- Next.js and TypeScript.
- Gemini with structured output for the plans, stories and council answers.
- One plain TypeScript file for the simulation, with a test.
- A charting library for the outcome ranges.
- No accounts and no database.

**Show your assumptions:** put market returns, inflation and rent growth in a panel the user can see and change. That builds trust.

**Team split:**

| Role | Owns |
|---|---|
| Simulation | The 1,000-future engine, Canadian accounts, life events, tests |
| Agents | Gemini prompts for plans, stories, council answers and re-planning |
| Frontend | Onboarding, the council view, timelines, charts, sliders |
| Story and design | Agent characters, copy, pitch, Devpost, backup video |

**Scope:**
- **Must have:** 5 agents, a 30-year simulation across 1,000 futures, 4 sliders, timelines and outcome charts, agent stories, the plan with 3 actions.
- **Should have:** questions to the council, a custom agent from one sentence.
- **Cut:** Solana, accounts, exact tax math (approximate it), any 3D world.

**Prizes to enter:** the Canada Life Future Me Challenge, Overall, and MLH Best Use of Gemini.

---

## How to demo (3 minutes)

| Time | Beat | Do and say |
|---|---|---|
| 0:00–0:20 | Hook | Gen Z can't picture their financial future, and Canada Life's challenge asks us to "turn uncertainty into confidence." |
| 0:20–1:00 | Onboarding | Onboard a sample student live: 21 years old, $12,000 of OSAP debt, wants a home by 35. The council appears and the timelines animate. |
| 1:00–1:40 | Stress test | Drag "recession in 2029" plus a layoff. The Experience Maxer's emergency fund hits zero while the Safety Net holds, and the agents re-plan out loud. |
| 1:40–2:20 | Ask the council | Ask "Japan trip or FHSA?" and the agents answer with numbers. |
| 2:20–3:00 | Plan and close | Mix a plan, show the 3 actions and the future-self note, then close on who it helps. |

---

## Solana: skip it

- Settlers just won the Solana prize with an agent simulation, so ours would look derivative.
- Crypto inside a Gen Z planning tool is a hard sell to an insurance company's judges.
- It costs hours we don't have.

---

## VaxBridge or Future Council?

- **Future Council is the easier build:** all the data is made up, so there's no handwriting to read and no Ontario regulation to encode.
- **VaxBridge has the bigger real-world story** and passed a more thorough originality check. It's in the Best Health Hack by Sun Life track. Team page: <https://claude.ai/artifact/FjfeSZLJxf3Nkz5gY1NsCL>
- It's Saturday, so pick one within the hour.

---

## Sources

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
- [MIT Future You](https://www.media.mit.edu/projects/future-you/oVERVIEW/)
- [MIT News on Future You](https://news.mit.edu/index%2Ephp/2024/ai-simulation-gives-people-glimpse-potential-future-self-1001)
- [UCLA Anderson Review on Hershfield's research](https://anderson-review.ucla.edu/young-adults-with-an-ai-bot-chat-with-their-60-year-old-selves)

**Agent simulation research**
- [Research on 2,500 AI agent personas](https://arxiv.org/pdf/2512.18803v1)
- [Multi-agent debate for trading](https://arxiv.org/pdf/2609.29701)
