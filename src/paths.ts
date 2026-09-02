import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Config } from "./config.js";

/** Reference images bigger than this are refused before the upload starts. */
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;

export type ImageKind = "png" | "jpeg" | "webp" | "gif";

/**
 * Path containment, resolved and normalised. `relative` is case-insensitive on
 * win32, which is what the filesystem does there too.
 */
export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Container sniffing from magic bytes; the extension of a path proves nothing. */
export function sniffImage(buf: Buffer): ImageKind | null {
  if (buf.length > 8 && buf.subarray(1, 4).toString("latin1") === "PNG") return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return "jpeg";
  if (
    buf.length > 12 &&
    buf.subarray(0, 4).toString("latin1") === "RIFF" &&
    buf.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "webp";
  }
  if (buf.length > 6 && buf.subarray(0, 3).toString("latin1") === "GIF") return "gif";
  return null;
}

/**
 * Resolves a caller-supplied `save_dir` inside the sandbox root.
 *
 * `save_dir` arrives from the model, not from the user, so an unconstrained
 * value lets a prompt write files anywhere this process can reach. Relative
 * values are resolved against the root rather than the cwd, which is whatever
 * directory the MCP client happened to start in.
 */
export function resolveSaveDir(cfg: Config, override?: string): string {
  const raw = override?.trim();
  if (!raw) return cfg.saveDir;
  const dir = isAbsolute(raw) ? resolve(raw) : resolve(cfg.saveRoot, raw);
  if (!isInside(cfg.saveRoot, dir)) {
    throw new Error(
      `save_dir must stay inside ${cfg.saveRoot}: ${dir} is outside it. ` +
        `Set PROIMAGE_SAVE_DIR_ROOT to widen the sandbox.`,
    );
  }
  return dir;
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Validates reference images before any of their bytes leave the machine.
 *
 * `image_path` is an LLM-controlled absolute path, so "readable" is not a
 * sufficient test: without a content check, one prompt can have a private key
 * or an .env uploaded to the relay as a "reference image". A file that is not
 * a real image is refused locally, at zero cost.
 *
 * Returns an error message, or null when every path is acceptable.
 */
export async function checkImageInputs(paths: string[], cfg: Config): Promise<string | null> {
  for (const raw of paths) {
    const requested = resolve(raw);
    let real: string;
    try {
      // realpath resolves symlinks, so a link cannot point out of the root.
      real = await realpath(requested);
    } catch {
      return `Image not found or unreadable: ${raw}`;
    }

    if (cfg.inputRoot && !isInside(cfg.inputRoot, real)) {
      return (
        `Reference image outside PROIMAGE_INPUT_ROOT (${cfg.inputRoot}): ${real}. ` +
        `Move the file inside that root, or widen PROIMAGE_INPUT_ROOT.`
      );
    }

    const info = await stat(real);
    if (!info.isFile()) return `Not a file: ${raw}`;
    if (info.size > MAX_INPUT_BYTES) {
      return (
        `Reference image is ${(info.size / 1024 / 1024).toFixed(1)}MB, over the ` +
        `${MAX_INPUT_BYTES / 1024 / 1024}MB limit: ${raw}`
      );
    }
    if (info.size === 0) return `Reference image is empty: ${raw}`;

    if (!sniffImage(await readHead(real, 16))) {
      return (
        `Not an image file: ${raw}. Reference images must be PNG, JPEG, WebP or GIF - ` +
        `the file's magic bytes are none of those, so it was not uploaded.`
      );
    }
  }
  return null;
}

/**
 * The relay answers with a URL that this server then fetches. Downloading
 * whatever host it names would make the server a request generator pointed at
 * anything reachable from this machine, including link-local metadata services,
 * so the host must be on the trusted list.
 */
export function assertDownloadable(rawUrl: string, cfg: Config): string {
  const trimmed = rawUrl.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`The API returned an unusable image URL: ${trimmed}`);
  }

  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`Refusing to download over ${url.protocol}//: ${trimmed}`);
  }

  const trusted = cfg.trustedDownloadHosts.some((entry) => host === entry || host.endsWith(`.${entry}`));
  if (!trusted) {
    throw new Error(
      `Refusing to download the image from an untrusted host: ${host}. ` +
        `Trusted hosts are ${cfg.trustedDownloadHosts.join(", ")}. ` +
        `Add it to PROIMAGE_TRUSTED_DOWNLOAD_HOSTS if that host is expected.`,
    );
  }
  return trimmed;
}
