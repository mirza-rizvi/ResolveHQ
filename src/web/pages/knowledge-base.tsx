import { useCallback, useEffect, useState } from "react";
import { BookOpen, FileText, Pencil, Plus, Search, Send, Trash2, X } from "lucide-react";
import { useAuth } from "@/web/auth";
import { useToast } from "@/web/components/toast";
import { ApiError, api, errorMessage } from "@/web/lib/api";
import { Badge, Button, Input } from "@/web/components/ui";

interface ArticleSummary {
  id: string;
  title: string;
  slug: string;
  category: string | null;
  status: "draft" | "published";
  version: number;
  updatedAt: string;
}
interface Article extends ArticleSummary {
  body: string;
  publishedAt: string | null;
}

/** Help articles share the help center's public address space: /help/<workspace>/<slug>. */
export function KnowledgeBasePage() {
  const { session } = useAuth();
  const toast = useToast();
  const [articles, setArticles] = useState<ArticleSummary[]>([]);
  const [status, setStatus] = useState<"all" | "draft" | "published">("all");
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Article | null>(null);
  const [creating, setCreating] = useState(false);
  const canManage = session?.role === "owner" || session?.role === "admin";

  const load = useCallback(async () => {
    try {
      const search = new URLSearchParams();
      if (status !== "all") search.set("status", status);
      if (query.trim()) search.set("q", query.trim().toLowerCase());
      const result = await api<{ articles: ArticleSummary[] }>(`/knowledge-base?${search}`);
      setArticles(result.articles);
      setLoaded(true);
      setError("");
    } catch (reason) {
      setError(errorMessage(reason, "Articles could not be loaded."));
    }
  }, [status, query]);
  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timeout);
  }, [load]);

  async function openArticle(id: string) {
    try {
      setEditing(await api<{ article: Article }>(`/knowledge-base/${id}`).then((result) => result.article));
    } catch (reason) {
      toast.push(errorMessage(reason, "Article could not be opened."), "error");
    }
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = {
      title: String(form.get("title") ?? ""),
      slug: String(form.get("slug") ?? "") || undefined,
      category: String(form.get("category") ?? "") || null,
      body: String(form.get("body") ?? ""),
      status: form.get("status") === "published" ? ("published" as const) : ("draft" as const),
    };
    try {
      if (editing) {
        await api(`/knowledge-base/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ ...values, version: editing.version }),
        });
        setEditing(null);
      } else {
        await api("/knowledge-base", { method: "POST", body: JSON.stringify(values) });
        setCreating(false);
      }
      toast.push("Article saved.", "success");
      await load();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        toast.push("This article changed in another session. Reopen it and apply your edit again.", "error");
        setEditing(null);
      } else toast.push(errorMessage(reason, "The article could not be saved."), "error");
    }
  }

  async function remove(article: ArticleSummary) {
    if (!window.confirm(`Delete “${article.title}”? Customers lose access immediately.`)) return;
    try {
      await api(`/knowledge-base/${article.id}`, { method: "DELETE" });
      if (editing?.id === article.id) setEditing(null);
      toast.push("Article deleted.", "success");
      await load();
    } catch (reason) {
      toast.push(errorMessage(reason, "The article could not be deleted."), "error");
    }
  }

  async function publish(article: ArticleSummary) {
    try {
      await api(`/knowledge-base/${article.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: article.status === "published" ? "draft" : "published",
          version: article.version,
        }),
      });
      await load();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409)
        toast.push("This article changed in another session. Refresh the list and retry.", "error");
      else toast.push(errorMessage(reason, "The article could not be updated."), "error");
    }
  }

  const form = creating || editing;
  return (
    <div className="standard-page">
      <header className="page-header">
        <div>
          <h1>Knowledge base</h1>
          <p>
            Document repeat answers once. Published articles are served at{" "}
            <code>/help/{session?.organization.slug}</code>.
          </p>
        </div>
        {canManage && (
          <Button
            onClick={() => {
              setCreating((open) => !open);
              setEditing(null);
            }}
          >
            {creating ? <X size={15} /> : <Plus size={15} />}
            {creating ? "Close" : "New article"}
          </Button>
        )}
      </header>
      {error && <p className="page-error">{error}</p>}
      {form && (
        <form className="kb-editor" onSubmit={save}>
          <div className="kb-editor-row">
            <label>
              Title
              <Input name="title" defaultValue={editing?.title} required maxLength={200} />
            </label>
            <label>
              Category
              <Input
                name="category"
                defaultValue={editing?.category ?? ""}
                placeholder="Billing, setup…"
                maxLength={80}
              />
            </label>
            <label>
              Link slug
              <Input name="slug" defaultValue={editing?.slug} placeholder="auto from title" maxLength={80} />
            </label>
          </div>
          <label>
            Body
            <textarea
              name="body"
              defaultValue={editing?.body}
              rows={12}
              required
              placeholder="Write the answer the way you would say it to a customer. Simple HTML paragraphs and links are allowed."
            />
          </label>
          <div className="kb-editor-row">
            <label>
              State
              <select name="status" defaultValue={editing?.status ?? "draft"}>
                <option value="draft">Draft — only your team sees it</option>
                <option value="published">Published — public in the help center</option>
              </select>
            </label>
            <div className="kb-editor-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setCreating(false);
                  setEditing(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit">
                <Send size={14} />
                Save article
              </Button>
            </div>
          </div>
        </form>
      )}
      <label className="customer-search">
        <Search size={16} />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search titles…"
          aria-label="Search articles"
        />
      </label>
      <div className="section-heading">
        <h2>
          <BookOpen size={16} />
          {articles.length} articles
        </h2>
        <select
          aria-label="Filter by state"
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
        >
          <option value="all">All</option>
          <option value="draft">Drafts</option>
          <option value="published">Published</option>
        </select>
      </div>
      {loaded && !articles.length && (
        <p className="ledger-empty">No articles yet. Write down the answer you give most often.</p>
      )}
      <div className="kb-list">
        {articles.map((article) => (
          <article key={article.id}>
            <FileText size={16} />
            <button
              type="button"
              className="kb-title"
              disabled={!canManage}
              onClick={() => void openArticle(article.id)}
            >
              <strong>{article.title}</strong>
              <small>/{article.slug}</small>
            </button>
            <span>{article.category ?? "Uncategorized"}</span>
            <Badge tone={article.status === "published" ? "green" : "amber"}>{article.status}</Badge>
            {canManage && (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={article.status === "published" ? "Unpublish article" : "Publish article"}
                  onClick={() => void publish(article)}
                >
                  <Send size={13} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Edit article"
                  onClick={() => void openArticle(article.id)}
                >
                  <Pencil size={13} />
                </Button>
                <Button variant="ghost" size="icon" aria-label="Delete article" onClick={() => void remove(article)}>
                  <Trash2 size={13} />
                </Button>
              </>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
