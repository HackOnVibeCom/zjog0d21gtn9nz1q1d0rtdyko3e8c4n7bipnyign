"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { AppShell } from "@/components/app/AppShell";
import { Badge, Chip, type BadgeTone } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { ProgressSteps, type Step } from "@/components/ui/ProgressSteps";
import {
  groupCandidates,
  isLowConfidence,
  isResearchOnly,
  showsPrepareAction,
} from "@/lib/discovery/presentation";

type Channel = {
  platform: string;
  priority: string;
  why: string;
  format: string;
  angle: string;
};
type Analysis = {
  primaryCategory: string;
  audience: string;
  valueProp: string;
  summary?: string;
  mainProblem?: string;
  secondaryCategories?: string[];
  recommendedChannels: Channel[];
};
type Project = { id: string; name: string; description?: string; storeUrl?: string };
type Publication = {
  id: string;
  platform: string;
  status: string;
  externalPostUrl?: string | null;
  content: string;
  clicks: number;
  error?: string | null;
};
type Analytics = {
  totalClicks: number;
  clicksByPlatform: Record<string, number>;
  publications: Publication[];
};
type Evidence = {
  sourceQuery: string;
  position: number;
  domain: string;
  rulesRead: false;
  pageType: string;
  actionability: "actionable" | "research_only" | "unknown";
  audienceMatch?: number;
  problemMatch?: number;
  contextMatch?: "strong" | "partial" | "mismatch" | "unknown";
  opportunityQuality?: "strong_opportunity" | "weak_match" | "research_only" | "unknown";
  rejectionReason?: string;
};
type Community = {
  id: string;
  platform?: string;
  name: string;
  url: string;
  description?: string | null;
  memberCount?: number | null;
  audienceFit: number;
  relevanceReason?: string;
  promotionPolicy: string;
  policyEvidence?: string | null;
  suggestedApproach: string;
  generatedContent?: string | null;
  hasTrackingLink?: boolean;
  /** Server's verdict on whether a post may be prepared. Never re-derived here. */
  canPrepare?: boolean;
  evidence?: Evidence | null;
  isDemo?: boolean;
};

// Waiting on the search provider. Measured: a real run's tasks became ready
// between 251s and 381s after submission, so the old 150s budget gave up
// before the first result existed. Polling is free; only submitting costs.
const POLL_START_MS = 3_000;
const POLL_MAX_MS = 15_000;
const POLL_DEADLINE_MS = 8 * 60 * 1000;
/** Must not exceed the server's ticket TTL (6h). */
const RUN_TTL_MS = 6 * 60 * 60 * 1000;
/** Keep in step with SCORE_BATCH_SIZE on the server. */
const SCORE_BATCH = 5;

type SavedRun = { ticket: string; total: number; expiresAt: number };

const PAGE_TYPE_LABELS: Record<string, string> = {
  discussion_thread: "Discussion thread",
  community_group: "Community group",
  forum: "Forum",
  q_and_a: "Q&A",
  social_post: "Social post",
  article: "Article",
  news: "News",
  research: "Research",
  landing_page: "Landing page",
  directory: "Directory",
  other: "Unclassified",
};

function statusTone(s: string): BadgeTone {
  if (s === "published") return "success";
  if (s === "failed") return "danger";
  if (s === "requires_user_action") return "warning";
  return "neutral";
}
function policyTone(p: string): BadgeTone {
  if (p === "allowed") return "success";
  if (p === "restricted" || p === "requires_permission") return "warning";
  if (p === "prohibited") return "danger";
  return "neutral";
}

