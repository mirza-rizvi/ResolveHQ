import type { AppBindings } from "resolve-server/types";
declare module "cloudflare:test" { interface ProvidedEnv extends AppBindings {} }
declare const __D1_MIGRATIONS__: import("cloudflare:test").D1Migration[];
