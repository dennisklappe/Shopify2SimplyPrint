export interface ProductFileMapping {
  id: number;
  product_mapping_id: number;
  simplyprint_file_id: string;
  simplyprint_file_name: string | null;
  qty_per_product: number;
  yield_per_print: number;
  is_auto_mapped: number;
  created_at: number;
  updated_at: number;
}

export async function getFileMappingsByProductMapping(
  db: D1Database,
  productMappingId: number
): Promise<ProductFileMapping[]> {
  const result = await db
    .prepare("SELECT * FROM product_file_mappings WHERE product_mapping_id = ? ORDER BY id")
    .bind(productMappingId)
    .all<ProductFileMapping>();
  return result.results;
}

export async function getFileMappingsByShop(
  db: D1Database,
  shopId: number
): Promise<ProductFileMapping[]> {
  const result = await db
    .prepare(
      `SELECT pf.* FROM product_file_mappings pf
       JOIN product_mappings pm ON pf.product_mapping_id = pm.id
       WHERE pm.shop_id = ? AND pm.is_active = 1
       ORDER BY pf.product_mapping_id, pf.id`
    )
    .bind(shopId)
    .all<ProductFileMapping>();
  return result.results;
}

export async function addFileMapping(
  db: D1Database,
  productMappingId: number,
  data: {
    simplyprint_file_id: string;
    simplyprint_file_name?: string | null;
    qty_per_product?: number;
    yield_per_print?: number;
    is_auto_mapped?: boolean;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO product_file_mappings (product_mapping_id, simplyprint_file_id, simplyprint_file_name, qty_per_product, yield_per_print, is_auto_mapped)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(
      productMappingId,
      data.simplyprint_file_id,
      data.simplyprint_file_name || null,
      data.qty_per_product ?? 1,
      data.yield_per_print ?? 1,
      data.is_auto_mapped ? 1 : 0
    )
    .run();
}

export async function deleteFileMappingsByProductMapping(
  db: D1Database,
  productMappingId: number
): Promise<void> {
  await db
    .prepare("DELETE FROM product_file_mappings WHERE product_mapping_id = ?")
    .bind(productMappingId)
    .run();
}

// Replace all file mappings for a variant (used by map/map_product actions)
// Uses db.batch() for atomicity: delete + inserts run in a single transaction
export async function replaceFileMappings(
  db: D1Database,
  productMappingId: number,
  files: Array<{
    simplyprint_file_id: string;
    simplyprint_file_name?: string | null;
    qty_per_product?: number;
    yield_per_print?: number;
  }>
): Promise<void> {
  const deleteStmt = db
    .prepare("DELETE FROM product_file_mappings WHERE product_mapping_id = ?")
    .bind(productMappingId);

  const insertStmts = files.map((f) =>
    db
      .prepare(
        `INSERT INTO product_file_mappings (product_mapping_id, simplyprint_file_id, simplyprint_file_name, qty_per_product, yield_per_print)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(
        productMappingId,
        f.simplyprint_file_id,
        f.simplyprint_file_name || null,
        f.qty_per_product ?? 1,
        f.yield_per_print ?? 1
      )
  );

  // Run delete + inserts atomically in a single batch
  await db.batch([deleteStmt, ...insertStmts]);
}
