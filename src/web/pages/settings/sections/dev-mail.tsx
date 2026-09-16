import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { useToast } from "@/web/components/toast";
import { ApiError, api, errorMessage } from "@/web/lib/api";
import type { MailCapture } from "../types";

/** Only rendered while the Worker captures mail instead of delivering it; the route 404s otherwise. */
export function DevMailSection() {
  const toast = useToast();
  const [captures, setCaptures] = useState<MailCapture[] | null>(null);
  const [captureError, setCaptureError] = useState("");
  useEffect(() => {
    api<{ captures: MailCapture[] }>("/operations/dev-mail")
      .then((result) => {
        setCaptures(result.captures);
        setCaptureError("");
      })
      .catch((reason) => {
        if (reason instanceof ApiError && [403, 404].includes(reason.status)) return;
        setCaptureError("Captured mail could not be loaded.");
        toast.push(errorMessage(reason, "Captured mail could not be loaded."), "error");
      });
  }, [toast]);
  if (!captures && !captureError) return null;
  return (
    <section className="settings-section">
      <div>
        <h2>
          <Mail size={18} />
          Captured outgoing mail (development)
        </h2>
        <p>Mail is captured instead of delivered while no Resend key is configured.</p>
      </div>
      <div className="mail-captures">
        {captureError ? (
          <p className="form-error" role="alert">
            {captureError}
          </p>
        ) : captures?.length ? (
          captures.map((capture) => (
            <article key={capture.id}>
              <header>
                <strong>{capture.toAddress}</strong>
                <span>{capture.subject}</span>
                <time>{new Date(capture.createdAt).toLocaleString()}</time>
              </header>
              {capture.text && (
                <details>
                  <summary>View text</summary>
                  <pre>{capture.text}</pre>
                </details>
              )}
            </article>
          ))
        ) : (
          <p className="settings-empty">Nothing captured yet.</p>
        )}
      </div>
    </section>
  );
}
