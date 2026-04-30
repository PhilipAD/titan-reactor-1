/**
 * Hermes "Settlement" base layout.
 *
 * Goal
 * ----
 * Take a flat list of Hermes entities and lay them out as a *believable* SC
 * base on the loaded map: a Command Center anchor at the heart, a Tech ring
 * around it, supply/depots tucked behind, defensive bunkers at the perimeter,
 * subagents tight to the core, workers snapped to the actual mineral patches
 * the CHK placed on the map, and active sessions strung along the front line.
 *
 * Algorithm
 * ---------
 * Layered: each scType gets a "placement strategy" that mirrors how a
 * (mid-skill) human Terran player actually lays out buildings, falling back
 * to a stochastic-but-collision-safe placer for free-form units. References:
 *   - Liquipedia "Walling as Terran" (https://liquipedia.net/starcraft/Walling_as_Terran)
 *   - Liquipedia "List of Unit and Building Sizes" (footprints in tiles)
 *   - Liquipedia "Walling" (grid + addon-gap principles)
 *
 * Strategies (Hermes 2026-04 Terran human-tidy pass):
 *
 *   - **core**       : single building locked at the base center
 *                      (Command Center).
 *   - **wall-row**   : tight horizontal row at a fixed Y offset — the
 *                      classic Supply Depot wall, packed flush so a
 *                      Zergling can't slip through (footprintW + 1 tile).
 *   - **production-strip** : a horizontal row of production buildings
 *                      (Barracks → Factory → Starport), each with its
 *                      mandatory 2-tile addon gap reserved on the right
 *                      (Comsat/Machine Shop/Control Tower).
 *   - **tidy-arc**   : N buildings spread evenly around an angular arc
 *                      at a fixed ring radius — the orderly Eng-Bay /
 *                      Bunker / Turret perimeter look.
 *   - **worker**     : snap to nearest CHK mineral patch (existing).
 *   - **free-poisson** : Bridson-style Poisson-disk sampling within a
 *                      ring annulus, used for free-form units (Marines,
 *                      and the catch-all unknown scType).
 *
 * Backstop: for any concentric-ring placement we still verify minimum
 * tile-spacing against everything placed so far (cross-strategy collision
 * avoidance), and unbuildable terrain is rejected via the optional
 * `_can_place_building_at` engine hook.
 *
 * Pure module: no I/O, no side effects, deterministic given the same input
 * (we use a tiny seedable LCG so the layout is stable across reloads — the
 * user shouldn't see the base spontaneously rearrange itself just because
 * the dashboard re-rendered).
 */

export interface HermesEntityShape {
    id: string;
    scType: string;
    editPx?: number;
    editPy?: number;
}

export interface ResourcePatch {
    /** OpenBW pixel coords (CHK frame). */
    px: number;
    py: number;
    type: "mineral" | "gas";
}

export type LayoutRole =
    | "core"
    | "tech-ring"
    | "supply-back"
    | "defense-perimeter"
    | "subagent-cluster"
    | "front-patrol"
    | "static-post"
    | "worker-near-resource"
    | "wanderer";

export interface PlacementResult {
    px: number;
    py: number;
    role: LayoutRole;
    /**
     * For roles that involve patrolling, this is a small set of pixel
     * waypoints the behavior loop should cycle through. Optional: the
     * behavior loop falls back to a generic orbit otherwise.
     */
    waypoints?: { px: number; py: number }[];
    /** For workers, the nearest mineral patch they should gather from. */
    targetResourcePx?: number;
    targetResourcePy?: number;
    targetResourceType?: "mineral" | "gas";
}

export interface LayoutContext {
    mapWidthTiles: number;
    mapHeightTiles: number;
    /** Optional anchor; defaults to the map center. Pixel coords. */
    centerPx?: number;
    centerPy?: number;
    /** Mineral fields and geysers from the loaded CHK. */
    resources?: ResourcePatch[];
    /** Deterministic seed; defaults to a stable value. */
    seed?: number;
    /**
     * Hermes 2026-04 deeper rebuild — optional WASM-backed placement check.
     * If provided, layout will reject any (px, py, scType) that the engine
     * says is unbuildable (e.g. on water, on ramps, on top of CHK doodads),
     * causing Poisson sampling to retry and the spiral fallback to try a
     * different angle.
     *
     * Wire this to `_can_place_building_at` from the rebuilt titan.wasm via
     * the bridge in `hermes-entity-bridge.ts`. When the legacy wasm is
     * loaded the property is omitted and we keep the old behavior.
     */
    validatePlacement?: ( params: {
        scType: string;
        unitTypeId: number;
        px: number;
        py: number;
    } ) => boolean;
    analyzePlacement?: ( params: {
        scType: string;
        unitTypeId: number;
        px: number;
        py: number;
    } ) => {
        ok: boolean;
        componentId: number | null;
        edgeClearanceTiles: number;
    };
    /**
     * Lookup table from scType -> SC unit type id. Required when
     * `validatePlacement` is provided so we can call the engine with the
     * right type id for each entity's intended building.
     */
    scTypeToUnitTypeId?: Record< string, number >;
}

/**
 * Hermes 2026-04 Terran human-tidy pass: per-scType placement strategy.
 * - "core"             : pinned at (cx, cy)
 * - "wall-row"         : tight horizontal row at a fixed radius from CC
 * - "production-strip" : horizontal row with 2-tile addon gap to the right
 * - "tidy-arc"         : even angular spacing on one ring
 * - "worker"           : snap to nearest mineral patch
 * - "free-poisson"     : Bridson Poisson-disk sampling within an annulus
 *                        (legacy organic fallback for units / unknowns).
 */
type PlaceStrategy =
    | "core"
    | "resource-building"
    | "wall-row"
    | "production-strip"
    | "tidy-arc"
    | "worker"
    | "free-poisson";

/**
 * Footprint of each Terran building in BW tiles (1 tile = 32 px). Sourced
 * from Liquipedia "List of Unit and Building Sizes":
 *   CC / Barracks / Factory / Starport / Eng Bay : 128 x 96  -> 4 x 3
 *   Supply Depot / Academy / Armory / Bunker     : 96  x 64  -> 3 x 2
 *   Missile Turret                               : 64  x 64  -> 2 x 2
 *   Refinery                                     : 128 x 64  -> 4 x 2
 *   Add-on (Comsat / Machine Shop / Control Tw)  : 64  x 64  -> 2 x 2
 */
interface BuildingFootprint {
    wTiles: number;
    hTiles: number;
    /** When true, reserve a 2-tile-wide addon gap to the right. */
    addonRight?: boolean;
}

const FOOTPRINT_BY_SCTYPE: Record< string, BuildingFootprint > = {
    CommandCenter: { wTiles: 4, hTiles: 3 },
    Refinery: { wTiles: 4, hTiles: 2 },
    Barracks: { wTiles: 4, hTiles: 3, addonRight: true },
    Factory: { wTiles: 4, hTiles: 3, addonRight: true },
    Starport: { wTiles: 4, hTiles: 3, addonRight: true },
    Academy: { wTiles: 3, hTiles: 2 },
    TechBuilding: { wTiles: 4, hTiles: 3 },
    EngineeringBay: { wTiles: 4, hTiles: 3 },
    Armory: { wTiles: 3, hTiles: 2 },
    ScienceFacility: { wTiles: 4, hTiles: 3, addonRight: true },
    SupplyDepot: { wTiles: 3, hTiles: 2 },
    Bunker: { wTiles: 3, hTiles: 2 },
    MissileTurret: { wTiles: 2, hTiles: 2 },
    ComsatStation: { wTiles: 2, hTiles: 2 },
    NuclearSilo: { wTiles: 2, hTiles: 2 },
    ControlTower: { wTiles: 2, hTiles: 2 },
    MachineShop: { wTiles: 2, hTiles: 2 },
    CovertOps: { wTiles: 2, hTiles: 2 },
    PhysicsLab: { wTiles: 2, hTiles: 2 },
    Gateway: { wTiles: 4, hTiles: 3, addonRight: true },
    Hatchery: { wTiles: 4, hTiles: 3 },
    Lair: { wTiles: 4, hTiles: 3 },
    Hive: { wTiles: 4, hTiles: 3 },
    Extractor: { wTiles: 4, hTiles: 2 },
    SpawningPool: { wTiles: 3, hTiles: 2 },
    HydraliskDen: { wTiles: 3, hTiles: 2 },
    EvolutionChamber: { wTiles: 3, hTiles: 2 },
    Spire: { wTiles: 3, hTiles: 2 },
    GreaterSpire: { wTiles: 3, hTiles: 2 },
    QueensNest: { wTiles: 3, hTiles: 2 },
    DefilerMound: { wTiles: 3, hTiles: 2 },
    UltraliskCavern: { wTiles: 3, hTiles: 2 },
    NydusCanal: { wTiles: 2, hTiles: 2 },
    CreepColony: { wTiles: 2, hTiles: 2 },
    SporeColony: { wTiles: 2, hTiles: 2 },
    SunkenColony: { wTiles: 2, hTiles: 2 },
    Nexus: { wTiles: 4, hTiles: 3 },
    Pylon: { wTiles: 2, hTiles: 2 },
    Assimilator: { wTiles: 4, hTiles: 2 },
    RoboticsFacility: { wTiles: 4, hTiles: 3 },
    RoboticsSupportBay: { wTiles: 3, hTiles: 2 },
    Observatory: { wTiles: 3, hTiles: 2 },
    TemplarArchives: { wTiles: 3, hTiles: 2 },
    Forge: { wTiles: 3, hTiles: 2 },
    CyberneticsCore: { wTiles: 3, hTiles: 2 },
    Stargate: { wTiles: 4, hTiles: 3 },
    FleetBeacon: { wTiles: 3, hTiles: 2 },
    ArbiterTribunal: { wTiles: 3, hTiles: 2 },
    PhotonCannon: { wTiles: 2, hTiles: 2 },
    ShieldBattery: { wTiles: 2, hTiles: 2 },
    Marine: { wTiles: 1, hTiles: 1 },
    Firebat: { wTiles: 1, hTiles: 1 },
    Ghost: { wTiles: 1, hTiles: 1 },
    Dropship: { wTiles: 2, hTiles: 2 },
    ScienceVessel: { wTiles: 2, hTiles: 2 },
    Zealot: { wTiles: 1, hTiles: 1 },
    Drone: { wTiles: 1, hTiles: 1 },
    Probe: { wTiles: 1, hTiles: 1 },
    Zergling: { wTiles: 1, hTiles: 1 },
    Hydralisk: { wTiles: 1, hTiles: 1 },
    Lurker: { wTiles: 1, hTiles: 1 },
    Mutalisk: { wTiles: 1, hTiles: 1 },
    Guardian: { wTiles: 2, hTiles: 2 },
    Overlord: { wTiles: 2, hTiles: 2 },
    Overseer: { wTiles: 2, hTiles: 2 },
    Defiler: { wTiles: 1, hTiles: 1 },
    Ultralisk: { wTiles: 2, hTiles: 2 },
    Scourge: { wTiles: 1, hTiles: 1 },
    Dragoon: { wTiles: 1, hTiles: 1 },
    HighTemplar: { wTiles: 1, hTiles: 1 },
    DarkTemplar: { wTiles: 1, hTiles: 1 },
    Archon: { wTiles: 1, hTiles: 1 },
    DarkArchon: { wTiles: 1, hTiles: 1 },
    Shuttle: { wTiles: 2, hTiles: 2 },
    Reaver: { wTiles: 1, hTiles: 1 },
    Observer: { wTiles: 1, hTiles: 1 },
    Carrier: { wTiles: 2, hTiles: 2 },
    Arbiter: { wTiles: 2, hTiles: 2 },
    SCV: { wTiles: 1, hTiles: 1 },
};

