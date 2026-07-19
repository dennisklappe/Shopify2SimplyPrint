import { Session } from "@shopify/shopify-api";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";

const CREATE_SESSIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS shopify_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    shop TEXT NOT NULL,
    state TEXT,
    isOnline INTEGER NOT NULL DEFAULT 0,
    scope TEXT,
    expires INTEGER,
    accessToken TEXT,
    userId TEXT,
    firstName TEXT,
    lastName TEXT,
    email TEXT,
    accountOwner INTEGER DEFAULT 0,
    locale TEXT,
    collaborator INTEGER DEFAULT 0,
    emailVerified INTEGER DEFAULT 0
  )
`;

const CREATE_SESSIONS_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_shopify_sessions_shop ON shopify_sessions(shop)
`;

export class D1SessionStorage implements SessionStorage {
  private db: D1Database;
  private initialized = false;

  constructor(db: D1Database) {
    this.db = db;
  }

  private async ensureTable(): Promise<void> {
    if (this.initialized) return;
    try {
      await this.db.prepare(CREATE_SESSIONS_TABLE).run();
      await this.db.prepare(CREATE_SESSIONS_INDEX).run();
      this.initialized = true;
    } catch (error) {
      // Table might already exist, that's fine
      console.log("Session table init:", error);
      this.initialized = true;
    }
  }

  async storeSession(session: Session): Promise<boolean> {
    await this.ensureTable();

    const entries = sessionToEntries(session);

    const query = `
      INSERT OR REPLACE INTO shopify_sessions (
        id, shop, state, isOnline, scope, expires, accessToken,
        userId, firstName, lastName, email, accountOwner, locale, collaborator, emailVerified
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.db
      .prepare(query)
      .bind(
        entries.id,
        entries.shop,
        entries.state,
        entries.isOnline,
        entries.scope,
        entries.expires,
        entries.accessToken,
        entries.userId,
        entries.firstName,
        entries.lastName,
        entries.email,
        entries.accountOwner,
        entries.locale,
        entries.collaborator,
        entries.emailVerified
      )
      .run();

    return true;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    await this.ensureTable();

    const result = await this.db
      .prepare("SELECT * FROM shopify_sessions WHERE id = ?")
      .bind(id)
      .first<SessionRow>();

    if (!result) {
      return undefined;
    }

    return rowToSession(result);
  }

  async deleteSession(id: string): Promise<boolean> {
    await this.ensureTable();

    await this.db
      .prepare("DELETE FROM shopify_sessions WHERE id = ?")
      .bind(id)
      .run();

    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    await this.ensureTable();

    if (ids.length === 0) return true;

    const placeholders = ids.map(() => "?").join(", ");
    await this.db
      .prepare(`DELETE FROM shopify_sessions WHERE id IN (${placeholders})`)
      .bind(...ids)
      .run();

    return true;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    await this.ensureTable();

    const result = await this.db
      .prepare("SELECT * FROM shopify_sessions WHERE shop = ?")
      .bind(shop)
      .all<SessionRow>();

    return (result.results || []).map(rowToSession);
  }
}

interface SessionRow {
  id: string;
  shop: string;
  state: string | null;
  isOnline: number;
  scope: string | null;
  expires: number | null;
  accessToken: string | null;
  userId: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  accountOwner: number;
  locale: string | null;
  collaborator: number;
  emailVerified: number;
}

interface SessionEntries {
  id: string;
  shop: string;
  state: string | null;
  isOnline: number;
  scope: string | null;
  expires: number | null;
  accessToken: string | null;
  userId: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  accountOwner: number;
  locale: string | null;
  collaborator: number;
  emailVerified: number;
}

function sessionToEntries(session: Session): SessionEntries {
  return {
    id: session.id,
    shop: session.shop,
    state: session.state || null,
    isOnline: session.isOnline ? 1 : 0,
    scope: session.scope || null,
    expires: session.expires ? session.expires.getTime() : null,
    accessToken: session.accessToken || null,
    userId: session.onlineAccessInfo?.associated_user?.id?.toString() || null,
    firstName: session.onlineAccessInfo?.associated_user?.first_name || null,
    lastName: session.onlineAccessInfo?.associated_user?.last_name || null,
    email: session.onlineAccessInfo?.associated_user?.email || null,
    accountOwner: session.onlineAccessInfo?.associated_user?.account_owner ? 1 : 0,
    locale: session.onlineAccessInfo?.associated_user?.locale || null,
    collaborator: session.onlineAccessInfo?.associated_user?.collaborator ? 1 : 0,
    emailVerified: session.onlineAccessInfo?.associated_user?.email_verified ? 1 : 0,
  };
}

function rowToSession(row: SessionRow): Session {
  const sessionData: {
    id: string;
    shop: string;
    state: string;
    isOnline: boolean;
    scope?: string;
    accessToken?: string;
    expires?: Date;
    onlineAccessInfo?: {
      expires_in: number;
      associated_user_scope: string;
      associated_user: {
        id: number;
        first_name: string;
        last_name: string;
        email: string;
        account_owner: boolean;
        locale: string;
        collaborator: boolean;
        email_verified: boolean;
      };
    };
  } = {
    id: row.id,
    shop: row.shop,
    state: row.state || "",
    isOnline: Boolean(row.isOnline),
    scope: row.scope || undefined,
    accessToken: row.accessToken || undefined,
  };

  if (row.expires) {
    sessionData.expires = new Date(row.expires);
  }

  if (row.userId) {
    sessionData.onlineAccessInfo = {
      expires_in: 0,
      associated_user_scope: row.scope || "",
      associated_user: {
        id: parseInt(row.userId, 10),
        first_name: row.firstName || "",
        last_name: row.lastName || "",
        email: row.email || "",
        account_owner: Boolean(row.accountOwner),
        locale: row.locale || "",
        collaborator: Boolean(row.collaborator),
        email_verified: Boolean(row.emailVerified),
      },
    };
  }

  return new Session(sessionData);
}
