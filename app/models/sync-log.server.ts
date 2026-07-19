export interface SyncLog {
  id: number;
  shop_id: number;
  sync_type: string;
  status: string;
  message: string | null;
  details: string | null;
  items_processed: number;
  items_created: number;
  items_updated: number;
  items_failed: number;
  duration_ms: number | null;
  created_at: number;
}

export async function createSyncLog(
  db: D1Database,
  data: {
    shop_id: number;
    sync_type: string;
    status: string;
    message?: string | null;
    details?: string | null;
    items_processed?: number;
    items_created?: number;
    items_updated?: number;
    items_failed?: number;
    duration_ms?: number | null;
  }
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO sync_logs (
        shop_id, sync_type, status, message, details,
        items_processed, items_created, items_updated, items_failed, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      data.shop_id,
      data.sync_type,
      data.status,
      data.message || null,
      data.details || null,
      data.items_processed || 0,
      data.items_created || 0,
      data.items_updated || 0,
      data.items_failed || 0,
      data.duration_ms || null
    )
    .run();

  return result.meta.last_row_id;
}

export async function getSyncLogsByShop(
  db: D1Database,
  shopId: number,
  limit: number = 50
): Promise<SyncLog[]> {
  const result = await db
    .prepare(
      "SELECT * FROM sync_logs WHERE shop_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .bind(shopId, limit)
    .all<SyncLog>();
  return result.results;
}

export async function getLatestSyncLog(
  db: D1Database,
  shopId: number,
  syncType?: string
): Promise<SyncLog | null> {
  let query = "SELECT * FROM sync_logs WHERE shop_id = ?";
  const params: (number | string)[] = [shopId];

  if (syncType) {
    query += " AND sync_type = ?";
    params.push(syncType);
  }

  query += " ORDER BY created_at DESC LIMIT 1";

  const result = await db
    .prepare(query)
    .bind(...params)
    .first<SyncLog>();

  return result || null;
}

export async function getSyncSummary(
  db: D1Database,
  shopId: number,
  days: number = 7
): Promise<{
  totalSyncs: number;
  successfulSyncs: number;
  failedSyncs: number;
  totalItemsProcessed: number;
  totalItemsCreated: number;
  totalItemsFailed: number;
}> {
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;

  const result = await db
    .prepare(
      `SELECT
        COUNT(*) as totalSyncs,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successfulSyncs,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as failedSyncs,
        SUM(items_processed) as totalItemsProcessed,
        SUM(items_created) as totalItemsCreated,
        SUM(items_failed) as totalItemsFailed
       FROM sync_logs
       WHERE shop_id = ? AND created_at >= ?`
    )
    .bind(shopId, cutoff)
    .first<{
      totalSyncs: number;
      successfulSyncs: number;
      failedSyncs: number;
      totalItemsProcessed: number;
      totalItemsCreated: number;
      totalItemsFailed: number;
    }>();

  return result || {
    totalSyncs: 0,
    successfulSyncs: 0,
    failedSyncs: 0,
    totalItemsProcessed: 0,
    totalItemsCreated: 0,
    totalItemsFailed: 0,
  };
}

export async function cleanupOldSyncLogs(
  db: D1Database,
  shopId: number,
  keepDays: number = 30
): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - keepDays * 24 * 60 * 60;

  const result = await db
    .prepare("DELETE FROM sync_logs WHERE shop_id = ? AND created_at < ?")
    .bind(shopId, cutoff)
    .run();

  return result.meta.changes;
}
