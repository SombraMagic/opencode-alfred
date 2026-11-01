/**
 * Panel CHATBOT: pestaña central para probar los modelos de Ollama directamente, sin el
 * arnés de opencode. Solo vive con Mente local ENCENDIDA; si se apaga (o el servidor no
 * responde) el panel sigue abierto pero bloqueado y no manda nada al modelo.
 *
 * El marcado está en `media/chatbot.html` (lo escribe `interfaz`): aquí solo se rellenan los
 * huecos `%%CSP%% %%NONCE%% %%TOKENS%% %%STYLE%% %%SCRIPT%%` (mismos que el generador de
 * imágenes) y se atiende al webview, que no es de fiar. La clave de OpenAI nunca viaja a él.
 *
 * PROTOCOLO
 * webview → host
 *   {type:"ready"}
 *   {type:"send", text, attachments?:[{name,dataUrl}]}  máx 4, 10 MiB c/u, png/jpeg/webp/gif;
 *                                                        se guardan en <globalStorage>/chatbot/adjuntos
 *   {type:"stop"} | {type:"regenerate"} | {type:"newChat"}
 *   {type:"openChat",id} | {type:"deleteChat",id} | {type:"renameChat",id,title}
 *   {type:"setModel",model} | {type:"setParams",system,temperature,numCtx}
 *   {type:"setTool",name,on} | {type:"setAutoSpeak",on}
 *   {type:"speak",id} | {type:"copy",text} | {type:"export"} | {type:"openFile",file}
 *     (`file` = ruta o URI de una imagen de la conversación activa; otra cosa se ignora)
 * host → webview
 *   {type:"state", state:{locked, lockReason, models:[{name,sizeLabel}], model,
 *      capabilities:{tools,thinking,vision}, tools:[{name,label,on,available}],
 *      params:{system,temperature,numCtx}, autoSpeak, chats:[{id,title,updatedAt}], activeId}}
 *      (numCtx 0 = el de Ollama; activeId "" = ninguna)
 *   {type:"chat", chat:{id,title,model,messages:[{id,role,content,at,images:[uri],
 *      toolCalls?:[{name,args}],toolName?,metrics?}]}}   (metrics solo de esta sesión)
 *   {type:"event", messageId, event}  con event =
 *      {type:"delta",text} | {type:"thinking",text} | {type:"toolStart",name,args} |
 *      {type:"toolEnd",name,result:string,error?,imageUri?} |
 *      {type:"done",metrics:{evalCount,evalDurationMs,totalMs}} | {type:"error",message}
 *      `messageId` es el del mensaje assistant en curso (el de la ronda que pide la tool, en
 *      toolStart/toolEnd). Al acabar el turno llega un `chat` completo que lo sustituye todo.
 *      `toolEnd.result` es siempre un string (el host manda `event.result.text`); el adjunto
 *      de la tool viaja aparte como `imageUri`.
 *   {type:"busy", on}
 */
import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ConversationStore, newConversation } from "../chatbot/store";
import { modelCapabilities, runChat } from "../chatbot/ollamaChat";
import { ToolRegistry } from "../chatbot/toolsRegistry";
import { createImageTool } from "../chatbot/tools/imageTool";
import { toMarkdown } from "../chatbot/export";
import type { ChatEvent, ChatMessage, ChatMetrics, Conversation, ModelCapabilities } from "../chatbot/types";
import { generateWithSettings } from "../images/generateWith";
import { ollamaTags } from "../ollama/client";
import { readSettings as readMenteSettings } from "../ollama/service";
import { writeAtomic } from "../pizarra/files";
import { speak } from "../voice/service.js";
import { KEY_OPENAI, imagenesDir, readSettings as readImageSettings } from "./imageGenPanel";
import { setActivity } from "./activity";

const KEY_PREFS = "opencodeAgents.chatbot";
const MAX_TEXT = 100_000;
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_SYSTEM = 20_000;
const MAX_SPEAK = 5000;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,120}$/;
const IMAGE_TOOL = "generar_imagen";
/** Herramientas conocidas: nombre y rótulo para el toggle. */
const TOOL_DEFS = [{ name: IMAGE_TOOL, label: "Generar imagen" }];

interface Prefs {
  model: string;
  system: string;
  temperature: number;
  numCtx: number;
  autoSpeak: boolean;
  toolsOff: string[];
}

