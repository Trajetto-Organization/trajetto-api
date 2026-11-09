import { injectable } from "tsyringe";

import { env } from "@/env";
import {
  mapTileSettingsFrom,
  resolveMapTiles,
  type MapTiles,
} from "@/shared/map/map-tiles";

interface MapConfig {
  /** Null: no provider outside development, so no base map ("sem mapa de fundo"). */
  tiles: MapTiles | null;
}

/**
 * The base map a client draws (wave 5). The same answer for every session:
 * it is the platform's provider, not a company's data, so it needs no
 * tenant and no permission. The rules are in src/shared/map/map-tiles.ts.
 */
@injectable()
class GetMapConfigUseCase {
  execute(): MapConfig {
    return { tiles: resolveMapTiles(mapTileSettingsFrom(env)) };
  }
}

export { GetMapConfigUseCase };
export type { MapConfig };
