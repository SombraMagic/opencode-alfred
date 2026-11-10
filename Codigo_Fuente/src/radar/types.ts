/**
 * Modelo del Radar de noticias: configuración, noticia normalizada y estado de la
 * última pasada. Sin `vscode`: lo consumen el servicio, el panel y `extension.ts`.
 */

/** Proveedores del filtro LLM. Los tres hablan chat completions compatible con OpenAI. */
export type RadarProveedor = "ollama" | "openai" | "deepseek";

/** Feed público que lee el radar. */
export interface RadarFuente {
  /** Identificador estable (no se renombra al editar el nombre visible). */
  id: string;
  nombre: string;
  url: string;
  activa: boolean;
  /**
   * Tema que se asigna a TODAS las noticias de esta fuente. Con él, las reglas de
   * inclusión no se miran (las de exclusión sí): un feed temático no necesita que sus
   * titulares casen con la lista de palabras. Vacío o ausente = sin tema fijo.
   */
  temaFijo?: string;
}

/** Tema con sus reglas de inclusión y exclusión (palabras sueltas o frases). */
export interface RadarTema {
  id: string;
  nombre: string;
  /** Si el texto casa con alguna, la noticia pasa a la capa del LLM. */
  incluir: string[];
  /** Si el texto casa con alguna, la noticia se descarta antes del LLM. */
  excluir: string[];
}

/** Configuración completa del radar. Vive en `globalState` `opencodeAgents.radar.config`. */
export interface RadarConfig {
  fuentes: RadarFuente[];
  temas: RadarTema[];
  proveedor: RadarProveedor;
  /** Vacío = el defecto del proveedor (en Ollama, el primer modelo instalado). */
  modelo: string;
  /** Puntuación mínima (0-100) para entrar en `ultimas.md`. */
  umbral: number;
  /** Perfil MariaDB del panel de bases de datos. Vacío = el primero guardado. */
  profileId: string;
  /** Pide al mismo LLM la traducción al español del titular y del cuerpo. */
  traducir: boolean;
}

/** Noticia normalizada, lista para guardar en `alfred_radar.items`. */
export interface RadarNoticia {
  /** sha256 de enlace canónico + título normalizado: clave de deduplicación. */
  hash: string;
  fuenteId: string;
  fuenteNombre: string;
  titulo: string;
  enlace: string;
  resumen: string;
  autor: string;
  /** Epoch ms; 0 si el feed no trae fecha legible. */
  publicada: number;
  /** Epoch ms del momento de la recogida. */
  recogida: number;
  /** La noticia no pasó las reglas por tema: no se puntúa ni sale en la lista. */
  descartada: boolean;
  /** Tema sugerido por las reglas (el LLM puede corregirlo). */
  temaRegla: string;
}

/** Fallo de una fuente en la última pasada: un feed roto no tumba la pasada. */
export interface RadarFallo {
  fuente: string;
  error: string;
}

/** Fase del servicio. `sinBase`: MariaDB apagado, sin perfil o sin contraseña válida. */
export type RadarFase = "idle" | "working" | "sinBase" | "error";

/** Contadores de la última pasada. */
export interface RadarContadores {
  /** Noticias vistas en los feeds (incluye repetidas). */
  descargadas: number;
  /** Insertadas por primera vez en la base. */
  nuevas: number;
  /** Descartadas por las reglas antes del LLM. */
  descartadas: number;
  /** Puntuadas por el LLM en esta pasada. */
  puntuadas: number;
  /** Borradas por la purga de retención. */
  purgadas: number;
}

/** Estado publicado por el servicio: para el panel y para el aviso del comando. */
export interface RadarEstado {
  fase: RadarFase;
  /** Paso en curso, solo con fase `working`. */
  trabajando?: string;
  /** Detalle del fallo (`sinBase`/`error`) o aviso puntual tras una pasada. */
  mensaje?: string;
  /** Epoch ms de la última pasada completada (con éxito o con fallos parciales). */
  ultimaPasada?: number;
  contadores: RadarContadores;
  fallos: RadarFallo[];
  /** Noticias vivas en la base (sin descartar); -1 si aún no se sabe. */
  total: number;
}

/** Estado inicial: nada hecho todavía. */
export function estadoVacio(): RadarEstado {
  return {
    fase: "idle",
    contadores: { descargadas: 0, nuevas: 0, descartadas: 0, puntuadas: 0, purgadas: 0 },
    fallos: [],
    total: -1,
  };
}