/** Width of an addon in tiles (Comsat / Machine Shop / Control Tower). */
const ADDON_WIDTH_TILES = 2;

const RESOURCE_BUILDING_SCTYPES = new Set( [
    "Refinery",
    "Extractor",
    "Assimilator",
] );

const FLYING_SCTYPES = new Set( [
    "Wraith",
    "Dropship",
    "ScienceVessel",
    "Battlecruiser",
    "Valkyrie",
    "NuclearMissile",
    "Overlord",
    "Overseer",
    "Mutalisk",
    "Guardian",
    "Scourge",
    "Shuttle",
    "Observer",
    "Carrier",
    "Arbiter",
] );

interface ZoneDef {
    /** Inner radius in tiles (inclusive). */
    rMinTiles: number;
    /** Outer radius in tiles (exclusive). */
    rMaxTiles: number;
    /** Minimum tile spacing between any two units in this zone. */
    minSpacingTiles: number;
    role: LayoutRole;
    /** Hermes 2026-04 Terran human-tidy pass — chosen placement style. */
    placement?: PlaceStrategy;
    /**
     * For tidy-arc / wall-row / production-strip: the ring radius in
     * tiles (defaults to (rMin+rMax)/2). Lets us pin "supplies sit at
     * exactly tile 14" while still keeping the legacy band metadata
     * for free-poisson collision math.
     */
    radiusTiles?: number;
}

/**
 * Per-scType zone definitions. Picked so visually:
 *   - Command Center anchors the heart.
 *   - Production buildings (Barracks) sit in a tidy row south of the CC,
 *     each with its mandatory 2-tile addon gap reserved on the right —
 *     mimics how a human player builds a "rax line".
 *   - Supply Depots form a tight wall north (back) of the CC — the
 *     classic 3-tile-spaced supply wall.
 *   - Tech buildings (Engineering Bay / Academy stand-ins) ring the base
 *     evenly at one fixed radius.
 *   - Bunkers form a visible defensive arc on the south/front.
 *   - SCVs snap to actual mineral patches (existing).
 *   - Marines patrol the perimeter (Poisson + waypoint loop).
 *
 * Hermes 2026-04 Terran human-tidy pass: each zone now also carries a
 * `placement` strategy and (optionally) a fixed `radiusTiles`. The legacy
 * `rMin/rMax/minSpacing` triple is preserved so free-poisson zones (Marines,
 * unknowns) keep their original organic behavior.
 *
 * If you change these, run `node scripts/diag-hermes-bridge-tour.mjs` and
 * eyeball the screenshots — the *vibe* matters more than the math.
 */
const ZONE_BY_SCTYPE: Record< string, ZoneDef > = {
    CommandCenter: {
        rMinTiles: 0,
        rMaxTiles: 1,
        minSpacingTiles: 0,
        role: "core",
        placement: "core",
    },
    /**
     * Gateway and Zealot are remapped at the bridge level to Terran units
     * (Barracks / Marine) so the base is a coherent Terran composition.
     * We keep them as named zones so callers that still send the legacy
     * Protoss scTypes get sensible placement.
     */
    Gateway: {
        rMinTiles: 7,
        rMaxTiles: 11,
        minSpacingTiles: 2,
        role: "subagent-cluster",
        placement: "production-strip",
        radiusTiles: 8,
    },
    Refinery: {
        rMinTiles: 4,
        rMaxTiles: 8,
        minSpacingTiles: 2,
        role: "subagent-cluster",
        placement: "resource-building",
    },
    Zealot: {
        rMinTiles: 14,
        rMaxTiles: 19,
        minSpacingTiles: 1.4,
        role: "front-patrol",
        placement: "free-poisson",
    },
    TechBuilding: {
        rMinTiles: 7,
        rMaxTiles: 13,
        minSpacingTiles: 2.2,
        role: "tech-ring",
        placement: "tidy-arc",
        radiusTiles: 10,
    },
    SupplyDepot: {
        rMinTiles: 13,
        rMaxTiles: 17,
        minSpacingTiles: 2.2,
        role: "supply-back",
        placement: "wall-row",
        radiusTiles: 14,
    },
    Marine: {
        rMinTiles: 14,
        rMaxTiles: 19,
        minSpacingTiles: 1.4,
        role: "front-patrol",
        placement: "free-poisson",
    },
    Firebat: {
        rMinTiles: 15,
        rMaxTiles: 20,
        minSpacingTiles: 1.5,
        role: "front-patrol",
        placement: "free-poisson",
    },
    Ghost: {
        rMinTiles: 13,
        rMaxTiles: 18,
        minSpacingTiles: 1.6,
        role: "front-patrol",
        placement: "free-poisson",
    },
    Dropship: {
        rMinTiles: 17,
        rMaxTiles: 24,
        minSpacingTiles: 2.4,
        role: "wanderer",
        placement: "free-poisson",
    },
    ScienceVessel: {
        rMinTiles: 15,
        rMaxTiles: 22,
        minSpacingTiles: 2.4,
        role: "wanderer",
        placement: "free-poisson",
    },
    Barracks: {
        rMinTiles: 8,
        rMaxTiles: 12,
        minSpacingTiles: 2.5,
        role: "tech-ring",
        placement: "production-strip",
        radiusTiles: 9,
    },
    Factory: {
        rMinTiles: 9,
        rMaxTiles: 13,
        minSpacingTiles: 2.5,
        role: "tech-ring",
        placement: "production-strip",
        radiusTiles: 11,
    },
    Starport: {
        rMinTiles: 10,
        rMaxTiles: 14,
        minSpacingTiles: 2.5,
        role: "tech-ring",
        placement: "production-strip",
        radiusTiles: 12,
    },
    Academy: {
        rMinTiles: 7,
        rMaxTiles: 12,
        minSpacingTiles: 2,
        role: "tech-ring",
        placement: "tidy-arc",
        radiusTiles: 9,
    },
    EngineeringBay: {
        rMinTiles: 7,
        rMaxTiles: 13,
        minSpacingTiles: 2.2,
        role: "tech-ring",
        placement: "tidy-arc",
        radiusTiles: 10,
    },
    Armory: {
        rMinTiles: 8,
        rMaxTiles: 14,
        minSpacingTiles: 2.2,
        role: "tech-ring",
        placement: "tidy-arc",
        radiusTiles: 11,
    },
    ScienceFacility: {
        rMinTiles: 11,
        rMaxTiles: 15,
        minSpacingTiles: 2.5,
        role: "tech-ring",
        placement: "production-strip",
        radiusTiles: 13,
    },
    ComsatStation: {
        rMinTiles: 8,
        rMaxTiles: 12,
        minSpacingTiles: 2,
        role: "tech-ring",
        placement: "tidy-arc",
        radiusTiles: 9,
    },
    NuclearSilo: {
        rMinTiles: 8,
        rMaxTiles: 12,
        minSpacingTiles: 2,
        role: "tech-ring",
        placement: "tidy-arc",
        radiusTiles: 9,
    },
    ControlTower: {
        rMinTiles: 10,
        rMaxTiles: 14,
        minSpacingTiles: 2,
        role: "tech-ring",
        placement: "tidy-arc",
        radiusTiles: 11,
    },
    MachineShop: {
        rMinTiles: 10,
        rMaxTiles: 14,
        minSpacingTiles: 2,
        role: "tech-ring",
        placement: "tidy-arc",
        radiusTiles: 11,
    },
    CovertOps: {
        rMinTiles: 11,
        rMaxTiles: 15,
        minSpacingTiles: 2,
        role: "tech-ring",
        placement: "tidy-arc",
        radiusTiles: 12,
    },
    PhysicsLab: {
        rMinTiles: 11,
        rMaxTiles: 15,
        minSpacingTiles: 2,
        role: "tech-ring",
        placement: "tidy-arc",
        radiusTiles: 12,
    },
    Bunker: {
        rMinTiles: 18,
        rMaxTiles: 24,
        minSpacingTiles: 2.5,
        role: "defense-perimeter",
        placement: "tidy-arc",
        radiusTiles: 21,
    },
    MissileTurret: {
        rMinTiles: 17,
        rMaxTiles: 23,
        minSpacingTiles: 2,
        role: "defense-perimeter",
        placement: "tidy-arc",
        radiusTiles: 19,
    },
    SCV: {
        rMinTiles: 2,
        rMaxTiles: 6,
        minSpacingTiles: 1.0,
        role: "worker-near-resource",
        placement: "worker",
    },
    /** Catch-all so unknown scTypes still get a sane spot. */
    _default: {
        rMinTiles: 8,
        rMaxTiles: 14,
        minSpacingTiles: 2,
        role: "wanderer",
        placement: "free-poisson",
    },
};

