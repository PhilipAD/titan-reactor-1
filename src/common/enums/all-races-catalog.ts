/**
 * Hermes 2026-04 spawn-anything pass: comprehensive entity catalog
 * for ALL THREE StarCraft Brood War races. Single source of truth
 * mapping the game's units / buildings / addons to the typeIds used
 * by the rebuilt OpenBW (`titan.wasm`) — verified against
 * `bwgame.h::UnitTypes` and `imbateam-openbw/bwenums.h`.
 *
 * Each entry includes:
 *   - typeId (decimal + hex) — the value `_create_unit` and
 *     `_create_completed_unit_at` accept
 *   - name — human-friendly label for the demo UI
 *   - race — Terran / Protoss / Zerg / Neutral
 *   - kind — unit / building / addon
 *   - footprint — tile WxH for buildings (1x1 for mobile units)
 *   - canTrigger — whether the safe `_create_unit` (trigger) path
 *     can spawn this on a flat melee map. Buildings that need
 *     creep / a geyser host return false here, in which case the
 *     demo falls back to `_create_completed_unit_at` (engine paused
 *     so no tick crash).
 *
 * Source list (verified against the user's 2026-04-28 reference):
 *   Terran 13 units + 12 buildings + 6 addons
 *   Protoss 14 units + 16 buildings
 *   Zerg 13 units + 14 buildings (Hatchery/Lair/Hive treated as
 *     three distinct buildings for the spawn demo)
 */

export type Race = "terran" | "protoss" | "zerg" | "neutral";
export type EntityKind = "unit" | "building" | "addon";

export interface EntityCatalogEntry {
    typeId: number;
    name: string;
    race: Race;
    kind: EntityKind;
    /** Tile footprint width (for buildings) or 1 (for mobile units). */
    footprintW: number;
    /** Tile footprint height (for buildings) or 1 (for mobile units). */
    footprintH: number;
    /**
     * True if `_create_unit` (the safe trigger path that inserts the
     * unit into the engine's unit_finder) can usually place this
     * type on a flat melee map. False for entries that need creep,
     * a geyser host, an addon-host building, or other special
     * placement context — those use the bypass shim in the demo
     * (with the engine paused so the missing unit_finder slot is
     * harmless).
     */
    canTrigger: boolean;
    /**
     * Notes useful for the demo / debug UI (e.g. why a unit is
     * unusual, what asset to expect). Free-form English.
     */
    note?: string;
}

