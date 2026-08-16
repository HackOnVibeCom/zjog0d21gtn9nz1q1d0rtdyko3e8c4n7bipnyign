"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { AppShell } from "@/components/app/AppShell";
import { Chip } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ProgressSteps, type Step } from "@/components/ui/ProgressSteps";
import { DeleteConfirm, ProjectCard, type ProjectSummary } from "@/components/app/ProjectCard";
import { GoogleAdsCard } from "@/components/app/GoogleAdsCard";

type Metadata = {
  name: string;
  description?: string;
  category?: string;
  developer?: string;
  rating?: number;
  reviewsCount?: number;
  installs?: string;
  storeUrl: string;
  iconUrl?: string;
};
type Analysis = {
  audience: string;
  valueProp: string;
  summary: string;
  mainProblem: string;
  recommendedChannels: unknown[];
};
/** A retrieved-vs-inferred fact, with the provenance stated rather than implied. */
function Field({
  title,
  value,
  prov,
  long,
}: {
  title: string;
  value?: string | number;
  prov: "retrieved" | "ai";
  /** Store descriptions can run thousands of characters — keep them scrollable. */
  long?: boolean;
}) {
  if (value === undefined || value === "" || value === null) return null;
  return (
    <div className={`prov ${prov === "retrieved" ? "prov-retrieved" : "prov-ai"}`}>
      <div className="row-wrap" style={{ gap: 8 }}>
        <span className="t-h3">{title}</span>
        <span className="prov-label">{prov === "retrieved" ? "Retrieved" : "AI inference"}</span>
      </div>
      <div
        className={`t-body ${long ? "scroll-y" : ""}`}
        style={{ color: "var(--text)", marginTop: 2, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
      >
        {value}
      </div>
    </div>
  );
}

function AppIcon({ url, name, small }: { url?: string; name: string; small?: boolean }) {
  const cls = `app-icon ${small ? "app-icon-sm" : ""}`;
  if (url) {
    // Remote store icons come from many CDNs; a plain img keeps this simple.
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={cls} src={url} alt="" width={small ? 36 : 52} height={small ? 36 : 52} />;
  }
  return (
    <span className={`${cls} app-icon-fallback`} aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export default function Workspace() {
  const router = useRouter();
  const { status } = useSession();
  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState<"active" | "history">("active");
  const [pendingId, setPendingId] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<ProjectSummary | null>(null);
  const [listError, setListError] = useState("");

  const [mode, setMode] = useState<"import" | "manual">("import");
  const [url, setUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [stage, setStage] = useState("");
  const [review, setReview] = useState<{ metadata: Metadata; analysis: Analysis } | null>(null);
  const [creating, setCreating] = useState(false);

  const [form, setForm] = useState({ name: "", description: "", storeUrl: "", targetAudience: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/projects");
    const data = res.ok ? await res.json().catch(() => ({})) : {};
    setProjects(Array.isArray(data.projects) ? data.projects : []);
  }, []);

  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/projects");
      const data = res.ok ? await res.json().catch(() => ({})) : {};
      if (!cancelled) setProjects(Array.isArray(data.projects) ? data.projects : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [status]);

  /** Archive / restore. The server owns the rule; we just re-read the list. */
  const patchProject = useCallback(
    async (p: ProjectSummary, action: "archive" | "restore") => {
      setPendingId(p.id);
      setListError("");
      try {
        const res = await fetch(`/api/projects/${p.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        if (!res.ok) throw new Error("Could not update this project.");
        await refresh();
      } catch (e) {
        setListError((e as Error).message);
      } finally {
        setPendingId("");
      }
    },
    [refresh]
  );

  const deleteProject = useCallback(async () => {
    if (!confirmDelete) return;
    setPendingId(confirmDelete.id);
    setListError("");
    try {
      const res = await fetch(`/api/projects/${confirmDelete.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not delete this project.");
      setConfirmDelete(null);
      await refresh();
    } catch (e) {
      setListError((e as Error).message);
    } finally {
      setPendingId("");
    }
  }, [confirmDelete, refresh]);

  const post = async (payload: unknown) => {
    const res = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "We couldn't import this app.");
    return data;
  };

  /**
   * One click = exactly one paid provider lookup. The submit call returns a
   * ticket; polling it is free, so the wait happens here in the browser rather
   * than inside a serverless invocation that would time out.
   */
  async function analyze() {
    if (!url.trim() || importing) return;
    setImporting(true);
    setImportError("");
    setStage("Submitting your Google Play link…");
    try {
      const { ticket } = await post({ url: url.trim() });

      setStage("Reading the Google Play listing…");
      const deadline = Date.now() + 90_000;
      let metadata: Metadata | undefined;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2500));
        const result = await post({ ticket });
        if (result.status === "ready" && result.metadata) {
          metadata = result.metadata as Metadata;
          break;
        }
      }
      if (!metadata) throw new Error("The store lookup is taking too long. Please try again.");

      setStage("Understanding your app…");
      const { analysis } = await post({
        analyze: {
          name: metadata.name,
          description: metadata.description,
          storeUrl: metadata.storeUrl,
        },
      });
      setReview({ metadata, analysis });
    } catch (e) {
      setImportError((e as Error).message);
    } finally {
      setImporting(false);
      setStage("");
    }
  }

  async function continueFromReview() {
    if (!review || creating) return;
    setCreating(true);
    setImportError("");
    const { metadata, analysis } = review;
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: metadata.name,
          description: metadata.description,
          storeUrl: metadata.storeUrl,
          targetAudience: analysis.audience,
          analysis,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.project?.id) {
        router.push(`/projects/${data.project.id}`);
        return;
      }
      setImportError(data.error || "Could not create project");
    } catch (e) {
      setImportError((e as Error).message);
    }
    setCreating(false);
  }

  async function submitManual(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (data.project?.id) router.push(`/projects/${data.project.id}`);
      else {
        setError(data.error || "Something went wrong");
        setSaving(false);
      }
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  if (status !== "authenticated") {
    return (
      <AppShell narrow>
        <div className="stack" aria-busy="true">
          <div className="skeleton" style={{ height: 30, width: 220 }} />
          <div className="skeleton" style={{ height: 160 }} />
        </div>
      </AppShell>
    );
  }

  /* ---------------------------------------------------------------- review */

  if (review) {
    const { metadata: m, analysis: a } = review;
    return (
      <AppShell narrow>
        <div className="animate-in">
          <div className="row" style={{ marginBottom: 20 }}>
            <AppIcon url={m.iconUrl} name={m.name} />
            <div style={{ minWidth: 0 }}>
              <h1 className="t-h1">We understood your app</h1>
              <p className="t-small">Check this over before we build your workspace.</p>
            </div>
          </div>

          <div className="card card-lg">
            <p className="t-small" style={{ marginBottom: 18 }}>
              <span className="prov-label" style={{ color: "var(--success)" }}>
                Retrieved
              </span>{" "}
              comes from the Google Play listing.{" "}
              <span className="prov-label" style={{ color: "var(--accent)" }}>
                AI inference
              </span>{" "}
              is derived by AI and not stated by Google Play.
            </p>

            <div className="stack">
              <Field title="App name" value={m.name} prov="retrieved" />
              <Field title="Category" value={m.category} prov="retrieved" />
              <Field title="Developer" value={m.developer} prov="retrieved" />
              <Field
                title="Rating"
                value={
                  m.rating !== undefined
                    ? `${m.rating}${m.reviewsCount ? ` (${m.reviewsCount.toLocaleString()} reviews)` : ""}`
                    : undefined
                }
                prov="retrieved"
              />
              <Field title="Installs" value={m.installs} prov="retrieved" />
              <Field title="What it does (listing)" value={m.description} prov="retrieved" long />
              <Field title="Summary" value={a.summary} prov="ai" />
              <Field title="Target audience" value={a.audience} prov="ai" />
              <Field title="Main problem" value={a.mainProblem} prov="ai" />
              <Field title="Value proposition" value={a.valueProp} prov="ai" />
            </div>
          </div>

          {importError && (
            <p className="notice notice-error" role="alert" style={{ marginTop: 16 }}>
              <span aria-hidden="true">⚠</span>
              {importError}
            </p>
          )}

          <div className="row" style={{ marginTop: 20 }}>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setImportError("");
                setReview(null);
              }}
              disabled={creating}
            >
              ← Edit
            </button>
            <button
              className={`btn btn-primary ${creating ? "btn-busy" : ""}`}
              onClick={continueFromReview}
              disabled={creating}
            >
              {creating && <span className="spinner" aria-hidden="true" />}
              {creating ? "Creating workspace…" : "Looks good — continue"}
            </button>
          </div>
        </div>
      </AppShell>
    );
  }

  /* ------------------------------------------------------------ add an app */

  const importSteps: Step[] = [
    {
      label: "Submitting your Google Play link",
      state: stage.startsWith("Submitting") ? "active" : "done",
    },
    {
      label: "Reading the Google Play listing",
      state: stage.startsWith("Reading")
        ? "active"
        : stage.startsWith("Understanding")
        ? "done"
        : "todo",
    },
    {
      label: "Understanding your app",
      state: stage.startsWith("Understanding") ? "active" : "todo",
    },
  ];

  const addPanel = (
    <div className="card card-lg animate-in">
      {mode === "import" ? (
        <>
          <h2 className="t-h2">Add your app</h2>
          <p className="t-small" style={{ marginTop: 4, marginBottom: 20 }}>
            Paste your Google Play link — we read the listing and understand your app
            automatically.
          </p>

          <div className="field">
            <label className="field-label" htmlFor="play-url">
              Google Play URL
            </label>
            <input
              id="play-url"
              className="input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://play.google.com/store/apps/details?id=…"
              disabled={importing}
              inputMode="url"
            />
          </div>

          {importError && (
            <p className="notice notice-error" role="alert" style={{ marginBottom: 16 }}>
              <span aria-hidden="true">⚠</span>
              <span>
                {importError}{" "}
                <button
                  className="disclosure-btn"
                  style={{ color: "var(--accent)" }}
                  onClick={() => {
                    setImportError("");
                    setMode("manual");
                  }}
                >
                  Enter details manually
                </button>
              </span>
            </p>
          )}

          <button
            className={`btn btn-primary btn-lg btn-block ${importing ? "btn-busy" : ""}`}
            onClick={analyze}
            disabled={importing || !url.trim()}
          >
            {importing && <span className="spinner" aria-hidden="true" />}
            {importing ? stage || "Working…" : "Analyse app"}
          </button>

          {importing && (
            <div style={{ marginTop: 18 }}>
              <ProgressSteps
                steps={importSteps}
                note="Reading a store listing usually takes a few seconds."
              />
            </div>
          )}

          {!importing && (
            <>
              <div className="divider-or">or</div>
              <button className="btn btn-secondary btn-block" onClick={() => setMode("manual")}>
                Enter app details manually
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <h2 className="t-h2">Enter app details</h2>
          <p className="t-small" style={{ marginTop: 4, marginBottom: 20 }}>
            For unpublished apps or websites — tell us the essentials yourself.
          </p>

          <form onSubmit={submitManual}>
            <div className="field">
              <label className="field-label" htmlFor="m-name">
                App name *
              </label>
              <input
                id="m-name"
                className="input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="MealSnap"
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="m-desc">
                What does it do?
              </label>
              <input
                id="m-desc"
                className="input"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="AI meal planning for busy people"
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="m-url">
                App Store / Google Play / website URL
              </label>
              <input
                id="m-url"
                className="input"
                value={form.storeUrl}
                onChange={(e) => setForm({ ...form, storeUrl: e.target.value })}
                placeholder="https://…"
                inputMode="url"
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="m-aud">
                Target audience
              </label>
              <input
                id="m-aud"
                className="input"
                value={form.targetAudience}
                onChange={(e) => setForm({ ...form, targetAudience: e.target.value })}
                placeholder="busy professionals"
              />
            </div>

            {error && (
              <p className="notice notice-error" role="alert" style={{ marginBottom: 16 }}>
                <span aria-hidden="true">⚠</span>
                {error}
              </p>
            )}

            <button
              type="submit"
              className={`btn btn-primary btn-lg btn-block ${saving ? "btn-busy" : ""}`}
              disabled={saving || !form.name.trim()}
            >
              {saving && <span className="spinner" aria-hidden="true" />}
              {saving ? "Analysing your app…" : "Analyse & continue →"}
            </button>
          </form>

          <div style={{ textAlign: "center", marginTop: 16 }}>
            <button className="disclosure-btn" onClick={() => setMode("import")}>
              ← Use a Google Play link instead
            </button>
          </div>
        </>
      )}
    </div>
  );

  /* ------------------------------------------------------------- dashboard */

  const active = (projects ?? []).filter((p) => p.status !== "history");
  const history = (projects ?? []).filter((p) => p.status === "history");
  const shown = tab === "active" ? active : history;
  const hasProjects = (projects?.length ?? 0) > 0;

  return (
    <AppShell narrow={!hasProjects && !adding}>
      <div className="section-head">
        <div>
          <h1 className="t-h1">Your apps</h1>
          <p className="t-small">
            {projects === null
              ? "Loading your workspace…"
              : hasProjects
              ? "Projects you haven't worked on for 48 hours move to History."
              : "Start by adding the app you want to grow."}
          </p>
        </div>
        {hasProjects && !adding && (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            + Add app
          </button>
        )}
      </div>

      {projects === null && (
        <div className="grid-cards" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card">
              <div className="skeleton" style={{ height: 36, width: 36, borderRadius: 9 }} />
              <div className="skeleton" style={{ height: 16, marginTop: 14 }} />
              <div className="skeleton" style={{ height: 12, width: "60%", marginTop: 8 }} />
            </div>
          ))}
        </div>
      )}

      {hasProjects && (
        <>
          <div className="tabs" role="tablist" aria-label="Project lists" style={{ marginBottom: 18 }}>
            <button
              role="tab"
              className="tab"
              aria-selected={tab === "active"}
              onClick={() => setTab("active")}
            >
              Active <span className="tab-count">{active.length}</span>
            </button>
            <button
              role="tab"
              className="tab"
              aria-selected={tab === "history"}
              onClick={() => setTab("history")}
            >
              History <span className="tab-count">{history.length}</span>
            </button>
          </div>

          {listError && (
            <p className="notice notice-error" role="alert" style={{ marginBottom: 16 }}>
              <span aria-hidden="true">⚠</span>
              {listError}
            </p>
          )}

          {shown.length > 0 ? (
            <div className="grid-cards stagger" style={{ marginBottom: 28 }}>
              {shown.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  busy={pendingId === p.id}
                  onArchive={(x) => patchProject(x, "archive")}
                  onRestore={(x) => patchProject(x, "restore")}
                  onDelete={(x) => setConfirmDelete(x)}
                />
              ))}
            </div>
          ) : (
            <div style={{ marginBottom: 28 }}>
              <EmptyState
                title={tab === "active" ? "Nothing active right now" : "No projects in history yet"}
                description={
                  tab === "active"
                    ? "Everything has moved to History. Open a project or add a new app to get going again."
                    : "Projects appear here once you haven't worked on them for 48 hours, or when you file them away yourself."
                }
                action={
                  tab === "active" ? (
                    <button className="btn btn-primary" onClick={() => setAdding(true)}>
                      + Add app
                    </button>
                  ) : undefined
                }
              />
            </div>
          )}
        </>
      )}

      {projects !== null && !hasProjects && !adding && (
        <div style={{ marginTop: 8 }}>{addPanel}</div>
      )}

      {hasProjects && adding && (
        <div style={{ maxWidth: 620 }}>
          {addPanel}
          <div style={{ textAlign: "center", marginTop: 14 }}>
            <button
              className="disclosure-btn"
              onClick={() => {
                setAdding(false);
                setImportError("");
              }}
            >
              ← Back to your apps
            </button>
          </div>
        </div>
      )}

      {projects !== null && !hasProjects && (
        <p className="t-meta" style={{ textAlign: "center", marginTop: 20 }}>
          <Chip>Works with any published Google Play app</Chip>
        </p>
      )}

      {projects !== null && (
        <div style={{ marginTop: 8 }}>
          <GoogleAdsCard />
        </div>
      )}

      {confirmDelete && (
        <DeleteConfirm
          project={confirmDelete}
          busy={pendingId === confirmDelete.id}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={deleteProject}
        />
      )}
    </AppShell>
  );
}
