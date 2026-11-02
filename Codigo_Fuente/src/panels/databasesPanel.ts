import * as vscode from "vscode";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type {
  DbCell,
  DbColumn,
  DbForeignKey,
  DbIndex,
  DbProfile,
  DbProfileView,
  DbQueryColumn,
  DbQueryResult,
  DbStructureColumn,
  DbTableInfo,
  DbTableSpec,
  DbTableSpecColumn,
} from "../databases/types";
import { DbSession } from "../databases/driver";
import { SshTunnel, type HostKeyStore, type SshSecrets } from "../databases/ssh";
import {
  alterTable,
  createDatabase,
  createTable,
  dropDatabase,
  dropTable,
  listColumns,
  listDatabases,
  listForeignKeys,
  listIndexes,
  listTables,
  primaryKeyColumns,
  renameTable,
  tableCount,
  truncateTable,
} from "../databases/introspect";
import { orderByClause, searchWhere } from "../databases/search";
import { deleteRows, insertRow, updateRowCell, type RowIdentity } from "../databases/rows";
import { runConsole, statementsOf } from "../databases/console";
import { exportTable, type ExportFormat } from "../databases/export";
import { dumpDatabase, type DumpConnection, type DumpOptions } from "../databases/dump";
import { ident, qualified } from "../databases/quote";

const KEY_PROFILES = "opencodeAgents.dbProfiles";
const KEY_HOST_KEYS = "opencodeAgents.sshHostKeys";
const KEY_ACTIVE_PROFILE = "opencodeAgents.db.profile";
const KEY_ACTIVE_DB = "opencodeAgents.db.database";
const KEY_ACTIVE_TABLE = "opencodeAgents.db.table";
const KEY_ACTIVE_TAB = "opencodeAgents.db.tab";
const KEY_PAGE_SIZE = "opencodeAgents.db.pageSize";
const KEY_SEARCH = "opencodeAgents.db.search";
const KEY_BACKUP_DIR = "opencodeAgents.db.backupDir";

const DEFAULT_PAGE_SIZE = 100;
const ALLOWED_PAGE_SIZES = [50, 100, 250, 500];

export interface DbUiState {
  profiles: DbProfileView[];
  activeProfileId?: string;
  connected: boolean;
  serverInfo?: string;
  databases: { name: string; tables: number }[];
  currentDb?: string;
  tables: DbTableInfo[];
  currentTable?: string;
  columns: DbColumn[];
  indexes: DbIndex[];
  foreignKeys: DbForeignKey[];
  data?: {
    columns: DbQueryColumn[];
    rows: DbCell[][];
    page: number;
    pageSize: number;
    truncated: boolean;
    ms: number;
    orderBy?: { column: string; dir: "asc" | "desc" };
    search: string;
    identity: string[];
  };
  console?: {
    results: { statement: string; result: DbQueryResult }[];
    error?: { index: number; message: string };
    sql: string;
  };
  busy?: string;
  error?: string;
  notice?: string;
  backupDir?: string;
}

export type DbAction =
  | {
      type: "saveProfile";
      profile: DbProfile;
      password?: string;
      sshPassword?: string;
      sshPassphrase?: string;
    }
  | { type: "deleteProfile"; id: string }
  | {
      type: "connect";
      id: string;
      password?: string;
      sshPassword?: string;
      sshPassphrase?: string;
    }
  | { type: "disconnect" }
  | { type: "refreshDatabases" }
  | { type: "selectDatabase"; database: string }
  | { type: "refreshTables" }
  | { type: "selectTable"; table: string }
  | {
      type: "loadData";
      page?: number;
      search?: string;
      orderBy?: { column: string; dir: "asc" | "desc" };
      pageSize?: number;
    }
  | { type: "refreshStructure" }
  | { type: "createDatabase"; name: string }
  | { type: "dropDatabase"; name: string; confirm: string }
  | { type: "createTable"; spec: DbTableSpec }
  | { type: "alterTable"; table: string; original: string[]; columns: DbStructureColumn[]; confirm: string }
  | { type: "dropTable"; table: string; confirm: string }
  | { type: "truncateTable"; table: string; confirm: string }
  | { type: "renameTable"; from: string; to: string }
  | { type: "insertRow"; values: Record<string, DbCell> }
  | { type: "updateCell"; identity: RowIdentity; column: string; value: DbCell }
  | { type: "deleteRows"; identity: { columns: string[]; rows: DbCell[][] } }
  | { type: "runSql"; sql: string; confirm?: string }
  | { type: "cancel" }
  | { type: "exportTable"; format: "csv" | "json" | "sql" }
  | { type: "backupDatabase" }
  | { type: "openBackupFolder" }
  | { type: "countTable" };

function getNonce(): string {
  return randomBytes(16).toString("hex");
}

/** Celda que llega del webview: texto, nulo o binario en base64. El resto se descarta. */
function parseCell(raw: unknown): { ok: true; cell: DbCell } | { ok: false } {
  if (raw === null) {
    return { ok: true, cell: null };
  }
  if (typeof raw === "string") {
    return { ok: true, cell: raw };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (
      typeof obj.b64 === "string" &&
      obj.b64.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(obj.b64) &&
      typeof obj.bytes === "number" &&
      Number.isFinite(obj.bytes) &&
      obj.bytes >= 0
    ) {
      return { ok: true, cell: { b64: obj.b64, bytes: obj.bytes } };
    }
  }
  return { ok: false };
}

/** Columna del editor de estructura: mismo saneado que `createTable`. */
function parseSpecColumn(raw: unknown): DbTableSpecColumn | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const c = raw as Record<string, unknown>;
  const name = typeof c.name === "string" ? c.name.trim() : "";
  const type = typeof c.type === "string" ? c.type.trim().toUpperCase() : "";
  if (!name || !type) {
    return undefined;
  }
  return {
    name,
    type,
    length: typeof c.length === "string" && c.length.trim() ? c.length.trim() : undefined,
    nullable: Boolean(c.nullable),
    defaultValue: typeof c.defaultValue === "string" ? c.defaultValue : null,
    autoIncrement: Boolean(c.autoIncrement),
    primaryKey: Boolean(c.primaryKey),
    comment: typeof c.comment === "string" && c.comment.trim() ? c.comment.trim() : undefined,
    unsigned: c.unsigned === true,
    zerofill: c.zerofill === true,
    onUpdate: c.onUpdate === true,
  };
}

