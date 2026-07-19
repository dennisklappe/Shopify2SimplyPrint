import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { redirect } from "@remix-run/cloudflare";

// Redirect root to app - auth is handled by the app route
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // If embedded or has id_token, go directly to /app which handles auth
  const embedded = url.searchParams.get("embedded");
  const idToken = url.searchParams.get("id_token");

  if (embedded || idToken) {
    // Preserve all query params for the app route
    return redirect(`/app${url.search}`);
  }

  const shop = url.searchParams.get("shop");

  // If we have a shop but not embedded, go through auth
  if (shop) {
    return redirect(`/auth?shop=${shop}`);
  }

  // Otherwise go to app
  return redirect("/app");
};
