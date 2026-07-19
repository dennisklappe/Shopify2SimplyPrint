import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { useLoaderData, useSubmit, useNavigation, useActionData, useNavigate } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  TextField,
  Button,
  Banner,
  Badge,
  Select,
  Checkbox,
  Divider,
  Box,
} from "@shopify/polaris";
import { createShopifyApp, getEnvFromContext } from "~/shopify.server";
import { getShopByDomain, getShopById, updateShopSimplyPrintCredentials, updateShopSettings, clearSimplyPrintCredentials, markSimplyprintConnected } from "~/models/shop.server";
import { testConnection, getQueueGroups } from "~/services/simplyprint-api.server";
import { encrypt } from "~/lib/encryption.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const env = getEnvFromContext(context);
  const shopify = await createShopifyApp(env, request);

  const { session } = await shopify.authenticate.admin(request);
  const shop = await getShopByDomain(env.DB, session.shop);

  if (!shop) {
    return json({ shop: null, queueGroups: [] as { id: number; name: string }[] });
  }

  const updatedShop = shop;

  // Fetch queue groups if SimplyPrint is connected
  let queueGroups: { id: number; name: string }[] = [];
  if (updatedShop.simplyprint_api_key && updatedShop.simplyprint_company_id) {
    queueGroups = await getQueueGroups(
      updatedShop.simplyprint_api_key,
      updatedShop.simplyprint_company_id,
      env.ENCRYPTION_KEY
    );
  }

  return json({
    shop: {
      id: updatedShop.id,
      domain: updatedShop.shopify_domain,
      hasSimplyPrint: Boolean(updatedShop.simplyprint_api_key),
      companyId: updatedShop.simplyprint_company_id || "",
      mode: updatedShop.settings_mode || "simple",
      defaultThreshold: updatedShop.settings_default_threshold || 100,
      defaultYield: updatedShop.settings_default_yield || 1,
      filamentColorEnabled: Boolean(updatedShop.settings_filament_color),
      queueGroup: updatedShop.simplyprint_queue_group,
    },
    queueGroups,
  });
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
  const action = formData.get("action");

  if (action === "save_simplyprint") {
    const apiKey = formData.get("apiKey") as string;
    const companyId = formData.get("companyId") as string;

    if (!apiKey || !companyId) {
      return json({ error: "API key and Company ID are required" }, { status: 400 });
    }

    // Test the connection first
    const encryptedKey = await encrypt(apiKey, env.ENCRYPTION_KEY);
    const testResult = await testConnection(encryptedKey, companyId, env.ENCRYPTION_KEY);

    if (!testResult.success) {
      return json({ error: `Connection failed: ${testResult.error}` }, { status: 400 });
    }

    // Save credentials
    await updateShopSimplyPrintCredentials(env.DB, shop.id, encryptedKey, companyId);
    await markSimplyprintConnected(env.DB, shop.id);

    return json({ success: true, message: "SimplyPrint connected successfully!" });
  }

  if (action === "disconnect_simplyprint") {
    await clearSimplyPrintCredentials(env.DB, shop.id);
    return json({ success: true, message: "SimplyPrint disconnected" });
  }

  if (action === "save_settings") {
    const mode = formData.get("mode") as "simple" | "advanced";
    const defaultThreshold = parseInt(formData.get("defaultThreshold") as string) || 100;
    const defaultYield = parseInt(formData.get("defaultYield") as string) || 1;
    const filamentColorEnabled = formData.get("filamentColorEnabled") === "true";
    const queueGroupRaw = formData.get("queueGroup") as string;
    const queueGroup = queueGroupRaw ? parseInt(queueGroupRaw) : null;

    await updateShopSettings(env.DB, shop.id, {
      mode,
      default_threshold: defaultThreshold,
      default_yield: defaultYield,
      filament_color_enabled: filamentColorEnabled,
      queue_group: queueGroup,
    });

    return json({ success: true, message: "Settings saved successfully!" });
  }

  return json({ error: "Unknown action" }, { status: 400 });
};

