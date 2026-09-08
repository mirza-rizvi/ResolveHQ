import { and, asc, desc, eq, like, lt, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/middleware";
import { createDb } from "../db";
import { knowledgeBaseArticles, organizations } from "../db/schema";
import { HttpError } from "../http/errors";
import { validate } from "../http/validate";
import { newId } from "../lib/id";
import { sanitizeHtml } from "../lib/sanitize-html";
import type { HonoEnv } from "../types";

export function slugifyArticle(value: string) {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!slug) throw new HttpError(400, "invalid_slug", "The title must contain letters or numbers to build a link.");
  return slug;
}

const articleInput = z.object({
  title: z.string().trim().min(1).max(200),
  slug: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((value) => (value ? slugifyArticle(value) : undefined)),
  category: z.string().trim().min(1).max(80).optional().nullable(),
  body: z.string().trim().min(1).max(100_000),
  status: z.enum(["draft", "published"]).default("draft"),
});

function decodeCursor(raw: string | undefined): { updatedAt: Date; id: string } | undefined {
  if (!raw) return undefined;
  const [ms, id] = raw.split(".");
  const updatedAt = new Date(Number(ms));
  return Number.isFinite(updatedAt.getTime()) && id ? { updatedAt, id } : undefined;
}
const articlePatch = articleInput
  .partial()
  .extend({ version: z.number().int().positive() })
  .transform((value) => (value.slug === undefined ? value : { ...value, slug: slugifyArticle(value.slug) }));

/** Stored bodies are plain text or sanitized HTML; inbound HTML never enters the knowledge base. */
function storedBody(body: string) {
  return body.includes("<") ? sanitizeHtml(body) : body;
}
export const knowledgeBaseRoutes = new Hono<HonoEnv>();
knowledgeBaseRoutes.use("*", requireAuth);

