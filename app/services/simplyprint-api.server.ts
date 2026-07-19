import { decrypt } from "~/lib/encryption.server";

const SIMPLYPRINT_API_BASE = "https://api.simplyprint.io";

export interface SimplyPrintFile {
  id: string;
  name: string;
  size: number;
  created_at: string;
  folder_id: string | null;
}

export interface SimplyPrintFolder {
  id: string;
  name: string;
  parent_id: string | null;
}

export interface SimplyPrintQueueItem {
  id: string;
  filename: string;
  left: number; // quantity remaining to print
  printed: number;
  analysis?: {
    estimate?: number; // print time in seconds
  };
  cost?: {
    total_cost?: number;
  };
}

export interface SimplyPrintConfig {
  apiKey: string;
  companyId: string;
}

async function getDecryptedApiKey(
  encryptedApiKey: string,
  encryptionKey: string
): Promise<string> {
  return decrypt(encryptedApiKey, encryptionKey);
}

async function makeRequest<T>(
  config: SimplyPrintConfig,
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: Record<string, unknown>
): Promise<T> {
  const url = `${SIMPLYPRINT_API_BASE}/${config.companyId}${endpoint}`;

  const response = await fetch(url, {
    method,
    headers: {
      "X-API-KEY": config.apiKey,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SimplyPrint API error: ${response.status} ${errorText}`);
  }

  const data = await response.json() as T & { status?: boolean; message?: string };

  // SimplyPrint API returns { status: false, message: "..." } on logical errors with HTTP 200
  if (data.status === false) {
    throw new Error(`SimplyPrint API error: ${data.message || "Unknown error"}`);
  }

  return data;
}

// Test API connection
export async function testConnection(
  encryptedApiKey: string,
  companyId: string,
  encryptionKey: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const apiKey = await getDecryptedApiKey(encryptedApiKey, encryptionKey);
    const config: SimplyPrintConfig = { apiKey, companyId };

    // Test with account endpoint
    await makeRequest(config, "/account/Test");
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Get all files from SimplyPrint
export async function getFiles(
  encryptedApiKey: string,
  companyId: string,
  encryptionKey: string,
  folderId?: string,
  search?: string
): Promise<{ files: SimplyPrintFile[]; folders: SimplyPrintFolder[] }> {
  const apiKey = await getDecryptedApiKey(encryptedApiKey, encryptionKey);
  const config: SimplyPrintConfig = { apiKey, companyId };

  let endpoint = "/files/GetFiles";
  const params = new URLSearchParams();
  if (folderId) params.set("f", folderId);
  if (search) params.set("search", search);

  if (params.toString()) {
    endpoint += `?${params.toString()}`;
  }

  const response = await makeRequest<{
    files: SimplyPrintFile[];
    folders: SimplyPrintFolder[];
  }>(config, endpoint);

  return response;
}

// Get all files recursively (for auto-mapping and file picker)
export async function getAllFiles(
  encryptedApiKey: string,
  companyId: string,
  encryptionKey: string
): Promise<(SimplyPrintFile & { folder_path: string })[]> {
  const apiKey = await getDecryptedApiKey(encryptedApiKey, encryptionKey);
  const config: SimplyPrintConfig = { apiKey, companyId };

  const allFiles: (SimplyPrintFile & { folder_path: string })[] = [];

  async function fetchFolder(folderId?: string, path: string = ""): Promise<void> {
    let endpoint = "/files/GetFiles";
    if (folderId) endpoint += `?f=${folderId}`;

    const response = await makeRequest<{
      files: SimplyPrintFile[];
      folders: SimplyPrintFolder[];
    }>(config, endpoint);

    const files = response.files || [];
    const folders = response.folders || [];

    for (const file of files) {
      allFiles.push({ ...file, folder_path: path || "/" });
    }

    // Recursively fetch subfolders in parallel
    if (folders.length > 0) {
      await Promise.all(folders.map((folder) =>
        fetchFolder(folder.id, path ? `${path}/${folder.name}` : folder.name)
      ));
    }
  }

  await fetchFolder();
  return allFiles;
}

// Add item to print queue
export async function addToQueue(
  encryptedApiKey: string,
  companyId: string,
  encryptionKey: string,
  fileId: string,
  amount: number = 1,
  options?: {
    group?: number;
    tags?: string[];
    forPrinters?: string[];
    filamentColor?: string;
  }
): Promise<{ success: boolean; queueItemId?: string; error?: string }> {
  try {
    const apiKey = await getDecryptedApiKey(encryptedApiKey, encryptionKey);
    const config: SimplyPrintConfig = { apiKey, companyId };

    const body: Record<string, unknown> = {
      filesystem: fileId,
      amount,
    };

    if (options?.group !== undefined) body.group = options.group;
    if (options?.tags) body.tags = options.tags;
    if (options?.forPrinters) body.for_printers = options.forPrinters;
    if (options?.filamentColor) {
      body.tags = {
        ...(body.tags as Record<string, unknown> || {}),
        material: [{ color: options.filamentColor, ext: 0 }],
      };
    }

    const response = await makeRequest<{ created_id?: number }>(
      config,
      "/queue/AddItem",
      "POST",
      body
    );

    return {
      success: true,
      queueItemId: response.created_id?.toString(),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Get queue items
export async function getQueueItems(
  encryptedApiKey: string,
  companyId: string,
  encryptionKey: string
): Promise<SimplyPrintQueueItem[]> {
  const apiKey = await getDecryptedApiKey(encryptedApiKey, encryptionKey);
  const config: SimplyPrintConfig = { apiKey, companyId };

  const response = await makeRequest<{ queue: SimplyPrintQueueItem[] }>(
    config,
    "/queue/GetItems"
  );

  return response.queue || [];
}

// Get queue summary (total jobs, print time, etc.)
export async function getQueueSummary(
  encryptedApiKey: string,
  companyId: string,
  encryptionKey: string
): Promise<{ totalJobs: number; totalPrintTime: number }> {
  const items = await getQueueItems(encryptedApiKey, companyId, encryptionKey);

  // Calculate total print time from items
  // Each item has analysis.estimate (seconds per print) and left (remaining quantity)
  const totalPrintTime = items.reduce((sum, item) => {
    const estimatePerPrint = item.analysis?.estimate || 0;
    const quantity = item.left || 1;
    return sum + estimatePerPrint * quantity;
  }, 0);

  return {
    totalJobs: items.length,
    totalPrintTime,
  };
}

// Format seconds to human readable time (e.g., "1d 5h 55m")
export function formatPrintTime(seconds: number): string {
  if (seconds <= 0) return "0m";

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);

  return parts.join(" ");
}

// Get queue groups
export interface SimplyPrintQueueGroup {
  id: number;
  name: string;
}

export async function getQueueGroups(
  encryptedApiKey: string,
  companyId: string,
  encryptionKey: string
): Promise<SimplyPrintQueueGroup[]> {
  const apiKey = await getDecryptedApiKey(encryptedApiKey, encryptionKey);
  const config: SimplyPrintConfig = { apiKey, companyId };

  try {
    const response = await makeRequest<{ list: SimplyPrintQueueGroup[] }>(
      config,
      "/queue/groups/Get"
    );
    return response.list || [];
  } catch {
    return [];
  }
}

// Delete queue item
export async function deleteQueueItem(
  encryptedApiKey: string,
  companyId: string,
  encryptionKey: string,
  queueItemId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const apiKey = await getDecryptedApiKey(encryptedApiKey, encryptionKey);
    const config: SimplyPrintConfig = { apiKey, companyId };

    await makeRequest(
      config,
      "/queue/DeleteItem",
      "POST",
      { id: queueItemId }
    );

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Extract EAN from filename like "Filament Spool Holder (1234567890123)"
export function extractEanFromFilename(filename: string): string | null {
  // Match 8-14 digit numbers in parentheses (EAN-8, EAN-13, UPC, etc.)
  const match = filename.match(/\((\d{8,14})\)/);
  return match ? match[1] : null;
}

// Build a map of EAN -> file for auto-mapping
export async function buildEanToFileMap(
  encryptedApiKey: string,
  companyId: string,
  encryptionKey: string
): Promise<Map<string, SimplyPrintFile>> {
  const files = await getAllFiles(encryptedApiKey, companyId, encryptionKey);
  const eanMap = new Map<string, SimplyPrintFile>();

  for (const file of files) {
    const ean = extractEanFromFilename(file.name);
    if (ean) {
      eanMap.set(ean, file);
    }
  }

  return eanMap;
}
