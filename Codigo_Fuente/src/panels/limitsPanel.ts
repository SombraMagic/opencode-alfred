import type * as vscode from "vscode";
import type { ProviderLimits } from "../limits/limits";

/** Mensajes que el webview tiene permitido pedir. */
interface LimitsMessage {
  type?: string;
  plan?: string;
  id?: string;
  collapsed?: boolean;
}

/** Clave del globalState donde viven las tarjetas plegadas. */
const COLLAPSED_KEY = "opencodeAgents.limitsCollapsed";

/**
 * Límites de consumo. Ya no tiene vista propia: pinta en la webview de
 * `VozPanel`, que le presta un `sink` mientras está lista.
 */
export class LimitsController {
  private sink?: (msg: unknown) => void;
  private providers: ProviderLimits[] = [];
  // Ids de proveedor con la tarjeta plegada (persisten en el globalState).
  private collapsed: string[] = [];
  // Antes del primer sondeo no se manda nada: la vista muestra «Leyendo límites…».
  private loaded = false;

  constructor(
    private readonly onReady: () => void,
    private readonly onRefresh: () => void,
    private readonly onSetGoPlan: (plan: "go" | "go-plus") => void,
    /** La webview vigente se ha cerrado: el host apaga aquí su temporizador de sondeo. */
    private readonly onDispose: () => void,
    private readonly state: vscode.Memento
  ) {}

  /** La webview está lista: se le manda lo último y el host arma su sondeo. */
  attach(sink: (msg: unknown) => void): void {
    this.sink = sink;
    // El estado guardado no es de fiar: solo valen las entradas de tipo string.
    const guardado = this.state.get<unknown[]>(COLLAPSED_KEY, []);
    this.collapsed = Array.isArray(guardado)
      ? guardado.filter((id): id is string => typeof id === "string")
      : [];
    this.post();
    this.onReady();
  }

  /** Solo la webview vigente apaga el sondeo: un dispose tardío de una vieja no mata el de la nueva. */
  detach(sink: (msg: unknown) => void): void {
    if (this.sink === sink) {
      this.sink = undefined;
      this.onDispose();
    }
  }

  /** Atiende los mensajes del webview. */
  handle(message: LimitsMessage | undefined): void {
    if (message?.type === "refresh") {
      this.onRefresh();
    }
    if (message?.type === "setGoPlan") {
      if (message.plan === "go" || message.plan === "go-plus") {
        this.onSetGoPlan(message.plan);
      }
    }
    if (message?.type === "collapse") {
      const id = message.id;
      if (typeof id === "string" && id) {
        // Sin repintar: el webview ya movió su tarjeta y su sondeo no debe deshacerlo.
        const resto = this.collapsed.filter((otro) => otro !== id);
        this.collapsed = message.collapsed ? [...resto, id] : resto;
        void this.state.update(COLLAPSED_KEY, this.collapsed);
      }
    }
  }

  update(providers: ProviderLimits[]): void {
    this.providers = Array.isArray(providers) ? providers : [];
    this.loaded = true;
    this.post();
  }

  private post(): void {
    if (!this.loaded || !this.sink) {
      return;
    }
    this.sink({ type: "limits", providers: this.providers, collapsed: this.collapsed });
  }
}
