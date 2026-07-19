import type { Shop } from "~/models/shop.server";
import { getShopSettings, incrementPrintCount } from "~/models/shop.server";
import {
  getProductMappingByVariant,
  adjustProductStock,
  setProductStock,
  type ProductMapping,
} from "~/models/product-mapping.server";
import {
  createQueueLog,
  hasOrderBeenQueued,
} from "~/models/queue-log.server";
import { createSyncLog } from "~/models/sync-log.server";
import { addToQueue } from "./simplyprint-api.server";
import {
  getFileMappingsByProductMapping,
} from "~/models/product-file-mapping.server";

export interface OrderLineItem {
  id: string;
  variantId: string;
  productId: string;
  title: string;
  variantTitle: string | null;
  quantity: number;
  sku: string | null;
}

export interface OrderInfo {
  id: string;
  orderNumber: string;
  lineItems: OrderLineItem[];
}

export interface QueueResult {
  success: boolean;
  itemsProcessed: number;
  itemsQueued: number;
  itemsSkipped: number;
  itemsFailed: number;
  printsAdded: number;
  errors: string[];
  details: Array<{
    lineItemId: string;
    title: string;
    status: "queued" | "skipped" | "failed";
    printsQueued?: number;
    reason?: string;
  }>;
}

// Get current inventory level and inventory item ID for a variant
async function getInventoryInfo(
  shopDomain: string,
  accessToken: string,
  variantId: string
): Promise<{ quantity: number | null; inventoryItemId: string | null; locationId: string | null; tracked: boolean }> {
  const query = `
    query getInventory($id: ID!) {
      productVariant(id: $id) {
        inventoryQuantity
        inventoryItem {
          id
          tracked
          inventoryLevels(first: 1) {
            edges {
              node {
                id
                location {
                  id
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
      `https://${shopDomain}/admin/api/2025-10/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query,
          variables: { id: `gid://shopify/ProductVariant/${variantId}` },
        }),
      }
    );

    if (!response.ok) return { quantity: null, inventoryItemId: null, locationId: null, tracked: false };

    const result = (await response.json()) as {
      data?: {
        productVariant?: {
          inventoryQuantity?: number;
          inventoryItem?: {
            id: string;
            tracked?: boolean;
            inventoryLevels?: {
              edges: Array<{
                node: {
                  id: string;
                  location: { id: string };
                };
              }>;
            };
          };
        };
      };
    };

    const variant = result.data?.productVariant;
    const inventoryLevel = variant?.inventoryItem?.inventoryLevels?.edges?.[0]?.node;

    return {
      quantity: variant?.inventoryQuantity ?? null,
      inventoryItemId: variant?.inventoryItem?.id ?? null,
      locationId: inventoryLevel?.location?.id ?? null,
      tracked: variant?.inventoryItem?.tracked ?? false,
    };
  } catch {
    return { quantity: null, inventoryItemId: null, locationId: null, tracked: false };
  }
}

