# AI Growth Kit

An AI growth agent for app developers. You give it a Google Play link; it works out who your
users are, where they already gather, and then — with your approval — creates the advertising
campaign itself through the Google Ads API.

**Live app: https://ai-growth-kit-695.netlify.app**
**Judge demo (no account needed): https://ai-growth-kit-695.netlify.app/demo**

> ### Why the `*.hackonvibe.com` address shows a waiting page
>
> This is a Next.js server application, not a static site. The HackOnVibe pipeline publishes
> static output to Cloudflare Pages and, as its own build log explains, leaves server apps to be
> deployed by the team — so the live URL above is where the running product is. The repository is
> unchanged in the way the rules require: `.github/workflows/deploy.yml` has never been edited.

## What a judge can verify in two minutes

Open `/demo` and press the button. With no sign-up, the server will:

1. create a Google Ads **campaign budget** in an isolated **test** advertising account;
2. create an **App Campaign**, `PAUSED`, through the real Google Ads API (v25);
3. **read the campaign back from Google** with a fresh query and show what Google returned;
4. let you press **Verify with Google again** at any time, which re-queries Google live rather
   than re-reading our database.

**What this proves:** the product performs real, authenticated, audited write operations against
a real advertising platform, and can prove the result independently.

**What it does not claim:** the campaign is not serving. It is paused, it has no ad group and no
app ad creatives, and a Google Ads test account cannot serve advertising or spend money at all.
Nothing is shown to anyone and no users are acquired. The demo page says exactly this.

## The loop

| Step | What happens | Where the data comes from |
| --- | --- | --- |
| **Understand** | Reads the real Google Play listing and derives audience, problem and value proposition | Store data is retrieved; interpretation is AI, and each is labelled |
| **Promote** | Recommends channels for this specific app | AI inference, labelled |
| **Discover** | Live web search for public discussions where the audience already talks | Real search results, scored for whether the *people* fit — not just the words |
| **Publish** | Prepares a draft and a unique tracking link for opportunities that pass the gate | You post it yourself; weak or unsuitable placements cannot be prepared at all |
| **Measure** | Counts every click on every tracking link | Real, first-party |
| **Execute** | Creates the Google Ads campaign, paused, after your approval | Real Google Ads API, verified by read-back |

## Principles the code actually enforces

- **Provenance is structural.** Retrieved facts and AI inference are separate fields with separate
  labels, all the way to the screen. Nothing invents a metric it did not measure.
- **A model may propose a budget; it never decides one.** `clampDailyBudgetMicros` is deterministic
  server code, and the request is built from its output. No value from a browser can raise it.
- **The account is never taken from the client.** Customer id, manager id, credential and campaign
  status are resolved server-side; a request body can influence only goal, market, and a budget
  that is clamped before use.
- **Proof means asking Google, not trusting ourselves.** Every campaign is confirmed by a separate
  read query, and the verify button repeats that query on demand.
- **Discovery can say no.** A page can contain every keyword and none of your users. Candidates
  that fail the audience test are shown as research, and the server refuses to prepare them.

## Running it yourself

```bash
npm install
cp .env.example .env      # then fill in your own values
npx prisma migrate deploy
npm run dev
```

`npm test` runs the suite (no network, no paid API calls). `npm run build` must stay on webpack —
see `package.json`.

### Configuration

`.env.example` lists every variable by name, with an explanation and no values. Nothing
confidential is stored in this repository: `.env*` is git-ignored and has never been committed.
The Google Ads sandbox stays disabled unless its variables are present, and the demo page says so
plainly rather than pretending to work.

## Stack

Next.js 16 (App Router) · TypeScript · Prisma + PostgreSQL (Neon) · Auth.js v5 ·
Google Ads API v25 · DataForSEO · OpenAI · deployed on Netlify.

## Responsible use

The product uses official platform APIs and permission-aware integrations. It is not built for
unsolicited mass messaging, unauthorised access, spam, or working around platform and community
rules. Discovering a community is not the same as being welcome to post in it, and the product
says so where it matters.
