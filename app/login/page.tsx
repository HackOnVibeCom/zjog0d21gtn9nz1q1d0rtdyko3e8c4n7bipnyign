"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BrandMark } from "@/components/app/AppShell";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const res = await signIn("credentials", { email, password, redirect: false });
    setLoading(false);
    if (res?.error) setError("Invalid email or password");
    else router.push("/app");
  }

  return (
    <div className="auth-wrap">
      <Link href="/" className="brand" style={{ marginBottom: 24, fontSize: 16 }}>
        <BrandMark />
        AI Growth Kit
      </Link>

      <div className="auth-card animate-in">
        <h1 className="t-h1">Welcome back</h1>
        <p className="t-small" style={{ marginTop: 6, marginBottom: 26 }}>
          Sign in to your growth workspace.
        </p>

        <form onSubmit={submit} noValidate>
          <div className="field">
            <label className="field-label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              className="input"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="password">
              Password
            </label>
            <div className="input-affix">
              <input
                id="password"
                className="input"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                placeholder="Your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="input-affix-btn"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
          </div>

          {error && (
            <p className="notice notice-error" role="alert" style={{ marginBottom: 16 }}>
              <span aria-hidden="true">⚠</span>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || !email || !password}
            className={`btn btn-primary btn-lg btn-block ${loading ? "btn-busy" : ""}`}
          >
            {loading && <span className="spinner" aria-hidden="true" />}
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>

      <p className="t-small" style={{ marginTop: 22 }}>
        No account?{" "}
        <Link href="/signup" style={{ color: "var(--accent)", fontWeight: 650 }}>
          Create one
        </Link>
      </p>
    </div>
  );
}
