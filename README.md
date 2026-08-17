# AI Growth Kit

**A growth agent for people who can build software but not distribute it.**

You give it your app. It works out who the app is for, recommends where to
promote it, finds real public discussions where those people already gather,
prepares the promotion, and — in an isolated Google Ads test environment —
creates a real advertising campaign resource and then asks Google to confirm
that it exists.

**Production:** https://ai-growth-kit-695.netlify.app
**Judge sandbox (no signup):** https://ai-growth-kit-695.netlify.app/demo

**Who it's for:** indie mobile developers, solo founders, bootstrapped founders,
and small software teams with no growth department.

**The problem:** building software got dramatically faster. Distribution didn't.

**Why the Google Ads proof matters:** most demos stop at advice. This one crosses
into a real external platform: it authenticates against the Google Ads API,
creates a campaign budget and an App Campaign, and returns a Campaign ID that
Google generated. You can press **Verify with Google again** and watch a fresh
query go back to Google. It's a real API resource — and it is paused, has no ad
creatives, and lives in a test account that cannot serve ads or spend money.

---

## The problem

Modern AI-assisted development has made building software much faster and much
cheaper. A single developer can now ship something genuinely useful in a
weekend.

Getting it in front of users has not become any easier.

A developer with a working product still has to manually:

- figure out positioning
- define the audience
- pick acquisition channels
- hunt for relevant communities and websites
- write promotional content
- configure advertising tools
- publish
- track what happened
- decide what to do next

Each of those is a different tool, a different skill, and a different afternoon.

And it isn't a one-time cost. It repeats for every new product, every launch,
every feature, every new audience, and every new market. That's what makes it a
recurring problem rather than a chore you finish once.

## The solution

AI Growth Kit does this work as one connected flow that starts from the app
itself, not from a blank marketing prompt.

Because it begins with the real store listing, every later step inherits context:
the audience analysis feeds the channel recommendations, which feed the search
queries, which feed the scoring of what it finds, which feeds the drafts and the
campaign proposal.

## Product flow

```
App link → Understand → Promote → Discover → Execute → Measure
```

| Step | What happens |
| --- | --- |
| **Understand** | Imports the real Google Play listing and works out the audience, the problem the app solves, and its positioning. |
| **Promote** | Recommends acquisition channels for this specific app, with the reasoning for each. |
| **Discover** | Searches the public web for discussions by people who have this problem, and scores whether the right people are actually there. |
| **Publish** | Prepares a draft and a unique tracking link; publishes to your own Discord channel if you connect one. |
| **Execute** | Creates a real, paused Google Ads App Campaign in an isolated test account and proves it with a fresh read from Google. |
| **Measure** | Counts every click on every tracking link, first-party. |

The longer-term direction adds **Optimize** — acting on measured results
automatically. That is not implemented, and nothing in the product pretends
otherwise.

## Try it live

There are two ways in, and they show different things.

### The public judge sandbox — `/demo`

No signup, no email, no Google account, no shared password. An isolated demo
session that can see nothing belonging to any customer. It runs on a fixed
example app so every visitor sees the same thing, and it's where you can press
the button that actually calls Google.

### The full product — sign up

Your own app, your own project. Real Google Play import, real analysis, real web
discovery, real tracking links. Inside the project, Step 3 also offers the same
safe Google Ads test execution — using your app's package ID, still in the
isolated test account.

## What's working today

- Landing page, signup and login, tenant-isolated projects
- Google Play app import with real store data
- Product understanding, audience and positioning analysis
- Channel recommendations with reasoning
- Web audience discovery backed by DataForSEO search
- Relevance and actionability scoring, including a refusal to recommend weak fits
- AI draft preparation
- Publishing to your own Discord channel via webhook
- First-party tracking links and real click counting
- Google Ads OAuth connection, account hierarchy discovery, account selection,
  encrypted refresh-token storage — **read access only**
- Real Google Ads TEST execution: campaign budget, App Campaign, Google-issued
  Campaign ID, forced PAUSED, fresh read-back, and re-verification on demand
- Budget ceilings, idempotency, rate limits, and daily execution caps

## Real Google Ads execution

The sandbox and the signed-in project both use the same execution engine. The
only thing that differs between an execution path and any future customer path
is which credential is presented.

What actually happens when you press the button:

1. Service-account authentication against Google Ads API v25
2. Google is asked whether the target account has `test_account = true` — if the
   answer is no, execution is refused
3. The approved budget is clamped to a server-side ceiling
4. A `CampaignBudget` is created through the API
5. An App Campaign is created — `MULTI_CHANNEL`, `APP_CAMPAIGN`, status forced to
   `PAUSED`
6. A fresh Google Ads Query Language read-back retrieves what Google actually
   stored
7. The proof is persisted as a `GoogleAdsExecution` record

