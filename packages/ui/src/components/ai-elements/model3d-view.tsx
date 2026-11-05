"use client";

// Sando (ShrineTech): inline 3D model viewer (SANDO-VIEWER3D.md, 2026-11-05). Two entry points share one view:
//   - PreviewPane: a workspace .glb/.gltf/.stl/.3mf/.obj opened from a message file link or the file tree (autoStart);
//   - Model3dBlock: a ```model3d {"src": "…", "label": "…"} fence in an assistant reply (tap to view).
// Bytes come through IFileService.readFileRange (lib/model3dFile.ts); three.js (lib/model3dViewer.ts) is a lazy chunk.
// At most MAX_LIVE WebGL contexts stay alive on the page: starting another one stops the oldest (it goes back to its poster).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BoxIcon, Maximize2Icon, MoonIcon, RotateCcwIcon, SunIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { resolveMarkdownFileLink } from "@/lib/markdownFileLink.js";
import { readModel3dFile, Model3dReadError, type Model3dFileReader } from "@/lib/model3dFile.js";
import {
  fileNameOf,
  formatModel3dBytes,
  formatModel3dSize,
  formatModel3dTriangles,
  model3dFormatOf,
  model3dSiblingPath,
  parseModel3dSpec,
} from "@/lib/model3dSpec.js";
import type { Model3dBackground, Model3dViewerHandle } from "@/lib/model3dViewer.js";

type ViewerModule = typeof import("@/lib/model3dViewer.js");
let viewerModule: Promise<ViewerModule> | null = null;
const loadViewer = (): Promise<ViewerModule> => {
  viewerModule ??= import("@/lib/model3dViewer.js").catch((e: unknown) => {
    viewerModule = null; // a failed chunk load may be retried
    throw e;
  });
  return viewerModule;
};

const MAX_LIVE = 3;
const live: Array<{ id: symbol; stop: () => void }> = [];
const dropLive = (id: symbol) => {
  const i = live.findIndex((v) => v.id === id);
  if (i >= 0) live.splice(i, 1);
};

const pageIsDark = (): boolean =>
  typeof document === "undefined" || document.documentElement.classList.contains("dark");

type Phase = "idle" | "reading" | "parsing" | "ready" | "error";

export interface Model3dViewProps {
  path: string;
  label?: string;
  reader: Model3dFileReader;
  autoStart?: boolean;
  /** "pane" fills the PreviewPane body; "block" is a card inside a message. */
  variant?: "pane" | "block";
}

