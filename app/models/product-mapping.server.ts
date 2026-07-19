export interface ProductMapping {
  id: number;
  shop_id: number;
  shopify_product_id: string;
  shopify_variant_id: string | null;
  shopify_sku: string | null;
  shopify_barcode: string | null;
  shopify_title: string | null;
  shopify_variant_title: string | null;
  simplyprint_file_id: string | null;
  simplyprint_file_name: string | null;
  yield_per_print: number;
  stock_threshold: number | null;
  current_stock: number;
  inventory_tracked: number;
  filament_color: string | null;
  is_auto_mapped: number;
  is_active: number;
  created_at: number;
  updated_at: number;
}

export async function getProductMappingsByShop(
  db: D1Database,
  shopId: number
): Promise<ProductMapping[]> {
  const result = await db
    .prepare("SELECT * FROM product_mappings WHERE shop_id = ? AND is_active = 1 ORDER BY shopify_title")
    .bind(shopId)
    .all<ProductMapping>();
  return result.results;
}

export async function getProductMappingByVariant(
  db: D1Database,
  shopId: number,
  variantId: string
): Promise<ProductMapping | null> {
  const result = await db
    .prepare(
      "SELECT * FROM product_mappings WHERE shop_id = ? AND shopify_variant_id = ? AND is_active = 1"
    )
    .bind(shopId, variantId)
    .first<ProductMapping>();
  return result || null;
}

export async function getProductMappingByBarcode(
  db: D1Database,
  shopId: number,
  barcode: string
): Promise<ProductMapping | null> {
  const result = await db
    .prepare(
      "SELECT * FROM product_mappings WHERE shop_id = ? AND shopify_barcode = ? AND is_active = 1"
    )
    .bind(shopId, barcode)
    .first<ProductMapping>();
  return result || null;
}

export async function getMappedProducts(
  db: D1Database,
  shopId: number
): Promise<ProductMapping[]> {
  const result = await db
    .prepare(
      "SELECT * FROM product_mappings WHERE shop_id = ? AND is_active = 1 AND EXISTS (SELECT 1 FROM product_file_mappings WHERE product_file_mappings.product_mapping_id = product_mappings.id)"
    )
    .bind(shopId)
    .all<ProductMapping>();
  return result.results;
}

export async function getUnmappedProducts(
  db: D1Database,
  shopId: number
): Promise<ProductMapping[]> {
  const result = await db
    .prepare(
      "SELECT * FROM product_mappings WHERE shop_id = ? AND is_active = 1 AND NOT EXISTS (SELECT 1 FROM product_file_mappings WHERE product_file_mappings.product_mapping_id = product_mappings.id)"
    )
    .bind(shopId)
    .all<ProductMapping>();
  return result.results;
}

