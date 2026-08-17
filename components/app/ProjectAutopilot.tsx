"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { BUDGET_CHOICES, MARKETS } from "@/lib/demo/workspace";

/**
 * GROWTH AUTOPILOT for a signed-in project.
 *
 * Turns the analysis of the app the customer added into a proposed Google Ads
 * campaign, and — once they approve a budget — creates it for real in the
 * isolated TEST advertiser. The copy carries a duty: a paused campaign with no
 * ad group and no creatives advertises nothing, so nothing here may suggest it
 * serves, spends or reaches anyone. What it may claim is the true part: a real
 * campaign resource exists, and Google will confirm it on demand.
 */

type Proof = {
  campaignId: string | null;
  campaignName: string | null;
  status: string | null;
  channelType: string | null;
  channelSubType: string | null;
  appId: string | null;
  dailyBudgetMicros: number | null;
  lastVerifiedAt: string | null;
  events: { code: string; label: string; detail?: string; status: string; at: string }[];
};

type Plan = {
  marketLabel: string;
  reasoning: string[];
  dailyBudgetMicros: number;
  approvedDailyBudgetMicros: number;
  clampedByPolicy: boolean;
};

type Verification = {
  verifiedAt: string;
  campaignId: string | null;
  campaignName: string | null;
  status: string | null;
  channelType: string | null;
  channelSubType: string | null;
};

const PLANNED = [
  "Confirm with Google that the target really is a TEST account",
  "Clamp the approved daily budget to the server ceiling",
  "Create a campaign budget",
  "Create an App Campaign for this app — PAUSED",
  "Read the campaign back from Google to prove it exists",
];

const money = (micros: number | null) => (micros == null ? "—" : (micros / 1_000_000).toFixed(2));

/**
 * How to show a status Google reported.
 *
 * The server always *requests* PAUSED, but a requested value is not a result:
 * showing PAUSED when Google returned nothing would be inventing the very fact
 * the page exists to prove. Only a confirmed PAUSED earns the success tone.
 */
function statusDisplay(status: string | null): { label: string; tone: "success" | "warning" | "neutral" } {
  if (status === "PAUSED") return { label: "PAUSED", tone: "success" };
  if (!status) return { label: "Status not confirmed", tone: "neutral" };
  return { label: status, tone: "warning" };
}

const clock = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

