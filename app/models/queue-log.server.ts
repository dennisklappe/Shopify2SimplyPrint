export interface QueueLog {
  id: number;
  shop_id: number;
  shopify_order_id: string;
  shopify_order_number: string | null;
  shopify_line_item_id: string | null;
  product_mapping_id: number | null;
  shopify_product_title: string | null;
  simplyprint_file_id: string | null;
  simplyprint_queue_item_id: string | null;
  quantity_ordered: number;
  prints_queued: number;
  inventory_adjusted: number;
  status: "queued" | "printing" | "completed" | "failed" | "skipped";
  skip_reason: string | null;
  error_message: string | null;
  created_at: number;
}

export async function getQueueLogsByShop(
  db: D1Database,
  shopId: number,
  limit: number = 100
): Promise<QueueLog[]> {
  const result = await db
    .prepare(
      "SELECT * FROM queue_log WHERE shop_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .bind(shopId, limit)
    .all<QueueLog>();
  return result.results;
}

export async function getQueueLogsByOrder(
  db: D1Database,
  shopId: number,
  orderId: string
): Promise<QueueLog[]> {
  const result = await db
    .prepare(
      "SELECT * FROM queue_log WHERE shop_id = ? AND shopify_order_id = ? ORDER BY created_at DESC"
    )
    .bind(shopId, orderId)
    .all<QueueLog>();
  return result.results;
}

export async function createQueueLog(
  db: D1Database,
  data: {
    shop_id: number;
    shopify_order_id: string;
    shopify_order_number?: string | null;
    shopify_line_item_id?: string | null;
    product_mapping_id?: number | null;
    shopify_product_title?: string | null;
    simplyprint_file_id?: string | null;
    simplyprint_queue_item_id?: string | null;
    quantity_ordered: number;
    prints_queued: number;
    inventory_adjusted?: number;
    status: "queued" | "printing" | "completed" | "failed" | "skipped";
    skip_reason?: string | null;
    error_message?: string | null;
  }
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO queue_log (
        shop_id, shopify_order_id, shopify_order_number, shopify_line_item_id,
        product_mapping_id, shopify_product_title, simplyprint_file_id,
        simplyprint_queue_item_id, quantity_ordered, prints_queued, inventory_adjusted,
        status, skip_reason, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      data.shop_id,
      data.shopify_order_id,
      data.shopify_order_number || null,
      data.shopify_line_item_id || null,
      data.product_mapping_id || null,
      data.shopify_product_title || null,
      data.simplyprint_file_id || null,
      data.simplyprint_queue_item_id || null,
      data.quantity_ordered,
      data.prints_queued,
      data.inventory_adjusted || 0,
      data.status,
      data.skip_reason || null,
      data.error_message || null
    )
    .run();

  return result.meta.last_row_id;
}

export async function getQueueStats(
  db: D1Database,
  shopId: number
): Promise<{
  total: number;
  queued: number;
  printing: number;
  completed: number;
  failed: number;
  skipped: number;
  totalPrints: number;
}> {
  const result = await db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
        SUM(CASE WHEN status = 'printing' THEN 1 ELSE 0 END) as printing,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped,
        SUM(prints_queued) as totalPrints
       FROM queue_log
       WHERE shop_id = ?`
    )
    .bind(shopId)
    .first<{
      total: number;
      queued: number;
      printing: number;
      completed: number;
      failed: number;
      skipped: number;
      totalPrints: number;
    }>();

  return result || {
    total: 0,
    queued: 0,
    printing: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    totalPrints: 0,
  };
}

export async function getRecentQueueActivity(
  db: D1Database,
  shopId: number,
  days: number = 7
): Promise<QueueLog[]> {
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const result = await db
    .prepare(
      "SELECT * FROM queue_log WHERE shop_id = ? AND created_at >= ? ORDER BY created_at DESC"
    )
    .bind(shopId, cutoff)
    .all<QueueLog>();
  return result.results;
}

export async function hasOrderBeenQueued(
  db: D1Database,
  shopId: number,
  orderId: string,
  lineItemId?: string,
  simplyprintFileId?: string
): Promise<boolean> {
  let query = "SELECT COUNT(*) as count FROM queue_log WHERE shop_id = ? AND shopify_order_id = ?";
  const params: (number | string)[] = [shopId, orderId];

  if (lineItemId) {
    query += " AND shopify_line_item_id = ?";
    params.push(lineItemId);
  }

  if (simplyprintFileId) {
    query += " AND simplyprint_file_id = ?";
    params.push(simplyprintFileId);
  }

  // Exclude failed entries so retries can re-attempt them
  query += " AND status != 'failed'";

  const result = await db
    .prepare(query)
    .bind(...params)
    .first<{ count: number }>();

  return (result?.count || 0) > 0;
}
