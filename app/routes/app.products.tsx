import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { useLoaderData, useSubmit, useNavigation, useActionData } from "@remix-run/react";
import { useState, useCallback, useMemo } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Banner,
  TextField,
  Select,
  Badge,
  IndexTable,
  useIndexResourceState,
  Modal,
  FormLayout,
} from "@shopify/polaris";
import { createShopifyApp, getEnvFromContext } from "~/shopify.server";
import { getShopByDomain, getShopSettings } from "~/models/shop.server";
import {
  getProductMappingsByShop,
  upsertProductMapping,
  updateProductMapping,
  updateProductMappingsByProduct,
  bulkSetProductStock,
  adjustProductStock,
  extractEanFromFilename,
} from "~/models/product-mapping.server";
import { getAllFiles, buildEanToFileMap, addToQueue } from "~/services/simplyprint-api.server";
import { encrypt } from "~/lib/encryption.server";
import { createQueueLog } from "~/models/queue-log.server";
import { incrementPrintCount } from "~/models/shop.server";
import {
  getFileMappingsByShop,
  getFileMappingsByProductMapping,
  replaceFileMappings,
  addFileMapping,
  type ProductFileMapping,
} from "~/models/product-file-mapping.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const loaderStart = Date.now();
  const env = getEnvFromContext(context);
  const shopify = await createShopifyApp(env, request);

  const { session, admin } = await shopify.authenticate.admin(request);
  const shop = await getShopByDomain(env.DB, session.shop);

  if (!shop) {
    return json({ shop: null, mappings: [], files: [], filesError: null, settings: null, hasSimplyPrint: false, fileMappings: {} as Record<number, ProductFileMapping[]> });
  }

  const settings = getShopSettings(shop);

  // Get existing mappings and SimplyPrint files in parallel
  const [mappings, files] = await Promise.all([
    getProductMappingsByShop(env.DB, shop.id),
    (async () => {
      const t = Date.now();
      if (!shop.simplyprint_api_key || !shop.simplyprint_company_id) return { files: [] as { id: string; name: string; ean: string | null }[], error: null as string | null };
      try {
        // Recursively fetch files from all folders
        const allFiles = await getAllFiles(
          shop.simplyprint_api_key,
          shop.simplyprint_company_id,
          env.ENCRYPTION_KEY
        );
        return {
          files: allFiles.map((f) => ({
            id: f.id,
            name: f.name,
            ean: extractEanFromFilename(f.name),
            folder: f.folder_path,
          })),
          error: null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("Failed to fetch SimplyPrint files:", message);
        return { files: [] as { id: string; name: string; ean: string | null }[], error: message };
      } finally {
        console.log(`[PERF] SimplyPrint files fetch: ${Date.now() - t}ms`);
      }
    })(),
  ]);

  const filesResult = files as { files: { id: string; name: string; ean: string | null }[]; error: string | null };

  // Load file mappings grouped by product_mapping_id
  const allFileMappings = await getFileMappingsByShop(env.DB, shop.id);
  const fileMappingsMap: Record<number, ProductFileMapping[]> = {};
  for (const fm of allFileMappings) {
    if (!fileMappingsMap[fm.product_mapping_id]) {
      fileMappingsMap[fm.product_mapping_id] = [];
    }
    fileMappingsMap[fm.product_mapping_id].push(fm);
  }

  console.log(`[PERF] Products page total loader: ${Date.now() - loaderStart}ms (${mappings.length} mappings, ${filesResult.files.length} files)`);

  return json({
    shop: { id: shop.id, mode: settings.mode, defaultThreshold: settings.default_threshold, defaultYield: settings.default_yield },
    mappings,
    files: filesResult.files,
    filesError: filesResult.error,
    settings,
    hasSimplyPrint: Boolean(shop.simplyprint_api_key),
    fileMappings: fileMappingsMap,
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

  if (action === "sync_inventory") {
    const shopifyApp = await createShopifyApp(env, request);
    const { admin } = await shopifyApp.authenticate.admin(request);
    const mappings = await getProductMappingsByShop(env.DB, shop.id);
    const variantIds = mappings
      .filter(m => m.shopify_variant_id)
      .map(m => `gid://shopify/ProductVariant/${m.shopify_variant_id}`);

    if (variantIds.length === 0) {
      return json({ success: true, message: "No variants to sync" });
    }

    try {
      const batchSize = 50;
      const maxConcurrent = 5;
      const allBatchResults = [];
      for (let i = 0; i < variantIds.length; i += batchSize * maxConcurrent) {
        const batchPromises = [];
        for (let j = i; j < Math.min(i + batchSize * maxConcurrent, variantIds.length); j += batchSize) {
          const batch = variantIds.slice(j, j + batchSize);
          batchPromises.push(
            admin.graphql(`
              query getInventoryBatch($ids: [ID!]!) {
                nodes(ids: $ids) {
                  ... on ProductVariant {
                    id
                    inventoryQuantity
                    inventoryItem {
                      tracked
                    }
                  }
                }
              }
            `, { variables: { ids: batch } }).then(r => r.json())
          );
        }
        const results = await Promise.all(batchPromises);
        allBatchResults.push(...results);
      }

      const stockUpdates: { mappingId: number; stock: number; inventoryTracked: boolean }[] = [];
      for (const inventoryData of allBatchResults) {
        const nodes = inventoryData.data?.nodes || [];
        for (const node of nodes) {
          if (!node?.id) continue;
          const variantId = node.id.replace("gid://shopify/ProductVariant/", "");
          const mapping = mappings.find(m => m.shopify_variant_id === variantId);
          if (!mapping) continue;

          const tracked = node.inventoryItem?.tracked ?? false;
          const shopifyStock = node.inventoryQuantity ?? 0;

          if (tracked) {
            stockUpdates.push({ mappingId: mapping.id, stock: shopifyStock, inventoryTracked: true });
          } else if (mapping.inventory_tracked === 1) {
            stockUpdates.push({ mappingId: mapping.id, stock: mapping.current_stock, inventoryTracked: false });
          }
        }
      }

      await bulkSetProductStock(env.DB, shop.id, stockUpdates);
      return json({ success: true, message: `Synced inventory for ${stockUpdates.length} variants` });
    } catch (error) {
      return json({ error: `Inventory sync failed: ${error instanceof Error ? error.message : "Unknown error"}` }, { status: 500 });
    }
  }

  if (action === "map") {
    const mappingId = parseInt(formData.get("mappingId") as string);
    const filesJson = formData.get("files") as string;
    const stockThreshold = formData.get("stockThreshold") as string;
    const stock = formData.get("stock") as string;

    // Parse files array: [{fileId, fileName, qtyPerProduct, yieldPerPrint}]
    let files: Array<{
      fileId: string;
      fileName: string;
      qtyPerProduct: number;
      yieldPerPrint: number;
    }> = [];
    if (filesJson) {
      try {
        files = JSON.parse(filesJson);
      } catch {
        return json({ error: "Malformed file selection" }, { status: 400 });
      }
    }

    // Replace file mappings
    await replaceFileMappings(
      env.DB,
      mappingId,
      files.map((f) => ({
        simplyprint_file_id: f.fileId,
        simplyprint_file_name: f.fileName,
        qty_per_product: Math.max(1, Math.min(100, f.qtyPerProduct || 1)),
        yield_per_print: Math.max(1, Math.min(10, f.yieldPerPrint || 1)),
      }))
    );

    // Update variant-level settings (stock, threshold)
    await updateProductMapping(env.DB, shop.id, mappingId, {
      stock_threshold: stockThreshold ? parseInt(stockThreshold) : null,
      ...(stock ? { current_stock: parseInt(stock) } : {}),
    });

    return json({ success: true, message: "Product mapped successfully" });
  }

  if (action === "map_product") {
    const productId = formData.get("productId") as string;
    const filesJson = formData.get("files") as string;
    const stockThreshold = formData.get("stockThreshold") as string;

    let files: Array<{
      fileId: string;
      fileName: string;
      qtyPerProduct: number;
      yieldPerPrint: number;
    }> = [];
    if (filesJson) {
      try {
        files = JSON.parse(filesJson);
      } catch {
        return json({ error: "Malformed file selection" }, { status: 400 });
      }
    }

    // Get all variants for this product
    const allMappings = await getProductMappingsByShop(env.DB, shop.id);
    const productVariants = allMappings.filter(
      (m) => m.shopify_product_id === productId
    );

    for (const variant of productVariants) {
      await replaceFileMappings(
        env.DB,
        variant.id,
        files.map((f) => ({
          simplyprint_file_id: f.fileId,
          simplyprint_file_name: f.fileName,
          qty_per_product: Math.max(1, Math.min(100, f.qtyPerProduct || 1)),
          yield_per_print: Math.max(1, Math.min(10, f.yieldPerPrint || 1)),
        }))
      );

      if (stockThreshold !== null) {
        await updateProductMapping(env.DB, shop.id, variant.id, {
          stock_threshold: stockThreshold ? parseInt(stockThreshold) : null,
        });
      }
    }

    return json({ success: true, message: `Mapped files to ${productVariants.length} variants` });
  }

  if (action === "update_color") {
    const mappingId = formData.get("mappingId") as string;
    const color = formData.get("color") as string;

    await updateProductMapping(env.DB, shop.id, parseInt(mappingId), {
      filament_color: color || null,
    });

    return json({ success: true, message: "Color updated" });
  }

  if (action === "update_stock") {
    const mappingId = formData.get("mappingId") as string;
    const stock = parseInt(formData.get("stock") as string);

    if (isNaN(stock) || stock < 0) {
      return json({ error: "Invalid stock value" }, { status: 400 });
    }

    await updateProductMapping(env.DB, shop.id, parseInt(mappingId), {
      current_stock: stock,
    });

    return json({ success: true, message: "Stock updated successfully" });
  }

  if (action === "update_threshold") {
    const mappingId = formData.get("mappingId") as string;
    const threshold = formData.get("threshold") as string;

    await updateProductMapping(env.DB, shop.id, parseInt(mappingId), {
      stock_threshold: threshold ? parseInt(threshold) : null,
    });

    return json({ success: true, message: "Threshold updated successfully" });
  }

  if (action === "sync_products") {
    // Sync Shopify products to mappings table (paginated)
    const shopifyApp = await createShopifyApp(env, request);
    const { admin } = await shopifyApp.authenticate.admin(request);

    // Fetch all products with cursor-based pagination
    const allVariants: { productId: string; productTitle: string; variantId: string; variantTitle: string; sku: string; barcode: string }[] = [];
    let hasNextPage = true;
    let cursor: string | null = null;

    while (hasNextPage) {
      const afterClause = cursor ? `, after: "${cursor}"` : "";
      const response = await admin.graphql(`
        query {
          products(first: 30${afterClause}) {
            edges {
              node {
                id
                title
                variants(first: 30) {
                  edges {
                    node {
                      id
                      title
                      sku
                      barcode
                    }
                  }
                }
              }
              cursor
            }
            pageInfo {
              hasNextPage
            }
          }
        }
      `);
      const data = await response.json();

      // Surface GraphQL errors instead of treating them as "no products".
      // Previously an errored response left data.data undefined, the loop
      // exited immediately, and the user was shown a success banner.
      if (data.errors?.length) {
        const message = data.errors.map((e: { message: string }) => e.message).join("; ");
        throw new Error(`Shopify rejected the product query: ${message}`);
      }
      if (!data.data?.products) {
        throw new Error("Shopify returned no product data. Check the app's access scopes.");
      }

      const edges = data.data.products.edges || [];
      hasNextPage = data.data.products.pageInfo?.hasNextPage || false;

      for (const productEdge of edges) {
        const product = productEdge.node;
        cursor = productEdge.cursor;
        const productId = product.id.replace("gid://shopify/Product/", "");

        for (const variantEdge of product.variants.edges) {
          const variant = variantEdge.node;
          allVariants.push({
            productId,
            productTitle: product.title,
            variantId: variant.id.replace("gid://shopify/ProductVariant/", ""),
            variantTitle: variant.title,
            sku: variant.sku,
            barcode: variant.barcode,
          });
        }
      }
    }

    // Get existing mappings to determine inserts vs updates
    const existing = await getProductMappingsByShop(env.DB, shop.id);
    const existingByVariant = new Map(existing.map(m => [m.shopify_variant_id, m]));

    // Batch upsert using D1 batch API
    const inserts: D1PreparedStatement[] = [];
    const updates: D1PreparedStatement[] = [];

    for (const v of allVariants) {
      const variantTitle = v.variantTitle !== "Default Title" ? v.variantTitle : null;
      const ex = existingByVariant.get(v.variantId);

      if (ex) {
        updates.push(
          env.DB.prepare(
            `UPDATE product_mappings SET shopify_sku = ?, shopify_barcode = ?, shopify_title = ?, shopify_variant_title = ?, filament_color = ?, updated_at = unixepoch() WHERE id = ?`
          ).bind(v.sku, v.barcode, v.productTitle, variantTitle, variantTitle, ex.id)
        );
      } else {
        inserts.push(
          env.DB.prepare(
            `INSERT INTO product_mappings (shop_id, shopify_product_id, shopify_variant_id, shopify_sku, shopify_barcode, shopify_title, shopify_variant_title, filament_color, yield_per_print, is_auto_mapped) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`
          ).bind(shop.id, v.productId, v.variantId, v.sku, v.barcode, v.productTitle, variantTitle, variantTitle)
        );
      }
    }

    // D1 batch supports up to 500 statements
    const allStmts = [...inserts, ...updates];
    for (let i = 0; i < allStmts.length; i += 500) {
      await env.DB.batch(allStmts.slice(i, i + 500));
    }

    return json({ success: true, message: `Synced ${allVariants.length} product variants (${inserts.length} new, ${updates.length} updated)` });
  }

  if (action === "auto_map") {
    if (!shop.simplyprint_api_key || !shop.simplyprint_company_id) {
      return json({ error: "SimplyPrint not connected" }, { status: 400 });
    }

    // Build EAN to file map
    const eanMap = await buildEanToFileMap(
      shop.simplyprint_api_key,
      shop.simplyprint_company_id,
      env.ENCRYPTION_KEY
    );

    // Get products and their existing file mappings
    const mappings = await getProductMappingsByShop(env.DB, shop.id);
    const allFileMappingsForAutoMap = await getFileMappingsByShop(env.DB, shop.id);
    const mappedVariantIds = new Set(allFileMappingsForAutoMap.map((fm) => fm.product_mapping_id));
    let autoMapped = 0;

    for (const mapping of mappings) {
      if (!mappedVariantIds.has(mapping.id) && mapping.shopify_barcode) {
        const file = eanMap.get(mapping.shopify_barcode);
        if (file) {
          await addFileMapping(env.DB, mapping.id, {
            simplyprint_file_id: file.id,
            simplyprint_file_name: file.name,
            is_auto_mapped: true,
          });
          autoMapped++;
        }
      }
    }

    return json({ success: true, message: `Auto-mapped ${autoMapped} products by EAN` });
  }

  if (action === "check_stock_queue") {
    if (!shop.simplyprint_api_key || !shop.simplyprint_company_id) {
      return json({ error: "SimplyPrint not connected" }, { status: 400 });
    }

    const settings = getShopSettings(shop);
    if (settings.mode !== "advanced") {
      return json({ error: "This feature is only available in advanced mode" }, { status: 400 });
    }

    const shopifyApp = await createShopifyApp(env, request);
    const { admin } = await shopifyApp.authenticate.admin(request);

    // Get all mapped products (those with file mappings)
    const mappings = await getProductMappingsByShop(env.DB, shop.id);
    const allCheckFileMappings = await getFileMappingsByShop(env.DB, shop.id);
    const fileMappingsByVariant: Record<number, typeof allCheckFileMappings> = {};
    for (const fm of allCheckFileMappings) {
      if (!fileMappingsByVariant[fm.product_mapping_id]) {
        fileMappingsByVariant[fm.product_mapping_id] = [];
      }
      fileMappingsByVariant[fm.product_mapping_id].push(fm);
    }

    const mappedProducts = mappings.filter(m => (fileMappingsByVariant[m.id] || []).length > 0 && m.shopify_variant_id);

    let totalPrintsQueued = 0;
    let productsQueued = 0;
    const errors: string[] = [];

    for (const mapping of mappedProducts) {
      try {
        const variantFileMappings = fileMappingsByVariant[mapping.id] || [];

        // Get current inventory level and tracking status
        const response = await admin.graphql(`
          query getInventory($id: ID!) {
            productVariant(id: $id) {
              inventoryQuantity
              inventoryItem {
                id
                tracked
                inventoryLevels(first: 1) {
                  edges {
                    node {
                      location {
                        id
                      }
                    }
                  }
                }
              }
            }
          }
        `, {
          variables: { id: `gid://shopify/ProductVariant/${mapping.shopify_variant_id}` }
        });

        const data = await response.json();
        const variant = data.data?.productVariant;
        const tracked = variant?.inventoryItem?.tracked ?? false;
        const inventoryItemId = variant?.inventoryItem?.id;
        const locationId = variant?.inventoryItem?.inventoryLevels?.edges?.[0]?.node?.location?.id;

        const currentStock = tracked
          ? (variant?.inventoryQuantity ?? 0)
          : (mapping.current_stock ?? 0);

        const threshold = mapping.stock_threshold ?? settings.default_threshold;

        // Check if below threshold
        if (currentStock < threshold) {
          const deficit = threshold - currentStock;
          let variantPrintsQueued = 0;

          // Queue each file for this variant
          for (const fileMapping of variantFileMappings) {
            const printsNeeded = Math.ceil((deficit * fileMapping.qty_per_product) / fileMapping.yield_per_print);

            if (printsNeeded > 0) {
              const queueResult = await addToQueue(
                shop.simplyprint_api_key,
                shop.simplyprint_company_id,
                env.ENCRYPTION_KEY,
                fileMapping.simplyprint_file_id,
                printsNeeded,
                { filamentColor: mapping.filament_color || undefined }
              );

              if (queueResult.success) {
                variantPrintsQueued += printsNeeded;

                await createQueueLog(env.DB, {
                  shop_id: shop.id,
                  shopify_order_id: "manual-stock-check",
                  shopify_order_number: "Manual Stock Check",
                  shopify_line_item_id: mapping.shopify_variant_id,
                  product_mapping_id: mapping.id,
                  shopify_product_title: mapping.shopify_title || "Unknown",
                  simplyprint_file_id: fileMapping.simplyprint_file_id,
                  simplyprint_queue_item_id: queueResult.queueItemId,
                  quantity_ordered: deficit,
                  prints_queued: printsNeeded,
                  inventory_adjusted: 0,
                  status: "queued",
                });
              } else {
                errors.push(`${mapping.shopify_title} (${fileMapping.simplyprint_file_name}): ${queueResult.error}`);
              }
            }
          }

          if (variantPrintsQueued > 0) {
            totalPrintsQueued += variantPrintsQueued;
            productsQueued++;

            // Inventory adjustment once per variant
            const inventoryIncrease = deficit;
            if (tracked && inventoryItemId && locationId) {
              await admin.graphql(`
                mutation adjustInventory($input: InventoryAdjustQuantitiesInput!) {
                  inventoryAdjustQuantities(input: $input) {
                    userErrors {
                      message
                    }
                  }
                }
              `, {
                variables: {
                  input: {
                    reason: "correction",
                    name: "available",
                    changes: [{
                      inventoryItemId,
                      locationId,
                      delta: inventoryIncrease,
                    }],
                  },
                },
              });
            } else if (!tracked) {
              await adjustProductStock(env.DB, shop.id, mapping.id, inventoryIncrease);
            }

            await incrementPrintCount(env.DB, shop.id, variantPrintsQueued);
          }
        }
      } catch (error) {
        errors.push(`${mapping.shopify_title}: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    }

    if (errors.length > 0) {
      return json({
        success: true,
        message: `Queued ${totalPrintsQueued} prints for ${productsQueued} products. ${errors.length} errors occurred.`,
        errors,
      });
    }

    return json({
      success: true,
      message: totalPrintsQueued > 0
        ? `Queued ${totalPrintsQueued} prints for ${productsQueued} products below threshold`
        : "All products are above threshold, no prints needed",
    });
  }

  return json({ error: "Unknown action" }, { status: 400 });
};

export default function Products() {
  const { shop, mappings, files, filesError, hasSimplyPrint, settings, fileMappings } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isLoading = navigation.state === "submitting";

  const [selectedMapping, setSelectedMapping] = useState<typeof mappings[0] | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [thresholdValue, setThresholdValue] = useState("");
  const [stockValue, setStockValue] = useState("");
  const [editingCell, setEditingCell] = useState<{ id: number; field: "stock" | "threshold" | "color" } | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState("");
  const [selectedProductTitle, setSelectedProductTitle] = useState("");

  // Multi-file state for the modal
  const [modalFiles, setModalFiles] = useState<Array<{
    fileId: string;
    fileName: string;
    qtyPerProduct: number;
    yieldPerPrint: number;
  }>>([]);
  const [addingFile, setAddingFile] = useState(false);
  const [newFileId, setNewFileId] = useState("");
  const [newFileQty, setNewFileQty] = useState("1");
  const [newFileYield, setNewFileYield] = useState("1");

  const handleSyncProducts = () => {
    submit({ action: "sync_products" }, { method: "post" });
  };

  const handleAutoMap = () => {
    submit({ action: "auto_map" }, { method: "post" });
  };

  const openProductMapModal = (productId: string, title: string, firstVariant: typeof mappings[0]) => {
    setSelectedProductId(productId);
    setSelectedProductTitle(title);
    const existingFiles = (fileMappings[firstVariant.id] || []).map((fm: ProductFileMapping) => ({
      fileId: fm.simplyprint_file_id,
      fileName: fm.simplyprint_file_name || "",
      qtyPerProduct: fm.qty_per_product,
      yieldPerPrint: fm.yield_per_print,
    }));
    setModalFiles(existingFiles);
    setThresholdValue(firstVariant.stock_threshold ? String(firstVariant.stock_threshold) : "");
    setAddingFile(false);
    setNewFileId("");
    setNewFileQty("1");
    setNewFileYield("1");
    setFileSearch("");
    setSelectedFolder("__all__");
    setProductModalOpen(true);
  };

  const handleSaveProductMapping = () => {
    submit(
      {
        action: "map_product",
        productId: selectedProductId,
        files: JSON.stringify(modalFiles),
        stockThreshold: thresholdValue,
      },
      { method: "post" }
    );
    setProductModalOpen(false);
  };

  const handleCheckStock = () => {
    submit({ action: "check_stock_queue" }, { method: "post" });
  };

  const handleSyncInventory = () => {
    submit({ action: "sync_inventory" }, { method: "post" });
  };

  const openMapModal = (mapping: typeof mappings[0]) => {
    setSelectedMapping(mapping);
    const existingFiles = (fileMappings[mapping.id] || []).map((fm: ProductFileMapping) => ({
      fileId: fm.simplyprint_file_id,
      fileName: fm.simplyprint_file_name || "",
      qtyPerProduct: fm.qty_per_product,
      yieldPerPrint: fm.yield_per_print,
    }));
    setModalFiles(existingFiles);
    setThresholdValue(mapping.stock_threshold ? String(mapping.stock_threshold) : "");
    setStockValue(String(mapping.current_stock ?? 0));
    setAddingFile(false);
    setNewFileId("");
    setNewFileQty("1");
    setNewFileYield("1");
    setFileSearch("");
    setSelectedFolder("__all__");
    setModalOpen(true);
  };

  const handleSaveMapping = () => {
    if (!selectedMapping) return;

    const newStock = parseInt(stockValue);
    const stockChanged = !isNaN(newStock) && newStock !== (selectedMapping.current_stock ?? 0);

    submit(
      {
        action: "map",
        mappingId: String(selectedMapping.id),
        files: JSON.stringify(modalFiles),
        stockThreshold: thresholdValue,
        ...(settings?.mode === "advanced" && stockChanged ? { stock: stockValue } : {}),
      },
      { method: "post" }
    );
    setModalOpen(false);
  };

  const handleInlineEdit = (mapping: typeof mappings[0], field: "stock" | "threshold" | "color") => {
    if (field === "stock" && mapping.inventory_tracked === 1) return;
    setEditingCell({ id: mapping.id, field });
    if (field === "stock") {
      setEditingValue(String(mapping.current_stock ?? 0));
    } else if (field === "threshold") {
      setEditingValue(mapping.stock_threshold ? String(mapping.stock_threshold) : "");
    } else if (field === "color") {
      setEditingValue(mapping.filament_color || mapping.shopify_variant_title || "");
    }
  };

  const handleAddFile = () => {
    if (!newFileId) return;
    if (modalFiles.some((f) => f.fileId === newFileId)) return;

    const fileName = files.find((f) => f.id === newFileId)?.name || "";
    setModalFiles([
      ...modalFiles,
      {
        fileId: newFileId,
        fileName,
        qtyPerProduct: Math.max(1, Math.min(100, parseInt(newFileQty) || 1)),
        yieldPerPrint: Math.max(1, Math.min(10, parseInt(newFileYield) || 1)),
      },
    ]);
    setNewFileId("");
    setNewFileQty("1");
    setNewFileYield("1");
    setAddingFile(false);
  };

  const handleRemoveFile = (fileId: string) => {
    setModalFiles(modalFiles.filter((f) => f.fileId !== fileId));
  };

  const handleUpdateFileField = (fileId: string, field: "qtyPerProduct" | "yieldPerPrint", value: string) => {
    setModalFiles(modalFiles.map((f) => {
      if (f.fileId !== fileId) return f;
      const numValue = parseInt(value) || 1;
      if (field === "qtyPerProduct") {
        return { ...f, qtyPerProduct: Math.max(1, Math.min(100, numValue)) };
      }
      return { ...f, yieldPerPrint: Math.max(1, Math.min(10, numValue)) };
    }));
  };

  const handleInlineSave = () => {
    if (!editingCell) return;
    const value = parseInt(editingValue);

    if (editingCell.field === "stock") {
      if (!isNaN(value) && value >= 0) {
        submit(
          { action: "update_stock", mappingId: String(editingCell.id), stock: String(value) },
          { method: "post" }
        );
      }
    } else if (editingCell.field === "threshold") {
      submit(
        { action: "update_threshold", mappingId: String(editingCell.id), threshold: editingValue },
        { method: "post" }
      );
    } else if (editingCell.field === "color") {
      submit(
        { action: "update_color", mappingId: String(editingCell.id), color: editingValue },
        { method: "post" }
      );
    }
    setEditingCell(null);
  };

  const handleInlineKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleInlineSave();
    } else if (e.key === "Escape") {
      setEditingCell(null);
    }
  };

  const [fileSearch, setFileSearch] = useState("");
  const [selectedFolder, setSelectedFolder] = useState("__all__");

  // Get unique folder paths for the folder dropdown
  const folderOptions = useMemo(() => {
    const folders = [...new Set(files.map((f) => f.folder || "/"))].sort((a, b) => {
      if (a === "/") return -1;
      if (b === "/") return 1;
      return a.localeCompare(b);
    });
    return [
      { label: "All folders", value: "__all__" },
      ...folders.map((f) => ({ label: f === "/" ? "/ (root)" : f, value: f })),
    ];
  }, [files]);

  // Filter files by selected folder and search query
  const fileOptions = useMemo(() => {
    let filtered = files;

    if (selectedFolder !== "__all__") {
      filtered = filtered.filter((f) => (f.folder || "/") === selectedFolder);
    }

    if (fileSearch) {
      const q = fileSearch.toLowerCase();
      filtered = filtered.filter((f) => f.name.toLowerCase().includes(q));
    }

    return [
      { label: "-- Select a file --", value: "" },
      ...filtered.map((f) => ({
        label: f.ean ? `${f.name} (EAN: ${f.ean})` : f.name,
        value: f.id,
      })),
    ];
  }, [files, selectedFolder, fileSearch]);

  const resourceName = {
    singular: "product",
    plural: "products",
  };

  const truncateStyle = {
    maxWidth: "200px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  };

  const productGroups = mappings.reduce((groups, mapping) => {
    const key = mapping.shopify_product_id;
    if (!groups[key]) {
      groups[key] = {
        productId: key,
        title: mapping.shopify_title || "Unknown",
        variants: [],
      };
    }
    groups[key].variants.push(mapping);
    return groups;
  }, {} as Record<string, { productId: string; title: string; variants: typeof mappings }>);

  let rowIndex = 0;
  const groupedRows = Object.values(productGroups).flatMap((group) => {
    const hasMultipleVariants = group.variants.length > 1;
    const firstVariant = group.variants[0];
    const isMapped = group.variants.some(v => (fileMappings[v.id] || []).length > 0);
    const rows: React.ReactNode[] = [];

    if (hasMultipleVariants) {
      rows.push(
        <IndexTable.Row id={`product-${group.productId}`} key={`product-${group.productId}`} position={rowIndex++}>
          <IndexTable.Cell>
            <div style={truncateStyle} title={group.title}>
              <InlineStack gap="200" blockAlign="center" wrap={false}>
                <Text variant="bodyMd" fontWeight="bold" as="span">
                  {group.title}
                </Text>
                <Badge tone="info">{group.variants.length} variants</Badge>
              </InlineStack>
            </div>
          </IndexTable.Cell>
          {settings?.filament_color_enabled && <IndexTable.Cell />}
          <IndexTable.Cell>
            {(() => {
              const firstVariantFiles = fileMappings[firstVariant.id] || [];
              return (
                <div style={truncateStyle} title={firstVariantFiles.map((f: ProductFileMapping) => f.simplyprint_file_name).join(", ") || undefined}>
                  {isMapped ? (
                    firstVariantFiles.length === 1 ? (
                      <Badge tone="success">{firstVariantFiles[0].simplyprint_file_name}</Badge>
                    ) : (
                      <Badge tone="success">{firstVariantFiles.length} files</Badge>
                    )
                  ) : (
                    <Badge tone="attention">Not mapped</Badge>
                  )}
                </div>
              );
            })()}
          </IndexTable.Cell>
          {settings?.mode === "advanced" && <IndexTable.Cell />}
          {settings?.mode === "advanced" && <IndexTable.Cell />}
          <IndexTable.Cell>
            <Button size="slim" onClick={() => openProductMapModal(group.productId, group.title, firstVariant)}>
              {isMapped ? "Edit All" : "Map All"}
            </Button>
          </IndexTable.Cell>
        </IndexTable.Row>
      );
    }

    for (const mapping of group.variants) {
      rows.push(
        <IndexTable.Row id={String(mapping.id)} key={mapping.id} position={rowIndex++}>
          <IndexTable.Cell>
            <div style={{ ...truncateStyle, paddingLeft: hasMultipleVariants ? "20px" : "0" }} title={hasMultipleVariants ? (mapping.shopify_variant_title || "Default") : `${mapping.shopify_title}${mapping.shopify_variant_title ? ` — ${mapping.shopify_variant_title}` : ""}`}>
              {hasMultipleVariants ? (
                <Text variant="bodySm" as="span">
                  {mapping.shopify_variant_title || "Default"}
                </Text>
              ) : (
                <Text variant="bodyMd" fontWeight="bold" as="span">
                  {mapping.shopify_title}
                  {mapping.shopify_variant_title && (
                    <Text variant="bodySm" tone="subdued" as="span">
                      {" "}— {mapping.shopify_variant_title}
                    </Text>
                  )}
                </Text>
              )}
            </div>
          </IndexTable.Cell>
          {settings?.filament_color_enabled && (
            <IndexTable.Cell>
              {editingCell?.id === mapping.id && editingCell?.field === "color" ? (
                <input
                  type="text"
                  value={editingValue}
                  onChange={(e) => setEditingValue(e.target.value)}
                  onBlur={handleInlineSave}
                  onKeyDown={handleInlineKeyDown}
                  autoFocus
                  style={{ width: "120px", padding: "2px 4px", fontSize: "12px" }}
                />
              ) : (
                <span
                  onClick={() => handleInlineEdit(mapping, "color")}
                  style={{ cursor: "pointer", padding: "2px 4px", borderRadius: "4px", fontSize: "12px" }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#f0f0f0")}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                  title="Click to edit filament color"
                >
                  {mapping.filament_color || <Text as="span" tone="subdued" variant="bodySm">—</Text>}
                </span>
              )}
            </IndexTable.Cell>
          )}
          <IndexTable.Cell>
            {!hasMultipleVariants && (() => {
              const variantFiles = fileMappings[mapping.id] || [];
              return (
                <div style={truncateStyle} title={variantFiles.map((f: ProductFileMapping) => f.simplyprint_file_name).join(", ") || undefined}>
                  {variantFiles.length === 0 ? (
                    <Badge tone="attention">Not mapped</Badge>
                  ) : variantFiles.length === 1 ? (
                    <Badge tone="success">{variantFiles[0].simplyprint_file_name}</Badge>
                  ) : (
                    <Badge tone="success">{variantFiles.length} files</Badge>
                  )}
                </div>
              );
            })()}
          </IndexTable.Cell>
          {settings?.mode === "advanced" && (
            <IndexTable.Cell>
              {editingCell?.id === mapping.id && editingCell?.field === "stock" ? (
                <input
                  type="number"
                  value={editingValue}
                  onChange={(e) => setEditingValue(e.target.value)}
                  onBlur={handleInlineSave}
                  onKeyDown={handleInlineKeyDown}
                  autoFocus
                  min={0}
                  style={{ width: "60px", padding: "2px 4px" }}
                />
              ) : (
                <InlineStack gap="100" blockAlign="center">
                  <span
                    onClick={() => handleInlineEdit(mapping, "stock")}
                    style={{
                      cursor: mapping.inventory_tracked === 1 ? "default" : "pointer",
                      padding: "2px 4px",
                      borderRadius: "4px",
                    }}
                    onMouseEnter={(e) => mapping.inventory_tracked !== 1 && (e.currentTarget.style.backgroundColor = "#f0f0f0")}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                  >
                    {mapping.current_stock ?? 0}
                  </span>
                  {mapping.inventory_tracked === 1 && (
                    <Text as="span" tone="subdued" variant="bodySm">(synced)</Text>
                  )}
                </InlineStack>
              )}
            </IndexTable.Cell>
          )}
          {settings?.mode === "advanced" && (
            <IndexTable.Cell>
              {editingCell?.id === mapping.id && editingCell?.field === "threshold" ? (
                <input
                  type="number"
                  value={editingValue}
                  onChange={(e) => setEditingValue(e.target.value)}
                  onBlur={handleInlineSave}
                  onKeyDown={handleInlineKeyDown}
                  autoFocus
                  min={0}
                  placeholder={String(shop?.defaultThreshold ?? 100)}
                  style={{ width: "60px", padding: "2px 4px" }}
                />
              ) : (
                <span
                  onClick={() => handleInlineEdit(mapping, "threshold")}
                  style={{ cursor: "pointer", padding: "2px 4px", borderRadius: "4px" }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#f0f0f0")}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                >
                  {mapping.stock_threshold ?? shop?.defaultThreshold ?? 100}
                </span>
              )}
            </IndexTable.Cell>
          )}
          <IndexTable.Cell>
            {!hasMultipleVariants && (
              <Button size="slim" onClick={() => openMapModal(mapping)}>
                {(fileMappings[mapping.id] || []).length > 0 ? "Edit" : "Map"}
              </Button>
            )}
          </IndexTable.Cell>
        </IndexTable.Row>
      );
    }

    return rows;
  });

  return (
    <Page
      title="Product Mappings"
      primaryAction={{
        content: "Sync Products",
        onAction: handleSyncProducts,
        loading: isLoading,
      }}
      secondaryActions={
        hasSimplyPrint
          ? [
              {
                content: "Auto-Map by EAN",
                onAction: handleAutoMap,
                disabled: isLoading,
              },
              ...(settings?.mode === "advanced"
                ? [
                    {
                      content: "Refresh Stock",
                      onAction: handleSyncInventory,
                      disabled: isLoading,
                    },
                    {
                      content: "Check Stock & Queue",
                      onAction: handleCheckStock,
                      disabled: isLoading,
                    },
                  ]
                : []),
            ]
          : []
      }
    >
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

        {!hasSimplyPrint && (
          <Banner tone="warning" title="SimplyPrint Not Connected">
            Connect your SimplyPrint account in Settings to map products to print files.
          </Banner>
        )}

        {filesError && (
          <Banner tone="critical" title="Failed to load SimplyPrint files">
            {filesError}
          </Banner>
        )}

        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">
                Products ({mappings.length})
              </Text>
              <InlineStack gap="200">
                <Badge tone="success">
                  {mappings.filter((m) => (fileMappings[m.id] || []).length > 0).length} mapped
                </Badge>
                <Badge tone="attention">
                  {mappings.filter((m) => (fileMappings[m.id] || []).length === 0).length} unmapped
                </Badge>
              </InlineStack>
            </InlineStack>

            <Text as="p" variant="bodyMd" tone="subdued">
              Map your Shopify products to SimplyPrint files. Set the yield (items per print) and threshold (for advanced mode).
            </Text>

            {mappings.length === 0 ? (
              <Banner>
                No products synced yet. Click "Sync Products" to import your Shopify products.
              </Banner>
            ) : (
              <div style={{ overflow: "visible" }}>
                <style>{`
                  .Polaris-IndexTable-ScrollContainer {
                    overflow-x: visible !important;
                  }
                  .Polaris-IndexTable__Table {
                    table-layout: fixed;
                    width: 100%;
                  }
                `}</style>
                <IndexTable
                  resourceName={resourceName}
                  itemCount={mappings.length}
                  headings={[
                    { title: "Product" },
                    ...(settings?.filament_color_enabled ? [{ title: "Color / Filament" }] : []),
                    { title: "SimplyPrint File" },
                    ...(settings?.mode === "advanced" ? [{ title: "Stock" }, { title: "Threshold" }] : []),
                    { title: "" },
                  ]}
                  selectable={false}
                >
                  {groupedRows}
                </IndexTable>
              </div>
            )}
          </BlockStack>
        </Card>

        <Modal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          title={`Map: ${selectedMapping?.shopify_title || ""}`}
          primaryAction={{
            content: "Save",
            onAction: handleSaveMapping,
            loading: isLoading,
          }}
          secondaryActions={[
            {
              content: "Cancel",
              onAction: () => setModalOpen(false),
            },
          ]}
        >
          <Modal.Section>
            <FormLayout>
              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">Mapped Files</Text>
                {modalFiles.length === 0 ? (
                  <Text as="p" tone="subdued" variant="bodySm">No files mapped yet. Click "+ Add File" to get started.</Text>
                ) : (
                  modalFiles.map((file, index) => (
                    <InlineStack key={file.fileId} gap="200" blockAlign="center" wrap={false}>
                      <div style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <Text as="span" variant="bodySm">{index + 1}. {file.fileName}</Text>
                      </div>
                      <div style={{ width: "70px" }}>
                        <TextField
                          label="Qty"
                          labelHidden
                          type="number"
                          value={String(file.qtyPerProduct)}
                          onChange={(v) => handleUpdateFileField(file.fileId, "qtyPerProduct", v)}
                          min={1}
                          max={100}
                          autoComplete="off"
                        />
                      </div>
                      <div style={{ width: "70px" }}>
                        <TextField
                          label="Yield"
                          labelHidden
                          type="number"
                          value={String(file.yieldPerPrint)}
                          onChange={(v) => handleUpdateFileField(file.fileId, "yieldPerPrint", v)}
                          min={1}
                          max={10}
                          autoComplete="off"
                        />
                      </div>
                      <Button size="slim" tone="critical" onClick={() => handleRemoveFile(file.fileId)}>
                        Remove
                      </Button>
                    </InlineStack>
                  ))
                )}
                {modalFiles.length > 0 && (
                  <InlineStack gap="400">
                    <Text as="span" variant="bodySm" tone="subdued">Qty = parts per product</Text>
                    <Text as="span" variant="bodySm" tone="subdued">Yield = items per print</Text>
                  </InlineStack>
                )}
              </BlockStack>

              {addingFile ? (
                <Card>
                  <BlockStack gap="300">
                    <Select
                      label="Folder"
                      options={folderOptions}
                      value={selectedFolder}
                      onChange={setSelectedFolder}
                    />
                    <TextField
                      label="Search files"
                      value={fileSearch}
                      onChange={setFileSearch}
                      placeholder="Filter by file name..."
                      autoComplete="off"
                      clearButton
                      onClearButtonClick={() => setFileSearch("")}
                    />
                    <Select
                      label="SimplyPrint File"
                      options={fileOptions}
                      value={newFileId}
                      onChange={setNewFileId}
                    />
                    <InlineStack gap="200">
                      <div style={{ width: "120px" }}>
                        <TextField
                          label="Qty per product"
                          type="number"
                          value={newFileQty}
                          onChange={setNewFileQty}
                          min={1}
                          max={100}
                          autoComplete="off"
                        />
                      </div>
                      <div style={{ width: "120px" }}>
                        <TextField
                          label="Yield per print"
                          type="number"
                          value={newFileYield}
                          onChange={setNewFileYield}
                          min={1}
                          max={10}
                          autoComplete="off"
                        />
                      </div>
                    </InlineStack>
                    <InlineStack gap="200">
                      <Button onClick={handleAddFile} disabled={!newFileId}>Add</Button>
                      <Button onClick={() => setAddingFile(false)}>Cancel</Button>
                    </InlineStack>
                  </BlockStack>
                </Card>
              ) : (
                <Button onClick={() => setAddingFile(true)}>+ Add File</Button>
              )}

              {settings?.mode === "advanced" && (
                <TextField
                  label="Current Stock"
                  type="number"
                  value={stockValue}
                  onChange={setStockValue}
                  min={0}
                  autoComplete="off"
                  disabled={selectedMapping?.inventory_tracked === 1}
                  helpText={
                    selectedMapping?.inventory_tracked === 1
                      ? "Stock is synced from Shopify inventory tracking"
                      : "Manual stock count (used for threshold calculation)"
                  }
                />
              )}

              {settings?.mode === "advanced" && (
                <TextField
                  label="Stock Threshold"
                  type="number"
                  value={thresholdValue}
                  onChange={setThresholdValue}
                  placeholder={String(shop?.defaultThreshold || 100)}
                  autoComplete="off"
                  helpText="Only queue prints when stock falls below this level"
                />
              )}
            </FormLayout>
          </Modal.Section>
        </Modal>

        <Modal
          open={productModalOpen}
          onClose={() => setProductModalOpen(false)}
          title={`Map All Variants: ${selectedProductTitle}`}
          primaryAction={{
            content: "Save for All Variants",
            onAction: handleSaveProductMapping,
            loading: isLoading,
          }}
          secondaryActions={[
            { content: "Cancel", onAction: () => setProductModalOpen(false) },
          ]}
        >
          <Modal.Section>
            <FormLayout>
              <Banner tone="info">
                This will set the SimplyPrint files for all variants of this product.
                {settings?.filament_color_enabled && " The filament color for each variant is automatically set from its name."}
              </Banner>

              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">Mapped Files</Text>
                {modalFiles.length === 0 ? (
                  <Text as="p" tone="subdued" variant="bodySm">No files mapped yet. Click "+ Add File" to get started.</Text>
                ) : (
                  modalFiles.map((file, index) => (
                    <InlineStack key={file.fileId} gap="200" blockAlign="center" wrap={false}>
                      <div style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <Text as="span" variant="bodySm">{index + 1}. {file.fileName}</Text>
                      </div>
                      <div style={{ width: "70px" }}>
                        <TextField
                          label="Qty"
                          labelHidden
                          type="number"
                          value={String(file.qtyPerProduct)}
                          onChange={(v) => handleUpdateFileField(file.fileId, "qtyPerProduct", v)}
                          min={1}
                          max={100}
                          autoComplete="off"
                        />
                      </div>
                      <div style={{ width: "70px" }}>
                        <TextField
                          label="Yield"
                          labelHidden
                          type="number"
                          value={String(file.yieldPerPrint)}
                          onChange={(v) => handleUpdateFileField(file.fileId, "yieldPerPrint", v)}
                          min={1}
                          max={10}
                          autoComplete="off"
                        />
                      </div>
                      <Button size="slim" tone="critical" onClick={() => handleRemoveFile(file.fileId)}>
                        Remove
                      </Button>
                    </InlineStack>
                  ))
                )}
                {modalFiles.length > 0 && (
                  <InlineStack gap="400">
                    <Text as="span" variant="bodySm" tone="subdued">Qty = parts per product</Text>
                    <Text as="span" variant="bodySm" tone="subdued">Yield = items per print</Text>
                  </InlineStack>
                )}
              </BlockStack>

              {addingFile ? (
                <Card>
                  <BlockStack gap="300">
                    <Select
                      label="Folder"
                      options={folderOptions}
                      value={selectedFolder}
                      onChange={setSelectedFolder}
                    />
                    <TextField
                      label="Search files"
                      value={fileSearch}
                      onChange={setFileSearch}
                      placeholder="Filter by file name..."
                      autoComplete="off"
                      clearButton
                      onClearButtonClick={() => setFileSearch("")}
                    />
                    <Select
                      label="SimplyPrint File"
                      options={fileOptions}
                      value={newFileId}
                      onChange={setNewFileId}
                    />
                    <InlineStack gap="200">
                      <div style={{ width: "120px" }}>
                        <TextField
                          label="Qty per product"
                          type="number"
                          value={newFileQty}
                          onChange={setNewFileQty}
                          min={1}
                          max={100}
                          autoComplete="off"
                        />
                      </div>
                      <div style={{ width: "120px" }}>
                        <TextField
                          label="Yield per print"
                          type="number"
                          value={newFileYield}
                          onChange={setNewFileYield}
                          min={1}
                          max={10}
                          autoComplete="off"
                        />
                      </div>
                    </InlineStack>
                    <InlineStack gap="200">
                      <Button onClick={handleAddFile} disabled={!newFileId}>Add</Button>
                      <Button onClick={() => setAddingFile(false)}>Cancel</Button>
                    </InlineStack>
                  </BlockStack>
                </Card>
              ) : (
                <Button onClick={() => setAddingFile(true)}>+ Add File</Button>
              )}
            </FormLayout>
          </Modal.Section>
        </Modal>
      </BlockStack>
    </Page>
  );
}