Object.assign( ZONE_BY_SCTYPE, {
    Vulture: ZONE_BY_SCTYPE.Marine,
    Goliath: ZONE_BY_SCTYPE.Firebat,
    SiegeTank: ZONE_BY_SCTYPE.Firebat,
    SiegeTankSiege: ZONE_BY_SCTYPE.Bunker,
    SpiderMine: ZONE_BY_SCTYPE.Bunker,
    Wraith: ZONE_BY_SCTYPE.Dropship,
    Battlecruiser: ZONE_BY_SCTYPE.ScienceVessel,
    Valkyrie: ZONE_BY_SCTYPE.ScienceVessel,
    NuclearMissile: ZONE_BY_SCTYPE.Dropship,
    Hatchery: ZONE_BY_SCTYPE.CommandCenter,
    Lair: ZONE_BY_SCTYPE.CommandCenter,
    Hive: ZONE_BY_SCTYPE.CommandCenter,
    Nexus: ZONE_BY_SCTYPE.CommandCenter,
    Extractor: ZONE_BY_SCTYPE.Refinery,
    Assimilator: ZONE_BY_SCTYPE.Refinery,
    Drone: ZONE_BY_SCTYPE.SCV,
    Probe: ZONE_BY_SCTYPE.SCV,
    Overlord: ZONE_BY_SCTYPE.SupplyDepot,
    Overseer: ZONE_BY_SCTYPE.ScienceVessel,
    Pylon: ZONE_BY_SCTYPE.SupplyDepot,
    Zergling: ZONE_BY_SCTYPE.Marine,
    Hydralisk: ZONE_BY_SCTYPE.Firebat,
    Lurker: ZONE_BY_SCTYPE.Ghost,
    Mutalisk: ZONE_BY_SCTYPE.Dropship,
    Guardian: ZONE_BY_SCTYPE.ScienceVessel,
    Defiler: ZONE_BY_SCTYPE.Ghost,
    Ultralisk: ZONE_BY_SCTYPE.Firebat,
    Scourge: ZONE_BY_SCTYPE.Dropship,
    SpawningPool: ZONE_BY_SCTYPE.Barracks,
    HydraliskDen: ZONE_BY_SCTYPE.Academy,
    EvolutionChamber: ZONE_BY_SCTYPE.EngineeringBay,
    Spire: ZONE_BY_SCTYPE.Starport,
    GreaterSpire: ZONE_BY_SCTYPE.ControlTower,
    QueensNest: ZONE_BY_SCTYPE.MachineShop,
    DefilerMound: ZONE_BY_SCTYPE.ScienceFacility,
    UltraliskCavern: ZONE_BY_SCTYPE.Armory,
    NydusCanal: ZONE_BY_SCTYPE.ControlTower,
    SporeColony: ZONE_BY_SCTYPE.MissileTurret,
    SunkenColony: ZONE_BY_SCTYPE.Bunker,
    Dragoon: ZONE_BY_SCTYPE.Firebat,
    HighTemplar: ZONE_BY_SCTYPE.Ghost,
    DarkTemplar: ZONE_BY_SCTYPE.Ghost,
    Archon: ZONE_BY_SCTYPE.Firebat,
    DarkArchon: ZONE_BY_SCTYPE.Ghost,
    Shuttle: ZONE_BY_SCTYPE.Dropship,
    Reaver: ZONE_BY_SCTYPE.Firebat,
    Observer: ZONE_BY_SCTYPE.ScienceVessel,
    Carrier: ZONE_BY_SCTYPE.ScienceVessel,
    Arbiter: ZONE_BY_SCTYPE.ScienceVessel,
    RoboticsFacility: ZONE_BY_SCTYPE.Factory,
    RoboticsSupportBay: ZONE_BY_SCTYPE.MachineShop,
    Observatory: ZONE_BY_SCTYPE.ScienceFacility,
    TemplarArchives: ZONE_BY_SCTYPE.Academy,
    Forge: ZONE_BY_SCTYPE.EngineeringBay,
    CyberneticsCore: ZONE_BY_SCTYPE.Armory,
    Stargate: ZONE_BY_SCTYPE.Starport,
    FleetBeacon: ZONE_BY_SCTYPE.ControlTower,
    ArbiterTribunal: ZONE_BY_SCTYPE.PhysicsLab,
    PhotonCannon: ZONE_BY_SCTYPE.MissileTurret,
    ShieldBattery: ZONE_BY_SCTYPE.Bunker,
} );

/**
 * "Behind" quadrant for supply (in radians, measured from base center).
 * North is -PI/2 in screen-y-down pixel coords. We give supply a 120-deg
 * fan north of the base so it visually reads as "in the back".
 */
const SUPPLY_ARC = { center: -Math.PI / 2, halfWidth: Math.PI / 3 };

/**
 * "Front" quadrant for bunkers + patrolling marines. South arc, 180 deg.
 */
const DEFENSE_ARC = { center: Math.PI / 2, halfWidth: Math.PI };
const PATROL_BASE_RADIUS_TILES = 24;
const PATROL_LANE_GAP_TILES = 4;
const PATROL_UNITS_PER_LANE = 18;
const PATROL_MIN_SEGMENT_RAD = 0.12;
const PATROL_MAX_SEGMENT_RAD = 0.38;
const STATIC_POST_EVERY_N_PATROLS = 4;

/**
 * Tiny seedable LCG — Numerical Recipes constants. Enough randomness for
 * Poisson disk; we don't need crypto-quality.
 */
const makeRng = ( seed: number ) => {
    let s = seed >>> 0 || 1;
    return () => {
        s = ( s * 1664525 + 1013904223 ) >>> 0;
        return s / 0xffffffff;
    };
};

const TILE_PX = 32;
const BUILDING_EDGE_BUFFER_TILES = 2;
const BUILDING_EXTRA_GAP_TILES = 1;
const GROUND_UNIT_EDGE_BUFFER_TILES = 3;
const NON_WORKER_RESOURCE_BUFFER_TILES = 8;
const UNIT_BUILDING_BUFFER_TILES = 5;
const UNIT_CORE_BUFFER_TILES = 10;
const RESOURCE_CORE_CORRIDOR_BUFFER_TILES = 4;
const RESOURCE_CORE_CORRIDOR_MAX_TILES = 30;

/**
 * Sample one point in an annulus around (cx, cy) constrained to an angular
 * arc. Returns null after `maxTries` rejections — caller should fall back
 * to a deterministic spiral so we never lose entities to bad luck.
 */
const tryPoissonInAnnulus = (
    rng: () => number,
    cx: number,
    cy: number,
    rMinPx: number,
    rMaxPx: number,
    arc: { center: number; halfWidth: number } | null,
    minSpacingPx: number,
    placed: { px: number; py: number }[],
    bounds: { minPx: number; maxPx: number; minPy: number; maxPy: number },
    maxTries = 60,
    validate?: ( px: number, py: number ) => boolean
): { px: number; py: number } | null => {
    const minSq = minSpacingPx * minSpacingPx;
    for ( let t = 0; t < maxTries; t++ ) {
        const angle = arc
            ? arc.center + ( rng() * 2 - 1 ) * arc.halfWidth
            : rng() * Math.PI * 2;
        // sqrt distribution -> uniform inside the annulus
        const r = Math.sqrt(
            rng() * ( rMaxPx * rMaxPx - rMinPx * rMinPx ) + rMinPx * rMinPx
        );
        const px = Math.round( cx + Math.cos( angle ) * r );
        const py = Math.round( cy + Math.sin( angle ) * r );
        if ( px < bounds.minPx || px > bounds.maxPx ) continue;
        if ( py < bounds.minPy || py > bounds.maxPy ) continue;
        let ok = true;
        for ( const p of placed ) {
            const dx = px - p.px;
            const dy = py - p.py;
            if ( dx * dx + dy * dy < minSq ) {
                ok = false;
                break;
            }
        }
        if ( !ok ) continue;
        if ( validate && !validate( px, py ) ) continue;
        return { px, py };
    }
    return null;
};

