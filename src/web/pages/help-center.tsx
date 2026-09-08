import { useEffect, useState } from "react";
import { ArrowLeft, LifeBuoy } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { api, errorMessage } from "@/web/lib/api";

interface ArticleStub {
  slug: string;
  title: string;
  category: string | null;
  updatedAt: string;
}
interface ArticleBody extends ArticleStub {
  body: string;
  publishedAt: string | null;
}

/** Stored bodies are either plain text or server-sanitized HTML. */
function ArticleBody({ body }: { body: string }) {
  if (body.includes("<")) return <div className="help-article-body" dangerouslySetInnerHTML={{ __html: body }} />;
  return (
    <div className="help-article-body">
      {body.split(/\n{2,}/).map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </div>
  );
}

export function HelpCenterPage() {
  const { workspace, articleSlug } = useParams();
  const [meta, setMeta] = useState<{ name: string } | null>(null);
  const [articles, setArticles] = useState<ArticleStub[]>([]);
  const [article, setArticle] = useState<ArticleBody | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setMeta(null);
    setArticles([]);
    setArticle(null);
    setError("");
    if (!workspace) return;
    api<{ workspace: { name: string }; articles: ArticleStub[] }>(`/help-center/${workspace}`)
      .then((result) => {
        if (cancelled) return;
        setMeta(result.workspace);
        setArticles(result.articles);
      })
      .catch((reason) => {
        if (!cancelled) setError(errorMessage(reason, "This help center could not be loaded."));
      });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  useEffect(() => {
    let cancelled = false;
    setArticle(null);
    if (!workspace || !articleSlug) return;
    api<{ workspace: { name: string }; article: ArticleBody }>(`/help-center/${workspace}/${articleSlug}`)
      .then((result) => {
        if (!cancelled) setArticle(result.article);
      })
      .catch((reason) => {
        if (!cancelled) setError(errorMessage(reason, "This article is not available."));
      });
    return () => {
      cancelled = true;
    };
  }, [workspace, articleSlug]);

  if (error)
    return (
      <div className="help-center">
        <div className="help-empty">
          <LifeBuoy size={22} />
          <h1>Help center</h1>
          <p>{error}</p>
          <Link to="/">Go back</Link>
        </div>
      </div>
    );
  if (!meta)
    return (
      <div className="help-center">
        <div className="route-loading" aria-label="Loading help center" />
      </div>
    );

  const categories = [...new Set(articles.map((entry) => entry.category ?? "Other"))];
  return (
    <div className="help-center">
      <header className="help-header">
        <LifeBuoy size={20} />
        <div>
          <h1>{meta.name} help</h1>
          <p>Guides and answers published by the support team.</p>
        </div>
      </header>
      {article ? (
        <article className="help-article">
          <Link className="help-back" to={`/help/${workspace}`}>
            <ArrowLeft size={14} />
            All articles
          </Link>
          <p className="ticket-reference">{article.category ?? "General"}</p>
          <h2>{article.title}</h2>
          <ArticleBody body={article.body} />
          <small>Updated {new Date(article.updatedAt).toLocaleDateString()}</small>
        </article>
      ) : articles.length ? (
        categories.map((category) => (
          <section key={category} className="help-section">
            <h2>{category}</h2>
            <ul>
              {articles
                .filter((entry) => (entry.category ?? "Other") === category)
                .map((entry) => (
                  <li key={entry.slug}>
                    <Link to={`/help/${workspace}/${entry.slug}`}>{entry.title}</Link>
                  </li>
                ))}
            </ul>
          </section>
        ))
      ) : (
        <div className="help-empty">
          <p>No articles have been published yet. Check back soon.</p>
        </div>
      )}
    </div>
  );
}