export const TERRAN_ENTITIES: EntityCatalogEntry[] = [
    // ── workers + infantry ──────────────────────────────────────
    { typeId: 0x07, name: "SCV", race: "terran", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x00, name: "Marine", race: "terran", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x20, name: "Firebat", race: "terran", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x01, name: "Ghost", race: "terran", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x22, name: "Medic", race: "terran", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    // ── vehicles ────────────────────────────────────────────────
    { typeId: 0x02, name: "Vulture", race: "terran", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x05, name: "Siege Tank (Tank Mode)", race: "terran", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x1e, name: "Siege Tank (Siege Mode)", race: "terran", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true, note: "morphs from tank mode normally; demo spawns directly" },
    { typeId: 0x03, name: "Goliath", race: "terran", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    // ── air ─────────────────────────────────────────────────────
    { typeId: 0x08, name: "Wraith", race: "terran", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x0b, name: "Dropship", race: "terran", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x09, name: "Science Vessel", race: "terran", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x0c, name: "Battlecruiser", race: "terran", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x3a, name: "Valkyrie", race: "terran", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    // ── buildings ───────────────────────────────────────────────
    { typeId: 0x6a, name: "Command Center", race: "terran", kind: "building", footprintW: 4, footprintH: 3, canTrigger: true },
    { typeId: 0x6d, name: "Supply Depot", race: "terran", kind: "building", footprintW: 3, footprintH: 2, canTrigger: true },
    { typeId: 0x6e, name: "Refinery", race: "terran", kind: "building", footprintW: 4, footprintH: 2, canTrigger: false, note: "needs a geyser host on flat ground" },
    { typeId: 0x6f, name: "Barracks", race: "terran", kind: "building", footprintW: 4, footprintH: 3, canTrigger: true },
    { typeId: 0x7a, name: "Engineering Bay", race: "terran", kind: "building", footprintW: 4, footprintH: 3, canTrigger: true },
    { typeId: 0x70, name: "Academy", race: "terran", kind: "building", footprintW: 3, footprintH: 2, canTrigger: true },
    { typeId: 0x71, name: "Factory", race: "terran", kind: "building", footprintW: 4, footprintH: 3, canTrigger: true },
    { typeId: 0x72, name: "Starport", race: "terran", kind: "building", footprintW: 4, footprintH: 3, canTrigger: true },
    { typeId: 0x74, name: "Science Facility", race: "terran", kind: "building", footprintW: 4, footprintH: 3, canTrigger: true },
    { typeId: 0x7b, name: "Armory", race: "terran", kind: "building", footprintW: 3, footprintH: 2, canTrigger: true },
    { typeId: 0x7c, name: "Missile Turret", race: "terran", kind: "building", footprintW: 2, footprintH: 2, canTrigger: true },
    { typeId: 0x7d, name: "Bunker", race: "terran", kind: "building", footprintW: 3, footprintH: 2, canTrigger: true },
    // ── addons ──────────────────────────────────────────────────
    { typeId: 0x6b, name: "Comsat Station", race: "terran", kind: "addon", footprintW: 2, footprintH: 2, canTrigger: false, note: "addon needs CC host" },
    { typeId: 0x6c, name: "Nuclear Silo", race: "terran", kind: "addon", footprintW: 2, footprintH: 2, canTrigger: false, note: "addon needs CC host" },
    { typeId: 0x78, name: "Machine Shop", race: "terran", kind: "addon", footprintW: 2, footprintH: 2, canTrigger: false, note: "addon needs Factory host" },
    { typeId: 0x73, name: "Control Tower", race: "terran", kind: "addon", footprintW: 2, footprintH: 2, canTrigger: false, note: "addon needs Starport host" },
    { typeId: 0x76, name: "Physics Lab", race: "terran", kind: "addon", footprintW: 2, footprintH: 2, canTrigger: false, note: "addon needs Science Facility host" },
    { typeId: 0x75, name: "Covert Ops", race: "terran", kind: "addon", footprintW: 2, footprintH: 2, canTrigger: false, note: "addon needs Science Facility host" },
];

export const PROTOSS_ENTITIES: EntityCatalogEntry[] = [
    // ── ground units ────────────────────────────────────────────
    { typeId: 0x40, name: "Probe", race: "protoss", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x41, name: "Zealot", race: "protoss", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x42, name: "Dragoon", race: "protoss", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x43, name: "High Templar", race: "protoss", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x3d, name: "Dark Templar", race: "protoss", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x44, name: "Archon", race: "protoss", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true, note: "normally morphs from 2x High Templar" },
    { typeId: 0x3f, name: "Dark Archon", race: "protoss", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true, note: "normally morphs from 2x Dark Templar" },
    { typeId: 0x53, name: "Reaver", race: "protoss", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    // ── air units ───────────────────────────────────────────────
    { typeId: 0x54, name: "Observer", race: "protoss", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x45, name: "Shuttle", race: "protoss", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x46, name: "Scout", race: "protoss", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x3c, name: "Corsair", race: "protoss", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x48, name: "Carrier", race: "protoss", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x47, name: "Arbiter", race: "protoss", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    // ── buildings ───────────────────────────────────────────────
    { typeId: 0x9a, name: "Nexus", race: "protoss", kind: "building", footprintW: 4, footprintH: 3, canTrigger: true },
    { typeId: 0x9c, name: "Pylon", race: "protoss", kind: "building", footprintW: 2, footprintH: 2, canTrigger: true },
    { typeId: 0x9d, name: "Assimilator", race: "protoss", kind: "building", footprintW: 4, footprintH: 2, canTrigger: false, note: "needs a geyser host" },
    { typeId: 0xa0, name: "Gateway", race: "protoss", kind: "building", footprintW: 4, footprintH: 3, canTrigger: true },
    { typeId: 0xa6, name: "Forge", race: "protoss", kind: "building", footprintW: 3, footprintH: 2, canTrigger: true },
    { typeId: 0xa2, name: "Photon Cannon", race: "protoss", kind: "building", footprintW: 2, footprintH: 2, canTrigger: true },
    { typeId: 0xa4, name: "Cybernetics Core", race: "protoss", kind: "building", footprintW: 3, footprintH: 2, canTrigger: true },
    { typeId: 0xac, name: "Shield Battery", race: "protoss", kind: "building", footprintW: 3, footprintH: 2, canTrigger: true },
    { typeId: 0xa3, name: "Citadel of Adun", race: "protoss", kind: "building", footprintW: 3, footprintH: 2, canTrigger: true },
    { typeId: 0xa5, name: "Templar Archives", race: "protoss", kind: "building", footprintW: 3, footprintH: 2, canTrigger: true },
    { typeId: 0x9b, name: "Robotics Facility", race: "protoss", kind: "building", footprintW: 3, footprintH: 2, canTrigger: true },
    { typeId: 0xab, name: "Robotics Support Bay", race: "protoss", kind: "building", footprintW: 3, footprintH: 2, canTrigger: true },
    { typeId: 0x9f, name: "Observatory", race: "protoss", kind: "building", footprintW: 3, footprintH: 2, canTrigger: true },
    { typeId: 0xa7, name: "Stargate", race: "protoss", kind: "building", footprintW: 4, footprintH: 3, canTrigger: true },
    { typeId: 0xa9, name: "Fleet Beacon", race: "protoss", kind: "building", footprintW: 3, footprintH: 2, canTrigger: true },
    { typeId: 0xaa, name: "Arbiter Tribunal", race: "protoss", kind: "building", footprintW: 3, footprintH: 2, canTrigger: true },
];

export const ZERG_ENTITIES: EntityCatalogEntry[] = [
    // ── ground units ────────────────────────────────────────────
    { typeId: 0x29, name: "Drone", race: "zerg", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x25, name: "Zergling", race: "zerg", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x26, name: "Hydralisk", race: "zerg", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x67, name: "Lurker", race: "zerg", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true, note: "normally morphs from a Hydralisk" },
    { typeId: 0x27, name: "Ultralisk", race: "zerg", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x2d, name: "Queen", race: "zerg", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x2e, name: "Defiler", race: "zerg", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x32, name: "Infested Terran", race: "zerg", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    // ── air units ───────────────────────────────────────────────
    { typeId: 0x2a, name: "Overlord", race: "zerg", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x2b, name: "Mutalisk", race: "zerg", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x2f, name: "Scourge", race: "zerg", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true },
    { typeId: 0x2c, name: "Guardian", race: "zerg", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true, note: "normally morphs from a Mutalisk" },
    { typeId: 0x3e, name: "Devourer", race: "zerg", kind: "unit", footprintW: 1, footprintH: 1, canTrigger: true, note: "normally morphs from a Mutalisk" },
    // ── buildings (creep-required, except Hatchery + Extractor) ──
    { typeId: 0x83, name: "Hatchery", race: "zerg", kind: "building", footprintW: 4, footprintH: 3, canTrigger: true },
    { typeId: 0x84, name: "Lair", race: "zerg", kind: "building", footprintW: 4, footprintH: 3, canTrigger: false, note: "morphs from Hatchery, needs creep" },
    { typeId: 0x85, name: "Hive", race: "zerg", kind: "building", footprintW: 4, footprintH: 3, canTrigger: false, note: "morphs from Lair, needs creep" },
    { typeId: 0x95, name: "Extractor", race: "zerg", kind: "building", footprintW: 4, footprintH: 2, canTrigger: false, note: "needs a geyser host" },
    { typeId: 0x8e, name: "Spawning Pool", race: "zerg", kind: "building", footprintW: 3, footprintH: 2, canTrigger: false, note: "needs creep" },
    { typeId: 0x8f, name: "Creep Colony", race: "zerg", kind: "building", footprintW: 2, footprintH: 2, canTrigger: false, note: "needs creep" },
    { typeId: 0x92, name: "Sunken Colony", race: "zerg", kind: "building", footprintW: 2, footprintH: 2, canTrigger: false, note: "morphs from Creep Colony, needs creep" },
    { typeId: 0x90, name: "Spore Colony", race: "zerg", kind: "building", footprintW: 2, footprintH: 2, canTrigger: false, note: "morphs from Creep Colony, needs creep" },
    { typeId: 0x87, name: "Hydralisk Den", race: "zerg", kind: "building", footprintW: 3, footprintH: 2, canTrigger: false, note: "needs creep" },
    { typeId: 0x8b, name: "Evolution Chamber", race: "zerg", kind: "building", footprintW: 3, footprintH: 2, canTrigger: false, note: "needs creep" },
    { typeId: 0x8a, name: "Queen's Nest", race: "zerg", kind: "building", footprintW: 3, footprintH: 2, canTrigger: false, note: "needs creep" },
    { typeId: 0x8d, name: "Spire", race: "zerg", kind: "building", footprintW: 2, footprintH: 2, canTrigger: false, note: "needs creep" },
    { typeId: 0x89, name: "Greater Spire", race: "zerg", kind: "building", footprintW: 2, footprintH: 2, canTrigger: false, note: "morphs from Spire, needs creep" },
    { typeId: 0x8c, name: "Ultralisk Cavern", race: "zerg", kind: "building", footprintW: 3, footprintH: 2, canTrigger: false, note: "needs creep" },
    { typeId: 0x88, name: "Defiler Mound", race: "zerg", kind: "building", footprintW: 4, footprintH: 2, canTrigger: false, note: "needs creep" },
    { typeId: 0x86, name: "Nydus Canal", race: "zerg", kind: "building", footprintW: 2, footprintH: 2, canTrigger: false, note: "needs creep" },
    { typeId: 0x82, name: "Infested Command Center", race: "zerg", kind: "building", footprintW: 4, footprintH: 3, canTrigger: false, note: "infested CC, needs creep nearby" },
];

export const ALL_ENTITIES: EntityCatalogEntry[] = [
    ...TERRAN_ENTITIES,
    ...PROTOSS_ENTITIES,
    ...ZERG_ENTITIES,
];

export const ENTITY_BY_TYPE_ID: Record<number, EntityCatalogEntry> = {};
for ( const e of ALL_ENTITIES ) {
    ENTITY_BY_TYPE_ID[ e.typeId ] = e;
}

export const ENTITY_BY_RACE: Record<Race, EntityCatalogEntry[]> = {
    terran: TERRAN_ENTITIES,
    protoss: PROTOSS_ENTITIES,
    zerg: ZERG_ENTITIES,
    neutral: [],
};
