import "@shopify/shopify-app-remix/adapters/node";
import {
  AppDistribution,
  shopifyApp,
  DeliveryMethod,
} from "@shopify/shopify-app-remix/server";
import { LATEST_API_VERSION } from "@shopify/shopify-api";
import { D1SessionStorage } from "./lib/d1-session-storage.server";

// Global variables for Cloudflare Workers environment
let _db: D1Database | null = null;
let _env: Env | null = null;
let _shopify: ReturnType<typeof shopifyApp> | null = null;

// Setup DB and environment from load-context
export function setupDb(env: Env) {
  _db = env.DB;
  _env = env;
}

// Get the D1 database instance
export function getDb(): D1Database {
  if (!_db) {
    throw new Error("Database not initialized. Call setupDb first.");
  }
  return _db;
}

// Get the environment
export function getEnv(): Env {
  if (!_env) {
    throw new Error("Environment not initialized. Call setupDb first.");
  }
  return _env;
}

// Get the API key this deployment is configured with
export function getCurrentApiKey(): string {
  return _env?.SHOPIFY_API_KEY || "";
}

// Get or create the Shopify app instance
export function getShopify() {
  if (!_env) {
    throw new Error("Environment not initialized. Call setupDb first.");
  }

  // Create a new instance each time since scopes might change
  // or we need fresh session storage
  _shopify = shopifyApp({
    apiKey: _env.SHOPIFY_API_KEY,
    apiSecretKey: _env.SHOPIFY_API_SECRET,
    apiVersion: LATEST_API_VERSION,
    // write_inventory is required: the app increases Shopify stock when prints
    // are queued (see adjustInventory in app/services/queue.server.ts). Without
    // it, OAuth succeeds and every inventory write then fails at runtime.
    scopes: _env.SCOPES?.split(",") || [
      "read_products",
      "read_orders",
      "read_inventory",
      "write_inventory",
    ],
    appUrl: _env.SHOPIFY_APP_URL || "https://localhost",
    authPathPrefix: "/auth",
    sessionStorage: new D1SessionStorage(_db!),
    distribution: _env.APP_DISTRIBUTION === "ShopifyAdmin"
      ? AppDistribution.ShopifyAdmin
      : AppDistribution.AppStore,
    isEmbeddedApp: true,
    webhooks: {
      APP_UNINSTALLED: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks",
      },
      ORDERS_PAID: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks",
      },
      ORDERS_CREATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks",
      },
      INVENTORY_LEVELS_UPDATE: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks",
      },
      CUSTOMERS_DATA_REQUEST: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks",
      },
      CUSTOMERS_REDACT: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks",
      },
      SHOP_REDACT: {
        deliveryMethod: DeliveryMethod.Http,
        callbackUrl: "/webhooks",
      },
    },
    hooks: {
      afterAuth: async ({ session }: { session: { shop: string } }) => {
        console.log(`Auth completed for shop: ${session.shop}`);
      },
    },
    future: {
      unstable_newEmbeddedAuthStrategy: true,
    },
  });

  return _shopify;
}

// Create the Shopify app instance for this request
export async function createShopifyApp(env: Env, _request?: Request) {
  setupDb(env);
  return getShopify();
}

// Helper to extract env from Remix context with proper typing
export function getEnvFromContext(context: { cloudflare?: { env?: Env } }): Env {
  const env = context.cloudflare?.env;
  if (!env) {
    throw new Error("Environment not available in context");
  }
  return env;
}

export type ShopifyApp = ReturnType<typeof getShopify>;
