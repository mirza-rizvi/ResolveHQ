import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";

type RateResult =
  | { status: "recorded"; rating: number }
  | { status: "already_rated"; rating: number | null; hasComment: boolean }
  | { status: "unavailable" };

const faces: Record<number, string> = { 1: "😞", 3: "😐", 5: "🙂" };
const labels: Record<number, string> = { 1: "Bad", 3: "OK", 5: "Good" };

/**
 * The only surface in this release an external customer sees.
 *
 * It owes nothing to the workspace's visual direction and everything to speed and calm:
 * one centred column, no navigation, no session, and a plain sentence for every outcome.
 *
 * The click in the email is the answer. This page confirms it; it never asks the customer
 * to click again to register a score they already gave.
 */
export function RatePage() {
  const { token } = useParams();
  const [result, setResult] = useState<RateResult | null>(null);
  const [comment, setComment] = useState("");
  const [commentState, setCommentState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const submitted = useRef(false);

  useEffect(() => {
    if (!token || submitted.current) return;
    submitted.current = true;
    fetch(`/api/csat/${encodeURIComponent(token)}`, { method: "POST" })
      .then((response) => (response.ok ? (response.json() as Promise<RateResult>) : { status: "unavailable" as const }))
      .then(setResult)
      .catch(() => setResult({ status: "unavailable" }));
  }, [token]);

  async function sendComment(event: React.FormEvent) {
    event.preventDefault();
    if (!token || !comment.trim()) return;
    setCommentState("saving");
    try {
      const response = await fetch(`/api/csat/${encodeURIComponent(token)}/comment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ comment }),
      });
      const body = (await response.json()) as { status: string };
      setCommentState(body.status === "recorded" ? "saved" : "failed");
    } catch {
      setCommentState("failed");
    }
  }

  const rating = result && result.status !== "unavailable" ? result.rating : null;
  return (
    <main className="rate-page">
      <section className="rate-card">
        {!result && <p className="rate-quiet">Recording your answer…</p>}

        {result?.status === "unavailable" && (
          <>
            <h1>This rating link is no longer available</h1>
            <p className="rate-quiet">
              It may have already been used, or the conversation it belonged to may have been deleted. Nothing is
              wrong on your side, and there is nothing you need to do.
            </p>
          </>
        )}

        {result && result.status !== "unavailable" && (
          <>
            <div className="rate-face" aria-hidden="true">
              {rating != null ? faces[rating] : "🙂"}
            </div>
            <h1>{result.status === "recorded" ? "Thank you" : "You have already answered"}</h1>
            <p className="rate-quiet">
              {rating != null
                ? `We recorded your rating as “${labels[rating]}”.`
                : "We recorded your answer."}
            </p>

            {commentState === "saved" ? (
              <p className="rate-quiet">Thanks — your note has been added.</p>
            ) : (
              <form onSubmit={sendComment} className="rate-comment">
                <label htmlFor="rate-comment-field">Anything you would like to add?</label>
                <textarea
                  id="rate-comment-field"
                  value={comment}
                  maxLength={2000}
                  rows={4}
                  placeholder="Optional"
                  onChange={(event) => setComment(event.target.value)}
                />
                <button type="submit" disabled={!comment.trim() || commentState === "saving"}>
                  {commentState === "saving" ? "Sending…" : "Send"}
                </button>
                {commentState === "failed" && (
                  <p className="rate-quiet" role="alert">
                    That could not be saved. Your rating was still recorded.
                  </p>
                )}
              </form>
            )}
          </>
        )}
      </section>
    </main>
  );
}
