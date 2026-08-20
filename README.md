# AI Growth Kit

**An AI Growth Director for people who can build software but not distribute it.**

Give AI Growth Kit a mobile app. It works out who the product is for, researches
real market and audience signals, recommends an acquisition direction, turns that
decision into an executable campaign proposal, and connects it to real
distribution infrastructure.

The hackathon vertical slice proves this workflow end to end:

```text
REAL APP
→ REAL PRODUCT ANALYSIS
→ REAL WEB RESEARCH
→ AI GROWTH DECISION
→ HUMAN APPROVAL
→ REAL GOOGLE ADS API TEST EXECUTION
→ GOOGLE-GENERATED RESOURCE
→ FRESH PROVIDER VERIFICATION
```

**Production:** [https://ai-growth-kit-695.netlify.app](https://ai-growth-kit-695.netlify.app)  
**Public judge demo — no signup:** [https://ai-growth-kit-695.netlify.app/demo](https://ai-growth-kit-695.netlify.app/demo)

**Who it is for:** indie mobile developers, solo founders, bootstrapped founders
and small software teams without a dedicated growth department.

**The problem:** building software became dramatically faster. Distribution did not.

---

## The problem

Modern AI-assisted development has made software dramatically faster and cheaper
to build.

A solo developer can now create a useful product in days or weeks, but getting
that product in front of the right users still requires a completely different
set of skills.

After shipping an app, a founder still has to:

- understand positioning
- define the real target audience
- choose acquisition channels
- research demand and audience language
- find relevant market signals
- turn those signals into campaign strategy
- configure advertising infrastructure
- create campaign resources
- verify that execution actually happened
- later measure results and decide what to change

These tasks are spread across different tools and traditionally require
marketing, research and advertising expertise.

The result is a new bottleneck:

> **Software creation has become accessible to small teams. Professional
> distribution has not.**

AI Growth Kit is built around that gap.

---

## The solution

AI Growth Kit acts as an **AI Growth Director** for an application.

Instead of starting from a blank marketing prompt, the system starts from the
actual product.

A real Google Play listing provides the initial context. That context flows into
product understanding, audience reasoning, external research and finally an
executable growth experiment.

The product is designed around one connected loop:

```text
Understand → Research → Decide → Execute → Verify
```

Longer term, verified campaign performance can extend that loop into:

```text
Measure → Optimize
```

Measurement-driven optimization is not implemented yet and is not presented as
if it were.

---

## Current product flow

```text
Google Play URL
      ↓
UNDERSTAND
      ↓
PLAN / PROMOTE
      ↓
DISCOVER
      ↓
CAMPAIGN PROPOSAL
      ↓
HUMAN APPROVAL
      ↓
EXECUTE
      ↓
VERIFY
```

| Stage | What happens |
| --- | --- |
| **Understand** | Imports the real Google Play listing and analyzes the audience, problem, positioning and value proposition. |
| **Plan / Promote** | Recommends acquisition channels and growth direction for this specific application. |
| **Discover** | Searches the public web for real market and audience evidence and turns it into audience signals, pain points and growth actions. |
| **Campaign Proposal** | Converts product understanding and external evidence into a concrete acquisition experiment. |
| **Execute** | In the public demo, creates a real Google Ads App Campaign resource in Google's isolated TEST environment. |
| **Verify** | Performs a fresh Google Ads API read-back so the provider — not our own database — confirms the campaign resource. |

AI-generated recommendations and retrieved external facts are deliberately kept
separate.

---

# Try it live

## Public judge demo — `/demo`

The public demo requires:

- no signup
- no email
- no Google Ads account
- no shared credentials

Open:

**[https://ai-growth-kit-695.netlify.app/demo](https://ai-growth-kit-695.netlify.app/demo)**

Paste any valid public Google Play application URL and press:

**Start AI Growth Director**

Nothing is hardcoded to one demonstration application.

The server then performs the real pipeline:

```text
Google Play import
→ Understand & Plan
→ Discover
→ Campaign Proposal
```

The system uses:

- real Google Play listing data
- a real OpenAI model call for product analysis
- real DataForSEO-backed web research
- AI reasoning over the product and retrieved evidence

Completed stages are persisted server-side.

If a provider fails, the workflow reports the failure rather than replacing it
with prepared success data.

---

## The explicit execution step

Automation deliberately stops before modifying Google Ads.

The user must separately choose:

**Execute TEST campaign**

That action uses the real Google Ads API against an isolated Google Ads TEST
hierarchy.

The current judge flow creates:

1. a real `CampaignBudget`
2. a real Google App Campaign
3. status forced to `PAUSED`
4. a Google-generated Campaign ID
5. a fresh Google Ads API read-back

The user can then press:

**Verify with Google again**

That issues another provider query instead of trusting a cached status from our
database.

---

# Why the Google Ads proof matters

Most AI marketing products can generate advice.

The important transition for AI Growth Kit is:

```text
recommendation
        ↓
authorized external action
        ↓
independently verifiable provider result
```

The Google Ads campaign ID displayed in the demo is generated by Google.

The campaign is not simulated.

The provider read-back is not simulated.

The TEST environment itself is real.

What the TEST environment deliberately cannot produce is:

- advertising delivery
- real spend
- paid impressions
- paid clicks
- installs caused by the campaign
- conversions
- Cost Per Install (CPI)
- Return On Ad Spend (ROAS)

We prefer a smaller result that can be independently verified over fabricated
performance numbers.

---

# TEST execution versus production execution

There are two deliberately separate Google Ads architectures.

## 1. Public TEST execution

Used by `/demo` and the existing safe test workflow.

```text
DemoServiceAccountAuthProvider
        ↓
Google Ads TEST advertiser
        ↓
CampaignBudget
        ↓
App Campaign
        ↓
PAUSED
        ↓
Google read-back
```

Before any TEST mutation, Google is asked to confirm:

```text
customer.test_account = true
```

If the account is not a TEST account, execution is refused.

The public demo cannot switch itself to a production customer credential.

---

## 2. Production customer execution backend

A separate production execution architecture now exists in the codebase.

It is intentionally **not exposed through the customer-facing frontend yet**.

The backend is structured around:

```text
Authenticated customer
        ↓
Google OAuth
        ↓
Customer advertiser account
        ↓
Production account verification
        ↓
Approved campaign definition
        ↓
CampaignBudget
        ↓
Campaign
        ↓
AdGroup
        ↓
AdGroupAd / AppAdInfo
        ↓
PAUSED
        ↓
Provider verification
        ↓
Separate launch approval
        ↓
ENABLED
        ↓
Manual PAUSE
```

This is deliberately a different execution engine from the public TEST path.

A production customer path cannot use the demo service-account credential.

---

# Google Ads API Basic Access

There is currently one external limitation:

> **Our Google Ads developer token currently has Test Account Access. We have
> applied for Google Ads API Basic Access, and approval is still pending.**

Until Google grants Basic Access, AI Growth Kit cannot use the Google Ads API to
modify normal production advertising accounts.

For that reason, production mutation is disabled server-side.

Two independent server feature gates exist:

```text
GOOGLE_ADS_PRODUCTION_MUTATION_ENABLED=false
GOOGLE_ADS_PRODUCTION_LAUNCH_ENABLED=false
```

Both ship disabled.

The second gate is deliberately separate from the first:

> Permission to create a PAUSED campaign is not permission to start spending
> money.

There is no separate "Basic Access token." Google changes the access level of
the existing developer token.

---

# Production Google Ads backend

The current repository contains the production execution core behind those
server-side gates.

Implemented backend components include:

- customer Google OAuth
- encrypted OAuth refresh-token storage
- advertiser hierarchy discovery
- advertiser selection
- `UserOAuthAuthProvider`
- production/customer credential separation
- fresh production account validation
- rejection of Google Ads manager accounts as campaign targets
- rejection of TEST accounts on the production path
- deterministic advertising-budget controls
- AI-generated text-ad proposals
- deterministic text-asset validation
- production execution persistence
- CampaignBudget creation
- Campaign creation
- AdGroup creation
- App Ad / `AppAdInfo` creation
- initial campaign status `PAUSED`
- provider verification
- separate launch route
- sparse `PAUSED → ENABLED` campaign-status mutation
- manual pause route
- tenant ownership checks
- execution claims for concurrency protection
- partial-execution persistence
- server-side mutation and launch kill switches
- sanitized provider errors
- automated tests that do not make live Google Ads mutations

The production path is **implemented locally but not live-provider-verified
against a normal advertiser account** because Google Ads API Basic Access is
still pending.

Additional safety hardening is being completed before those feature gates are
ever enabled.

No production Google Ads campaign has been created or launched by this code.

---

# Production campaign safety model

Advertising is a money-moving boundary, so AI is not given final authority.

The architecture follows this principle:

> **AI decides what may be useful. Deterministic backend rules decide what is
> actually allowed to happen.**

Before a production mutation can occur, server code is responsible for
confirming conditions such as:

- authenticated user
- tenant ownership
- customer OAuth credential
- selected advertiser
- advertiser is not a manager account
- advertiser is not a TEST account
- production mutation feature gate enabled
- valid approved advertising assets
- configured average daily budget within server policy
- explicit campaign-creation approval
- execution state claimed against concurrent mutation

Creation and launch are separate decisions.

A production campaign is designed to be created:

```text
PAUSED
```

before any later launch operation.

Launching requires a second approval and a second feature gate.

The model cannot override either feature gate.

---

# Average daily budget

Google Ads `CampaignBudget.amount_micros` represents an **average daily budget**.

AI Growth Kit therefore does not describe that value as a guaranteed maximum
amount that can be spent on every individual calendar day.

The product instead enforces a deterministic ceiling on the **configured average
daily budget value sent to Google**.

Conceptually:

```text
requested average daily budget
        ↓
server validation
        ↓
server ceiling
        ↓
approved configured average daily budget
        ↓
Google Ads
```

A model recommendation cannot override that server limit.

---

# AI-generated advertising text

The production backend also contains a constrained AI ad-copy proposal layer.

The model is given product and research context and may propose:

- headlines
- descriptions

It does **not** decide:

- advertiser identity
- Google customer ID
- execution permissions
- campaign status
- feature gates
- unrestricted budget values

Generated text is passed through deterministic validation before it can become
an advertising asset.

Current rules include:

- Google Ads text-length limits
- minimum and maximum asset counts
- duplicate removal
- invisible/control-character cleanup
- no silent mid-word truncation
- filtering of unsupported model-generated claims

The executable provider payload is constructed by backend code, not by the
language model.

---

# What's working today

## Live product / public judge flow

- Landing page
- Signup and login
- Tenant-isolated projects
- Google Play application import
- Real store listing data
- Product understanding
- Audience analysis
- Positioning and value proposition analysis
- Channel recommendations
- Real DataForSEO-backed web discovery
- Relevance and actionability scoring
- Audience signals
- Pain-point extraction
- Recommended growth actions
- Public no-login `/demo`
- Server-persisted demo workflow
- Real Google Ads TEST authentication
- TEST-account verification
- CampaignBudget creation
- App Campaign creation
- Google-generated Campaign ID
- forced `PAUSED`
- fresh Google provider read-back
- Verify with Google again
- database-backed abuse protections and execution limits

## Implemented in the repository behind production gates

- Customer Google OAuth
- encrypted refresh tokens
- Google Ads account discovery
- account selection
- customer OAuth auth provider
- production account validation
- manager-account rejection
- TEST-account rejection on production path
- production CampaignBudget provider path
- production Campaign provider path
- production AdGroup provider path
- production App Ad provider path
- production verification route
- separate launch route
- manual pause route
- separate mutation and launch feature gates
- production execution persistence
- deterministic ad-copy validation
- AI-assisted text-asset proposals

## Not live-verified yet

The production path cannot be live-tested against a normal advertiser account
until Google grants Google Ads API Basic Access.

That limitation comes from the current access level of the developer token, not
from the public TEST environment.

---

# Meaningful AI, deterministic safety

AI is used as a reasoning layer rather than simply as a text-generation feature.

| Area | What AI does |
| --- | --- |
| **Understand** | Interprets the app listing and infers audience, problem and value proposition |
| **Plan / Promote** | Recommends acquisition directions and explains why |
| **Discover** | Generates research queries and scores whether retrieved evidence actually matches the target audience |
| **Growth intelligence** | Converts external evidence into audience signals, pain points and recommended growth actions |
| **Production ad proposal** | Produces candidate advertising headlines and descriptions that deterministic backend rules validate before execution |

The model currently used by the application is:

**`gpt-4o-mini`**

via the OpenAI API.

There is currently:

- no multi-model routing
- no autonomous performance optimization loop
- no AI authority to bypass server execution rules

Those are not presented as implemented.

---

# Evidence versus inference

AI Growth Kit deliberately separates external evidence from model reasoning.

Typical provenance categories are:

- **RETRIEVED / OBSERVED** — came from the store or external web research
- **AI GENERATED / AI INFERENCE** — interpretation or recommendation produced by the model
- **DEMO** — intentionally synthetic demonstration data where such fixtures are used

A retrieved fact is not presented as an AI discovery.

An AI recommendation is not presented as a provider fact.

A provider result is not marked successful until the external provider returns
it.

---

# No fabricated performance metrics

The current product does not invent:

- campaign spend
- paid impressions
- paid clicks
- campaign-generated installs
- attributed conversions
- Cost Per Install
- Return On Ad Spend
- revenue attribution

Those numbers require real campaign delivery and attribution infrastructure.

They do not exist in the current TEST environment and therefore are not shown.

First-party click-tracking infrastructure exists in the codebase, including:

```text
TrackingLink
TrackingEvent
/r/[slug]
```

but measurement is not currently a primary user-facing stage.

---

# Why the hackathon demo uses TEST advertising

Putting unrestricted production advertising behind a public hackathon button
would be unsafe.

Google Ads TEST accounts solve that problem.

They allow AI Growth Kit to demonstrate:

- real authentication
- real API mutation
- real Google resources
- real provider-generated identifiers
- real read-back

without:

- serving advertising
- charging an advertiser
- exposing a customer's account
- creating public financial risk

This is why the public judge workflow uses the isolated TEST path even though a
separate production architecture exists in the repository.

---

# Who it's for

AI Growth Kit is primarily designed for:

- indie mobile developers
- solo founders
- bootstrapped founders
- first-time software founders
- small software teams without a dedicated growth specialist

The defining situation is:

> **They can build the product. Distribution is the bottleneck.**

Today their alternatives usually involve:

- spending founder hours across disconnected marketing tools
- learning specialist advertising systems
- hiring freelancers
- hiring a growth specialist earlier than the business can justify

AI Growth Kit does not claim to replace an experienced marketing organization.

Its goal is to make structured growth work available to teams that do not have
one yet.

---

# Why this matters

AI-assisted development is expanding the number of people capable of creating
software.

Distribution expertise has not expanded at the same rate.

A technically strong product can still fail to reach users because its creator:

- does not understand performance marketing
- does not know which audience to prioritize
- cannot afford an agency
- does not have a growth team
- has no time to learn several acquisition platforms
- cannot connect research, strategy and execution into one repeatable system

AI Growth Kit tries to make that workflow accessible through one product that
carries context from the application itself into research and authorized
execution.

---

# Business model

AI Growth Kit is intended to become a subscription **Software as a Service
(SaaS)** product.

There is currently:

- no Stripe integration
- no paid subscription system
- no production billing
- no team/invite system
- no paying customers
- no revenue

Those facts are intentionally not hidden.

The intended pricing structure is conceptual:

| Tier | Intended shape |
| --- | --- |
| **Free / Trial** | Limited projects and enough of the core workflow to evaluate the product |
| **Starter** | More projects, deeper research and production growth capabilities |
| **Pro** | Higher limits, experimentation, optimization and collaboration as those capabilities become production-ready |

Advertising spend remains separate from the SaaS subscription.

When production advertising becomes available:

```text
Customer ↔ Google
```

remains the billing relationship for advertising spend.

AI Growth Kit charges for software and automation, not for holding the
customer's advertising funds.

---

# Path to first revenue

1. Recruit early users from indie developer, mobile developer and bootstrapped
   founder communities.
2. Let them import real applications and evaluate whether the workflow saves
   meaningful research and growth-planning time.
3. Validate repeated use of product understanding, market intelligence and
   acquisition planning.
4. Enable controlled production Google Ads execution after Google Ads API Basic
   Access and production verification are complete.
5. Introduce paid SaaS tiers around repeated growth workflows and higher-value
   execution.
6. Add measurement and optimization only after real provider performance data is
   available.
7. Expand into additional acquisition channels based on actual customer demand.

There are no customers or revenue today.

This is the commercialization plan, not a claim about existing traction.

---

# Why the model can be sustainable

The people who benefit from the product are also potential paying customers.

Subscription revenue can fund:

- application infrastructure
- model usage
- web-research providers
- advertising integrations
- monitoring
- additional acquisition channels
- continued product development

Advertising spend does not need to pass through AI Growth Kit.

That creates a relatively direct SaaS relationship:

> if the system repeatedly saves founders time or helps them run better growth
> experiments, they have a reason to subscribe.

We are not claiming profitability today.

---

# Current versus planned

## Working now

- authentication
- tenant-isolated projects
- Google Play import
- product understanding
- target-audience analysis
- acquisition-channel recommendations
- DataForSEO-backed external research
- audience and pain-point intelligence
- Google Ads TEST execution
- real `CampaignBudget`
- real App Campaign resource
- Google-generated Campaign ID
- `PAUSED`
- fresh Google verification
- public no-login judge flow
- first-party click-tracking backend infrastructure

## Implemented in backend, disabled pending external approval

- customer OAuth production architecture
- production advertiser validation
- production `CampaignBudget`
- production Campaign
- production AdGroup
- production App Ad / `AppAdInfo`
- AI-generated text assets
- deterministic ad-asset validation
- separate create approval
- separate launch architecture
- manual pause architecture
- server-side production mutation gate
- separate production launch gate
- persistent production execution state

These capabilities are intentionally not exposed in the current customer-facing
frontend.

They remain disabled while Google Ads API Basic Access is pending and have not
been live-provider-verified against a normal production advertiser.

## Planned, not built

- paid campaign performance dashboard
- paid impressions/click/spend reporting loop
- install attribution
- conversion attribution
- Cost Per Install optimization
- revenue attribution
- automated performance-driven optimization
- automated budget reallocation
- production creative experimentation
- Stripe billing
- subscriptions
- team/invite functionality
- Meta Ads execution
- TikTok Ads execution
- Apple Search Ads execution
- dedicated YouTube campaign management

---

# Customer Google Ads connection

A signed-in customer can authorize Google Ads through Google OAuth.

The current integration supports:

- OAuth authorization
- encrypted refresh-token storage
- account hierarchy discovery
- advertiser-account selection

The existing customer-facing connection interface remains non-executing.

There is currently **no customer-facing production campaign button**.

The production execution routes exist only in the backend and remain protected by
server-side feature gates.

---

# Discovery and Reddit

Web discovery is live.

AI Growth Kit uses DataForSEO-backed public web search to retrieve real:

- URLs
- titles
- snippets
- audience evidence

The AI then evaluates whether the source actually contains the relevant audience
and turns useful evidence into:

- audience signals
- pain points
- growth actions
- advertising or positioning hypotheses

Discovery is research, not outreach.

AI Growth Kit does not automatically:

- post to communities
- comment
- send unsolicited messages
- contact people found through research

Reddit's dedicated Data API integration is not currently live because approval
is still pending.

No live Reddit data is presented when those credentials are unavailable.

---

# YouTube

Google App Campaigns use Google's multi-channel advertising infrastructure.

A complete serving App Campaign may be distributed by Google across eligible
Google inventory, which can include YouTube.

AI Growth Kit does **not** currently implement:

- dedicated YouTube campaign management
- YouTube publishing
- explicit YouTube Shorts targeting
- Demand Gen campaign management

Those should not be confused with App Campaign support.

---

# Measurement

First-party measurement infrastructure exists:

```text
/r/[slug]
→ TrackingEvent
→ redirect
```

It is retained for later attribution work but is not currently one of the
primary product stages.

AI Growth Kit does not currently measure:

- Google Ads spend
- paid impressions
- paid clicks
- attributed installs
- paid conversions
- Cost Per Install
- Return On Ad Spend
- revenue attribution

The future optimization loop depends on those measurements and therefore is not
presented as implemented today.

---

# For judges

## Fastest proof: public demo

1. Open **[the public live demo](https://ai-growth-kit-695.netlify.app/demo)**
2. No signup is required.
3. Paste any valid public Google Play app URL.
4. Press **Start AI Growth Director**.
5. Watch the real workflow complete:
   - App import
   - Understand & Plan
   - Discover
   - Campaign Proposal
6. Review the distinction between retrieved evidence and AI-generated reasoning.
7. Explicitly press **Execute TEST campaign**.
8. Watch the Google Ads execution return a real Google-generated campaign
   resource and `PAUSED` status.
9. Press **Verify with Google again** to issue a fresh provider query.

The TEST environment cannot serve advertising or spend money.

That is why this workflow can safely be made public.

---

## Full authenticated product

1. Open **[https://ai-growth-kit-695.netlify.app](https://ai-growth-kit-695.netlify.app)**
2. Create an account.
3. Create a project from a real Google Play URL.
4. Run product analysis.
5. Explore Understand → Promote → Discover.
6. The existing safe Google Ads TEST workflow can execute against the isolated
   TEST hierarchy.
7. Google Ads account connection infrastructure is available separately for
   customer OAuth/account discovery.

The production execution backend is not exposed through this interface while
Basic Access is pending.

---

# Technical architecture

```text
Browser
   ↓
Next.js 16 / React 19 / TypeScript
   ↓
AI Growth Kit server
   ├── OpenAI
   │     product reasoning / recommendations / ad-copy proposals
   │
   ├── DataForSEO
   │     real public web evidence
   │
   ├── Google Ads API v25
   │     TEST execution
   │     production execution architecture behind feature gates
   │
   ├── deterministic safety layer
   │     account guards / budget policy / approvals / execution gates
   │
   └── Prisma 6
          ↓
       Neon PostgreSQL
```

Additional stack:

- Auth.js v5
- bcrypt password hashing
- JSON Web Token (JWT) sessions
- Google OAuth
- Netlify server runtime

The production build intentionally remains:

```text
next build --webpack
```

Slow provider workflows are split into bounded server operations where needed,
and completed workflow state is persisted rather than being represented by
client-side timers.

---

# Security

- Authentication and project ownership checks
- Tenant isolation
- Google OAuth state protection
- encrypted Google refresh tokens using authenticated encryption
- credentials remain server-side
- `.env` is ignored by Git
- `.env.example` contains variable names and safe placeholders only
- TEST execution requires Google to confirm `test_account = true`
- production execution requires customer OAuth
- production path rejects TEST advertiser accounts
- production path rejects manager accounts as campaign targets
- separate TEST and production authentication providers
- production mutation disabled by default
- production launch disabled independently by default
- campaign creation designed to begin as `PAUSED`
- configured average daily budget bounded by deterministic server policy
- ownership checks on production execution records
- provider error bodies are sanitized
- no browser authority over secrets or server feature gates
- public `/demo` cannot use production customer credentials

---

# Known limitations

- Google Ads API Basic Access is still pending
- production Google Ads mutations remain disabled
- production execution is not exposed through the frontend
- the production path has not yet been live-provider-verified against a normal
  advertiser account
- the public TEST campaign does not serve advertising or produce performance data
- paid campaign attribution is not implemented
- optimization based on spend/install/conversion performance is not implemented
- Reddit's dedicated API access is pending approval
- measurement is not a primary user-facing stage
- no billing or subscriptions
- no team/invite functionality

---

# Where AI Growth Kit fits

AI Growth Kit overlaps with several existing categories:

- AI marketing assistants
- mobile user-acquisition platforms
- App Store Optimization tools
- audience-research products
- campaign-management systems
- marketing analytics products

Most specialize in one stage.

AI Growth Kit is built around the connection between stages:

```text
PRODUCT
   ↓
UNDERSTANDING
   ↓
EXTERNAL EVIDENCE
   ↓
GROWTH DECISION
   ↓
AUTHORIZED EXECUTION
   ↓
PROVIDER VERIFICATION
```

Google Ads is the first execution arm, not the whole product.

Google already knows how to run an advertising auction.

The role of AI Growth Kit is different: understand the product and evidence,
decide what growth experiment makes sense, translate that into controlled
execution, and eventually use measured results to recommend the next action.

---

# Hackathon and deployment notes

The live server application runs on Netlify:

**[https://ai-growth-kit-695.netlify.app](https://ai-growth-kit-695.netlify.app)**

AI Growth Kit requires a server runtime for:

- authentication
- database access
- OpenAI calls
- DataForSEO calls
- Google Ads authentication
- Google Ads execution
- secret handling

The HackOnVibe repository contains the product source and development history.

The organizer-provided:

```text
.github/workflows/deploy.yml
```

is preserved.

The actual Next.js application runtime is hosted separately on Netlify.

Runtime secrets are supplied through environment variables and are not committed
to the repository.

---

# Running locally

```bash
npm install
cp .env.example .env
# Fill in your own local credentials.
npx prisma migrate deploy
npm run dev
```

Run automated checks with:

```bash
npm test
npm run lint
npx tsc --noEmit
npx prisma validate
npm run build
```

Tests use mocks for production Google Ads mutations.

They do not spend advertising money or make production campaign mutations.

---

# Responsible use

AI Growth Kit uses official platform APIs and permission-aware integrations.

It is not designed for:

- unsolicited mass messaging
- unauthorized account access
- automated spam
- bypassing platform rules
- pretending AI-generated inference is retrieved evidence
- silently spending advertising money

External actions that can create financial consequences are deliberately
separated from AI recommendations and constrained by deterministic backend
rules.

The goal is not autonomous growth at any cost.

The goal is **controlled, evidence-based growth execution that a small software
team can understand and verify.**
