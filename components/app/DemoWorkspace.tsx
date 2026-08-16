"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge, Chip } from "@/components/ui/Badge";
import {
  BUDGET_CHOICES,
  DEMO_APP,
  DISCOVER,
  MARKETS,
  PROMOTE,
  UNDERSTAND,
} from "@/lib/demo/workspace";

/**
 * THE PUBLIC DEMO.
 *
 * A visitor gets to press the button that actually calls Google — so the copy
 * here carries a duty. Everything stated as fact is either a labelled example
 * or something Google returned to us; nothing implies the campaign serves,
 * spends or acquires anyone. The strongest claim allowed on this page is the
 * true one: a real campaign resource exists in an isolated test account, and
 * you can make Google confirm it in front of you.
 */

type Proof = {
  campaignId: string | null;
  campaignName: string | null;
  status: string | null;
  channelType: string | null;
  channelSubType: string | null;
  appId: string | null;
  dailyBudgetMicros: number | null;
  completedAt: string | null;
  lastVerifiedAt: string | null;
  events: { code: string; label: string; detail?: string; status: string; at: string }[];
};

type Plan = {
  marketLabel: string;
  strategy: string;
  reasoning: string[];
  dailyBudgetMicros: number;
  approvedDailyBudgetMicros: number;
  clampedByPolicy: boolean;
  campaignStatus: string;
  channel: string;
};

type Phase = "intro" | "workspace" | "running" | "done";

/** The steps the server will run. Shown as intent before, never as progress. */
const PLANNED = [
  "Verify the target is a Google Ads TEST account",
  "Validate the approved budget against the server ceiling",
  "Create the campaign budget",
  "Create the App Campaign — PAUSED",
  "Read the campaign back from Google",
];

const money = (micros: number | null) =>
  micros == null ? "—" : (micros / 1_000_000).toFixed(2);

const clock = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";