function parseAction(raw: unknown): DbAction | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "";

  switch (type) {
    case "disconnect":
    case "refreshDatabases":
    case "refreshTables":
    case "refreshStructure":
    case "cancel":
    case "backupDatabase":
    case "openBackupFolder":
    case "countTable":
      return { type };

    case "deleteProfile": {
      const id = typeof obj.id === "string" ? obj.id.trim() : "";
      return id ? { type: "deleteProfile", id } : undefined;
    }

    case "selectDatabase": {
      const database = typeof obj.database === "string" ? obj.database.trim() : "";
      return database ? { type: "selectDatabase", database } : undefined;
    }

    case "selectTable": {
      const table = typeof obj.table === "string" ? obj.table.trim() : "";
      return table ? { type: "selectTable", table } : undefined;
    }

    case "saveProfile": {
      const rawProf = obj.profile;
      if (!rawProf || typeof rawProf !== "object") {
        return undefined;
      }
      const p = rawProf as Record<string, unknown>;
      const id = typeof p.id === "string" && p.id.trim() ? p.id.trim() : randomUUID();
      const name = typeof p.name === "string" ? p.name.trim() : "";
      const host = typeof p.host === "string" && p.host.trim() ? p.host.trim() : "127.0.0.1";
      const port = typeof p.port === "number" && p.port > 0 ? p.port : 3306;
      const user = typeof p.user === "string" ? p.user.trim() : "";
      const database = typeof p.database === "string" && p.database.trim() ? p.database.trim() : undefined;
      const ssl = p.ssl === "require" || p.ssl === "verify" ? p.ssl : "off";

      const rawTunnel = p.tunnel;
      const t = rawTunnel && typeof rawTunnel === "object" ? (rawTunnel as Record<string, unknown>) : {};
      const tunnel = {
        enabled: Boolean(t.enabled),
        host: typeof t.host === "string" ? t.host.trim() : "",
        port: typeof t.port === "number" && t.port > 0 ? t.port : 22,
        user: typeof t.user === "string" ? t.user.trim() : "",
        auth: t.auth === "key" || t.auth === "agent" ? (t.auth as "key" | "agent") : ("password" as const),
        keyPath: typeof t.keyPath === "string" && t.keyPath.trim() ? t.keyPath.trim() : undefined,
      };

      if (!name || !user) {
        return undefined;
      }

      const profile: DbProfile = { id, name, host, port, user, database, ssl, tunnel };
      const password = typeof obj.password === "string" ? obj.password : undefined;
      const sshPassword = typeof obj.sshPassword === "string" ? obj.sshPassword : undefined;
      const sshPassphrase = typeof obj.sshPassphrase === "string" ? obj.sshPassphrase : undefined;

      return { type: "saveProfile", profile, password, sshPassword, sshPassphrase };
    }

    case "connect": {
      const id = typeof obj.id === "string" ? obj.id.trim() : "";
      if (!id) {
        return undefined;
      }
      const password = typeof obj.password === "string" ? obj.password : undefined;
      const sshPassword = typeof obj.sshPassword === "string" ? obj.sshPassword : undefined;
      const sshPassphrase = typeof obj.sshPassphrase === "string" ? obj.sshPassphrase : undefined;
      return { type: "connect", id, password, sshPassword, sshPassphrase };
    }

    case "loadData": {
      const page = typeof obj.page === "number" && obj.page >= 0 ? Math.floor(obj.page) : undefined;
      const search = typeof obj.search === "string" ? obj.search : undefined;
      const pageSize =
        typeof obj.pageSize === "number" && ALLOWED_PAGE_SIZES.includes(obj.pageSize)
          ? obj.pageSize
          : undefined;
      let orderBy: { column: string; dir: "asc" | "desc" } | undefined;
      if (obj.orderBy && typeof obj.orderBy === "object") {
        const ob = obj.orderBy as Record<string, unknown>;
        if (typeof ob.column === "string" && ob.column.trim()) {
          orderBy = {
            column: ob.column.trim(),
            dir: ob.dir === "desc" ? "desc" : "asc",
          };
        }
      }
      return { type: "loadData", page, search, orderBy, pageSize };
    }

    case "createDatabase": {
      const name = typeof obj.name === "string" ? obj.name.trim() : "";
      return name ? { type: "createDatabase", name } : undefined;
    }

    case "dropDatabase": {
      const name = typeof obj.name === "string" ? obj.name.trim() : "";
      const confirm = typeof obj.confirm === "string" ? obj.confirm.trim() : "";
      return name && confirm ? { type: "dropDatabase", name, confirm } : undefined;
    }

    case "createTable": {
      const rawSpec = obj.spec;
      if (!rawSpec || typeof rawSpec !== "object") {
        return undefined;
      }
      const s = rawSpec as Record<string, unknown>;
      const name = typeof s.name === "string" ? s.name.trim() : "";
      if (!name || !Array.isArray(s.columns) || s.columns.length === 0) {
        return undefined;
      }
      const columns: DbTableSpecColumn[] = [];
      for (const rawCol of s.columns) {
        const column = parseSpecColumn(rawCol);
        if (!column) {
          return undefined;
        }
        columns.push(column);
      }
      return { type: "createTable", spec: { name, columns } };
    }

    case "alterTable": {
      const table = typeof obj.table === "string" ? obj.table.trim() : "";
      const confirm = typeof obj.confirm === "string" ? obj.confirm : "";
      if (
        !table ||
        !confirm ||
        !Array.isArray(obj.original) ||
        obj.original.length === 0 ||
        !Array.isArray(obj.columns) ||
        obj.columns.length === 0 ||
        obj.columns.length > 1017
      ) {
        return undefined;
      }
      const original: string[] = [];
      for (const rawName of obj.original) {
        if (typeof rawName !== "string" || !rawName.trim()) {
          return undefined;
        }
        original.push(rawName.trim());
      }
      const columns: DbStructureColumn[] = [];
      for (const rawCol of obj.columns) {
        if (!rawCol || typeof rawCol !== "object") {
          return undefined;
        }
        const entrada = rawCol as Record<string, unknown>;
        const column = parseSpecColumn(entrada.column);
        const rawOriginal = entrada.originalName;
        let originalName: string | null;
        if (rawOriginal === null) {
          originalName = null;
        } else if (typeof rawOriginal === "string" && rawOriginal.trim()) {
          originalName = rawOriginal.trim();
        } else {
          return undefined;
        }
        if (!column) {
          return undefined;
        }
        columns.push({ originalName, column });
      }
      return { type: "alterTable", table, original, columns, confirm };
    }

    case "dropTable":
    case "truncateTable": {
      const table = typeof obj.table === "string" ? obj.table.trim() : "";
      const confirm = typeof obj.confirm === "string" ? obj.confirm.trim() : "";
      return table && confirm ? { type, table, confirm } : undefined;
    }

    case "renameTable": {
      const from = typeof obj.from === "string" ? obj.from.trim() : "";
      const to = typeof obj.to === "string" ? obj.to.trim() : "";
      return from && to ? { type: "renameTable", from, to } : undefined;
    }

    case "insertRow": {
      if (!obj.values || typeof obj.values !== "object" || Array.isArray(obj.values)) {
        return undefined;
      }
      const values: Record<string, DbCell> = {};
      for (const [key, raw] of Object.entries(obj.values as Record<string, unknown>)) {
        const parsed = parseCell(raw);
        if (!parsed.ok) {
          return undefined;
        }
        values[key] = parsed.cell;
      }
      return { type: "insertRow", values };
    }

    case "updateCell": {
      const rawId = obj.identity;
      const column = typeof obj.column === "string" ? obj.column.trim() : "";
      if (!rawId || typeof rawId !== "object" || !column) {
        return undefined;
      }
      const idObj = rawId as Record<string, unknown>;
      if (!Array.isArray(idObj.columns) || !Array.isArray(idObj.values)) {
        return undefined;
      }
      const identity: RowIdentity = {
        columns: idObj.columns.map((c) => String(c)),
        values: idObj.values as DbCell[],
      };
      const parsed = parseCell(obj.value);
      if (!parsed.ok) {
        return undefined;
      }
      return {
        type: "updateCell",
        identity,
        column,
        value: parsed.cell,
      };
    }

    case "deleteRows": {
      const rawId = obj.identity;
      if (!rawId || typeof rawId !== "object") {
        return undefined;
      }
      const idObj = rawId as Record<string, unknown>;
      if (!Array.isArray(idObj.columns) || !Array.isArray(idObj.rows)) {
        return undefined;
      }
      const identity = {
        columns: idObj.columns.map((c) => String(c)),
        rows: idObj.rows as DbCell[][],
      };
      return { type: "deleteRows", identity };
    }

    case "runSql": {
      const sql = typeof obj.sql === "string" ? obj.sql : "";
      const confirm = typeof obj.confirm === "string" ? obj.confirm : undefined;
      return sql.trim() ? { type: "runSql", sql, confirm } : undefined;
    }

    case "exportTable": {
      const format = obj.format;
      if (format === "csv" || format === "json" || format === "sql") {
        return { type: "exportTable", format };
      }
      return undefined;
    }
  }

  return undefined;
}

