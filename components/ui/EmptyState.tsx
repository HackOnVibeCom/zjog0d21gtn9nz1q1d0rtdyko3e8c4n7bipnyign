import type { ReactNode } from "react";

/**
 * Blank space tells the customer nothing. Every empty list says what it is
 * waiting for and what to do next.
 */
export function EmptyState({
  icon = "◎",
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true">
        {icon}
      </div>
      <p className="t-h3">{title}</p>
      {description && (
        <p className="t-small" style={{ maxWidth: 420, margin: "6px auto 0" }}>
          {description}
        </p>
      )}
      {action && <div style={{ marginTop: 18 }}>{action}</div>}
    </div>
  );
}