export default function Settings() {
  const { shop, queueGroups } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const isLoading = navigation.state === "submitting";

  const [apiKey, setApiKey] = useState("");
  const [companyId, setCompanyId] = useState(shop?.companyId || "");
  const [mode, setMode] = useState(shop?.mode || "simple");
  const [defaultThreshold, setDefaultThreshold] = useState(String(shop?.defaultThreshold || 100));
  const [defaultYield, setDefaultYield] = useState(String(shop?.defaultYield || 1));
  const [filamentColorEnabled, setFilamentColorEnabled] = useState(shop?.filamentColorEnabled || false);
  const [queueGroup, setQueueGroup] = useState(shop?.queueGroup != null ? String(shop.queueGroup) : "");

  const handleSaveSimplyPrint = () => {
    submit({ action: "save_simplyprint", apiKey, companyId }, { method: "post" });
  };

  const handleDisconnect = () => {
    if (confirm("Are you sure you want to disconnect SimplyPrint?")) {
      submit({ action: "disconnect_simplyprint" }, { method: "post" });
    }
  };

  const handleSaveSettings = () => {
    submit(
      { action: "save_settings", mode, defaultThreshold, defaultYield: mode === "simple" ? "1" : defaultYield, filamentColorEnabled: String(filamentColorEnabled), queueGroup },
      { method: "post" }
    );
  };

  const modeOptions = [
    { label: "Simple - Queue prints for every order", value: "simple" },
    { label: "Advanced - Only queue when stock is below threshold", value: "advanced" },
  ];

  return (
    <Page title="Settings" backAction={{ content: "Back", onAction: () => navigate("/app") }}>
      <BlockStack gap="500">
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

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  SimplyPrint Connection
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Connect your SimplyPrint account to automatically add prints to your queue.
                  Get your API key from{" "}
                  <a href="https://simplyprint.io/panel/user_settings/api" target="_blank" rel="noopener noreferrer">
                    SimplyPrint Settings
                  </a>.
                </Text>

                {shop?.hasSimplyPrint ? (
                  <BlockStack gap="300">
                    <InlineStack gap="200" align="start">
                      <Badge tone="success">Connected</Badge>
                      <Text as="span" variant="bodyMd" tone="subdued">
                        Company ID: {shop.companyId}
                      </Text>
                    </InlineStack>
                    <Button tone="critical" onClick={handleDisconnect}>
                      Disconnect
                    </Button>
                  </BlockStack>
                ) : (
                  <BlockStack gap="300">
                    <TextField
                      label="API Key"
                      value={apiKey}
                      onChange={setApiKey}
                      type="password"
                      autoComplete="off"
                      helpText="Your SimplyPrint API key"
                    />
                    <TextField
                      label="Company ID"
                      value={companyId}
                      onChange={setCompanyId}
                      autoComplete="off"
                      helpText="Your SimplyPrint company/organization ID"
                    />
                    <Button
                      variant="primary"
                      onClick={handleSaveSimplyPrint}
                      loading={isLoading}
                      disabled={!apiKey || !companyId}
                    >
                      Connect SimplyPrint
                    </Button>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Queue Settings
                </Text>

                <Select
                  label="Operation Mode"
                  options={modeOptions}
                  value={mode}
                  onChange={setMode}
                  helpText={
                    mode === "simple"
                      ? "Every order will add prints to the queue based on quantity and yield"
                      : "Only add prints when inventory falls below the threshold"
                  }
                />

                {mode === "advanced" && (
                  <TextField
                    label="Default Yield per Print"
                    type="number"
                    value={defaultYield}
                    onChange={setDefaultYield}
                    min={1}
                    max={10}
                    autoComplete="off"
                    helpText="Default number of items produced per print job (can be overridden per product)"
                  />
                )}

                {mode === "advanced" && (
                  <TextField
                    label="Default Stock Threshold"
                    type="number"
                    value={defaultThreshold}
                    onChange={setDefaultThreshold}
                    min={1}
                    autoComplete="off"
                    helpText="Only queue prints when stock falls below this level (can be overridden per product)"
                  />
                )}

                <Divider />

                <Checkbox
                  label="Enable filament color"
                  checked={filamentColorEnabled}
                  onChange={setFilamentColorEnabled}
                  helpText="Show a filament color column on the Products page. Colors are auto-filled from variant names and passed to SimplyPrint when queueing prints. When disabled, prints will use the filament color configured on the file in SimplyPrint."
                />

                {queueGroups && queueGroups.length > 0 && (
                  <>
                    <Divider />
                    <Select
                      label="Print Queue Group"
                      options={[
                        { label: "None (default)", value: "" },
                        ...queueGroups.map((g) => ({
                          label: g.name,
                          value: String(g.id),
                        })),
                      ]}
                      value={queueGroup}
                      onChange={setQueueGroup}
                      helpText="Select which SimplyPrint queue group new print jobs should be added to"
                    />
                  </>
                )}

                <Button onClick={handleSaveSettings} loading={isLoading}>
                  Save Settings
                </Button>
              </BlockStack>
            </Card>
          </Layout.Section>

        </Layout>
      </BlockStack>
    </Page>
  );
}
