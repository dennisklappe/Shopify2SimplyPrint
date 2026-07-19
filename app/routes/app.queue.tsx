import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { useLoaderData, useSubmit, useNavigation, useActionData } from "@remix-run/react";
import { useState, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  IndexTable,
  EmptyState,
  Tooltip,
  TextField,
  Button,
  Banner,
} from "@shopify/polaris";
import { createShopifyApp, getEnvFromContext } from "~/shopify.server";
import { getShopByDomain } from "~/models/shop.server";
import { getQueueLogsByShop, getQueueStats } from "~/models/queue-log.server";
import { processOrderForQueue, type OrderInfo } from "~/services/queue.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const env = getEnvFromContext(context);
  const shopify = await createShopifyApp(env, request);

  const { session } = await shopify.authenticate.admin(request);
  const shop = await getShopByDomain(env.DB, session.shop);

  if (!shop) {
    return json({ logs: [], stats: null, hasSimplyPrint: false });
  }

  const [logs, stats] = await Promise.all([
    getQueueLogsByShop(env.DB, shop.id, 100),
    getQueueStats(env.DB, shop.id),
  ]);

  return json({ logs, stats, hasSimplyPrint: Boolean(shop.simplyprint_api_key) });
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const env = getEnvFromContext(context);
  const shopify = await createShopifyApp(env, request);

  const { session } = await shopify.authenticate.admin(request);
  const shop = await getShopByDomain(env.DB, session.shop);

  if (!shop) {
    return json({ error: "Shop not found" }, { status: 404 });
  }

  const formData = await request.formData();
  const orderNumber = formData.get("orderNumber") as string;

  if (!orderNumber) {
    return json({ error: "Order number is required" }, { status: 400 });
  }

  if (!shop.simplyprint_api_key) {
    return json({ error: "SimplyPrint not connected" }, { status: 400 });
  }

  // Fetch order from Shopify by order number
  const query = `
    query getOrderByName($query: String!) {
      orders(first: 1, query: $query) {
        edges {
          node {
            id
            name
            lineItems(first: 50) {
              edges {
                node {
                  id
                  variant { id }
                  product { id }
                  title
                  variantTitle
                  quantity
                  sku
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch(
      `https://${session.shop}/admin/api/2025-10/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": session.accessToken!,
        },
        body: JSON.stringify({
          query,
          variables: { query: `name:${orderNumber}` },
        }),
      }
    );

    if (!response.ok) {
      return json({ error: `Shopify API error: ${response.status}` }, { status: 500 });
    }

    const result = (await response.json()) as {
      data?: {
        orders?: {
          edges: Array<{
            node: {
              id: string;
              name: string;
              lineItems: {
                edges: Array<{
                  node: {
                    id: string;
                    variant: { id: string } | null;
                    product: { id: string } | null;
                    title: string;
                    variantTitle: string | null;
                    quantity: number;
                    sku: string | null;
                  };
                }>;
              };
            };
          }>;
        };
      };
    };

    const orderData = result.data?.orders?.edges?.[0]?.node;
    if (!orderData) {
      return json({ error: `Order #${orderNumber} not found` }, { status: 404 });
    }

    const extractId = (gid: string) => gid.split("/").pop() || gid;

    const order: OrderInfo = {
      id: extractId(orderData.id),
      orderNumber: orderData.name.replace("#", ""),
      lineItems: orderData.lineItems.edges.map((edge) => ({
        id: extractId(edge.node.id),
        variantId: edge.node.variant ? extractId(edge.node.variant.id) : "",
        productId: edge.node.product ? extractId(edge.node.product.id) : "",
        title: edge.node.title,
        variantTitle: edge.node.variantTitle,
        quantity: edge.node.quantity,
        sku: edge.node.sku,
      })),
    };

    const processResult = await processOrderForQueue(env.DB, shop, order, env.ENCRYPTION_KEY);

    if (processResult.success) {
      return json({
        success: true,
        message: `Order ${orderData.name}: ${processResult.itemsQueued} queued, ${processResult.itemsSkipped} skipped`,
      });
    } else {
      return json({
        error: `Failed: ${processResult.errors.join(", ")}`,
      }, { status: 500 });
    }
  } catch (error) {
    return json({
      error: error instanceof Error ? error.message : "Unknown error",
    }, { status: 500 });
  }
};