export default function ProjectDashboard() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [launching, setLaunching] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState("");
  const [providerMsg, setProviderMsg] = useState("");
  const [isDemoData, setIsDemoData] = useState(false);
  const [stage, setStage] = useState("");
  const [preparing, setPreparing] = useState("");
  const [copied, setCopied] = useState("");
  const [resumable, setResumable] = useState(false);
  const [showWeak, setShowWeak] = useState(false);

  // A submitted search is paid for, so its handle outlives this render: a
  // refresh or a closed tab must never force the customer to buy it again.
  const runKey = `agk.discover.run.${id}`;
  const loadRun = useCallback((): SavedRun | null => {
    try {
      const raw = window.localStorage.getItem(runKey);
      if (!raw) return null;
      const saved = JSON.parse(raw) as SavedRun;
      if (!saved?.ticket || Date.now() > saved.expiresAt) {
        window.localStorage.removeItem(runKey);
        return null;
      }
      return saved;
    } catch {
      return null;
    }
  }, [runKey]);
  const saveRun = useCallback(
    (run: SavedRun) => {
      try {
        window.localStorage.setItem(runKey, JSON.stringify(run));
      } catch {
        // Storage being unavailable only costs resumability, not correctness.
      }
    },
    [runKey]
  );
  const clearRun = useCallback(() => {
    try {
      window.localStorage.removeItem(runKey);
    } catch {
      /* ignore */
    }
  }, [runKey]);

  const loadAnalytics = useCallback(async () => {
    const res = await fetch(`/api/projects/${id}/analytics`);
    if (res.ok) setAnalytics(await res.json());
  }, [id]);

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/projects/${id}`);
      if (res.ok) {
        const data = await res.json();
        setProject(data.project);
        setAnalysis(data.analysis);
      }
      const d = await fetch(`/api/projects/${id}/discover`);
      if (d.ok) {
        const dj = await d.json();
        setCommunities(dj.communities ?? []);
        setProviderMsg(dj.message ?? "");
      }
      // A paid search from an earlier visit may still be waiting to be
      // collected — offer it instead of letting the customer pay twice.
      setResumable(Boolean(loadRun()));
      // Opening the workspace is deliberate owner intent, so it keeps the
      // project out of History. A project the owner archived by hand stays
      // archived — the server refuses to unfile it on a mere visit.
      fetch(`/api/projects/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "touch" }),
      }).catch(() => {});
      await loadAnalytics();
    })();
    const t = setInterval(loadAnalytics, 3000); // live click counter
    return () => clearInterval(t);
  }, [id, loadAnalytics, loadRun]);

  async function launch() {
    setLaunching(true);
    await fetch("/api/campaigns/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: id, platforms: ["discord"] }),
    });
    await loadAnalytics();
    setLaunching(false);
  }

  const discoverPost = useCallback(
    async (payload: unknown) => {
      const res = await fetch(`/api/projects/${id}/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Discovery failed");
      return data;
    },
    [id]
  );

  /**
   * Collect an already-submitted (already-paid) run and score it.
   *
   * The provider's standard queue has been measured taking over six minutes,
   * so this waits generously and, if it still is not done, leaves the run
   * saved and resumable rather than discarding paid work.
   */
  const collectRun = useCallback(
    async (ticket: string, total: number) => {
      const deadline = Date.now() + POLL_DEADLINE_MS;
      let wait = POLL_START_MS;
      let found: unknown[] = [];
      let pending = total;

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(Math.round(wait * 1.25), POLL_MAX_MS); // gentle backoff
        const poll = await discoverPost({ step: "search-poll", ticket });
        found = Array.isArray(poll.results) ? poll.results : [];
        pending = Number(poll.pending) || 0;
        const elapsed = Math.round((Date.now() - (deadline - POLL_DEADLINE_MS)) / 1000);
        setStage(`Collecting results (${total - pending}/${total}) · ${elapsed}s`);
        if (pending === 0) break;
      }

      if (pending > 0 && !found.length) {
        // Nothing is lost: the searches are paid for and keep running at the
        // provider. The saved ticket lets the customer collect them for free.
        setResumable(true);
        throw new Error(
          "Your searches are still running at the provider — this can take several minutes. " +
            "Nothing more will be charged: press “Check results” in a moment."
        );
      }

      // Scoring writes several sentences per result, so it goes in small
      // batches — one long AI call would be killed mid-flight.
      const batches: unknown[][] = [];
      for (let i = 0; i < found.length; i += SCORE_BATCH) {
        batches.push(found.slice(i, i + SCORE_BATCH));
      }
      for (let i = 0; i < batches.length; i++) {
        setStage(`Scoring what we found (${i + 1}/${batches.length})`);
        const scored = await discoverPost({
          step: "score",
          results: batches[i],
          replace: i === 0, // the first batch replaces the previous run
        });
        setCommunities(scored.communities ?? []);
      }
      clearRun();
      setResumable(false);
      if (pending > 0) {
        setDiscoverError(`${pending} of ${total} searches were still running — showing the rest.`);
      }
    },
    [discoverPost, clearRun]
  );

  /** Collect a saved run without submitting anything new. Never costs money. */
  async function resumeAudience() {
    const saved = loadRun();
    if (!saved) {
      setResumable(false);
      setDiscoverError("That search is no longer available — start a new one when you're ready.");
      return;
    }
    if (discovering) return;
    setDiscovering(true);
    setDiscoverError("");
    setIsDemoData(false);
    setStage("Checking your searches");
    try {
      await collectRun(saved.ticket, saved.total);
    } catch (e) {
      const message = (e as Error).message;
      // A handle the server will not honour any more is a dead end — drop it
      // rather than leaving a button that can never succeed.
      if (/could not be resumed/i.test(message)) {
        clearRun();
        setResumable(false);
      }
      setDiscoverError(message);
    } finally {
      setDiscovering(false);
      setStage("");
    }
  }

  /**
   * Real web discovery. Each step is a short request so nothing times out:
   * AI writes the queries, one batch of paid searches, then AI scores the
   * real results. Searches only ever run from this explicit click.
   */
  async function findAudience() {
    if (discovering) return;
    // Never buy a second batch while one is still collectable.
    const saved = loadRun();
    if (saved) {
      setResumable(true);
      await resumeAudience();
      return;
    }
    setDiscovering(true);
    setDiscoverError("");
    setIsDemoData(false);
    setStage("Working out where to look");
    try {
      const { queries } = await discoverPost({ step: "queries" });
      const list: string[] = Array.isArray(queries) ? queries : [];
      if (!list.length) throw new Error("Could not work out what to search for.");

      setStage(`Searching the public web (${list.length} searches)`);
      const { ticket } = await discoverPost({ step: "search-submit", queries: list });
      // Remember the paid run before waiting on it, so a refresh, a closed tab
      // or a slow provider never costs the customer a second search.
      saveRun({ ticket, total: list.length, expiresAt: Date.now() + RUN_TTL_MS });

      await collectRun(ticket, list.length);
    } catch (e) {
      setDiscoverError((e as Error).message);
    } finally {
      setDiscovering(false);
      setStage("");
    }
  }

  async function previewDemo() {
    if (discovering) return;
    setDiscovering(true);
    setDiscoverError("");
    try {
      const data = await discoverPost({ demo: true });
      setIsDemoData(true);
      setCommunities(data.communities ?? []);
    } catch (e) {
      setDiscoverError((e as Error).message);
    } finally {
      setDiscovering(false);
    }
  }

  async function prepare(candidateId: string) {
    if (preparing) return;
    setPreparing(candidateId);
    setDiscoverError("");
    try {
      const { candidate } = await discoverPost({ step: "prepare", candidateId });
      setCommunities((prev) => prev.map((c) => (c.id === candidate.id ? candidate : c)));
    } catch (e) {
      setDiscoverError((e as Error).message);
    } finally {
      setPreparing("");
    }
  }

  if (!project) {
    return (
      <AppShell>
        <div className="stack-lg" aria-busy="true">
          <div className="skeleton" style={{ height: 78 }} />
          <div className="skeleton" style={{ height: 190 }} />
          <div className="skeleton" style={{ height: 190 }} />
        </div>
      </AppShell>
    );
  }

  // Places the audience can actually be engaged, versus pages that only prove
  // the audience exists. Unclassified results stay out of the main list.
  const {
    opportunities,
    lowConfidence: weakMatches,
    research,
  } = groupCandidates(communities);

  /** Honest waiting UI: which stage we are in, never a fabricated percentage. */
  const discoverySteps: Step[] = (() => {
    const order = ["Working out", "Searching", "Collecting", "Scoring"];
    const current = order.findIndex((p) => stage.startsWith(p));
    const at = stage.startsWith("Checking") ? 2 : current;
    const labels = [
      "Building a search strategy",
      "Submitting searches to the provider",
      "Collecting real public results",
      "Scoring audience fit",
    ];
    return labels.map((label, i) => ({
      label,
      state: at < 0 ? "todo" : i < at ? "done" : i === at ? "active" : "todo",
    }));
  })();

  const renderCandidate = (c: Community) => {
    const isWeb = c.platform === "web";
    const researchOnly = isResearchOnly(c);
    const weak = isLowConfidence(c);
    const quality = c.evidence?.opportunityQuality;
    // The server decides; the button only reflects that decision.
    const canPrepare = Boolean(c.canPrepare);
    const offersPrepare = showsPrepareAction(c);
    const badge = researchOnly
      ? { text: "Research only", tone: "warning" as BadgeTone }
      : quality === "strong_opportunity"
      ? { text: "Strong audience match", tone: "success" as BadgeTone }
      : quality === "weak_match"
      ? { text: "Low confidence", tone: "warning" as BadgeTone }
      : isWeb
      ? { text: "Not verified", tone: "warning" as BadgeTone }
      : null;

    return (
      <article key={c.id} className={`card ${weak || researchOnly ? "card-muted" : ""}`}>
        <div className="spread" style={{ alignItems: "flex-start" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <a
              href={c.url}
              target="_blank"
              rel="noopener noreferrer"
              className="t-h3"
              style={{ overflowWrap: "anywhere" }}
            >
              {c.platform === "reddit" ? `r/${c.name}` : c.name}
            </a>
            <div className="row-wrap" style={{ marginTop: 8 }}>
              {c.isDemo ? (
                <Badge tone="danger">Demo</Badge>
              ) : (
                badge && <Badge tone={badge.tone}>{badge.text}</Badge>
              )}
              {isWeb && c.evidence && (
                <span className="t-meta">
                  {PAGE_TYPE_LABELS[c.evidence.pageType] ?? "Unclassified"} · {c.evidence.domain}
                </span>
              )}
              {typeof c.memberCount === "number" && (
                <span className="t-meta">
                  {c.memberCount.toLocaleString()} {c.isDemo ? "demo members" : "members"}
                </span>
              )}
              {!isWeb && !c.isDemo && (
                <Badge tone={policyTone(c.promotionPolicy)}>
                  {c.promotionPolicy.replace(/_/g, " ")}
                </Badge>
              )}
            </div>
          </div>
          <div style={{ textAlign: "right", flex: "0 0 auto" }}>
            <div className="score">{c.audienceFit}%</div>
            <div className="meter" style={{ marginTop: 5 }}>
              <div
                className={`meter-fill ${
                  quality === "strong_opportunity"
                    ? "meter-fill--strong"
                    : weak || researchOnly
                    ? "meter-fill--weak"
                    : ""
                }`}
                style={{ width: `${Math.max(2, Math.min(100, c.audienceFit))}%` }}
              />
            </div>
            <div className="t-meta" style={{ marginTop: 4 }}>
              AI relevance
            </div>
          </div>
        </div>

        {c.relevanceReason && (
          <div className="prov prov-ai" style={{ marginTop: 14 }}>
            <span className="prov-label">Why it fits · AI</span>
            <p className="t-small" style={{ color: "var(--text)" }}>
              {c.relevanceReason}
            </p>
          </div>
        )}

        {weak && c.evidence?.rejectionReason && (
          <div className="prov" style={{ marginTop: 12, borderLeftColor: "var(--warning)" }}>
            <span className="prov-label" style={{ color: "var(--warning)" }}>
              Why we didn&apos;t recommend it · AI
            </span>
            <p className="t-small">{c.evidence.rejectionReason}</p>
          </div>
        )}

        {isWeb && c.description && (
          <p className="snippet" style={{ marginTop: 12 }}>
            <span className="prov-label" style={{ color: "var(--success)" }}>
              Evidence — search snippet
            </span>
            <br />“{c.description}”
          </p>
        )}

        {isWeb && c.evidence && (
          <p className="t-meta" style={{ marginTop: 10 }}>
            Retrieved via web search · query “{c.evidence.sourceQuery}” · Google result #
            {c.evidence.position} ·{" "}
            {researchOnly
              ? "Research evidence — not a direct posting opportunity."
              : "Potential audience location — posting rules not verified."}
          </p>
        )}

        {canPrepare && (
          <p className="t-meta" style={{ marginTop: 8 }}>
            Suggested approach (AI): {c.suggestedApproach.replace(/_/g, " ")}
          </p>
        )}

        {!c.isDemo && (
          <div className="row-wrap divide-top" style={{ marginTop: 14, paddingTop: 12 }}>
            <a
              href={c.url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary btn-sm"
            >
              {researchOnly ? "Open source ↗" : "Open community ↗"}
            </a>
            {!canPrepare && !c.generatedContent && (
              <span className="t-meta">
                {researchOnly
                  ? "Use as research evidence — no post is prepared for articles."
                  : quality === "weak_match"
                  ? "Not recommended for outreach — the people here don't look like your users."
                  : "Not recommended — we couldn't confirm this is your audience."}
              </span>
            )}
            {offersPrepare && (
              <button
                className={`btn btn-primary btn-sm ${preparing === c.id ? "btn-busy" : ""}`}
                onClick={() => prepare(c.id)}
                disabled={Boolean(preparing)}
              >
                {preparing === c.id && <span className="spinner" aria-hidden="true" />}
                {preparing === c.id ? "Preparing…" : "Prepare post + tracking link"}
              </button>
            )}
            {/* A draft that already exists stays copyable whatever the gate says. */}
            {c.generatedContent && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  navigator.clipboard?.writeText(c.generatedContent ?? "");
                  setCopied(c.id);
                }}
              >
                {copied === c.id ? "Copied ✓" : "Copy suggested post"}
              </button>
            )}
          </div>
        )}

        {c.generatedContent && !researchOnly && (
          <div style={{ marginTop: 12 }}>
            <span className="prov-label" style={{ color: "var(--accent)" }}>
              Suggested post · AI draft
            </span>
            <div className="draft" style={{ marginTop: 6 }}>
              {c.generatedContent}
            </div>
          </div>
        )}
      </article>
    );
  };

  const totalClicks = analytics?.totalClicks ?? 0;

  return (
    <AppShell
      context={
        <span className="t-small truncate" style={{ fontWeight: 650, color: "var(--text)" }}>
          {project.name}
        </span>
      }
    >
      {/* ---------------------------------------------------- project header */}
      <header className="card card-lg animate-in" style={{ marginBottom: 24 }}>
        <div className="spread" style={{ alignItems: "flex-start" }}>
          <div className="row" style={{ alignItems: "flex-start", minWidth: 0 }}>
            <span className="app-icon app-icon-fallback" aria-hidden="true">
              {project.name.slice(0, 1).toUpperCase()}
            </span>
            <div style={{ minWidth: 0 }}>
              <h1 className="t-h1 break-any">{project.name}</h1>
              <div className="row-wrap" style={{ marginTop: 8 }}>
                {analysis?.primaryCategory && <Chip>{analysis.primaryCategory}</Chip>}
                {analysis?.secondaryCategories?.slice(0, 2).map((c) => <Chip key={c}>{c}</Chip>)}
                {project.storeUrl && (
                  <a
                    href={project.storeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="t-meta"
                    style={{ color: "var(--accent)" }}
                  >
                    View listing ↗
                  </a>
                )}
              </div>
            </div>
          </div>
          <div style={{ textAlign: "right", flex: "0 0 auto" }}>
            <div className="t-metric">
              <AnimatedNumber value={totalClicks} />
            </div>
            <div className="t-meta">tracked clicks</div>
          </div>
        </div>
      </header>

      {/* ------------------------------------------------------- UNDERSTAND */}
      <section aria-labelledby="understand" className="card card-lg" style={{ marginBottom: 20 }}>
        <div className="section-head">
          <div>
            <span className="t-label">Step 1 · Understand</span>
            <h2 id="understand" className="t-h2">
              What this product is
            </h2>
          </div>
          <Badge tone="accent">AI inference</Badge>
        </div>
        {analysis ? (
          <dl className="kv">
            {analysis.summary && (
              <>
                <dt>Summary</dt>
                <dd>{analysis.summary}</dd>
              </>
            )}
            {analysis.mainProblem && (
              <>
                <dt>Main problem</dt>
                <dd>{analysis.mainProblem}</dd>
              </>
            )}
            <dt>Target audience</dt>
            <dd>{analysis.audience || "—"}</dd>
            <dt>Value proposition</dt>
            <dd>{analysis.valueProp || "—"}</dd>
          </dl>
        ) : (
          <EmptyState
            title="No analysis yet"
            description="This project was created without an AI analysis."
          />
        )}
      </section>

      {/* ---------------------------------------------------------- PROMOTE */}
      <section aria-labelledby="promote" className="card card-lg" style={{ marginBottom: 20 }}>
        <div className="section-head">
          <div>
            <span className="t-label">Step 2 · Promote</span>
            <h2 id="promote" className="t-h2">
              Where to start
            </h2>
          </div>
        </div>
        {analysis?.recommendedChannels?.length ? (
          <div className="stack stagger">
            {analysis.recommendedChannels.map((c) => (
              <div key={c.platform} className="card card-muted">
                <div className="row-wrap">
                  <span className="t-h3" style={{ textTransform: "capitalize" }}>
                    {c.platform}
                  </span>
                  <Badge tone={c.priority === "high" ? "success" : "neutral"}>{c.priority}</Badge>
                  {c.format && <span className="t-meta">{c.format}</span>}
                </div>
                {c.angle && (
                  <p className="t-small" style={{ marginTop: 8 }}>
                    {c.angle}
                  </p>
                )}
                {c.why && (
                  <p className="t-meta" style={{ marginTop: 6 }}>
                    {c.why}
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No channel recommendations yet" />
        )}

        <div className="divide-top">
          <div className="spread">
            <div>
              <h3 className="t-h3">Owned channel</h3>
              <p className="t-meta">Posts to your own connected Discord — not audience discovery.</p>
            </div>
            <button
              className={`btn btn-secondary ${launching ? "btn-busy" : ""}`}
              onClick={launch}
              disabled={launching}
            >
              {launching && <span className="spinner spinner-dark" aria-hidden="true" />}
              {launching ? "Publishing…" : "Publish to Discord"}
            </button>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- DISCOVER */}
      <section aria-labelledby="discover" className="card card-lg" style={{ marginBottom: 20 }}>
        <div className="section-head">
          <div>
            <span className="t-label">Step 3 · Discover</span>
            <h2 id="discover" className="t-h2">
              Where your audience already gathers
            </h2>
            <p className="t-small" style={{ marginTop: 4, maxWidth: 660 }}>
              {isDemoData
                ? "Fictional sample communities for demonstrating the discovery workflow — nothing below was retrieved from a real source."
                : "Searches the public web for discussions by the people who have your problem — judged on who is actually talking, not on matching words. Nothing is posted anywhere."}
            </p>
          </div>
        </div>

        <div className="row-wrap" style={{ marginTop: 4 }}>
          {resumable ? (
            <button
              className={`btn btn-primary ${discovering ? "btn-busy" : ""}`}
              onClick={resumeAudience}
              disabled={discovering}
            >
              {discovering && <span className="spinner" aria-hidden="true" />}
              {discovering ? stage || "Checking…" : "Check results (already paid for)"}
            </button>
          ) : (
            <button
              className={`btn btn-primary ${discovering ? "btn-busy" : ""}`}
              onClick={findAudience}
              disabled={discovering}
            >
              {discovering && <span className="spinner" aria-hidden="true" />}
              {discovering && !isDemoData ? stage || "Working…" : "Find my audience"}
            </button>
          )}
          <button className="btn btn-secondary" onClick={previewDemo} disabled={discovering}>
            Preview with demo data
          </button>
        </div>

        {resumable && !discovering && (
          <p className="notice notice-info" style={{ marginTop: 14 }}>
            <span aria-hidden="true">↻</span>
            <span>
              A search you already paid for is waiting to be collected — checking costs nothing, no
              additional search charge.{" "}
              <button
                className="disclosure-btn"
                style={{ color: "inherit", textDecoration: "underline" }}
                onClick={() => {
                  clearRun();
                  setResumable(false);
                  setDiscoverError("");
                }}
              >
                Discard it and start a new search
              </button>
            </span>
          </p>
        )}

        {discovering && !isDemoData && (
          <div style={{ marginTop: 16 }}>
            <ProgressSteps
              steps={discoverySteps}
              note="Real searches run in the provider's queue and can take several minutes. Waiting costs nothing — only starting a search does."
            />
          </div>
        )}

        {discoverError && (
          <p className="notice notice-error" role="alert" style={{ marginTop: 14 }}>
            <span aria-hidden="true">⚠</span>
            {discoverError}
          </p>
        )}

        {isDemoData && (
          <p className="notice notice-demo" style={{ marginTop: 14 }}>
            Demo / test data — fictional, not retrieved from anywhere
          </p>
        )}

        {!isDemoData && communities.length > 0 && (
          <p className="t-meta" style={{ marginTop: 16 }}>
            {opportunities.length} audience {opportunities.length === 1 ? "opportunity" : "opportunities"}
            {weakMatches.length > 0 && ` · ${weakMatches.length} not recommended`}
            {research.length > 0 && ` · ${research.length} research`}
          </p>
        )}

        {!isDemoData && communities.length === 0 && !discovering && (
          <div style={{ marginTop: 16 }}>
            <EmptyState
              icon="🔎"
              title="No searches run yet"
              description="Press “Find my audience” to search the public web for discussions by people with your problem."
            />
          </div>
        )}

        {!isDemoData && opportunities.length === 0 && communities.length > 0 && (
          <p className="notice notice-warning" style={{ marginTop: 14 }}>
            <span aria-hidden="true">•</span>
            No discussions with your actual audience came out of this search. What we did find is
            below — pages about a similar topic but a different crowd, plus research evidence that
            can sharpen the next search.
          </p>
        )}

        {opportunities.length > 0 && (
          <div style={{ marginTop: 20 }}>
            {!isDemoData && (
              <h3 className="t-label" style={{ color: "var(--success)", marginBottom: 10 }}>
                Audience opportunities
              </h3>
            )}
            <div className="stack stagger">{opportunities.map(renderCandidate)}</div>
          </div>
        )}

        {weakMatches.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <button
              className={`disclosure-btn ${showWeak ? "disclosure-open" : ""}`}
              onClick={() => setShowWeak((v) => !v)}
              aria-expanded={showWeak}
            >
              <span className="disclosure-caret" aria-hidden="true">
                ▸
              </span>
              Low-confidence matches ({weakMatches.length})
            </button>
            <p className="t-meta" style={{ marginTop: 4 }}>
              Real discussions we are not recommending — either the people in them don&apos;t look
              like your audience, or we couldn&apos;t confirm that they do. No posts are prepared
              for these.
            </p>
            {showWeak && (
              <div className="stack" style={{ marginTop: 12 }}>
                {weakMatches.map(renderCandidate)}
              </div>
            )}
          </div>
        )}

        {research.length > 0 && (
          <div style={{ marginTop: 24 }}>
            <h3 className="t-label" style={{ color: "var(--warning)" }}>
              Research evidence
            </h3>
            <p className="t-meta" style={{ marginTop: 4, marginBottom: 12 }}>
              Useful for understanding the market and sharpening your wording — not places to post.
            </p>
            <div className="stack">{research.map(renderCandidate)}</div>
          </div>
        )}

        {providerMsg && (
          <p className="t-meta divide-top" style={{ marginTop: 20 }}>
            Reddit provider: {providerMsg}
          </p>
        )}
      </section>

      {/* ---------------------------------------------------------- MEASURE */}
      <section aria-labelledby="measure" className="card card-lg">
        <div className="section-head">
          <div>
            <span className="t-label">Step 4 · Measure</span>
            <h2 id="measure" className="t-h2">
              Results
            </h2>
            <p className="t-small">Every prepared link is counted here as people click it.</p>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="t-metric">
              <AnimatedNumber value={totalClicks} />
            </div>
            <div className="t-meta">total tracked clicks</div>
          </div>
        </div>

        {analytics && Object.keys(analytics.clicksByPlatform).length > 0 && (
          <div className="row-wrap" style={{ marginBottom: 16 }}>
            {Object.entries(analytics.clicksByPlatform).map(([platform, clicks]) => (
              <Chip key={platform}>
                <span className="break-any">{platform}</span>
                <b style={{ marginLeft: 6 }}>{clicks}</b>
              </Chip>
            ))}
          </div>
        )}

        {analytics?.publications.length ? (
          <div className="stack">
            {analytics.publications.map((p) => (
              <div key={p.id} className="card card-muted">
                <div className="spread">
                  <div className="row-wrap">
                    <span className="t-h3" style={{ textTransform: "capitalize" }}>
                      {p.platform}
                    </span>
                    <Badge tone={statusTone(p.status)}>{p.status.replace(/_/g, " ")}</Badge>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <b style={{ fontSize: 18, fontVariantNumeric: "tabular-nums" }}>
                      <AnimatedNumber value={p.clicks} />
                    </b>
                    <div className="t-meta">clicks</div>
                  </div>
                </div>
                {p.content && (
                  <p className="t-small" style={{ marginTop: 8 }}>
                    {p.content}
                  </p>
                )}
                {p.externalPostUrl && (
                  <a
                    href={p.externalPostUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="t-small"
                    style={{ color: "var(--accent)", display: "inline-block", marginTop: 8 }}
                  >
                    View live post ↗
                  </a>
                )}
                {p.error && (
                  <p className="notice notice-error" style={{ marginTop: 8 }}>
                    {p.error}
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon="📈"
            title="No tracked links yet"
            description="Prepare a post for an audience opportunity, or publish to your Discord — each one gets its own link, and clicks appear here."
          />
        )}
      </section>
    </AppShell>
  );
}