/**
 * Deterministic spiral fallback when Poisson rejects too many candidates
 * (typically because the requested band is too small for the entity count).
 */
const spiralFallback = (
    cx: number,
    cy: number,
    rMinPx: number,
    rMaxPx: number,
    arc: { center: number; halfWidth: number } | null,
    placed: { px: number; py: number }[],
    bounds: { minPx: number; maxPx: number; minPy: number; maxPy: number },
    indexInZone: number,
    validate?: ( px: number, py: number ) => boolean
): { px: number; py: number } => {
    const golden = Math.PI * ( 3 - Math.sqrt( 5 ) ); // golden-angle increment
    const minSq = TILE_PX * TILE_PX;
    let last = { px: cx, py: cy };
    for ( let attempt = 0; attempt < 256; attempt++ ) {
        const idx = indexInZone + attempt;
        const angle = arc
            ? arc.center + Math.sin( idx * golden ) * arc.halfWidth
            : idx * golden;
        const r = rMinPx + ( ( idx * 7 ) % Math.max( 1, rMaxPx - rMinPx ) );
        let px = Math.round( cx + Math.cos( angle ) * r );
        let py = Math.round( cy + Math.sin( angle ) * r );
        px = Math.max( bounds.minPx, Math.min( bounds.maxPx, px ) );
        py = Math.max( bounds.minPy, Math.min( bounds.maxPy, py ) );
        last = { px, py };
        if ( validate && !validate( px, py ) ) continue;
        if (
            placed.some( ( p ) => {
                const dx = p.px - px;
                const dy = p.py - py;
                return dx * dx + dy * dy < minSq;
            } )
        ) {
            continue;
        }
        return last;
    }
    return last;
};

const candidateSpiral = (
    cx: number,
    cy: number,
    rMinPx: number,
    rMaxPx: number,
    arc: { center: number; halfWidth: number } | null,
    bounds: { minPx: number; maxPx: number; minPy: number; maxPy: number },
    indexInZone: number,
    attempts = 384
): Array< { px: number; py: number } > => {
    const out: Array< { px: number; py: number } > = [];
    const seen = new Set< string >();
    const golden = Math.PI * ( 3 - Math.sqrt( 5 ) );
    for ( let attempt = 0; attempt < attempts; attempt++ ) {
        const idx = indexInZone + attempt;
        const angle = arc
            ? arc.center + Math.sin( idx * golden ) * arc.halfWidth
            : idx * golden;
        const r = rMinPx + ( ( idx * 7 ) % Math.max( 1, rMaxPx - rMinPx ) );
        const px = Math.max(
            bounds.minPx,
            Math.min( bounds.maxPx, Math.round( cx + Math.cos( angle ) * r ) )
        );
        const py = Math.max(
            bounds.minPy,
            Math.min( bounds.maxPy, Math.round( cy + Math.sin( angle ) * r ) )
        );
        const key = `${px},${py}`;
        if ( seen.has( key ) ) continue;
        seen.add( key );
        out.push( { px, py } );
    }
    return out;
};

/** Set of scTypes that are static buildings — used to gate the
 * `_can_place_building_at` engine check (units don't need it). */
const BUILDING_SCTYPES = new Set( [
    "CommandCenter",
    "Refinery",
    "Gateway",
    "TechBuilding",
    "SupplyDepot",
    "Barracks",
    "Factory",
    "Starport",
    "Academy",
    "EngineeringBay",
    "Armory",
    "ScienceFacility",
    "ComsatStation",
    "NuclearSilo",
    "ControlTower",
    "MachineShop",
    "CovertOps",
    "PhysicsLab",
    "Bunker",
    "MissileTurret",
    "Hatchery",
    "Lair",
    "Hive",
    "Extractor",
    "SpawningPool",
    "HydraliskDen",
    "EvolutionChamber",
    "Spire",
    "GreaterSpire",
    "QueensNest",
    "DefilerMound",
    "UltraliskCavern",
    "NydusCanal",
    "CreepColony",
    "SporeColony",
    "SunkenColony",
    "Nexus",
    "Pylon",
    "Assimilator",
    "RoboticsFacility",
    "RoboticsSupportBay",
    "Observatory",
    "TemplarArchives",
    "Forge",
    "CyberneticsCore",
    "Stargate",
    "FleetBeacon",
    "ArbiterTribunal",
    "PhotonCannon",
    "ShieldBattery",
] );

const isBuildingScType = ( scType: string ): boolean =>
    BUILDING_SCTYPES.has( scType );

const arcForRole = ( role: LayoutRole ): { center: number; halfWidth: number } | null => {
    switch ( role ) {
        case "supply-back":
            return SUPPLY_ARC;
        case "defense-perimeter":
        case "front-patrol":
            return DEFENSE_ARC;
        default:
            return null;
    }
};

/**
 * Pick the closest (still-unassigned) mineral patch for a worker so SCVs
 * cluster around the resources the map actually has — much more believable
 * than dropping them next to the CC at random.
 */
const nearestResource = (
    cx: number,
    cy: number,
    resources: ResourcePatch[],
    used: Set< number >,
    type?: ResourcePatch["type"]
): { res: ResourcePatch; idx: number } | null => {
    let best: { res: ResourcePatch; idx: number; d: number } | null = null;
    for ( let i = 0; i < resources.length; i++ ) {
        if ( used.has( i ) ) continue;
        const r = resources[i];
        if ( type && r.type !== type ) continue;
        const d = ( r.px - cx ) ** 2 + ( r.py - cy ) ** 2;
        if ( !best || d < best.d ) best = { res: r, idx: i, d };
    }
    return best ? { res: best.res, idx: best.idx } : null;
};

const resourcesByDistance = (
    cx: number,
    cy: number,
    resources: ResourcePatch[],
    type: ResourcePatch["type"]
): Array< { res: ResourcePatch; idx: number } > =>
    resources
        .map( ( res, idx ) => ( { res, idx } ) )
        .filter( ( p ) => p.res.type === type )
        .sort( ( a, b ) => {
            const ad = ( a.res.px - cx ) ** 2 + ( a.res.py - cy ) ** 2;
            const bd = ( b.res.px - cx ) ** 2 + ( b.res.py - cy ) ** 2;
            return ad - bd;
        } );

/**
 * Build the patrol waypoint loop for one front-line marine.
 * Four points evenly spaced around the perimeter, rotated by the marine's
 * own angle so different marines patrol different stretches of the line.
 */
const makePatrolLoop = (
    cx: number,
    cy: number,
    radiusPx: number,
    seedAngle: number,
    bounds: { minPx: number; maxPx: number; minPy: number; maxPy: number },
    laneIndex = 0,
    slotInLane = 0,
    slotsInLane = 1
): { px: number; py: number }[] => {
    const span = DEFENSE_ARC.halfWidth * 2;
    const laneSlots = Math.max( 1, slotsInLane );
    const slotCenter = DEFENSE_ARC.center -
        DEFENSE_ARC.halfWidth +
        ( ( slotInLane + 0.5 ) / laneSlots ) * span;
    const centerAngle = ( Number.isFinite( seedAngle ) ? ( seedAngle + slotCenter ) / 2 : slotCenter ) +
        laneIndex * 0.03;
    const segmentHalfWidth = Math.max(
        PATROL_MIN_SEGMENT_RAD,
        Math.min( PATROL_MAX_SEGMENT_RAD, ( span / laneSlots ) * 0.42 )
    );
    const laneRadiusPx = radiusPx;
    const innerRadiusPx = Math.max( TILE_PX, laneRadiusPx - TILE_PX );
    const outerRadiusPx = laneRadiusPx + TILE_PX;
    const pointAt = ( angle: number, radius: number ) => ( {
        px: Math.max( bounds.minPx, Math.min( bounds.maxPx, Math.round( cx + Math.cos( angle ) * radius ) ) ),
        py: Math.max( bounds.minPy, Math.min( bounds.maxPy, Math.round( cy + Math.sin( angle ) * radius ) ) ),
    } );
    return [
        pointAt( centerAngle - segmentHalfWidth, laneRadiusPx ),
        pointAt( centerAngle, outerRadiusPx ),
        pointAt( centerAngle + segmentHalfWidth, laneRadiusPx ),
        pointAt( centerAngle, innerRadiusPx ),
    ];
};

/**
 * Hermes 2026-04 Terran human-tidy pass — even angular distribution.
 *
 * Place `n` items on a single ring at radius `R` (px), with angles spread
 * uniformly across the arc `[arc.center - arc.halfWidth, arc.center +
 * arc.halfWidth]`. `null` arc = full circle (closes the loop without
 * doubling on the seam by using `n` divisions instead of `n-1`).
 *
 * Returns null per-slot if the candidate fails `validate` (e.g. unbuildable
 * terrain) so the caller can fall through to free-poisson on a per-slot
 * basis instead of giving up the whole zone.
 */