export async function upsertProductMapping(
  db: D1Database,
  shopId: number,
  data: {
    shopify_product_id: string;
    shopify_variant_id: string;
    shopify_sku?: string | null;
    shopify_barcode?: string | null;
    shopify_title?: string | null;
    shopify_variant_title?: string | null;
    simplyprint_file_id?: string | null;
    simplyprint_file_name?: string | null;
    yield_per_print?: number;
    stock_threshold?: number | null;
    filament_color?: string | null;
    is_auto_mapped?: boolean;
  }
): Promise<ProductMapping> {
  const existing = await getProductMappingByVariant(db, shopId, data.shopify_variant_id);

  if (existing) {
    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (data.filament_color !== undefined) {
      updates.push("filament_color = ?");
      values.push(data.filament_color);
    }
    if (data.shopify_sku !== undefined) {
      updates.push("shopify_sku = ?");
      values.push(data.shopify_sku);
    }
    if (data.shopify_barcode !== undefined) {
      updates.push("shopify_barcode = ?");
      values.push(data.shopify_barcode);
    }
    if (data.shopify_title !== undefined) {
      updates.push("shopify_title = ?");
      values.push(data.shopify_title);
    }
    if (data.shopify_variant_title !== undefined) {
      updates.push("shopify_variant_title = ?");
      values.push(data.shopify_variant_title);
    }
    if (data.simplyprint_file_id !== undefined) {
      updates.push("simplyprint_file_id = ?");
      values.push(data.simplyprint_file_id);
    }
    if (data.simplyprint_file_name !== undefined) {
      updates.push("simplyprint_file_name = ?");
      values.push(data.simplyprint_file_name);
    }
    if (data.yield_per_print !== undefined) {
      updates.push("yield_per_print = ?");
      values.push(data.yield_per_print);
    }
    if (data.stock_threshold !== undefined) {
      updates.push("stock_threshold = ?");
      values.push(data.stock_threshold);
    }
    if (data.is_auto_mapped !== undefined) {
      updates.push("is_auto_mapped = ?");
      values.push(data.is_auto_mapped ? 1 : 0);
    }

    if (updates.length > 0) {
      updates.push("updated_at = unixepoch()");
      values.push(existing.id, shopId);

      await db
        .prepare(`UPDATE product_mappings SET ${updates.join(", ")} WHERE id = ? AND shop_id = ?`)
        .bind(...values)
        .run();
    }

    return (await getProductMappingByVariant(db, shopId, data.shopify_variant_id))!;
  }

  await db
    .prepare(
      `INSERT INTO product_mappings (
        shop_id, shopify_product_id, shopify_variant_id, shopify_sku, shopify_barcode,
        shopify_title, shopify_variant_title, simplyprint_file_id, simplyprint_file_name,
        yield_per_print, stock_threshold, filament_color, is_auto_mapped
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      shopId,
      data.shopify_product_id,
      data.shopify_variant_id,
      data.shopify_sku || null,
      data.shopify_barcode || null,
      data.shopify_title || null,
      data.shopify_variant_title || null,
      data.simplyprint_file_id || null,
      data.simplyprint_file_name || null,
      data.yield_per_print || 1,
      data.stock_threshold ?? null,
      data.filament_color || null,
      data.is_auto_mapped ? 1 : 0
    )
    .run();

  return (await getProductMappingByVariant(db, shopId, data.shopify_variant_id))!;
}

export async function updateProductMapping(
  db: D1Database,
  shopId: number,
  mappingId: number,
  data: {
    simplyprint_file_id?: string | null;
    simplyprint_file_name?: string | null;
    yield_per_print?: number;
    stock_threshold?: number | null;
    current_stock?: number;
    inventory_tracked?: boolean;
    filament_color?: string | null;
  }
): Promise<void> {
  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (data.filament_color !== undefined) {
    updates.push("filament_color = ?");
    values.push(data.filament_color);
  }
  if (data.simplyprint_file_id !== undefined) {
    updates.push("simplyprint_file_id = ?");
    values.push(data.simplyprint_file_id);
  }
  if (data.simplyprint_file_name !== undefined) {
    updates.push("simplyprint_file_name = ?");
    values.push(data.simplyprint_file_name);
  }
  if (data.yield_per_print !== undefined) {
    updates.push("yield_per_print = ?");
    values.push(data.yield_per_print);
  }
  if (data.stock_threshold !== undefined) {
    updates.push("stock_threshold = ?");
    values.push(data.stock_threshold);
  }
  if (data.current_stock !== undefined) {
    updates.push("current_stock = ?");
    values.push(data.current_stock);
  }
  if (data.inventory_tracked !== undefined) {
    updates.push("inventory_tracked = ?");
    values.push(data.inventory_tracked ? 1 : 0);
  }

  if (updates.length === 0) return;

  updates.push("updated_at = unixepoch()");
  values.push(mappingId, shopId);

  // shop_id is part of the predicate so a mapping id from one shop can never
  // be used to write to another shop's row.
  await db
    .prepare(`UPDATE product_mappings SET ${updates.join(", ")} WHERE id = ? AND shop_id = ?`)
    .bind(...values)
    .run();
}

// Apply file mapping + settings to ALL variants of a product at once
export async function updateProductMappingsByProduct(
  db: D1Database,
  shopId: number,
  shopifyProductId: string,
  data: {
    simplyprint_file_id?: string | null;
    simplyprint_file_name?: string | null;
    yield_per_print?: number;
    stock_threshold?: number | null;
  }
): Promise<number> {
  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (data.simplyprint_file_id !== undefined) {
    updates.push("simplyprint_file_id = ?");
    values.push(data.simplyprint_file_id);
  }
  if (data.simplyprint_file_name !== undefined) {
    updates.push("simplyprint_file_name = ?");
    values.push(data.simplyprint_file_name);
  }
  if (data.yield_per_print !== undefined) {
    updates.push("yield_per_print = ?");
    values.push(data.yield_per_print);
  }
  if (data.stock_threshold !== undefined) {
    updates.push("stock_threshold = ?");
    values.push(data.stock_threshold);
  }

  if (updates.length === 0) return 0;

  updates.push("updated_at = unixepoch()");
  values.push(shopId, shopifyProductId);

  const result = await db
    .prepare(
      `UPDATE product_mappings SET ${updates.join(", ")} WHERE shop_id = ? AND shopify_product_id = ? AND is_active = 1`
    )
    .bind(...values)
    .run();

  return result.meta.changes;
}

// Update stock for a product (used after queueing prints or when orders are placed)
export async function adjustProductStock(
  db: D1Database,
  shopId: number,
  mappingId: number,
  delta: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE product_mappings
       SET current_stock = MAX(0, current_stock + ?), updated_at = unixepoch()
       WHERE id = ? AND shop_id = ?`
    )
    .bind(delta, mappingId, shopId)
    .run();
}

