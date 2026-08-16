"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BrandMark } from "@/components/app/AppShell";

export default function Signup() {
  const [name, setName] = useState("");
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
    const res = await fetch("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error || "Sign up failed");
      setLoading(false);
      return;
    }
    // Auto sign-in after successful registration.
    await signIn("credentials", { email, password, redirect: false });
    router.push("/app");
  }

  return (
    <div className="auth-wrap">
      <Link href="/" className="brand" style={{ marginBottom: 24, fontSize: 16 }}>
        <BrandMark />
        AI Growth Kit
      </Link>

      <div className="auth-card animate-in">
        <h1 className="t-h1">Create your account</h1>
        <p className="t-small" style={{ marginTop: 6, marginBottom: 26 }}>
          Start with one app link — the analysis runs straight after sign-up.
        </p>

        <form onSubmit={submit} noValidate>
          <div className="field">
            <label className="field-label" htmlFor="name">
              Name <span className="muted" style={{ fontWeight: 400 }}>(optional)</span>
            </label>
            <input
              id="name"
              className="input"
              autoComplete="name"
              placeholder="Alex"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

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
                autoComplete="new-password"
                placeholder="At least 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-describedby="password-hint"
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
            <p className="field-hint" id="password-hint">
              Minimum 8 characters.
            </p>
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
            {loading ? "Creating account…" : "Create account"}
          </button>
        </form>
      </div>

      <p className="t-small" style={{ marginTop: 22 }}>
        Have an account?{" "}
        <Link href="/login" style={{ color: "var(--accent)", fontWeight: 650 }}>
          Sign in
        </Link>
      </p>
    </div>
  );
}