export default function Queue() {
  const { logs, stats, hasSimplyPrint } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();

  const [orderNumber, setOrderNumber] = useState("");
  const [buttonState, setButtonState] = useState<"idle" | "processing" | "done">("idle");

  // Handle order processing feedback
  useEffect(() => {
    if (navigation.state === "submitting") {
      setButtonState("processing");
    } else if (buttonState === "processing" && navigation.state === "idle") {
      setButtonState("done");
      if (actionData && "success" in actionData && actionData.success) {
        setOrderNumber("");
      }
      setTimeout(() => setButtonState("idle"), 2000);
    }
  }, [navigation.state, actionData, buttonState]);

  const handleProcessOrder = () => {
    if (orderNumber.trim()) {
      submit({ orderNumber: orderNumber.trim() }, { method: "post" });
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString();
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "queued":
        return <Badge tone="info">Queued</Badge>;
      case "printing":
        return <Badge tone="warning">Printing</Badge>;
      case "completed":
        return <Badge tone="success">Completed</Badge>;
      case "failed":
        return <Badge tone="critical">Failed</Badge>;
      case "skipped":
        return <Badge>Skipped</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const truncateText = (text: string, maxLength: number = 30) => {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + "...";
  };

  const formatStockChange = (quantityOrdered: number, printsQueued: number, inventoryAdjusted: number) => {
    // Stock decreases by quantity ordered, increases by inventory adjusted (prints * yield)
    const consumed = quantityOrdered;
    const added = inventoryAdjusted;
    const net = added - consumed;

    if (net === 0) return "±0";
    return net > 0 ? `+${net}` : `${net}`;
  };

  const resourceName = {
    singular: "queue entry",
    plural: "queue entries",
  };

  const rowMarkup = logs.map((log, index) => {
    const productTitle = log.shopify_product_title || "Unknown";
    const truncatedTitle = truncateText(productTitle, 35);
    const needsTooltip = productTitle.length > 35;
    const stockChange = formatStockChange(log.quantity_ordered, log.prints_queued, log.inventory_adjusted);

    return (
      <IndexTable.Row id={String(log.id)} key={log.id} position={index}>
        <IndexTable.Cell>
          <Text variant="bodyMd" fontWeight="bold" as="span">
            #{log.shopify_order_number || log.shopify_order_id}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          {needsTooltip ? (
            <Tooltip content={productTitle}>
              <Text as="span" variant="bodyMd">{truncatedTitle}</Text>
            </Tooltip>
          ) : (
            productTitle
          )}
        </IndexTable.Cell>
        <IndexTable.Cell>
          {log.quantity_ordered}
        </IndexTable.Cell>
        <IndexTable.Cell>
          {log.prints_queued}
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" tone={stockChange.startsWith("+") ? "success" : stockChange.startsWith("-") ? "critical" : "subdued"}>
            {stockChange}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          {getStatusBadge(log.status)}
        </IndexTable.Cell>
        <IndexTable.Cell>
          {log.skip_reason || log.error_message || "-"}
        </IndexTable.Cell>
        <IndexTable.Cell>
          {formatDate(log.created_at)}
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page title="Queue History">
      <BlockStack gap="500">
        {stats && (
          <Layout>
            <Layout.Section variant="oneThird">
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">Total Prints</Text>
                  <Text as="p" variant="headingLg">{stats.totalPrints || 0}</Text>
                </BlockStack>
              </Card>
            </Layout.Section>
            <Layout.Section variant="oneThird">
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">Successful</Text>
                  <InlineStack gap="200">
                    <Text as="p" variant="headingLg">{stats.queued + stats.completed}</Text>
                    <Badge tone="success">
                      {stats.total > 0 ? Math.round(((stats.queued + stats.completed) / stats.total) * 100) : 0}%
                    </Badge>
                  </InlineStack>
                </BlockStack>
              </Card>
            </Layout.Section>
            <Layout.Section variant="oneThird">
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">Process Order</Text>
                  <InlineStack gap="200" blockAlign="end">
                    <div style={{ flex: 1 }}>
                      <TextField
                        label=""
                        labelHidden
                        value={orderNumber}
                        onChange={setOrderNumber}
                        placeholder="Order #"
                        autoComplete="off"
                        size="slim"
                      />
                    </div>
                    <Button
                      onClick={handleProcessOrder}
                      loading={buttonState === "processing"}
                      disabled={!orderNumber.trim() || !hasSimplyPrint || buttonState !== "idle"}
                      tone={buttonState === "done" ? "success" : undefined}
                      size="slim"
                    >
                      {buttonState === "processing" ? "..." : buttonState === "done" ? "Done!" : "Go"}
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>
        )}

        {actionData && "error" in actionData && (
          <Banner tone="critical" title="Error">
            {actionData.error}
          </Banner>
        )}

        {actionData && "success" in actionData && actionData.success && (
          <Banner tone="success" title="Success">
            {actionData.message}
          </Banner>
        )}

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Recent Queue Activity
            </Text>

            {logs.length === 0 ? (
              <EmptyState
                heading="No queue activity yet"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>
                  When orders come in, prints will be automatically added to your SimplyPrint queue.
                </p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={resourceName}
                itemCount={logs.length}
                headings={[
                  { title: "Order" },
                  { title: "Product" },
                  { title: "Qty" },
                  { title: "Prints" },
                  { title: "Stock Δ" },
                  { title: "Status" },
                  { title: "Notes" },
                  { title: "Date" },
                ]}
                selectable={false}
              >
                {rowMarkup}
              </IndexTable>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
