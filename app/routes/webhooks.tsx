import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { createShopifyApp, getEnvFromContext, setupDb } from "~/shopify.server";
import { getShopByDomain, deactivateShop } from "~/models/shop.server";
import { processOrderForQueue, type OrderInfo } from "~/services/queue.server";

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const env = getEnvFromContext(context);

  // Initialize DB first
  setupDb(env);

  // Log that we received a webhook request
  const shopHeader = request.headers.get("X-Shopify-Shop-Domain");
  const topicHeader = request.headers.get("X-Shopify-Topic");
  console.log(`Webhook request received: topic=${topicHeader}, shop=${shopHeader}`);

  const shopify = await createShopifyApp(env, request);

  try {
    const { topic, shop: shopDomain, payload } = await shopify.authenticate.webhook(request);

    console.log(`Webhook authenticated successfully: ${topic} for ${shopDomain}`);

    switch (topic) {
      case "APP_UNINSTALLED": {
        await deactivateShop(env.DB, shopDomain);
        console.log(`Shop deactivated: ${shopDomain}`);
        break;
      }

      case "ORDERS_PAID":
      case "ORDERS_CREATE": {
        // Parse order from payload
        const orderData = payload as {
          id: number;
          order_number: string;
          financial_status: string;
          line_items: Array<{
            id: number;
            variant_id: number;
            product_id: number;
            title: string;
            variant_title: string | null;
            quantity: number;
            sku: string | null;
          }>;
        };

        // For ORDERS_CREATE, only process if order is already paid (imported from marketplace)
        // Native orders will be unpaid at creation and processed later by ORDERS_PAID
        if (topic === "ORDERS_CREATE" && orderData.financial_status !== "paid") {
          console.log(`Order ${orderData.order_number} created but not paid (${orderData.financial_status}), skipping`);
          break;
        }

        const shop = await getShopByDomain(env.DB, shopDomain);
        if (!shop) {
          console.log(`Shop not found for ${topic} webhook: ${shopDomain}`);
          break;
        }

        if (!shop.simplyprint_api_key) {
          console.log(`SimplyPrint not connected for shop: ${shopDomain}`);
          break;
        }

        const order: OrderInfo = {
          id: String(orderData.id),
          orderNumber: String(orderData.order_number),
          lineItems: orderData.line_items.map((item) => ({
            id: String(item.id),
            variantId: String(item.variant_id),
            productId: String(item.product_id),
            title: item.title,
            variantTitle: item.variant_title,
            quantity: item.quantity,
            sku: item.sku,
          })),
        };

        const result = await processOrderForQueue(env.DB, shop, order, env.ENCRYPTION_KEY);
        console.log(`Order ${order.orderNumber} processed via ${topic}:`, result);
        break;
      }

      case "INVENTORY_LEVELS_UPDATE": {
        // For future: could trigger queue additions based on inventory changes
        console.log(`Inventory update for ${shopDomain}`);
        break;
      }

      case "CUSTOMERS_DATA_REQUEST":
      case "CUSTOMERS_REDACT":
      case "SHOP_REDACT": {
        // GDPR compliance webhooks - log and acknowledge
        console.log(`GDPR webhook: ${topic} for ${shopDomain}`);
        break;
      }

      default: {
        console.log(`Unhandled webhook topic: ${topic}`);
      }
    }

    return json({ success: true });
  } catch (error) {
    // authenticate.webhook throws a Response (e.g. 401) for invalid HMAC, so pass it through
    if (error instanceof Response) {
      console.error(`Webhook authentication failed: ${error.status} for ${topicHeader} from ${shopHeader}`);
      return error;
    }
    console.error("Webhook error:", error);
    console.error("Webhook error details:", {
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
      shop: shopHeader,
      topic: topicHeader,
    });
    return json(
      { error: error instanceof Error ? error.message : "Webhook processing failed" },
      { status: 500 }
    );
  }
};
