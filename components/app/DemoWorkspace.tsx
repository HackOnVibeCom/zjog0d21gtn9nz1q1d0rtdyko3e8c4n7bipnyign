"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Badge, Chip } from "@/components/ui/Badge";

/**
 * THE PUBLIC JUDGE FLOW.
 *
 * One page, no account, and every stage tied to a real operation. The rule
 * this component exists to keep is simple: a stage may only show as complete
 * after the server says the work behind it actually finished. Nothing here is
 * timed, and no stage is optimistic — if a step fails the pipeline stops and
 * says so rather than falling back to prepared data.
 */

type Listing = {
  appId: string;
  name: string;
  category?: string;
  developer?: string;
  description?: string;
  storeUrl: string;
  retrievedAt: string;
};

type Channel = { platform: string; priority: string; why: string; angle?: string };
type Analysis = {
  primaryCategory: string;
  audience: string;
  valueProp: string;
  summary: string;
  mainProblem: string;
  recommendedChannels: Channel[];
};

type Source = {
  title: string;
  url: string;
  domain: string;
  snippet?: string;
  position: number;
  sourceQuery: string;
  audienceFit: number;
  audienceSignal: string;
  painPoint: string;
  growthAction: string;
};

type Proposal = {
  appId: string;
  goal: string;
  environment: string;
  campaignType: string;
  channel: string;
  statusPolicy: string;
  maxDailyBudgetMicros: number;
  recommendation: { positioning: string; audience: string; messagingAngle: string };
};

type Run = {
  id: string;
  appId: string;
  stage: string;
  failedAt: string | null;
  listing: Listing | null;
  analysis: Analysis | null;
  discovery: { scored?: Source[] } | null;
  proposal: Proposal | null;
  hasExecution: boolean;
};

type Proof = {
  campaignId: string | null;
  status: string | null;
  channelType: string | null;
  channelSubType: string | null;
  appId: string | null;
  lastVerifiedAt: string | null;
  events: { code: string; label: string; status: string; at: string }[];
};

type Verification = { verifiedAt: string; campaignId: string | null; status: string | null };
type StageState = "pending" | "running" | "complete" | "failed";

/** Each entry is one real server operation. Nothing is here for decoration. */
const PIPELINE = [
  { step: "import-submit", group: "import", running: "Reading Google Play listing…" },
  { step: "import-poll", group: "import", running: "Reading Google Play listing…" },
  { step: "analyze", group: "analyze", running: "Analyzing product and building the plan…" },
  { step: "discover-queries", group: "discover", running: "Generating market research queries…" },
  { step: "discover-submit", group: "discover", running: "Searching the public web…" },
  { step: "discover-poll", group: "discover", running: "Searching the public web…" },
  { step: "discover-score", group: "discover", running: "Analyzing audience signals…" },
  { step: "propose", group: "execute", running: "Preparing campaign proposal…" },
] as const;

/**
 * Four stages, because there are four real operations. Understand and Plan
 * come out of a single model call, so the timeline reports it once — the two
 * results are still presented separately below, where they are two genuinely
 * different product outputs.
 */
const GROUPS = [
  { key: "import", n: "01", title: "App import" },
  { key: "analyze", n: "02", title: "Understand & plan" },
  { key: "discover", n: "03", title: "Discover — market & audience intelligence" },
  { key: "execute", n: "04", title: "Campaign proposal" },
] as const;

const POLL_MS = 4000;
const POLL_DEADLINE_MS = 8 * 60 * 1000;

const money = (micros: number | null | undefined) =>
  micros == null ? "—" : (micros / 1_000_000).toFixed(2);
