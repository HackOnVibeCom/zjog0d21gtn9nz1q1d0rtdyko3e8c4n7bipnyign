"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { BrandMark, HOW_IT_WORKS_HREF } from "./AppShell";

/**
 * The public site stays public for everyone, including signed-in customers —
 * `/` is never redirected away. What changes is the invitation: someone who
 * already has an account is offered their workspace, not another sign-up.
 */
export function LandingNav() {
  const { status } = useSession();
  const authed = status === "authenticated";

  return (
    <header className="nav">
      <div className="nav-inner">
        <Link href="/" className="brand">
          <BrandMark />
          <span className="brand-name">AI Growth Kit</span>
        </Link>
        <span className="nav-spacer" />
        <nav className="nav-links" aria-label="Main">
          <Link href={HOW_IT_WORKS_HREF} className="nav-link">
            How it works
          </Link>
          <Link href="/demo" className="nav-link">
            Live demo
          </Link>
          {authed ? (
            <Link href="/app" className="nav-link">
              Dashboard
            </Link>
          ) : (
            <Link href="/login" className="nav-link">
              Log in
            </Link>
          )}
        </nav>
        <Link href={authed ? "/app" : "/signup"} className="btn btn-primary btn-sm">
          {authed ? "Open workspace" : "Get started"}
        </Link>
      </div>
    </header>
  );
}

/** Hero call to action, matched to whether the visitor already has an account. */
export function LandingCta({ compact = false }: { compact?: boolean }) {
  const { status } = useSession();
  const authed = status === "authenticated";
  const size = compact ? "" : " btn-lg";

  if (authed) {
    return (
      <>
        <div className={compact ? "row-wrap" : "hero-actions"}>
          <Link href="/app" className={`btn btn-primary${size}`}>
            Go to dashboard
          </Link>
          <Link href="/demo" className={`btn btn-secondary${size}`}>
            Try the live demo
          </Link>
        </div>
        {!compact && (
          <p className="t-meta" style={{ marginTop: 14 }}>
            You&apos;re signed in — your workspace is one click away.
          </p>
        )}
      </>
    );
  }

  return (
    <>
      <div className={compact ? "row-wrap" : "hero-actions"}>
        <Link href="/signup" className={`btn btn-primary${size}`}>
          {compact ? "Start with your app link" : "Analyse my app"}
        </Link>
        {!compact && (
          <Link href="/demo" className={`btn btn-secondary${size}`}>
            Try the live demo
          </Link>
        )}
      </div>
      {!compact && (
        <p className="t-meta" style={{ marginTop: 14 }}>
          Free while in early access · no card required · the demo needs no account
        </p>
      )}
    </>
  );
}
