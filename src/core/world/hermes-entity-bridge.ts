/**
 * Hermes entity bridge.
 *
 * Listens for `hermes:entities` postMessage events from the parent (the
 * Hermes dashboard) and spawns/updates/kills OpenBW units to mirror the
 * Hermes agent state on top of whatever StarCraft map the embed has loaded.
 *
 * Pure side-effect module: install once after a world is created. All bridge
 * state lives here so we can re-install or dispose cleanly.
 *
 * Architecture (2026-04-27 update — natural placement + living units)
 * --------------------------------------------------------------------
 *   1. `hermes-base-layout.ts` decides WHERE each entity should sit using
 *      Bridson Poisson-disk sampling inside concentric per-role ring
 *      annuli (zonal masking). Workers are snapped to real CHK mineral
 *      patches when present.
 *   2. This bridge spawns the units at those positions via OpenBW's
 *      `_create_unit` (the only WASM spawn export, see
 *      diag-list-wasm-api.mjs).
 *   3. After spawning, each unit is registered with
 *      `hermes-unit-behavior.ts` which periodically re-issues StarCraft
 *      orders so the base looks alive (marines patrol, wraiths orbit the
 *      tech ring, SCVs gather from real minerals, ghosts hold the
 *      perimeter with micro-shuffles, etc).
 */

import type { OpenBW } from "@openbw/openbw";
import type { World } from "./world";
import type { PxToWorld } from "common/utils/conversions";
import { SimpleBufferView } from "@openbw/structs";
import type { Camera } from "three";
import { Vector3 } from "three";
import CameraControls from "camera-controls";
import {
    computeBaseLayout,
    extractResourcesFromMap,
    type HermesEntityShape,
    type PlacementResult,
    type ResourcePatch,
} from "./hermes-base-layout";
import { installBehaviorLoop, type BehaviorOpenBW } from "./hermes-unit-behavior";

/**
 * Minimal duck-types for the things the focus-on-entity feature needs from
 * the rest of the world. Kept structural so this module doesn't pull in the
 * full SceneComposer / ViewControllerComposer types.
 */
interface FocusViewport {
    orbit?: {
        moveTo?: ( x: number, y: number, z: number, animate: boolean ) => void;
        dollyTo?: ( d: number, animate: boolean ) => void;
    } | null;
}

interface FocusViewControllerComposer {
    viewports?: FocusViewport[];
    primaryCamera?: Camera;
}

interface FocusableUnit {
    id: number;
    x?: number;
    y?: number;
    spriteIndex?: number;
    extras?: { dat?: { isFlyer?: boolean } } | undefined;
}

interface FocusSceneComposer {
    units?: { get?: ( unitId: number ) => FocusableUnit | undefined };
    sprites?: { get?: ( spriteIndex: number ) => { position?: Vector3 } | undefined };
    selectedUnits?: { set?: unknown };
}

export interface HermesEntityPayload {
    id: string;
    type?: string;
    scType: string;
    cluster?: string;
    x: number;
    y?: number;
    z: number;
    editPx?: number;
    editPy?: number;
    activity?: string;
    label?: string;
    [key: string]: unknown;
}

interface InstalledUnit {
    address: number;
    unitId: number | null;
    spriteIndex?: number;
    typeId: number;
    owner: number;
    px: number;
    py: number;
    label: string;
    labelCategory: string;
    placement: PlacementResult;
}

type EntityIconSource = {
    id?: string;
    label?: string;
    scType?: string;
    type?: string;
    cluster?: string;
    data?: unknown;
};

const entityTextForIcon = ( entity: EntityIconSource ): string => {
    const data = entity.data as { category?: unknown; skill?: unknown; platform?: unknown } | undefined;
    return [
        entity.id,
        entity.label,
        entity.scType,
        entity.type,
        entity.cluster,
        typeof data?.category === "string" ? data.category : undefined,
        typeof data?.skill === "string" ? data.skill : undefined,
        typeof data?.platform === "string" ? data.platform : undefined,
    ]
        .filter( ( value ): value is string => typeof value === "string" && value.length > 0 )
        .join( " " )
        .toLowerCase();
};

const entityComponentFor = ( entity: EntityIconSource ): { icon: string; label: string } => {
    const text = entityTextForIcon( entity );
    if ( text.includes( "cron" ) ) return { icon: "⏱️", label: "Cron Jobs" };
    if ( text.includes( "skill" ) ) return { icon: "🛠️", label: "Skills" };
    if ( text.includes( "dashboard" ) ) return { icon: "📊", label: "Dashboard" };
    if ( text.includes( "chat" ) || text.includes( "session" ) ) return { icon: "💬", label: "Chat Sessions" };
    if ( text.includes( "subagent" ) || text.includes( "agent" ) ) return { icon: "🤖", label: "Agents" };
    if ( text.includes( "memory" ) || text.includes( "wiki" ) || text.includes( "docs" ) ) return { icon: "📚", label: "Docs And Memory" };
    if ( text.includes( "monitor" ) || text.includes( "intel" ) || text.includes( "analytics" ) ) return { icon: "🔎", label: "Monitoring And Analytics" };
    if ( text.includes( "platform" ) || text.includes( "integration" ) ) return { icon: "🔌", label: "Platforms And Integrations" };
    if ( text.includes( "config" ) || text.includes( "env" ) || text.includes( "model" ) ) return { icon: "⚙️", label: "Config And Models" };
    if ( text.includes( "supply" ) ) return { icon: "📦", label: "Supply" };
    if ( text.includes( "worker" ) || text.includes( "scv" ) || text.includes( "drone" ) || text.includes( "probe" ) ) {
        return { icon: "⛏️", label: "Workers" };
    }
    return { icon: "◆", label: "Other Hermes Entities" };
};

const entityIconFor = ( entity: EntityIconSource ): string => entityComponentFor( entity ).icon;

const labelWithEntityIcon = (
    entity: EntityIconSource,
    label: string
): string => {
    const knownIconPrefixes = [ "⏱️ ", "🛠️ ", "📊 ", "💬 ", "🤖 ", "📚 ", "🔎 ", "🔌 ", "⚙️ ", "📦 ", "⛏️ ", "◆ " ];
    if ( knownIconPrefixes.some( ( prefix ) => label.startsWith( prefix ) ) ) {
        return label;
    }
    return `${entityIconFor( entity )} ${label}`;
};

/**
 * Map a Hermes scType string to a StarCraft unit typeId. We deliberately
 * pick **mobile** units in most cases because _create_unit on melee map
 * tiles fails for buildings (terrain / placement constraints — verified
 * via diag-hermes-embed-v3.mjs). Mobile units render reliably anywhere
 * and can take orders, which means the behavior loop can make them feel
 * alive (patrol, gather, orbit).
 */
// Hermes 2026-04 spawn-anything pass: full Terran tech tree mapped to
// real building / unit type ids. With the rebuilt titan.wasm exposing
// `_create_completed_unit_at` (the C++ `create_completed_unit` from
// bwgame.h:17372 which BYPASSES `can_place_building`), every entry in
// this map is guaranteed to actually spawn the right asset on screen —
// no more flying-unit stand-ins masquerading as buildings. See
// hermes-deeper/openbw/imbateam-openbw/ui/openbw.cpp `create_completed_unit_at`
// for the bypass shim. Type ids from units.dat (BWDAT), see
// `common/enums/unit-types.ts` and `imbateam-openbw/bwenums.h`.
//
// Mobile units still use `_create_unit` (trigger_create_unit) so they
// get proper pathing init. Buildings use `_create_completed_unit_at`
// so we sidestep the `can_place_building` rejection that previously
// caused the dashboard to look like a flock of battlecruisers.
//
// Hermes 2026-04 Terran human-tidy pass: previously-Protoss scTypes
// (Gateway, Zealot) get remapped to Terran equivalents (Barracks,
// Marine) so we never see a stray Probe in a Terran main.
const SC_TYPE_MAP: Record< string, number > = {
    // ── core ──────────────────────────────────────────────────────
    CommandCenter: 0x6a, // 106 Terran Command Center (4x3)
    SCV: 0x07, //   7 Terran SCV
    SupplyDepot: 0x6d, // 109 Terran Supply Depot (3x2)
    Refinery: 0x6e, // 110 Terran Refinery (4x2)
    // ── production ────────────────────────────────────────────────
    Barracks: 0x6f, // 111 Terran Barracks (4x3)
    Factory: 0x71, // 113 Terran Factory (4x3, addon)
    Starport: 0x72, // 114 Terran Starport (4x3, addon)
    // ── tech ──────────────────────────────────────────────────────
    Academy: 0x70, // 112 Terran Academy (3x2)
    EngineeringBay: 0x7a, // 122 Terran Engineering Bay (4x3)
    TechBuilding: 0x7a, // alias -> Engineering Bay
    Armory: 0x7b, // 123 Terran Armory (3x2)
    ScienceFacility: 0x74, // 116 Terran Science Facility (4x3, addon)
    // ── addons (only spawn if their host is present) ──────────────
    ComsatStation: 0x6b, // 107 Comsat (2x2 addon)
    NuclearSilo: 0x6c, // 108 Nuclear Silo (2x2 addon)
    ControlTower: 0x73, // 115 Control Tower (2x2 addon)
    MachineShop: 0x78, // 120 Machine Shop (2x2 addon)
    CovertOps: 0x75, // 117 Covert Ops (2x2 addon)
    PhysicsLab: 0x76, // 118 Physics Lab (2x2 addon)
    // ── defense ───────────────────────────────────────────────────
    Bunker: 0x7d, // 125 Terran Bunker (3x2)
    MissileTurret: 0x7c, // 124 Terran Missile Turret (2x2)
    // ── infantry ──────────────────────────────────────────────────
    Marine: 0x00, //   0 Terran Marine
    Firebat: 0x20, //  32 Terran Firebat
    Ghost: 0x01, //   1 Terran Ghost
    Medic: 0x22, //  34 Terran Medic
    // ── vehicles ──────────────────────────────────────────────────
    Vulture: 0x02, //   2 Terran Vulture
    Goliath: 0x03, //   3 Terran Goliath
    SiegeTank: 0x05, //   5 Terran Siege Tank (Tank Mode)
    SiegeTankSiege: 0x1e, //  30 Terran Siege Tank (Siege Mode)
    SpiderMine: 0x0d, //  13 Vulture Spider Mine
    // ── air ───────────────────────────────────────────────────────
    Wraith: 0x08, //   8 Terran Wraith
    Dropship: 0x0b, //  11 Terran Dropship
    ScienceVessel: 0x09, //   9 Terran Science Vessel
    Battlecruiser: 0x0c, //  12 Terran Battlecruiser
    Valkyrie: 0x3a, //  58 Terran Valkyrie
    NuclearMissile: 0x0e, //  14 Nuclear Missile
    // ── Zerg ──────────────────────────────────────────────────────
    Drone: 0x29,
    Zergling: 0x25,
    Hydralisk: 0x26,
    Lurker: 0x67,
    Mutalisk: 0x2b,
    Guardian: 0x2c,
    Overlord: 0x2a,
    Overseer: 0x2a,
    Defiler: 0x2e,
    Ultralisk: 0x27,
    Scourge: 0x2f,
    Hatchery: 0x83,
    Lair: 0x84,
    Hive: 0x85,
    Extractor: 0x95,
    SpawningPool: 0x8e,
    HydraliskDen: 0x87,
    EvolutionChamber: 0x8b,
    Spire: 0x8d,
    GreaterSpire: 0x89,
    QueensNest: 0x8a,
    DefilerMound: 0x88,
    UltraliskCavern: 0x8c,
    NydusCanal: 0x86,
    CreepColony: 0x8f,
    SporeColony: 0x90,
    SunkenColony: 0x92,
    // ── Protoss ───────────────────────────────────────────────────
    Probe: 0x40,
    Zealot: 0x41,
    Dragoon: 0x42,
    HighTemplar: 0x43,
    DarkTemplar: 0x3d,
    Archon: 0x44,
    DarkArchon: 0x3f,
    Shuttle: 0x45,
    Reaver: 0x53,
    Observer: 0x54,
    Carrier: 0x48,
    Arbiter: 0x47,
    Nexus: 0x9a,
    Pylon: 0x9c,
    Assimilator: 0x9d,
    Gateway: 0xa0,
    RoboticsFacility: 0x9b,
    RoboticsSupportBay: 0xab,
    Observatory: 0x9f,
    TemplarArchives: 0xa5,
    Forge: 0xa6,
    CyberneticsCore: 0xa4,
    Stargate: 0xa7,
    FleetBeacon: 0xa9,
    ArbiterTribunal: 0xaa,
    PhotonCannon: 0xa2,
    ShieldBattery: 0xac,
    // ── neutral / skipped ─────────────────────────────────────────
    VespeneGeyser: -1, // already exists on map as neutral
    StartLocation: -1, // CHK metadata, never spawnable
};

/**
 * Hermes 2026-04 spawn-anything pass: explicit BUILDING set so the
 * bridge knows which scTypes need the `_create_completed_unit_at`
 * bypass vs. the `_create_unit` trigger path. Anything not in this
 * set is treated as a mobile unit (free pathing, no placement
 * validation, takes orders).
 */
