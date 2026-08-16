"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";

type Account = {
  customerId: string;
  descriptiveName: string | null;
  currencyCode: string | null;
  timeZone: string | null;
  testAccount: boolean | null;
  manager: boolean | null;
  accessPath?: "direct" | "manager_child";
  parentManagerCustomerId?: string | null;
};
type State = {
  status: "not_configured" | "not_connected" | "connected" | "account_error";
  connection?: { selectedCustomerId: string | null; connectedAt: string } | null;
  accounts?: Account[];
  error?: string;
};

/** 1234567890 → 123-456-7890, the form advertisers recognise. */
const formatId = (raw: string) => {
  const d = raw.replace(/\D/g, "");
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d;
};

/** What came back on the redirect from Google, in plain language. */
const RESULT_MESSAGES: Record<string, string> = {
  connected: "",
  denied: "Authorization was cancelled, so nothing was connected.",
  invalid_state: "That authorization link had expired. Please connect again.",
  invalid_grant: "Google rejected the authorization. Please connect again.",
  invalid_request: "Google did not return an authorization code.",
  not_configured: "Google Ads is not configured on this deployment yet.",
  signin_required: "Please sign in before connecting Google Ads.",
  timeout: "Google did not respond in time. Please try again.",
  provider_error: "Google could not complete the authorization.",
  error: "The connection could not be completed.",
};

/**
 * Growth Autopilot — Google Ads connection.
 *
 * Phase 1 connects and reads; it cannot create a campaign or spend anything,
 * and there is deliberately no button here that would. "Connected" is only ever
 * shown after the server has completed real OAuth AND read real accounts back
 * from Google — never as an optimistic local state.
 */
