export type StepState = "done" | "active" | "todo";

export type Step = { label: string; state: StepState };

/**
 * Honest waiting UI. The provider gives no completion percentage, so we show
 * which stage we are in rather than inventing a progress bar that lies.
 */
export function ProgressSteps({ steps, note }: { steps: Step[]; note?: string }) {
  return (
    <div className="card card-muted" role="status" aria-live="polite">
      <ol className="steps" style={{ listStyle: "none" }}>
        {steps.map((s) => (
          <li
            key={s.label}
            className={`step ${s.state === "done" ? "step-done" : s.state === "active" ? "step-active" : ""}`}
          >
            <span className="step-dot" aria-hidden="true">
              ✓
            </span>
            <span>{s.label}</span>
          </li>
        ))}
      </ol>
      {note && (
        <p className="t-meta" style={{ marginTop: 14 }}>
          {note}
        </p>
      )}
    </div>
  );
}
