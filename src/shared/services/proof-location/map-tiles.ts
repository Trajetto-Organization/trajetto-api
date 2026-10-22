import { isDecodablePng, isPng } from "../png-integrity";
import { tileUrl, tileViewport, type TileViewport } from "./web-mercator";

/**
 * The static map of the proof document (decision 14.8, design §5.2): the
 * tiles around the GPS fix, fetched from the configured XYZ provider and
 * handed to the renderer as bytes.
 *
 * All or nothing. One tile that fails (status, type, size, corrupt bytes)
 * discards the whole map: a map with a hole in it looks tampered with, and
 * the page already knows how to go without one.
 */

/** Zoom 16: a few blocks across, enough to recognise the street. */
const MAP_ZOOM = 16;

/** The viewport in tile pixels; drawn at 200×85 pt (half scale). */
const MAP_VIEWPORT = { width: 400, height: 170 } as const;

const MAX_TILE_BYTES = 256 * 1024;

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

interface MapTileImage {
  bytes: Buffer;
  left: number;
  top: number;
}

interface ProofMapImage {
  width: number;
  height: number;
  tiles: MapTileImage[];
  marker: { x: number; y: number };
  attribution: string;
}

type TileFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** Whether `bytes` is an image pdfkit can draw without risk (see png-integrity). */
function isAcceptableTile(bytes: Buffer, contentType: string | null): boolean {
  if (bytes.length === 0 || bytes.length > MAX_TILE_BYTES) return false;

  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();

  if (type === "image/png") return isPng(bytes) && isDecodablePng(bytes);

  if (type === "image/jpeg" || type === "image/jpg") {
    return bytes.subarray(0, 3).equals(JPEG_SIGNATURE);
  }

  return false;
}

async function fetchTile(
  url: string,
  signal: AbortSignal,
  fetcher: TileFetch,
  userAgent: string,
): Promise<Buffer | null> {
  try {
    const response = await fetcher(url, {
      signal,
      headers: { "user-agent": userAgent, accept: "image/png,image/jpeg" },
    });

    if (response.status !== 200) return null;

    // Refused before reading the body when the provider says it is huge.
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > MAX_TILE_BYTES) return null;

    const bytes = Buffer.from(await response.arrayBuffer());

    return isAcceptableTile(bytes, response.headers.get("content-type"))
      ? bytes
      : null;
  } catch {
    return null;
  }
}

/**
 * The map around (latitude, longitude), or null when there is no provider,
 * no budget left, or any tile is unusable.
 *
 * `timeoutMs` is the budget for ALL tiles together, fetched in parallel.
 */
async function fetchProofMap(
  latitude: number,
  longitude: number,
  options: {
    template: string | undefined;
    attribution: string | undefined;
    timeoutMs: number;
    userAgent: string;
    fetcher?: TileFetch;
  },
): Promise<ProofMapImage | null> {
  if (!options.template || !options.attribution) return null;

  const viewport: TileViewport = tileViewport(latitude, longitude, {
    zoom: MAP_ZOOM,
    ...MAP_VIEWPORT,
  });

  if (viewport.tiles.length === 0) return null;

  const signal = AbortSignal.timeout(options.timeoutMs);
  const fetcher = options.fetcher ?? (fetch as unknown as TileFetch);

  const fetched = await Promise.all(
    viewport.tiles.map((tile) =>
      fetchTile(
        tileUrl(options.template!, tile),
        signal,
        fetcher,
        options.userAgent,
      ),
    ),
  );

  if (fetched.some((bytes) => bytes === null)) return null;

  return {
    width: viewport.width,
    height: viewport.height,
    tiles: viewport.tiles.map((tile, index) => ({
      bytes: fetched[index] as Buffer,
      left: tile.left,
      top: tile.top,
    })),
    marker: viewport.marker,
    attribution: options.attribution,
  };
}

export {
  MAP_VIEWPORT,
  MAP_ZOOM,
  MAX_TILE_BYTES,
  fetchProofMap,
  isAcceptableTile,
};
export type { MapTileImage, ProofMapImage, TileFetch };