knowledgeBaseRoutes.get("/", async (context) => {
  const tenant = context.get("tenant");
  const status = context.req.query("status");
  const query = context.req.query("q")?.trim().toLowerCase();
  const limit = Math.min(50, Math.max(1, Number(context.req.query("limit") ?? 30) || 30));

  const cursor = decodeCursor(context.req.query("cursor"));
  const db = createDb(context.env.DB);
  const rows = await db
    .select({
      id: knowledgeBaseArticles.id,
      title: knowledgeBaseArticles.title,
      slug: knowledgeBaseArticles.slug,
      category: knowledgeBaseArticles.category,
      status: knowledgeBaseArticles.status,
      version: knowledgeBaseArticles.version,
      publishedAt: knowledgeBaseArticles.publishedAt,
      updatedAt: knowledgeBaseArticles.updatedAt,
    })
    .from(knowledgeBaseArticles)
    .where(
      and(
        eq(knowledgeBaseArticles.organizationId, tenant.organizationId),
        status === "draft" || status === "published" ? eq(knowledgeBaseArticles.status, status) : undefined,
        query ? like(knowledgeBaseArticles.title, `%${query}%`) : undefined,
        cursor
          ? or(
              lt(knowledgeBaseArticles.updatedAt, cursor.updatedAt),
              and(eq(knowledgeBaseArticles.updatedAt, cursor.updatedAt), lt(knowledgeBaseArticles.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(knowledgeBaseArticles.updatedAt), desc(knowledgeBaseArticles.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return context.json({
    articles: page,
    nextCursor: hasMore && last ? `${new Date(last.updatedAt).getTime()}.${last.id}` : null,
    hasMore,
  });
});

knowledgeBaseRoutes.post("/", requireRole("admin"), validate("json", articleInput), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  const slug = input.slug ?? slugifyArticle(input.title);
  const id = newId("kb");
  const now = new Date();
  try {
    await createDb(context.env.DB)
      .insert(knowledgeBaseArticles)
      .values({
        id,
        organizationId: tenant.organizationId,
        title: input.title,
        slug,
        category: input.category ?? null,
        body: storedBody(input.body),
        status: input.status,
        publishedAt: input.status === "published" ? now : null,
        createdByUserId: tenant.userId,
        createdAt: now,
        updatedAt: now,
      });
  } catch (error) {
    if (String(error).includes("UNIQUE"))
      throw new HttpError(409, "kb_slug_exists", "An article with this link slug already exists.");
    throw error;
  }
  return context.json({ article: { id, slug, status: input.status } }, 201);
});

knowledgeBaseRoutes.get("/:id", async (context) => {
  const tenant = context.get("tenant");
  const [article] = await createDb(context.env.DB)
    .select()
    .from(knowledgeBaseArticles)
    .where(
      and(
        eq(knowledgeBaseArticles.id, context.req.param("id")),
        eq(knowledgeBaseArticles.organizationId, tenant.organizationId),
      ),
    )
    .limit(1);
  if (!article) throw new HttpError(404, "article_not_found", "Article not found.");
  return context.json({ article });
});

knowledgeBaseRoutes.patch("/:id", requireRole("admin"), validate("json", articlePatch), async (context) => {
  const tenant = context.get("tenant");
  const input = context.req.valid("json");
  const db = createDb(context.env.DB);
  const [current] = await db
    .select()
    .from(knowledgeBaseArticles)
    .where(
      and(
        eq(knowledgeBaseArticles.id, context.req.param("id")),
        eq(knowledgeBaseArticles.organizationId, tenant.organizationId),
      ),
    )
    .limit(1);
  if (!current) throw new HttpError(404, "article_not_found", "Article not found.");
  if (input.version !== current.version)
    throw new HttpError(409, "kb_version_conflict", "This article changed in another session. Refresh and try again.");
  const publishing = input.status === "published" && !current.publishedAt;
  try {
    await db
      .update(knowledgeBaseArticles)
      .set({
        title: input.title,
        slug: input.slug,
        category: input.category === undefined ? undefined : input.category,
        body: input.body === undefined ? undefined : storedBody(input.body),
        status: input.status,
        publishedAt: publishing ? new Date() : undefined,
        version: current.version + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(knowledgeBaseArticles.id, current.id),
          eq(knowledgeBaseArticles.organizationId, tenant.organizationId),
          eq(knowledgeBaseArticles.version, current.version),
        ),
      );
  } catch (error) {
    if (String(error).includes("UNIQUE"))
      throw new HttpError(409, "kb_slug_exists", "An article with this link slug already exists.");
    throw error;
  }
  return context.json({ ok: true });
});

knowledgeBaseRoutes.delete("/:id", requireRole("admin"), async (context) => {
  const tenant = context.get("tenant");
  const result = await createDb(context.env.DB)
    .delete(knowledgeBaseArticles)
    .where(
      and(
        eq(knowledgeBaseArticles.id, context.req.param("id")),
        eq(knowledgeBaseArticles.organizationId, tenant.organizationId),
      ),
    );
  if (!result.meta.changes) throw new HttpError(404, "article_not_found", "Article not found.");
  return context.json({ ok: true });
});

/** Public help center: published articles of one organization, found by workspace slug. */
export const helpCenterRoutes = new Hono<HonoEnv>();

helpCenterRoutes.get("/:workspace", async (context) => {
  const workspace = context.req.param("workspace").toLowerCase();
  const db = createDb(context.env.DB);
  const [organization] = await db
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.slug, workspace))
    .limit(1);
  if (!organization) throw new HttpError(404, "workspace_not_found", "No help center exists at this address.");
  const articles = await db
    .select({
      slug: knowledgeBaseArticles.slug,
      title: knowledgeBaseArticles.title,
      category: knowledgeBaseArticles.category,
      updatedAt: knowledgeBaseArticles.updatedAt,
    })
    .from(knowledgeBaseArticles)
    .where(
      and(eq(knowledgeBaseArticles.organizationId, organization.id), eq(knowledgeBaseArticles.status, "published")),
    )
    .orderBy(asc(knowledgeBaseArticles.category), asc(knowledgeBaseArticles.title));
  return context.json({ workspace: { name: organization.name, slug: organization.slug }, articles });
});

helpCenterRoutes.get("/:workspace/:slug", async (context) => {
  const workspace = context.req.param("workspace").toLowerCase();
  const db = createDb(context.env.DB);
  const [organization] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.slug, workspace))
    .limit(1);
  if (!organization) throw new HttpError(404, "workspace_not_found", "No help center exists at this address.");
  const [article] = await db
    .select({
      slug: knowledgeBaseArticles.slug,
      title: knowledgeBaseArticles.title,
      category: knowledgeBaseArticles.category,
      body: knowledgeBaseArticles.body,
      publishedAt: knowledgeBaseArticles.publishedAt,
      updatedAt: knowledgeBaseArticles.updatedAt,
    })
    .from(knowledgeBaseArticles)
    .where(
      and(
        eq(knowledgeBaseArticles.organizationId, organization.id),
        eq(knowledgeBaseArticles.slug, context.req.param("slug")),
        eq(knowledgeBaseArticles.status, "published"),
      ),
    )
    .limit(1);
  if (!article) throw new HttpError(404, "article_not_found", "This article is not available.");
  return context.json({ workspace: { name: organization.name }, article });
});
