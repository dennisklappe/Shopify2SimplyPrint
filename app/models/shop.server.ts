export interface Shop {
  id: number;
  shopify_domain: string;
  shopify_access_token: string;
  simplyprint_api_key: string | null;
  simplyprint_company_id: string | null;
  settings_mode: "simple" | "advanced";
  settings_default_threshold: number;
  settings_default_yield: number;
  settings_filament_color: number;
  simplyprint_queue_group: number | null;
  prints_this_month: number;
  prints_month_start: string | null;
  is_active: number;
  created_at: number;
  updated_at: number;
  language: string | null;
  shop_email: string | null;
  shop_owner_name: string | null;
  simplyprint_connected_at: number | null;
}

export interface ShopSettings {
  mode: "simple" | "advanced";
  default_threshold: number;
  default_yield: number;
  filament_color_enabled: boolean;
  queue_group: number | null;
}

export async function getShopByDomain(
  db: D1Database,
  domain: string
): Promise<Shop | null> {
  const result = await db
    .prepare("SELECT * FROM shops WHERE shopify_domain = ?")
    .bind(domain)
    .first<Shop>();
  return result || null;
}

export async function getShopById(
  db: D1Database,
  id: number
): Promise<Shop | null> {
  const result = await db
    .prepare("SELECT * FROM shops WHERE id = ?")
    .bind(id)
    .first<Shop>();
  return result || null;
}

export async function upsertShop(
  db: D1Database,
  domain: string,
  accessToken: string
): Promise<Shop> {
  const existing = await getShopByDomain(db, domain);

  if (existing) {
    await db
      .prepare(
        `UPDATE shops
         SET shopify_access_token = ?, is_active = 1, updated_at = unixepoch()
         WHERE shopify_domain = ?`
      )
      .bind(accessToken, domain)
      .run();

    return (await getShopByDomain(db, domain))!;
  }

  await db
    .prepare(
      `INSERT INTO shops (shopify_domain, shopify_access_token, prints_this_month)
       VALUES (?, ?, 0)`
    )
    .bind(domain, accessToken)
    .run();

  return (await getShopByDomain(db, domain))!;
}

export async function updateShopSimplyPrintCredentials(
  db: D1Database,
  shopId: number,
  apiKey: string | null,
  companyId: string | null
): Promise<void> {
  await db
    .prepare(
      `UPDATE shops
       SET simplyprint_api_key = ?,
           simplyprint_company_id = ?,
           updated_at = unixepoch()
       WHERE id = ?`
    )
    .bind(apiKey, companyId, shopId)
    .run();
}

export async function updateShopSettings(
  db: D1Database,
  shopId: number,
  settings: Partial<ShopSettings>
): Promise<void> {
  const updates: string[] = [];
  const values: (string | number | null)[] = [];

  if (settings.mode !== undefined) {
    updates.push("settings_mode = ?");
    values.push(settings.mode);
  }
  if (settings.default_threshold !== undefined) {
    updates.push("settings_default_threshold = ?");
    values.push(settings.default_threshold);
  }
  if (settings.default_yield !== undefined) {
    updates.push("settings_default_yield = ?");
    values.push(settings.default_yield);
  }
  if (settings.filament_color_enabled !== undefined) {
    updates.push("settings_filament_color = ?");
    values.push(settings.filament_color_enabled ? 1 : 0);
  }
  if (settings.queue_group !== undefined) {
    updates.push("simplyprint_queue_group = ?");
    values.push(settings.queue_group);
  }

  if (updates.length === 0) return;

  updates.push("updated_at = unixepoch()");
  values.push(shopId);

  await db
    .prepare(`UPDATE shops SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
}

export async function clearSimplyPrintCredentials(
  db: D1Database,
  shopId: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE shops
       SET simplyprint_api_key = NULL,
           simplyprint_company_id = NULL,
           updated_at = unixepoch()
       WHERE id = ?`
    )
    .bind(shopId)
    .run();
}

export async function deactivateShop(
  db: D1Database,
  domain: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE shops SET is_active = 0, updated_at = unixepoch() WHERE shopify_domain = ?`
    )
    .bind(domain)
    .run();
}

export function getShopSettings(shop: Shop): ShopSettings {
  return {
    mode: shop.settings_mode || "simple",
    default_threshold: shop.settings_default_threshold || 100,
    default_yield: shop.settings_default_yield || 1,
    filament_color_enabled: Boolean(shop.settings_filament_color),
    queue_group: shop.simplyprint_queue_group ?? null,
  };
}

export async function incrementPrintCount(
  db: D1Database,
  shopId: number,
  count: number = 1
): Promise<void> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];

  const shop = await getShopById(db, shopId);
  if (shop && shop.prints_month_start !== monthStart) {
    // New month, reset counter
    await db
      .prepare(
        `UPDATE shops SET prints_this_month = ?, prints_month_start = ?, updated_at = unixepoch() WHERE id = ?`
      )
      .bind(count, monthStart, shopId)
      .run();
  } else {
    // Same month, increment counter
    await db
      .prepare(
        `UPDATE shops SET prints_this_month = prints_this_month + ?, updated_at = unixepoch() WHERE id = ?`
      )
      .bind(count, shopId)
      .run();
  }
}

export async function resetPrintCount(
  db: D1Database,
  shopId: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE shops SET prints_this_month = 0, prints_month_start = NULL, updated_at = unixepoch() WHERE id = ?`
    )
    .bind(shopId)
    .run();
}

export async function markSimplyprintConnected(db: D1Database, shopId: number): Promise<void> {
  await db
    .prepare("UPDATE shops SET simplyprint_connected_at = unixepoch(), updated_at = unixepoch() WHERE id = ? AND simplyprint_connected_at IS NULL")
    .bind(shopId)
    .run();
}

export async function updateShopEmail(db: D1Database, shopId: number, email: string, ownerName: string): Promise<void> {
  await db
    .prepare("UPDATE shops SET shop_email = ?, shop_owner_name = ?, updated_at = unixepoch() WHERE id = ?")
    .bind(email, ownerName, shopId)
    .run();
}