const clock = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function DemoWorkspace() {
  const [ready, setReady] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [url, setUrl] = useState("");
  const [run, setRun] = useState<Run | null>(null);
  const [busyStep, setBusyStep] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [announcement, setAnnouncement] = useState("");

  const [executing, setExecuting] = useState(false);
  const [proof, setProof] = useState<Proof | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verification, setVerification] = useState<Verification | null>(null);

  const cancelled = useRef(false);

  /** Recover whatever this session already owns. No provider call is made. */
  const load = useCallback(async () => {
    const s = await fetch("/api/demo/session", { method: "POST" }).catch(() => null);
    if (s?.ok) {
      const data = await s.json().catch(() => ({}));
      setConfigured(Boolean(data.configured));
    }
    const r = await fetch("/api/demo/run").catch(() => null);
    if (r?.ok) {
      const data = await r.json().catch(() => ({}));
      if (data.run) setRun(data.run as Run);
    }
    const st = await fetch("/api/demo/status").catch(() => null);
    if (st?.ok) {
      const data = await st.json().catch(() => ({}));
      if (data.executed && data.proof) setProof(data.proof as Proof);
    }
    setReady(true);
  }, []);

  useEffect(() => {
    const active = { current: true };
    (async () => {
      if (!active.current) return;
      await load();
    })();
    return () => {
      active.current = false;
      cancelled.current = true;
    };
  }, [load]);

  /**
   * Drive the pipeline one real operation at a time.
   *
   * A step advances only after the server returns success for it, so the
   * timeline can never get ahead of the work. A provider task that is still
   * queued repeats the same step; anything else stops the run.
   */
  const drive = useCallback(async (startRun: Run) => {
    let current = startRun;
    for (const stage of PIPELINE) {
      if (cancelled.current) return;
      setBusyStep(stage.step);
      setAnnouncement(stage.running);

      const deadline = Date.now() + POLL_DEADLINE_MS;
      for (;;) {
        const res = await fetch("/api/demo/run/advance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: current.id, step: stage.step }),
        }).catch(() => null);

        if (!res) {
          setError("The connection was lost. Reload the page — your run is saved.");
          setBusyStep(null);
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (data.run) {
          current = data.run as Run;
          setRun(current);
        }
        if (!res.ok) {
          setError(
            typeof data.error === "string" ? data.error : "This step could not be completed."
          );
          setAnnouncement("The pipeline stopped.");
          setBusyStep(null);
          return;
        }
        if (data.pending) {
          if (Date.now() > deadline) {
            setError("The provider is still working. Your run is saved — start it again later.");
            setBusyStep(null);
            return;
          }
          await sleep(POLL_MS);
          continue;
        }
        break;
      }
    }
    setBusyStep(null);
    setAnnouncement("Campaign proposal ready for your approval.");
  }, []);

  const start = useCallback(async () => {
    setError("");
    setVerification(null);
    cancelled.current = false;
    setBusyStep("start");
    const res = await fetch("/api/demo/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storeUrl: url }),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res || !res.ok) {
      setError(typeof data.error === "string" ? data.error : "The run could not be started.");
      setBusyStep(null);
      return;
    }
    const fresh = data.run as Run;
    setRun(fresh);
    setAnnouncement("AI Growth Director started.");
    await drive(fresh);
  }, [url, drive]);

  const execute = useCallback(async () => {
    setExecuting(true);
    setError("");
    setAnnouncement("Calling the Google Ads API now.");
    try {
      const res = await fetch("/api/demo/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          market: "US",
          approvedDailyBudgetMicros: run?.proposal?.maxDailyBudgetMicros,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          typeof data.error === "string" ? data.error : "The test execution could not be completed."
        );
        setAnnouncement("The execution did not complete.");
        return;
      }
      setProof(data.proof as Proof);
      setAnnouncement("Google returned a campaign.");
    } catch {
      setError("The connection was lost during execution. Reload — any campaign will be shown.");
    } finally {
      setExecuting(false);
    }
  }, [run]);

  const verify = useCallback(async () => {
    setVerifying(true);
    setError("");
    try {
      const res = await fetch("/api/demo/verify", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.verified) {
        setError(
          typeof data.error === "string" ? data.error : "Google could not confirm this campaign."
        );
        setVerification(null);
        return;
      }
      setVerification({
        verifiedAt: data.verifiedAt,
        campaignId: data.campaignId ?? null,
        status: data.status ?? null,
      });
      setAnnouncement(`Google confirmed the campaign at ${clock(data.verifiedAt)}.`);
    } catch {
      setError("The verification request could not be sent.");
    } finally {
      setVerifying(false);
    }
  }, []);

  // Stage status is derived from what the server persisted, never from a timer.
  const groupState = (key: string): StageState => {
    if (!run) return "pending";
    const failed = run.failedAt;
    if (failed === key || (failed === "understand" && key === "analyze")) return "failed";
    if (failed === "propose" && key === "execute") return "failed";
    const complete: Record<string, boolean> = {
      import: Boolean(run.listing),
      analyze: Boolean(run.analysis),
      discover: Boolean(run.discovery?.scored?.length),
      execute: Boolean(run.proposal),
    };
    if (complete[key]) return "complete";
    const running = PIPELINE.find((p) => p.step === busyStep);
    return running?.group === key ? "running" : "pending";
  };

  const proofForThisRun = Boolean(proof?.appId && run?.appId && proof?.appId === run?.appId);
  // One execution per session. Once it is spent, a later app may be researched
  // but its proposal must not offer an action that would refuse.
  const executionSpent = Boolean(proof) && !proofForThisRun;
  const sources = run?.discovery?.scored ?? [];

  return (
    <main className="page">
      <div className="notice notice-demo" style={{ marginBottom: 20 }}>
        Public demo · real providers · Google Ads TEST environment
      </div>

      <section className="stack">
        <div>
          <h1 className="t-h1">AI Growth Kit — public live demo</h1>
          <p className="t-lead" style={{ marginTop: 10, maxWidth: 660 }}>
            Run the real growth workflow yourself — no account required. Paste any Google Play app
            and the AI Growth Director imports it, understands it, plans acquisition and researches
            the market before asking you to approve one test campaign.
          </p>
        </div>

        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>

        <div className="card card-lg card-accent">
          <label className="field-label" htmlFor="store-url">
            Google Play URL
          </label>
          <input
            id="store-url"
            className="input"
            style={{ marginTop: 6 }}
            placeholder="https://play.google.com/store/apps/details?id=…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={Boolean(busyStep)}
            spellCheck={false}
          />
          <p className="field-hint">
            Any public Google Play app works. The link is validated on the server.
          </p>
          <div className="row-wrap" style={{ marginTop: 16 }}>
            <button
              className={`btn btn-primary btn-lg ${busyStep ? "btn-busy" : ""}`}
              onClick={start}
              disabled={Boolean(busyStep) || !ready || url.trim().length === 0}
            >
              {busyStep && <span className="spinner spinner-dark" aria-hidden="true" />}
              {busyStep ? "Running…" : "Start AI Growth Director"}
            </button>
            <span className="t-meta">
              Import, understand, plan and research run automatically. Nothing is created in Google
              Ads until you approve it.
            </span>
          </div>
          {error && (
            <p className="notice notice-error" role="alert" style={{ marginTop: 16 }}>
              <span aria-hidden="true">⚠</span>
              {error}
            </p>
          )}
        </div>

        {run && (
          <ol className="steps card card-lg" style={{ listStyle: "none" }}>
            {GROUPS.map((g) => {
              const state = groupState(g.key);
              return (
                <li
                  key={g.key}
                  className={`step ${
                    state === "complete" ? "step-done" : state === "running" ? "step-active" : ""
                  }`}
                >
                  <span className="step-dot" aria-hidden="true">
                    {state === "failed" ? "×" : "✓"}
                  </span>
                  <span className="spread" style={{ width: "100%", gap: 12 }}>
                    <span>
                      <span className="t-meta t-mono">{g.n}</span> {g.title}
                    </span>
                    <span className="t-meta">
                      {state === "running"
                        ? PIPELINE.find((p) => p.step === busyStep)?.running
                        : state}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        )}

        {run?.listing && (
          <section className="card card-lg" aria-labelledby="understand">
            <div className="spread">
              <h2 id="understand" className="t-h2">
                02 · What this app is
              </h2>
              <Chip>Retrieved + AI inference</Chip>
            </div>
            <dl className="kv" style={{ marginTop: 16 }}>
              <div>
                <dt className="prov-retrieved">
                  App <span className="prov-label">RETRIEVED</span>
                </dt>
                <dd>
                  {run.listing.name}
                  <span className="t-mono break-any"> · {run.listing.appId}</span>
                </dd>
              </div>
              {run.listing.category && (
                <div>
                  <dt className="prov-retrieved">
                    Category <span className="prov-label">RETRIEVED</span>
                  </dt>
                  <dd>{run.listing.category}</dd>
                </div>
              )}
              {run.analysis && (
                <>
                  <div>
                    <dt className="prov-ai">
                      What it does <span className="prov-label">AI INFERENCE</span>
                    </dt>
                    <dd>{run.analysis.summary}</dd>
                  </div>
                  <div>
                    <dt className="prov-ai">
                      Target audience <span className="prov-label">AI INFERENCE</span>
                    </dt>
                    <dd>{run.analysis.audience}</dd>
                  </div>
                  <div>
                    <dt className="prov-ai">
                      Main problem <span className="prov-label">AI INFERENCE</span>
                    </dt>
                    <dd>{run.analysis.mainProblem}</dd>
                  </div>
                  <div>
                    <dt className="prov-ai">
                      Value proposition <span className="prov-label">AI INFERENCE</span>
                    </dt>
                    <dd>{run.analysis.valueProp}</dd>
                  </div>
                </>
              )}
            </dl>
          </section>
        )}

        {run?.analysis && (
          <section className="card card-lg" aria-labelledby="plan">
            <div className="spread">
              <h2 id="plan" className="t-h2">
                02 · Acquisition plan
              </h2>
              <Chip>AI recommendation</Chip>
            </div>
            <div className="stack" style={{ marginTop: 14 }}>
              {run.analysis.recommendedChannels.slice(0, 4).map((c) => (
                <div key={c.platform} className="prov prov-ai">
                  <div className="row-wrap">
                    <strong className="t-body" style={{ textTransform: "capitalize" }}>
                      {c.platform}
                    </strong>
                    <Badge tone={/high|urgent/i.test(c.priority) ? "success" : "neutral"}>
                      {c.priority}
                    </Badge>
                  </div>
                  <p className="t-small" style={{ marginTop: 4 }}>
                    {c.why}
                  </p>
                </div>
              ))}
            </div>
            <p className="t-meta divide-top" style={{ marginTop: 16 }}>
              The model proposes strategy. Permissions, the TEST-versus-production boundary, budget
              ceilings and provider verification stay in deterministic server code.
            </p>
          </section>
        )}

        {sources.length > 0 && (
          <section className="card card-lg" aria-labelledby="discover">
            <div className="spread">
              <h2 id="discover" className="t-h2">
                03 · Market &amp; audience intelligence
              </h2>
              <Chip>Real web evidence</Chip>
            </div>
            <p className="t-small" style={{ marginTop: 6 }}>
              Research only. AI Growth Kit does not post, comment or message anywhere.
            </p>
            <div className="stack" style={{ marginTop: 16 }}>
              {sources.map((s) => (
                <article key={s.url} className="card card-muted">
                  <div className="spread">
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="t-body"
                      style={{ overflowWrap: "anywhere", fontWeight: 650 }}
                    >
                      {s.title}
                    </a>
                    <span className="score">{s.audienceFit}%</span>
                  </div>
                  <p className="t-meta" style={{ marginTop: 4 }}>
                    {s.domain} · observed via web search · query “{s.sourceQuery}” · result #
                    {s.position} · the page itself was not opened or read
                  </p>
                  {s.snippet && (
                    <p className="snippet" style={{ marginTop: 10 }}>
                      <span className="prov-label" style={{ color: "var(--success)" }}>
                        Evidence — observed search snippet
                      </span>
                      <br />“{s.snippet}”
                    </p>
                  )}
                  {s.audienceSignal && (
                    <div className="prov prov-ai" style={{ marginTop: 10 }}>
                      <span className="prov-label">Audience signal · AI inference</span>
                      <p className="t-small">{s.audienceSignal}</p>
                    </div>
                  )}
                  {s.painPoint && (
                    <div className="prov prov-ai" style={{ marginTop: 10 }}>
                      <span className="prov-label">Pain point · AI inference</span>
                      <p className="t-small">{s.painPoint}</p>
                    </div>
                  )}
                  {s.growthAction && (
                    <div className="divide-top" style={{ marginTop: 12, paddingTop: 10 }}>
                      <span className="prov-label" style={{ color: "var(--accent)" }}>
                        Recommended growth action · AI inference
                      </span>
                      <p className="t-small" style={{ marginTop: 4 }}>
                        {s.growthAction}
                      </p>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}

        {run?.proposal && !proofForThisRun && (
          <section className="card card-lg card-accent" aria-labelledby="proposal">
            <h2 id="proposal" className="t-h2">
              04 · Campaign proposal
            </h2>
            <p className="t-small" style={{ marginTop: 8, maxWidth: 640 }}>
              Nothing has been created in Google Ads yet. This is where automation stops and you
              decide.
            </p>

            <dl className="kv" style={{ marginTop: 16 }}>
              <div>
                <dt>Application</dt>
                <dd className="t-mono break-any">{run.proposal.appId}</dd>
              </div>
              <div>
                <dt>Goal</dt>
                <dd>{run.proposal.goal}</dd>
              </div>
              <div>
                <dt>Environment</dt>
                <dd>{run.proposal.environment}</dd>
              </div>
              <div>
                <dt>Campaign type</dt>
                <dd>
                  {run.proposal.campaignType} · {run.proposal.channel}
                </dd>
              </div>
              <div>
                <dt>Status policy</dt>
                <dd>{run.proposal.statusPolicy}</dd>
              </div>
              <div>
                <dt>Budget ceiling</dt>
                <dd>{money(run.proposal.maxDailyBudgetMicros)} / day, enforced by the server</dd>
              </div>
            </dl>

            <div className="divide-top" style={{ marginTop: 18, paddingTop: 14 }}>
              <span className="prov-label" style={{ color: "var(--accent)" }}>
                AI strategy recommendation — not sent to Google
              </span>
              <dl className="kv" style={{ marginTop: 10 }}>
                <div>
                  <dt>Positioning</dt>
                  <dd>{run.proposal.recommendation.positioning}</dd>
                </div>
                <div>
                  <dt>Audience</dt>
                  <dd>{run.proposal.recommendation.audience}</dd>
                </div>
                <div>
                  <dt>Messaging angle</dt>
                  <dd>{run.proposal.recommendation.messagingAngle}</dd>
                </div>
              </dl>
              <p className="t-meta" style={{ marginTop: 10 }}>
                Google receives the campaign type, the channel, the paused status, the promoted
                package and the clamped budget. The strategy above informs your decision; it is not
                provider configuration.
              </p>
            </div>

            <div className="divide-top" style={{ marginTop: 18, paddingTop: 16 }}>
              {executionSpent ? (
                <p className="notice notice-warning">
                  TEST execution already used in this demo session. This proposal was not sent to
                  Google, and the campaign shown below belongs to the app it was created for.
                </p>
              ) : (
                <>
                  <button
                    className={`btn btn-primary btn-lg btn-block ${executing ? "btn-busy" : ""}`}
                    onClick={execute}
                    disabled={executing || !configured || run.hasExecution}
                  >
                    {executing && <span className="spinner spinner-dark" aria-hidden="true" />}
                    {executing ? "Calling the Google Ads API…" : "Execute TEST campaign"}
                  </button>
                  <p className="t-meta" style={{ marginTop: 10, textAlign: "center" }}>
                    Creates one PAUSED App Campaign in the isolated TEST account. One execution per
                    demo session.
                  </p>
                </>
              )}
            </div>
          </section>
        )}

        {proof && (
          <section className="card card-lg card-accent" aria-labelledby="proof">
            {run && !proofForThisRun && (
              <p className="notice notice-info" style={{ marginBottom: 14 }}>
                Previous TEST execution — created for{" "}
                <span className="t-mono">{proof.appId}</span>, not for the app currently being
                researched. One execution is allowed per demo session.
              </p>
            )}
            <div className="spread">
              <h2 id="proof" className="t-h2">
                Google provider proof
              </h2>
              <Badge tone={proof.status === "PAUSED" ? "success" : "warning"}>
                {proof.status ?? "Status not confirmed"}
              </Badge>
            </div>
            <dl className="kv" style={{ marginTop: 16 }}>
              <div>
                <dt>Provider</dt>
                <dd>Google Ads API</dd>
              </div>
              <div>
                <dt>Campaign ID</dt>
                <dd className="t-mono">{proof.campaignId ?? "—"}</dd>
              </div>
              <div>
                <dt>Campaign type</dt>
                <dd>{proof.channelSubType ?? "—"}</dd>
              </div>
              <div>
                <dt>Advertising channel</dt>
                <dd>{proof.channelType ?? "—"}</dd>
              </div>
              <div>
                <dt>Promoted app</dt>
                <dd className="t-mono break-any">{proof.appId ?? "—"}</dd>
              </div>
              <div>
                <dt>Environment</dt>
                <dd>TEST</dd>
              </div>
              <div>
                <dt>Confirmed at</dt>
                <dd className="t-mono">{clock(proof.lastVerifiedAt)}</dd>
              </div>
            </dl>

            {proof.events.length > 0 && (
              <ol
                className="steps divide-top"
                style={{ marginTop: 18, paddingTop: 14, listStyle: "none" }}
              >
                {proof.events.map((e) => (
                  <li
                    key={e.code + e.at}
                    className={`step ${e.status === "failed" ? "" : "step-done"}`}
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
            )}

            <div className="divide-top" style={{ marginTop: 18, paddingTop: 16 }}>
              <button
                className={`btn btn-primary ${verifying ? "btn-busy" : ""}`}
                onClick={verify}
                disabled={verifying}
              >
                {verifying && <span className="spinner spinner-dark" aria-hidden="true" />}
                {verifying ? "Asking Google…" : "Verify with Google again"}
              </button>
              <p className="t-meta" style={{ marginTop: 10 }}>
                Runs a new read query against the Google Ads API. Our database is not consulted for
                the answer.
              </p>
              {verification && (
                <div className="card card-muted" style={{ marginTop: 14 }}>
                  <div className="spread">
                    <strong className="t-body">Provider verification</strong>
                    <Badge tone={verification.status === "PAUSED" ? "success" : "warning"}>
                      {verification.status ?? "unknown"}
                    </Badge>
                  </div>
                  <p className="t-small" style={{ marginTop: 6 }}>
                    Google Ads API · campaign{" "}
                    <span className="t-mono">{verification.campaignId ?? "—"}</span> · verified just
                    now at {clock(verification.verifiedAt)}
                  </p>
                </div>
              )}
            </div>
          </section>
        )}

        <div className="card card-warning">
          <h3 className="t-h3">TEST environment</h3>
          <p className="t-small" style={{ marginTop: 8 }}>
            This campaign resource is created through the official Google Ads API in Google&apos;s
            isolated TEST environment. TEST campaigns cannot serve ads or spend money. Production
            advertising execution requires Google Ads API Basic Access.
          </p>
        </div>

        <div className="card card-lg">
          <h3 className="t-h3">Run this on your own app</h3>
          <p className="t-small" style={{ marginTop: 8, maxWidth: 620 }}>
            The demo runs the same pipeline the product uses. With an account you keep your
            projects, revisit the research and connect your own Google Ads account.
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
    </main>
  );
}
