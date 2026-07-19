/// <reference types="@remix-run/cloudflare" />
/// <reference types="vite/client" />
/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
  SHOPIFY_API_KEY: string;
  SHOPIFY_API_SECRET: string;
  ENCRYPTION_KEY: string;
  SHOPIFY_APP_URL: string;
  SCOPES?: string;
  APP_DISTRIBUTION?: string;
}

declare module "@remix-run/cloudflare" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      cf?: Request["cf"];
      ctx?: ExecutionContext;
      caches?: CacheStorage;
    };
    [key: string]: unknown;
  }

  // Re-export types from server-runtime
  export type {
    LoaderFunctionArgs,
    ActionFunctionArgs,
    LinksFunction,
    EntryContext,
  } from "@remix-run/server-runtime";

  export { json, redirect } from "@remix-run/server-runtime";
}
