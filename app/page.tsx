import Link from "next/link";
import { LandingNav, LandingCta } from "@/components/app/LandingNav";

/**
 * Every claim on this page describes something the product actually does
 * today. No customers, logos, testimonials or usage numbers are implied.
 */
const FLOW = [
  {
    title: "Understand",
    body: "Paste a Google Play link. We read the real listing and the AI works out the audience, the problem and the value proposition.",
  },
  {
    title: "Promote",
    body: "Channel recommendations for this specific app — where to start, why it fits, and the angle to take.",
  },
  {
    title: "Discover",
    body: "Real public web search finds discussions where people with your problem already talk to each other.",
  },
  {
    title: "Prepare",
    body: "For a recommended opportunity, a drafted post and a unique tracking link. You post it yourself.",
  },
  {
    title: "Measure",
    body: "Every link is counted, so you see which placement actually sent people to your app.",
  },
];

const PRINCIPLES = [
  {
    title: "Retrieved facts stay separate from AI guesses",
    body: "Store details, page titles and search snippets are labelled as retrieved. Audience, positioning and relevance are labelled as AI inference. You always know which is which.",
  },
  {
    title: "It tells you when an audience isn't yours",
    body: "A page can use all your keywords and contain none of your users. Discovery judges who is actually in the conversation, and says when it isn't a fit.",
  },
  {
    title: "Nothing is published behind your back",
    body: "Drafts are prepared for you to review and post. Posting rules are never assumed, and automated publishing only runs through channels you connect yourself.",
  },
];

export default function Landing() {
  return (
    <>
      <LandingNav />

      <main className="page">
        <section className="hero animate-in">
          <span className="badge badge-warning">Early access · in development</span>
          <h1 className="t-display" style={{ marginTop: 18, maxWidth: 760, marginInline: "auto" }}>
            Turn one app link into a
            <br />
            practical growth plan
          </h1>
          <p className="t-lead" style={{ maxWidth: 600, margin: "18px auto 0" }}>
            AI Growth Kit reads your Google Play listing, works out who your users are, finds the
            public discussions where they already gather, and counts every click you earn.
          </p>
          <LandingCta />
        </section>

        <section id="how-it-works" aria-labelledby="flow-heading" style={{ marginTop: 8, scrollMarginTop: 88 }}>
          <div className="section-head">
            <div>
              <h2 id="flow-heading" className="t-h2">
                How it works
              </h2>
              <p className="t-small">Five steps, from a store link to measured clicks.</p>
            </div>
          </div>
          <div className="flow stagger">
            {FLOW.map((s) => (
              <article key={s.title} className="flow-step">
                <h3 className="t-h3">{s.title}</h3>
                <p className="t-small" style={{ marginTop: 6 }}>
                  {s.body}
                </p>
              </article>
            ))}
          </div>
        </section>

        <section aria-labelledby="demo-heading" style={{ marginTop: 64 }}>
          <div className="card card-lg card-accent">
            <span className="badge badge-accent">No account needed</span>
            <h2 id="demo-heading" className="t-h2" style={{ marginTop: 14 }}>
              It doesn&apos;t only advise. Watch it execute.
            </h2>
            <p className="t-body" style={{ marginTop: 10, maxWidth: 640 }}>
              Approve a daily budget and the product creates a real Google Ads App Campaign through
              the Google Ads API — paused, in an isolated test account — then asks Google to confirm
              it while you watch. A test account serves no ads and spends nothing, and the campaign
              carries no ad creatives, so nothing is shown to anyone.
            </p>
            <div className="row-wrap" style={{ marginTop: 22 }}>
              <Link href="/demo" className="btn btn-primary">
                Try the live demo
              </Link>
              <span className="t-meta">One execution per visitor</span>
            </div>
          </div>
        </section>

        <section aria-labelledby="principles-heading" style={{ marginTop: 64 }}>
          <div className="section-head">
            <div>
              <h2 id="principles-heading" className="t-h2">
                Built to be trusted with your growth
              </h2>
              <p className="t-small">
                Acquisition advice is only worth acting on if you can tell where it came from.
              </p>
            </div>
          </div>
          <div className="feature-grid stagger">
            {PRINCIPLES.map((p) => (
              <article key={p.title} className="card">
                <h3 className="t-h3">{p.title}</h3>
                <p className="t-small" style={{ marginTop: 8 }}>
                  {p.body}
                </p>
              </article>
            ))}
          </div>
        </section>

        <section aria-labelledby="who-heading" style={{ marginTop: 64 }}>
          <div className="card card-lg card-accent">
            <h2 id="who-heading" className="t-h2">
              For people who can build, but shouldn&apos;t have to guess at distribution
            </h2>
            <p className="t-body" style={{ marginTop: 10, maxWidth: 620 }}>
              Indie app developers, startup founders and small software teams — anyone who has
              shipped something good and now has to answer the harder question of where the first
              users come from.
            </p>
            <div className="hero-actions" style={{ justifyContent: "flex-start", marginTop: 24 }}>
              <LandingCta compact />
            </div>
          </div>
        </section>

        <section aria-labelledby="use-heading" style={{ marginTop: 56 }}>
          <h2 id="use-heading" className="t-label">
            Responsible use
          </h2>
          <p className="t-small" style={{ marginTop: 10, maxWidth: 720 }}>
            AI Growth Kit uses official platform APIs and permission-aware integrations. It is not
            built for unsolicited mass messaging, unauthorised access, spam, or working around
            platform and community rules. Discovering a community is not the same as being welcome
            to post in it, and the product says so.
          </p>
        </section>

        <footer
          className="spread"
          style={{
            marginTop: 64,
            paddingTop: 24,
            borderTop: "1px solid var(--border)",
          }}
        >
          <span className="t-meta">© {new Date().getFullYear()} AI Growth Kit — early access</span>
          <span className="row-wrap">
            <Link href="/login" className="t-meta">
              Log in
            </Link>
            <Link href="/signup" className="t-meta">
              Create account
            </Link>
          </span>
        </footer>
      </main>
    </>
  );
}
