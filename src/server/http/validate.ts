import { zValidator } from "@hono/zod-validator";
import type { ZodType } from "zod";
import { HttpError } from "./errors";

export function validate<T extends ZodType>(target: "json" | "query", schema: T) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      const issue = result.error.issues[0];
      const path = issue?.path?.length ? `${issue.path.map((segment) => String(segment)).join(".")}: ` : "";
      throw new HttpError(400, "validation_error", `${path}${issue?.message ?? "Invalid input."}`);
    }
  });
}