The Campaign ID you see is generated by Google, not by us. **Verify with Google
again** issues another live query — our database is not consulted for the
answer.

### Campaign completeness

Being precise about what the resource is:

| Real | Not created |
| --- | --- |
| `CampaignBudget` | Ad group |
| App Campaign resource | App Ad |
| Google-issued Campaign ID | Text assets |
| `PAUSED` status | Image assets |
| `MULTI_CHANNEL` / `APP_CAMPAIGN` | Video assets |
| Fresh Google read-back | — |

Because there is no ad group and there are no creatives, the resource is not a
fully serving campaign. Nothing is submitted for serving, nothing is shown to
anyone, and no advertising money moves.

## Why the hackathon demo uses no real ad spend

This is a deliberate decision, not a missing feature.

Every execution in this project runs inside Google Ads **test** accounts. Test
accounts cannot serve advertising and cannot spend money — that is what makes it
safe to put a real execution button on a public page that strangers can press.

So the demo deliberately does not show:

- real ad serving
- paid impressions or paid clicks
- campaign spend
- paid installs or conversions
- cost per install (CPI)
- return on ad spend (ROAS)
- revenue attribution

We could have shown a dashboard full of impressive numbers. We'd rather show a
smaller real result that you can independently verify than fabricate performance
metrics for a better-looking demo.

## Meaningful AI, deterministic safety

AI does real work here — it isn't a label on a form.

| Where | What the model does |
| --- | --- |
| Understand | Reads the store listing and infers audience, problem, and value proposition |
| Promote | Chooses which channels fit this specific app, and explains why |
| Discover | Generates the search queries, then judges whether the people in each result are actually your users |
| Publish | Drafts the promotional content |

The model currently used throughout is **`gpt-4o-mini`** via the OpenAI API.
There is no multi-model routing and no autonomous optimization loop; claiming
either would be untrue.

The interesting part is what the model is *not* allowed to do:

> **AI decides what may be useful. Deterministic backend rules decide what is
> allowed to happen.**

These rules are ordinary server code, and they override any model output:

- A hard daily budget ceiling, applied before any request is built
- The approved budget is treated as a request and clamped to that ceiling
- The advertising account is resolved server-side; the browser cannot supply or
  override a customer ID
- Google is asked to confirm `test_account = true` before any mutation
- Campaign status is forced to `PAUSED` — the string `ENABLED` appears nowhere in
  the engine
- Database-backed idempotency: one execution per demo session, one per project
- Per-client rate limiting and a global daily execution cap
- An ambiguous failure is never closed as "failed" — the system asks Google
  whether a campaign was created before allowing another attempt
- Provider error bodies are never echoed to the browser

## Who it's for

Independent software creators and small teams:

- indie mobile developers
- solo founders
- bootstrapped founders
- first-time founders
- small software teams with no dedicated growth person

The situation that defines them: **they can build the product; distribution is
the bottleneck.**

Why they might pay: the alternatives are founder hours spread across a dozen
disconnected tools, learning several specialist advertising systems, hiring
freelancers, or hiring a growth specialist long before the company can justify
the cost.

AI Growth Kit does not replace a professional marketing team. It aims to make
the first steps of that work possible without one.

## Why this matters

AI-assisted development is putting software creation within reach of far more
people and far smaller teams. Access to distribution expertise has not spread
the same way.

A genuinely useful product can still go nowhere because its creator doesn't know
performance marketing, can't afford an agency, can't hire a growth team, doesn't
know where the first users are, or simply runs out of hours switching between
marketing tools.

That gap falls hardest on solo developers, small teams, bootstrapped and
first-time founders, and developers working outside the major startup
ecosystems, where informal access to this knowledge is thinner.

**Without AI Growth Kit:** a founder researches audience, positioning,
communities, channels, content, ad setup, and tracking by hand, in seven
different places.

**With AI Growth Kit:** one product carries context from the application itself
through research, promotion, authorized action, and measurement.

We're not claiming social outcomes we haven't demonstrated. The claim is
narrower and checkable: growth tooling that currently assumes a marketing
department should be usable by someone who doesn't have one.

## Business model

Stated plainly, because judges should not have to guess:

**Not implemented today:** Stripe, paid subscriptions, billing, team and invite
functionality. None of it is in the code, and none of it is presented as live.

The planned model is SaaS. Tiers below are **conceptual** — nothing is
purchasable:

| Tier (conceptual) | Intended shape |
| --- | --- |
| **Free / trial** | One project, limited analysis and discovery — enough to judge whether the workflow saves you time |
| **Starter** | More projects, deeper discovery, publishing and measurement — aimed at indie developers and solo founders |
| **Pro** | Larger limits, automation, and advanced execution as those capabilities become production-ready; collaboration later |