const tidyArcSlot = (
    cx: number,
    cy: number,
    rPx: number,
    arc: { center: number; halfWidth: number } | null,
    indexInZone: number,
    totalInZone: number,
    bounds: { minPx: number; maxPx: number; minPy: number; maxPy: number },
    validate?: ( px: number, py: number ) => boolean
): { px: number; py: number } | null => {
    let angle: number;
    if ( arc == null ) {
        angle = ( indexInZone / Math.max( 1, totalInZone ) ) * Math.PI * 2;
    } else if ( totalInZone <= 1 ) {
        angle = arc.center;
    } else {
        const span = arc.halfWidth * 2;
        angle = arc.center - arc.halfWidth + ( indexInZone / ( totalInZone - 1 ) ) * span;
    }
    const px = Math.max(
        bounds.minPx,
        Math.min( bounds.maxPx, Math.round( cx + Math.cos( angle ) * rPx ) )
    );
    const py = Math.max(
        bounds.minPy,
        Math.min( bounds.maxPy, Math.round( cy + Math.sin( angle ) * rPx ) )
    );
    if ( validate && !validate( px, py ) ) return null;
    return { px, py };
};

/**
 * Hermes 2026-04 Terran human-tidy pass — tight wall row.
 *
 * Place `n` items in a single horizontal row with `(footprintW + 1)`-tile
 * spacing — Terran's classic Supply-Depot wall packed flush enough that a
 * Zergling can't slip through. The row sits at `y = cy + sign * R*TILE`
 * where `sign` depends on the zone arc (negative for SUPPLY_ARC, positive
 * for DEFENSE_ARC, +1 by default).
 *
 * If the row would exceed the map bounds, items wrap to a second row one
 * footprint-height further out so we never lose entities on tiny maps.
 */
const wallRowSlot = (
    cx: number,
    cy: number,
    rPx: number,
    arc: { center: number; halfWidth: number } | null,
    footprint: BuildingFootprint,
    indexInZone: number,
    totalInZone: number,
    bounds: { minPx: number; maxPx: number; minPy: number; maxPy: number }
): { px: number; py: number } => {
    const sign = arc && Math.sin( arc.center ) < 0 ? -1 : 1;
    const slotW = ( footprint.wTiles + 1 ) * TILE_PX;
    const maxRowItems = Math.max(
        1,
        Math.floor( ( bounds.maxPx - bounds.minPx ) / slotW ) - 1
    );
    const itemsPerRow = Math.min( totalInZone, maxRowItems );
    const rowIdx = Math.floor( indexInZone / itemsPerRow );
    const colIdx = indexInZone % itemsPerRow;
    const offsetX = ( colIdx - ( itemsPerRow - 1 ) / 2 ) * slotW;
    const rowOffset = rowIdx * ( footprint.hTiles + 1 ) * TILE_PX * sign;
    const px = Math.max(
        bounds.minPx,
        Math.min( bounds.maxPx, Math.round( cx + offsetX ) )
    );
    const py = Math.max(
        bounds.minPy,
        Math.min( bounds.maxPy, Math.round( cy + sign * rPx + rowOffset ) )
    );
    return { px, py };
};

/**
 * Hermes 2026-04 Terran human-tidy pass — production strip.
 *
 * Place a row of production buildings (Barracks / Factory / Starport)
 * each with the mandatory 2-tile addon gap reserved on the right. Slot
 * stride = (footprintW + addonW + 1) * TILE so two consecutive Barracks
 * never crash into each other's Comsat slot.
 */
const productionStripSlot = (
    cx: number,
    cy: number,
    rPx: number,
    arc: { center: number; halfWidth: number } | null,
    footprint: BuildingFootprint,
    indexInZone: number,
    totalInZone: number,
    bounds: { minPx: number; maxPx: number; minPy: number; maxPy: number }
): { px: number; py: number } => {
    const sign = arc && Math.sin( arc.center ) < 0 ? -1 : 1;
    const addonW = footprint.addonRight ? ADDON_WIDTH_TILES : 0;
    const slotW = ( footprint.wTiles + addonW + 1 ) * TILE_PX;
    const maxRowItems = Math.max(
        1,
        Math.floor( ( bounds.maxPx - bounds.minPx ) / slotW ) - 1
    );
    const itemsPerRow = Math.min( totalInZone, maxRowItems );
    const rowIdx = Math.floor( indexInZone / itemsPerRow );
    const colIdx = indexInZone % itemsPerRow;
    const offsetX = ( colIdx - ( itemsPerRow - 1 ) / 2 ) * slotW;
    const rowOffset = rowIdx * ( footprint.hTiles + 1 ) * TILE_PX * sign;
    const px = Math.max(
        bounds.minPx,
        Math.min( bounds.maxPx, Math.round( cx + offsetX ) )
    );
    const py = Math.max(
        bounds.minPy,
        Math.min( bounds.maxPy, Math.round( cy + sign * rPx + rowOffset ) )
    );
    return { px, py };
};

/**
 * Wraith orbit waypoints around the tech ring (4-point ring at the wraith's
 * own radius from the center).
 */
const makeOrbitLoop = (
    cx: number,
    cy: number,
    px: number,
    py: number,
    bounds: { minPx: number; maxPx: number; minPy: number; maxPy: number }
): { px: number; py: number }[] => {
    const dx = px - cx;
    const dy = py - cy;
    const r = Math.sqrt( dx * dx + dy * dy );
    const a0 = Math.atan2( dy, dx );
    const out: { px: number; py: number }[] = [];
    for ( let i = 0; i < 4; i++ ) {
        const a = a0 + ( i * Math.PI ) / 2;
        const wp = {
            px: Math.max( bounds.minPx, Math.min( bounds.maxPx, Math.round( cx + Math.cos( a ) * r ) ) ),
            py: Math.max( bounds.minPy, Math.min( bounds.maxPy, Math.round( cy + Math.sin( a ) * r ) ) ),
        };
        out.push( wp );
    }
    return out;
};

/**
 * Compute the fully laid-out base for a snapshot of Hermes entities.
 *
 * Stable: same entities + same context => same Map<id, PlacementResult>.
 */
