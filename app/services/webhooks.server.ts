// Webhook registration service
// Ensures webhooks are registered for the shop

interface WebhookSubscription {
  id: string;
  topic: string;
  callbackUrl: string;
}

interface WebhookCheckResult {
  registered: string[];
  missing: string[];
  success: boolean;
}

const REQUIRED_WEBHOOKS = [
  "ORDERS_PAID",
  "ORDERS_CREATE",
  "APP_UNINSTALLED",
  "INVENTORY_LEVELS_UPDATE",
];

// Check which webhooks are registered
export async function checkWebhooks(
  shopDomain: string,
  accessToken: string,
  appUrl: string
): Promise<WebhookCheckResult> {
  const query = `
    query {
      webhookSubscriptions(first: 20) {
        edges {
          node {
            id
            topic
            endpoint {
              __typename
              ... on WebhookHttpEndpoint {
                callbackUrl
              }
            }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch(
      `https://${shopDomain}/admin/api/2025-10/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query }),
      }
    );

    if (!response.ok) {
      console.error("Failed to check webhooks:", response.status);
      return { registered: [], missing: REQUIRED_WEBHOOKS, success: false };
    }

    const result = (await response.json()) as {
      data?: {
        webhookSubscriptions?: {
          edges: Array<{
            node: {
              id: string;
              topic: string;
              endpoint: {
                __typename: string;
                callbackUrl?: string;
              };
            };
          }>;
        };
      };
    };

    const subscriptions = result.data?.webhookSubscriptions?.edges || [];
    const expectedCallbackUrl = `${appUrl}/webhooks`;

    const registered: string[] = [];
    const missing: string[] = [];

    for (const topic of REQUIRED_WEBHOOKS) {
      const found = subscriptions.find(
        (s) =>
          s.node.topic === topic &&
          s.node.endpoint?.callbackUrl === expectedCallbackUrl
      );
      if (found) {
        registered.push(topic);
      } else {
        missing.push(topic);
      }
    }

    return { registered, missing, success: true };
  } catch (error) {
    console.error("Error checking webhooks:", error);
    return { registered: [], missing: REQUIRED_WEBHOOKS, success: false };
  }
}

// Register a single webhook
async function registerWebhook(
  shopDomain: string,
  accessToken: string,
  topic: string,
  callbackUrl: string
): Promise<{ success: boolean; error?: string }> {
  const mutation = `
    mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
        webhookSubscription {
          id
          topic
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    const response = await fetch(
      `https://${shopDomain}/admin/api/2025-10/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: mutation,
          variables: {
            topic,
            webhookSubscription: {
              callbackUrl,
              format: "JSON",
            },
          },
        }),
      }
    );

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const result = (await response.json()) as {
      data?: {
        webhookSubscriptionCreate?: {
          webhookSubscription?: { id: string };
          userErrors?: Array<{ field: string; message: string }>;
        };
      };
    };

    const errors = result.data?.webhookSubscriptionCreate?.userErrors;
    if (errors && errors.length > 0) {
      return { success: false, error: errors.map((e) => e.message).join(", ") };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Ensure all required webhooks are registered
export async function ensureWebhooksRegistered(
  shopDomain: string,
  accessToken: string,
  appUrl: string
): Promise<{ success: boolean; registered: string[]; failed: string[] }> {
  const check = await checkWebhooks(shopDomain, accessToken, appUrl);

  if (check.missing.length === 0) {
    console.log(`All webhooks already registered for ${shopDomain}`);
    return { success: true, registered: check.registered, failed: [] };
  }

  console.log(`Registering missing webhooks for ${shopDomain}:`, check.missing);

  const callbackUrl = `${appUrl}/webhooks`;
  const registered: string[] = [...check.registered];
  const failed: string[] = [];

  for (const topic of check.missing) {
    const result = await registerWebhook(
      shopDomain,
      accessToken,
      topic,
      callbackUrl
    );
    if (result.success) {
      registered.push(topic);
      console.log(`Registered webhook: ${topic}`);
    } else {
      failed.push(topic);
      console.error(`Failed to register webhook ${topic}:`, result.error);
    }
  }

  return {
    success: failed.length === 0,
    registered,
    failed,
  };
}
