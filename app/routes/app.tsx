import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { createShopifyApp, getEnvFromContext, getCurrentApiKey } from "~/shopify.server";
import { getShopByDomain, upsertShop, updateShopEmail } from "~/models/shop.server";
import { ensureWebhooksRegistered } from "~/services/webhooks.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const env = getEnvFromContext(context);

  const shopify = await createShopifyApp(env, request);
  const { session, admin } = await shopify.authenticate.admin(request);

  // Ensure shop exists in our database and token is up to date
  if (session.shop && session.accessToken) {
    await upsertShop(env.DB, session.shop, session.accessToken);

    // Ensure webhooks are registered
    try {
      const webhookResult = await ensureWebhooksRegistered(
        session.shop,
        session.accessToken,
        env.SHOPIFY_APP_URL
      );
      if (webhookResult.failed.length > 0) {
        console.error("Failed to register some webhooks:", webhookResult.failed);
      }
    } catch (err) {
      console.error("Webhook registration error:", err);
    }
  }
  const shop = await getShopByDomain(env.DB, session.shop);

  // Capture shop email/owner name if not already stored
  if (shop && !shop.shop_email) {
    try {
      const response = await admin.graphql(`query { shop { email shopOwnerName } }`);
      const data = await response.json();
      if (data.data?.shop?.email) {
        await updateShopEmail(env.DB, shop.id, data.data.shop.email, data.data.shop.shopOwnerName || '');
      }
    } catch (error) {
      console.error("Failed to fetch shop email:", error);
    }
  }

  return json({
    apiKey: getCurrentApiKey(),
    shop: session.shop,
    hasSimplyPrintCredentials: Boolean(shop?.simplyprint_api_key),
  });
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Dashboard
        </Link>
        <Link to="/app/products">Products</Link>
        <Link to="/app/queue">Queue History</Link>
        <Link to="/app/logs">Sync Logs</Link>
        <Link to="/app/settings">Settings</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  console.error("App error:", error);

  return (
    <div style={{ padding: "2rem", fontFamily: "system-ui" }}>
      <h1>Something went wrong</h1>
      <p>
        We encountered an error loading the app. Please try refreshing the page
        or contact support if the problem persists.
      </p>
      <pre style={{ background: "#f5f5f5", padding: "1rem", overflow: "auto" }}>
        {error instanceof Error ? error.message : "Unknown error"}
      </pre>
    </div>
  );
}
