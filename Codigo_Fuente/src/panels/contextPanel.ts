import { ContextWindowInfo } from "../stats/contextWindow";

/**
 * Estado de la ventana de contexto. Ya no tiene vista propia: pinta en la
 * webview de `VozPanel`, que le presta un `sink` mientras está lista.
 */
export class ContextController {
  private sink?: (msg: unknown) => void;
  private last?: ContextWindowInfo;

  constructor(
    private readonly onReady: () => void,
    private readonly onCompact: () => void
  ) {}

  /** La webview está lista: se le reenvía lo último y se pide una medida fresca. */
  attach(sink: (msg: unknown) => void): void {
    this.sink = sink;
    this.post();
    this.onReady();
  }

  /** Solo suelta si el sink sigue siendo el suyo (un dispose tardío no pisa al nuevo). */
  detach(sink: (msg: unknown) => void): void {
    if (this.sink === sink) {
      this.sink = undefined;
    }
  }

  /** Atiende los mensajes del webview. */
  handle(message: { type?: string } | undefined): void {
    if (message?.type === "compact") {
      this.onCompact();
    }
  }

  update(info: ContextWindowInfo): void {
    this.last = info;
    this.post();
  }

  /** Sesión que el panel está midiendo: es la que hay que compactar. */
  currentSessionId(): string | undefined {
    return this.last?.sessionId;
  }

  /** Agente de la sesión medida: lleva el retraso del sondeo, vale para comparar por nombre. */
  currentAgent(): string | undefined {
    return this.last?.agent;
  }

  private post(): void {
    if (this.sink && this.last) {
      this.sink({ type: "context", payload: this.last });
    }
  }
}