On advertising money: **AI Growth Kit charges for the software, not the ad
spend.** Advertising budgets stay directly between the customer and the ad
platform. We never need to hold a customer's advertising money, which removes a
whole category of financial and regulatory risk from the business.

## Path to first revenue

1. Recruit early users from indie developer, mobile developer, and bootstrapped
   founder communities.
2. Have them import a real app and check whether the product saves meaningful
   time across analysis, promotion planning, and audience discovery.
3. Convert the users who keep coming back to discovery, content preparation,
   publishing, and measurement into an early paid subscription.
4. Add production Google Ads execution as a higher-value paid capability once
   production execution, campaign completeness, and attribution are ready.
5. Expand to further acquisition channels based on what customers actually use,
   rather than building every ad network up front.

The first paying customer does not require the whole roadmap. What exists today
— app analysis, promotion planning, audience discovery, content preparation,
authorized Discord publishing, and first-party click measurement — is already
useful work.

There are no customers and no revenue yet. This is the plan, not a report.

## Why it can be sustainable

The impact here doesn't depend on grants or donations, because the people it
helps are the same people who would pay for it.

A subscription can fund infrastructure, model and API usage, search provider
costs, further integrations, and continued development. Advertising spend stays
between customers and ad platforms, so the cost of a customer's campaigns never
lands on us.

That produces a straightforward alignment: if the product consistently saves
small developers time or helps them make better growth decisions, they have a
direct reason to keep paying. If it doesn't, they stop — which is the correct
outcome.

We are not claiming profitability.

## Current vs planned

**Working today:** landing page · authentication · tenant-isolated projects ·
Google Play import · product understanding · promotion recommendations · web
audience discovery (DataForSEO) · relevance and actionability scoring · AI
content preparation · Discord publishing to your own channel · first-party
tracking links · real click tracking · Google Ads OAuth and read access · account
hierarchy discovery · account selection · Google Ads TEST execution ·
`CampaignBudget` creation · App Campaign resource creation · real Campaign ID ·
forced `PAUSED` · Google read-back · Verify with Google again · budget safety
controls · rate and abuse controls

**Planned, not built:** production customer Google Ads execution · ad group
creation · App Ad creation · text, image and video assets · real paid serving ·
paid campaign attribution · install, conversion and revenue attribution ·
performance-driven autonomous optimization · live Reddit access after approval ·
Meta Ads · TikTok Ads · Apple Search Ads · dedicated YouTube and Demand Gen ·
Stripe billing · team and invite functionality

### Customer Google Ads: read-only today

A customer can connect their Google Ads account through Google OAuth, and the
product will discover their account hierarchy and let them select an account.
Refresh tokens are encrypted at rest.

**That path is read-only.** A normal customer cannot yet approve and launch a
campaign in their own production Google Ads account. Every execution in the
product today — public sandbox and signed-in project alike — runs through a
service account into the isolated test hierarchy.

### Discovery and Reddit

Web discovery is live and real: DataForSEO-backed Google search, real public
source URLs, real page titles and snippets, and scoring that judges whether the
right people are in the conversation. Candidates that fail the audience test are
shown as research rather than recommended, and the server refuses to prepare
them.

**Reddit is not live.** The provider is written against Reddit's official
OAuth API, but credentials are still pending approval, so the product reports
its status as `approval_pending` and says so in the interface. It activates when
approved credentials exist — no code change required. Until then, no Reddit data
is being retrieved.

### YouTube

**Implemented:** Google App Campaign creation through the official Google Ads
API.

**Platform capability:** App Campaigns are `MULTI_CHANNEL`, and a complete,
serving App Campaign may be distributed by Google across eligible Google
surfaces, including YouTube.

**Not implemented:** dedicated YouTube campaign management, Demand Gen, explicit
YouTube Shorts targeting, or any YouTube publishing integration.

### Publishing

Drafts are prepared for you to review. Publishing goes to **your own** Discord
channel through a webhook you connect. There is no automated posting into
third-party communities — discovering a community is not the same as being
welcome to post in it, and the product says so where it matters.

### Measurement

Every prepared placement carries a first-party tracking link. `/r/:slug` records
a `TrackingEvent` and redirects; the dashboard counts those clicks.

Measurement today means **click tracking**. Paid impressions, attributed
installs, conversions, cost per install, return on ad spend, and revenue
attribution are not measured and are not displayed.

## Measurement and provenance

Retrieved facts and AI inferences are separate fields with separate labels, all
the way to the screen:

- **RETRIEVED** — from the store listing or a search result
- **AI GENERATED** — the model's interpretation
- **DEMO** — fixed example data in the sandbox

The rule is simple: a retrieved fact is never dressed up as an AI conclusion, an
AI conclusion is never presented as an external fact, and demo fixtures are
never presented as live provider data.