export class DatabasesPanel {
  public static current?: DatabasesPanel;
  private static readonly viewType = "opencodeAgents.databases";

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly disposables: vscode.Disposable[] = [];

  private session?: DbSession;
  private tunnel?: SshTunnel;
  private activePassword?: string;
  private backupCancelled = false;
  private disposed = false;

  private actionQueue = Promise.resolve();

  private state: DbUiState = {
    profiles: [],
    connected: false,
    databases: [],
    tables: [],
    columns: [],
    indexes: [],
    foreignKeys: [],
  };

  static open(context: vscode.ExtensionContext): DatabasesPanel {
    if (DatabasesPanel.current) {
      DatabasesPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return DatabasesPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      DatabasesPanel.viewType,
      "Bases de datos",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );

    DatabasesPanel.current = new DatabasesPanel(panel, context);
    return DatabasesPanel.current;
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this.panel = panel;
    this.context = context;

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (message: { type?: string; action?: unknown }) => {
        if (message?.type === "ready") {
          void this.init();
          return;
        }
        if (message?.type === "action") {
          const action = parseAction(message.action);
          if (action) {
            this.enqueue(action);
          }
        }
      },
      null,
      this.disposables
    );
  }

  private enqueue(action: DbAction): void {
    if (action.type === "cancel") {
      this.backupCancelled = true;
      if (this.session) {
        void this.session.cancel().catch(() => undefined);
      }
      this.postState({ ...this.state, busy: undefined, notice: "Operación cancelada." });
      return;
    }

    this.actionQueue = this.actionQueue
      .then(async () => {
        await this.handleAction(action);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.postState({ ...this.state, busy: undefined, error: msg });
      });
  }

  private async init(): Promise<void> {
    const profiles = this.getStoredProfiles();
    const views = await this.buildProfileViews(profiles);
    const savedProfileId = this.context.workspaceState.get<string>(KEY_ACTIVE_PROFILE);
    const backupDir = this.context.workspaceState.get<string>(KEY_BACKUP_DIR);

    this.state = {
      ...this.state,
      profiles: views,
      activeProfileId: savedProfileId && profiles.some((p) => p.id === savedProfileId) ? savedProfileId : profiles[0]?.id,
      backupDir,
    };
    this.postState(this.state);
  }

  private getHostKeyStore(): HostKeyStore {
    return {
      get: (server: string) => {
        const map = this.context.globalState.get<Record<string, string>>(KEY_HOST_KEYS, {});
        return map[server];
      },
      remember: (server: string, fingerprint: string) => {
        const map = { ...this.context.globalState.get<Record<string, string>>(KEY_HOST_KEYS, {}) };
        map[server] = fingerprint;
        void this.context.globalState.update(KEY_HOST_KEYS, map);
      },
    };
  }

  private getStoredProfiles(): DbProfile[] {
    return this.context.globalState.get<DbProfile[]>(KEY_PROFILES, []);
  }

  private async saveStoredProfiles(profiles: DbProfile[]): Promise<void> {
    await this.context.globalState.update(KEY_PROFILES, profiles);
  }

  private async buildProfileViews(profiles: DbProfile[]): Promise<DbProfileView[]> {
    const views: DbProfileView[] = [];
    for (const p of profiles) {
      const pw = await this.context.secrets.get(`opencodeAgents.db.pw.${p.id}`);
      const sshPw = await this.context.secrets.get(`opencodeAgents.db.sshPw.${p.id}`);
      const sshPass = await this.context.secrets.get(`opencodeAgents.db.sshPass.${p.id}`);
      views.push({
        ...p,
        hasPassword: Boolean(pw),
        hasSshPassword: Boolean(sshPw),
        hasSshPassphrase: Boolean(sshPass),
      });
    }
    return views;
  }

  private async handleAction(action: DbAction): Promise<void> {
    this.state = { ...this.state, error: undefined, notice: undefined };
    this.postState(this.state);

    switch (action.type) {
      case "saveProfile": {
        let profiles = this.getStoredProfiles();
        const existingIdx = profiles.findIndex((p) => p.id === action.profile.id);
        if (existingIdx >= 0) {
          profiles[existingIdx] = action.profile;
        } else {
          profiles.push(action.profile);
        }
        await this.saveStoredProfiles(profiles);

        const id = action.profile.id;
        if (action.password !== undefined) {
          if (action.password) {
            await this.context.secrets.store(`opencodeAgents.db.pw.${id}`, action.password);
          } else {
            await this.context.secrets.delete(`opencodeAgents.db.pw.${id}`);
          }
        }
        if (action.sshPassword !== undefined) {
          if (action.sshPassword) {
            await this.context.secrets.store(`opencodeAgents.db.sshPw.${id}`, action.sshPassword);
          } else {
            await this.context.secrets.delete(`opencodeAgents.db.sshPw.${id}`);
          }
        }
        if (action.sshPassphrase !== undefined) {
          if (action.sshPassphrase) {
            await this.context.secrets.store(`opencodeAgents.db.sshPass.${id}`, action.sshPassphrase);
          } else {
            await this.context.secrets.delete(`opencodeAgents.db.sshPass.${id}`);
          }
        }

        const views = await this.buildProfileViews(profiles);
        this.state = {
          ...this.state,
          profiles: views,
          activeProfileId: action.profile.id,
          notice: `Perfil "${action.profile.name}" guardado.`,
        };
        this.postState(this.state);
        break;
      }

      case "deleteProfile": {
        let profiles = this.getStoredProfiles();
        profiles = profiles.filter((p) => p.id !== action.id);
        await this.saveStoredProfiles(profiles);

        await this.context.secrets.delete(`opencodeAgents.db.pw.${action.id}`);
        await this.context.secrets.delete(`opencodeAgents.db.sshPw.${action.id}`);
        await this.context.secrets.delete(`opencodeAgents.db.sshPass.${action.id}`);

        if (this.state.activeProfileId === action.id && this.state.connected) {
          await this.disconnectInternal();
          this.state = {
            ...this.state,
            connected: false,
            serverInfo: undefined,
            databases: [],
            currentDb: undefined,
            tables: [],
            currentTable: undefined,
            columns: [],
            indexes: [],
            foreignKeys: [],
            data: undefined,
            console: undefined,
          };
        }

        const views = await this.buildProfileViews(profiles);
        const nextActiveId = profiles[0]?.id;
        await this.context.workspaceState.update(KEY_ACTIVE_PROFILE, nextActiveId);

        this.state = {
          ...this.state,
          profiles: views,
          activeProfileId: nextActiveId,
          notice: "Perfil eliminado.",
        };
        this.postState(this.state);
        break;
      }

      case "connect": {
        await this.connectInternal(action.id, action.password, action.sshPassword, action.sshPassphrase);
        break;
      }

      case "disconnect": {
        await this.disconnectInternal();
        this.state = {
          ...this.state,
          connected: false,
          serverInfo: undefined,
          databases: [],
          currentDb: undefined,
          tables: [],
          currentTable: undefined,
          columns: [],
          indexes: [],
          foreignKeys: [],
          data: undefined,
          console: undefined,
          notice: "Desconectado del servidor.",
        };
        this.postState(this.state);
        break;
      }

      case "refreshDatabases": {
        if (!this.session) {
          throw new Error("No hay conexión activa con la base de datos.");
        }
        this.postState({ ...this.state, busy: "Actualizando bases de datos..." });
        const dbs = await listDatabases(this.session);
        this.state = { ...this.state, databases: dbs, busy: undefined };
        this.postState(this.state);
        break;
      }

      case "selectDatabase": {
        await this.selectDatabaseInternal(action.database);
        break;
      }

      case "refreshTables": {
        if (!this.session || !this.state.currentDb) {
          throw new Error("No hay base de datos seleccionada.");
        }
        this.postState({ ...this.state, busy: "Actualizando tablas..." });
        const tables = await listTables(this.session, this.state.currentDb);
        this.state = { ...this.state, tables, busy: undefined };
        this.postState(this.state);
        break;
      }

      case "selectTable": {
        await this.selectTableInternal(action.table);
        break;
      }

      case "loadData": {
        if (!this.session || !this.state.currentDb || !this.state.currentTable) {
          throw new Error("No hay tabla seleccionada para cargar datos.");
        }
        const page = action.page ?? this.state.data?.page ?? 0;
        const search = action.search !== undefined ? action.search : this.state.data?.search ?? "";
        const orderBy = action.orderBy ?? this.state.data?.orderBy;
        const pageSize = action.pageSize ?? this.state.data?.pageSize ?? DEFAULT_PAGE_SIZE;

        await this.context.workspaceState.update(KEY_SEARCH, search);
        await this.context.workspaceState.update(KEY_PAGE_SIZE, pageSize);

        await this.loadDataInternal(page, search, orderBy, pageSize);
        break;
      }

      case "refreshStructure": {
        if (!this.session || !this.state.currentDb || !this.state.currentTable) {
          throw new Error("No hay tabla seleccionada.");
        }
        this.postState({ ...this.state, busy: "Actualizando estructura..." });
        const db = this.state.currentDb;
        const table = this.state.currentTable;
        const columns = await listColumns(this.session, db, table);
        const indexes = await listIndexes(this.session, db, table);
        const foreignKeys = await listForeignKeys(this.session, db, table);
        this.state = { ...this.state, columns, indexes, foreignKeys, busy: undefined };
        this.postState(this.state);
        break;
      }

      case "createDatabase": {
        if (!this.session) {
          throw new Error("No hay conexión activa.");
        }
        this.postState({ ...this.state, busy: `Creando base de datos ${action.name}...` });
        await createDatabase(this.session, action.name);
        const dbs = await listDatabases(this.session);
        this.state = { ...this.state, databases: dbs, busy: undefined, notice: `Base de datos "${action.name}" creada.` };
        await this.selectDatabaseInternal(action.name);
        break;
      }

      case "dropDatabase": {
        if (!this.session) {
          throw new Error("No hay conexión activa.");
        }
        if (action.confirm !== action.name) {
          throw new Error("El nombre de confirmación no coincide.");
        }
        this.postState({ ...this.state, busy: `Eliminando base de datos ${action.name}...` });
        await dropDatabase(this.session, action.name);
        const dbs = await listDatabases(this.session);
        const nextDb = this.state.currentDb === action.name ? undefined : this.state.currentDb;
        await this.context.workspaceState.update(KEY_ACTIVE_DB, nextDb);
        this.state = {
          ...this.state,
          databases: dbs,
          currentDb: nextDb,
          tables: nextDb ? this.state.tables : [],
          currentTable: nextDb ? this.state.currentTable : undefined,
          columns: nextDb ? this.state.columns : [],
          indexes: nextDb ? this.state.indexes : [],
          foreignKeys: nextDb ? this.state.foreignKeys : [],
          data: nextDb ? this.state.data : undefined,
          busy: undefined,
          notice: `Base de datos "${action.name}" eliminada.`,
        };
        this.postState(this.state);
        break;
      }

      case "createTable": {
        if (!this.session || !this.state.currentDb) {
          throw new Error("No hay base de datos seleccionada.");
        }
        this.postState({ ...this.state, busy: `Creando tabla ${action.spec.name}...` });
        await createTable(this.session, this.state.currentDb, action.spec);
        const tables = await listTables(this.session, this.state.currentDb);
        this.state = { ...this.state, tables, busy: undefined, notice: `Tabla "${action.spec.name}" creada.` };
        await this.selectTableInternal(action.spec.name);
        break;
      }

      case "alterTable": {
        if (!this.session || !this.state.currentDb || !this.state.currentTable) {
          throw new Error("No hay tabla seleccionada.");
        }
        const table = this.state.currentTable;
        if (action.table !== table) {
          throw new Error("La tabla cambió: vuelve a abrir la estructura.");
        }
        if (this.state.tables.find((t) => t.name === table)?.isView) {
          throw new Error("Una vista no tiene estructura editable.");
        }
        if (action.confirm !== "GUARDAR") {
          throw new Error("La confirmación no coincide.");
        }
        const vivas = await listColumns(this.session, this.state.currentDb, table);
        const vivasSet = new Set(vivas.map((c) => c.name.toLowerCase()));
        const originalSet = new Set(action.original.map((n) => n.toLowerCase()));
        if (vivasSet.size !== originalSet.size || [...originalSet].some((n) => !vivasSet.has(n))) {
          throw new Error(
            "La estructura de la tabla cambió desde que la abriste: recarga y vuelve a intentarlo."
          );
        }
        this.postState({ ...this.state, busy: `Actualizando estructura de ${table}...` });
        await alterTable(this.session, this.state.currentDb, table, action.columns);
        this.state = { ...this.state, busy: undefined, notice: `Estructura de ${table} actualizada.` };
        await this.selectTableInternal(table);
        break;
      }

      case "dropTable": {
        if (!this.session || !this.state.currentDb) {
          throw new Error("No hay base de datos seleccionada.");
        }
        if (action.confirm !== action.table) {
          throw new Error("El nombre de confirmación no coincide.");
        }
        this.postState({ ...this.state, busy: `Eliminando tabla ${action.table}...` });
        await dropTable(this.session, this.state.currentDb, action.table);
        const tables = await listTables(this.session, this.state.currentDb);
        const nextTable = this.state.currentTable === action.table ? undefined : this.state.currentTable;
        await this.context.workspaceState.update(KEY_ACTIVE_TABLE, nextTable);
        this.state = {
          ...this.state,
          tables,
          currentTable: nextTable,
          columns: nextTable ? this.state.columns : [],
          indexes: nextTable ? this.state.indexes : [],
          foreignKeys: nextTable ? this.state.foreignKeys : [],
          data: nextTable ? this.state.data : undefined,
          busy: undefined,
          notice: `Tabla "${action.table}" eliminada.`,
        };
        this.postState(this.state);
        break;
      }

      case "truncateTable": {
        if (!this.session || !this.state.currentDb) {
          throw new Error("No hay base de datos seleccionada.");
        }
        if (action.confirm !== action.table) {
          throw new Error("El nombre de confirmación no coincide.");
        }
        this.postState({ ...this.state, busy: `Vaciando tabla ${action.table}...` });
        await truncateTable(this.session, this.state.currentDb, action.table);
        const tables = await listTables(this.session, this.state.currentDb);
        this.state = { ...this.state, tables, busy: undefined, notice: `Tabla "${action.table}" vaciada.` };
        if (this.state.currentTable === action.table) {
          await this.loadDataInternal(0, this.state.data?.search ?? "", this.state.data?.orderBy, this.state.data?.pageSize ?? DEFAULT_PAGE_SIZE);
        } else {
          this.postState(this.state);
        }
        break;
      }

      case "renameTable": {
        if (!this.session || !this.state.currentDb) {
          throw new Error("No hay base de datos seleccionada.");
        }
        this.postState({ ...this.state, busy: `Renombrando tabla a ${action.to}...` });
        await renameTable(this.session, this.state.currentDb, action.from, action.to);
        const tables = await listTables(this.session, this.state.currentDb);
        this.state = { ...this.state, tables, busy: undefined, notice: `Tabla renombrada a "${action.to}".` };
        if (this.state.currentTable === action.from) {
          await this.selectTableInternal(action.to);
        } else {
          this.postState(this.state);
        }
        break;
      }

      case "insertRow": {
        if (!this.session || !this.state.currentDb || !this.state.currentTable) {
          throw new Error("No hay tabla seleccionada.");
        }
        this.postState({ ...this.state, busy: "Insertando fila..." });
        const res = await insertRow(
          this.session,
          this.state.currentDb,
          this.state.currentTable,
          this.state.columns,
          action.values
        );
        const noticeMsg = res.insertId ? `Fila insertada con ID ${res.insertId}.` : "Fila insertada con éxito.";
        await this.loadDataInternal(
          this.state.data?.page ?? 0,
          this.state.data?.search ?? "",
          this.state.data?.orderBy,
          this.state.data?.pageSize ?? DEFAULT_PAGE_SIZE
        );
        this.postState({ ...this.state, busy: undefined, notice: noticeMsg });
        break;
      }

      case "updateCell": {
        if (!this.session || !this.state.currentDb || !this.state.currentTable) {
          throw new Error("No hay tabla seleccionada.");
        }
        if (!action.identity) {
          throw new Error("La tabla no tiene clave primaria ni índice único: no se puede editar con seguridad.");
        }
        const identityColumns = this.checkedIdentity(action.identity.columns);
        if (identityColumns.length === 0) {
          throw new Error("La tabla no tiene clave primaria ni índice único: no se puede editar con seguridad.");
        }
        const identity: RowIdentity = { columns: identityColumns, values: action.identity.values };
        const col = this.state.columns.find((c) => c.name === action.column);
        if (!col) {
          throw new Error(`Columna "${action.column}" no encontrada.`);
        }
        this.postState({ ...this.state, busy: "Actualizando celda..." });
        await updateRowCell(
          this.session,
          this.state.currentDb,
          this.state.currentTable,
          identity,
          col,
          action.value
        );
        await this.loadDataInternal(
          this.state.data?.page ?? 0,
          this.state.data?.search ?? "",
          this.state.data?.orderBy,
          this.state.data?.pageSize ?? DEFAULT_PAGE_SIZE
        );
        this.postState({ ...this.state, busy: undefined, notice: "Celda actualizada." });
        break;
      }

      case "deleteRows": {
        if (!this.session || !this.state.currentDb || !this.state.currentTable) {
          throw new Error("No hay tabla seleccionada.");
        }
        if (!action.identity) {
          throw new Error("La tabla no tiene clave primaria ni índice único: no se puede editar con seguridad.");
        }
        const identityColumns = this.checkedIdentity(action.identity.columns);
        if (identityColumns.length === 0) {
          throw new Error("La tabla no tiene clave primaria ni índice único: no se puede editar con seguridad.");
        }
        const pageSize = this.state.data?.pageSize ?? 500;
        if (action.identity.rows.length === 0) {
          throw new Error("No hay filas seleccionadas para eliminar.");
        }
        if (action.identity.rows.length > pageSize) {
          throw new Error(`No se pueden eliminar más de ${pageSize} filas de una vez: recarga los datos.`);
        }
        const rows: DbCell[][] = action.identity.rows.map((row) => {
          if (!Array.isArray(row) || row.length !== identityColumns.length) {
            throw new Error("El número de valores de una fila no coincide con el de las columnas de la identidad.");
          }
          return row;
        });
        const identity = { columns: identityColumns, rows };
        this.postState({ ...this.state, busy: `Eliminando ${identity.rows.length} filas...` });
        const result = await deleteRows(
          this.session,
          this.state.currentDb,
          this.state.currentTable,
          identity
        );
        await this.loadDataInternal(
          this.state.data?.page ?? 0,
          this.state.data?.search ?? "",
          this.state.data?.orderBy,
          this.state.data?.pageSize ?? DEFAULT_PAGE_SIZE
        );
        this.postState({
          ...this.state,
          busy: undefined,
          notice: result.error
            ? `Se eliminaron ${result.deleted} fila(s) y falló el resto: ${result.error}`
            : `Se eliminaron ${result.deleted} fila(s).`,
        });
        break;
      }

      case "runSql": {
        if (!this.session) {
          throw new Error("No hay conexión activa.");
        }
        const stmts = statementsOf(action.sql);
        const hasWrites = stmts.some((s) => !s.readOnly);
        if (hasWrites && action.confirm !== "EJECUTAR") {
          this.postState({
            ...this.state,
            notice: "Se detectaron sentencias que modifican datos o esquema. Escribe EJECUTAR para confirmar.",
          });
          return;
        }

        this.postState({ ...this.state, busy: "Ejecutando SQL..." });
        const run = await runConsole(this.session, action.sql);
        this.state = {
          ...this.state,
          console: {
            results: run.results,
            error: run.error,
            sql: action.sql,
          },
          busy: undefined,
        };
        this.postState(this.state);
        break;
      }

      case "exportTable": {
        if (!this.session || !this.state.currentDb || !this.state.currentTable) {
          throw new Error("No hay tabla seleccionada para exportar.");
        }
        const db = this.state.currentDb;
        const table = this.state.currentTable;
        const format = action.format;
        const ext = format === "sql" ? "sql" : format === "json" ? "json" : "csv";

        const filterMap: Record<string, string[]> = {
          csv: ["csv"],
          json: ["json"],
          sql: ["sql"],
        };

        const defaultDir = this.state.backupDir || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const defaultUri = defaultDir
          ? vscode.Uri.file(path.join(defaultDir, `${db}.${table}.${ext}`))
          : undefined;

        const fileUri = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { [format.toUpperCase()]: filterMap[format] },
          saveLabel: "Exportar",
          title: `Exportar tabla ${table} (${format.toUpperCase()})`,
        });

        if (!fileUri) {
          return;
        }

        const outDir = path.dirname(fileUri.fsPath);
        await this.context.workspaceState.update(KEY_BACKUP_DIR, outDir);
        this.state.backupDir = outDir;

        this.postState({ ...this.state, busy: `Exportando ${table} a ${format.toUpperCase()}...` });
        const res = await exportTable(
          this.session,
          db,
          table,
          this.state.columns,
          format,
          fileUri.fsPath,
          (rows) => {
            this.postState({
              ...this.state,
              busy: `Exportando ${table} (${rows} filas)...`,
            });
          }
        );

        this.state = {
          ...this.state,
          busy: undefined,
          notice: `Tabla exportada: ${res.rows} filas (${(res.bytes / 1024).toFixed(1)} KB) en ${path.basename(fileUri.fsPath)}.`,
        };
        this.postState(this.state);
        break;
      }

      case "backupDatabase": {
        if (!this.session || !this.state.currentDb) {
          throw new Error("No hay base de datos seleccionada para volcar.");
        }
        const db = this.state.currentDb;
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, "0");
        const d = String(now.getDate()).padStart(2, "0");
        const hh = String(now.getHours()).padStart(2, "0");
        const mm = String(now.getMinutes()).padStart(2, "0");
        const ss = String(now.getSeconds()).padStart(2, "0");
        const stamp = `${y}${m}${d}-${hh}${mm}${ss}`;
        const defaultFile = `${db}-${stamp}.sql`;

        const defaultDir = this.state.backupDir || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const defaultUri = defaultDir
          ? vscode.Uri.file(path.join(defaultDir, defaultFile))
          : undefined;

        const fileUri = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { "Copia SQL (*.sql)": ["sql"] },
          saveLabel: "Guardar copia de seguridad",
          title: `Copia de seguridad de ${db}`,
        });

        if (!fileUri) {
          return;
        }

        const outDir = path.dirname(fileUri.fsPath);
        await this.context.workspaceState.update(KEY_BACKUP_DIR, outDir);
        this.state.backupDir = outDir;

        const profile = this.getStoredProfiles().find((p) => p.id === this.state.activeProfileId);
        let native: DumpConnection | undefined;
        if (profile && this.activePassword !== undefined) {
          if (this.tunnel) {
            native = {
              host: "127.0.0.1",
              port: this.tunnel.localPort,
              user: profile.user,
              password: this.activePassword,
              ssl: profile.ssl !== "off",
            };
          } else {
            native = {
              host: profile.host,
              port: profile.port,
              user: profile.user,
              password: this.activePassword,
              ssl: profile.ssl !== "off",
            };
          }
        }

        this.backupCancelled = false;
        const dumpOpts: DumpOptions = {
          db,
          filePath: fileUri.fsPath,
          onProgress: (info) => {
            this.postState({
              ...this.state,
              busy: `Volcando ${info.table} · ${info.rows} filas · ${(info.bytes / (1024 * 1024)).toFixed(1)} MB`,
            });
          },
          isCancelled: () => this.backupCancelled,
          toolPath: vscode.workspace.getConfiguration("opencodeAgents").get<string>("mariadbDumpPath"),
        };

        this.postState({ ...this.state, busy: `Iniciando volcado de ${db}...` });
        const res = await dumpDatabase(this.session, dumpOpts, native);

        this.state = {
          ...this.state,
          busy: undefined,
          notice: `Copia de seguridad completada (${res.tool}, ${res.tables} tablas, ${(res.bytes / (1024 * 1024)).toFixed(2)} MB).`,
        };
        this.postState(this.state);
        break;
      }

      case "openBackupFolder": {
        if (this.state.backupDir) {
          void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(this.state.backupDir));
        }
        break;
      }

      case "countTable": {
        if (!this.session || !this.state.currentDb || !this.state.currentTable) {
          throw new Error("No hay tabla seleccionada.");
        }
        this.postState({ ...this.state, busy: "Contando filas reales..." });
        const count = await tableCount(this.session, this.state.currentDb, this.state.currentTable);
        this.state = {
          ...this.state,
          busy: undefined,
          notice: `Total de filas en ${this.state.currentTable}: ${count.toLocaleString("es-ES")}`,
        };
        this.postState(this.state);
        break;
      }
    }
  }

  /**
   * Identidad de la fila según el último `loadData`, no la que pide el webview: así una
   * clave ajena o una columna inventada no se cuela en el WHERE.
   */
  private checkedIdentity(columns: string[]): string[] {
    const real = this.state.data?.identity ?? [];
    const same =
      real.length === columns.length && real.every((name, i) => name.toLowerCase() === columns[i].toLowerCase());
    if (!same) {
      throw new Error("La identidad de la fila no coincide con la clave de la tabla: recarga los datos.");
    }
    return [...real];
  }

  private async connectInternal(
    profileId: string,
    actionPw?: string,
    actionSshPw?: string,
    actionSshPass?: string
  ): Promise<void> {
    await this.disconnectInternal();

    const profiles = this.getStoredProfiles();
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) {
      throw new Error(`Perfil con ID "${profileId}" no encontrado.`);
    }

    this.postState({ ...this.state, busy: `Conectando a "${profile.name}"...`, error: undefined });

    const pw = actionPw ?? (await this.context.secrets.get(`opencodeAgents.db.pw.${profile.id}`)) ?? undefined;
    this.activePassword = pw;

    let tunnel: SshTunnel | undefined;
    if (profile.tunnel.enabled) {
      const sshPw =
        actionSshPw ?? (await this.context.secrets.get(`opencodeAgents.db.sshPw.${profile.id}`)) ?? undefined;
      const sshPass =
        actionSshPass ?? (await this.context.secrets.get(`opencodeAgents.db.sshPass.${profile.id}`)) ?? undefined;
      const hostKeys = this.getHostKeyStore();

      try {
        tunnel = await SshTunnel.open(profile, { password: sshPw, passphrase: sshPass }, hostKeys);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.state = {
          ...this.state,
          connected: false,
          busy: undefined,
          error: `Error al abrir túnel SSH: ${msg}`,
        };
        this.postState(this.state);
        return;
      }
    }

    let session: DbSession;
    try {
      session = await DbSession.open(profile, pw, tunnel);
    } catch (err) {
      if (tunnel) {
        await tunnel.close().catch(() => undefined);
      }
      let msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("auth_gssapi_client")) {
        msg += "\nConsejo: MariaDB intentó autenticación GSSAPI no soportada por el cliente. Usa una cuenta con mysql_native_password o ed25519.";
      }
      this.state = {
        ...this.state,
        connected: false,
        busy: undefined,
        error: `Error al conectar a MariaDB: ${msg}`,
      };
      this.postState(this.state);
      return;
    }

    this.session = session;
    this.tunnel = tunnel;

    let serverInfo: string | undefined;
    try {
      const verRes = await session.query("SELECT VERSION() AS ver", [], { timeoutMs: 5000 });
      serverInfo = typeof verRes.rows[0]?.[0] === "string" ? verRes.rows[0][0] : undefined;
    } catch {
      serverInfo = undefined;
    }

    await this.context.workspaceState.update(KEY_ACTIVE_PROFILE, profile.id);

    let dbs: { name: string; tables: number }[] = [];
    try {
      dbs = await listDatabases(session);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.state = {
        ...this.state,
        connected: true,
        serverInfo,
        activeProfileId: profile.id,
        busy: undefined,
        error: `Conectado pero no se pudieron listar las bases: ${msg}`,
      };
      this.postState(this.state);
      return;
    }

    this.state = {
      ...this.state,
      connected: true,
      serverInfo,
      activeProfileId: profile.id,
      databases: dbs,
      busy: undefined,
      error: undefined,
      notice: `Conectado a ${profile.name} (${serverInfo ?? "MariaDB"}).`,
    };

    const rememberedDb = this.context.workspaceState.get<string>(KEY_ACTIVE_DB) || profile.database;
    if (rememberedDb && dbs.some((d) => d.name.toLowerCase() === rememberedDb.toLowerCase())) {
      const actualDb = dbs.find((d) => d.name.toLowerCase() === rememberedDb.toLowerCase())!.name;
      await this.selectDatabaseInternal(actualDb);
    } else {
      this.postState(this.state);
    }
  }

  private async disconnectInternal(): Promise<void> {
    if (this.session) {
      await this.session.close().catch(() => undefined);
      this.session = undefined;
    }
    if (this.tunnel) {
      await this.tunnel.close().catch(() => undefined);
      this.tunnel = undefined;
    }
    this.activePassword = undefined;
  }

  private async selectDatabaseInternal(db: string): Promise<void> {
    if (!this.session) {
      return;
    }
    await this.context.workspaceState.update(KEY_ACTIVE_DB, db);
    this.postState({ ...this.state, currentDb: db, busy: `Cargando tablas de ${db}...` });

    const tables = await listTables(this.session, db);
    this.state = {
      ...this.state,
      currentDb: db,
      tables,
      currentTable: undefined,
      columns: [],
      indexes: [],
      foreignKeys: [],
      data: undefined,
      busy: undefined,
    };

    const rememberedTable = this.context.workspaceState.get<string>(KEY_ACTIVE_TABLE);
    if (rememberedTable && tables.some((t) => t.name.toLowerCase() === rememberedTable.toLowerCase())) {
      const actualTable = tables.find((t) => t.name.toLowerCase() === rememberedTable.toLowerCase())!.name;
      await this.selectTableInternal(actualTable);
    } else {
      this.postState(this.state);
    }
  }

  private async selectTableInternal(table: string): Promise<void> {
    if (!this.session || !this.state.currentDb) {
      return;
    }
    await this.context.workspaceState.update(KEY_ACTIVE_TABLE, table);
    const db = this.state.currentDb;

    this.postState({ ...this.state, currentTable: table, busy: `Cargando datos de ${table}...` });

    const columns = await listColumns(this.session, db, table);
    const indexes = await listIndexes(this.session, db, table);
    const foreignKeys = await listForeignKeys(this.session, db, table);

    this.state = {
      ...this.state,
      currentTable: table,
      columns,
      indexes,
      foreignKeys,
    };

    const search = this.context.workspaceState.get<string>(KEY_SEARCH, "");
    const pageSize = this.context.workspaceState.get<number>(KEY_PAGE_SIZE, DEFAULT_PAGE_SIZE);

    await this.loadDataInternal(0, search, undefined, pageSize);
  }

  private async loadDataInternal(
    page: number,
    search: string,
    orderBy?: { column: string; dir: "asc" | "desc" },
    pageSize: number = DEFAULT_PAGE_SIZE
  ): Promise<void> {
    if (!this.session || !this.state.currentDb || !this.state.currentTable) {
      return;
    }
    const db = this.state.currentDb;
    const table = this.state.currentTable;
    const cols = this.state.columns;

    const where = searchWhere(cols, search);
    const whereSql = where ? ` WHERE ${where.sql}` : "";
    const orderSql = orderByClause(cols, orderBy);
    const offset = page * pageSize;

    const sql = `SELECT * FROM ${qualified(db, table)}${whereSql}${orderSql} LIMIT ? OFFSET ?`;
    const params = [...(where?.params ?? []), pageSize, offset];

    const started = Date.now();
    const res = await this.session.query(sql, params, { timeoutMs: 30000 });
    const ms = Date.now() - started;

    const pks = await primaryKeyColumns(this.session, db, table);

    this.state = {
      ...this.state,
      data: {
        columns: res.columns,
        rows: res.rows,
        page,
        pageSize,
        truncated: res.truncated,
        ms,
        orderBy,
        search,
        identity: pks,
      },
      busy: undefined,
    };
    this.postState(this.state);
  }

  private postState(state: DbUiState): void {
    if (this.disposed) {
      return;
    }
    void this.panel.webview.postMessage({ type: "state", state });
  }

  private getHtml(webview: vscode.Webview): string {
    try {
      const nonce = getNonce();
      const uriIn = (file: string): string =>
        webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", file)).toString();
      const template = readFileSync(
        path.join(this.context.extensionUri.fsPath, "media", "databases.html"),
        "utf8"
      );
      return template
        .replaceAll("%%CSP%%", webview.cspSource)
        .replaceAll("%%NONCE%%", nonce)
        .replaceAll("%%TOKENS%%", uriIn("tokens.css"))
        .replaceAll("%%STYLE%%", uriIn("databases.css"))
        .replaceAll("%%SCRIPT%%", uriIn("databases.js"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Bases de datos: no se pudo cargar la interfaz (${message}).`);
      return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8" /><title>Bases de datos</title></head><body><p>No se pudo cargar <code>media/databases.html</code>.</p></body></html>`;
    }
  }

  private dispose(): void {
    this.disposed = true;
    this.backupCancelled = true;
    DatabasesPanel.current = undefined;
    void this.disconnectInternal();
    while (this.disposables.length > 0) {
      const item = this.disposables.pop();
      if (item) {
        item.dispose();
      }
    }
  }
}