const BUILDING_SCTYPES = new Set< string >( [
    "CommandCenter",
    "SupplyDepot",
    "Refinery",
    "Barracks",
    "Factory",
    "Starport",
    "Academy",
    "EngineeringBay",
    "TechBuilding",
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
    "Gateway",
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

const RESOURCE_BUILDING_SCTYPES = new Set< string >( [
    "Refinery",
    "Extractor",
    "Assimilator",
] );

const RESOURCE_BUILDING_TYPE_IDS = new Set< number >( [
    0x6e, // Terran Refinery
    0x95, // Zerg Extractor
    0x9d, // Protoss Assimilator
] );
const VESPENE_GEYSER_TYPE_ID = 0xbc;

const ZERG_BUILDING_TYPE_IDS = new Set< number >( [
    0x83, // Hatchery
    0x84, // Lair
    0x85, // Hive
    0x86, // Nydus Canal
    0x87, // Hydralisk Den
    0x88, // Defiler Mound
    0x89, // Greater Spire
    0x8a, // Queen's Nest
    0x8b, // Evolution Chamber
    0x8c, // Ultralisk Cavern
    0x8d, // Spire
    0x8e, // Spawning Pool
    0x8f, // Creep Colony
    0x90, // Spore Colony
    0x92, // Sunken Colony
    0x95, // Extractor
] );

const TERRAIN_VALIDATOR_TYPE_BY_TYPE_ID: Record< number, number > = {
    // Use same-footprint Terran buildings to validate terrain/doodad/map
    // buildability without enforcing Zerg creep or Protoss pylon power.
    0x83: 0x6a, // Hatchery -> Command Center
    0x84: 0x6a, // Lair -> Command Center
    0x85: 0x6a, // Hive -> Command Center
    0x86: 0x7c, // Nydus Canal -> Missile Turret
    0x87: 0x70, // Hydralisk Den -> Academy
    0x88: 0x70, // Defiler Mound -> Academy
    0x89: 0x70, // Greater Spire -> Academy
    0x8a: 0x70, // Queen's Nest -> Academy
    0x8b: 0x70, // Evolution Chamber -> Academy
    0x8c: 0x70, // Ultralisk Cavern -> Academy
    0x8d: 0x70, // Spire -> Academy
    0x8e: 0x70, // Spawning Pool -> Academy
    0x8f: 0x7c, // Creep Colony -> Missile Turret
    0x90: 0x7c, // Spore Colony -> Missile Turret
    0x92: 0x7c, // Sunken Colony -> Missile Turret
    0x9a: 0x6a, // Nexus -> Command Center
    0x9b: 0x6f, // Robotics Facility -> Barracks
    0x9c: 0x7c, // Pylon -> Missile Turret
    0x9f: 0x70, // Observatory -> Academy
    0xa0: 0x6f, // Gateway -> Barracks
    0xa2: 0x7c, // Photon Cannon -> Missile Turret
    0xa4: 0x70, // Cybernetics Core -> Academy
    0xa5: 0x70, // Templar Archives -> Academy
    0xa6: 0x70, // Forge -> Academy
    0xa7: 0x6f, // Stargate -> Barracks
    0xa9: 0x70, // Fleet Beacon -> Academy
    0xaa: 0x70, // Arbiter Tribunal -> Academy
    0xab: 0x70, // Robotics Support Bay -> Academy
    0xac: 0x7c, // Shield Battery -> Missile Turret
};

const terrainValidatorTypeId = ( typeId: number ): number =>
    TERRAIN_VALIDATOR_TYPE_BY_TYPE_ID[typeId] ?? typeId;

type RacePlacementProfile = {
    core: "CommandCenter" | "Hatchery" | "Nexus";
    refinery: "Refinery" | "Extractor" | "Assimilator";
    worker: "SCV" | "Drone" | "Probe";
};

const ZERG_SCTYPES = new Set( [
    "Drone",
    "Zergling",
    "Hydralisk",
    "Lurker",
    "Mutalisk",
    "Guardian",
    "Overlord",
    "Overseer",
    "Defiler",
    "Ultralisk",
    "Scourge",
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
] );

const PROTOSS_SCTYPES = new Set( [
    "Probe",
    "Zealot",
    "Dragoon",
    "HighTemplar",
    "DarkTemplar",
    "Archon",
    "DarkArchon",
    "Shuttle",
    "Reaver",
    "Observer",
    "Carrier",
    "Arbiter",
    "Nexus",
    "Pylon",
    "Assimilator",
    "Gateway",
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

const inferRacePlacementProfile = (
    entities: Array< { scType?: string } >
): RacePlacementProfile => {
    if ( entities.some( ( e ) => e.scType && ZERG_SCTYPES.has( e.scType ) ) ) {
        return { core: "Hatchery", refinery: "Extractor", worker: "Drone" };
    }
    if ( entities.some( ( e ) => e.scType && PROTOSS_SCTYPES.has( e.scType ) ) ) {
        return { core: "Nexus", refinery: "Assimilator", worker: "Probe" };
    }
    return { core: "CommandCenter", refinery: "Refinery", worker: "SCV" };
};

const DEFAULT_UNIT_TYPE = 0x00; // marine fallback
const TERRAIN_VALIDATION_OWNER = 11;
const PROTOSS_POWER_RADIUS_PX = 8 * 32;
const PROTOSS_POWER_MAX_SYNTHETIC_PYLONS = 12;
const FLYING_TYPE_IDS = new Set( [
    0x08, // Terran Wraith
    0x09, // Terran Science Vessel
    0x0b, // Terran Dropship
    0x0c, // Terran Battlecruiser
    0x0e, // Nuclear Missile
    0x2a, // Zerg Overlord
    0x2b, // Zerg Mutalisk
    0x2c, // Zerg Guardian
    0x2f, // Zerg Scourge
    0x3a, // Terran Valkyrie
    0x45, // Protoss Shuttle
    0x47, // Protoss Arbiter
    0x48, // Protoss Carrier
    0x54, // Protoss Observer
] );
const PROTOSS_BUILDING_SCTYPES = new Set( [
    "Nexus",
    "Pylon",
    "Assimilator",
    "Gateway",
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

interface InstallParams {
    world: World;
    mapWidthTiles: number;
    mapHeightTiles: number;
    /** Player ID owned by Hermes. Defaults to 0. */
    hermesPlayerId?: number;
    /**
     * Hermes 2026-04 base-layout fix: anchor (CHK pixel coords) at which
     * the layout should center the Command Center / Tech ring / Bunker
     * arc. Pass the player's start-location pixel coords (from the CHK)
     * so the base spawns on the same buildable plateau the engine
     * auto-places the Command Center on. Falls back to map center when
     * omitted (legacy behaviour).
     */
    anchorPx?: number;
    anchorPy?: number;
    /**
     * Optional mineral/geyser patches in CHK pixel coords. If omitted the
     * bridge auto-extracts them from `world.map.units`.
     */
    resources?: ResourcePatch[];
    /** Deterministic layout seed; defaults to 0xc0ffee. */
    layoutSeed?: number;
    /**
     * Optional camera-focus dependencies. When all three are supplied,
     * `hermes:focus-entity` postMessages will pan the camera to the unit
     * and select it (which fires the existing `selected-units-changed`
     * event so the dashboard's TitanUnitInspector pops up).
     */
    pxToWorld?: PxToWorld;
    viewControllerComposer?: FocusViewControllerComposer;
    sceneComposer?: FocusSceneComposer;
    creep?: {
        generateImmediate: ( tiles: SimpleBufferView< Uint8Array > ) => void;
    };
}

interface InstalledBridge {
    placeEntities: ( entities: unknown[] ) => {
        spawned: number;
        updated: number;
        killed: number;
        skipped: number;
        /**
         * Hermes 2026-04 base-layout fix: number of Hermes entities that
         * were attached to engine-spawned units (Command Center +
         * starting SCVs) instead of being created via _create_unit. Lets
         * tests and the dashboard verify the adoption path is firing.
         */
        adopted: number;
    };
    /**
     * Pan the camera to the given Hermes entity and select the underlying
     * SC unit so the unit inspector opens. Returns true if the entity was
     * found and focus was issued.
     */
    focusByHermesId: ( hermesId: string ) => boolean;
    dispose: () => void;
    /** Live snapshot for tests / diagnostics. */
    state: () => {
        units: number;
        types: Record< number, number >;
        behavior: ReturnType< ReturnType< typeof installBehaviorLoop >["state"] >;
    };
}

export const installHermesEntityBridge = ( params: InstallParams ): InstalledBridge => {
    const {
        world,
        mapWidthTiles,
        mapHeightTiles,
        hermesPlayerId = 0,
        layoutSeed = 0xc0ffee,
    } = params;

    const openBW = world.openBW as unknown as OpenBW & {
        _create_unit: ( typeId: number, ownerId: number, x: number, y: number ) => number;
        /**
         * Hermes 2026-04 spawn-anything pass: bypass-placement spawn
         * shipped in the rebuilt titan.wasm. Wraps C++
         * `state_functions::create_completed_unit` (bwgame.h:17372)
         * which calls the low-level `create_unit` (only checks
         * `is_in_map_bounds`) then `finish_building_unit` +
         * `complete_unit`. Skips `can_place_building` so any building
         * type can be force-spawned anywhere inside the map.
         * Returns a unit_t* address on success, 0 on failure.
         */
        _create_completed_unit_at?: (
            typeId: number,
            ownerId: number,
            x: number,
            y: number
        ) => number;
        /**
         * Hermes 2026-04 spawn-anything pass: validation hook for the
         * placement search. Returns 1 if a building of that type can
         * legally be placed at (x, y) for that owner, 0 otherwise.
         * Wraps C++ `state_functions::can_place_building`.
         */
        _can_place_building_at?: (
            typeId: number,
            ownerId: number,
            x: number,
            y: number
        ) => number;
        _morph_unit_at?: ( unitId: number, newTypeId: number ) => number;
        get_util_funcs: () => {
            kill_unit: ( id: number ) => void;
            remove_unit: ( id: number ) => void;
            issue_command: (
                unitId: number,
                commandType: number,
                targetUnitId: number,
                x: number,
                y: number,
                extra: number
            ) => void;
        };
    };

    // Resolve real mineral / geyser positions from the loaded map so workers
    // can be snapped to actual resource patches.
    const resources =
        params.resources ??
        extractResourcesFromMap(
            ( world.map as unknown as { units?: Array< { unitId?: number; x?: number; y?: number } > } )
                .units ?? []
        );

    const installed = new Map< string, InstalledUnit >();
    const raceAwareLabel = ( label: string, typeId: number ): string => {
        switch ( typeId ) {
            case 0x29: // Drone
                return label.replace( /\bBase SCV\b/gi, "Drone" ).replace( /\bSCV\b/gi, "Drone" );
            case 0x40: // Probe
                return label.replace( /\bBase SCV\b/gi, "Probe" ).replace( /\bSCV\b/gi, "Probe" );
            case 0x83: // Hatchery
            case 0x84: // Lair
            case 0x85: // Hive
                return label.replace( /\bCommand Center\b/gi, "Hatchery" ).replace( /\bCC\b/g, "Hatchery" );
            case 0x9a: // Nexus
                return label.replace( /\bCommand Center\b/gi, "Nexus" ).replace( /\bCC\b/g, "Nexus" );
            case 0x2a: // Overlord
                return label.replace( /\bSupply Depot\b/gi, "Overlord" ).replace( /\bSupply\b/gi, "Overlord" );
            case 0x9c: // Pylon
                return label.replace( /\bSupply Depot\b/gi, "Pylon" ).replace( /\bSupply\b/gi, "Pylon" );
            default:
                return label;
        }
    };
    const labelForEntity = ( entity: HermesEntityPayload, typeId: number ): string => {
        const raw = typeof entity.label === "string" && entity.label.trim()
            ? entity.label.trim()
            : entity.id;
        return labelWithEntityIcon( entity, raceAwareLabel( raw, typeId ) );
    };
    const labelCategoryForEntity = ( entity: HermesEntityPayload ): string => {
        const component = entityComponentFor( entity );
        return `${component.icon} ${component.label}`;
    };
    const formatLabelCategory = ( category: string ): string =>
        category
            .replace( /[_-]+/g, " " )
            .replace( /\s+/g, " " )
            .trim()
            .replace( /\b\w/g, ( ch ) => ch.toUpperCase() ) || "Unknown";
    const livePositionFor = ( rec: InstalledUnit ): { px: number; py: number; world?: Vector3 } => {
        if ( typeof rec.spriteIndex === "number" ) {
            const sprite = params.sceneComposer?.sprites?.get?.( rec.spriteIndex );
            if ( sprite?.position ) {
                return { px: rec.px, py: rec.py, world: sprite.position };
            }
        }
        if ( rec.unitId != null ) {
            const sceneUnit = params.sceneComposer?.units?.get?.( rec.unitId );
            const spriteIndex = sceneUnit?.spriteIndex;
            if ( typeof spriteIndex === "number" ) {
                rec.spriteIndex = spriteIndex;
                const sprite = params.sceneComposer?.sprites?.get?.( spriteIndex );
                if ( sprite?.position ) {
                    return {
                        px: sceneUnit?.x ?? rec.px,
                        py: sceneUnit?.y ?? rec.py,
                        world: sprite.position,
                    };
                }
            }
            if (
                typeof sceneUnit?.x === "number" &&
                typeof sceneUnit?.y === "number"
            ) {
                return { px: sceneUnit.x, py: sceneUnit.y };
            }
            try {
                for ( const unit of openBW.iterators.units as unknown as Iterable< {
                    id?: number;
                    spriteIndex?: number;
                    x?: number;
                    y?: number;
                } > ) {
                    if (
                        unit.id === rec.unitId &&
                        typeof unit.x === "number" &&
                        typeof unit.y === "number"
                    ) {
                        if ( typeof unit.spriteIndex === "number" ) {
                            rec.spriteIndex = unit.spriteIndex;
                            const sprite = params.sceneComposer?.sprites?.get?.( unit.spriteIndex );
                            if ( sprite?.position ) {
                                return { px: unit.x, py: unit.y, world: sprite.position };
                            }
                        }
                        return { px: unit.x, py: unit.y };
                    }
                }
            } catch {
                /* fall back to stored placement */
            }
        }
        return { px: rec.px, py: rec.py };
    };
    const spriteIndexForUnitId = ( unitId: number | null ): number | undefined => {
        if ( unitId == null ) return undefined;
        try {
            for ( const unit of openBW.iterators.units as unknown as Iterable< {
                id?: number;
                spriteIndex?: number;
            } > ) {
                if ( unit.id === unitId && typeof unit.spriteIndex === "number" ) {
                    return unit.spriteIndex;
                }
            }
        } catch {
            /* best-effort for labels only */
        }
        return undefined;
    };
    const installedTypeIsBuilding = ( typeId: number ): boolean =>
        Array.from( BUILDING_SCTYPES ).some( ( scType ) => SC_TYPE_MAP[scType] === typeId );
    const moveInstalledUnit = ( rec: InstalledUnit, px: number, py: number ) => {
        if ( !openBW.HEAP32 || typeof rec.address !== "number" || rec.address <= 0 ) return;
        const unitAddr32 = ( rec.address >> 2 ) + 2;
        openBW.HEAP32[unitAddr32 + 16] = px;
        openBW.HEAP32[unitAddr32 + 17] = py;
        const spriteAddr = openBW.HEAPU32?.[unitAddr32 + 1];
        if ( typeof spriteAddr === "number" && spriteAddr > 0 ) {
            const spriteAddr32 = ( spriteAddr >> 2 ) + 2;
            openBW.HEAP32[spriteAddr32 + 10] = px;
            openBW.HEAP32[spriteAddr32 + 11] = py;
        }
    };
    const publishUnitEntityMap = () => {
        const unitToEntity: Record< number, string > = {};
        for ( const [ hermesId, rec ] of installed ) {
            if ( rec.unitId != null ) unitToEntity[rec.unitId] = hermesId;
        }
        ( globalThis as Record< string, unknown > ).__hermesUnitToEntity = unitToEntity;
    };
    const createHermesLabelOverlay = () => {
        if ( typeof document === "undefined" || typeof window === "undefined" ) {
            return { dispose: () => undefined };
        }
        const root = document.createElement( "div" );
        root.id = "hermes-unit-label-overlay";
        root.style.position = "fixed";
        root.style.inset = "0";
        root.style.pointerEvents = "none";
        root.style.zIndex = "2147483600";
        root.style.fontFamily = "'Courier New', monospace";
        root.style.fontSize = "11px";
        root.style.color = "#cffff0";
        root.style.textShadow = "0 1px 2px #001, 0 0 7px #00ff88";

        const filterWrap = document.createElement( "div" );
        filterWrap.id = "hermes-label-filter-control";
        filterWrap.style.position = "fixed";
        filterWrap.style.top = "58px";
        filterWrap.style.right = "10px";
        filterWrap.style.minWidth = "190px";
        filterWrap.style.border = "1px solid rgba(0, 255, 136, 0.45)";
        filterWrap.style.borderRadius = "4px";
        filterWrap.style.background = "rgba(0, 10, 18, 0.86)";
        filterWrap.style.color = "#9fffd0";
        filterWrap.style.pointerEvents = "auto";
        filterWrap.style.zIndex = "2";
        filterWrap.style.userSelect = "none";
        filterWrap.style.fontFamily = "'Courier New', monospace";

        const filterButton = document.createElement( "button" );
        filterButton.type = "button";
        filterButton.id = "hermes-label-filter-button";
        filterButton.style.width = "100%";
        filterButton.style.display = "flex";
        filterButton.style.alignItems = "center";
        filterButton.style.justifyContent = "space-between";
        filterButton.style.gap = "8px";
        filterButton.style.padding = "6px 8px";
        filterButton.style.border = "0";
        filterButton.style.background = "transparent";
        filterButton.style.color = "inherit";
        filterButton.style.font = "inherit";
        filterButton.style.cursor = "pointer";
        filterButton.setAttribute( "aria-expanded", "false" );
        filterButton.setAttribute( "aria-controls", "hermes-label-filter-menu" );

        const filterButtonText = document.createElement( "span" );
        filterButtonText.textContent = "Labels: Hover only";
        const filterButtonCaret = document.createElement( "span" );
        filterButtonCaret.textContent = "v";
        filterButton.append( filterButtonText, filterButtonCaret );

        const filterMenu = document.createElement( "div" );
        filterMenu.id = "hermes-label-filter-menu";
        filterMenu.style.display = "none";
        filterMenu.style.borderTop = "1px solid rgba(0, 255, 136, 0.28)";
        filterMenu.style.padding = "6px 8px 8px";
        filterMenu.style.maxHeight = "260px";
        filterMenu.style.overflowY = "auto";

        const allRow = document.createElement( "label" );
        allRow.style.display = "flex";
        allRow.style.alignItems = "center";
        allRow.style.gap = "6px";
        allRow.style.padding = "3px 0 6px";
        allRow.style.cursor = "pointer";
        const allToggle = document.createElement( "input" );
        allToggle.id = "hermes-show-all-labels-checkbox";
        allToggle.type = "checkbox";
        allToggle.style.margin = "0";
        allToggle.setAttribute( "aria-label", "Show all Hermes label categories" );
        const allText = document.createElement( "span" );
        allText.textContent = "All labels";
        allRow.append( allToggle, allText );

        const categoryList = document.createElement( "div" );
        categoryList.id = "hermes-label-category-list";
        categoryList.style.display = "grid";
        categoryList.style.gap = "4px";
        filterMenu.append( allRow, categoryList );
        filterWrap.append( filterButton, filterMenu );

        const labelLayer = document.createElement( "div" );
        labelLayer.style.position = "absolute";
        labelLayer.style.inset = "0";
        labelLayer.style.pointerEvents = "none";
        labelLayer.style.zIndex = "1";
        root.appendChild( labelLayer );
        document.body.appendChild( root );
        document.body.appendChild( filterWrap );

        const labelEls = new Map< string, HTMLDivElement >();
        const screenPositions = new Map< string, { x: number; y: number; visible: boolean } >();
        const projected = new Vector3();
        const mouse = { x: -1, y: -1, inside: false };
        let hoveredId: string | null = null;
        let dropdownOpen = false;
        let selectAllCategories = false;
        const selectedCategories = new Set< string >();
        const categoryRows = new Map< string, HTMLInputElement >();
        let raf = 0;
        let postFrameTimer = 0;

        const onMouseMove = ( ev: MouseEvent ) => {
            if (
                ev.target instanceof Element &&
                ev.target.closest( "#hermes-label-filter-control" )
            ) {
                mouse.inside = false;
                hoveredId = null;
                return;
            }
            mouse.x = ev.clientX;
            mouse.y = ev.clientY;
            mouse.inside = true;
        };
        const onMouseLeave = () => {
            mouse.inside = false;
            hoveredId = null;
        };
        const updateFilterSummary = () => {
            const allCategories = Array.from(
                new Set( Array.from( installed.values(), ( rec ) => rec.labelCategory ) )
            ).sort( ( a, b ) => formatLabelCategory( a ).localeCompare( formatLabelCategory( b ) ) );
            const selectedCount = allCategories.filter( ( category ) =>
                selectedCategories.has( category )
            ).length;
            selectAllCategories = allCategories.length > 0 && selectedCount === allCategories.length;
            allToggle.checked = allCategories.length > 0 && selectedCount === allCategories.length;
            allToggle.indeterminate = selectedCount > 0 && selectedCount < allCategories.length;
            if ( selectedCount === 0 ) {
                filterButtonText.textContent = "Labels: Hover only";
            } else if ( selectedCount === allCategories.length ) {
                filterButtonText.textContent = "Labels: All";
            } else {
                filterButtonText.textContent = `Labels: ${selectedCount} categories`;
            }
        };
        const setDropdownOpen = ( open: boolean ) => {
            dropdownOpen = open;
            filterMenu.style.display = dropdownOpen ? "block" : "none";
            filterButton.setAttribute( "aria-expanded", dropdownOpen ? "true" : "false" );
            filterButtonCaret.textContent = dropdownOpen ? "^" : "v";
        };
        const onFilterButtonClick = () => {
            setDropdownOpen( !dropdownOpen );
        };
        const onDocumentPointerDown = ( ev: MouseEvent ) => {
            if (
                dropdownOpen &&
                ev.target instanceof Element &&
                !ev.target.closest( "#hermes-label-filter-control" )
            ) {
                setDropdownOpen( false );
            }
        };
        const onAllToggle = () => {
            const allCategories = Array.from(
                new Set( Array.from( installed.values(), ( rec ) => rec.labelCategory ) )
            );
            selectedCategories.clear();
            selectAllCategories = allToggle.checked;
            if ( allToggle.checked ) {
                for ( const category of allCategories ) selectedCategories.add( category );
            }
            for ( const [ category, input ] of categoryRows ) {
                input.checked = selectedCategories.has( category );
            }
            updateFilterSummary();
        };
        window.addEventListener( "mousemove", onMouseMove, { passive: true } );
        window.addEventListener( "mouseleave", onMouseLeave );
        window.addEventListener( "blur", onMouseLeave );
        document.addEventListener( "mousedown", onDocumentPointerDown );
        filterButton.addEventListener( "click", onFilterButtonClick );
        allToggle.addEventListener( "change", onAllToggle );

        const syncCategoryControls = () => {
            const categories = Array.from(
                new Set( Array.from( installed.values(), ( rec ) => rec.labelCategory ) )
            ).sort( ( a, b ) => formatLabelCategory( a ).localeCompare( formatLabelCategory( b ) ) );
            const current = new Set( categories );
            for ( const category of Array.from( categoryRows.keys() ) ) {
                if ( current.has( category ) ) continue;
                categoryRows.get( category )?.closest( "label" )?.remove();
                categoryRows.delete( category );
                selectedCategories.delete( category );
            }
            for ( const category of categories ) {
                if ( categoryRows.has( category ) ) continue;
                const row = document.createElement( "label" );
                row.style.display = "flex";
                row.style.alignItems = "center";
                row.style.gap = "6px";
                row.style.cursor = "pointer";
                row.style.padding = "2px 0";
                const input = document.createElement( "input" );
                input.type = "checkbox";
                input.style.margin = "0";
                input.checked = selectedCategories.has( category );
                input.setAttribute( "aria-label", `Show ${formatLabelCategory( category )} labels` );
                input.addEventListener( "change", () => {
                    if ( input.checked ) {
                        selectedCategories.add( category );
                    } else {
                        selectedCategories.delete( category );
                        selectAllCategories = false;
                    }
                    updateFilterSummary();
                } );
                const text = document.createElement( "span" );
                text.textContent = formatLabelCategory( category );
                row.append( input, text );
                categoryList.appendChild( row );
                categoryRows.set( category, input );
            }
            if ( selectAllCategories ) {
                for ( const category of categories ) selectedCategories.add( category );
            }
            for ( const [ category, input ] of categoryRows ) {
                input.checked = selectedCategories.has( category );
            }
            updateFilterSummary();
        };

        const syncLabelElements = () => {
            syncCategoryControls();
            for ( const hermesId of Array.from( labelEls.keys() ) ) {
                if ( installed.has( hermesId ) ) continue;
                labelEls.get( hermesId )?.remove();
                labelEls.delete( hermesId );
                screenPositions.delete( hermesId );
            }
            for ( const [ hermesId, rec ] of installed ) {
                let el = labelEls.get( hermesId );
                if ( !el ) {
                    el = document.createElement( "div" );
                    el.dataset.hermesLabel = "1";
                    el.dataset.hermesId = hermesId;
                    el.style.position = "absolute";
                    el.style.padding = "2px 5px";
                    el.style.border = "1px solid rgba(0, 255, 136, 0.38)";
                    el.style.borderRadius = "3px";
                    el.style.background = "rgba(0, 8, 12, 0.82)";
                    el.style.whiteSpace = "nowrap";
                    el.style.pointerEvents = "none";
                    el.style.transform = "translate(-50%, -100%)";
                    el.style.willChange = "transform, left, top";
                    labelLayer.appendChild( el );
                    labelEls.set( hermesId, el );
                }
                el.dataset.typeId = String( rec.typeId );
                el.dataset.labelCategory = rec.labelCategory;
                if ( el.textContent !== rec.label ) el.textContent = rec.label;
            }
        };

        const updateHover = () => {
            if ( !mouse.inside ) {
                hoveredId = null;
                return;
            }
            let bestId: string | null = null;
            let bestD2 = 36 * 36;
            for ( const [ hermesId, pos ] of screenPositions ) {
                if ( !pos.visible ) continue;
                const dx = pos.x - mouse.x;
                const dy = pos.y - mouse.y;
                const d2 = dx * dx + dy * dy;
                if ( d2 < bestD2 ) {
                    bestD2 = d2;
                    bestId = hermesId;
                }
            }
            hoveredId = bestId;
        };

        const renderLabels = () => {
            syncLabelElements();
            const camera = params.viewControllerComposer?.primaryCamera;
            const pxToWorld = params.pxToWorld;
            if ( camera && pxToWorld ) {
                for ( const [ hermesId, rec ] of installed ) {
                    const el = labelEls.get( hermesId );
                    if ( !el ) continue;
                    try {
                        const livePos = livePositionFor( rec );
                        rec.px = livePos.px;
                        rec.py = livePos.py;
                        if ( livePos.world ) {
                            projected.copy( livePos.world );
                        } else {
                            pxToWorld.xyz( livePos.px, livePos.py, projected );
                        }
                        const isBuilding = installedTypeIsBuilding( rec.typeId );
                        if ( !livePos.world ) {
                            projected.y += isBuilding ? 0.4 : 0.25;
                        }
                        projected.project( camera );
                        const x = ( projected.x * 0.5 + 0.5 ) * window.innerWidth;
                        const footprint = completedFootprintForType( rec.typeId );
                        const labelLiftPx = isBuilding
                            ? Math.max( 18, footprint.h * 6 )
                            : 12;
                        const y = ( -projected.y * 0.5 + 0.5 ) * window.innerHeight - labelLiftPx;
                        const visible =
                            Number.isFinite( x ) &&
                            Number.isFinite( y ) &&
                            x >= -160 &&
                            x <= window.innerWidth + 160 &&
                            y >= -160 &&
                            y <= window.innerHeight + 160;
                        screenPositions.set( hermesId, { x, y, visible } );
                        el.style.left = `${x}px`;
                        el.style.top = `${y}px`;
                    } catch {
                        screenPositions.set( hermesId, { x: 0, y: 0, visible: false } );
                    }
                }
            }
            updateHover();
            for ( const [ hermesId, el ] of labelEls ) {
                const visible = screenPositions.get( hermesId )?.visible ?? false;
                const category = installed.get( hermesId )?.labelCategory;
                const categorySelected =
                    typeof category === "string" && selectedCategories.has( category );
                const shouldShow = visible && ( categorySelected || hoveredId === hermesId );
                el.style.display = shouldShow ? "block" : "none";
            }
        };

        const tick = () => {
            renderLabels();
            if ( postFrameTimer ) window.clearTimeout( postFrameTimer );
            postFrameTimer = window.setTimeout( renderLabels, 0 );
            raf = window.requestAnimationFrame( tick );
        };
        raf = window.requestAnimationFrame( tick );

        return {
            dispose: () => {
                if ( raf ) window.cancelAnimationFrame( raf );
                if ( postFrameTimer ) window.clearTimeout( postFrameTimer );
                window.removeEventListener( "mousemove", onMouseMove );
                window.removeEventListener( "mouseleave", onMouseLeave );
                window.removeEventListener( "blur", onMouseLeave );
                document.removeEventListener( "mousedown", onDocumentPointerDown );
                filterButton.removeEventListener( "click", onFilterButtonClick );
                allToggle.removeEventListener( "change", onAllToggle );
                root.remove();
                filterWrap.remove();
            },
        };
    };
    const labelOverlay = createHermesLabelOverlay();
    const cameraLocked = () =>
        !!( globalThis as Record< string, unknown > ).__hermesCameraLocked;
    const configureOrbitForCcZoom = ( orbit: unknown, distance: number ) => {
        const o = orbit as {
            minDistance?: number;
            maxDistance?: number;
            dollySpeed?: number;
            dollyToCursor?: boolean;
            truckSpeed?: number;
            mouseButtons?: Record< string, number >;
            touches?: Record< string, number >;
        } | null | undefined;
        if ( !o ) return;
        o.minDistance = Math.max( 120, Math.round( distance * 0.32 ) );
        o.maxDistance = Math.min(
            280,
            Math.max( o.minDistance + 70, Math.round( distance * 1.15 ) )
        );
        o.dollySpeed = 1.4;
        o.dollyToCursor = false;
        o.truckSpeed = 0;
        if ( o.mouseButtons ) {
            o.mouseButtons.left = CameraControls.ACTION.NONE;
            o.mouseButtons.right = CameraControls.ACTION.NONE;
            o.mouseButtons.middle = CameraControls.ACTION.NONE;
            o.mouseButtons.wheel = CameraControls.ACTION.DOLLY;
        }
        if ( o.touches ) {
            o.touches.one = CameraControls.ACTION.NONE;
            o.touches.two = CameraControls.ACTION.TOUCH_DOLLY;
            o.touches.three = CameraControls.ACTION.NONE;
        }
    };

    let currentRaceProfile: RacePlacementProfile = {
        core: "CommandCenter",
        refinery: "Refinery",
        worker: "SCV",
    };

    const behavior = installBehaviorLoop( {
        openBW: openBW as unknown as BehaviorOpenBW,
        intervalMs: 1500,
        engineOrders: typeof openBW._create_completed_unit_at !== "function",
        mapWidthTiles,
        mapHeightTiles,
    } );

    /**
     * Hermes 2026-04 base-layout fix: scan the live OpenBW unit iterator
     * for the engine-auto-spawned Command Center + SCVs that melee maps
     * place at each player's start location. Returns {ccPx, ccPy,
     * existingCcUnitId, scvUnitIds}. Used both to (a) shift the layout
     * anchor onto the *actual* buildable plateau the engine validated for
     * us, and (b) adopt those existing units for the first
     * Hermes "CommandCenter" + "SCV" entities so we never see a
     * duplicate CC stacked on top of the engine's CC, and the SCVs come
     * pre-loaded with the engine's gather orders.
     */
    const findEngineSpawnedBase = (): {
        ccPx?: number;
        ccPy?: number;
        existingCcUnitId?: number;
        existingCcAddress?: number;
        existingScvs: Array< { unitId: number; address: number; px: number; py: number } >;
    } => {
        const result: {
            ccPx?: number;
            ccPy?: number;
            existingCcUnitId?: number;
            existingCcAddress?: number;
            existingScvs: Array< { unitId: number; address: number; px: number; py: number } >;
        } = { existingScvs: [] };
        try {
            for ( const u of openBW.iterators.units as unknown as Iterable< {
                id: number;
                typeId?: number;
                owner?: number;
                x?: number;
                y?: number;
                _address?: number;
            } > ) {
                if ( u.owner !== hermesPlayerId ) continue;
                if ( u.typeId === 0x6a /* commandCenter */ && result.ccPx == null ) {
                    result.ccPx = u.x;
                    result.ccPy = u.y;
                    result.existingCcUnitId = u.id;
                    result.existingCcAddress = u._address;
                } else if ( u.typeId === 0x07 /* scv */ ) {
                    if ( typeof u.x === "number" && typeof u.y === "number" && typeof u._address === "number" ) {
                        result.existingScvs.push( {
                            unitId: u.id,
                            address: u._address,
                            px: u.x,
                            py: u.y,
                        } );
                    }
                }
            }
        } catch ( err ) {
            console.warn( "[hermes-entity-bridge] findEngineSpawnedBase failed:", err );
        }
        return result;
    };

    const findUnitIdByAddress = ( address: number ): number | null => {
        try {
            for ( const u of openBW.iterators.units ) {
                if (
                    ( u as unknown as { _address?: number } )._address === address
                ) {
                    return u.id;
                }
            }
        } catch {
            /* swallow */
        }
        return null;
    };

    const consumedGeyserUnitIds = new Set< number >();
    const hideGeyserUnderResourceBuilding = ( px: number, py: number ): void => {
        const MAX_GEYSER_CENTER_DISTANCE_PX = 96;
        let best: { id: number; distanceSq: number } | null = null;
        try {
            for ( const u of openBW.iterators.units as unknown as Iterable< {
                id?: number;
                typeId?: number;
                x?: number;
                y?: number;
            } > ) {
                if (
                    typeof u.id !== "number" ||
                    consumedGeyserUnitIds.has( u.id ) ||
                    u.typeId !== VESPENE_GEYSER_TYPE_ID ||
                    typeof u.x !== "number" ||
                    typeof u.y !== "number"
                ) {
                    continue;
                }
                const dx = u.x - px;
                const dy = u.y - py;
                const distanceSq = dx * dx + dy * dy;
                if ( distanceSq > MAX_GEYSER_CENTER_DISTANCE_PX * MAX_GEYSER_CENTER_DISTANCE_PX ) continue;
                if ( !best || distanceSq < best.distanceSq ) {
                    best = { id: u.id, distanceSq };
                }
            }
            if ( !best ) return;
            // A refinery/extractor/assimilator replaces the neutral geyser in
            // StarCraft. In completed-render mode we create the building but
            // the map's neutral geyser sprite remains, so it can draw over the
            // building. Remove only the matched neutral unit after the resource
            // building exists; layout still keeps the original resource coords.
            openBW.get_util_funcs().remove_unit( best.id );
            consumedGeyserUnitIds.add( best.id );
        } catch ( err ) {
            console.warn( "[hermes-entity-bridge] failed to hide geyser under resource building:", err );
        }
    };

    const killByHermesId = ( hermesId: string ) => {
        const rec = installed.get( hermesId );
        if ( !rec ) return false;
        installed.delete( hermesId );
        behavior.unregister( hermesId );
        const unitId = rec.unitId ?? findUnitIdByAddress( rec.address );
        if ( unitId == null ) return false;
        try {
            openBW.get_util_funcs().kill_unit( unitId );
            return true;
        } catch {
            return false;
        }
    };

    /**
     * Hermes 2026-04 spawn-anything pass: spiral search offsets used by
     * the building placement search. Tries the exact tile first, then
     * a 1-tile, 2-tile, 3-tile, 4-tile ring (so we never wander more
     * than 4 tiles from the layout's preferred position).
     *
     * Used in two places:
     *   1) To find a `_can_place_building_at`-valid tile for a
     *      "polite" spawn that respects engine placement rules
     *      (preferred when possible — gives the building a real
     *      grounded foundation, mineral-line clearance, etc).
     *   2) As the search radius for `_create_completed_unit_at`
     *      bypass spawns when no polite tile exists in 4 tiles.
     */
    const TILE = 32;
    // Completed-render placement is allowed to move farther than a live
    // player would. Search beyond the full map diagonal from any requested
    // point so dense bases keep producing buildings instead of skips or
    // marine stand-ins.
    const MAX_BUILDING_SEARCH_RADIUS_TILES = Math.max(
        64,
        mapWidthTiles * 2,
        mapHeightTiles * 2
    );
    const SPIRAL_OFFSETS: Array< [ number, number ] > = ( () => {
        const out: Array< [ number, number ] > = [ [ 0, 0 ] ];
        for ( let r = 1; r <= MAX_BUILDING_SEARCH_RADIUS_TILES; r++ ) {
            for ( let dy = -r; dy <= r; dy++ ) {
                for ( let dx = -r; dx <= r; dx++ ) {
                    if ( Math.abs( dx ) === r || Math.abs( dy ) === r ) {
                        out.push( [ dx * TILE, dy * TILE ] );
                    }
                }
            }
        }
        return out;
    } )();

    /** Stats counter for the per-batch creation report. */
    const createStats = {
        firstChoiceOk: 0,
        politeSearchOk: 0,
        forceCompletedOk: 0,
        triggerCreateOk: 0,
        marineFallback: 0,
        totalFail: 0,
    };

    /**
     * Hermes 2026-04 spawn-anything pass v6: monotonic counter so each
     * marine fallback lands in its own unit_finder cell (avoid stacking
     * 30+ marines on the same px,py which crashes `_generate_frame`).
     */
    let fallbackSpiralCursor = 0;

    /**
     * The legacy wasm build has no placement validator exports. In that
     * mode, issuing behavior-loop orders (`issue_command`) to Hermes-
     * spawned/adopted units is not reliable: after a few frames the engine
     * can OOB in pathing / plugin payload generation. Keep legacy units
     * passive. Re-enable behavior only on the rebuilt wasm where we can
     * validate building placement before spawning.
     */
    const behaviorOrdersEnabled = true;

    // Hermes 2026-04 live dashboard stability pass:
    // `_create_unit` can return a non-zero address for buildings and some
    // special units, but the next live OpenBW tick corrupts the unit table
    // and cascades into `_next_frame` / `_generate_frame` OOB reads. The
    // all-races integration demo proved that `_create_completed_unit_at`
    // renders every requested asset correctly as long as the engine stays
    // paused. Use that render-first path for the dashboard so the map opens
    // with visible, correctly-typed units and buildings.
    const createCompletedUnitAt = openBW._create_completed_unit_at;
    const renderOnlyCompletedSpawns = typeof createCompletedUnitAt === "function";

    if ( renderOnlyCompletedSpawns ) {
        try {
            ( globalThis as Record< string, unknown > ).__hermesCompletedRenderMode = true;
            openBW.setSandboxMode?.( true );
            openBW.setPaused?.( true );
            console.log(
                "[hermes-entity-bridge][trace] completed-unit render mode enabled; OpenBW sandbox is paused before Hermes placement"
            );
        } catch ( err ) {
            console.warn(
                "[hermes-entity-bridge][trace] failed to pause OpenBW before placement:",
                err
            );
        }
    }

    // Hermes 2026-04 spawn-iter-link fix: in paused mode the engine's
    // `_can_place_building_at` check is computed from a pre-batch
    // tile-occupancy snapshot, so it can't see prior bridge placements
    // in the SAME batch. As a result, multiple `_create_completed_unit_at`
    // calls would happily land at overlapping tile cells; the engine
    // allocates the unit memory and returns a non-zero address but does
    // NOT link the unit into the per-player intrusive list, so it never
    // renders and never appears in `iterators.units`. We mirror the
    // engine's tile occupancy on the JS side and skip tiles already
    // claimed by an earlier completed-spawn within the same dashboard
    // session. Tracked at full unit footprint with a 1-tile clearance.
    const occupiedTiles: Set< string > = new Set();
    const pendingMorphByAddress = new Map< number, number >();
    const tileKey = ( tx: number, ty: number ) => `${tx},${ty}`;
    // Tile-snap helper: building anchors must be on the 32-px tile grid.
    const snapTile = ( v: number ) => Math.round( v / TILE ) * TILE;
    const CREEP_TILE_FLAG = 0x40;
    const TILE_FLAG_UNBUILDABLE = 0x80;
    const TILE_FLAG_PARTIALLY_WALKABLE = 0x2000;
    const ZERG_BUILDING_CREEP_BUFFER_TILES = 3;
    const ZERG_CREEP_BRIDGE_GAP_TILES = 3;
    const paintedCreepOriginalFlags = new Map< number, number >();
    const zergCreepSourceRects: Array< { left: number; top: number; right: number; bottom: number } > = [];
    let creepTilesPaintedThisBatch = 0;
    const completedFootprintForType = ( typeId: number ): { w: number; h: number } => {
        switch ( typeId ) {
            case 0x6a: // Command Center
            case 0x6f: // Barracks
            case 0x71: // Factory
            case 0x72: // Starport
            case 0x74: // Science Facility
            case 0x7a: // Engineering Bay
            case 0x83: // Hatchery
            case 0x84: // Lair
            case 0x85: // Hive
            case 0x9a: // Nexus
            case 0x9b: // Robotics Facility
            case 0xa0: // Gateway
            case 0xa7: // Stargate
                return { w: 5, h: 4 };
            case 0x6e: // Refinery
            case 0x95: // Extractor
            case 0x9d: // Assimilator
                return { w: 4, h: 2 };
            case 0x6d: // Supply Depot
            case 0x70: // Academy
            case 0x7b: // Armory
            case 0x7d: // Bunker
            case 0x8e: // Spawning Pool
            case 0x87: // Hydralisk Den
            case 0x8b: // Evolution Chamber
            case 0x8d: // Spire
            case 0x89: // Greater Spire
            case 0x8a: // Queen's Nest
            case 0x88: // Defiler Mound
            case 0x8c: // Ultralisk Cavern
            case 0x9f: // Observatory
            case 0xa5: // Templar Archives
            case 0xa6: // Forge
            case 0xa4: // Cybernetics Core
            case 0xa9: // Fleet Beacon
            case 0xaa: // Arbiter Tribunal
            case 0xab: // Robotics Support Bay
                return { w: 3, h: 2 };
            case 0x7c: // Missile Turret
            case 0x6b: // Comsat
            case 0x6c: // Nuclear Silo
            case 0x73: // Control Tower
            case 0x78: // Machine Shop
            case 0x75: // Covert Ops
            case 0x76: // Physics Lab
            case 0x86: // Nydus Canal
            case 0x8f: // Creep Colony
            case 0x90: // Spore Colony
            case 0x92: // Sunken Colony
            case 0x9c: // Pylon
            case 0xa2: // Photon Cannon
            case 0xac: // Shield Battery
                return { w: 2, h: 2 };
            default:
                return { w: 1, h: 1 };
        }
    };
    const tileBlockIsClearForFootprint = (
        cx: number,
        cy: number,
        footprint: { w: number; h: number }
    ): boolean => {
        const cTileX = Math.floor( cx / TILE );
        const cTileY = Math.floor( cy / TILE );
        const halfX = Math.floor( footprint.w / 2 );
        const halfY = Math.floor( footprint.h / 2 );
        for ( let ty = cTileY - halfY; ty <= cTileY + halfY; ty++ ) {
            for ( let tx = cTileX - halfX; tx <= cTileX + halfX; tx++ ) {
                if ( occupiedTiles.has( tileKey( tx, ty ) ) ) return false;
            }
        }
        return true;
    };
    const claimTileBlockForFootprint = (
        cx: number,
        cy: number,
        footprint: { w: number; h: number }
    ): void => {
        const cTileX = Math.floor( cx / TILE );
        const cTileY = Math.floor( cy / TILE );
        const halfX = Math.floor( footprint.w / 2 );
        const halfY = Math.floor( footprint.h / 2 );
        for ( let ty = cTileY - halfY; ty <= cTileY + halfY; ty++ ) {
            for ( let tx = cTileX - halfX; tx <= cTileX + halfX; tx++ ) {
                occupiedTiles.add( tileKey( tx, ty ) );
            }
        }
    };
    const tileRectForFootprint = (
        px: number,
        py: number,
        footprint: { w: number; h: number },
        paddingTiles = 0
    ) => {
        const cTileX = Math.floor( px / TILE );
        const cTileY = Math.floor( py / TILE );
        const left = cTileX - Math.floor( footprint.w / 2 ) - paddingTiles;
        const top = cTileY - Math.floor( footprint.h / 2 ) - paddingTiles;
        return {
            left,
            top,
            right: left + footprint.w - 1 + paddingTiles * 2,
            bottom: top + footprint.h - 1 + paddingTiles * 2,
        };
    };
    const tileFlagsView = (): Uint16Array | null => {
        const ptr = openBW.getTilesPtr?.();
        const size = openBW.getTilesSize?.();
        if (
            !openBW.HEAPU16 ||
            typeof ptr !== "number" ||
            typeof size !== "number" ||
            ptr <= 0 ||
            size <= 0
        ) {
            return null;
        }
        return openBW.HEAPU16.subarray( ptr >> 1, ( ptr >> 1 ) + size * 2 );
    };
    const clearPaintedCreep = (): void => {
        const tiles = tileFlagsView();
        if ( !tiles ) return;
        for ( const [ tilePos, originalFlags ] of paintedCreepOriginalFlags ) {
            const flagsIndex = tilePos * 2 + 1;
            if ( flagsIndex >= 0 && flagsIndex < tiles.length ) {
                tiles[flagsIndex] = originalFlags;
            }
        }
        paintedCreepOriginalFlags.clear();
        zergCreepSourceRects.length = 0;
        creepTilesPaintedThisBatch = 0;
    };
    const resourceAllowsCreep = ( tx: number, ty: number ): boolean => {
        for ( const resource of resources ) {
            const rect = resourceCreepRect( resource );
            if (
                tx >= rect.left &&
                tx <= rect.right &&
                ty >= rect.top &&
                ty <= rect.bottom
            ) {
                return true;
            }
        }
        return false;
    };
    const resourceCreepRect = ( resource: ResourcePatch ) =>
        tileRectForFootprint(
            resource.px,
            resource.py,
            resource.type === "gas" ? { w: 4, h: 2 } : { w: 2, h: 1 },
            1
        );
    const rectsOverlap = (
        a: { left: number; top: number; right: number; bottom: number },
        b: { left: number; top: number; right: number; bottom: number }
    ): boolean =>
        !( a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top );
    const tileCanHaveCreep = ( tiles: Uint16Array, tx: number, ty: number ): boolean => {
        if ( tx < 0 || ty < 0 || tx >= mapWidthTiles || ty >= mapHeightTiles ) return false;
        if ( resourceAllowsCreep( tx, ty ) ) return true;
        const tilePos = ty * mapWidthTiles + tx;
        const flags = tiles[tilePos * 2 + 1] ?? 0;
        if ( flags & ( TILE_FLAG_UNBUILDABLE | TILE_FLAG_PARTIALLY_WALKABLE ) ) {
            return false;
        }
        if ( ty < mapHeightTiles - 1 ) {
            const belowFlags = tiles[( ( ty + 1 ) * mapWidthTiles + tx ) * 2 + 1] ?? 0;
            if ( belowFlags & TILE_FLAG_UNBUILDABLE ) return false;
        }
        return true;
    };
    const paintCreepRect = (
        tiles: Uint16Array,
        rect: { left: number; top: number; right: number; bottom: number }
    ): void => {
        for (
            let ty = Math.max( 0, rect.top );
            ty <= Math.min( mapHeightTiles - 1, rect.bottom );
            ty++
        ) {
            for (
                let tx = Math.max( 0, rect.left );
                tx <= Math.min( mapWidthTiles - 1, rect.right );
                tx++
            ) {
                if ( !tileCanHaveCreep( tiles, tx, ty ) ) continue;
                const tilePos = ty * mapWidthTiles + tx;
                const flagsIndex = tilePos * 2 + 1;
                if ( !paintedCreepOriginalFlags.has( tilePos ) ) {
                    paintedCreepOriginalFlags.set( tilePos, tiles[flagsIndex] );
                    creepTilesPaintedThisBatch++;
                }
                tiles[flagsIndex] = tiles[flagsIndex] | CREEP_TILE_FLAG;
            }
        }
    };
    const rememberZergCreepForBuilding = ( typeId: number, px: number, py: number ): void => {
        if ( !ZERG_BUILDING_TYPE_IDS.has( typeId ) ) return;
        zergCreepSourceRects.push( tileRectForFootprint(
            px,
            py,
            completedFootprintForType( typeId ),
            ZERG_BUILDING_CREEP_BUFFER_TILES
        ) );
    };
    const prepaintZergCreepForBuilding = ( typeId: number, px: number, py: number ): void => {
        if ( !ZERG_BUILDING_TYPE_IDS.has( typeId ) ) return;
        const tiles = tileFlagsView();
        if ( !tiles ) return;
        const rect = tileRectForFootprint(
            px,
            py,
            completedFootprintForType( typeId ),
            ZERG_BUILDING_CREEP_BUFFER_TILES
        );
        zergCreepSourceRects.push( rect );
        paintCreepRect( tiles, rect );
    };
    const rectGapTiles = (
        a: { left: number; top: number; right: number; bottom: number },
        b: { left: number; top: number; right: number; bottom: number }
    ): number => {
        const gapX =
            a.right < b.left ? b.left - a.right - 1 :
                b.right < a.left ? a.left - b.right - 1 :
                    0;
        const gapY =
            a.bottom < b.top ? b.top - a.bottom - 1 :
                b.bottom < a.top ? a.top - b.bottom - 1 :
                    0;
        return Math.max( gapX, gapY );
    };
    const paintRememberedZergCreep = (): void => {
        if ( zergCreepSourceRects.length === 0 ) return;
        const tiles = tileFlagsView();
        if ( !tiles ) return;
        const paintedRegions: Array< { left: number; top: number; right: number; bottom: number } > = [];
        for ( const rect of zergCreepSourceRects ) {
            paintCreepRect( tiles, rect );
            paintedRegions.push( rect );
        }
        for ( let i = 0; i < zergCreepSourceRects.length; i++ ) {
            for ( let j = i + 1; j < zergCreepSourceRects.length; j++ ) {
                const a = zergCreepSourceRects[i];
                const b = zergCreepSourceRects[j];
                if ( rectGapTiles( a, b ) > ZERG_CREEP_BRIDGE_GAP_TILES ) continue;
                const merged = {
                    left: Math.min( a.left, b.left ),
                    top: Math.min( a.top, b.top ),
                    right: Math.max( a.right, b.right ),
                    bottom: Math.max( a.bottom, b.bottom ),
                };
                paintCreepRect( tiles, merged );
                paintedRegions.push( merged );
            }
        }
        for ( const resource of resources ) {
            const rect = resourceCreepRect( resource );
            if ( paintedRegions.some( ( region ) => rectsOverlap( region, rect ) ) ) {
                paintCreepRect( tiles, rect );
            }
        }
    };
    const refreshCreepTexture = (): void => {
        if ( !params.creep || creepTilesPaintedThisBatch <= 0 || !openBW.HEAPU8 ) return;
        const ptr = openBW.getTilesPtr?.();
        const size = openBW.getTilesSize?.();
        if ( typeof ptr !== "number" || typeof size !== "number" || ptr <= 0 || size <= 0 ) {
            return;
        }
        try {
            const tiles = new SimpleBufferView( 4, ptr, size, openBW.HEAPU8 );
            params.creep.generateImmediate( tiles );
        } catch ( err ) {
            console.warn( "[hermes-entity-bridge] failed to refresh Zerg creep texture:", err );
        }
    };
    const buildingTypeIds = new Set(
        Array.from( BUILDING_SCTYPES )
            .map( ( scType ) => SC_TYPE_MAP[scType] )
            .filter( ( typeId ): typeId is number => typeof typeId === "number" && typeId >= 0 )
    );
    const tileFlagsPlacementBufferOk = ( typeId: number, px: number, py: number, paddingTiles = 2 ): boolean => {
        const tiles = tileFlagsView();
        if ( !tiles ) return false;
        const rect = tileRectForFootprint( px, py, completedFootprintForType( typeId ), paddingTiles );
        for ( let ty = rect.top; ty <= rect.bottom; ty++ ) {
            if ( ty < 0 || ty >= mapHeightTiles ) return false;
            for ( let tx = rect.left; tx <= rect.right; tx++ ) {
                if ( tx < 0 || tx >= mapWidthTiles ) return false;
                const tilePos = ty * mapWidthTiles + tx;
                const flags = tiles[tilePos * 2 + 1] ?? 0;
                const belowFlags = ty < mapHeightTiles - 1
                    ? tiles[( ( ty + 1 ) * mapWidthTiles + tx ) * 2 + 1] ?? 0
                    : TILE_FLAG_UNBUILDABLE;
                if ( flags & ( TILE_FLAG_UNBUILDABLE | TILE_FLAG_PARTIALLY_WALKABLE ) ) return false;
                if ( belowFlags & TILE_FLAG_UNBUILDABLE ) return false;
            }
        }
        return true;
    };
    const tileBlockTouchesResource = (
        cx: number,
        cy: number,
        footprint: { w: number; h: number },
        allowGas: boolean
    ): boolean => {
        const cTileX = Math.floor( cx / TILE );
        const cTileY = Math.floor( cy / TILE );
        const halfX = Math.floor( footprint.w / 2 ) + 1;
        const halfY = Math.floor( footprint.h / 2 ) + 1;
        for ( const resource of resources ) {
            if ( allowGas && resource.type === "gas" ) continue;
            const tx = Math.floor( resource.px / TILE );
            const ty = Math.floor( resource.py / TILE );
            if (
                tx >= cTileX - halfX &&
                tx <= cTileX + halfX &&
                ty >= cTileY - halfY &&
                ty <= cTileY + halfY
            ) {
                return true;
            }
        }
        return false;
    };

    const createCompleted = (
        typeId: number,
        rawPx: number,
        rawPy: number,
        exactOnly = false,
        ignoreOccupied = false
    ): { address: number; px: number; py: number; mode: "completed" | "fail" } => {
        if ( !createCompletedUnitAt ) {
            return { address: 0, px: rawPx, py: rawPy, mode: "fail" };
        }
        // Snap to tile grid first - building positions are tile-aligned
        // in BW and unaligned input gets quantized internally anyway,
        // causing two "different" requested positions to collide.
        const px = snapTile( rawPx );
        const py = snapTile( rawPy );
        // `_create_completed_unit_at` accepts a unit's CENTER position.
        // Claim an approximate footprint per type: large buildings reserve
        // clearance, but mobile workers only reserve their own tile so SCVs
        // can sit at the mineral/gas line instead of being swept far away.
        const footprint = completedFootprintForType( typeId );
        const isBuildingType = buildingTypeIds.has( typeId );
        const isResourceBuildingType = RESOURCE_BUILDING_TYPE_IDS.has( typeId );
        const validationTypeId = terrainValidatorTypeId( typeId );
        // Keep completed building correction local. The layout already did
        // the wider connected-terrain search; a spawn-time whole-map sweep can
        // visually jump buildings across cliffs or to another base.
        const buildingSweepRadiusTiles = Math.min(
            MAX_BUILDING_SEARCH_RADIUS_TILES,
            Math.max( 48, Math.ceil( Math.max( mapWidthTiles, mapHeightTiles ) * 0.5 ) )
        );
        const sweep: Array< [ number, number ] > = exactOnly
            ? [ [ 0, 0 ] ]
            : isBuildingType && !isResourceBuildingType
                ? SPIRAL_OFFSETS.filter( ( [ dx, dy ] ) =>
                    Math.max( Math.abs( dx ), Math.abs( dy ) ) <= buildingSweepRadiusTiles * TILE
                )
                : SPIRAL_OFFSETS;
        const tileBlockHasTerrainBuffer = ( cx: number, cy: number, paddingTiles = 2 ): boolean => {
            const tiles = tileFlagsView();
            if ( !tiles ) return true;
            const rect = tileRectForFootprint( cx, cy, footprint, paddingTiles );
            for ( let ty = rect.top; ty <= rect.bottom; ty++ ) {
                if ( ty < 0 || ty >= mapHeightTiles ) return false;
                for ( let tx = rect.left; tx <= rect.right; tx++ ) {
                    if ( tx < 0 || tx >= mapWidthTiles ) return false;
                    const tilePos = ty * mapWidthTiles + tx;
                    const flags = tiles[tilePos * 2 + 1] ?? 0;
                    const belowFlags = ty < mapHeightTiles - 1
                        ? tiles[( ( ty + 1 ) * mapWidthTiles + tx ) * 2 + 1] ?? 0
                        : TILE_FLAG_UNBUILDABLE;
                    if ( flags & ( TILE_FLAG_UNBUILDABLE | TILE_FLAG_PARTIALLY_WALKABLE ) ) return false;
                    if ( belowFlags & TILE_FLAG_UNBUILDABLE ) return false;
                }
            }
            return true;
        };
        const mobileTerrainOk = ( cx: number, cy: number ): boolean => {
            if ( isBuildingType || FLYING_TYPE_IDS.has( typeId ) ) return true;
            const tiles = tileFlagsView();
            if ( !tiles ) return true;
            const tileX = Math.floor( cx / TILE );
            const tileY = Math.floor( cy / TILE );
            if ( tileX < 0 || tileY < 0 || tileX >= mapWidthTiles || tileY >= mapHeightTiles ) return false;
            const tilePos = tileY * mapWidthTiles + tileX;
            const flags = tiles[tilePos * 2 + 1] ?? 0;
            if ( flags & ( TILE_FLAG_UNBUILDABLE | TILE_FLAG_PARTIALLY_WALKABLE ) ) return false;
            if ( tileY < mapHeightTiles - 1 ) {
                const belowFlags = tiles[( ( tileY + 1 ) * mapWidthTiles + tileX ) * 2 + 1] ?? 0;
                if ( belowFlags & TILE_FLAG_UNBUILDABLE ) return false;
            }
            return true;
        };

        const isTileBlockClear = ( cx: number, cy: number ): boolean => {
            return tileBlockIsClearForFootprint( cx, cy, footprint );
        };
        const claimTileBlock = ( cx: number, cy: number ): void => {
            claimTileBlockForFootprint( cx, cy, footprint );
        };

        const positionForCreatedAddress = ( address: number ): { px: number; py: number; unitId: number } | null => {
            try {
                for ( const u of openBW.iterators.units as unknown as Iterable< {
                    id: number;
                    x?: number;
                    y?: number;
                    _address?: number;
                } > ) {
                    if (
                        u._address === address &&
                        typeof u.x === "number" &&
                        typeof u.y === "number"
                    ) {
                        return { px: u.x, py: u.y, unitId: u.id };
                    }
                }
            } catch {
                /* fall back to requested position */
            }
            return null;
        };
        const writeCreatedPosition = ( address: number, px: number, py: number ): void => {
            if ( !openBW.HEAP32 || address <= 0 ) return;
            const unitAddr32 = ( address >> 2 ) + 2;
            openBW.HEAP32[unitAddr32 + 16] = px;
            openBW.HEAP32[unitAddr32 + 17] = py;
            const spriteAddr = openBW.HEAPU32?.[unitAddr32 + 1];
            if ( typeof spriteAddr === "number" && spriteAddr > 0 ) {
                const spriteAddr32 = ( spriteAddr >> 2 ) + 2;
                openBW.HEAP32[spriteAddr32 + 10] = px;
                openBW.HEAP32[spriteAddr32 + 11] = py;
            }
        };

        let firstThrowReported = false;
        let createCompletedCallsBeforeSuccess = 0;
        for ( const [ dx, dy ] of sweep ) {
            const tx = px + dx;
            const ty = py + dy;
            if (
                isBuildingType &&
                !isResourceBuildingType &&
                tileBlockTouchesResource( tx, ty, footprint, false )
            ) {
                continue;
            }
            if ( !mobileTerrainOk( tx, ty ) ) continue;
            if (
                isBuildingType &&
                !isResourceBuildingType &&
                !tileBlockHasTerrainBuffer( tx, ty )
            ) {
                continue;
            }
            if (
                isBuildingType &&
                !isResourceBuildingType &&
                openBW._can_place_building_at
            ) {
                try {
                    if ( openBW._can_place_building_at( validationTypeId, TERRAIN_VALIDATION_OWNER, tx, ty ) !== 1 ) {
                        continue;
                    }
                } catch {
                    continue;
                }
            }
            // Skip JS-side already-claimed tile blocks BEFORE asking
            // the engine — saves us from getting an "orphan" address
            // back that never links into the player list.
            if ( !ignoreOccupied && !isTileBlockClear( tx, ty ) ) continue;
            try {
                createCompletedCallsBeforeSuccess++;
                let addr = 0;
                try {
                    addr = createCompletedUnitAt(
                        typeId,
                        hermesPlayerId,
                        tx,
                        ty
                    );
                } catch ( err ) {
                    if ( !firstThrowReported ) {
                        firstThrowReported = true;
                        console.warn(
                            `[hermes-entity-bridge][trace] completed spawn first-attempt threw type=${typeId} px=${px} py=${py} (will sweep neighbors):`,
                            err
                        );
                    }
                }
                if (
                    !addr &&
                    isBuildingType &&
                    !isResourceBuildingType &&
                    validationTypeId !== typeId &&
                    typeof openBW._morph_unit_at === "function"
                ) {
                    const hostAddr = createCompletedUnitAt(
                        validationTypeId,
                        hermesPlayerId,
                        tx,
                        ty
                    );
                    if ( hostAddr ) {
                        const hostUnitId =
                            positionForCreatedAddress( hostAddr )?.unitId ??
                            findUnitIdByAddress( hostAddr );
                        if ( hostUnitId != null && openBW._morph_unit_at( hostUnitId, typeId ) === 1 ) {
                            addr = hostAddr;
                            console.log(
                                `[hermes-entity-bridge][spawn] morphed host type=${validationTypeId} -> requested=${typeId} at (${tx},${ty})`
                            );
                        } else {
                            pendingMorphByAddress.set( hostAddr, typeId );
                            addr = hostAddr;
                            console.log(
                                `[hermes-entity-bridge][spawn] deferred morph host type=${validationTypeId} -> requested=${typeId} at (${tx},${ty})`
                            );
                        }
                    }
                }
                if ( addr ) {
                    if ( isBuildingType && !isResourceBuildingType ) {
                        writeCreatedPosition( addr, tx, ty );
                    }
                    const actual = isBuildingType && !isResourceBuildingType
                        ? { px: tx, py: ty, unitId: positionForCreatedAddress( addr )?.unitId ?? -1 }
                        : positionForCreatedAddress( addr ) ?? { px: tx, py: ty, unitId: -1 };
                    if (
                        isBuildingType &&
                        !isResourceBuildingType &&
                        !tileBlockHasTerrainBuffer( actual.px, actual.py )
                    ) {
                        try {
                            const id = actual.unitId >= 0 ? actual.unitId : findUnitIdByAddress( addr );
                            if ( id != null ) openBW.get_util_funcs().remove_unit( id );
                        } catch {
                            /* ignore remove failure and keep searching */
                        }
                        continue;
                    }
                    if ( !ignoreOccupied && !isTileBlockClear( actual.px, actual.py ) ) {
                        try {
                            const id = actual.unitId >= 0 ? actual.unitId : findUnitIdByAddress( addr );
                            if ( id != null ) openBW.get_util_funcs().remove_unit( id );
                        } catch {
                            /* ignore remove failure and keep searching */
                        }
                        continue;
                    }
                    claimTileBlock( actual.px, actual.py );
                    if ( createCompletedCallsBeforeSuccess > 1 ) {
                        console.log(
                            `[hermes-entity-bridge][spawn] type=${typeId} requested=(${px},${py}) -> placed=(${actual.px},${actual.py}) addr=${addr} (after ${createCompletedCallsBeforeSuccess} sweep attempts)`
                        );
                    }
                    if ( isResourceBuildingType ) {
                        hideGeyserUnderResourceBuilding( actual.px, actual.py );
                    }
                    return { address: addr, px: actual.px, py: actual.py, mode: "completed" };
                }
            } catch ( err ) {
                if ( !firstThrowReported ) {
                    firstThrowReported = true;
                    // Only log the first throw per type so the console
                    // doesn't get spammed when the engine rejects every
                    // tile in the sweep (e.g. unbuildable mineral line).
                    console.warn(
                        `[hermes-entity-bridge][trace] completed spawn first-attempt threw type=${typeId} px=${px} py=${py} (will sweep neighbors):`,
                        err
                    );
                }
            }
        }
        // Final fallback: trigger path at the original position. This is
        // sometimes accepted even when `_create_completed_unit_at` rejected
        // the entire sweep (different engine validation path).
        if ( isBuildingType ) {
            for ( const [ dx, dy ] of sweep ) {
                const tx = px + dx;
                const ty = py + dy;
                if ( !isResourceBuildingType && tileBlockTouchesResource( tx, ty, footprint, false ) ) continue;
                if ( !isResourceBuildingType && !tileBlockHasTerrainBuffer( tx, ty ) ) continue;
                if ( !ignoreOccupied && !isTileBlockClear( tx, ty ) ) continue;
                if ( !isResourceBuildingType && openBW._can_place_building_at ) {
                    try {
                        if ( openBW._can_place_building_at( validationTypeId, TERRAIN_VALIDATION_OWNER, tx, ty ) !== 1 ) {
                            continue;
                        }
                    } catch {
                        continue;
                    }
                }
                try {
                    const addr = openBW._create_unit(
                        typeId,
                        hermesPlayerId,
                        tx,
                        ty
                    );
                    if ( addr ) {
                        claimTileBlock( tx, ty );
                        if ( isResourceBuildingType ) {
                            hideGeyserUnderResourceBuilding( tx, ty );
                        }
                        console.log(
                            `[hermes-entity-bridge][spawn] paused trigger building rendered type=${typeId} requested=(${px},${py}) -> placed=(${tx},${ty})`
                        );
                        return { address: addr, px: tx, py: ty, mode: "completed" };
                    }
                } catch ( err ) {
                    if ( !firstThrowReported ) {
                        console.warn(
                            `[hermes-entity-bridge][trace] paused trigger building first failure type=${typeId} px=${tx} py=${ty}:`,
                            err
                        );
                        firstThrowReported = true;
                    }
                }
            }
            return { address: 0, px, py, mode: "fail" };
        }
        try {
            const addr = openBW._create_unit(
                typeId,
                hermesPlayerId,
                px,
                py
            );
            if ( addr ) {
                console.log(
                    `[hermes-entity-bridge][trace] paused trigger fallback rendered exact type=${typeId} px=${px} py=${py}`
                );
                return { address: addr, px, py, mode: "completed" };
            }
        } catch ( err ) {
            console.warn(
                `[hermes-entity-bridge][trace] paused trigger fallback failed type=${typeId} px=${px} py=${py}:`,
                err
            );
        }
        return { address: 0, px, py, mode: "fail" };
    };

    /**
     * Hermes 2026-04 spawn-anything pass: build a placement search
     * function. When `_can_place_building_at` is exposed by the WASM
     * (rebuilt titan.wasm), we try to find a *polite* tile within 4
     * tiles of the requested position before falling back to the
     * `_create_completed_unit_at` bypass. On the legacy WASM (no
     * `_can_place_building_at`), we skip the polite search and go
     * straight to bypass.
     */
    const findValidBuildingTile = (
        typeId: number,
        px: number,
        py: number,
        ownerId = hermesPlayerId
    ): { px: number; py: number } | null => {
        const canPlace = openBW._can_place_building_at;
        if ( !canPlace ) return null;
        const validationTypeId = terrainValidatorTypeId( typeId );
        for ( const [ dx, dy ] of SPIRAL_OFFSETS ) {
            try {
                if ( canPlace( validationTypeId, ownerId, px + dx, py + dy ) === 1 ) {
                    return { px: px + dx, py: py + dy };
                }
            } catch {
                /* swallow & try next */
            }
        }
        return null;
    };

    /**
     * Hermes 2026-04 spawn-anything pass (v5 — STABLE marine-only on
     * legacy wasm, polite on rebuilt wasm).
     *
     * Lessons learned the hard way:
     *   1) Bypass spawns (`_create_completed_unit_at`) crash
     *      `_next_frame` instantly because the new unit is not in
     *      `unit_finder`. REMOVED.
     *   2) "Trigger-spiral" — calling `_create_unit` directly at
     *      every spiral offset on the legacy wasm — *appears* to
     *      succeed (returns non-zero), but the buildings it places
     *      crash `_next_frame` ~10 seconds later (the order handler
     *      hits a vector OOB walking some not-fully-initialized
     *      building list). REMOVED.
     *   3) The ONLY paths the live engine reliably tolerates on the
     *      legacy wasm are:
     *        a) the trigger path with a JS-side pre-validation via
     *           `_can_place_building_at` (rebuilt wasm only), or
     *        b) marine stand-ins (fully-initialized mobile units
     *           that the order handler always knows how to tick).
     *
     * Strategy:
     *   A) If `_can_place_building_at` is exposed (rebuilt wasm),
     *      spiral-search for a polite tile and `_create_unit` there.
     *   B) Otherwise: return mode="fail" immediately. The caller
     *      falls back to a marine stand-in.
     *
     * The dashboard will visually show marines instead of correct
     * building sprites on the legacy wasm — that's the cost of
     * stability. The fix for proper-typed buildings is to ship the
     * rebuilt wasm with the `_can_place_building_at` shim.
     */
    const spawnBuilding = (
        typeId: number,
        px: number,
        py: number,
        exactOnly = false
    ): { address: number; px: number; py: number; mode: "completed" | "polite" | "fail" } => {
        if ( renderOnlyCompletedSpawns ) {
            if ( RESOURCE_BUILDING_TYPE_IDS.has( typeId ) ) {
                return createCompleted( typeId, px, py, true );
            }
            if ( exactOnly ) {
                try {
                    if (
                        openBW._can_place_building_at &&
                        openBW._can_place_building_at( terrainValidatorTypeId( typeId ), TERRAIN_VALIDATION_OWNER, px, py ) !== 1
                    ) {
                        console.warn(
                            `[hermes-entity-bridge] edit placement rejected type=${typeId} px=${px} py=${py}; move to a valid buildable tile first`
                        );
                        return { address: 0, px, py, mode: "fail" };
                    }
                } catch {
                    return { address: 0, px, py, mode: "fail" };
                }
                return createCompleted( typeId, px, py, true, true );
            }
            const polite = findValidBuildingTile( typeId, px, py, TERRAIN_VALIDATION_OWNER );
            const target = polite ?? { px, py };
            return createCompleted( typeId, target.px, target.py );
        }

        const canPlace = openBW._can_place_building_at;
        if ( !canPlace ) return { address: 0, px, py, mode: "fail" };

        const polite = findValidBuildingTile( typeId, px, py );
        if ( polite ) {
            try {
                const addr = openBW._create_unit(
                    typeId,
                    hermesPlayerId,
                    polite.px,
                    polite.py
                );
                if ( addr ) {
                    return {
                        address: addr,
                        px: polite.px,
                        py: polite.py,
                        mode: "polite",
                    };
                }
            } catch {
                /* fall through to fail */
            }
        }
        return { address: 0, px, py, mode: "fail" };
    };

    /**
     * Hermes 2026-04 spawn-anything pass: spawn a mobile unit. Uses
     * the trigger path so the unit gets full pathing + AI init (so it
     * can take orders from the behavior loop). Falls back to a marine
     * at the same spot if the requested type is rejected (mostly
     * happens for spell summons that need a caster).
     */
    const spawnMobileUnit = (
        typeId: number,
        px: number,
        py: number
    ): { address: number; px: number; py: number; mode: "completed" | "trigger" | "marine" | "fail" } => {
        if ( renderOnlyCompletedSpawns ) {
            if ( typeId === 0x07 /* Terran SCV */ ) {
                try {
                    const addr = openBW._create_unit( typeId, hermesPlayerId, px, py );
                    if ( addr ) return { address: addr, px, py, mode: "trigger" };
                } catch {
                    /* fall through to completed path */
                }
            }
            return createCompleted( typeId, px, py );
        }

        try {
            const addr = openBW._create_unit( typeId, hermesPlayerId, px, py );
            if ( addr ) return { address: addr, px, py, mode: "trigger" };
        } catch {
            /* fall through */
        }
        const fallbackTypeId = SC_TYPE_MAP[currentRaceProfile.worker] ?? DEFAULT_UNIT_TYPE;
        if ( typeId !== fallbackTypeId ) {
            try {
                const addr = openBW._create_unit( fallbackTypeId, hermesPlayerId, px, py );
                if ( addr ) return { address: addr, px, py, mode: "marine" };
            } catch {
                /* fall through */
            }
        }
        return { address: 0, px, py, mode: "fail" };
    };

    /**
     * Spawn one entity at its laid-out position. Returns true if a
     * unit was created.
     */
    const spawnMarineFallback = (
        hermesId: string,
        scType: string,
        requestedTypeId: number,
        placement: PlacementResult
    ): { address: number; px: number; py: number; typeId: number } | null => {
        const fallbackTypeId = SC_TYPE_MAP[currentRaceProfile.worker] ?? DEFAULT_UNIT_TYPE;
        const fallbackTerrainOk = ( px: number, py: number ): boolean => {
            if ( FLYING_TYPE_IDS.has( fallbackTypeId ) ) return true;
            const tiles = tileFlagsView();
            if ( !tiles ) return true;
            const tileX = Math.floor( px / TILE );
            const tileY = Math.floor( py / TILE );
            if ( tileX < 0 || tileY < 0 || tileX >= mapWidthTiles || tileY >= mapHeightTiles ) return false;
            const tilePos = tileY * mapWidthTiles + tileX;
            const flags = tiles[tilePos * 2 + 1] ?? 0;
            if ( flags & ( TILE_FLAG_UNBUILDABLE | TILE_FLAG_PARTIALLY_WALKABLE ) ) return false;
            if ( tileY < mapHeightTiles - 1 ) {
                const belowFlags = tiles[( ( tileY + 1 ) * mapWidthTiles + tileX ) * 2 + 1] ?? 0;
                if ( belowFlags & TILE_FLAG_UNBUILDABLE ) return false;
            }
            return true;
        };
        const baseSafePx =
            typeof params.anchorPx === "number" ? params.anchorPx : placement.px;
        const baseSafePy =
            typeof params.anchorPy === "number" ? params.anchorPy : placement.py;
        for ( let attempt = 0; attempt < Math.min( SPIRAL_OFFSETS.length, 384 ); attempt++ ) {
            const [ dx, dy ] = SPIRAL_OFFSETS[( fallbackSpiralCursor + attempt ) % SPIRAL_OFFSETS.length];
            const safePx = baseSafePx + dx;
            const safePy = baseSafePy + dy;
            if ( safePx < TILE || safePy < TILE ) continue;
            if ( safePx > ( mapWidthTiles - 1 ) * TILE || safePy > ( mapHeightTiles - 1 ) * TILE ) continue;
            if ( !fallbackTerrainOk( safePx, safePy ) ) continue;
            try {
                const address = openBW._create_unit(
                    fallbackTypeId,
                    hermesPlayerId,
                    safePx,
                    safePy
                );
                if ( address ) {
                    fallbackSpiralCursor += attempt + 1;
                    createStats.marineFallback++;
                    console.warn(
                        `[hermes-entity-bridge][fallback] ${currentRaceProfile.worker} fallback for id=${hermesId} scType=${scType} requestedType=${requestedTypeId} requested=(${placement.px},${placement.py}) fallback=(${safePx},${safePy})`
                    );
                    placement.px = safePx;
                    placement.py = safePy;
                    return { address, px: safePx, py: safePy, typeId: fallbackTypeId };
                }
            } catch {
                /* try next fallback tile */
            }
        }
        return null;
    };

    const spawnAtPlacement = (
        entity: HermesEntityPayload,
        placement: PlacementResult
    ): boolean => {
        const typeIdRaw = SC_TYPE_MAP[ entity.scType ];
        if ( typeIdRaw === -1 ) return false;
        const typeId = typeIdRaw ?? DEFAULT_UNIT_TYPE;
        const isBuilding = BUILDING_SCTYPES.has( entity.scType );
        const isEditedPosition =
            entity.syntheticPlacement !== true &&
            typeof entity.editPx === "number" &&
            typeof entity.editPy === "number";
        if ( isBuilding ) {
            prepaintZergCreepForBuilding( typeId, placement.px, placement.py );
        }
        const result = isBuilding
            ? spawnBuilding( typeId, placement.px, placement.py, isEditedPosition )
            : spawnMobileUnit( typeId, placement.px, placement.py );
        let address = result.address;
        let actualTypeId = typeId;
        let usedMarineFallback = false;

        // Hermes 2026-04 spawn-anything pass v6 (spread-out passive
        // marine): when a polite-typed spawn fails, drop a marine
        // near the start-location anchor at a per-entity offset so
        // we don't pile every fallback marine into the SAME unit_finder
        // grid cell (~32 px). The engine's spatial index stores units
        // in a fixed-size bucket per cell, and overflowing it with
        // 30+ stacked marines is what triggers the
        // `_generate_frame` -> `_get_buffer(9)` OOB cascade.
        //
        // The marine is also DELIBERATELY NOT registered with the
        // behavior loop, so it just stands at the anchor. No move
        // orders -> no pathing -> no OOB. The dashboard sees a small
        // marine cluster instead of any unspawned entities, but the engine
        // stays alive.
        if ( !address ) {
            const fallback = spawnMarineFallback( entity.id, entity.scType, typeId, placement );
            if ( fallback ) {
                address = fallback.address;
                actualTypeId = fallback.typeId;
                usedMarineFallback = true;
            }
        } else if ( result.mode === "completed" ) {
            createStats.forceCompletedOk++;
            placement.px = result.px;
            placement.py = result.py;
        } else if ( result.mode === "polite" ) {
            createStats.politeSearchOk++;
            placement.px = result.px;
            placement.py = result.py;
        } else if ( result.mode === "trigger" ) {
            createStats.triggerCreateOk++;
        } else if ( result.mode === "marine" ) {
            actualTypeId = SC_TYPE_MAP[currentRaceProfile.worker] ?? DEFAULT_UNIT_TYPE;
            createStats.marineFallback++;
            usedMarineFallback = true;
            console.warn(
                `[hermes-entity-bridge][fallback] mobile ${currentRaceProfile.worker} fallback for id=${entity.id} scType=${entity.scType} requestedType=${typeId} at (${placement.px},${placement.py})`
            );
        }
        if ( !address ) {
            createStats.totalFail++;
            return false;
        }
        if (
            result.mode === "completed" ||
            result.mode === "trigger" ||
            result.mode === "marine"
        ) {
            createStats.firstChoiceOk++;
        }

        const unitId = findUnitIdByAddress( address );
        installed.set( entity.id, {
            address,
            unitId,
            spriteIndex: spriteIndexForUnitId( unitId ),
            typeId: actualTypeId,
            owner: hermesPlayerId,
            px: placement.px,
            py: placement.py,
            label: labelForEntity( entity, actualTypeId ),
            labelCategory: labelCategoryForEntity( entity ),
            placement,
        } );
        rememberZergCreepForBuilding( actualTypeId, placement.px, placement.py );
        publishUnitEntityMap();
        // CRITICAL: only register units we KNOW are on safe terrain
        // (placed via the polite path, OR placed at the start-location
        // anchor by the marine fallback). Others get no behavior
        // orders, so issue_command can never crash on them.
        if ( behaviorOrdersEnabled && unitId != null && !usedMarineFallback && !isBuilding ) {
            behavior.register( {
                hermesId: entity.id,
                unitId,
                typeId: actualTypeId,
                placement,
            } );
        }
        return true;
    };

    /**
     * Hermes 2026-04 base-layout fix: track which Hermes ids we've
     * already adopted to engine-spawned units (CC + SCVs). Adopted ids
     * are NOT re-spawned by `_create_unit` — they're re-registered with
     * the behaviour loop pointing at the existing unit so the engine's
     * own gather/build orders keep firing AND the dashboard can still
     * focus / select them via `hermesId`.
     */
    const adoptedHermesIds = new Set< string >();
    /**
     * Hermes 2026-04 base-layout fix: track which engine OpenBW unit
     * ids have been adopted by some Hermes entity, so a later Hermes
     * SCV-5 / SCV-6 can't re-claim engine SCV-1 just because the engine
     * iterator still lists it.
     */
    const adoptedEngineUnitIds = new Set< number >();

    const placeEntities = ( rawEntities: unknown[] ) => {
        const entities = rawEntities.filter(
            ( entity ): entity is HermesEntityPayload =>
                !!entity &&
                typeof entity === "object" &&
                typeof ( entity as HermesEntityPayload ).id === "string" &&
                typeof ( entity as HermesEntityPayload ).scType === "string"
        );
        const incoming = new Set< string >();
        const entityById = new Map(
            entities
                .filter( ( entity ) => entity && typeof entity.id === "string" )
                .map( ( entity ) => [ entity.id, entity ] as const )
        );
        let spawned = 0,
            updated = 0,
            killed = 0,
            skipped = 0,
            adopted = 0;
        // Reset per-batch counters so the periodic log is meaningful.
        createStats.firstChoiceOk = 0;
        createStats.politeSearchOk = 0;
        createStats.forceCompletedOk = 0;
        createStats.triggerCreateOk = 0;
        createStats.marineFallback = 0;
        createStats.totalFail = 0;
        clearPaintedCreep();

        const raceProfile = inferRacePlacementProfile( entities );
        currentRaceProfile = raceProfile;

        // Hermes 2026-04 base-layout fix: every batch, refresh the
        // engine-spawned base scan. The CC pixel coords are the most
        // accurate anchor we have because the engine already validated
        // that area as buildable. Falls back to the explicit anchorPx /
        // anchorPy passed in by world-composer (= player start
        // location), and finally to undefined (= map center).
        let engineBase = findEngineSpawnedBase();
        if (
            raceProfile.core !== "CommandCenter" &&
            ( engineBase.existingCcUnitId != null || engineBase.existingScvs.length > 0 )
        ) {
            try {
                if ( engineBase.existingCcUnitId != null ) {
                    openBW.get_util_funcs().kill_unit( engineBase.existingCcUnitId );
                }
                for ( const scv of engineBase.existingScvs ) {
                    openBW.get_util_funcs().kill_unit( scv.unitId );
                }
            } catch ( err ) {
                console.warn( "[hermes-entity-bridge] failed to remove Terran starting units for selected race:", err );
            }
            engineBase = findEngineSpawnedBase();
        }

        // Hermes 2026-04 spawn-anything pass v5 (bypass-free, polite-only):
        // try to spawn a CC through the safe POLITE path only — only on
        // the rebuilt wasm where we have `_can_place_building_at`. On
        // legacy wasm we trust the engine to have already placed a CC at
        // the start location, and skip this fallback rather than risk a
        // 10-second-delayed _next_frame crash from a CC the engine
        // accepted but couldn't fully integrate.
        const canPlaceCc = openBW._can_place_building_at;
        if (
            raceProfile.core === "CommandCenter" &&
            !renderOnlyCompletedSpawns &&
            engineBase.existingCcUnitId == null &&
            canPlaceCc &&
            typeof params.anchorPx === "number" &&
            typeof params.anchorPy === "number"
        ) {
            const ccTypeId = 0x6a; // Terran Command Center
            const TILE = 32;
            let placedAddr = 0;
            let placedPx = params.anchorPx;
            let placedPy = params.anchorPy;
            outer: for ( let r = 0; r <= 8; r++ ) {
                for ( let dy = -r; dy <= r; dy++ ) {
                    for ( let dx = -r; dx <= r; dx++ ) {
                        if ( r > 0 && Math.abs( dx ) !== r && Math.abs( dy ) !== r ) continue;
                        const px = params.anchorPx + dx * TILE;
                        const py = params.anchorPy + dy * TILE;
                        try {
                            if ( canPlaceCc( ccTypeId, hermesPlayerId, px, py ) !== 1 ) continue;
                        } catch {
                            continue;
                        }
                        try {
                            const addr = openBW._create_unit(
                                ccTypeId,
                                hermesPlayerId,
                                px,
                                py
                            );
                            if ( addr ) {
                                placedAddr = addr;
                                placedPx = px;
                                placedPy = py;
                                break outer;
                            }
                        } catch {
                            /* try next tile */
                        }
                    }
                }
            }
            if ( placedAddr ) {
                console.log(
                    `[hermes-entity-bridge] polite-spawned CC for player ${hermesPlayerId} at px=${placedPx} py=${placedPy} (engine had none, anchor was ${params.anchorPx}/${params.anchorPy})`
                );
                engineBase = findEngineSpawnedBase();
            } else {
                console.warn(
                    `[hermes-entity-bridge] could not politely place CC within 8 tiles of anchor px=${params.anchorPx} py=${params.anchorPy}; leaving player ${hermesPlayerId} without a CC`
                );
            }
        } else if (
            !renderOnlyCompletedSpawns &&
            engineBase.existingCcUnitId == null
        ) {
            console.warn(
                `[hermes-entity-bridge] no engine CC found for player ${hermesPlayerId} and rebuilt wasm not present (need _can_place_building_at to safely place one); skipping`
            );
        } else if (
            renderOnlyCompletedSpawns &&
            engineBase.existingCcUnitId == null
        ) {
            console.log(
                "[hermes-entity-bridge][trace] no engine CC found; force-spawned Command Center will be rendered through completed-unit placement"
            );
        }

        // Hermes 2026-04 spawn-anything pass: same idea for SCVs — most
        // melee CHKs don't ship starting workers either, so force-spawn
        // a small worker line if there are none. Uses the trigger path
        // (mobile unit needs pathing init).
        if (
            !renderOnlyCompletedSpawns &&
            engineBase.existingScvs.length === 0 &&
            typeof params.anchorPx === "number" &&
            typeof params.anchorPy === "number"
        ) {
            const STARTING_WORKERS = 4;
            const workerTypeId = SC_TYPE_MAP[raceProfile.worker] ?? 0x07;
            for ( let i = 0; i < STARTING_WORKERS; i++ ) {
                try {
                    const angle = ( i / STARTING_WORKERS ) * Math.PI * 2;
                    const r = 96; // 3 tiles out from CC center
                    openBW._create_unit(
                        workerTypeId,
                        hermesPlayerId,
                        params.anchorPx + Math.round( Math.cos( angle ) * r ),
                        params.anchorPy + Math.round( Math.sin( angle ) * r )
                    );
                } catch {
                    /* swallow */
                }
            }
            console.log(
                `[hermes-entity-bridge] force-spawned ${STARTING_WORKERS} starting ${raceProfile.worker}s for player ${hermesPlayerId}`
            );
            engineBase = findEngineSpawnedBase();
        } else if (
            renderOnlyCompletedSpawns &&
            engineBase.existingScvs.length === 0
        ) {
            console.log(
                "[hermes-entity-bridge][trace] no engine SCVs found; SCVs will be rendered through completed-unit placement"
            );
        }

        const anchorPx =
            engineBase.ccPx ?? params.anchorPx;
        const anchorPy =
            engineBase.ccPy ?? params.anchorPy;
        const terrainAnchorPx =
            typeof anchorPx === "number" ? anchorPx : Math.round( ( mapWidthTiles * TILE ) / 2 );
        const terrainAnchorPy =
            typeof anchorPy === "number" ? anchorPy : Math.round( ( mapHeightTiles * TILE ) / 2 );

        const refineryEntityCount = entities.filter(
            ( e ) => e?.scType && RESOURCE_BUILDING_SCTYPES.has( e.scType )
        ).length;
        const GAS_RADIUS_FROM_CC_PX = 24 * TILE;
        const gasResourcesByDistance = resources
            .filter( ( r ) => r.type === "gas" )
            .map( ( r ) => {
                const dx = typeof anchorPx === "number" ? r.px - anchorPx : 0;
                const dy = typeof anchorPy === "number" ? r.py - anchorPy : 0;
                return {
                    resource: r,
                    distanceSq: dx * dx + dy * dy,
                };
            } )
            .sort( ( a, b ) => {
                return a.distanceSq - b.distanceSq;
            } );
        const nearbyGasResources = gasResourcesByDistance
            .filter( ( r ) => r.distanceSq <= GAS_RADIUS_FROM_CC_PX * GAS_RADIUS_FROM_CC_PX )
            .map( ( r ) => r.resource );
        const nearestGasResources = [
            ...nearbyGasResources,
            ...gasResourcesByDistance
                .map( ( r ) => r.resource )
                .filter( ( r ) => !nearbyGasResources.includes( r ) ),
        ].slice( 0, Math.max( 2, refineryEntityCount ) );
        const layoutResources = [
            ...resources.filter( ( r ) => r.type === "mineral" ),
            ...nearestGasResources,
        ];
        const syntheticRefineries: HermesEntityPayload[] = nearestGasResources
            .slice( refineryEntityCount )
            .map( ( r, i ) => ( {
                id: `__hermes_refinery_${i}`,
                scType: raceProfile.refinery,
                x: r.px,
                y: 0,
                z: r.py,
                label: raceProfile.refinery,
            } ) );
        const workerEntityCount = entities.filter(
            ( e ) => e?.scType === raceProfile.worker
        ).length;
        const mineralCount = layoutResources.filter( ( r ) => r.type === "mineral" ).length;
        const gasCount = layoutResources.filter( ( r ) => r.type === "gas" ).length;
        const minimumScvs = Math.min(
            8,
            Math.max(
                workerEntityCount,
                gasCount > 0 ? Math.max( 8, Math.min( mineralCount, 4 ) * 2 ) : 4
            )
        );
        const syntheticWorkers: HermesEntityPayload[] = Array.from(
            { length: Math.max( 0, minimumScvs - workerEntityCount ) },
            ( _, i ) => ( {
                id: `__hermes_worker_${i}`,
                scType: raceProfile.worker,
                x: anchorPx ?? 0,
                y: 0,
                z: anchorPy ?? 0,
                label: raceProfile.worker,
            } )
        );
        const syntheticEntities = [ ...syntheticRefineries, ...syntheticWorkers ];
        let entitiesToPlace = syntheticEntities.length > 0
            ? [ ...entities, ...syntheticEntities ]
            : entities;
        const incomingEntityIds = new Set(
            entitiesToPlace
                .filter( ( entity ) => entity && typeof entity.id === "string" )
                .filter( ( entity ) => SC_TYPE_MAP[entity.scType] !== -1 )
                .map( ( entity ) => entity.id )
        );

        // Keep the JS-side completed-spawn occupancy mirror batch-accurate.
        // A stale footprint from a previous race/layout batch can otherwise
        // make valid Zerg spawns fail and cascade into Marine fallback.
        for ( const id of Array.from( installed.keys() ) ) {
            if ( incomingEntityIds.has( id ) ) continue;
            if ( adoptedHermesIds.has( id ) ) {
                const rec = installed.get( id );
                if ( rec?.unitId != null ) adoptedEngineUnitIds.delete( rec.unitId );
                installed.delete( id );
                behavior.unregister( id );
                adoptedHermesIds.delete( id );
                publishUnitEntityMap();
                continue;
            }
            if ( killByHermesId( id ) ) killed++;
        }
        occupiedTiles.clear();

        // Compute the full layout fresh on each batch. Stable thanks to
        // the LCG seed, so the camera doesn't see the base spontaneously
        // re-arrange itself when an unrelated entity is added.
        let shapes: HermesEntityShape[] = entitiesToPlace
            .filter( ( e ): e is HermesEntityPayload => !!e && typeof e.id === "string" )
            .filter( ( e ) => SC_TYPE_MAP[e.scType] !== -1 )
            .map( ( e ) => ( { id: e.id, scType: e.scType } ) );
        // Hermes 2026-04 deeper rebuild: when the rebuilt titan.wasm is
        // present, ask the engine to validate every candidate placement
        // against actual buildable terrain. Falls back to no-validation
        // on the legacy wasm so the bridge still works in mixed
        // environments.
        const canPlace = (
            openBW as unknown as {
                _can_place_building_at?: (
                    typeId: number,
                    owner: number,
                    px: number,
                    py: number
                ) => number;
            }
        )._can_place_building_at;
        const validatePlacement = canPlace
            ? ( params: { unitTypeId: number; px: number; py: number } ) => {
                try {
                    return canPlace(
                        terrainValidatorTypeId( params.unitTypeId ),
                        renderOnlyCompletedSpawns ? TERRAIN_VALIDATION_OWNER : hermesPlayerId,
                        params.px,
                        params.py
                    ) === 1;
                } catch {
                    return false;
                }
            }
            : undefined;
        type PlacementTerrainGrid = {
            passable: Uint8Array;
            componentIds: Int32Array;
            edgeDistance: Int16Array;
        };
        const terrainGridCache = new Map< string, PlacementTerrainGrid >();
        const TERRAIN_SAMPLE_RADIUS_TILES = Math.min(
            56,
            Math.max( 24, Math.ceil( Math.max( mapWidthTiles, mapHeightTiles ) / 3 ) )
        );
        const terrainGridFor = ( unitTypeId: number ): PlacementTerrainGrid | null => {
            const tiles = tileFlagsView();
            if ( !canPlace && !tiles ) return null;
            const validationTypeId = terrainValidatorTypeId( unitTypeId );
            const ownerId = renderOnlyCompletedSpawns ? TERRAIN_VALIDATION_OWNER : hermesPlayerId;
            const cacheKey = `${validationTypeId}:${ownerId}`;
            const cached = terrainGridCache.get( cacheKey );
            if ( cached ) return cached;

            const tileCount = mapWidthTiles * mapHeightTiles;
            const passable = new Uint8Array( tileCount );
            const componentIds = new Int32Array( tileCount );
            const edgeDistance = new Int16Array( tileCount );
            componentIds.fill( -1 );
            edgeDistance.fill( 0 );

            const anchorTileX = Math.max(
                0,
                Math.min( mapWidthTiles - 1, Math.round( terrainAnchorPx / TILE ) )
            );
            const anchorTileY = Math.max(
                0,
                Math.min( mapHeightTiles - 1, Math.round( terrainAnchorPy / TILE ) )
            );
            const sampleLeft = Math.max( 0, anchorTileX - TERRAIN_SAMPLE_RADIUS_TILES );
            const sampleRight = Math.min( mapWidthTiles - 1, anchorTileX + TERRAIN_SAMPLE_RADIUS_TILES );
            const sampleTop = Math.max( 0, anchorTileY - TERRAIN_SAMPLE_RADIUS_TILES );
            const sampleBottom = Math.min( mapHeightTiles - 1, anchorTileY + TERRAIN_SAMPLE_RADIUS_TILES );

            for ( let ty = 0; ty < mapHeightTiles; ty++ ) {
                if ( ty < sampleTop || ty > sampleBottom ) continue;
                for ( let tx = 0; tx < mapWidthTiles; tx++ ) {
                    if ( tx < sampleLeft || tx > sampleRight ) continue;
                    const tilePos = ty * mapWidthTiles + tx;
                    if ( tiles ) {
                        const flags = tiles[tilePos * 2 + 1] ?? 0;
                        const belowFlags = ty < mapHeightTiles - 1
                            ? tiles[( ( ty + 1 ) * mapWidthTiles + tx ) * 2 + 1] ?? 0
                            : TILE_FLAG_UNBUILDABLE;
                        passable[tilePos] =
                            flags & ( TILE_FLAG_UNBUILDABLE | TILE_FLAG_PARTIALLY_WALKABLE ) ||
                            belowFlags & TILE_FLAG_UNBUILDABLE
                                ? 0
                                : 1;
                    } else {
                        if ( !canPlace ) continue;
                        try {
                            passable[tilePos] =
                                canPlace( validationTypeId, ownerId, tx * TILE, ty * TILE ) === 1 ? 1 : 0;
                        } catch {
                            passable[tilePos] = 0;
                        }
                    }
                }
            }

            let nextComponentId = 0;
            const queue = new Int32Array( tileCount );
            for ( let i = 0; i < tileCount; i++ ) {
                if ( !passable[i] || componentIds[i] !== -1 ) continue;
                let head = 0;
                let tail = 0;
                componentIds[i] = nextComponentId;
                queue[tail++] = i;
                while ( head < tail ) {
                    const cur = queue[head++];
                    const x = cur % mapWidthTiles;
                    const y = Math.floor( cur / mapWidthTiles );
                    const neighbors = [
                        x > 0 ? cur - 1 : -1,
                        x < mapWidthTiles - 1 ? cur + 1 : -1,
                        y > 0 ? cur - mapWidthTiles : -1,
                        y < mapHeightTiles - 1 ? cur + mapWidthTiles : -1,
                    ];
                    for ( const next of neighbors ) {
                        if ( next < 0 || !passable[next] || componentIds[next] !== -1 ) continue;
                        componentIds[next] = nextComponentId;
                        queue[tail++] = next;
                    }
                }
                nextComponentId++;
            }

            let head = 0;
            let tail = 0;
            for ( let i = 0; i < tileCount; i++ ) {
                const x = i % mapWidthTiles;
                const y = Math.floor( i / mapWidthTiles );
                const leftPassable = x > 0 && passable[i - 1] === 1;
                const rightPassable = x < mapWidthTiles - 1 && passable[i + 1] === 1;
                const topPassable = y > 0 && passable[i - mapWidthTiles] === 1;
                const bottomPassable = y < mapHeightTiles - 1 && passable[i + mapWidthTiles] === 1;
                const touchesInvalid =
                    passable[i] !== 1 ||
                    x === 0 ||
                    y === 0 ||
                    x === mapWidthTiles - 1 ||
                    y === mapHeightTiles - 1 ||
                    !leftPassable ||
                    !rightPassable ||
                    !topPassable ||
                    !bottomPassable;
                if ( touchesInvalid ) {
                    edgeDistance[i] = 0;
                    queue[tail++] = i;
                } else {
                    edgeDistance[i] = 32767;
                }
            }
            while ( head < tail ) {
                const cur = queue[head++];
                const x = cur % mapWidthTiles;
                const y = Math.floor( cur / mapWidthTiles );
                const nextDistance = edgeDistance[cur] + 1;
                const neighbors = [
                    x > 0 ? cur - 1 : -1,
                    x < mapWidthTiles - 1 ? cur + 1 : -1,
                    y > 0 ? cur - mapWidthTiles : -1,
                    y < mapHeightTiles - 1 ? cur + mapWidthTiles : -1,
                ];
                for ( const next of neighbors ) {
                    if ( next < 0 || passable[next] !== 1 || edgeDistance[next] <= nextDistance ) continue;
                    edgeDistance[next] = nextDistance;
                    queue[tail++] = next;
                }
            }

            const grid = { passable, componentIds, edgeDistance };
            terrainGridCache.set( cacheKey, grid );
            return grid;
        };
        const footprintRectForType = ( typeId: number, px: number, py: number, paddingTiles = 0 ) => {
            const footprint = completedFootprintForType( typeId );
            const cTileX = Math.round( px / TILE );
            const cTileY = Math.round( py / TILE );
            const left = cTileX - Math.floor( footprint.w / 2 ) - paddingTiles;
            const top = cTileY - Math.floor( footprint.h / 2 ) - paddingTiles;
            return {
                left,
                top,
                right: left + footprint.w - 1 + paddingTiles * 2,
                bottom: top + footprint.h - 1 + paddingTiles * 2,
            };
        };
        const bufferedPlacementOk = (
            unitTypeId: number,
            px: number,
            py: number,
            paddingTiles: number
        ): boolean => {
            const grid = terrainGridFor( unitTypeId );
            if ( !grid ) return validatePlacement?.( { unitTypeId, px, py } ) ?? false;
            if ( !( validatePlacement?.( { unitTypeId, px, py } ) ?? false ) ) return false;
            const rect = footprintRectForType( unitTypeId, px, py, paddingTiles );
            for ( let ty = rect.top; ty <= rect.bottom; ty++ ) {
                if ( ty < 0 || ty >= mapHeightTiles ) return false;
                for ( let tx = rect.left; tx <= rect.right; tx++ ) {
                    if ( tx < 0 || tx >= mapWidthTiles ) return false;
                    if ( grid.passable[ty * mapWidthTiles + tx] !== 1 ) return false;
                }
            }
            return true;
        };
        const analyzePlacement = ( canPlace || tileFlagsView() )
            ? ( params: { scType?: string; unitTypeId: number; px: number; py: number } ) => {
                const grid = terrainGridFor( params.unitTypeId );
                const tx = Math.max(
                    0,
                    Math.min( mapWidthTiles - 1, Math.round( params.px / TILE ) )
                );
                const ty = Math.max(
                    0,
                    Math.min( mapHeightTiles - 1, Math.round( params.py / TILE ) )
                );
                const tileIndex = ty * mapWidthTiles + tx;
                const isBuildingShape = BUILDING_SCTYPES.has( params.scType ?? "" );
                const ok = RESOURCE_BUILDING_SCTYPES.has( params.scType ?? "" )
                    ? validatePlacement?.( params ) ?? false
                    : isBuildingShape
                        ? bufferedPlacementOk( params.unitTypeId, params.px, params.py, 2 )
                        : grid?.passable[tileIndex] === 1;
                return {
                    ok,
                    componentId: ok && grid ? grid.componentIds[tileIndex] : null,
                    edgeClearanceTiles: ok && grid ? grid.edgeDistance[tileIndex] : 0,
                };
            }
            : undefined;

        const computeLayout = ( currentShapes: HermesEntityShape[] ) => computeBaseLayout( currentShapes, {
            mapWidthTiles,
            mapHeightTiles,
            centerPx: anchorPx,
            centerPy: anchorPy,
            seed: layoutSeed,
            resources: layoutResources,
            validatePlacement,
            analyzePlacement,
            scTypeToUnitTypeId: SC_TYPE_MAP,
        } );
        let layout = computeLayout( shapes );

        if ( raceProfile.core === "Nexus" ) {
            const isProtossPowerConsumer = ( scType: string ): boolean =>
                PROTOSS_BUILDING_SCTYPES.has( scType ) && scType !== "Pylon";
            const hasPylonPower = ( placement: PlacementResult ): boolean =>
                shapes.some( ( shape ) => {
                    if ( shape.scType !== "Pylon" ) return false;
                    const pylon = layout.get( shape.id );
                    return !!pylon &&
                        Math.hypot( pylon.px - placement.px, pylon.py - placement.py ) <= PROTOSS_POWER_RADIUS_PX;
                } );

            for ( let pylonIndex = 0; pylonIndex < PROTOSS_POWER_MAX_SYNTHETIC_PYLONS; pylonIndex++ ) {
                const uncovered = shapes
                    .filter( ( shape ) => isProtossPowerConsumer( shape.scType ) )
                    .map( ( shape ) => ( { shape, placement: layout.get( shape.id ) } ) )
                    .filter( ( item ): item is { shape: HermesEntityShape; placement: PlacementResult } =>
                        !!item.placement && !hasPylonPower( item.placement )
                    );
                if ( uncovered.length === 0 ) break;

                let bestCluster = uncovered.slice( 0, 1 );
                for ( const seed of uncovered ) {
                    const cluster = uncovered.filter( ( item ) =>
                        Math.hypot(
                            item.placement.px - seed.placement.px,
                            item.placement.py - seed.placement.py
                        ) <= PROTOSS_POWER_RADIUS_PX * 2
                    );
                    if ( cluster.length > bestCluster.length ) bestCluster = cluster;
                }
                const editPx = Math.round(
                    bestCluster.reduce( ( sum, item ) => sum + item.placement.px, 0 ) / bestCluster.length
                );
                const editPy = Math.round(
                    bestCluster.reduce( ( sum, item ) => sum + item.placement.py, 0 ) / bestCluster.length
                );
                const syntheticPylon: HermesEntityPayload = {
                    id: `__hermes_pylon_${pylonIndex}`,
                    scType: "Pylon",
                    x: editPx,
                    y: 0,
                    z: editPy,
                    editPx,
                    editPy,
                    label: "Power Pylon",
                    syntheticPlacement: true,
                };
                entitiesToPlace = [ ...entitiesToPlace, syntheticPylon ];
                shapes = [
                    ...shapes,
                    { id: syntheticPylon.id, scType: "Pylon", editPx, editPy },
                ];
                layout = computeLayout( shapes );
            }
        }

        for ( const entity of entitiesToPlace ) {
            if ( !entity || typeof entity.id !== "string" ) continue;
            const existing = installed.get( entity.id );
            if ( !existing ) continue;
            const placement = layout.get( entity.id );
            const wantType = SC_TYPE_MAP[entity.scType] ?? DEFAULT_UNIT_TYPE;
            if ( wantType !== existing.typeId ) continue;
            if (
                placement &&
                ( Math.abs( placement.px - existing.px ) > 1 ||
                    Math.abs( placement.py - existing.py ) > 1 )
            ) {
                continue;
            }
            claimTileBlockForFootprint(
                existing.px,
                existing.py,
                completedFootprintForType( existing.typeId )
            );
        }

        // Hermes 2026-04 base-layout fix: queue of engine-spawned SCVs
        // we can adopt for incoming "SCV" entities (in priority order:
        // closest to the engine CC first). Mutated below as each Hermes
        // SCV claims one. Excludes engine units that have already been
        // adopted in a previous batch.
        const adoptableScvs = engineBase.existingScvs.filter(
            ( s ) => !adoptedEngineUnitIds.has( s.unitId )
        );

        for ( const entity of entitiesToPlace ) {
            if ( !entity || typeof entity.id !== "string" ) continue;
            if ( SC_TYPE_MAP[ entity.scType ] === -1 ) continue;
            incoming.add( entity.id );

            const placement = layout.get( entity.id );
            if ( !placement ) {
                skipped++;
                continue;
            }

            // ── Hermes 2026-04 base-layout fix: adopt engine units ─────
            // First Hermes "CommandCenter" -> the engine's auto-placed
            // CC at the player start location. The user clicks it and
            // sees a real Command Center, not a battlecruiser stand-in.
            if (
                entity.scType === "CommandCenter" &&
                engineBase.existingCcUnitId != null &&
                engineBase.existingCcAddress != null &&
                !adoptedEngineUnitIds.has( engineBase.existingCcUnitId ) &&
                !adoptedHermesIds.has( entity.id ) &&
                !installed.has( entity.id )
            ) {
                adoptedHermesIds.add( entity.id );
                adoptedEngineUnitIds.add( engineBase.existingCcUnitId );
                placement.px = engineBase.ccPx ?? placement.px;
                placement.py = engineBase.ccPy ?? placement.py;
                installed.set( entity.id, {
                    address: engineBase.existingCcAddress,
                    unitId: engineBase.existingCcUnitId,
                    spriteIndex: spriteIndexForUnitId( engineBase.existingCcUnitId ),
                    typeId: 0x6a,
                    owner: hermesPlayerId,
                    px: placement.px,
                    py: placement.py,
                    label: labelForEntity( entity, 0x6a ),
                    labelCategory: labelCategoryForEntity( entity ),
                    placement,
                } );
                if ( behaviorOrdersEnabled ) {
                    behavior.register( {
                        hermesId: entity.id,
                        unitId: engineBase.existingCcUnitId,
                        typeId: 0x6a,
                        placement,
                    } );
                }
                adopted++;
                continue;
            }

            // First N Hermes "SCV" entities (where N = number of
            // engine-spawned SCVs at the start location, usually 4) ->
            // adopt the existing SCVs. They already have engine-issued
            // gather orders, so they'll keep harvesting without us
            // having to re-issue anything.
            if (
                entity.scType === "SCV" &&
                adoptableScvs.length > 0 &&
                !adoptedHermesIds.has( entity.id ) &&
                !installed.has( entity.id )
            ) {
                const scv = adoptableScvs.shift()!;
                adoptedHermesIds.add( entity.id );
                adoptedEngineUnitIds.add( scv.unitId );
                placement.px = scv.px;
                placement.py = scv.py;
                installed.set( entity.id, {
                    address: scv.address,
                    unitId: scv.unitId,
                    spriteIndex: spriteIndexForUnitId( scv.unitId ),
                    typeId: 0x07,
                    owner: hermesPlayerId,
                    px: scv.px,
                    py: scv.py,
                    label: labelForEntity( entity, 0x07 ),
                    labelCategory: labelCategoryForEntity( entity ),
                    placement,
                } );
                if ( behaviorOrdersEnabled ) {
                    behavior.register( {
                        hermesId: entity.id,
                        unitId: scv.unitId,
                        typeId: 0x07,
                        placement,
                    } );
                }
                adopted++;
                continue;
            }

            const wantType = SC_TYPE_MAP[ entity.scType ] ?? DEFAULT_UNIT_TYPE;
            const isBuilding = BUILDING_SCTYPES.has( entity.scType );
            const existing = installed.get( entity.id );
            if ( existing ) {
                existing.label = labelForEntity( entity, existing.typeId );
                existing.labelCategory = labelCategoryForEntity( entity );
                // Re-spawn only if the type changed (cheap & robust). We
                // intentionally don't re-spawn on position drift — once the
                // base is laid out, units stay at their post and the
                // behavior loop animates them.
                const positionChanged =
                    Math.abs( placement.px - existing.px ) > 1 ||
                    Math.abs( placement.py - existing.py ) > 1;
                if (
                    isBuilding &&
                    wantType === existing.typeId &&
                    positionChanged
                ) {
                    moveInstalledUnit( existing, placement.px, placement.py );
                    existing.px = placement.px;
                    existing.py = placement.py;
                    existing.placement = placement;
                    rememberZergCreepForBuilding( existing.typeId, existing.px, existing.py );
                    updated++;
                    publishUnitEntityMap();
                    continue;
                }
                if ( wantType !== existing.typeId || positionChanged ) {
                    if ( killByHermesId( entity.id ) ) killed++;
                    if ( spawnAtPlacement( entity, placement ) ) updated++;
                    else skipped++;
                } else if ( existing.unitId == null ) {
                    // First-frame after spawn, the unit_id wasn't
                    // resolvable yet. Try again so the behavior loop can
                    // pick it up.
                    const unitId = findUnitIdByAddress( existing.address );
                    if ( unitId != null ) {
                        existing.unitId = unitId;
                        existing.spriteIndex = spriteIndexForUnitId( unitId );
                        if ( behaviorOrdersEnabled ) {
                            behavior.register( {
                                hermesId: entity.id,
                                unitId,
                                typeId: existing.typeId,
                                placement: existing.placement,
                            } );
                        }
                    }
                }
                rememberZergCreepForBuilding( existing.typeId, existing.px, existing.py );
                continue;
            }
            if ( spawnAtPlacement( entity, placement ) ) spawned++;
            else skipped++;
        }

        // Remove any previously-installed entities the parent no longer
        // sends. Iterate over a snapshot so killByHermesId can mutate.
        // Hermes 2026-04 base-layout fix: NEVER kill an adopted engine
        // unit (CC / SCV) — those belong to the engine, killing them
        // would crash the melee init. Just unregister the bridge entry.
        for ( const id of Array.from( installed.keys() ) ) {
            if ( incoming.has( id ) ) continue;
            if ( adoptedHermesIds.has( id ) ) {
                const rec = installed.get( id );
                if ( rec?.unitId != null ) adoptedEngineUnitIds.delete( rec.unitId );
                installed.delete( id );
                behavior.unregister( id );
                adoptedHermesIds.delete( id );
                publishUnitEntityMap();
                continue;
            }
            if ( killByHermesId( id ) ) killed++;
        }

        if ( renderOnlyCompletedSpawns ) {
            try {
                openBW.setSandboxMode?.( true );
                openBW.setPaused?.( true );
                openBW.generateFrame?.();
                let postFrameRejectedBuildings = 0;
                for ( const [ hermesId, rec ] of Array.from( installed.entries() ) ) {
                    if (
                        !buildingTypeIds.has( rec.typeId ) ||
                        RESOURCE_BUILDING_TYPE_IDS.has( rec.typeId )
                    ) {
                        continue;
                    }
                    let actual: { px: number; py: number; unitId: number } | null = null;
                    try {
                        for ( const unit of openBW.iterators.units as unknown as Iterable< {
                            id: number;
                            x?: number;
                            y?: number;
                            _address?: number;
                        } > ) {
                            if (
                                ( rec.unitId != null ? unit.id === rec.unitId : unit._address === rec.address ) &&
                                typeof unit.x === "number" &&
                                typeof unit.y === "number"
                            ) {
                                actual = { px: unit.x, py: unit.y, unitId: unit.id };
                                break;
                            }
                        }
                    } catch {
                        actual = null;
                    }
                    if ( !actual || tileFlagsPlacementBufferOk( rec.typeId, actual.px, actual.py, 2 ) ) {
                        const pendingMorphType = pendingMorphByAddress.get( rec.address );
                        if (
                            pendingMorphType != null &&
                            actual &&
                            typeof openBW._morph_unit_at === "function"
                        ) {
                            try {
                                if ( openBW._morph_unit_at( actual.unitId, pendingMorphType ) === 1 ) {
                                    pendingMorphByAddress.delete( rec.address );
                                }
                            } catch {
                                /* try again next batch */
                            }
                        }
                        continue;
                    }
                    postFrameRejectedBuildings++;
                    try {
                        openBW.get_util_funcs().remove_unit( actual.unitId );
                    } catch {
                        /* fall through to replacing the bridge record */
                    }
                    installed.delete( hermesId );
                    behavior.unregister( hermesId );
                    const entity = entityById.get( hermesId );
                    const replacement = spawnBuilding( rec.typeId, rec.placement.px, rec.placement.py, false );
                    if ( replacement.address ) {
                        rec.placement.px = replacement.px;
                        rec.placement.py = replacement.py;
                        const unitId = findUnitIdByAddress( replacement.address );
                        installed.set( hermesId, {
                            address: replacement.address,
                            unitId,
                            spriteIndex: spriteIndexForUnitId( unitId ),
                            typeId: rec.typeId,
                            owner: hermesPlayerId,
                            px: replacement.px,
                            py: replacement.py,
                            label: entity ? labelForEntity( entity, rec.typeId ) : rec.label,
                            labelCategory: entity ? labelCategoryForEntity( entity ) : rec.labelCategory,
                            placement: rec.placement,
                        } );
                    } else {
                        console.warn(
                            `[hermes-entity-bridge][trace] post-frame rejected building could not be relocated id=${hermesId} type=${rec.typeId}; leaving it unspawned instead of worker fallback`
                        );
                        skipped++;
                    }
                }
                if ( postFrameRejectedBuildings > 0 ) {
                    console.warn(
                        `[hermes-entity-bridge][trace] post-frame rejected ${postFrameRejectedBuildings} completed buildings that violated terrain buffer`
                    );
                }
                openBW.generateFrame?.();
                paintRememberedZergCreep();
                refreshCreepTexture();
                const installedRecs = Array.from( installed.values() );
                const focusRec =
                    installedRecs.find( ( rec ) => rec.typeId === 0x6a ) ??
                    installedRecs[0];
                const vp = params.viewControllerComposer?.viewports?.[0];
                const orbit = vp?.orbit;
                if ( focusRec && params.pxToWorld && orbit?.moveTo ) {
                    const bounds = installedRecs.reduce(
                        ( acc, rec ) => ( {
                            minPx: Math.min( acc.minPx, rec.px ),
                            maxPx: Math.max( acc.maxPx, rec.px ),
                            minPy: Math.min( acc.minPy, rec.py ),
                            maxPy: Math.max( acc.maxPy, rec.py ),
                        } ),
                        {
                            minPx: focusRec.px,
                            maxPx: focusRec.px,
                            minPy: focusRec.py,
                            maxPy: focusRec.py,
                        }
                    );
                    const centerPx = focusRec.px;
                    const centerPy = focusRec.py;
                    const spanPx = Math.max(
                        bounds.maxPx - bounds.minPx,
                        bounds.maxPy - bounds.minPy
                    );
                    const overviewDistance = Math.max(
                        180,
                        Math.min( 280, Math.round( spanPx / 6 ) )
                    );
                    const tmp = new Vector3();
                    params.pxToWorld.xyz( centerPx, centerPy, tmp );
                    orbit.moveTo.call( orbit, tmp.x, tmp.y, tmp.z, false );
                    orbit.dollyTo?.call( orbit, overviewDistance, false );
                    configureOrbitForCcZoom( orbit, overviewDistance );
                    console.log(
                        `[hermes-entity-bridge][trace] camera centered on CC px=${centerPx} py=${centerPy} distance=${overviewDistance} span=${spanPx} zoom=enabled pan=locked`
                    );
                }
                console.log(
                    `[hermes-entity-bridge][trace] generated paused completed-unit frame: live=${installed.size} spawned=${spawned} adopted=${adopted} skipped=${skipped}`
                );
            } catch ( err ) {
                console.warn(
                    "[hermes-entity-bridge][trace] paused generateFrame after placement failed:",
                    err
                );
            }
        }

        publishUnitEntityMap();
        return { spawned, updated, killed, skipped, adopted };
    };

    /**
     * Pan the camera to the given Hermes entity and (if a SceneComposer was
     * supplied) select the underlying OpenBW unit so the existing
     * `selected-units-changed` event fires.
     *
     * Resilient: missing dependencies => silently no-op so the bridge still
     * works in test harnesses.
     */
    const focusByHermesId = ( hermesId: string ): boolean => {
        const rec = installed.get( hermesId );
        if ( !rec ) return false;
        // Refresh unitId in case it wasn't resolvable on the spawn frame.
        if ( rec.unitId == null ) {
            const id = findUnitIdByAddress( rec.address );
            if ( id != null ) rec.unitId = id;
        }

        const vp = params.viewControllerComposer?.viewports?.[0];
        const orbit = vp?.orbit;
        const moveTo = orbit?.moveTo;
        if ( !cameraLocked() && params.pxToWorld && moveTo ) {
            try {
                const tmp = new Vector3();
                params.pxToWorld.xyz( rec.px, rec.py, tmp );
                // animate=true so the camera glides instead of snapping —
                // visually clearer that "this entity is here".
                moveTo.call( orbit, tmp.x, tmp.y, tmp.z, true );
            } catch ( err ) {
                console.warn( "[hermes-entity-bridge] focus moveTo failed:", err );
            }
        }

        // Select the unit so the dashboard's TitanUnitInspector pops up via
        // the existing `selected-units-changed` -> `titan:selected-units`
        // postMessage path.
        if (
            params.sceneComposer?.units?.get &&
            typeof params.sceneComposer?.selectedUnits?.set === "function" &&
            rec.unitId != null
        ) {
            try {
                const unit = params.sceneComposer.units.get( rec.unitId );
                if ( unit ) {
                    ( params.sceneComposer.selectedUnits.set as ( units: FocusableUnit[] ) => void )( [ unit ] );
                }
            } catch ( err ) {
                console.warn(
                    "[hermes-entity-bridge] focus select failed:",
                    err
                );
            }
        }
        return true;
    };

    const onMessage = ( ev: MessageEvent ) => {
        const data = ev.data as
            | { type?: string; entities?: HermesEntityPayload[]; id?: string }
            | null;
        if ( !data || typeof data !== "object" ) return;
        if ( data.type === "hermes:entities" ) {
            if ( !Array.isArray( data.entities ) ) return;
            const notifyParentApplied = ( ok: boolean ) => {
                const send = () => {
                    try {
                        window.parent?.postMessage(
                            { type: "titan:hermes-entities-applied", ok },
                            "*"
                        );
                    } catch {
                        /* non-fatal */
                    }
                };
                // Defer two frames so the map and first sprites can present before
                // the parent enables "Reload Titan" (avoids a flash on the base
                // loading screen).
                requestAnimationFrame( () => {
                    requestAnimationFrame( send );
                } );
            };
            try {
                const r = placeEntities( data.entities );
                console.log(
                    `[hermes-entity-bridge] placed: spawned=${r.spawned} updated=${r.updated} killed=${r.killed} skipped=${r.skipped} adopted=${r.adopted} live=${installed.size} resources=${resources.length} | create-stats: politeSearch=${createStats.politeSearchOk} forceCompleted=${createStats.forceCompletedOk} triggerCreate=${createStats.triggerCreateOk} marineFallback=${createStats.marineFallback} totalFail=${createStats.totalFail}`
                );
                notifyParentApplied( true );
            } catch ( err ) {
                console.warn(
                    "[hermes-entity-bridge] placeEntities failed:",
                    err
                );
                notifyParentApplied( false );
            }
            return;
        }
        if ( data.type === "hermes:focus-entity" && typeof data.id === "string" ) {
            try {
                const ok = focusByHermesId( data.id );
                if ( !ok ) {
                    console.warn(
                        `[hermes-entity-bridge] focus: no installed unit for hermesId=${data.id}`
                    );
                }
            } catch ( err ) {
                console.warn(
                    "[hermes-entity-bridge] focusByHermesId failed:",
                    err
                );
            }
            return;
        }
    };

    window.addEventListener( "message", onMessage );

    const dispose = () => {
        window.removeEventListener( "message", onMessage );
        // Best-effort kill of all installed units so a re-install starts
        // clean — but do NOT touch adopted engine units (CC + starting
        // SCVs). Those belong to the engine and killing them would
        // crash the melee init / break the auto-issued gather orders.
        for ( const id of Array.from( installed.keys() ) ) {
            if ( adoptedHermesIds.has( id ) ) {
                installed.delete( id );
                behavior.unregister( id );
                continue;
            }
            killByHermesId( id );
        }
        installed.clear();
        adoptedHermesIds.clear();
        adoptedEngineUnitIds.clear();
        labelOverlay.dispose();
        behavior.dispose();
    };

    const state = () => {
        const types: Record< number, number > = {};
        for ( const v of installed.values() ) {
            types[v.typeId] = ( types[v.typeId] ?? 0 ) + 1;
        }
        return { units: installed.size, types, behavior: behavior.state() };
    };

    return { placeEntities, focusByHermesId, dispose, state };
};
