import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  Badge,
  IndexTable,
  EmptyState,
} from "@shopify/polaris";
import { createShopifyApp, getEnvFromContext } from "~/shopify.server";
import { getShopByDomain } from "~/models/shop.server";
import { getSyncLogsByShop } from "~/models/sync-log.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const env = getEnvFromContext(context);
  const shopify = await createShopifyApp(env, request);

  const { session } = await shopify.authenticate.admin(request);
  const shop = await getShopByDomain(env.DB, session.shop);

  if (!shop) {
    return json({ logs: [] });
  }

  const logs = await getSyncLogsByShop(env.DB, shop.id, 100);

  return json({ logs });
};

export default function Logs() {
  const { logs } = useLoaderData<typeof loader>();

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString();
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "success":
        return <Badge tone="success">Success</Badge>;
      case "partial":
        return <Badge tone="warning">Partial</Badge>;
      case "error":
        return <Badge tone="critical">Error</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const resourceName = {
    singular: "sync log",
    plural: "sync logs",
  };

  const rowMarkup = logs.map((log, index) => (
    <IndexTable.Row id={String(log.id)} key={log.id} position={index}>
      <IndexTable.Cell>
        <Text variant="bodyMd" fontWeight="bold" as="span">
          {log.sync_type}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {getStatusBadge(log.status)}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {log.message || "-"}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {log.items_processed}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {log.items_created}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {log.items_failed}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {log.duration_ms ? `${log.duration_ms}ms` : "-"}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {formatDate(log.created_at)}
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page title="Sync Logs">
      <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingMd">
            Recent Sync Activity
          </Text>

          {logs.length === 0 ? (
            <EmptyState
              heading="No sync logs yet"
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>
                Sync logs will appear here when orders are processed.
              </p>
            </EmptyState>
          ) : (
            <IndexTable
              resourceName={resourceName}
              itemCount={logs.length}
              headings={[
                { title: "Type" },
                { title: "Status" },
                { title: "Message" },
                { title: "Processed" },
                { title: "Created" },
                { title: "Failed" },
                { title: "Duration" },
                { title: "Date" },
              ]}
              selectable={false}
            >
              {rowMarkup}
            </IndexTable>
          )}
        </BlockStack>
      </Card>
    </Page>
  );
}