export function Model3dView({
  path,
  label,
  reader,
  autoStart = false,
  variant = "block",
}: Model3dViewProps) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const format = model3dFormatOf(path);
  const file = fileNameOf(path);
  const shell = useRef<HTMLDivElement | null>(null);
  const canvasHost = useRef<HTMLDivElement | null>(null);
  const readerRef = useRef(reader);
  readerRef.current = reader;
  const tRef = useRef(t);
  tRef.current = t;
  const handle = useRef<Model3dViewerHandle | null>(null);
  const abort = useRef<AbortController | null>(null);
  const idRef = useRef<symbol>(Symbol("model3d"));
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<{ read: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readout, setReadout] = useState<string | null>(null);
  const [wire, setWire] = useState(false);
  const [bg, setBg] = useState<Model3dBackground>(() => (pageIsDark() ? "dark" : "light"));
  const [full, setFull] = useState(false);
  const bgRef = useRef(bg);
  bgRef.current = bg;
  const wireRef = useRef(wire);
  wireRef.current = wire;

  const stop = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    handle.current?.dispose();
    handle.current = null;
    dropLive(idRef.current);
    setPhase("idle");
    setProgress(null);
  }, []);

  const start = useCallback(async () => {
    if (!format || handle.current || abort.current) return;
    const ac = new AbortController();
    abort.current = ac;
    setError(null);
    setPhase("reading");
    setProgress(null);
    try {
      const reader = readerRef.current;
      const [mod, data] = await Promise.all([
        loadViewer(),
        readModel3dFile(reader, path, {
          signal: ac.signal,
          onProgress: (read, total) => setProgress({ read, total }),
        }),
      ]);
      if (ac.signal.aborted || !canvasHost.current) return;
      while (live.length >= MAX_LIVE) live.shift()?.stop();
      setPhase("parsing");
      const readSibling = async (ref: string) => {
        const sib = model3dSiblingPath(path, ref);
        return sib ? readModel3dFile(reader, sib, { signal: ac.signal }) : null;
      };
      handle.current = mod.mountModel3dViewer(canvasHost.current, {
        format,
        data,
        readSibling,
        background: bgRef.current,
        onInfo: ({ sizeMm, triangles }) => {
          setPhase("ready");
          setReadout(
            tRef.current("sando.m3d.readout", {
              size: formatModel3dSize(sizeMm),
              triangles: formatModel3dTriangles(triangles),
              bytes: formatModel3dBytes(data.byteLength),
            }),
          );
          if (wireRef.current) handle.current?.setWireframe(true);
        },
        onError: (msg) => {
          setPhase("error");
          setError(msg);
        },
      });
      live.push({ id: idRef.current, stop });
    } catch (e) {
      if (ac.signal.aborted) return;
      const code = e instanceof Model3dReadError ? e.code : null;
      const msg =
        code === "too_large"
          ? tRef.current("sando.m3d.tooLarge")
          : String((e as Error)?.message || e).slice(0, 160);
      logger.warn("[Model3dView] model load failed", { file, error: msg });
      setPhase("error");
      setError(msg);
    } finally {
      if (abort.current === ac && !handle.current) abort.current = null;
    }
  }, [file, format, path, stop]);

  useEffect(() => {
    if (autoStart) void start();
    return () => {
      abort.current?.abort();
      abort.current = null;
      handle.current?.dispose();
      handle.current = null;
      dropLive(idRef.current);
    };
  }, [autoStart, start]);

  // Full screen: the Fullscreen API where there is one (desktop, Android, iPad), else a fixed overlay (iPhone). Esc / ✕ leave.
  useEffect(() => {
    if (!full) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFull(false);
    };
    const onFs = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    document.addEventListener("keydown", onKey);
    document.documentElement.classList.add("sando-m3d-locked");
    const el = shell.current;
    let usedApi = false;
    if (el?.requestFullscreen && !document.fullscreenElement) {
      el.requestFullscreen()
        .then(() => {
          usedApi = true;
          document.addEventListener("fullscreenchange", onFs);
        })
        .catch(() => {});
    }
    requestAnimationFrame(() => handle.current?.resize());
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFs);
      document.documentElement.classList.remove("sando-m3d-locked");
      if (usedApi && document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
      requestAnimationFrame(() => handle.current?.resize());
    };
  }, [full]);

  if (!format) return null;
  const running =
    phase === "reading" ||
    phase === "parsing" ||
    phase === "ready" ||
    (phase === "error" && Boolean(handle.current));
  const status =
    phase === "reading"
      ? progress?.total
        ? t("sando.m3d.reading", {
            read: formatModel3dBytes(progress.read),
            total: formatModel3dBytes(progress.total),
          })
        : t("sando.m3d.loading")
      : phase === "parsing"
        ? t("sando.m3d.parsing")
        : null;

  return (
    <div
      ref={shell}
      data-sando-rich="model3d"
      className={cn(
        "sando-m3d flex min-h-0 flex-col overflow-hidden bg-card text-ui-base",
        variant === "block" ? "my-4 rounded-lg border border-border" : "h-full",
        full && "sando-m3d--full",
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-ui-xs text-muted-foreground" title={path}>
          {t("sando.m3d.title", { label: label || file })}
        </span>
        {full ? (
          <Button type="button" size="sm" variant="outline" onClick={() => setFull(false)}>
            <XIcon />
            {t("sando.m3d.close")}
          </Button>
        ) : null}
      </div>
      <div
        className={cn("sando-m3d__stage relative", variant === "pane" && !full && "flex-1")}
        data-bg={bg}
      >
        {/* three.js owns this node's children (the canvas); React never renders into it. */}
        <div ref={canvasHost} className="absolute inset-0" />
        {!running ? (
          <button
            type="button"
            className="sando-m3d__poster absolute inset-0 flex w-full items-center justify-center text-ui-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => void start()}
          >
            {phase === "error" ? t("sando.m3d.retry") : t("sando.m3d.tap")}
          </button>
        ) : null}
      </div>
      {status ? <div className="px-3 py-1.5 text-ui-xs text-muted-foreground">{status}</div> : null}
      {error ? (
        <div className="px-3 py-1.5 text-ui-xs text-warning" role="alert">
          {t("sando.m3d.error", { error })}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-2 py-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={phase !== "ready"}
          onClick={() => handle.current?.reset()}
        >
          <RotateCcwIcon />
          {t("sando.m3d.reset")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-pressed={wire}
          className={cn(wire && "border-primary text-primary")}
          disabled={phase !== "ready"}
          onClick={() => {
            const next = !wire;
            setWire(next);
            handle.current?.setWireframe(next);
          }}
        >
          <BoxIcon />
          {t("sando.m3d.wireframe")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            const next = bg === "dark" ? "light" : "dark";
            setBg(next);
            handle.current?.setBackground(next);
          }}
        >
          {bg === "dark" ? <SunIcon /> : <MoonIcon />}
          {bg === "dark" ? t("sando.m3d.light") : t("sando.m3d.dark")}
        </Button>
        {!full ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setFull(true);
              if (!running) void start();
            }}
          >
            <Maximize2Icon />
            {t("sando.m3d.full")}
          </Button>
        ) : null}
        {phase === "ready" ? (
          <Button type="button" size="sm" variant="ghost" onClick={stop}>
            {t("sando.m3d.stop")}
          </Button>
        ) : null}
      </div>
      <div className="px-3 pb-2 font-mono text-ui-xs text-muted-foreground [overflow-wrap:anywhere]">
        {readout ?? file}
      </div>
    </div>
  );
}

/** ```model3d fence: resolve the src against the workspace (like a markdown file link), then the same view. */
export function Model3dBlock({
  code,
  fallback,
  workspacePath,
  workspaceHomePath,
}: {
  code: string;
  fallback: ReactNode;
  workspacePath?: string;
  workspaceHomePath?: string;
}): ReactNode {
  const { intl } = useZCodeIntl();
  const services = useOptionalServices();
  const parsed = useMemo(() => parseModel3dSpec(code), [code]);
  const resolved = useMemo(() => {
    if (!parsed.ok) return null;
    const link = resolveMarkdownFileLink(workspacePath, parsed.model.src, {
      homePath: workspaceHomePath,
    });
    return link?.path && model3dFormatOf(link.path) ? link.path : null;
  }, [parsed, workspaceHomePath, workspacePath]);
  const error = !parsed.ok
    ? parsed.error
    : !services
      ? "files cannot be read here"
      : !resolved
        ? "outside the workspace"
        : null;
  if (error || !parsed.ok || !resolved || !services) {
    return (
      <div className="my-4" data-sando-rich="error">
        <div className="mb-1 text-ui-sm text-muted-foreground">
          {intl.formatMessage({ id: "sando.m3d.invalid" }, { error: error ?? "" })}
        </div>
        {fallback}
      </div>
    );
  }
  return <Model3dView path={resolved} label={parsed.model.label} reader={services.fileService} />;
}
