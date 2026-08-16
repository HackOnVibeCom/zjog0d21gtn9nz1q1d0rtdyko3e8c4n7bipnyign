// Minimal server-side OpenAI client. The API key is read from the process
// environment and is NEVER logged, returned, or embedded in output.
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export async function chatJSON<T = unknown>(
  system: string,
  user: string,
  model = "gpt-4o-mini"
): Promise<T> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set in the environment");

  let res: Response;
  try {
    res = await fetch(OPENAI_URL, {
    // Bounded: a hung request must not hold a serverless invocation open.
    signal: AbortSignal.timeout(25_000),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  } catch {
    throw new Error("The analysis service did not respond in time");
  }

  if (!res.ok) {
    // Only the status is surfaced — upstream bodies can echo request details.
    throw new Error(`The analysis service returned an error (${res.status})`);
  }
  try {
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content) as T;
  } catch {
    throw new Error("The analysis service returned an unreadable response");
  }
}