const DEFAULT_PREFS: Prefs = {
  model: "",
  system: "",
  temperature: 0.8,
  numCtx: 0,
  autoSpeak: false,
  toolsOff: [],
};

function clampNum(raw: unknown, min: number, max: number, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : fallback;
}

function sanitizeParams(raw: Record<string, unknown>): Pick<Prefs, "system" | "temperature" | "numCtx"> {
  const numCtx = clampNum(raw.numCtx, 0, 1_048_576, 0);
  return {
    system: typeof raw.system === "string" ? raw.system.slice(0, MAX_SYSTEM) : "",
    temperature: Math.round(clampNum(raw.temperature, 0, 2, DEFAULT_PREFS.temperature) * 100) / 100,
    // 0 = el contexto por defecto de Ollama; por debajo de 256 no tiene sentido.
    numCtx: numCtx === 0 ? 0 : Math.max(256, Math.round(numCtx)),
  };
}

function readPrefs(context: vscode.ExtensionContext): Prefs {
  const raw = context.globalState.get<Record<string, unknown>>(KEY_PREFS) ?? {};
  return {
    ...DEFAULT_PREFS,
    ...sanitizeParams(raw),
    model: typeof raw.model === "string" && MODEL_RE.test(raw.model) ? raw.model : "",
    autoSpeak: raw.autoSpeak === true,
    toolsOff: Array.isArray(raw.toolsOff)
      ? raw.toolsOff.filter((n): n is string => typeof n === "string" && TOOL_DEFS.some((t) => t.name === n))
      : [],
  };
}

type ChatbotAction =
  | { type: "send"; text: string; attachments: Array<{ name: string; dataUrl: string }> }
  | { type: "stop" | "regenerate" | "newChat" | "export" }
  | { type: "openChat" | "deleteChat"; id: string }
  | { type: "renameChat"; id: string; title: string }
  | { type: "setModel"; model: string }
  | { type: "setParams"; system: string; temperature: number; numCtx: number }
  | { type: "setTool"; name: string; on: boolean }
  | { type: "setAutoSpeak"; on: boolean }
  | { type: "speak"; id: string }
  | { type: "copy"; text: string }
  | { type: "openFile"; file: string };

/** El webview no es de fiar: solo pasan los mensajes del contrato, con su forma exacta. */
function parseAction(raw: unknown): ChatbotAction | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === "string" && ID_RE.test(m.id) ? m.id : "";
  switch (m.type) {
    case "send": {
      const text = typeof m.text === "string" ? m.text.slice(0, MAX_TEXT) : "";
      const attachments: Array<{ name: string; dataUrl: string }> = [];
      if (m.attachments !== undefined) {
        if (!Array.isArray(m.attachments) || m.attachments.length > MAX_ATTACHMENTS) return undefined;
        for (const a of m.attachments) {
          const item = a as { name?: unknown; dataUrl?: unknown } | undefined;
          // Base64 de 10 MiB ≈ 13,4 M caracteres: más allá ni se mira.
          if (typeof item?.dataUrl !== "string" || item.dataUrl.length > 14_500_000) return undefined;
          attachments.push({
            name: typeof item.name === "string" ? item.name.slice(0, 120) : "imagen",
            dataUrl: item.dataUrl,
          });
        }
      }
      return text.trim() || attachments.length ? { type: "send", text, attachments } : undefined;
    }
    case "stop":
    case "regenerate":
    case "newChat":
    case "export":
      return { type: m.type };
    case "openChat":
    case "deleteChat":
      return id ? { type: m.type, id } : undefined;
    case "renameChat": {
      const title = typeof m.title === "string" ? m.title.trim().slice(0, 60) : "";
      return id && title ? { type: "renameChat", id, title } : undefined;
    }
    case "setModel":
      return typeof m.model === "string" && MODEL_RE.test(m.model) ? { type: "setModel", model: m.model } : undefined;
    case "setParams":
      return { type: "setParams", ...sanitizeParams(m) };
    case "setTool":
      return typeof m.name === "string" && TOOL_DEFS.some((t) => t.name === m.name) && typeof m.on === "boolean"
        ? { type: "setTool", name: m.name, on: m.on }
        : undefined;
    case "setAutoSpeak":
      return typeof m.on === "boolean" ? { type: "setAutoSpeak", on: m.on } : undefined;
    case "speak":
      return id ? { type: "speak", id } : undefined;
    case "copy":
      return typeof m.text === "string" && m.text.length <= 1_000_000 ? { type: "copy", text: m.text } : undefined;
    case "openFile":
      return typeof m.file === "string" && m.file.length <= 1000 ? { type: "openFile", file: m.file } : undefined;
  }
  return undefined;
}