// Adjust inventory by a delta amount
async function adjustInventory(
  shopDomain: string,
  accessToken: string,
  inventoryItemId: string,
  locationId: string,
  delta: number,
  reason: string
): Promise<{ success: boolean; error?: string }> {
  const mutation = `
    mutation adjustInventory($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        userErrors {
          field
          message
        }
        inventoryAdjustmentGroup {
          id
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
            input: {
              reason,
              name: "available",
              changes: [
                {
                  inventoryItemId,
                  locationId,
                  delta,
                },
              ],
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
        inventoryAdjustQuantities?: {
          userErrors?: Array<{ field: string; message: string }>;
        };
      };
    };

    const errors = result.data?.inventoryAdjustQuantities?.userErrors;
    if (errors && errors.length > 0) {
      return { success: false, error: errors.map(e => e.message).join(", ") };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Legacy function for getting just the quantity
async function getInventoryLevel(
  shopDomain: string,
  accessToken: string,
  variantId: string
): Promise<number | null> {
  const info = await getInventoryInfo(shopDomain, accessToken, variantId);
  return info.quantity;
}

// Calculate how many prints to add based on mode (per-file)
function calculatePrintsToQueue(
  mode: "simple" | "advanced",
  quantityOrdered: number,
  qtyPerProduct: number,
  yieldPerPrint: number,
  currentStock: number | null,
  threshold: number
): { printsToQueue: number; reason?: string } {
  if (mode === "simple") {
    const prints = Math.ceil((quantityOrdered * qtyPerProduct) / yieldPerPrint);
    return { printsToQueue: prints };
  }

  // Advanced mode: Only queue if stock AFTER the order would be below threshold
  if (currentStock === null) {
    const prints = Math.ceil((quantityOrdered * qtyPerProduct) / yieldPerPrint);
    return { printsToQueue: prints, reason: "Could not fetch inventory, using simple mode" };
  }

  const stockAfterOrder = currentStock - quantityOrdered;

  if (stockAfterOrder >= threshold) {
    return { printsToQueue: 0, reason: `Stock after order (${stockAfterOrder}) still above threshold (${threshold})` };
  }

  const deficit = threshold - stockAfterOrder;
  const prints = Math.ceil((deficit * qtyPerProduct) / yieldPerPrint);

  return { printsToQueue: Math.max(0, prints) };
}

// Process an order and add items to print queue
export async function processOrderForQueue(
  db: D1Database,
  shop: Shop,
  order: OrderInfo,
  encryptionKey: string
): Promise<QueueResult> {
  const startTime = Date.now();
  const result: QueueResult = {
    success: true,
    itemsProcessed: 0,
    itemsQueued: 0,
    itemsSkipped: 0,
    itemsFailed: 0,
    printsAdded: 0,
    errors: [],
    details: [],
  };

  // Skip shops that have been deactivated (e.g. after app uninstall)
  if (shop.is_active !== 1) {
    result.success = false;
    result.errors.push("Shop is not active");
    return result;
  }

  // Check if we have SimplyPrint credentials
  if (!shop.simplyprint_api_key || !shop.simplyprint_company_id) {
    result.success = false;
    result.errors.push("SimplyPrint not connected");
    return result;
  }

  const settings = getShopSettings(shop);

  for (const lineItem of order.lineItems) {
    result.itemsProcessed++;

    // Get product mapping (variant-level)
    const mapping = await getProductMappingByVariant(db, shop.id, lineItem.variantId);
    if (!mapping) {
      result.itemsSkipped++;
      result.details.push({
        lineItemId: lineItem.id,
        title: lineItem.title,
        status: "skipped",
        reason: "No product mapping found",
      });
      await createQueueLog(db, {
        shop_id: shop.id,
        shopify_order_id: order.id,
        shopify_order_number: order.orderNumber,
        shopify_line_item_id: lineItem.id,
        shopify_product_title: lineItem.title,
        quantity_ordered: lineItem.quantity,
        prints_queued: 0,
        status: "skipped",
        skip_reason: "No product mapping found",
      });
      continue;
    }

    // Get file mappings for this variant
    const fileMappings = await getFileMappingsByProductMapping(db, mapping.id);
    if (fileMappings.length === 0) {
      result.itemsSkipped++;
      result.details.push({
        lineItemId: lineItem.id,
        title: lineItem.title,
        status: "skipped",
        reason: "No SimplyPrint file mapped",
      });
      await createQueueLog(db, {
        shop_id: shop.id,
        shopify_order_id: order.id,
        shopify_order_number: order.orderNumber,
        shopify_line_item_id: lineItem.id,
        product_mapping_id: mapping.id,
        shopify_product_title: lineItem.title,
        quantity_ordered: lineItem.quantity,
        prints_queued: 0,
        status: "skipped",
        skip_reason: "No SimplyPrint file mapped",
      });
      continue;
    }

    // Get inventory info (variant-level)
    const inventoryInfo = await getInventoryInfo(
      shop.shopify_domain,
      shop.shopify_access_token,
      lineItem.variantId
    );

    let currentStock: number | null;
    if (inventoryInfo.tracked) {
      currentStock = inventoryInfo.quantity;
      await setProductStock(db, shop.id, mapping.id, currentStock ?? 0, true);
    } else {
      currentStock = mapping.current_stock ?? 0;
      if (mapping.inventory_tracked === 1) {
        await setProductStock(db, shop.id, mapping.id, currentStock, false);
      }
    }

    const threshold = mapping.stock_threshold ?? settings.default_threshold;

    // In advanced mode, check stock once at variant level
    if (settings.mode === "advanced" && currentStock !== null) {
      const stockAfterOrder = currentStock - lineItem.quantity;
      if (stockAfterOrder >= threshold) {
        result.itemsSkipped++;
        const reason = `Stock after order (${stockAfterOrder}) still above threshold (${threshold})`;
        result.details.push({
          lineItemId: lineItem.id,
          title: lineItem.title,
          status: "skipped",
          reason,
        });
        await createQueueLog(db, {
          shop_id: shop.id,
          shopify_order_id: order.id,
          shopify_order_number: order.orderNumber,
          shopify_line_item_id: lineItem.id,
          product_mapping_id: mapping.id,
          shopify_product_title: lineItem.title,
          quantity_ordered: lineItem.quantity,
          prints_queued: 0,
          status: "skipped",
          skip_reason: reason,
        });
        if (!inventoryInfo.tracked) {
          await adjustProductStock(db, shop.id, mapping.id, -lineItem.quantity);
        }
        continue;
      }
    }

    // Queue each file
    let totalPrintsForItem = 0;
    let filesQueued = 0;
    let filesFailed = 0;
    const fileErrors: string[] = [];

    for (const fileMapping of fileMappings) {
      // Per-file dedup
      const alreadyQueued = await hasOrderBeenQueued(
        db, shop.id, order.id, lineItem.id, fileMapping.simplyprint_file_id
      );
      if (alreadyQueued) continue;

      const { printsToQueue } = calculatePrintsToQueue(
        settings.mode,
        lineItem.quantity,
        fileMapping.qty_per_product,
        fileMapping.yield_per_print,
        currentStock,
        threshold
      );

      if (printsToQueue === 0) continue;

      const queueResult = await addToQueue(
        shop.simplyprint_api_key,
        shop.simplyprint_company_id,
        encryptionKey,
        fileMapping.simplyprint_file_id,
        printsToQueue,
        {
          group: settings.queue_group ?? undefined,
          filamentColor: mapping.filament_color || undefined,
        }
      );

      if (queueResult.success) {
        filesQueued++;
        totalPrintsForItem += printsToQueue;

        await createQueueLog(db, {
          shop_id: shop.id,
          shopify_order_id: order.id,
          shopify_order_number: order.orderNumber,
          shopify_line_item_id: lineItem.id,
          product_mapping_id: mapping.id,
          shopify_product_title: lineItem.title,
          simplyprint_file_id: fileMapping.simplyprint_file_id,
          simplyprint_queue_item_id: queueResult.queueItemId,
          quantity_ordered: lineItem.quantity,
          prints_queued: printsToQueue,
          status: "queued",
        });
      } else {
        filesFailed++;
        fileErrors.push(`${fileMapping.simplyprint_file_name}: ${queueResult.error}`);

        await createQueueLog(db, {
          shop_id: shop.id,
          shopify_order_id: order.id,
          shopify_order_number: order.orderNumber,
          shopify_line_item_id: lineItem.id,
          product_mapping_id: mapping.id,
          shopify_product_title: lineItem.title,
          simplyprint_file_id: fileMapping.simplyprint_file_id,
          quantity_ordered: lineItem.quantity,
          prints_queued: 0,
          status: "failed",
          error_message: queueResult.error,
        });
      }
    }

    // Determine line item status
    if (filesQueued === 0 && filesFailed === 0) {
      // All files were already queued (dedup)
      result.itemsSkipped++;
      result.details.push({
        lineItemId: lineItem.id,
        title: lineItem.title,
        status: "skipped",
        reason: "Already queued",
      });
      continue;
    }

    if (filesFailed > 0 && filesQueued === 0) {
      result.itemsFailed++;
      result.errors.push(...fileErrors);
      result.details.push({
        lineItemId: lineItem.id,
        title: lineItem.title,
        status: "failed",
        reason: fileErrors.join("; "),
      });
    } else {
      // At least some files succeeded
      if (filesFailed > 0) {
        result.errors.push(...fileErrors);
      }
      result.itemsQueued++;
      result.printsAdded += totalPrintsForItem;

      result.details.push({
        lineItemId: lineItem.id,
        title: lineItem.title,
        status: "queued",
        printsQueued: totalPrintsForItem,
      });

      // Inventory adjustment: once per variant, after all files queued
      const inventoryIncrease = settings.mode === "advanced" && currentStock !== null
        ? (threshold - currentStock + lineItem.quantity)  // deficit
        : lineItem.quantity;

      if (inventoryInfo.tracked) {
        if (inventoryInfo.inventoryItemId && inventoryInfo.locationId) {
          const adjustResult = await adjustInventory(
            shop.shopify_domain,
            shop.shopify_access_token,
            inventoryInfo.inventoryItemId,
            inventoryInfo.locationId,
            inventoryIncrease,
            "correction"
          );
          if (!adjustResult.success) {
            result.errors.push(`Inventory adjustment failed for ${lineItem.title}: ${adjustResult.error}`);
          }
        }
      } else {
        await adjustProductStock(db, shop.id, mapping.id, inventoryIncrease);
      }

      await incrementPrintCount(db, shop.id, totalPrintsForItem);
    }

    // For untracked products, decrease virtual stock by quantity ordered
    if (!inventoryInfo.tracked) {
      await adjustProductStock(db, shop.id, mapping.id, -lineItem.quantity);
    }
  }

  // Log the sync operation
  await createSyncLog(db, {
    shop_id: shop.id,
    sync_type: "queue",
    status: result.itemsFailed === 0 ? "success" : "partial",
    message: `Processed order ${order.orderNumber}`,
    details: JSON.stringify(result.details),
    items_processed: result.itemsProcessed,
    items_created: result.itemsQueued,
    items_failed: result.itemsFailed,
    duration_ms: Date.now() - startTime,
  });

  result.success = result.itemsFailed === 0;
  return result;
}