**No fabricated performance metrics.** The only numbers shown are ones that were
actually recorded: first-party click counts from the tracking redirect, and
Google Play listing figures clearly labeled as retrieved store data — which
describe the app, not the results of anything AI Growth Kit did.

## For judges

### A. Fastest proof — the public sandbox (about two minutes)

1. Open **https://ai-growth-kit-695.netlify.app/demo**
2. No signup required
3. Read the safety disclosures, then start the demo
4. Review the example growth workspace
5. Choose a market and approve a daily budget
6. Run the test execution and watch each step report the time Google answered:
   safety policy check → TEST account verification → budget clamp →
   `CampaignBudget` created → App Campaign created → real Campaign ID →
   `PAUSED` → fresh Google read-back
7. Press **Verify with Google again** and watch a new query go to Google

Google test accounts cannot serve ads or spend real money, which is exactly why
this button can be public.

### B. The full product

1. Open **https://ai-growth-kit-695.netlify.app**
2. Create an account
3. Add your app from its Google Play URL and run the analysis
4. Walk through Understand → Promote → Discover, and use publishing and
   measurement where relevant
5. Step 3 also offers the same safe Google Ads test execution for your app
6. The Google Ads connection card shows the read-only customer integration

Production customer campaign execution is planned and is not presented as live.

## Technical architecture

Next.js 16 (App Router) · React 19 · TypeScript · Prisma 6 · Neon PostgreSQL ·
Auth.js v5 with credentials, bcrypt password hashing and JWT sessions · OpenAI
API · DataForSEO · Google Ads API v25 · Discord webhook publisher · deployed on
Netlify · source on GitHub.

Two design constraints shaped a lot of the code. Serverless functions have short
timeouts, so anything slow is split into submit-and-poll phases with resumable
signed tickets — a paid search is never bought twice because a page reloaded.
And the production build stays on webpack (`next build --webpack`); Turbopack
produced a broken Prisma client in the serverless runtime.

## Security

- Authentication with ownership gates on every project-scoped route
- Tenant isolation: a project is only reachable by the account that owns it
- Google OAuth state is an HMAC-signed payload bound to the user and an expiry
- Refresh tokens are encrypted at rest with AES-256-GCM
- Secrets live in Netlify runtime environment variables; none are committed to
  Git, and `.env*` has never been in the repository
- Execution is confined to the isolated Google Ads test hierarchy, confirmed
  with Google on every run
- Campaign status forced to `PAUSED`; hard server-side budget ceiling
- The target advertising account is server-controlled and cannot be supplied by
  a browser
- Database-backed idempotency, per-client rate limiting, global daily cap
- Provider responses are sanitized: no customer IDs, resource names, tokens or
  credentials reach the browser

## Known limitations

- Customer Google Ads is read-only; production execution is not enabled
- Test campaigns have no ad group and no creatives, so they cannot serve
- Reddit discovery is pending API approval
- Measurement is click tracking only
- No billing, subscriptions, or team features
- Rate limits and caps are enforced in the database and unit-tested, but have not
  been load-tested

## Where it fits

AI Growth Kit overlaps with several categories — mobile user-acquisition
platforms, app store optimization tools, app growth analytics, campaign
management, and general AI marketing assistants. Most of those specialize in one
stage of the work and assume you already know the rest.

The difference here is the connection between stages: product understanding →
audience discovery → promotion → authorized action → measurement, carried by one
product that started from your actual app. And where it acts on an external
platform, it proves the result by asking that platform again.

## Hackathon and deployment notes

The public application runs on **Netlify** at
https://ai-growth-kit-695.netlify.app. AI Growth Kit needs a server runtime for
authentication, database access, API integrations, Google Ads execution, and
secret handling, so it cannot be published as a static site.

The HackOnVibe repository holds the source and the real development history.
`.github/workflows/deploy.yml` is preserved unchanged; because this is a
server-side Next.js application, that pipeline publishes a waiting page to the
`*.hackonvibe.com` address rather than the running product. The Netlify URL
above is the live application.

Production deploys are built from a clean, tracked-files-only checkout so that a
developer's local `.env` cannot be copied into the Next.js standalone artifact.
Runtime secrets come from Netlify environment variables.

## Running it yourself

```bash
npm install
cp .env.example .env      # fill in your own values
npx prisma migrate deploy
npm run dev
```

`npm test` runs the suite — no network calls, no paid API requests, no Google
mutations. `.env.example` lists every variable by name with an explanation and
no values.

## Responsible use

AI Growth Kit uses official platform APIs and permission-aware integrations. It
is not built for unsolicited mass messaging, unauthorized access, spam, or
working around platform and community rules. Discovering a community is not the
same as being welcome to post in it, and the product is explicit about that.