export function DemoWorkspace() {
  const [phase, setPhase] = useState<Phase>("intro");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [starting, setStarting] = useState(false);
  const [market, setMarket] = useState<string>(MARKETS[0].code);
  const [budget, setBudget] = useState<number>(BUDGET_CHOICES[1].micros);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [proof, setProof] = useState<Proof | null>(null);
  const [reused, setReused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyNote, setVerifyNote] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/demo/session", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error("session");
      setConfigured(Boolean(data.configured));
      setPhase("workspace");
    } catch {
      setError("The demo could not start. Please reload the page and try again.");
    } finally {
      setStarting(false);
    }
  }, []);

  const execute = useCallback(async () => {
    setPhase("running");
    setError(null);
    setVerifyNote(null);
    try {
      const res = await fetch("/api/demo/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market, approvedDailyBudgetMicros: budget }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          typeof data.error === "string"
            ? data.error
            : "The Google Ads test execution could not be completed."
        );
        setPhase("workspace");
        return;
      }
      setReused(Boolean(data.reused));
      setPlan((data.plan as Plan) ?? null);
      setProof(data.proof as Proof);
      setPhase("done");
    } catch {
      setError(
        "The connection to the server was lost while the execution was running. Reload the page — if a campaign was created, it will be shown."
      );
      setPhase("workspace");
    }
  }, [market, budget]);

  const verify = useCallback(async () => {
    setVerifying(true);
    setVerifyNote(null);
    try {
      const res = await fetch("/api/demo/verify", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.verified) {
        setVerifyNote(
          typeof data.error === "string" ? data.error : "Google could not confirm this campaign right now."
        );
        return;
      }
      setProof((p) =>
        p
          ? {
              ...p,
              status: data.status ?? p.status,
              lastVerifiedAt: data.verifiedAt ?? p.lastVerifiedAt,
              campaignName: data.campaignName ?? p.campaignName,
            }
          : p
      );
      setVerifyNote(`Google confirmed this campaign again at ${clock(data.verifiedAt)}.`);
    } catch {
      setVerifyNote("The verification request could not be sent.");
    } finally {
      setVerifying(false);
    }
  }, []);

  /**
   * Recover the campaign this session already owns.
   *
   * Reads our own records rather than asking to execute again — on a session
   * that has not run yet, "execute" is a question that creates a campaign.
   */
  const recover = useCallback(async (): Promise<boolean> => {
    const res = await fetch("/api/demo/status").catch(() => null);
    if (!res) return false;
    const data = await res.json().catch(() => ({}));
    if (!data?.executed || !data.proof) return false;
    setProof(data.proof as Proof);
    setReused(true);
    setError(null);
    setPhase("done");
    return true;
  }, []);

  // A session started earlier in this browser may already own an execution.
  useEffect(() => {
    if (phase !== "workspace") return;
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await recover();
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, recover]);

  return (
    <main className="page">
      <div className="notice notice-demo" style={{ marginBottom: 20 }}>
        Public demo · real Google Ads API · isolated test account
      </div>

      <section className="stack">
        <div className="section-head">
          <div>
            <h1 className="t-h1">See the agent execute, not just advise</h1>
            <p className="t-lead" style={{ marginTop: 10, maxWidth: 680 }}>
              This is the product&apos;s own sandbox. You approve a budget, and the server creates a
              real, paused Google Ads App Campaign in an isolated test account — then asks Google to
              confirm it in front of you.
            </p>
          </div>
        </div>

        {phase === "intro" && (
          <div className="card card-lg card-accent animate-in">
            <h2 className="t-h3">Before you press it</h2>
            <ul className="stack" style={{ marginTop: 12, paddingLeft: 18 }}>
              <li className="t-small">
                No sign-up, no email, no Google account. Your session sees nothing belonging to any
                customer.
              </li>
              <li className="t-small">
                The campaign is created <strong>PAUSED</strong> in a Google Ads test account. Test
                accounts cannot serve ads and cannot spend money.
              </li>
              <li className="t-small">
                No ad group or app ad creatives are created, so nothing is submitted for review and
                nothing is advertised. What you get is a real API resource you can verify.
              </li>
              <li className="t-small">
                One execution per visitor. The budget you approve is a request — the server clamps it
                to its own ceiling before anything reaches Google.
              </li>
            </ul>
            <div className="row-wrap" style={{ marginTop: 20 }}>
              <button className="btn btn-primary btn-lg" onClick={start} disabled={starting}>
                {starting ? "Starting…" : "Try the live demo"}
              </button>
              <Link href="/" className="btn btn-secondary btn-lg">
                Back to the site
              </Link>
            </div>
          </div>
        )}

        {phase !== "intro" && (
          <>
            {configured === false && (
              <div className="notice notice-warning">
                The Google Ads sandbox is not configured on this deployment, so the execution button
                is unavailable. Everything below is the same demo workspace a judge would see.
              </div>
            )}
            {error && (
              <div className="notice notice-error">
                <span className="stack">
                  <span>{error}</span>
                  <span>
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={recovering}
                      onClick={async () => {
                        setRecovering(true);
                        const found = await recover();
                        if (!found)
                          setError(
                            "No campaign was created for this session, so nothing was left behind. You can run the demo again."
                          );
                        setRecovering(false);
                      }}
                    >
                      {recovering ? "Checking…" : "Check whether a campaign was created"}
                    </button>
                  </span>
                </span>
              </div>
            )}

            <DemoAppWorkspace />

            {phase !== "done" && (
              <section className="card card-lg" aria-labelledby="autopilot">
                <div className="spread">
                  <h2 id="autopilot" className="t-h2">
                    Growth Autopilot
                  </h2>
                  <Badge tone="accent">Step 4 · Execute</Badge>
                </div>
                <p className="t-small" style={{ marginTop: 8, maxWidth: 640 }}>
                  Choose the market and the daily budget you are willing to approve. Everything else —
                  the advertising account, the campaign type and the paused status — is decided by the
                  server, not by this page.
                </p>


                <div className="stack-lg" style={{ marginTop: 20 }}>
                  <div className="field">
                    <label className="field-label" htmlFor="market">
                      Market
                    </label>
                    <select
                      id="market"
                      className="input"
                      value={market}
                      onChange={(e) => setMarket(e.target.value)}
                      disabled={phase === "running"}
                    >
                      {MARKETS.map((m) => (
                        <option key={m.code} value={m.code}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="field">
                    <span className="field-label">Daily budget you approve</span>
                    <div className="row-wrap" style={{ marginTop: 4 }}>
                      {BUDGET_CHOICES.map((b) => (
                        <button
                          key={b.micros}
                          type="button"
                          className={`btn ${budget === b.micros ? "btn-primary" : "btn-secondary"}`}
                          onClick={() => setBudget(b.micros)}
                          disabled={phase === "running"}
                          aria-pressed={budget === b.micros}
                        >
                          {b.label}
                        </button>
                      ))}
                    </div>
                    <p className="field-hint">
                      In the test account&apos;s own currency. A test account is never charged.
                    </p>
                  </div>

                  <div className="card card-muted">
                    <h3 className="t-label">What the server will do</h3>
                    <ol className="steps" style={{ marginTop: 12, listStyle: "none" }}>
                      {PLANNED.map((s) => (
                        <li key={s} className="step">
                          <span className="step-dot" aria-hidden="true">
                            ✓
                          </span>
                          <span>{s}</span>
                        </li>
                      ))}
                    </ol>
                  </div>

                  <div>
                    <button
                      className={`btn btn-primary btn-lg btn-block${phase === "running" ? " btn-busy" : ""}`}
                      onClick={execute}
                      disabled={phase === "running" || !configured}
                    >
                      {phase === "running" ? (
                        <>
                          <span className="spinner spinner-dark" aria-hidden="true" /> Calling the
                          Google Ads API…
                        </>
                      ) : (
                        "Execute in Google Ads (test account)"
                      )}
                    </button>
                    <p className="t-meta" style={{ marginTop: 10, textAlign: "center" }}>
                      Creates one paused campaign. Nothing is published and no ads are served.
                    </p>
                  </div>
                </div>
              </section>
            )}

            {phase === "running" && (
              <div className="card card-muted" role="status" aria-live="polite">
                <div className="row">
                  <span className="spinner" aria-hidden="true" />
                  <span className="t-small">
                    The server is calling Google now. Each step below will be listed with the time
                    Google answered — this console reports results, it does not animate guesses.
                  </span>
                </div>
              </div>
            )}

            {phase === "done" && proof && (
              <ExecutionResult
                proof={proof}
                plan={plan}
                reused={reused}
                verifying={verifying}
                verifyNote={verifyNote}
                onVerify={verify}
              />
            )}
          </>
        )}
      </section>
    </main>
  );
}

/** Steps 1–3 of the loop, as a worked example. Every card states its source. */
function DemoAppWorkspace() {
  return (
    <section className="stack-lg" aria-label="Demo workspace">
      <div className="card">
        <div className="spread">
          <div>
            <h2 className="t-h3">{DEMO_APP.name}</h2>
            <p className="t-meta" style={{ marginTop: 4 }}>
              {DEMO_APP.category} · Google Play
            </p>
          </div>
          <Badge tone="neutral">Example app</Badge>
        </div>
      </div>

      <div className="card">
        <div className="spread">
          <h3 className="t-h3">1 · Understand</h3>
          <Chip>Retrieved + AI inference</Chip>
        </div>
        <dl className="kv" style={{ marginTop: 14 }}>
          {UNDERSTAND.map((f) => (
            <div key={f.label}>
              <dt className={f.provenance === "RETRIEVED" ? "prov-retrieved" : "prov-ai"}>
                {f.label} <span className="prov-label">{f.provenance}</span>
              </dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="card">
        <h3 className="t-h3">2 · Promote</h3>
        <div className="stack" style={{ marginTop: 12 }}>
          {PROMOTE.map((c) => (
            <div key={c.channel} className="prov prov-ai">
              <div className="row-wrap">
                <strong className="t-body">{c.channel}</strong>
                <Badge tone={c.priority === "high" ? "success" : "neutral"}>{c.priority}</Badge>
              </div>
              <p className="t-small" style={{ marginTop: 4 }}>
                {c.why}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="spread">
          <h3 className="t-h3">3 · Discover</h3>
          <Chip>Example results</Chip>
        </div>
        <p className="t-small" style={{ marginTop: 6 }}>
          In a real project these come from live web search. Here they are fixed examples, so that
          what you compare is the judgement — including the one this product refuses to recommend.
        </p>
        <div className="stack" style={{ marginTop: 14 }}>
          {DISCOVER.map((d) => (
            <div key={d.title} className="card card-muted">
              <div className="spread">
                <strong className="t-body">{d.title}</strong>
                <Badge
                  tone={d.quality === "strong" ? "success" : d.quality === "weak" ? "danger" : "neutral"}
                >
                  {d.quality}
                </Badge>
              </div>
              <p className="t-meta" style={{ marginTop: 4 }}>
                {d.domain} · {d.pageType}
              </p>
              <p className="snippet" style={{ marginTop: 8 }}>
                {d.snippet}
              </p>
              <p className="t-small" style={{ marginTop: 8 }}>
                {d.why}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** The proof, and the honest limits of what it proves. */
function ExecutionResult({
  proof,
  plan,
  reused,
  verifying,
  verifyNote,
  onVerify,
}: {
  proof: Proof;
  plan: Plan | null;
  reused: boolean;
  verifying: boolean;
  verifyNote: string | null;
  onVerify: () => void;
}) {
  return (
    <section className="stack-lg animate-in" aria-label="Execution result">
      {reused && (
        <div className="notice notice-info">
          This session already created a campaign, so you are seeing that one again rather than a
          second campaign. One execution per visitor keeps a public button from becoming a campaign
          generator.
        </div>
      )}

      <div className="card card-lg card-accent">
        <div className="spread">
          <h2 className="t-h2">Google Ads campaign created</h2>
          <Badge tone="success">{proof.status ?? "PAUSED"}</Badge>
        </div>
        <p className="t-small" style={{ marginTop: 8, maxWidth: 640 }}>
          These values were read back from Google after creation — not copied from the request we
          sent.
        </p>
        <dl className="kv" style={{ marginTop: 16 }}>
          <div>
            <dt>Campaign ID</dt>
            <dd className="t-mono">{proof.campaignId ?? "—"}</dd>
          </div>
          <div>
            <dt>Campaign name</dt>
            <dd>{proof.campaignName ?? "—"}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{proof.status ?? "—"}</dd>
          </div>
          <div>
            <dt>Channel</dt>
            <dd>
              {proof.channelType ?? "—"}
              {proof.channelSubType ? ` · ${proof.channelSubType}` : ""}
            </dd>
          </div>
          <div>
            <dt>Promoted app</dt>
            <dd className="t-mono break-any">{proof.appId ?? "—"}</dd>
          </div>
          <div>
            <dt>Daily budget sent</dt>
            <dd>{money(proof.dailyBudgetMicros)} / day</dd>
          </div>
          <div>
            <dt>Last confirmed by Google</dt>
            <dd>{clock(proof.lastVerifiedAt)}</dd>
          </div>
        </dl>

        <div className="row-wrap" style={{ marginTop: 20 }}>
          <button className="btn btn-primary" onClick={onVerify} disabled={verifying}>
            {verifying ? (
              <>
                <span className="spinner spinner-dark" aria-hidden="true" /> Asking Google…
              </>
            ) : (
              "Verify with Google again"
            )}
          </button>
          <span className="t-meta">Queries the Google Ads API live — not our database.</span>
        </div>
        {verifyNote && (
          <p className="t-small" style={{ marginTop: 12 }}>
            {verifyNote}
          </p>
        )}
      </div>

      {plan && (
        <div className="card">
          <h3 className="t-h3">Why the agent chose this</h3>
          <ul className="stack" style={{ marginTop: 10, paddingLeft: 18 }}>
            {plan.reasoning.map((r) => (
              <li key={r} className="t-small">
                {r}
              </li>
            ))}
          </ul>
          {plan.clampedByPolicy && (
            <div className="notice notice-warning" style={{ marginTop: 14 }}>
              The approved budget of {money(plan.approvedDailyBudgetMicros)} exceeded the sandbox
              ceiling, so the server reduced it to {money(plan.dailyBudgetMicros)} before building the
              request. The ceiling is server code — nothing sent from a browser can raise it.
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h3 className="t-h3">Execution console</h3>
        <p className="t-small" style={{ marginTop: 6 }}>
          Each line was recorded when it happened, with the time it completed.
        </p>
        <ol className="steps" style={{ marginTop: 14, listStyle: "none" }}>
          {proof.events.map((e) => (
            <li
              key={e.code + e.at}
              className={`step ${e.status === "failed" ? "" : "step-done"}`}
              title={e.detail ?? undefined}
            >
              <span className="step-dot" aria-hidden="true">
                ✓
              </span>
              <span className="spread" style={{ width: "100%", gap: 12 }}>
                <span>{e.label}</span>
                <span className="t-meta t-mono">{clock(e.at)}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>

      <div className="card card-warning">
        <h3 className="t-h3">What this is, and what it is not</h3>
        <div className="stack" style={{ marginTop: 10 }}>
          <p className="t-small">
            <strong>It is:</strong> a real campaign resource, created through the real Google Ads API
            in an isolated test account, confirmed by a fresh read query against Google.
          </p>
          <p className="t-small">
            <strong>It is not:</strong> a serving campaign. It is paused, it has no ad group and no
            app ad assets, so it shows nothing to anyone, spends nothing and acquires no users. A
            Google Ads test account cannot serve advertising at all.
          </p>
          <p className="t-small">
            The customer path uses this same execution engine with the customer&apos;s own Google Ads
            account and their own approval — the credential is the only thing that differs.
          </p>
        </div>
      </div>

      <div className="card card-lg">
        <h3 className="t-h3">Run this on your own app</h3>
        <p className="t-small" style={{ marginTop: 8, maxWidth: 620 }}>
          The demo uses a fixed example app so every visitor sees the same thing. With an account you
          start from your own Google Play link, and discovery runs against live web search.
        </p>
        <div className="row-wrap" style={{ marginTop: 18 }}>
          <Link href="/signup" className="btn btn-primary">
            Create an account
          </Link>
          <Link href="/" className="btn btn-secondary">
            How it works
          </Link>
        </div>
      </div>
    </section>
  );
}
