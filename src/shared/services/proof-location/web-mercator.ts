/**
 * Which XYZ map tiles cover a small viewport centred on a point, and where
 * the point falls inside it (Web Mercator, EPSG:3857 — what every XYZ tile
 * provider serves). Pure, so the arithmetic is tested without a provider.
 *
 * Used by the proof document's static map (decision 14.8, design §5.2): the
 * map is a mosaic of tiles drawn by pdfkit, no image library involved.
 */
const TILE_SIZE = 256;

interface TilePlacement {
  z: number;
  /** Tile column, already wrapped around the antimeridian. */
  x: number;
  y: number;

  /** Where the tile's top-left corner sits in the viewport, in pixels. */
  left: number;
  top: number;
}

interface TileViewport {
  zoom: number;
  width: number;
  height: number;

  tiles: TilePlacement[];

  /** The point, in viewport pixels. Always the centre, by construction. */
  marker: { x: number; y: number };
}

/** Global pixel coordinates of a point at `zoom` (origin top-left). */
function projectToPixels(
  latitude: number,
  longitude: number,
  zoom: number,
): { x: number; y: number } {
  const scale = TILE_SIZE * 2 ** zoom;

  // Mercator is undefined at the poles; tile providers stop at ±85.0511°.
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const phi = (clamped * Math.PI) / 180;

  return {
    x: ((longitude + 180) / 360) * scale,
    y: ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * scale,
  };
}

/**
 * The tiles a `width`×`height` viewport centred on the point touches.
 *
 * At most ceil(w/256)+1 by ceil(h/256)+1 tiles: a 400×170 viewport is 2–3
 * columns by 1–2 rows, the 3×2 grid of the design at worst.
 */
function tileViewport(
  latitude: number,
  longitude: number,
  options: { zoom: number; width: number; height: number },
): TileViewport {
  const { zoom, width, height } = options;
  const count = 2 ** zoom;

  const centre = projectToPixels(latitude, longitude, zoom);

  const viewLeft = centre.x - width / 2;
  const viewTop = centre.y - height / 2;

  const firstColumn = Math.floor(viewLeft / TILE_SIZE);
  const lastColumn = Math.floor((viewLeft + width - 1) / TILE_SIZE);
  const firstRow = Math.floor(viewTop / TILE_SIZE);
  const lastRow = Math.floor((viewTop + height - 1) / TILE_SIZE);

  const tiles: TilePlacement[] = [];

  for (let row = firstRow; row <= lastRow; row += 1) {
    // Past the top or bottom of the world there is no tile to ask for.
    if (row < 0 || row >= count) continue;

    for (let column = firstColumn; column <= lastColumn; column += 1) {
      tiles.push({
        z: zoom,
        // Columns wrap: the world repeats east-west.
        x: ((column % count) + count) % count,
        y: row,
        left: column * TILE_SIZE - viewLeft,
        top: row * TILE_SIZE - viewTop,
      });
    }
  }

  return {
    zoom,
    width,
    height,
    tiles,
    marker: { x: centre.x - viewLeft, y: centre.y - viewTop },
  };
}

/** Fills an XYZ template: `{z}/{x}/{y}` and an optional `{s}` subdomain. */
function tileUrl(template: string, tile: { z: number; x: number; y: number }): string {
  const subdomain = ["a", "b", "c"][(tile.x + tile.y) % 3];

  return template
    .replace("{s}", subdomain)
    .replace("{z}", String(tile.z))
    .replace("{x}", String(tile.x))
    .replace("{y}", String(tile.y));
}

export { TILE_SIZE, projectToPixels, tileUrl, tileViewport };
export type { TilePlacement, TileViewport };
