// Signing in must not trap the customer in the dashboard: the public site
// stays reachable, and "How it works" has to point at something real.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const shell = read("components/app/AppShell.tsx");
const landingNav = read("components/app/LandingNav.tsx");
const landing = read("app/page.tsx");

test("the workspace nav links back to the public site", () => {
  assert.match(shell, /href="\/"[\s\S]{0,80}Home/, "Home");
  assert.match(shell, /HOW_IT_WORKS_HREF[\s\S]{0,80}How it works/, "How it works");
  assert.match(shell, /href="\/app"[\s\S]{0,80}Dashboard/, "Dashboard");
  assert.match(shell, /signOut\(/, "sign out stays available");
});

test("How it works points at a section that exists on the landing page", () => {
  const anchor = shell.match(/HOW_IT_WORKS_HREF = "\/#([a-z-]+)"/);
  assert.ok(anchor, "the anchor is declared in one place");
  assert.ok(
    landing.includes(`id="${anchor[1]}"`),
    `landing must contain id="${anchor[1]}"`
  );
});

test("an authenticated visitor is never redirected away from the landing page", () => {
  assert.doesNotMatch(landing, /redirect\(|router\.push/);
  assert.doesNotMatch(landingNav, /redirect\(|router\.push/);
});

test("the landing call to action adapts to the session instead of duplicating auth", () => {
  assert.match(landingNav, /useSession/);
  assert.match(landingNav, /status === "authenticated"/);
  assert.match(landingNav, /Dashboard|Open workspace/);
  assert.match(landingNav, /Get started|Log in/);
});
