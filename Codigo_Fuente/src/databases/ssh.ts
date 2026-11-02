/**
 * Túnel SSH local para alcanzar un MariaDB que no está a la vista. Escucha solo en
 * 127.0.0.1 con un puerto asignado por el sistema y reenvía, desde el servidor SSH, al
 * host:puerto del perfil. Sin `vscode`: lo usan el panel, `extension.ts` y el MCP.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as net from "node:net";
import { Client } from "ssh2";
import type { ClientChannel, ConnectConfig } from "ssh2";
import type { DbProfile } from "./types";

/** Secretos del túnel, que no viven en el perfil. */
export interface SshSecrets {
  password?: string;
  passphrase?: string;
}

/** Almacen de huellas de host. `server` es `host:puerto`. */
export interface HostKeyStore {
  get(server: string): string | undefined;
  /** Guarda la huella en forma `SHA256:<base64>`. */
  remember(server: string, fingerprint: string): void;
}

/** Tiempo de espera del handshake SSH. */
const READY_TIMEOUT_MS = 15000;
const SSH_PORT = 22;
const DB_PORT = 3306;

/** Clave del almacen de huellas: `host:puerto`. */
function serverKey(host: string, port: number): string {
  return `${host}:${port}`;
}

/** Acepta la huella guardada con o sin prefijo `SHA256:`. */
function normalizedFingerprint(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("SHA256:") ? trimmed : `SHA256:${trimmed}`;
}

/** Configura la autenticación según el metodo del perfil. */
async function buildAuthConfig(
  profile: DbProfile,
  secrets: SshSecrets
): Promise<Pick<ConnectConfig, "password" | "privateKey" | "passphrase" | "agent">> {
  const tunnel = profile.tunnel;
  if (tunnel.auth === "password") {
    if (!secrets.password) {
      throw new Error("Falta la contraseña del túnel SSH.");
    }
    return { password: secrets.password };
  }
  if (tunnel.auth === "key") {
    if (!tunnel.keyPath) {
      throw new Error("Falta la ruta de la clave privada del túnel SSH.");
    }
    try {
      const raw = await readFile(tunnel.keyPath);
      return secrets.passphrase ? { privateKey: raw, passphrase: secrets.passphrase } : { privateKey: raw };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`No se pudo leer la clave SSH (${tunnel.keyPath}): ${msg}`);
    }
  }
  const sock = process.env.SSH_AUTH_SOCK;
  if (!sock) {
    throw new Error("No hay agente SSH disponible (falta SSH_AUTH_SOCK).");
  }
  return { agent: sock };
}

/** Pone el servidor local a escuchar en 127.0.0.1 con puerto 0 y devuelve el asignado. */
function listenLocal(local: net.Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (e: Error): void => reject(new Error(`Fallo el puerto local del túnel SSH: ${e.message}`));
    local.once("error", onError);
    local.listen(0, "127.0.0.1", () => {
      local.removeListener("error", onError);
      const addr = local.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      if (port > 0) {
        resolve(port);
      } else {
        reject(new Error("El sistema no asignó un puerto local para el túnel SSH."));
      }
    });
  });
}

/** Túnel SSH con un puerto local listo para mysql2. */
export class SshTunnel {
  /** Puerto local (127.0.0.1) al que hay que conectar MariaDB. */
  readonly localPort: number;

  private readonly client: Client;
  private readonly server: net.Server;
  /** Sockets locales aceptados, para romperlos al cerrar. */
  private readonly sockets = new Set<net.Socket>();
  /** Canales SSH abiertos, para cerrarlos al cerrar. */
  private readonly channels = new Set<ClientChannel>();
  /** Motivo real cuando el host rechaza la huella: el error de ssh2 es generico. */
  private hostKeyError: Error | undefined;
  private closed = false;

  private constructor(localPort: number, client: Client, server: net.Server) {
    this.localPort = localPort;
    this.client = client;
    this.server = server;
  }