export function GoogleAdsCard() {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/integrations/google-ads");
    const data = res.ok ? await res.json().catch(() => null) : null;
    setState(data ?? { status: "not_configured", accounts: [] });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Report the OAuth outcome once, then clean the query string so a
      // refresh does not repeat it.
      const params = new URLSearchParams(window.location.search);
      const result = params.get("googleAds");
      const res = await fetch("/api/integrations/google-ads");
      const data = res.ok ? await res.json().catch(() => null) : null;
      if (cancelled) return;
      if (result) {
        setNotice(RESULT_MESSAGES[result] ?? RESULT_MESSAGES.error);
        window.history.replaceState({}, "", window.location.pathname);
      }
      setState(data ?? { status: "not_configured", accounts: [] });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [selectError, setSelectError] = useState("");

  const disconnect = async () => {
    setBusy(true);
    await fetch("/api/integrations/google-ads", { method: "DELETE" }).catch(() => {});
    await load();
    setBusy(false);
  };

  const select = async (customerId: string) => {
    setBusy(true);
    setSelectError("");
    try {
      const res = await fetch("/api/integrations/google-ads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setSelectError(data.error || "That account could not be selected.");
      }
    } catch {
      setSelectError("That account could not be selected.");
    }
    await load();
    setBusy(false);
  };

  if (!state) {
    return (
      <section className="card" aria-busy="true">
        <div className="skeleton" style={{ height: 18, width: 180 }} />
        <div className="skeleton" style={{ height: 12, width: "70%", marginTop: 10 }} />
      </section>
    );
  }

  const accounts = state.accounts ?? [];
  const selected = state.connection?.selectedCustomerId ?? null;
  const connected = state.status === "connected" || state.status === "account_error";

  return (
    <section className="card" aria-labelledby="google-ads-heading">
      <div className="spread" style={{ alignItems: "flex-start" }}>
        <div>
          <span className="t-label">Growth autopilot</span>
          <h2 id="google-ads-heading" className="t-h2">
            Google Ads
          </h2>
        </div>
        <div className="row-wrap" style={{ justifyContent: "flex-end" }}>
          {state.status === "not_configured" && <Badge tone="neutral">Not configured</Badge>}
          {state.status === "not_connected" && <Badge tone="neutral">Not connected</Badge>}
          {state.status === "connected" && <Badge tone="success">Connected</Badge>}
          {state.status === "account_error" && <Badge tone="warning">Needs attention</Badge>}
        </div>
      </div>

      {notice && (
        <p className="notice notice-warning" role="status" style={{ marginTop: 14 }}>
          <span aria-hidden="true">•</span>
          {notice}
        </p>
      )}

      {state.status === "not_configured" && (
        <p className="t-small" style={{ marginTop: 12 }}>
          Google Ads integration is not configured on this deployment yet. Once the operator adds
          the Google credentials, you&apos;ll be able to connect an advertising account here.
        </p>
      )}

      {state.status === "not_connected" && (
        <>
          <p className="t-small" style={{ marginTop: 12, maxWidth: 560 }}>
            Connect a Google Ads account so AI Growth Kit can read it. You authorise through
            Google — we never see your password, and this connection cannot create campaigns or
            spend money.
          </p>
          <div className="row-wrap" style={{ marginTop: 16 }}>
            <a className="btn btn-primary" href="/api/integrations/google-ads/connect">
              Connect Google Ads
            </a>
          </div>
        </>
      )}

      {connected && (
        <>
          {state.status === "account_error" && state.error && (
            <p className="notice notice-error" role="alert" style={{ marginTop: 14 }}>
              <span aria-hidden="true">⚠</span>
              {state.error}
            </p>
          )}

          {accounts.length > 0 && (
            <div className="stack" style={{ marginTop: 16 }}>
              {accounts.map((a) => {
                const isSelected = selected === a.customerId;
                // Campaigns run in advertiser accounts. A manager is shown for
                // context but cannot be chosen — the server refuses it too.
                const isManager = a.manager === true;
                return (
                  <div
                    key={a.customerId}
                    className={`card card-muted ${isSelected ? "card-accent" : ""}`}
                  >
                    <div className="spread" style={{ alignItems: "flex-start" }}>
                      <div style={{ minWidth: 0 }}>
                        <p className="t-h3 truncate">
                          {a.descriptiveName || "Unnamed account"}
                        </p>
                        <p className="t-meta">
                          Customer ID {formatId(a.customerId)}
                          {a.currencyCode ? ` · ${a.currencyCode}` : ""}
                          {a.timeZone ? ` · ${a.timeZone}` : ""}
                        </p>
                        {a.accessPath === "manager_child" && a.parentManagerCustomerId && (
                          <p className="t-meta">
                            via manager {formatId(a.parentManagerCustomerId)}
                          </p>
                        )}
                        <div className="row-wrap" style={{ marginTop: 8 }}>
                          {a.testAccount === true && <Badge tone="accent">Test mode</Badge>}
                          {a.testAccount === false && <Badge tone="warning">Live account</Badge>}
                          {isManager ? (
                            <Badge tone="neutral">Manager</Badge>
                          ) : (
                            <Badge tone="neutral">Advertiser</Badge>
                          )}
                          {isSelected && <Badge tone="success">Selected</Badge>}
                        </div>
                      </div>
                      {isManager ? (
                        <span className="t-meta" style={{ textAlign: "right", maxWidth: 160 }}>
                          Manager account — choose an advertiser account below it
                        </span>
                      ) : (
                        !isSelected && (
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => select(a.customerId)}
                            disabled={busy}
                          >
                            Use this account
                          </button>
                        )
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {selectError && (
            <p className="notice notice-error" role="alert" style={{ marginTop: 14 }}>
              <span aria-hidden="true">⚠</span>
              {selectError}
            </p>
          )}

          {state.status === "connected" && accounts.length === 0 && (
            <p className="t-small" style={{ marginTop: 14 }}>
              This Google account is authorised, but no Google Ads accounts are accessible to it
              yet.
            </p>
          )}

          <p className="t-meta" style={{ marginTop: 14 }}>
            Read-only for now: AI Growth Kit can see these accounts. Creating campaigns and
            spending budget is not part of this connection.
          </p>

          <div className="row-wrap divide-top" style={{ marginTop: 14, paddingTop: 12 }}>
            <button className="btn btn-secondary btn-sm" onClick={load} disabled={busy}>
              Refresh accounts
            </button>
            <button className="btn btn-secondary btn-sm" onClick={disconnect} disabled={busy}>
              Disconnect
            </button>
            <span className="t-meta">Disconnecting removes our authorization only.</span>
          </div>
        </>
      )}
    </section>
  );
}
