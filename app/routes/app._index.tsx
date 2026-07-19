import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  Button,
  Banner,
  Divider,
} from "@shopify/polaris";
import { createShopifyApp, getEnvFromContext } from "~/shopify.server";
import { getShopByDomain } from "~/models/shop.server";
import { getProductMappingStats } from "~/models/product-mapping.server";
import { getQueueStats, getRecentQueueActivity } from "~/models/queue-log.server";
import { getLatestSyncLog, getSyncSummary } from "~/models/sync-log.server";
import { getQueueSummary, formatPrintTime } from "~/services/simplyprint-api.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const env = getEnvFromContext(context);
  const shopify = await createShopifyApp(env, request);

  const { session } = await shopify.authenticate.admin(request);
  const shop = await getShopByDomain(env.DB, session.shop);

  if (!shop) {
    return json({
      shop: null,
      productStats: null,
      queueStats: null,
      recentActivity: null,
      lastSync: null,
      syncSummary: null,
      hasSimplyPrintCredentials: false,
      simplyPrintQueue: null,
    });
  }

  const updatedShop = shop;

  const [productStats, queueStats, recentActivity, lastSync, syncSummary] =
    await Promise.all([
      getProductMappingStats(env.DB, updatedShop.id),
      getQueueStats(env.DB, updatedShop.id),
      getRecentQueueActivity(env.DB, updatedShop.id, 7),
      getLatestSyncLog(env.DB, updatedShop.id, "queue"),
      getSyncSummary(env.DB, updatedShop.id, 7),
    ]);

  // Fetch SimplyPrint queue if connected
  let simplyPrintQueue: { totalJobs: number; printTime: string } | null = null;
  if (updatedShop.simplyprint_api_key && updatedShop.simplyprint_company_id) {
    try {
      const summary = await getQueueSummary(
        updatedShop.simplyprint_api_key,
        updatedShop.simplyprint_company_id,
        env.ENCRYPTION_KEY
      );
      simplyPrintQueue = {
        totalJobs: summary.totalJobs,
        printTime: formatPrintTime(summary.totalPrintTime),
      };
    } catch (error) {
      console.error("Failed to fetch SimplyPrint queue:", error);
    }
  }

  return json({
    shop: {
      domain: updatedShop.shopify_domain,
      printsThisMonth: updatedShop.prints_this_month,
      mode: updatedShop.settings_mode,
    },
    productStats,
    queueStats,
    recentActivity: recentActivity.slice(0, 10),
    lastSync,
    syncSummary,
    hasSimplyPrintCredentials: Boolean(updatedShop.simplyprint_api_key),
    simplyPrintQueue,
  });
};

export default function Dashboard() {
  const {
    shop,
    productStats,
    queueStats,
    lastSync,
    hasSimplyPrintCredentials,
    simplyPrintQueue,
  } = useLoaderData<typeof loader>();

  const navigate = useNavigate();

  const getTimeSince = (timestamp: number | null) => {
    if (!timestamp) return "Never";
    const seconds = Math.floor(Date.now() / 1000 - timestamp);
    if (seconds < 60) return `${seconds} seconds ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
    return `${Math.floor(seconds / 86400)} days ago`;
  };

  return (
    <Page title="Dashboard">
      <style>{`
        .Polaris-Layout {
          align-items: stretch !important;
        }
        .Polaris-Layout__Section {
          display: flex;
          flex-direction: column;
        }
        .Polaris-Layout__Section > .Polaris-Card {
          flex: 1;
        }
      `}</style>
      <BlockStack gap="500">
        {!hasSimplyPrintCredentials && (
          <Banner
            title="Connect SimplyPrint"
            action={{ content: "Go to Settings", onAction: () => navigate("/app/settings") }}
            tone="warning"
          >
            <p>
              Connect your SimplyPrint account to start automatically adding prints to your queue when orders come in.
            </p>
          </Banner>
        )}

        <Layout>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Connection Status
                </Text>
                <InlineStack gap="200" align="start">
                  <Text as="span" variant="bodyMd">
                    SimplyPrint
                  </Text>
                  {hasSimplyPrintCredentials ? (
                    <Badge tone="success">Connected</Badge>
                  ) : (
                    <Badge tone="critical">Not Connected</Badge>
                  )}
                </InlineStack>
                <InlineStack gap="200" align="start">
                  <Text as="span" variant="bodyMd">
                    Mode
                  </Text>
                  <Badge tone="info">
                    {shop?.mode === "advanced" ? "Advanced" : "Simple"}
                  </Badge>
                </InlineStack>
                <InlineStack gap="200" align="start">
                  <Text as="span" variant="bodyMd">
                    Last Activity
                  </Text>
                  <Text as="span" variant="bodyMd" tone="subdued">
                    {lastSync ? getTimeSince(lastSync.created_at) : "Never"}
                  </Text>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  This Month
                </Text>
                <InlineStack gap="200" align="space-between">
                  <Text as="span" variant="bodyMd">
                    Prints queued
                  </Text>
                  <Text as="span" variant="bodyMd" fontWeight="semibold">
                    {shop?.printsThisMonth ?? 0}
                  </Text>
                </InlineStack>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Self-hosted, no print limits.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Product Mappings
                </Text>
                <InlineStack gap="400" align="start">
                  <BlockStack gap="100">
                    <Text as="span" variant="headingLg">
                      {productStats?.mapped || 0}
                    </Text>
                    <Text as="span" variant="bodyMd" tone="subdued">
                      Mapped
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text as="span" variant="headingLg">
                      {productStats?.unmapped || 0}
                    </Text>
                    <Text as="span" variant="bodyMd" tone="subdued">
                      Unmapped
                    </Text>
                  </BlockStack>
                </InlineStack>
                {productStats && productStats.unmapped > 0 && (
                  <Button onClick={() => navigate("/app/products")} variant="plain">
                    Map Products
                  </Button>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <Layout>
          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Queue Statistics
                </Text>
                <InlineStack gap="800" align="start">
                  <BlockStack gap="100">
                    <Text as="span" variant="headingLg">
                      {simplyPrintQueue?.printTime ?? "—"}
                    </Text>
                    <Text as="span" variant="bodyMd" tone="subdued">
                      Queue ({simplyPrintQueue?.totalJobs ?? 0} jobs)
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text as="span" variant="headingLg">
                      {queueStats?.totalPrints || 0}
                    </Text>
                    <Text as="span" variant="bodyMd" tone="subdued">
                      Sent from Shopify
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text as="span" variant="headingLg" tone="critical">
                      {queueStats?.failed || 0}
                    </Text>
                    <Text as="span" variant="bodyMd" tone="subdued">
                      Failed
                    </Text>
                  </BlockStack>
                </InlineStack>
                <Divider />
                <Button onClick={() => navigate("/app/queue")} variant="plain">
                  View Queue History
                </Button>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  How It Works
                </Text>
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd">
                    <strong>1.</strong> Connect your SimplyPrint account in Settings
                  </Text>
                  <Text as="p" variant="bodyMd">
                    <strong>2.</strong> Map your Shopify products to SimplyPrint files (use Auto-Map by EAN if your filenames contain the product barcode)
                  </Text>
                  <Text as="p" variant="bodyMd">
                    <strong>3.</strong> When an order is paid, prints are automatically added to your queue
                  </Text>
                </BlockStack>
                <Divider />
                <InlineStack gap="200">
                  <Button onClick={() => navigate("/app/products")} variant="primary">
                    Map Products
                  </Button>
                  <Button onClick={() => navigate("/app/settings")}>
                    Settings
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
