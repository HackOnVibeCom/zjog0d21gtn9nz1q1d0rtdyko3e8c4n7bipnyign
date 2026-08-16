"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/Badge";

export type ProjectSummary = {
  id: string;
  name: string;
  description?: string | null;
  storeUrl?: string | null;
  createdAt?: string;
  lastActivityAt?: string;
  archivedAt?: string | null;
  status?: "active" | "history";
  historyReason?: "archived" | "inactive" | null;
  analysis?: { primaryCategory?: string | null; audience?: string | null } | null;
};

function AppIcon({ name }: { name: string }) {
  return (
    <span className="app-icon app-icon-sm app-icon-fallback" aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function relative(iso?: string): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

/**
 * A project in the dashboard list.
 *
 * The card is a link, so its menu lives outside that link and stops the click
 * from bubbling — pressing ••• must never navigate into the project.
 */
export function ProjectCard({
  project,
  onArchive,
  onRestore,
  onDelete,
  busy,
}: {
  project: ProjectSummary;
  onArchive: (p: ProjectSummary) => void;
  onRestore: (p: ProjectSummary) => void;
  onDelete: (p: ProjectSummary) => void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const inHistory = project.status === "history";

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") setOpen(false);
        return;
      }
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const act = (fn: (p: ProjectSummary) => void) => () => {
    setOpen(false);
    fn(project);
  };

  return (
    <div className="card card-interactive" style={{ position: "relative", opacity: busy ? 0.6 : 1 }}>
      <div className="spread" style={{ alignItems: "flex-start" }}>
        <Link
          href={`/projects/${project.id}`}
          className="row"
          style={{ alignItems: "flex-start", minWidth: 0, flex: 1 }}
        >
          <AppIcon name={project.name} />
          <span style={{ minWidth: 0 }}>
            <span className="t-h3 truncate" style={{ display: "block" }}>
              {project.name}
            </span>
            <span className="t-meta truncate" style={{ display: "block" }}>
              {project.analysis?.primaryCategory || "Analysis pending"}
            </span>
          </span>
        </Link>

        <div className="card-menu" ref={menuRef}>
          <button
            className="menu-trigger"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={`Actions for ${project.name}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOpen((v) => !v);
            }}
          >
            •••
          </button>
          {open && (
            <div className="menu-list" role="menu">
              {inHistory ? (
                <button className="menu-item" role="menuitem" onClick={act(onRestore)}>
                  ↩ Restore to Active
                </button>
              ) : (
                <button className="menu-item" role="menuitem" onClick={act(onArchive)}>
                  ⌸ Move to History
                </button>
              )}
              <button
                className="menu-item menu-item-danger"
                role="menuitem"
                onClick={act(onDelete)}
              >
                ✕ Delete project
              </button>
            </div>
          )}
        </div>
      </div>

      <Link href={`/projects/${project.id}`} style={{ display: "block" }}>
        {project.analysis?.audience && (
          <p
            className="t-small"
            style={{
              marginTop: 12,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {project.analysis.audience}
          </p>
        )}
        <span className="row-wrap divide-top" style={{ marginTop: 14, paddingTop: 12 }}>
          {project.historyReason === "archived" ? (
            <Badge tone="neutral">Archived</Badge>
          ) : project.historyReason === "inactive" ? (
            <Badge tone="neutral">Inactive</Badge>
          ) : project.analysis ? (
            <Badge tone="success">Analysed</Badge>
          ) : (
            <Badge tone="warning">Needs analysis</Badge>
          )}
          <span className="t-meta">
            {project.lastActivityAt
              ? `Last worked on ${relative(project.lastActivityAt)}`
              : project.createdAt
              ? `Added ${new Date(project.createdAt).toLocaleDateString()}`
              : ""}
          </span>
        </span>
      </Link>
    </div>
  );
}

/**
 * Deleting takes the whole growth history with it, so the customer is told
 * exactly what disappears and has to confirm.
 */
export function DeleteConfirm({
  project,
  busy,
  onCancel,
  onConfirm,
}: {
  project: ProjectSummary;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="confirm-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="confirm-card">
        <h2 id="delete-title" className="t-h2">
          Delete “{project.name}”?
        </h2>
        <p className="t-body" style={{ marginTop: 10 }}>
          This removes the project and its analysis, discovery results, campaigns, prepared posts,
          tracking links and click history. This cannot be undone.
        </p>
        <div className="row" style={{ marginTop: 22, justifyContent: "flex-end" }}>
          <button className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className={`btn btn-danger ${busy ? "btn-busy" : ""}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy && <span className="spinner" aria-hidden="true" />}
            {busy ? "Deleting…" : "Delete project"}
          </button>
        </div>
      </div>
    </div>
  );
}