  /**
   * Abre el túnel del perfil. Si no hay huella guardada la recuerda (TOFU) y acepta;
   * si difiere de la guardada, rechaza.
   */
  static async open(profile: DbProfile, secrets: SshSecrets, keys: HostKeyStore): Promise<SshTunnel> {
    const tunnel = profile.tunnel;
    const sshHost = (tunnel.host ?? "").trim();
    const sshUser = (tunnel.user ?? "").trim();
    const sshPort = tunnel.port > 0 ? tunnel.port : SSH_PORT;
    if (!sshHost || !sshUser) {
      throw new Error("Falta el host o el usuario del túnel SSH.");
    }
    const dbHost = (profile.host ?? "").trim() || "127.0.0.1";
    const dbPort = profile.port > 0 ? profile.port : DB_PORT;
    const server = serverKey(sshHost, sshPort);
    const auth = await buildAuthConfig(profile, secrets);

    const client = new Client();
    const local = net.createServer();
    let tunnelObj: SshTunnel;
    try {
      tunnelObj = new SshTunnel(await listenLocal(local), client, local);
    } catch (e) {
      try {
        local.close();
      } catch {
        // nada que cerrar
      }
      throw e instanceof Error ? e : new Error(String(e));
    }
    tunnelObj.attachForward(dbHost, dbPort);

    const config: ConnectConfig = {
      host: sshHost,
      port: sshPort,
      username: sshUser,
      readyTimeout: READY_TIMEOUT_MS,
      ...auth,
      hostVerifier: (key: Buffer): boolean => tunnelObj.verifyHostKey(key, server, keys),
    };

    try {
      await tunnelObj.handshake(config, server);
    } catch (e) {
      await tunnelObj.close();
      throw e;
    }
    // Abierto ya: los errores de red despues del `ready` los ve MariaDB al fallar la consulta.
    client.on("error", () => undefined);
    return tunnelObj;
  }

  /** TOFU sobre la huella SHA256 del host. */
  private verifyHostKey(key: Buffer, server: string, keys: HostKeyStore): boolean {
    const got = `SHA256:${createHash("sha256").update(key).digest("base64")}`;
    const known = keys.get(server);
    if (known === undefined) {
      keys.remember(server, got);
      return true;
    }
    const expected = normalizedFingerprint(known);
    if (expected === got) {
      return true;
    }
    this.hostKeyError = new Error(
      `La huella del servidor SSH cambió. Esperado ${expected}, recibido ${got}. Servidor: ${server}.`
    );
    return false;
  }

  /** Espera el `ready` del cliente SSH con mensajes claros en español. */
  private handshake(config: ConnectConfig, server: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (fallback: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        reject(this.hostKeyError ?? fallback);
      };
      this.client.on("ready", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      this.client.on("error", (e) => fail(new Error(`No se pudo abrir el túnel SSH con ${server}: ${e.message}`)));
      this.client.on("timeout", () =>
        fail(new Error(`Tiempo de espera agotado (${READY_TIMEOUT_MS} ms) al abrir el túnel SSH con ${server}.`))
      );
      try {
        this.client.connect(config);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        fail(new Error(`No se pudo abrir el túnel SSH con ${server}: ${msg}`));
      }
    });
  }

  /** Encauza cada conexion local hacia el destino del perfil a traves del túnel. */
  private attachForward(dbHost: string, dbPort: number): void {
    this.server.on("error", () => undefined);
    this.server.on("connection", (sock) => {
      this.sockets.add(sock);
      sock.on("close", () => this.sockets.delete(sock));
      sock.on("error", () => sock.destroy());
      this.client.forwardOut("127.0.0.1", sock.remotePort ?? 0, dbHost, dbPort, (err, chan) => {
        if (err || chan === undefined) {
          sock.destroy();
          return;
        }
        this.channels.add(chan);
        chan.on("close", () => this.channels.delete(chan));
        chan.on("error", () => chan.destroy());
        sock.pipe(chan);
        chan.pipe(sock);
      });
    });
  }

  /** Cierra el servidor local y el cliente. Nunca lanza. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const sock of this.sockets) {
      try {
        sock.destroy();
      } catch {
        // ya estaba roto
      }
    }
    this.sockets.clear();
    for (const chan of this.channels) {
      try {
        chan.close();
      } catch {
        // ya estaba roto
      }
    }
    this.channels.clear();
    try {
      this.client.end();
    } catch {
      // sin conexion que terminar
    }
    try {
      this.client.destroy();
    } catch {
      // ya estaba caída
    }
    try {
      this.server.close();
    } catch {
      // ya cerrado
    }
  }
}