/** Feeds públicos de IA, programación, juegos y humor; sin autenticación. */
export const FUENTES_DEFECTO: readonly RadarFuente[] = [
  { id: "hf-blog", nombre: "Hugging Face blog", url: "https://huggingface.co/blog/feed.xml", activa: true },
  { id: "arxiv-cs-ai", nombre: "arXiv cs.AI", url: "https://export.arxiv.org/rss/cs.AI", activa: true },
  { id: "hacker-news", nombre: "Hacker News", url: "https://hnrss.org/frontpage", activa: true },
  { id: "github-blog", nombre: "GitHub blog", url: "https://github.blog/feed/", activa: true },
  { id: "simonw", nombre: "Simon Willison", url: "https://simonwillison.net/atom/everything/", activa: true },
  {
    id: "ars-technica",
    nombre: "Ars Technica",
    url: "https://feeds.arstechnica.com/arstechnica/technology-lab",
    activa: true,
  },
  {
    id: "mit-tr",
    nombre: "MIT Technology Review",
    url: "https://www.technologyreview.com/feed/",
    activa: true,
  },
  {
    id: "github-trending",
    nombre: "GitHub Trending",
    url: "https://mshibanami.github.io/GitHubTrendingRSS/daily/all.xml",
    activa: true,
    temaFijo: "Programación",
  },
  {
    id: "rps",
    nombre: "Rock Paper Shotgun",
    url: "https://www.rockpapershotgun.com/feed",
    activa: true,
    temaFijo: "Juegos",
  },
  { id: "xkcd", nombre: "xkcd", url: "https://xkcd.com/rss.xml", activa: true, temaFijo: "Humor" },
];

/** Reglas por tema: baratas y locales. El LLM puntúa después solo lo que pasa. */
export const TEMAS_DEFECTO: readonly RadarTema[] = [
  {
    id: "ia",
    nombre: "IA",
    incluir: [
      "ia", "ai", "inteligencia artificial", "llm", "gpt", "claude", "gemini", "llama",
      "mistral", "deepseek", "openai", "anthropic", "transformer", "machine learning",
      "deep learning", "red neuronal", "neural", "agente", "agent", "embedding",
      "fine-tun", "finetun", "inference", "inferencia", "diffusion", "stable diffusion",
      "whisper", "tts", "ocr", "vision", "rag", "prompt", "tokeniz", "hugging face",
      "ollama", "chatbot", "generativ", "multimodal", "mcp", "model context protocol",
    ],
    excluir: ["casino", "apuesta", "sorteo", "descuento", "cupon", "patrocinado", "sponsored"],
  },
  {
    id: "programacion",
    nombre: "Programación",
    incluir: [
      "typescript", "javascript", "python", "rust", "golang", " go ", "java ", "c++", "c#",
      "zig", "kotlin", "swift", "git", "github", "gitlab", "vscode", "vs code", "neovim",
      "compiler", "compilador", "programming", "programacion", "release", "version",
      "open source", "codigo abierto", "library", "libreria", "framework", "api", "sdk",
      "sql", "mariadb", "postgres", "sqlite", "docker", "kubernetes", "linux", "kernel",
      "wasm", "webassembly", "terminal", "cli", "editor", "lsp", "debug", "refactor",
      "testing", "test ", "ci/cd", "deploy", "npm", "pypi", "crates", "pull request",
    ],
    excluir: ["casino", "apuesta", "sorteo", "descuento", "cupon", "patrocinado", "sponsored"],
  },
  {
    id: "papers",
    nombre: "Papers",
    incluir: [
      "paper", "arxiv", "study", "estudio", "research", "investigacion", "benchmark",
      "evaluation", "evaluacion", "survey", "thesis", "tesis", "preprint", "journal",
      "peer-review", "dataset", "benchmarking", "state of the art", "sota",
    ],
    excluir: ["casino", "apuesta", "sorteo", "descuento", "cupon"],
  },
  {
    id: "juegos",
    nombre: "Juegos",
    incluir: [
      "juego", "videojuego", "videojuegos", "steam", "consola", "nintendo", "playstation",
      "xbox", "pc", "dlc", "remaster", "early access",
    ],
    excluir: ["casino", "apuesta", "sorteo", "descuento", "cupon"],
  },
  {
    id: "humor",
    nombre: "Humor",
    incluir: ["xkcd", "comic", "cómic", "humor", "chiste", "parodia", "sátira"],
    excluir: ["casino", "apuesta", "sorteo", "descuento", "cupon"],
  },
];

