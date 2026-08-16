"use client";

import Link from "next/link";
import { signOut, useSession } from "next-auth/react";
import type { ReactNode } from "react";

export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      ↗
    </span>
  );
}

/** Where "How it works" lives — a section of the public landing page. */
export const HOW_IT_WORKS_HREF = "/#how-it-works";

/**
 * Chrome shared by every workspace page.
 *
 * Signing in must not trap someone in the dashboard: the public site stays one
 * click away, so Home and How it works sit beside Dashboard rather than being
 * reachable only by editing the URL.
 */
export function AppShell({
  children,
  context,
  narrow = false,
}: {
  children: ReactNode;
  /** Optional breadcrumb after the brand, e.g. the current project. */
  context?: ReactNode;
  narrow?: boolean;
}) {
  const { data: session } = useSession();
  const email = session?.user?.email ?? undefined;

  return (
    <>
      <header className="nav">
        <div className="nav-inner">
          <Link href="/app" className="brand" aria-label="AI Growth Kit — dashboard">
            <BrandMark />
            <span className="brand-name">AI Growth Kit</span>
          </Link>
          {context && (
            <>
              <span className="nav-sep" aria-hidden="true">
                /
              </span>
              {context}
            </>
          )}
          <span className="nav-spacer" />
          <nav className="nav-links" aria-label="Main">
            <Link href="/" className="nav-link">
              Home
            </Link>
            <Link href={HOW_IT_WORKS_HREF} className="nav-link">
              How it works
            </Link>
            <Link href="/app" className="nav-link">
              Dashboard
            </Link>
          </nav>
          {email && <span className="nav-email truncate">{email}</span>}
          <button className="btn btn-secondary btn-sm" onClick={() => signOut({ callbackUrl: "/" })}>
            Sign out
          </button>
        </div>
      </header>
      <main className={`page ${narrow ? "page--narrow" : ""}`.trim()}>{children}</main>
    </>
  );
}
