import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageKind } from "@/web/inbox/types";
import { ApiError, api } from "@/web/lib/api";

export type DraftStatus = "idle" | "saving" | "saved" | "error";

interface StoredDraft {
  body: string;
  kind: MessageKind;
  revision: number;
}

const putDraft = (ticketId: string, body: string, kind: MessageKind, revision: number) =>
  api<{ draft: { revision: number } }>(`/operations/tickets/${ticketId}/draft`, {
    method: "PUT",
    body: JSON.stringify({ body, kind, revision }),
  });

export function useDraft(ticketId?: string) {
  const [body, setBodyState] = useState("");
  const [html, setHtml] = useState("");
  const [kind, setKindState] = useState<MessageKind>("message");
  const [status, setStatus] = useState<DraftStatus>("idle");
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  // Revisions are held per ticket: a save started before a ticket switch still
  // has to name the revision of the ticket it was written for.
  const revisions = useRef(new Map<string, number>());
  const openTicket = useRef(ticketId);
  const hydrated = useRef("");
  const edited = useRef(false);
  // Draft writes are serialised: the server rejects a stale revision, so two
  // debounced saves in flight at once would make the second one conflict.
  const writes = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef(0);

  const save = useCallback((id: string, text: string, messageKind: MessageKind) => {
    // Status belongs to whatever the agent is looking at now, so a save that
    // lands after a ticket switch reports nothing.
    const report = (next: DraftStatus, at: Date | null = null) => {
      if (openTicket.current !== id) return;
      setStatus(next);
      if (next === "saved") setSavedAt(at);
    };
    report("saving");
    const run = writes.current.then(async () => {
      try {
        revisions.current.set(id, (await putDraft(id, text, messageKind, revisions.current.get(id) ?? 0)).draft.revision);
      } catch (error) {
        // Another tab saved a newer draft. Take the server's revision and put
        // this text on top of it rather than dropping what was typed here.
        if (error instanceof ApiError && error.code === "draft_revision_conflict") {
          const current = await api<{ draft: StoredDraft | null }>(`/operations/tickets/${id}/draft`).catch(() => null);
          if (current?.draft) revisions.current.set(id, current.draft.revision);
          try {
            revisions.current.set(id, (await putDraft(id, text, messageKind, revisions.current.get(id) ?? 0)).draft.revision);
            report("saved", new Date());
            return;
          } catch { /* reported as an error below */ }
        }
        report("error");
        return;
      }
      report("saved", new Date());
    });
    writes.current = run;
    return run;
  }, []);

  useEffect(() => {
    openTicket.current = ticketId;
    hydrated.current = "";
    edited.current = false;
    setStatus("idle");
    setSavedAt(null);
    setHtml("");
    if (!ticketId) { setBodyState(""); setKindState("message"); return; }
    let cancelled = false;
    void api<{ draft: StoredDraft | null }>(`/operations/tickets/${ticketId}/draft`).then(({ draft }) => {
      // Anything typed while the stored draft was in flight wins over it.
      if (cancelled || edited.current) return;
      if (draft) { setBodyState(draft.body); setKindState(draft.kind); revisions.current.set(ticketId, draft.revision); }
      else { setBodyState(""); setKindState("message"); revisions.current.delete(ticketId); }
    }).catch(() => undefined).finally(() => {
      if (!cancelled) hydrated.current = ticketId;
    });
    return () => { cancelled = true; };
  }, [ticketId]);

  useEffect(() => {
    if (!ticketId || hydrated.current !== ticketId || !edited.current) return;
    // Nothing typed and nothing stored: no row worth creating.
    if (!body.trim() && !revisions.current.get(ticketId)) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(ticketId, body, kind), 700);
    return () => window.clearTimeout(timer.current);
  }, [body, kind, ticketId, save]);

  const setBody = useCallback((text: string, nextHtml = "") => {
    edited.current = true;
    setBodyState(text);
    setHtml(nextHtml);
  }, []);

  const setKind = useCallback((next: MessageKind) => {
    edited.current = true;
    setKindState(next);
  }, []);

  // Sent: drop the stored draft, but only once any save already on the wire has
  // landed, or that save would recreate the row straight after the delete.
  const clear = useCallback(async () => {
    window.clearTimeout(timer.current);
    edited.current = false;
    setBodyState("");
    setHtml("");
    setStatus("idle");
    setSavedAt(null);
    if (!ticketId) return;
    await writes.current.catch(() => undefined);
    await api(`/operations/tickets/${ticketId}/draft`, { method: "DELETE" }).catch(() => undefined);
    revisions.current.delete(ticketId);
  }, [ticketId]);

  return { body, html, kind, setBody, setKind, status, savedAt, clear };
}
