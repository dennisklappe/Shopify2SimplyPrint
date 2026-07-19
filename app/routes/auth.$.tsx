import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { createShopifyApp, getEnvFromContext } from "~/shopify.server";
import { upsertShop } from "~/models/shop.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const env = getEnvFromContext(context);

  const shopify = await createShopifyApp(env, request);

  // Let the library handle everything - it will redirect to OAuth or handle callback
  const { session } = await shopify.authenticate.admin(request);

  if (session?.shop && session?.accessToken) {
    await upsertShop(env.DB, session.shop, session.accessToken);
  }

  return null;
};
