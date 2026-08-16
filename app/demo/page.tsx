import type { Metadata } from "next";
import { LandingNav } from "@/components/app/LandingNav";
import { DemoWorkspace } from "@/components/app/DemoWorkspace";

export const metadata: Metadata = {
  title: "Live demo — AI Growth Kit",
  description:
    "Run the agent yourself: approve a budget and watch a real, paused Google Ads App Campaign be created in an isolated test account, then verified by Google.",
};

/**
 * The public demo route.
 *
 * Deliberately outside the authenticated app: it must be reachable with no
 * account, and it must never be able to reach one. The workspace it shows is
 * fixed example data, and the only real side effect it can cause is one paused
 * campaign in the sandbox advertiser.
 */
export default function DemoPage() {
  return (
    <>
      <LandingNav />
      <DemoWorkspace />
    </>
  );
}