export function ProjectAutopilot({ projectId, appName }: { projectId: string; appName: string }) {
  const [loaded, setLoaded] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [appId, setAppId] = useState<string | null>(null);
  const [market, setMarket] = useState<string>(MARKETS[0].code);
  const [budget, setBudget] = useState<number>(BUDGET_CHOICES[1].micros);
  const [running, setRunning] = useState(false);
  const [proof, setProof] = useState<Proof | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [reused, setReused] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const base = `/api/projects/${projectId}/google-ads`;

  // What this project already owns. Reads our records only — no Google call on
  // a page load, and a refresh never invites a second campaign.
  const loadStatus = useCallback(async () => {
    setLoadError(false);
    const res = await fetch(base).catch(() => null);
    if (!res || !res.ok) {
      setLoadError(true);
      setAnnouncement("The Google Ads status for this project could not be loaded.");
      return;
    }
    const data = await res.json().catch(() => null);
    if (!data) {
      setLoadError(true);
      setAnnouncement("The Google Ads status for this project could not be loaded.");
      return;
    }
    setConfigured(Boolean(data.configured));
    setAppId(typeof data.appId === "string" ? data.appId : null);
    if (data.executed && data.proof) {
      setProof(data.proof as Proof);
      setReused(true);
    }
    setLoaded(true);
  }, [base]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await loadStatus();
    })();
    return () => {
      cancelled = true;
    };
  }, [loadStatus]);

  const execute = useCallback(async () => {
    setRunning(true);
    setError("");
    setErrorCode("");
    setAnnouncement("Calling the Google Ads API now.");
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Only what the customer is allowed to decide. The advertising account,
        // the ceiling, the paused status and the promoted app are the server's.
        body: JSON.stringify({ market, approvedDailyBudgetMicros: budget }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message =
          typeof data.error === "string" ? data.error : "The test execution could not be completed.";
        setError(message);
        setErrorCode(typeof data.code === "string" ? data.code : "");
        setAnnouncement(`The execution did not complete. ${message}`);
        return;
      }
      setReused(Boolean(data.reused));
      setPlan((data.plan as Plan) ?? null);
      setProof(data.proof as Proof);
      setAnnouncement("Google returned a campaign. The confirmed values are now shown below.");
    } catch {
      const message =
        "The connection was lost while the execution was running. Reload the page — if a campaign was created, it will be shown.";
      setError(message);
      setAnnouncement(message);
    } finally {
      setRunning(false);
    }
  }, [base, market, budget]);

  const verify = useCallback(async () => {
    setVerifying(true);
    setError("");
    try {
      const res = await fetch(`${base}/verify`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.verified) {
        const message =
          typeof data.error === "string" ? data.error : "Google could not confirm this campaign right now.";
        setError(message);
        setAnnouncement(`Verification failed. ${message}`);
        return;
      }
      setVerification({
        verifiedAt: data.verifiedAt,
        campaignId: data.campaignId ?? null,
        campaignName: data.campaignName ?? null,
        status: data.status ?? null,
        channelType: data.channelType ?? null,
        channelSubType: data.channelSubType ?? null,
      });
      setAnnouncement(`Google confirmed the campaign again at ${clock(data.verifiedAt)}.`);
    } catch {
      const message = "The verification request could not be sent.";
      setError(message);
      setAnnouncement(message);
    } finally {
      setVerifying(false);
    }
  }, [base]);

  return (
    <article className="card card-accent" style={{ marginTop: 20 }} aria-labelledby="autopilot">
      <span className="t-label">Live Google Ads demo</span>
      <h3 id="autopilot" className="t-h3" style={{ marginTop: 4 }}>
        Launch a test campaign with Growth Autopilot
      </h3>
      <p className="t-small" style={{ marginTop: 8, maxWidth: 660 }}>
        Growth Autopilot turns the analysis of <strong>{appName}</strong> into a proposed Google Ads
        App Campaign. You approve the market and the budget; the server does the rest and then proves
        the result by asking Google.
      </p>

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      <dl className="kv" style={{ marginTop: 16 }}>
        <div>
          <dt>App this proposal is for</dt>
          <dd>
            {appName}
            {appId && <span className="t-mono break-any"> · {appId}</span>}
          </dd>
        </div>
        <div>
          <dt>Proposed action</dt>
          <dd>Create one Google Ads App Campaign, paused, in an isolated test account</dd>
        </div>
      </dl>

      {loadError && (
        <p className="notice notice-error" role="alert" style={{ marginTop: 16 }}>
          <span className="stack">
            <span>
              The Google Ads status for this project could not be loaded, so the execution button is
              unavailable until it is known.
            </span>
            <span>
              <button className="btn btn-secondary btn-sm" onClick={loadStatus}>
                Try loading it again
              </button>
            </span>
          </span>
        </p>
      )}

      {loaded && !appId && (
        <p className="notice notice-warning" style={{ marginTop: 16 }}>
          This project has no Google Play link, so there is no app to promote here.
        </p>
      )}
      {loaded && !configured && (
        <p className="notice notice-warning" style={{ marginTop: 16 }}>
          The Google Ads test sandbox is not configured on this deployment, so the execution button is
          unavailable.
        </p>
      )}
      {error && (
        <p
          className={`notice ${errorCode === "unconfirmed_outcome" ? "notice-warning" : "notice-error"}`}
          role="alert"
          style={{ marginTop: 16 }}
        >
          <span aria-hidden="true">⚠</span>
          <span className="stack">
            <span>{error}</span>
            {errorCode === "unconfirmed_outcome" && (
              <span className="t-meta">
                Press the button again in a few minutes: the server will ask Google whether that
                attempt created a campaign, and will show you that campaign instead of making a new
                one.
              </span>
            )}
          </span>
        </p>
      )}

      {!proof && (
        <div className="stack-lg" style={{ marginTop: 20 }}>
          <div className="field">
            <label className="field-label" htmlFor="ga-market">
              Target market
            </label>
            <select
              id="ga-market"
              className="input"
              value={market}
              onChange={(e) => setMarket(e.target.value)}
              disabled={running}
            >
              {MARKETS.map((m) => (
                <option key={m.code} value={m.code}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <span className="field-label" id="ga-budget-label">
              Daily budget you approve
            </span>
            <div className="row-wrap" style={{ marginTop: 4 }} role="group" aria-labelledby="ga-budget-label">
              {BUDGET_CHOICES.map((b) => (
                <button
                  key={b.micros}
                  type="button"
                  className={`btn ${budget === b.micros ? "btn-primary" : "btn-secondary"}`}
                  onClick={() => setBudget(b.micros)}
                  disabled={running}
                  aria-pressed={budget === b.micros}
                >
                  {b.label}
                </button>
              ))}
            </div>
            <p className="field-hint">
              A test account is never charged. Your choice is a request — the server clamps it to its
              own ceiling before building anything.
            </p>
          </div>

          <div className="card card-muted">
            <h4 className="t-label">What the server will attempt</h4>
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
              className={`btn btn-primary btn-lg btn-block ${running ? "btn-busy" : ""}`}
              onClick={execute}
              disabled={running || !configured || !appId || !loaded}
            >
              {running && <span className="spinner spinner-dark" aria-hidden="true" />}
              {running ? "Calling the Google Ads API…" : "Run live Google Ads test"}
            </button>
            <p className="t-meta" style={{ marginTop: 10, textAlign: "center" }}>
              What happens: one PAUSED App Campaign is created for this app in the test account. No
              ads are served, nothing is published and no money is spent.
            </p>
          </div>

          {running && (
            <div className="card card-muted" role="status" aria-live="polite">
              <div className="row">
                <span className="spinner" aria-hidden="true" />
                <span className="t-small">
                  Waiting for Google. Nothing is shown as done until Google has answered — each step
                  below will carry the time it completed.
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {proof && (
        <div className="animate-in" style={{ marginTop: 20 }}>
          {reused && (
            <p className="notice notice-info" style={{ marginBottom: 16 }}>
              This project already has its test campaign, so you are seeing that one again rather than
              a second campaign.
            </p>
          )}

          <div className="divide-top" style={{ paddingTop: 18 }}>
            <div className="spread">
              <h4 className="t-h3">Confirmed by Google</h4>
              <Badge tone={statusDisplay(proof.status).tone}>{statusDisplay(proof.status).label}</Badge>
            </div>
            <p className="t-small" style={{ marginTop: 8, color: "var(--text-secondary)" }}>
              What changed: Google returned a real campaign resource for {appName}. Every value below
              was read back from Google after creation — none of it is copied from the request we sent.
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
                <dd>{proof.status ?? "Not confirmed by Google"}</dd>
              </div>
              <div>
                <dt>Advertising channel</dt>
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
                <dd>
                  {money(proof.dailyBudgetMicros)} / day
                  {plan?.clampedByPolicy && " · reduced by the server ceiling"}
                </dd>
              </div>
              <div>
                <dt>Confirmed at</dt>
                <dd className="t-mono">{clock(proof.lastVerifiedAt)}</dd>
              </div>
            </dl>

            {plan && plan.reasoning.length > 0 && (
              <details style={{ marginTop: 16 }}>
                <summary className="t-label" style={{ cursor: "pointer" }}>
                  Why Growth Autopilot proposed this
                </summary>
                <ul className="stack" style={{ marginTop: 10, paddingLeft: 18 }}>
                  {plan.reasoning.map((r) => (
                    <li key={r} className="t-small">
                      {r}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {proof.events.length > 0 && (
              <ol className="steps" style={{ marginTop: 18, listStyle: "none" }}>
                {proof.events.map((e) => (
                  <li key={e.code + e.at} className={`step ${e.status === "failed" ? "" : "step-done"}`}>
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
          </div>

          <div className="divide-top" style={{ marginTop: 20, paddingTop: 18 }}>
            <button
              className={`btn btn-primary ${verifying ? "btn-busy" : ""}`}
              onClick={verify}
              disabled={verifying}
            >
              {verifying && <span className="spinner spinner-dark" aria-hidden="true" />}
              {verifying ? "Asking Google…" : "Verify with Google again"}
            </button>
            <p className="t-meta" style={{ marginTop: 10 }}>
              What happens: a brand-new read query runs against the Google Ads API right now. Our
              database is not consulted for the answer.
            </p>
          </div>

          {verification && (
            <div className="card card-muted animate-in" style={{ marginTop: 16 }}>
              <div className="spread">
                <h4 className="t-h3">Google answered again</h4>
                <Badge tone={statusDisplay(verification.status).tone}>
                  {statusDisplay(verification.status).label} · {clock(verification.verifiedAt)}
                </Badge>
              </div>
              <p className="t-small" style={{ marginTop: 8, color: "var(--text-secondary)" }}>
                What changed: a second, independent read query ran just now. This is Google&apos;s
                answer at that moment, not a value we had stored.
              </p>
              <dl className="kv" style={{ marginTop: 14 }}>
                <div>
                  <dt>Verified at</dt>
                  <dd className="t-mono">{clock(verification.verifiedAt)}</dd>
                </div>
                <div>
                  <dt>Campaign ID</dt>
                  <dd className="t-mono">{verification.campaignId ?? "—"}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{verification.status ?? "—"}</dd>
                </div>
                <div>
                  <dt>Advertising channel</dt>
                  <dd>
                    {verification.channelType ?? "—"}
                    {verification.channelSubType ? ` · ${verification.channelSubType}` : ""}
                  </dd>
                </div>
              </dl>
            </div>
          )}

          <p className="t-small" style={{ marginTop: 18 }}>
            <strong>What this is:</strong> a real campaign resource created through the Google Ads API
            in an isolated test account, confirmed by a fresh read query.{" "}
            <strong>What it is not:</strong> a serving campaign — it is paused, it has no ad group and
            no app ad assets, so it shows nothing to anyone, spends nothing and acquires no users.
          </p>
        </div>
      )}
    </article>
  );
}