// Set absolute stock value for a product
export async function setProductStock(
  db: D1Database,
  shopId: number,
  mappingId: number,
  stock: number,
  inventoryTracked: boolean
): Promise<void> {
  await db
    .prepare(
      `UPDATE product_mappings
       SET current_stock = ?, inventory_tracked = ?, updated_at = unixepoch()
       WHERE id = ? AND shop_id = ?`
    )
    .bind(stock, inventoryTracked ? 1 : 0, mappingId, shopId)
    .run();
}

// Batch update stock for multiple products using D1 batch (chunked to stay within limits)
export async function bulkSetProductStock(
  db: D1Database,
  shopId: number,
  updates: { mappingId: number; stock: number; inventoryTracked: boolean }[]
): Promise<void> {
  if (updates.length === 0) return;

  // D1 batch supports up to 500 statements per call
  const chunkSize = 500;
  for (let i = 0; i < updates.length; i += chunkSize) {
    const chunk = updates.slice(i, i + chunkSize);
    const stmts = chunk.map(({ mappingId, stock, inventoryTracked }) =>
      db
        .prepare(
          `UPDATE product_mappings
           SET current_stock = ?, inventory_tracked = ?, updated_at = unixepoch()
           WHERE id = ? AND shop_id = ?`
        )
        .bind(stock, inventoryTracked ? 1 : 0, mappingId, shopId)
    );
    await db.batch(stmts);
  }
}

export async function deleteProductMapping(
  db: D1Database,
  shopId: number,
  mappingId: number
): Promise<void> {
  await db
    .prepare("UPDATE product_mappings SET is_active = 0, updated_at = unixepoch() WHERE id = ? AND shop_id = ?")
    .bind(mappingId, shopId)
    .run();
}

export async function getProductMappingStats(
  db: D1Database,
  shopId: number
): Promise<{ total: number; mapped: number; unmapped: number }> {
  const result = await db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM product_file_mappings WHERE product_file_mappings.product_mapping_id = product_mappings.id) THEN 1 ELSE 0 END) as mapped,
        SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM product_file_mappings WHERE product_file_mappings.product_mapping_id = product_mappings.id) THEN 1 ELSE 0 END) as unmapped
       FROM product_mappings
       WHERE shop_id = ? AND is_active = 1`
    )
    .bind(shopId)
    .first<{ total: number; mapped: number; unmapped: number }>();

  return result || { total: 0, mapped: 0, unmapped: 0 };
}

// Extract EAN from SimplyPrint filename like "Filament Spool Holder (1234567890123)"
export function extractEanFromFilename(filename: string): string | null {
  const match = filename.match(/\((\d{8,14})\)/);
  return match ? match[1] : null;
}