/** Extensión según los primeros bytes; `undefined` si no es png/jpeg/webp/gif. */
function imageExt(bytes: Buffer): string | undefined {
  if (bytes.length > 12) {
    if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
    if (bytes.subarray(0, 4).toString("latin1") === "GIF8") return "gif";
    if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
      return "webp";
    }
  }
  return undefined;
}

function sizeLabel(bytes: number): string {
  if (!(bytes > 0)) return "";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1).replace(".", ",")} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export class ChatbotPanel {
  public static current: ChatbotPanel | undefined;
  private static readonly viewType = "opencodeAgents.chatbot";

  private readonly panel: vscode.WebviewPanel;
  private readonly store: ConversationStore;
  private readonly chatDir: string;
  private readonly disposables: vscode.Disposable[] = [];
  private queue: Promise<void> = Promise.resolve();
  private conv?: Conversation;
  private caps: { model: string; value: ModelCapabilities } | undefined;
  private metrics = new Map<string, ChatMetrics>();
  private abort?: AbortController;
  /** Hay un turno en cola o en marcha: un segundo envío no encola otro. */
  private pendingRun = false;
  private locked = true;
  private disposed = false;

  static open(context: vscode.ExtensionContext): ChatbotPanel {
    if (ChatbotPanel.current) {
      ChatbotPanel.current.panel.reveal(vscode.ViewColumn.Active);
      void ChatbotPanel.current.refresh();
      return ChatbotPanel.current;
    }
    const chatDir = join(context.globalStorageUri.fsPath, "chatbot");
    const panel = vscode.window.createWebviewPanel(ChatbotPanel.viewType, "Chatbot", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "media"),
        vscode.Uri.file(imagenesDir(context)),
        vscode.Uri.file(chatDir),
      ],
    });
    const created = new ChatbotPanel(panel, context, chatDir);
    ChatbotPanel.current = created;
    return created;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    chatDir: string
  ) {
    this.panel = panel;
    this.chatDir = chatDir;
    this.store = new ConversationStore(chatDir);
    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.onDidDispose(() => this.release(), null, this.disposables);
    this.panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.visible) void this.refresh();
      },
      null,
      this.disposables
    );
    this.panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        if ((message as { type?: unknown } | undefined)?.type === "ready") {
          void this.sendAll();
          return;
        }
        const action = parseAction(message);
        if (!action) return;
        // Parar y lo instantáneo no esperan a que acabe el turno en curso.
        if (action.type === "stop") {
          this.abort?.abort();
          // La generación de imagen no es cancelable: se apaga la tarjeta al abortar.
          setActivity("imagen-chat", false, "GENERANDO IMAGEN", "imagen");
          return;
        }
        if (action.type === "speak" || action.type === "copy" || action.type === "openFile") {
          void this.guard(() => this.handle(action));
          return;
        }
        if (action.type === "send" || action.type === "regenerate") {
          if (this.pendingRun) return;
          this.pendingRun = true;
        }
        // Cambiar o borrar chat corta el turno en vuelo: si no, esperarían detrás de `runTurn`.
        // No hay carrera con la conversación equivocada: la cola es serial, así que el
        // `finally` de `runTurn` guarda su `conv` y solo después se ejecuta el cambio.
        if (action.type === "newChat" || action.type === "openChat" || action.type === "deleteChat") {
          this.abort?.abort();
          // La generación de imagen no es cancelable: se apaga la tarjeta al abortar.
          setActivity("imagen-chat", false, "GENERANDO IMAGEN", "imagen");
        }
        this.queue = this.queue.then(() => this.guard(() => this.handle(action)));
      },
      null,
      this.disposables
    );
  }

  /** Repinta el estado (y bloquea o desbloquea) tras un cambio de Mente local. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    const state = await this.buildState();
    if (this.locked) this.abort?.abort();
    this.post({ type: "state", state });
  }

  private async guard(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      void vscode.window.showErrorMessage(`Chatbot: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private post(message: unknown): void {
    if (!this.disposed) void this.panel.webview.postMessage(message);
  }

  private toUri(file: string): string {
    return this.panel.webview.asWebviewUri(vscode.Uri.file(file)).toString();
  }

  // ── Estado ────────────────────────────────────────────────────────────

  private async capabilities(baseURL: string, model: string): Promise<ModelCapabilities> {
    if (this.caps?.model === model) return this.caps.value;
    const value = await modelCapabilities(baseURL, model);
    this.caps = { model, value };
    return value;
  }

  /** Estado completo; deja `this.locked` al día. */
  private async buildState(): Promise<Record<string, unknown>> {
    const menteLocal = readMenteSettings(this.context);
    const prefs = readPrefs(this.context);
    let installed: Array<{ name: string; sizeLabel: string }> = [];
    let lockReason = "";
    // El chatbot habla directo con Ollama: vale con que el servidor responda, no hace falta
    // que el proveedor esté escrito en opencode.json (interruptor de Mente local).
    try {
      installed = (await ollamaTags(menteLocal.baseURL)).map((t) => ({ name: t.name, sizeLabel: sizeLabel(t.size) }));
      if (!installed.length) lockReason = "Ollama no tiene modelos instalados.";
    } catch {
      lockReason = "El servidor de Ollama no responde. Enciende Mente local o arranca Ollama.";
    }
    this.locked = !!lockReason;
    const names = installed.map((m) => m.name);
    const model = [prefs.model, menteLocal.model].find((n) => n && names.includes(n)) ?? names[0] ?? "";
    const capabilities =
      model && !this.locked
        ? await this.capabilities(menteLocal.baseURL, model)
        : { tools: false, thinking: false, vision: false };
    return {
      locked: this.locked,
      lockReason,
      models: installed,
      model,
      capabilities,
      tools: TOOL_DEFS.map((t) => ({
        name: t.name,
        label: t.label,
        on: !prefs.toolsOff.includes(t.name),
        available: capabilities.tools,
      })),
      params: { system: prefs.system, temperature: prefs.temperature, numCtx: prefs.numCtx },
      autoSpeak: prefs.autoSpeak,
      chats: (await this.store.list()).map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
      activeId: this.conv?.id ?? "",
    };
  }

  private webChat(conv: Conversation): unknown {
    return {
      id: conv.id,
      title: conv.title,
      model: conv.model,
      messages: conv.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          at: m.at,
          images: (m.images ?? []).map((f) => this.toUri(f)),
          toolCalls: m.toolCalls,
          toolName: m.toolName,
          metrics: this.metrics.get(m.id),
        })),
    };
  }

  private async sendState(): Promise<void> {
    this.post({ type: "state", state: await this.buildState() });
  }

  private async sendAll(): Promise<void> {
    if (!this.conv) {
      const last = (await this.store.list())[0];
      this.conv = (last && (await this.store.load(last.id))) || undefined;
    }
    const state = await this.buildState();
    this.conv ??= newConversation(String(state.model));
    this.post({ type: "state", state: { ...state, activeId: this.conv.id } });
    this.post({ type: "chat", chat: this.webChat(this.conv) });
  }

  // ── Acciones ──────────────────────────────────────────────────────────

  private async handle(action: ChatbotAction): Promise<void> {
    switch (action.type) {
      case "send":
      case "regenerate":
        try {
          await this.runTurn(action);
        } finally {
          this.pendingRun = false;
        }
        return;
      case "newChat": {
        const state = await this.buildState();
        this.conv = newConversation(String(state.model));
        this.post({ type: "chat", chat: this.webChat(this.conv) });
        this.post({ type: "state", state: { ...state, activeId: this.conv.id } });
        return;
      }
      case "openChat": {
        const conv = await this.store.load(action.id);
        if (!conv) return;
        this.conv = conv;
        this.post({ type: "chat", chat: this.webChat(conv) });
        await this.sendState();
        return;
      }
      case "deleteChat": {
        await this.store.remove(action.id);
        if (this.conv?.id === action.id) {
          const state = await this.buildState();
          this.conv = newConversation(String(state.model));
          this.post({ type: "chat", chat: this.webChat(this.conv) });
        }
        await this.sendState();
        return;
      }
      case "renameChat": {
        const conv = await this.store.load(action.id);
        if (!conv) return;
        conv.title = action.title;
        await this.store.save(conv);
        if (this.conv?.id === conv.id) this.conv.title = action.title;
        await this.sendState();
        return;
      }
      case "setModel":
        await this.savePrefs({ model: action.model });
        await this.sendState();
        return;
      case "setParams":
        await this.savePrefs({ system: action.system, temperature: action.temperature, numCtx: action.numCtx });
        await this.sendState();
        return;
      case "setTool": {
        const off = new Set(readPrefs(this.context).toolsOff);
        if (action.on) off.delete(action.name);
        else off.add(action.name);
        await this.savePrefs({ toolsOff: [...off] });
        await this.sendState();
        return;
      }
      case "setAutoSpeak":
        await this.savePrefs({ autoSpeak: action.on });
        await this.sendState();
        return;
      case "speak": {
        const message = this.conv?.messages.find((m) => m.id === action.id && m.role === "assistant");
        if (message) await this.speakText(message.content);
        return;
      }
      case "copy":
        await vscode.env.clipboard.writeText(action.text);
        return;
      case "export": {
        if (!this.conv?.messages.length) {
          void vscode.window.showInformationMessage("No hay nada que exportar: la conversación está vacía.");
          return;
        }
        const base = (this.conv.title || "conversacion").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "conversacion";
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.chatDir, `${base}.md`)),
          filters: { Markdown: ["md"] },
        });
        if (target) await writeFile(target.fsPath, toMarkdown(this.conv), "utf8");
        return;
      }
      case "openFile": {
        const known = (this.conv?.messages ?? []).flatMap((m) => m.images ?? []);
        const file = known.find((f) => f === action.file || this.toUri(f) === action.file);
        if (file) await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file));
        return;
      }
    }
  }

  private async savePrefs(patch: Partial<Prefs>): Promise<void> {
    await this.context.globalState.update(KEY_PREFS, { ...readPrefs(this.context), ...patch });
  }

  private async speakText(text: string): Promise<void> {
    const clean = text.trim().slice(0, MAX_SPEAK);
    if (!clean) return;
    try {
      // Motor y voz: los del panel de VOZ (engine vacío = el configurado).
      await speak(clean, "");
    } catch (err) {
      void vscode.window.showWarningMessage(`Chatbot: no se pudo leer en voz alta: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Guarda las imágenes adjuntas ya validadas; `undefined` si alguna no vale. */
  private async saveAttachments(list: Array<{ name: string; dataUrl: string }>): Promise<string[] | undefined> {
    const files: string[] = [];
    const dir = join(this.chatDir, "adjuntos");
    for (const item of list) {
      const match = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(item.dataUrl);
      const bytes = match ? Buffer.from(match[1], "base64") : undefined;
      const ext = bytes && bytes.length <= MAX_ATTACHMENT_BYTES ? imageExt(bytes) : undefined;
      if (!bytes || !ext) {
        void vscode.window.showWarningMessage(
          `Chatbot: «${item.name}» no es una imagen válida (png, jpeg, webp o gif de hasta 10 MiB).`
        );
        return undefined;
      }
      await mkdir(dir, { recursive: true });
      const file = join(dir, `img-${randomUUID()}.${ext}`);
      await writeAtomic(file, bytes);
      files.push(file);
    }
    return files;
  }

  /** Ajustes del generador de imágenes tal como los dejó su panel; la clave se queda aquí. */
  private async imageSettings(): Promise<Parameters<typeof generateWithSettings>[0]> {
    const s = readImageSettings(this.context);
    return {
      provider: s.provider,
      url: s.url,
      port: s.port,
      openaiUrl: s.openaiUrl,
      openaiKey: s.provider === "openai" ? (await this.context.secrets.get(KEY_OPENAI)) ?? undefined : undefined,
      prefs: s.prefs,
      imagenesDir: imagenesDir(this.context),
    };
  }

  private async runTurn(action: ChatbotAction): Promise<void> {
    const menteLocal = readMenteSettings(this.context);
    const state = await this.buildState();
    if (this.locked || !state.model) {
      await this.sendState();
      return;
    }
    const model = String(state.model);
    const conv = this.conv ?? newConversation(model);
    this.conv = conv;

    if (action.type === "send") {
      const images = await this.saveAttachments(action.attachments);
      if (!images) return;
      conv.messages.push({
        id: randomUUID(),
        role: "user",
        content: action.text.trim(),
        images: images.length ? images : undefined,
        at: Date.now(),
      });
    } else {
      // Regenerar: se descarta todo lo que siguió al último mensaje del usuario.
      let last = -1;
      conv.messages.forEach((m, i) => {
        if (m.role === "user") last = i;
      });
      if (last < 0) return;
      conv.messages.length = last + 1;
    }
    conv.model = model;
    this.conv = await this.store.save(conv);
    this.post({ type: "chat", chat: this.webChat(this.conv) });

    const prefs = readPrefs(this.context);
    const caps = await this.capabilities(menteLocal.baseURL, model);
    const registry = new ToolRegistry();
    if (caps.tools && !prefs.toolsOff.includes(IMAGE_TOOL)) {
      registry.register(
        createImageTool(async (prompt) => {
          setActivity("imagen-chat", true, "GENERANDO IMAGEN", "imagen");
          try {
            return await generateWithSettings(await this.imageSettings(), prompt);
          } finally {
            setActivity("imagen-chat", false, "GENERANDO IMAGEN", "imagen");
          }
        })
      );
    }

    const controller = new AbortController();
    this.abort = controller;
    this.post({ type: "busy", on: true });
    let currentId = randomUUID();
    let failed = false;
    try {
      const stream = runChat({
        baseURL: menteLocal.baseURL,
        options: {
          model,
          system: prefs.system || undefined,
          temperature: prefs.temperature,
          numCtx: prefs.numCtx || undefined,
        },
        messages: conv.messages,
        registry,
        signal: controller.signal,
        capabilities: caps,
        onMessage: (message: ChatMessage) => {
          // El mensaje assistant toma el id con el que ya se pintó en streaming.
          if (message.role === "assistant") message.id = currentId;
          conv.messages.push(message);
        },
      });
      for await (const event of stream) {
        this.post({ type: "event", messageId: currentId, event: this.webEvent(event) });
        if (event.type === "done") this.metrics.set(currentId, event.metrics);
        if (event.type === "error") failed = true;
        if (event.type === "toolEnd") currentId = randomUUID();
      }
    } finally {
      this.abort = undefined;
      this.pendingRun = false;
      setActivity("imagen-chat", false, "GENERANDO IMAGEN", "imagen");
      try {
        this.conv = await this.store.save(conv);
      } catch (err) {
        void vscode.window.showErrorMessage(`Chatbot: no se pudo guardar la conversación: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.post({ type: "chat", chat: this.webChat(this.conv ?? conv) });
      this.post({ type: "busy", on: false });
      await this.sendState();
    }
    if (!failed && prefs.autoSpeak) {
      const reply = [...conv.messages].reverse().find((m) => m.role === "assistant" && m.content.trim());
      if (reply) void this.speakText(reply.content);
    }
  }

  private webEvent(event: ChatEvent): unknown {
    if (event.type === "toolEnd") {
      return {
        type: "toolEnd",
        name: event.name,
        result: event.result.text,
        error: event.error,
        imageUri: event.result.attachment ? this.toUri(event.result.attachment.file) : undefined,
      };
    }
    return event;
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const media = (file: string): string =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", file)).toString();
    let template: string;
    try {
      template = readFileSync(join(this.context.extensionUri.fsPath, "media", "chatbot.html"), "utf8");
    } catch {
      return "<!DOCTYPE html><html lang=\"es\"><body>No se encontró media/chatbot.html.</body></html>";
    }
    return template
      .replaceAll("%%CSP%%", webview.cspSource)
      .replaceAll("%%NONCE%%", nonce)
      .replaceAll("%%TOKENS%%", media("tokens.css"))
      .replaceAll("%%STYLE%%", media("chatbot.css"))
      .replaceAll("%%SCRIPT%%", media("chatbot.js"));
  }

  private release(): void {
    this.disposed = true;
    this.abort?.abort();
    setActivity("imagen-chat", false, "GENERANDO IMAGEN", "imagen");
    if (ChatbotPanel.current === this) ChatbotPanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}