/** Configuración por defecto: diez fuentes, cinco temas, Ollama local, umbral 45. */
export function configDefecto(): RadarConfig {
  return {
    fuentes: FUENTES_DEFECTO.map((f) => ({ ...f })),
    temas: TEMAS_DEFECTO.map((t) => ({ ...t, incluir: [...t.incluir], excluir: [...t.excluir] })),
    proveedor: "ollama",
    modelo: "",
    umbral: 45,
    profileId: "",
    traducir: false,
  };
}

/** Mezcla lo guardado con los defectos y sanea tipos: `globalState` no es de fiar. */
export function sanearConfig(raw: unknown): RadarConfig {
  const base = configDefecto();
  if (!raw || typeof raw !== "object") {
    return base;
  }
  const r = raw as Record<string, unknown>;

  const fuentes: RadarFuente[] = Array.isArray(r.fuentes)
    ? r.fuentes
        .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
        .map((f, i) => {
          const temaFijo = typeof f.temaFijo === "string" ? f.temaFijo.trim().slice(0, 64) : "";
          const fuente: RadarFuente = {
            id: typeof f.id === "string" && f.id.trim() ? f.id.trim().slice(0, 64) : `fuente-${i + 1}`,
            nombre: typeof f.nombre === "string" && f.nombre.trim() ? f.nombre.trim().slice(0, 200) : "Sin nombre",
            url: typeof f.url === "string" ? f.url.trim().slice(0, 1000) : "",
            activa: f.activa !== false,
          };
          // Vacío = sin tema fijo: la clave no se guarda y no viaja como cadena vacía.
          if (temaFijo) {
            fuente.temaFijo = temaFijo;
          }
          return fuente;
        })
        .filter((f) => /^https?:\/\/.+/i.test(f.url))
    : base.fuentes;

  // Migración: las fuentes del catálogo que no estén guardadas (altas nuevas de una
  // versión) entran solas, activas. Es idempotente y no pisa nada: solo añade ids que
  // faltan, así que lo que el usuario tenga (nombre, url, activa) sigue intacto.
  for (const fuente of base.fuentes) {
    if (!fuentes.some((f) => f.id === fuente.id)) {
      fuentes.push({ ...fuente });
    }
  }

  const temas = Array.isArray(r.temas)
    ? r.temas
        .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
        .map((t, i) => ({
          id: typeof t.id === "string" && t.id.trim() ? t.id.trim().slice(0, 64) : `tema-${i + 1}`,
          nombre: typeof t.nombre === "string" && t.nombre.trim() ? t.nombre.trim().slice(0, 64) : "Sin nombre",
          incluir: listaTextos(t.incluir),
          excluir: listaTextos(t.excluir),
        }))
    : base.temas;

  // Misma migración que las fuentes, para los temas: sin esto, una configuración vieja
  // no conoce «Juegos» ni «Humor», el filtro por chips no los enseña y las noticias de
  // las fuentes temáticas entran con un tema que no está en la lista. Solo añade ids
  // que faltan: nunca duplica ni pisa un tema del usuario. Idempotente; se materializa
  // en el siguiente `saveConfig`, no aquí. Coste aceptado: un tema de defecto que el
  // usuario hubiera borrado vuelve.
  for (const tema of base.temas) {
    if (!temas.some((t) => t.id === tema.id)) {
      temas.push({ ...tema, incluir: [...tema.incluir], excluir: [...tema.excluir] });
    }
  }

  const proveedor: RadarProveedor =
    r.proveedor === "openai" || r.proveedor === "deepseek" || r.proveedor === "ollama"
      ? r.proveedor
      : base.proveedor;

  const umbral = Math.min(100, Math.max(0, Math.round(num(r.umbral, base.umbral))));

  return {
    fuentes,
    temas,
    proveedor,
    modelo: typeof r.modelo === "string" ? r.modelo.trim().slice(0, 200) : "",
    umbral,
    profileId: typeof r.profileId === "string" ? r.profileId.trim().slice(0, 64) : "",
    traducir: r.traducir === true,
  };
}

function num(value: unknown, defecto: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : defecto;
}

function listaTextos(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0 && v.length <= 64)
    .slice(0, 100);
}
