import { type PlatformProxy } from "wrangler";
import { type AppLoadContext } from "@remix-run/cloudflare";
import { setupDb } from "./app/shopify.server";

type GetLoadContextArgs = {
  request: Request;
  context: {
    cloudflare: Omit<PlatformProxy<Env>, "dispose" | "caches" | "cf"> & {
      caches: PlatformProxy<Env>["caches"] | CacheStorage;
      cf: Request["cf"];
    };
  };
};

export function getLoadContext({ context }: GetLoadContextArgs): AppLoadContext {
  // Initialize the DB if available
  if (context.cloudflare?.env) {
    setupDb(context.cloudflare.env);
  }

  return context as AppLoadContext;
}