export const computeBaseLayout = (
    entities: HermesEntityShape[],
    ctx: LayoutContext
): Map< string, PlacementResult > => {
    const out = new Map< string, PlacementResult >();
    const cx = ctx.centerPx ?? ( ctx.mapWidthTiles * TILE_PX ) / 2;
    const cy = ctx.centerPy ?? ( ctx.mapHeightTiles * TILE_PX ) / 2;
    const bounds = {
        minPx: TILE_PX,
        maxPx: ctx.mapWidthTiles * TILE_PX - TILE_PX,
        minPy: TILE_PX,
        maxPy: ctx.mapHeightTiles * TILE_PX - TILE_PX,
    };
    const rng = makeRng( ctx.seed ?? 0xc0ffee );
    const resources = ctx.resources ?? [];
    const usedResources = new Set< number >();
    const usedRefineryResources = new Set< number >();
    const hasGas = resources.some( ( r ) => r.type === "gas" );

    // Group by scType so we can do per-zone Poisson sampling.
    const byType = new Map< string, HermesEntityShape[] >();
    for ( const e of entities ) {
        if ( !e || typeof e.id !== "string" ) continue;
        const arr = byType.get( e.scType ) ?? [];
        arr.push( e );
        byType.set( e.scType, arr );
    }

    // Order matters: place core first (anchor), then close-in zones, then
    // outer zones. This way later sampling can see the inner placements
    // and avoid them.
    const PLACEMENT_ORDER = [
        "CommandCenter",
        "Hatchery",
        "Lair",
        "Hive",
        "Nexus",
        "Refinery",
        "Extractor",
        "Assimilator",
        "Zealot",
        "Zergling",
        "Gateway",
        "SpawningPool",
        "SCV",
        "Drone",
        "Probe",
        "TechBuilding",
        "EngineeringBay",
        "EvolutionChamber",
        "Forge",
        "Academy",
        "HydraliskDen",
        "TemplarArchives",
        "Barracks",
        "Factory",
        "RoboticsFacility",
        "Starport",
        "Spire",
        "Stargate",
        "Armory",
        "UltraliskCavern",
        "CyberneticsCore",
        "ScienceFacility",
        "DefilerMound",
        "Observatory",
        "ComsatStation",
        "NuclearSilo",
        "ControlTower",
        "NydusCanal",
        "FleetBeacon",
        "MachineShop",
        "QueensNest",
        "RoboticsSupportBay",
        "CovertOps",
        "PhysicsLab",
        "GreaterSpire",
        "ArbiterTribunal",
        "SupplyDepot",
        "Overlord",
        "Overseer",
        "Pylon",
        "Marine",
        "Hydralisk",
        "Dragoon",
        "Firebat",
        "Lurker",
        "Reaver",
        "Ultralisk",
        "Ghost",
        "Defiler",
        "HighTemplar",
        "DarkTemplar",
        "Archon",
        "DarkArchon",
        "Dropship",
        "Mutalisk",
        "Shuttle",
        "Scourge",
        "ScienceVessel",
        "Guardian",
        "Observer",
        "Carrier",
        "Arbiter",
        "Bunker",
        "SunkenColony",
        "ShieldBattery",
        "MissileTurret",
        "SporeColony",
        "PhotonCannon",
    ];
    const seenTypes = new Set( PLACEMENT_ORDER );
    const remainingTypes = Array.from( byType.keys() ).filter( ( t ) => !seenTypes.has( t ) );
    const placementOrder = [ ...PLACEMENT_ORDER, ...remainingTypes ];
    const frontPatrolTotal = Array.from( byType.entries() ).reduce(
        ( total, [ scType, list ] ) => {
            const zone = ZONE_BY_SCTYPE[scType] ?? ZONE_BY_SCTYPE._default;
            return zone.role === "front-patrol" ? total + list.length : total;
        },
        0
    );
    let frontPatrolCursor = 0;

    /** Global list of placed footprints for cross-zone spacing/collision. */
    const placedAll: Array< { px: number; py: number; footprint: BuildingFootprint } > = [];
    const placedBuildings: Array< { px: number; py: number; footprint: BuildingFootprint; isCore: boolean } > = [];
    let preferredComponentId: number | null = null;

    const tileRectFor = (
        px: number,
        py: number,
        footprint: BuildingFootprint,
        paddingTiles = 0
    ) => {
        const cTileX = Math.floor( px / TILE_PX );
        const cTileY = Math.floor( py / TILE_PX );
        const left = cTileX - Math.floor( footprint.wTiles / 2 ) - paddingTiles;
        const top = cTileY - Math.floor( footprint.hTiles / 2 ) - paddingTiles;
        return {
            left,
            right: left + footprint.wTiles - 1 + paddingTiles * 2,
            top,
            bottom: top + footprint.hTiles - 1 + paddingTiles * 2,
        };
    };
    const rectsOverlap = (
        a: ReturnType< typeof tileRectFor >,
        b: ReturnType< typeof tileRectFor >
    ): boolean =>
        a.left <= b.right &&
        a.right >= b.left &&
        a.top <= b.bottom &&
        a.bottom >= b.top;
    const resourceBlocksBuilding = (
        scType: string,
        px: number,
        py: number,
        footprint: BuildingFootprint
    ): boolean => {
        const rect = tileRectFor( px, py, footprint, 1 );
        for ( const resource of resources ) {
            if (
                RESOURCE_BUILDING_SCTYPES.has( scType ) &&
                resource.type === "gas"
            ) {
                continue;
            }
            const resourceTileX = Math.floor( resource.px / TILE_PX );
            const resourceTileY = Math.floor( resource.py / TILE_PX );
            if (
                resourceTileX >= rect.left &&
                resourceTileX <= rect.right &&
                resourceTileY >= rect.top &&
                resourceTileY <= rect.bottom
            ) {
                return true;
            }
        }
        return false;
    };
    const distancePointToSegment = (
        px: number,
        py: number,
        ax: number,
        ay: number,
        bx: number,
        by: number
    ): number => {
        const dx = bx - ax;
        const dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        if ( lenSq <= 1 ) return Math.hypot( px - ax, py - ay );
        const t = Math.max( 0, Math.min( 1, ( ( px - ax ) * dx + ( py - ay ) * dy ) / lenSq ) );
        return Math.hypot( px - ( ax + t * dx ), py - ( ay + t * dy ) );
    };
    const buildingBlocksResourceCorridor = (
        scType: string,
        px: number,
        py: number,
        footprint: BuildingFootprint
    ): boolean => {
        if ( RESOURCE_BUILDING_SCTYPES.has( scType ) ) return false;
        if ( scType === "CommandCenter" || scType === "Hatchery" || scType === "Lair" || scType === "Hive" || scType === "Nexus" ) {
            return false;
        }
        const buildingRadiusPx =
            Math.hypot( footprint.wTiles, footprint.hTiles ) * TILE_PX * 0.5;
        const corridorBufferPx =
            RESOURCE_CORE_CORRIDOR_BUFFER_TILES * TILE_PX + buildingRadiusPx;
        const maxCorridorResourceDistancePx = RESOURCE_CORE_CORRIDOR_MAX_TILES * TILE_PX;
        return resources.some( ( resource ) => {
            const resourceDistance = Math.hypot( resource.px - cx, resource.py - cy );
            if ( resourceDistance < 6 * TILE_PX ) return false;
            if ( resourceDistance > maxCorridorResourceDistancePx ) return false;
            return distancePointToSegment( px, py, cx, cy, resource.px, resource.py ) < corridorBufferPx;
        } );
    };
    const buildingOverlapsPlaced = (
        px: number,
        py: number,
        footprint: BuildingFootprint,
        paddingTiles = 0
    ): boolean => {
        const rect = tileRectFor( px, py, footprint, paddingTiles );
        return placedAll.some( ( placed ) =>
            rectsOverlap( rect, tileRectFor( placed.px, placed.py, placed.footprint ) )
        );
    };
    const nonWorkerNearResource = ( px: number, py: number ): boolean => {
        const bufferPx = NON_WORKER_RESOURCE_BUFFER_TILES * TILE_PX;
        return resources.some( ( resource ) =>
            Math.hypot( resource.px - px, resource.py - py ) < bufferPx
        );
    };
    const nonWorkerWaypointsNearResource = ( waypoints?: { px: number; py: number }[] ): boolean =>
        !!waypoints?.some( ( waypoint ) => nonWorkerNearResource( waypoint.px, waypoint.py ) );
    const nonWorkerTooCloseToBuildings = (
        px: number,
        py: number,
        role: LayoutRole
    ): boolean => {
        if ( role === "worker-near-resource" ) return false;
        return placedBuildings.some( ( building ) => {
            const minTiles = building.isCore
                ? UNIT_CORE_BUFFER_TILES
                : UNIT_BUILDING_BUFFER_TILES;
            const footprintRadiusPx =
                Math.hypot( building.footprint.wTiles, building.footprint.hTiles ) * TILE_PX * 0.5;
            const minDistancePx = minTiles * TILE_PX + footprintRadiusPx;
            return Math.hypot( building.px - px, building.py - py ) < minDistancePx;
        } );
    };
    const nonWorkerWaypointsTooCloseToBuildings = (
        waypoints: { px: number; py: number }[] | undefined,
        role: LayoutRole
    ): boolean =>
        !!waypoints?.some( ( waypoint ) =>
            nonWorkerTooCloseToBuildings( waypoint.px, waypoint.py, role )
        );
    const groundWaypointOk = (
        scType: string,
        waypoint: { px: number; py: number },
        analyze?: ( px: number, py: number ) => {
            ok: boolean;
            componentId: number | null;
            edgeClearanceTiles: number;
        }
    ): boolean => {
        if ( FLYING_SCTYPES.has( scType ) ) return true;
        const analysis = analyze?.( waypoint.px, waypoint.py );
        if ( !analysis ) return true;
        if ( !analysis.ok ) return false;
        if (
            preferredComponentId != null &&
            analysis.componentId != null &&
            analysis.componentId !== preferredComponentId
        ) {
            return false;
        }
        return analysis.edgeClearanceTiles >= GROUND_UNIT_EDGE_BUFFER_TILES;
    };
    const groundWaypointsOk = (
        scType: string,
        waypoints?: { px: number; py: number }[],
        analyze?: ( px: number, py: number ) => {
            ok: boolean;
            componentId: number | null;
            edgeClearanceTiles: number;
        }
    ): boolean =>
        !waypoints || waypoints.every( ( waypoint ) => groundWaypointOk( scType, waypoint, analyze ) );
    const rememberPlaced = (
        px: number,
        py: number,
        footprint: BuildingFootprint
    ) => {
        placedAll.push( { px, py, footprint } );
    };

    for ( const scType of placementOrder ) {
        const list = byType.get( scType );
        if ( !list || list.length === 0 ) continue;
        const zone = ZONE_BY_SCTYPE[scType] ?? ZONE_BY_SCTYPE._default;
        const arc = arcForRole( zone.role );

        // Hermes 2026-04 Terran human-tidy pass: the chosen ring radius
        // (defaults to band midpoint) used by tidy-arc / wall-row /
        // production-strip. Free-poisson zones still use the rMin..rMax
        // band for sampling.
        const ringRadiusPx =
            ( zone.radiusTiles ?? ( zone.rMinTiles + zone.rMaxTiles ) / 2 ) * TILE_PX;
        const footprint =
            FOOTPRINT_BY_SCTYPE[scType] ?? FOOTPRINT_BY_SCTYPE.Marine;
        const strategy: PlaceStrategy = zone.placement ?? "free-poisson";

        // Hermes 2026-04 deeper rebuild: optionally consult the engine's
        // can_place_building_at to reject candidates on unbuildable
        // terrain. Only for building-shaped scTypes; units skip the check.
        let validate: ( ( px: number, py: number ) => boolean ) | undefined;
        let analyze: ( ( px: number, py: number ) => {
            ok: boolean;
            componentId: number | null;
            edgeClearanceTiles: number;
        } ) | undefined;
        if (
            ctx.validatePlacement &&
            ctx.scTypeToUnitTypeId &&
            isBuildingScType( scType )
        ) {
            const utid = ctx.scTypeToUnitTypeId[scType];
            if ( typeof utid === "number" && utid >= 0 ) {
                validate = ( px, py ) =>
                    ctx.validatePlacement!( {
                        scType,
                        unitTypeId: utid,
                        px,
                        py,
                    } );
            }
        }
        if (
            ctx.analyzePlacement &&
            ctx.scTypeToUnitTypeId &&
            !FLYING_SCTYPES.has( scType )
        ) {
            const utid = ctx.scTypeToUnitTypeId[scType];
            if ( typeof utid === "number" && utid >= 0 ) {
                analyze = ( px, py ) =>
                    ctx.analyzePlacement!( {
                        scType,
                        unitTypeId: utid,
                        px,
                        py,
                    } );
            }
        }
        const validateCandidate = ( px: number, py: number ): boolean => {
            if ( validate && !validate( px, py ) ) return false;
            const analysis = analyze?.( px, py );
            if (
                !isBuildingScType( scType ) &&
                nonWorkerTooCloseToBuildings( px, py, zone.role )
            ) {
                return false;
            }
            if (
                !isBuildingScType( scType ) &&
                !FLYING_SCTYPES.has( scType ) &&
                zone.role !== "worker-near-resource" &&
                nonWorkerNearResource( px, py )
            ) {
                return false;
            }
            if ( !isBuildingScType( scType ) ) {
                if ( !analysis ) return true;
                if ( !analysis.ok ) return false;
                if (
                    preferredComponentId != null &&
                    analysis.componentId != null &&
                    analysis.componentId !== preferredComponentId
                ) {
                    return false;
                }
                return analysis.edgeClearanceTiles >= GROUND_UNIT_EDGE_BUFFER_TILES;
            }
            if ( analysis ) {
                if ( !analysis.ok ) return false;
                if (
                    !RESOURCE_BUILDING_SCTYPES.has( scType ) &&
                    analysis.edgeClearanceTiles < BUILDING_EDGE_BUFFER_TILES
                ) {
                    return false;
                }
            }
            if ( resourceBlocksBuilding( scType, px, py, footprint ) ) return false;
            if ( buildingBlocksResourceCorridor( scType, px, py, footprint ) ) return false;
            return !buildingOverlapsPlaced(
                px,
                py,
                footprint,
                isBuildingScType( scType ) ? BUILDING_EXTRA_GAP_TILES : 0
            );
        };
        const validateCandidateRelaxed = ( px: number, py: number ): boolean => {
            if ( validate && !validate( px, py ) ) return false;
            const analysis = analyze?.( px, py );
            if ( !isBuildingScType( scType ) ) {
                if ( !analysis ) return true;
                if ( !analysis.ok ) return false;
                if (
                    !FLYING_SCTYPES.has( scType ) &&
                    preferredComponentId != null &&
                    analysis.componentId != null &&
                    analysis.componentId !== preferredComponentId
                ) {
                    return false;
                }
                return FLYING_SCTYPES.has( scType ) ||
                    analysis.edgeClearanceTiles >= GROUND_UNIT_EDGE_BUFFER_TILES;
            }
            if ( analysis ) {
                if ( !analysis.ok ) return false;
                if (
                    !RESOURCE_BUILDING_SCTYPES.has( scType ) &&
                    analysis.edgeClearanceTiles < BUILDING_EDGE_BUFFER_TILES
                ) {
                    return false;
                }
            }
            if ( resourceBlocksBuilding( scType, px, py, footprint ) ) return false;
            return !buildingOverlapsPlaced( px, py, footprint, 0 );
        };
        const scoreCandidate = ( px: number, py: number ): number => {
            const analysis = analyze?.( px, py );
            const componentBonus =
                analysis?.componentId != null &&
                preferredComponentId != null &&
                analysis.componentId === preferredComponentId
                    ? 1_000_000
                    : preferredComponentId == null
                        ? 100_000
                        : 0;
            const edgeBonus = ( analysis?.edgeClearanceTiles ?? BUILDING_EDGE_BUFFER_TILES ) * 2_500;
            const distanceToAnchor = Math.hypot( px - cx, py - cy );
            const nearestPlaced = placedAll.length
                ? Math.min(
                    ...placedAll.map( ( placed ) =>
                        Math.hypot( placed.px - px, placed.py - py )
                    )
                )
                : 0;
            const desiredGap = Math.max(
                3 * TILE_PX,
                ( footprint.wTiles + footprint.hTiles ) * TILE_PX * 0.65
            );
            const gapBonus = Math.min( nearestPlaced, desiredGap ) * 12;
            return componentBonus + edgeBonus + gapBonus - distanceToAnchor;
        };
        const chooseBestCandidate = (
            desired: { px: number; py: number } | null,
            rMinPx: number,
            rMaxPx: number,
            indexInZone: number
        ): { px: number; py: number } => {
            const pickFrom = ( candidates: Array< { px: number; py: number } > ) => {
                let best: { px: number; py: number; score: number } | null = null;
                for ( const candidate of candidates ) {
                    if ( !validateCandidate( candidate.px, candidate.py ) ) continue;
                    const score = scoreCandidate( candidate.px, candidate.py );
                    if ( !best || score > best.score ) {
                        best = { ...candidate, score };
                    }
                }
                return best;
            };
            const localCandidates = [
                ...( desired ? [ desired ] : [] ),
                ...candidateSpiral(
                    cx,
                    cy,
                    Math.max( TILE_PX, rMinPx ),
                    Math.max( TILE_PX * 2, rMaxPx ),
                    arc,
                    bounds,
                    indexInZone
                ),
            ];
            const localBest = pickFrom( localCandidates );
            if ( localBest ) return localBest;

            const wholeMapRadiusPx = Math.max(
                bounds.maxPx - bounds.minPx,
                bounds.maxPy - bounds.minPy
            );
            const globalBest = pickFrom(
                candidateSpiral(
                    cx,
                    cy,
                    TILE_PX,
                    wholeMapRadiusPx,
                    null,
                    bounds,
                    indexInZone,
                    8192
                )
            );
            if ( globalBest ) return globalBest;

            const relaxedPickFrom = ( candidates: Array< { px: number; py: number } > ) => {
                let best: { px: number; py: number; score: number } | null = null;
                for ( const candidate of candidates ) {
                    if ( !validateCandidateRelaxed( candidate.px, candidate.py ) ) continue;
                    const score = scoreCandidate( candidate.px, candidate.py );
                    if ( !best || score > best.score ) best = { ...candidate, score };
                }
                return best;
            };
            const relaxedBest = relaxedPickFrom(
                candidateSpiral(
                    cx,
                    cy,
                    TILE_PX,
                    wholeMapRadiusPx,
                    null,
                    bounds,
                    indexInZone,
                    16384
                )
            );
            if ( relaxedBest ) return relaxedBest;

            return spiralFallback(
                cx,
                cy,
                rMinPx,
                rMaxPx,
                arc,
                placedAll,
                bounds,
                indexInZone,
                validateCandidateRelaxed
            );
        };
        const rememberPlacement = ( px: number, py: number ) => {
            rememberPlaced( px, py, footprint );
            if ( isBuildingScType( scType ) ) {
                placedBuildings.push( {
                    px,
                    py,
                    footprint,
                    isCore: zone.role === "core",
                } );
            }
            if ( preferredComponentId == null && isBuildingScType( scType ) ) {
                preferredComponentId = analyze?.( px, py )?.componentId ?? null;
            }
        };

        for ( let i = 0; i < list.length; i++ ) {
            const e = list[i];
            if ( typeof e.editPx === "number" && typeof e.editPy === "number" ) {
                const desiredPx = Math.max( bounds.minPx, Math.min( bounds.maxPx, Math.round( e.editPx ) ) );
                const desiredPy = Math.max( bounds.minPy, Math.min( bounds.maxPy, Math.round( e.editPy ) ) );
                const point = chooseBestCandidate(
                    { px: desiredPx, py: desiredPy },
                    zone.rMinTiles * TILE_PX,
                    zone.rMaxTiles * TILE_PX,
                    i
                );
                rememberPlacement( point.px, point.py );
                out.set( e.id, { px: point.px, py: point.py, role: zone.role } );
                continue;
            }

            // ── core: Command Center pinned at the base anchor ────────
            if ( strategy === "core" ) {
                const desiredPx = Math.max( bounds.minPx, Math.min( bounds.maxPx, cx ) );
                const desiredPy = Math.max( bounds.minPy, Math.min( bounds.maxPy, cy ) );
                const point = chooseBestCandidate( { px: desiredPx, py: desiredPy }, TILE_PX, 8 * TILE_PX, i );
                rememberPlacement( point.px, point.py );
                out.set( e.id, { px: point.px, py: point.py, role: zone.role } );
                continue;
            }

            // ── refinery: lock exactly on top of a real geyser ─────────
            if ( strategy === "resource-building" ) {
                const pick = nearestResource(
                    cx,
                    cy,
                    resources,
                    usedRefineryResources,
                    "gas"
                );
                if ( pick ) {
                    usedRefineryResources.add( pick.idx );
                    const px = Math.max( bounds.minPx, Math.min( bounds.maxPx, pick.res.px ) );
                    const py = Math.max( bounds.minPy, Math.min( bounds.maxPy, pick.res.py ) );
                    rememberPlacement( px, py );
                    out.set( e.id, {
                        px,
                        py,
                        role: zone.role,
                        targetResourcePx: pick.res.px,
                        targetResourcePy: pick.res.py,
                        targetResourceType: "gas",
                    } );
                    continue;
                }
                // No geyser on this map -> fall through to normal building
                // placement so the refinery entity still appears somewhere
                // valid rather than being dropped.
            }

            // ── worker: snap to a real mineral/gas patch when possible ─
            if ( strategy === "worker" && resources.length > 0 ) {
                // Split workers evenly: first half mine minerals, second
                // half mine gas (when a geyser/refinery exists).
                const desiredType: ResourcePatch["type"] =
                    hasGas && i >= Math.ceil( list.length / 2 ) ? "gas" : "mineral";
                const gasCandidates = desiredType === "gas"
                    ? resourcesByDistance( cx, cy, resources, "gas" )
                    : [];
                const gasOffset = i - Math.ceil( list.length / 2 );
                const pick =
                    desiredType === "gas" && gasCandidates.length > 0
                        ? gasCandidates[gasOffset % gasCandidates.length]
                        : nearestResource( cx, cy, resources, usedResources, desiredType ) ??
                            nearestResource( cx, cy, resources, usedResources );
                if ( pick ) {
                    if ( pick.res.type === "mineral" ) usedResources.add( pick.idx );
                    // Start workers in front of the Command Center in a
                    // compact worker line, then behavior moves them out to
                    // their mineral/refinery targets. This looks like a real
                    // opening instead of workers popping into existence at
                    // remote resources.
                    const workersPerRow = Math.ceil( Math.sqrt( list.length ) );
                    const row = Math.floor( i / workersPerRow );
                    const col = i % workersPerRow;
                    const ox = Math.round(
                        cx + ( col - ( workersPerRow - 1 ) / 2 ) * TILE_PX
                    );
                    const oy = Math.round( cy + ( 4 + row ) * TILE_PX );
                    const px = Math.max( bounds.minPx, Math.min( bounds.maxPx, ox ) );
                    const py = Math.max( bounds.minPy, Math.min( bounds.maxPy, oy ) );
                    rememberPlacement( px, py );
                    out.set( e.id, {
                        px,
                        py,
                        role: zone.role,
                        targetResourcePx: pick.res.px,
                        targetResourcePy: pick.res.py,
                        targetResourceType: pick.res.type,
                    } );
                    continue;
                }
                // No resources on this map -> fall through to free-poisson
                // so the SCV still gets *some* placement near the CC.
            }

            // ── tidy-arc: even angular spacing on one ring radius ────
            if ( strategy === "tidy-arc" ) {
                const slot = tidyArcSlot(
                    cx,
                    cy,
                    ringRadiusPx,
                    arc,
                    i,
                    list.length,
                    bounds,
                    validateCandidate
                );
                const point = chooseBestCandidate(
                    slot,
                    zone.rMinTiles * TILE_PX,
                    zone.rMaxTiles * TILE_PX,
                    i
                );
                rememberPlacement( point.px, point.py );
                let waypoints: { px: number; py: number }[] | undefined;
                if ( zone.role === "tech-ring" || zone.role === "supply-back" ) {
                    waypoints = makeOrbitLoop( cx, cy, point.px, point.py, bounds );
                }
                out.set( e.id, {
                    px: point.px,
                    py: point.py,
                    role: zone.role,
                    waypoints,
                } );
                continue;
            }

            // ── wall-row: tight Supply-Depot wall ─────────────────────
            if ( strategy === "wall-row" ) {
                const slot = wallRowSlot(
                    cx,
                    cy,
                    ringRadiusPx,
                    arc,
                    footprint,
                    i,
                    list.length,
                    bounds
                );
                const point = chooseBestCandidate(
                    slot,
                    zone.rMinTiles * TILE_PX,
                    zone.rMaxTiles * TILE_PX,
                    i
                );
                rememberPlacement( point.px, point.py );
                let waypoints: { px: number; py: number }[] | undefined;
                if ( zone.role === "supply-back" ) {
                    // Even on the wall, tech-ring stand-ins keep the
                    // 4-point orbit waypoint loop so the unit-behavior
                    // tests stay green.
                    waypoints = makeOrbitLoop( cx, cy, point.px, point.py, bounds );
                }
                out.set( e.id, {
                    px: point.px,
                    py: point.py,
                    role: zone.role,
                    waypoints,
                } );
                continue;
            }

            // ── production-strip: Barracks / Factory / Starport row ──
            if ( strategy === "production-strip" ) {
                const slot = productionStripSlot(
                    cx,
                    cy,
                    ringRadiusPx,
                    arc,
                    footprint,
                    i,
                    list.length,
                    bounds
                );
                const point = chooseBestCandidate(
                    slot,
                    zone.rMinTiles * TILE_PX,
                    zone.rMaxTiles * TILE_PX,
                    i
                );
                rememberPlacement( point.px, point.py );
                let waypoints: { px: number; py: number }[] | undefined;
                if ( zone.role === "tech-ring" ) {
                    waypoints = makeOrbitLoop( cx, cy, point.px, point.py, bounds );
                }
                out.set( e.id, {
                    px: point.px,
                    py: point.py,
                    role: zone.role,
                    waypoints,
                } );
                continue;
            }

            // ── free-poisson: Bridson sampling + golden-spiral fallback ──
            const patrolIndex = zone.role === "front-patrol" ? frontPatrolCursor++ : -1;
            const patrolLaneIndex = patrolIndex >= 0
                ? Math.floor( patrolIndex / PATROL_UNITS_PER_LANE )
                : 0;
            const patrolSlotInLane = patrolIndex >= 0
                ? patrolIndex % PATROL_UNITS_PER_LANE
                : 0;
            const patrolSlotsInLane = patrolIndex >= 0
                ? Math.min(
                    PATROL_UNITS_PER_LANE,
                    Math.max( 1, frontPatrolTotal - patrolLaneIndex * PATROL_UNITS_PER_LANE )
                )
                : 1;
            const patrolBaseMinTiles = PATROL_BASE_RADIUS_TILES +
                patrolLaneIndex * PATROL_LANE_GAP_TILES;
            const rMinPx = ( zone.role === "front-patrol"
                ? Math.max( zone.rMinTiles, patrolBaseMinTiles )
                : zone.rMinTiles ) * TILE_PX;
            const rMaxPx = ( zone.role === "front-patrol"
                ? Math.max( zone.rMaxTiles, patrolBaseMinTiles + 3 )
                : zone.rMaxTiles ) * TILE_PX;
            const minSpacingPx = ( zone.role === "front-patrol"
                ? Math.max( zone.minSpacingTiles, 2.2 )
                : zone.minSpacingTiles ) * TILE_PX;
            let shouldHoldStaticPost =
                zone.role === "front-patrol" &&
                frontPatrolTotal > 12 &&
                patrolIndex % STATIC_POST_EVERY_N_PATROLS === 0;

            const candidate = tryPoissonInAnnulus(
                rng,
                cx,
                cy,
                rMinPx,
                rMaxPx,
                arc,
                minSpacingPx,
                placedAll,
                bounds,
                60,
                validateCandidate
            );
            const point = chooseBestCandidate( candidate, rMinPx, rMaxPx, i );
            rememberPlacement( point.px, point.py );

            let waypoints: { px: number; py: number }[] | undefined;
            if ( zone.role === "front-patrol" ) {
                const seedAngle = Math.atan2( point.py - cy, point.px - cx );
                waypoints = makePatrolLoop(
                    cx,
                    cy,
                    Math.max( rMinPx, Math.hypot( point.px - cx, point.py - cy ) ),
                    seedAngle,
                    bounds,
                    patrolLaneIndex,
                    patrolSlotInLane,
                    patrolSlotsInLane
                );
                for (
                    let expand = 1;
                    ( nonWorkerWaypointsTooCloseToBuildings( waypoints, zone.role ) ||
                        ( !FLYING_SCTYPES.has( scType ) &&
                            ( nonWorkerWaypointsNearResource( waypoints ) ||
                                !groundWaypointsOk( scType, waypoints, analyze ) ) ) ) &&
                    expand <= 4;
                    expand++
                ) {
                    waypoints = makePatrolLoop(
                        cx,
                        cy,
                        Math.max(
                            rMinPx + expand * PATROL_LANE_GAP_TILES * TILE_PX,
                            Math.hypot( point.px - cx, point.py - cy )
                        ),
                        seedAngle,
                        bounds,
                        patrolLaneIndex + expand,
                        patrolSlotInLane,
                        patrolSlotsInLane
                    );
                }
                if (
                    nonWorkerWaypointsTooCloseToBuildings( waypoints, zone.role ) ||
                    !groundWaypointsOk( scType, waypoints, analyze ) ||
                    ( !FLYING_SCTYPES.has( scType ) && nonWorkerWaypointsNearResource( waypoints ) )
                ) {
                    waypoints = undefined;
                    shouldHoldStaticPost = true;
                }
            } else if ( zone.role === "tech-ring" ) {
                waypoints = makeOrbitLoop( cx, cy, point.px, point.py, bounds );
            } else if ( zone.role === "supply-back" ) {
                waypoints = makeOrbitLoop( cx, cy, point.px, point.py, bounds );
            }

            out.set( e.id, {
                px: point.px,
                py: point.py,
                role: shouldHoldStaticPost ? "static-post" : zone.role,
                waypoints: shouldHoldStaticPost ? undefined : waypoints,
            } );
        }
    }

    return out;
};

/**
 * Helper: extract mineral patches and geysers from the CHK-decoded map units
 * array (anything with a unitId in {0xb0, 0xb1, 0xb2, 0xbc}).
 */
export const extractResourcesFromMap = (
    mapUnits: Array< { unitId?: number; x?: number; y?: number } >
): ResourcePatch[] => {
    const out: ResourcePatch[] = [];
    if ( !Array.isArray( mapUnits ) ) return out;
    for ( const u of mapUnits ) {
        if ( !u || typeof u.x !== "number" || typeof u.y !== "number" ) continue;
        if ( u.unitId === 0xb0 || u.unitId === 0xb1 || u.unitId === 0xb2 ) {
            out.push( { px: u.x, py: u.y, type: "mineral" } );
        } else if ( u.unitId === 0xbc ) {
            out.push( { px: u.x, py: u.y, type: "gas" } );
        }
    }
    return out;
};
