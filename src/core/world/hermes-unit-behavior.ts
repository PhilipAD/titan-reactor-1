/**
 * Hermes "Living Base" unit-behavior loop.
 *
 * After hermes-base-layout has placed all units in pretty positions, units
 * just stand still — even ground forces with no nearby enemies. That makes
 * the base feel like a museum diorama, not a living StarCraft base.
 *
 * This module re-issues OpenBW commands at a low frequency so the base is
 * visibly *alive*: marines patrol, wraiths orbit the tech ring, SCVs gather
 * from real mineral patches, ghosts hold the perimeter with occasional
 * micro-shuffles, dropships float behind the base, the Battlecruiser drifts
 * around the heart of the base.
 *
 * OpenBW order types (from sandbox-api.ts, .issue_command second arg):
 *   0 = attack-move    1 = attack-unit    2 = move
 *   3 = build          4 = train          5 = right-click
 *
 * Right-click on a mineral patch = auto-gather, which is exactly what an
 * SCV needs to look busy.
 */

import type { LayoutRole, PlacementResult } from "./hermes-base-layout";
import {
    clearHermesUnitVisualAction,
    setHermesUnitVisualAction,
} from "./hermes-visual-actions";

export interface BehaviorOpenBW {
    isSandboxMode: () => boolean;
    iterators: {
        units: Iterable< {
            id: number;
            _address?: number;
            x?: number;
            y?: number;
            typeId?: number;
            owner?: number;
            spriteAddr?: number;
        } >;
    };
    HEAP32?: Int32Array;
    HEAP8?: Int8Array;
    HEAPU16?: Uint16Array;
    _get_buffer?: ( slot: number ) => number;
    _set_player_resources?: ( playerId: number, minerals: number, gas: number ) => void;
    _is_reachable?: ( unitId: number, x: number, y: number ) => number;
    getTilesPtr?: () => number;
    getTilesSize?: () => number;
    get_util_funcs: () => {
        issue_command: (
            unitId: number,
            commandType: number,
            targetUnitId: number,
            x: number,
            y: number,
            extra: number
        ) => void;
    };
}

export interface UnitRegistration {
    /** Hermes entity id (so we can dedupe re-registrations). */
    hermesId: string;
    /** OpenBW unit id (from iterators.units, NOT the address). */
    unitId: number;
    /** OpenBW unit type id (so we can decide which order to issue). */
    typeId: number;
    /** Result of layout for this entity. */
    placement: PlacementResult;
}

interface InstallParams {
    openBW: BehaviorOpenBW;
    /** How often to consider issuing new orders. Defaults to 4s. */
    intervalMs?: number;
    /** Completed-render mode must not touch OpenBW order/pathing APIs. */
    engineOrders?: boolean;
    /** Map dimensions let visual-only movement reject non-walkable tile flags. */
    mapWidthTiles?: number;
    mapHeightTiles?: number;
}

interface InstalledBehavior {
    register: ( reg: UnitRegistration ) => void;
    unregister: ( hermesId: string ) => void;
    /** Force a single tick (used by tests). */
    tick: () => void;
    dispose: () => void;
    state: () => {
        registered: number;
        roles: Record< LayoutRole, number >;
    };
}

const ORDER_MOVE = 2;
const ORDER_RIGHT_CLICK = 5;
const MINERAL_TYPE_IDS = new Set( [ 0xb0, 0xb1, 0xb2 ] );
const GAS_TYPE_IDS = new Set( [
    0x6e, // Terran Refinery
    0x95, // Zerg Extractor
    0x9d, // Protoss Assimilator
    0xbc, // Neutral Vespene Geyser
] );
const RESOURCE_DEPOT_TYPE_IDS = new Set( [
    0x6a, // Terran Command Center
    0x83, // Zerg Hatchery
    0x84, // Zerg Lair
    0x85, // Zerg Hive
    0x9a, // Protoss Nexus
] );
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
const TILE_FLAG_UNBUILDABLE = 0x80;
const TILE_FLAG_PARTIALLY_WALKABLE = 0x2000;

/**
 * For perimeter units (Ghosts/Bunkers) we don't want them sprinting across
 * the map every tick — just a tiny shuffle so the wireframe pose changes.
 */
const SHUFFLE_RADIUS_PX = 24;

interface Tracked {
    reg: UnitRegistration;
    /** Index into placement.waypoints for cycle-style behavior. */
    waypointIdx: number;
    /** Game time of the last issued order, for per-unit cooldown. */
    lastOrderAt: number;
    /** Resource we're gathering from (right-click target unit id), if any. */
    gatherUnitId?: number;
    visualPx?: number;
    visualPy?: number;
    visualDirection8?: number;
    registeredAt: number;
    dwellUntilMs?: number;
    pendingCarryResource?: "mineral" | "gas";
    movingHome?: boolean;
    carriedResource?: "mineral" | "gas";
    lastDwellCommandAt?: number;
    phaseOffsetMs: number;
    dwellJitterMs: number;
    postOffsetPx: number;
    postOffsetPy: number;
    targetPx?: number;
    targetPy?: number;
    /**
     * Hermes 2026-04 spawn-anything pass: count of consecutive
     * `stepOne` throws for this tracker. Once this hits 3 the tick
     * loop unregisters the tracker so a permanently-broken force-
     * spawned unit doesn't loop-throw forever.
     */
    errorStreak?: number;
}

/**
 * Pick a nearby unit id to right-click for gathering. We just walk the
 * iterators looking for the first unit whose pixel position is within
 * `radiusPx` of `(px, py)` AND whose type is a mineral patch. (Bigger
 * resource-search would need spatial indexing; this is fine for ~30
 * patches.)
 */
const findResourceUnitNear = (
    openBW: BehaviorOpenBW,
    px: number,
    py: number,
    radiusPx: number,
    type: "mineral" | "gas" = "mineral"
): number | null => {
    const r2 = radiusPx * radiusPx;
    let best: { id: number; d: number } | null = null;
    for ( const u of openBW.iterators.units as unknown as Iterable< {
        id: number;
        x?: number;
        y?: number;
        typeId?: number;
    } > ) {
        const isMineral = typeof u.typeId === "number" && MINERAL_TYPE_IDS.has( u.typeId );
        const isGas = typeof u.typeId === "number" && GAS_TYPE_IDS.has( u.typeId );
        if ( type === "mineral" && !isMineral ) continue;
        if ( type === "gas" && !isGas ) continue;
        if ( typeof u.x !== "number" || typeof u.y !== "number" ) continue;
        const dx = ( u.x ?? 0 ) - px;
        const dy = ( u.y ?? 0 ) - py;
        const d = dx * dx + dy * dy;
        if ( d > r2 ) continue;
        if ( !best || d < best.d ) best = { id: u.id, d };
    }
    return best ? best.id : null;
};

const findUnitById = (
    openBW: BehaviorOpenBW,
    unitId: number
): {
    id: number;
    _address?: number;
    x?: number;
    y?: number;
    typeId?: number;
    owner?: number;
    spriteAddr?: number;
} | null => {
    for ( const u of openBW.iterators.units ) {
        if ( u.id === unitId ) {
            return {
                id: u.id,
                _address: u._address,
                x: u.x,
                y: u.y,
                typeId: u.typeId,
                owner: u.owner,
                spriteAddr: u.spriteAddr,
            };
        }
    }
    return null;
};

const findResourceDepot = ( openBW: BehaviorOpenBW, playerId = 0 ) => {
    for ( const u of openBW.iterators.units ) {
        if (
            typeof u.typeId === "number" &&
            RESOURCE_DEPOT_TYPE_IDS.has( u.typeId ) &&
            ( u.owner ?? playerId ) === playerId
        ) {
            return {
                id: u.id,
                _address: u._address,
                x: u.x,
                y: u.y,
                typeId: u.typeId,
                owner: u.owner,
                spriteAddr: u.spriteAddr,
            };
        }
    }
    return null;
};

const moveToward = (
    x: number,
    y: number,
    tx: number,
    ty: number,
    stepPx: number
): { x: number; y: number; reached: boolean } => {
    const dx = tx - x;
    const dy = ty - y;
    const d = Math.hypot( dx, dy );
    if ( d <= stepPx || d <= 1 ) return { x: tx, y: ty, reached: true };
    const f = stepPx / d;
    return { x: Math.round( x + dx * f ), y: Math.round( y + dy * f ), reached: false };
};

const isReachablePoint = (
    openBW: BehaviorOpenBW,
    unitId: number,
    x: number,
    y: number
): boolean => {
    if ( !openBW._is_reachable ) return true;
    try {
        return openBW._is_reachable( unitId, x, y ) !== 0;
    } catch {
        return false;
    }
};

const tileFlagsView = ( openBW: BehaviorOpenBW ): Uint16Array | null => {
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

const terrainWalkablePoint = (
    openBW: BehaviorOpenBW,
    x: number,
    y: number,
    mapWidthTiles?: number,
    mapHeightTiles?: number,
    ignoreTerrain = false
): boolean => {
    if ( ignoreTerrain ) return true;
    const tiles = tileFlagsView( openBW );
    if ( !tiles || !mapWidthTiles || !mapHeightTiles ) return true;
    const tx = Math.floor( x / 32 );
    const ty = Math.floor( y / 32 );
    if ( tx < 0 || ty < 0 || tx >= mapWidthTiles || ty >= mapHeightTiles ) return false;
    const tilePos = ty * mapWidthTiles + tx;
    const flags = tiles[tilePos * 2 + 1] ?? 0;
    const belowFlags = ty < mapHeightTiles - 1
        ? tiles[( ( ty + 1 ) * mapWidthTiles + tx ) * 2 + 1] ?? 0
        : TILE_FLAG_UNBUILDABLE;
    return (
        ( flags & ( TILE_FLAG_UNBUILDABLE | TILE_FLAG_PARTIALLY_WALKABLE ) ) === 0 &&
        ( belowFlags & TILE_FLAG_UNBUILDABLE ) === 0
    );
};

const terrainWalkableSegment = (
    openBW: BehaviorOpenBW,
    x: number,
    y: number,
    tx: number,
    ty: number,
    mapWidthTiles?: number,
    mapHeightTiles?: number,
    ignoreTerrain = false
): boolean => {
    if ( ignoreTerrain ) return true;
    const dist = Math.hypot( tx - x, ty - y );
    const steps = Math.max( 1, Math.ceil( dist / 16 ) );
    for ( let i = 1; i <= steps; i++ ) {
        const f = i / steps;
        if (
            !terrainWalkablePoint(
                openBW,
                x + ( tx - x ) * f,
                y + ( ty - y ) * f,
                mapWidthTiles,
                mapHeightTiles,
                ignoreTerrain
            )
        ) {
            return false;
        }
    }
    return true;
};

const moveTowardReachable = (
    openBW: BehaviorOpenBW,
    unitId: number,
    x: number,
    y: number,
    tx: number,
    ty: number,
    stepPx: number,
    useReachability = true,
    mapWidthTiles?: number,
    mapHeightTiles?: number,
    ignoreTerrain = false
): { x: number; y: number; reached: boolean } => {
    const direct = moveToward( x, y, tx, ty, stepPx );
    if (
        terrainWalkableSegment(
            openBW,
            x,
            y,
            direct.x,
            direct.y,
            mapWidthTiles,
            mapHeightTiles,
            ignoreTerrain
        ) &&
        ( !useReachability || isReachablePoint( openBW, unitId, direct.x, direct.y ) )
    ) {
        return direct;
    }

    const baseAngle = Math.atan2( ty - y, tx - x );
    const angles = [
        Math.PI / 6,
        -Math.PI / 6,
        Math.PI / 3,
        -Math.PI / 3,
        Math.PI / 2,
        -Math.PI / 2,
        ( 2 * Math.PI ) / 3,
        ( -2 * Math.PI ) / 3,
        Math.PI,
    ];
    for ( const offset of angles ) {
        const nx = Math.round( x + Math.cos( baseAngle + offset ) * stepPx );
        const ny = Math.round( y + Math.sin( baseAngle + offset ) * stepPx );
        if (
            terrainWalkableSegment(
                openBW,
                x,
                y,
                nx,
                ny,
                mapWidthTiles,
                mapHeightTiles,
                ignoreTerrain
            ) &&
            ( !useReachability || isReachablePoint( openBW, unitId, nx, ny ) )
        ) {
            return { x: nx, y: ny, reached: false };
        }
    }

    return { x, y, reached: false };
};

const writeUnitPosition = (
    openBW: BehaviorOpenBW,
    unit: { _address?: number; spriteAddr?: number },
    x: number,
    y: number,
    direction8?: number
) => {
    if ( !openBW.HEAP32 || typeof unit._address !== "number" ) return;
    const unitAddr32 = ( unit._address >> 2 ) + 2;
    openBW.HEAP32[unitAddr32 + 16] = x;
    openBW.HEAP32[unitAddr32 + 17] = y;
    if ( openBW.HEAP8 && typeof direction8 === "number" ) {
        const unitAddr8 = unit._address + ( 2 << 2 );
        openBW.HEAP8[unitAddr8 + ( 11 << 2 )] = direction8;
        openBW.HEAP8[unitAddr8 + ( 25 << 2 )] = direction8;
    }
    if ( typeof unit.spriteAddr === "number" && unit.spriteAddr > 0 ) {
        const spriteAddr32 = ( unit.spriteAddr >> 2 ) + 2;
        openBW.HEAP32[spriteAddr32 + 10] = x;
        openBW.HEAP32[spriteAddr32 + 11] = y;
    }
};

const randomWalkableShuffleTarget = (
    openBW: BehaviorOpenBW,
    t: Tracked,
    rng: () => number,
    mapWidthTiles?: number,
    mapHeightTiles?: number,
    ignoreTerrain = false
): { px: number; py: number } | null => {
    for ( let attempt = 0; attempt < 8; attempt++ ) {
        const px = Math.round( t.reg.placement.px + ( rng() - 0.5 ) * 2 * SHUFFLE_RADIUS_PX );
        const py = Math.round( t.reg.placement.py + ( rng() - 0.5 ) * 2 * SHUFFLE_RADIUS_PX );
        if (
            terrainWalkablePoint( openBW, px, py, mapWidthTiles, mapHeightTiles, ignoreTerrain ) &&
            isReachablePoint( openBW, t.reg.unitId, px, py )
        ) {
            return { px, py };
        }
    }
    return null;
};

const direction8FromDelta = ( dx: number, dy: number, fallback = 64 ) => {
    if ( Math.abs( dx ) < 0.001 && Math.abs( dy ) < 0.001 ) return fallback;
    return Math.round( ( Math.atan2( dy, dx ) / ( Math.PI * 2 ) ) * 256 + 64 + 256 ) % 256;
};

const direction8ToTarget = (
    x: number,
    y: number,
    tx: number,
    ty: number,
    fallback = 64
) => direction8FromDelta( tx - x, ty - y, fallback );

const hashString = ( value: string ): number => {
    let h = 2166136261 >>> 0;
    for ( let i = 0; i < value.length; i++ ) {
        h ^= value.charCodeAt( i );
        h = Math.imul( h, 16777619 ) >>> 0;
    }
    return h >>> 0;
};

const unitPositionForSeparation = ( t: Tracked ): { x: number; y: number } => ( {
    x: t.visualPx ?? t.reg.placement.px,
    y: t.visualPy ?? t.reg.placement.py,
} );

const localWaypointFor = (
    t: Tracked,
    wp: { px: number; py: number },
    tracked: Iterable< Tracked >
): { px: number; py: number } => {
    const phaseAngle = ( ( hashString( t.reg.hermesId ) % 360 ) / 360 ) * Math.PI * 2;
    let px = wp.px + t.postOffsetPx + Math.round( Math.cos( phaseAngle + t.waypointIdx ) * 10 );
    let py = wp.py + t.postOffsetPy + Math.round( Math.sin( phaseAngle + t.waypointIdx ) * 10 );
    const here = unitPositionForSeparation( t );
    let pushX = 0;
    let pushY = 0;
    const separationRadius = t.reg.placement.role === "front-patrol" ? 96 : 58;
    const pushScale = t.reg.placement.role === "front-patrol" ? 44 : 28;
    for ( const other of tracked ) {
        if ( other === t ) continue;
        const otherPos = unitPositionForSeparation( other );
        const dx = here.x - otherPos.x;
        const dy = here.y - otherPos.y;
        const dist = Math.hypot( dx, dy );
        if ( dist <= 0.001 || dist > separationRadius ) continue;
        const strength = ( separationRadius - dist ) / separationRadius;
        pushX += ( dx / dist ) * strength * pushScale;
        pushY += ( dy / dist ) * strength * pushScale;
    }
    px += Math.round( pushX );
    py += Math.round( pushY );
    return { px, py };
};

const writeWorkerCarryState = (
    openBW: BehaviorOpenBW,
    unit: { _address?: number },
    carriedResource?: "mineral" | "gas"
) => {
    if ( !openBW.HEAP32 || typeof unit._address !== "number" ) return;
    const unitAddr32 = ( unit._address >> 2 ) + 2;
    // unit_t::carrying_flags sits immediately after status_flags in the
    // OpenBW layout. Values mirror BW's resource-carrying state: 0 = empty,
    // 1 = mineral chunk, 2 = gas tank/sac/orb. Keep Gathering set while
    // returning so the SCV uses the resource-carrying visual branch.
    const STATUS_GATHERING = 0x800000;
    const statusFlagsIdx = unitAddr32 + 113;
    const carryingFlagsIdx = unitAddr32 + 114;
    if ( carriedResource ) {
        openBW.HEAP32[carryingFlagsIdx] = carriedResource === "gas" ? 2 : 1;
        openBW.HEAP32[statusFlagsIdx] = openBW.HEAP32[statusFlagsIdx] | STATUS_GATHERING;
    } else {
        openBW.HEAP32[carryingFlagsIdx] = 0;
        openBW.HEAP32[statusFlagsIdx] = openBW.HEAP32[statusFlagsIdx] & ~STATUS_GATHERING;
    }
};

const readPlayerResources = ( openBW: BehaviorOpenBW, playerId = 0 ) => {
    if ( !openBW.HEAP32 || !openBW._get_buffer ) return { minerals: 0, gas: 0 };
    const addr = openBW._get_buffer( 8 );
    const off = ( addr >> 2 ) + playerId * 7;
    return {
        minerals: openBW.HEAP32[off + 0] ?? 0,
        gas: openBW.HEAP32[off + 1] ?? 0,
    };
};

const addPlayerResources = (
    openBW: BehaviorOpenBW,
    playerId: number,
    type: "mineral" | "gas"
) => {
    const current = readPlayerResources( openBW, playerId );
    const minerals = current.minerals + ( type === "mineral" ? 8 : 0 );
    const gas = current.gas + ( type === "gas" ? 8 : 0 );
    if ( openBW._set_player_resources ) {
        openBW._set_player_resources( playerId, minerals, gas );
        return;
    }
    if ( !openBW.HEAP32 || !openBW._get_buffer ) return;
    const addr = openBW._get_buffer( 8 );
    const off = ( addr >> 2 ) + playerId * 7;
    openBW.HEAP32[off + 0] = minerals;
    openBW.HEAP32[off + 1] = gas;
};

/**
 * Issue the role-appropriate order for `t` at game-time `now`. Returns
 * true if an order was issued.
 */
const stepOne = (
    openBW: BehaviorOpenBW,
    t: Tracked,
    now: number,
    rng: () => number,
    tracked: Iterable< Tracked >,
    mapWidthTiles?: number,
    mapHeightTiles?: number
): boolean => {
    const cooldownMs = cooldownForRole( t.reg.placement.role );
    const role = t.reg.placement.role;
    const ignoresTerrain = FLYING_TYPE_IDS.has( t.reg.typeId );
    if (
        ( role === "front-patrol" || role === "tech-ring" || role === "supply-back" ) &&
        now - t.registeredAt < t.phaseOffsetMs
    ) {
        return false;
    }
    if ( now - t.lastOrderAt < cooldownMs + t.dwellJitterMs ) return false;
    const utils = openBW.get_util_funcs();

    switch ( role ) {
        case "front-patrol": {
            // Cycle through the patrol waypoints.
            const wps = t.reg.placement.waypoints;
            if ( !wps || wps.length === 0 ) return false;
            const rawWp = wps[t.waypointIdx % wps.length];
            const wp = localWaypointFor( t, rawWp, tracked );
            t.waypointIdx = ( t.waypointIdx + 1 ) % wps.length;
            const localReachable =
                terrainWalkablePoint( openBW, wp.px, wp.py, mapWidthTiles, mapHeightTiles, ignoresTerrain ) &&
                isReachablePoint( openBW, t.reg.unitId, wp.px, wp.py );
            const rawReachable =
                terrainWalkablePoint(
                    openBW,
                    rawWp.px,
                    rawWp.py,
                    mapWidthTiles,
                    mapHeightTiles,
                    ignoresTerrain
                ) &&
                isReachablePoint( openBW, t.reg.unitId, rawWp.px, rawWp.py );
            if ( !localReachable && !rawReachable ) return false;
            t.targetPx = localReachable ? wp.px : rawWp.px;
            t.targetPy = localReachable ? wp.py : rawWp.py;
            setHermesUnitVisualAction( t.reg.unitId, "moving" );
            utils.issue_command( t.reg.unitId, ORDER_MOVE, 0, t.targetPx, t.targetPy, 0 );
            t.lastOrderAt = now;
            return true;
        }
        case "tech-ring":
        case "supply-back": {
            // Slow orbit: only advance every 2 cycles so flyers drift instead
            // of sprinting around the ring.
            const wps = t.reg.placement.waypoints;
            if ( !wps || wps.length === 0 ) return false;
            const rawWp = wps[t.waypointIdx % wps.length];
            const wp = localWaypointFor( t, rawWp, tracked );
            t.waypointIdx = ( t.waypointIdx + 1 ) % wps.length;
            const localReachable =
                terrainWalkablePoint( openBW, wp.px, wp.py, mapWidthTiles, mapHeightTiles, ignoresTerrain ) &&
                isReachablePoint( openBW, t.reg.unitId, wp.px, wp.py );
            const rawReachable =
                terrainWalkablePoint(
                    openBW,
                    rawWp.px,
                    rawWp.py,
                    mapWidthTiles,
                    mapHeightTiles,
                    ignoresTerrain
                ) &&
                isReachablePoint( openBW, t.reg.unitId, rawWp.px, rawWp.py );
            if ( !localReachable && !rawReachable ) return false;
            t.targetPx = localReachable ? wp.px : rawWp.px;
            t.targetPy = localReachable ? wp.py : rawWp.py;
            setHermesUnitVisualAction( t.reg.unitId, "moving" );
            utils.issue_command( t.reg.unitId, ORDER_MOVE, 0, t.targetPx, t.targetPy, 0 );
            t.lastOrderAt = now;
            return true;
        }
        case "static-post":
            setHermesUnitVisualAction( t.reg.unitId, "idle" );
            t.lastOrderAt = now;
            return false;
        case "worker-near-resource": {
            // Try to gather. If we already have a target, no-op (the unit
            // is already on a gather loop). Otherwise find the nearest
            // mineral patch and right-click it.
            if ( t.gatherUnitId != null ) return false;
            const tx = t.reg.placement.targetResourcePx ?? t.reg.placement.px;
            const ty = t.reg.placement.targetResourcePy ?? t.reg.placement.py;
            const targetType = t.reg.placement.targetResourceType ?? "mineral";
            const target = findResourceUnitNear( openBW, tx, ty, 6 * 32, targetType );
            if ( target == null ) {
                // No resource available — fall back to wandering near the
                // CC so the SCV doesn't look catatonic.
                const shuffle = randomWalkableShuffleTarget(
                    openBW,
                    t,
                    rng,
                    mapWidthTiles,
                    mapHeightTiles,
                    ignoresTerrain
                );
                if ( !shuffle ) return false;
                setHermesUnitVisualAction( t.reg.unitId, "moving" );
                utils.issue_command( t.reg.unitId, ORDER_MOVE, 0, shuffle.px, shuffle.py, 0 );
                t.lastOrderAt = now;
                return true;
            }
            setHermesUnitVisualAction( t.reg.unitId, "moving", targetType );
            utils.issue_command( t.reg.unitId, ORDER_RIGHT_CLICK, target, 0, 0, 0 );
            t.gatherUnitId = target;
            t.lastOrderAt = now;
            return true;
        }
        case "defense-perimeter":
        case "subagent-cluster":
        case "core":
        case "wanderer":
        default: {
            // Gentle shuffle: a small random move within a few tiles of
            // the placement anchor so the unit changes facing without
            // abandoning its post.
            const shuffle = randomWalkableShuffleTarget(
                openBW,
                t,
                rng,
                mapWidthTiles,
                mapHeightTiles,
                ignoresTerrain
            );
            if ( !shuffle ) return false;
            setHermesUnitVisualAction( t.reg.unitId, "moving" );
            utils.issue_command( t.reg.unitId, ORDER_MOVE, 0, shuffle.px, shuffle.py, 0 );
            t.lastOrderAt = now;
            return true;
        }
    }
};

const stepVisualMotion = (
    openBW: BehaviorOpenBW,
    t: Tracked,
    stepPx: number,
    tracked: Iterable< Tracked >,
    engineOrders: boolean,
    mapWidthTiles?: number,
    mapHeightTiles?: number
): boolean => {
    const unit = findUnitById( openBW, t.reg.unitId );
    if ( !unit ) return false;
    t.visualPx ??= unit.x ?? t.reg.placement.px;
    t.visualPy ??= unit.y ?? t.reg.placement.py;
    t.visualDirection8 ??= 64;
    const ignoresTerrain = FLYING_TYPE_IDS.has( t.reg.typeId );

    if ( t.reg.placement.role === "static-post" ) {
        writeUnitPosition( openBW, unit, t.visualPx, t.visualPy, t.visualDirection8 );
        setHermesUnitVisualAction( t.reg.unitId, "idle", undefined, t.visualDirection8 );
        return false;
    }

    if ( t.reg.placement.role === "worker-near-resource" ) {
        const now = ( typeof performance !== "undefined" ? performance.now() : Date.now() );
        if ( now - t.registeredAt < 1800 ) {
            writeWorkerCarryState( openBW, unit, undefined );
            setHermesUnitVisualAction( t.reg.unitId, "idle", undefined, t.visualDirection8 );
            return false;
        }
        if ( t.dwellUntilMs && now < t.dwellUntilMs ) {
            const targetType = t.reg.placement.targetResourceType ?? "mineral";
            const target = t.gatherUnitId ?? findResourceUnitNear(
                openBW,
                t.reg.placement.targetResourcePx ?? t.reg.placement.px,
                t.reg.placement.targetResourcePy ?? t.reg.placement.py,
                6 * 32,
                targetType
            );
            if ( engineOrders && target != null && now - ( t.lastDwellCommandAt ?? 0 ) > 900 ) {
                openBW.get_util_funcs().issue_command(
                    t.reg.unitId,
                    ORDER_RIGHT_CLICK,
                    target,
                    0,
                    0,
                    0
                );
                t.gatherUnitId = target;
                t.lastDwellCommandAt = now;
            }
            t.visualDirection8 = direction8ToTarget(
                t.visualPx,
                t.visualPy,
                t.reg.placement.targetResourcePx ?? t.reg.placement.px,
                t.reg.placement.targetResourcePy ?? t.reg.placement.py,
                t.visualDirection8
            );
            writeUnitPosition( openBW, unit, t.visualPx, t.visualPy, t.visualDirection8 );
            writeWorkerCarryState( openBW, unit, t.carriedResource );
            setHermesUnitVisualAction(
                t.reg.unitId,
                "gathering",
                t.carriedResource ?? targetType,
                t.visualDirection8
            );
            return false;
        }
        if ( t.pendingCarryResource ) {
            t.carriedResource = t.pendingCarryResource;
            t.pendingCarryResource = undefined;
            t.movingHome = true;
            writeWorkerCarryState( openBW, unit, t.carriedResource );
            setHermesUnitVisualAction(
                t.reg.unitId,
                "carrying",
                t.carriedResource,
                t.visualDirection8
            );
        }
        const depot = findResourceDepot( openBW, unit.owner ?? 0 );
        const homePx = depot?.x ?? t.reg.placement.px;
        const homePy = depot?.y ?? t.reg.placement.py;
        const resourcePx = t.reg.placement.targetResourcePx ?? t.reg.placement.px;
        const resourcePy = t.reg.placement.targetResourcePy ?? t.reg.placement.py;
        const targetResourceType = t.reg.placement.targetResourceType ?? "mineral";
        const tx = t.movingHome ? homePx : resourcePx;
        const ty = t.movingHome ? homePy : resourcePy;
        const moved = moveTowardReachable(
            openBW,
            t.reg.unitId,
            t.visualPx,
            t.visualPy,
            tx,
            ty,
            stepPx,
            engineOrders,
            mapWidthTiles,
            mapHeightTiles,
            ignoresTerrain
        );
        t.visualDirection8 = direction8FromDelta(
            moved.x - t.visualPx,
            moved.y - t.visualPy,
            direction8ToTarget( t.visualPx, t.visualPy, tx, ty, t.visualDirection8 )
        );
        t.visualPx = moved.x;
        t.visualPy = moved.y;
        writeWorkerCarryState( openBW, unit, t.carriedResource );
        writeUnitPosition( openBW, unit, moved.x, moved.y, t.visualDirection8 );
        setHermesUnitVisualAction(
            t.reg.unitId,
            t.carriedResource ? "carrying" : "moving",
            t.carriedResource,
            t.visualDirection8
        );
        if ( moved.reached ) {
            if ( t.movingHome && t.carriedResource ) {
                addPlayerResources( openBW, unit.owner ?? 0, t.carriedResource );
                t.carriedResource = undefined;
                writeWorkerCarryState( openBW, unit, undefined );
                t.movingHome = false;
                t.gatherUnitId = undefined;
                setHermesUnitVisualAction(
                    t.reg.unitId,
                    "moving",
                    targetResourceType,
                    t.visualDirection8
                );
            } else {
                t.carriedResource = targetResourceType;
                t.pendingCarryResource = targetResourceType;
                t.dwellUntilMs = now + 2600;
                t.lastDwellCommandAt = 0;
                writeWorkerCarryState( openBW, unit, t.carriedResource );
                setHermesUnitVisualAction(
                    t.reg.unitId,
                    "gathering",
                    t.carriedResource,
                    t.visualDirection8
                );
            }
        }
        return true;
    }

    const wps = t.reg.placement.waypoints ?? ( ignoresTerrain
        ? [
            { px: t.reg.placement.px - 128, py: t.reg.placement.py - 128 },
            { px: t.reg.placement.px + 128, py: t.reg.placement.py - 128 },
            { px: t.reg.placement.px + 128, py: t.reg.placement.py + 128 },
            { px: t.reg.placement.px - 128, py: t.reg.placement.py + 128 },
        ]
        : undefined );
    if ( !wps || wps.length === 0 ) return false;
    const rawWp = wps[t.waypointIdx % wps.length];
    const wp = t.targetPx != null && t.targetPy != null
        ? { px: t.targetPx, py: t.targetPy }
        : localWaypointFor( t, rawWp, tracked );
    const moved = moveTowardReachable(
        openBW,
        t.reg.unitId,
        t.visualPx,
        t.visualPy,
        wp.px,
        wp.py,
        stepPx,
        engineOrders,
        mapWidthTiles,
        mapHeightTiles,
        ignoresTerrain
    );
    t.visualDirection8 = direction8FromDelta(
        moved.x - t.visualPx,
        moved.y - t.visualPy,
        direction8ToTarget( t.visualPx, t.visualPy, wp.px, wp.py, t.visualDirection8 )
    );
    t.visualPx = moved.x;
    t.visualPy = moved.y;
    writeUnitPosition( openBW, unit, moved.x, moved.y, t.visualDirection8 );
    setHermesUnitVisualAction( t.reg.unitId, "moving", undefined, t.visualDirection8 );
    if ( moved.reached ) {
        t.waypointIdx = ( t.waypointIdx + 1 ) % wps.length;
        t.targetPx = undefined;
        t.targetPy = undefined;
    }
    return true;
};

const cooldownForRole = ( role: LayoutRole ): number => {
    switch ( role ) {
        case "front-patrol":
            return 4500;
        case "static-post":
            return 30_000;
        case "tech-ring":
        case "supply-back":
            return 6000;
        case "worker-near-resource":
            return 9000;
        case "core":
            return 8000;
        case "defense-perimeter":
        case "subagent-cluster":
        case "wanderer":
        default:
            return 7000;
    }
};

const ROLE_KEYS: LayoutRole[] = [
    "core",
    "tech-ring",
    "supply-back",
    "defense-perimeter",
    "subagent-cluster",
    "front-patrol",
    "static-post",
    "worker-near-resource",
    "wanderer",
];

export const installBehaviorLoop = ( params: InstallParams ): InstalledBehavior => {
    const {
        openBW,
        intervalMs = 1500,
        engineOrders = true,
        mapWidthTiles,
        mapHeightTiles,
    } = params;
    const tracked = new Map< string, Tracked >();
    let timer: ReturnType< typeof setInterval > | null = null;
    let visualTimer: ReturnType< typeof setInterval > | null = null;

    // Tiny PRNG for the shuffle jitter — not security-critical.
    let s = 0x1234567 >>> 0;
    const rng = () => {
        s = ( s * 1664525 + 1013904223 ) >>> 0;
        return s / 0xffffffff;
    };

    const tick = () => {
        // Hermes 2026-04 base-layout fix: previously gated on
        // openBW.isSandboxMode(), which on a melee-map run is FALSE by
        // default — so SCVs never got gather orders, marines never
        // patrolled, etc. The world-composer now force-enables sandbox
        // mode on Hermes embed boot, but we also drop the guard here so
        // even the legacy boot path animates the base.
        const now = ( typeof performance !== "undefined" ? performance.now() : Date.now() );
        // Stagger so we don't burst-issue every order in the same frame.
        let issued = 0;
        const MAX_PER_TICK = 4;
        for ( const t of tracked.values() ) {
            if ( issued >= MAX_PER_TICK ) break;
            // Hermes 2026-04 spawn-anything pass: wrap stepOne so a
            // single bad unit (e.g. a force-spawned building whose
            // unit_finder slot is half-init) can't crash the entire
            // behavior loop. Without this, every tick that hits the
            // bad unit throws "memory access out of bounds" and
            // permanently kills the iframe's render loop.
            //
            // Bad units get auto-unregistered after 3 consecutive
            // throws so the loop doesn't waste cycles on them.
            try {
                if ( stepOne( openBW, t, now, rng, tracked.values(), mapWidthTiles, mapHeightTiles ) ) issued++;
                t.errorStreak = 0;
            } catch ( err ) {
                t.errorStreak = ( t.errorStreak ?? 0 ) + 1;
                if ( t.errorStreak === 1 ) {
                    console.warn(
                        `[hermes-unit-behavior] stepOne threw for hermesId=${t.reg.hermesId} unitId=${t.reg.unitId}: ${err instanceof Error ? err.message : String( err )}`
                    );
                } else if ( t.errorStreak >= 3 ) {
                    console.warn(
                        `[hermes-unit-behavior] disabling broken behavior tracker hermesId=${t.reg.hermesId} (${t.errorStreak} consecutive throws)`
                    );
                    tracked.delete( t.reg.hermesId );
                }
            }
        }
    };

    const start = () => {
        if ( timer ) return;
        if ( engineOrders ) {
            timer = setInterval( tick, intervalMs );
        }
        visualTimer = setInterval( () => {
            for ( const t of tracked.values() ) {
                try {
                    stepVisualMotion(
                        openBW,
                        t,
                        14,
                        tracked.values(),
                        engineOrders,
                        mapWidthTiles,
                        mapHeightTiles
                    );
                } catch ( err ) {
                    t.errorStreak = ( t.errorStreak ?? 0 ) + 1;
                    if ( t.errorStreak === 1 ) {
                        console.warn(
                            `[hermes-unit-behavior] visual motion threw for hermesId=${t.reg.hermesId} unitId=${t.reg.unitId}: ${err instanceof Error ? err.message : String( err )}`
                        );
                    } else if ( t.errorStreak >= 3 ) {
                        tracked.delete( t.reg.hermesId );
                    }
                }
            }
        }, 150 );
    };

    const stop = () => {
        if ( timer ) clearInterval( timer );
        if ( visualTimer ) clearInterval( visualTimer );
        timer = null;
        visualTimer = null;
    };

    start();

    return {
        register( reg ) {
            const existing = tracked.get( reg.hermesId );
            const hash = hashString( reg.hermesId );
            const angle = ( ( hash % 360 ) / 360 ) * Math.PI * 2;
            const radius = 14 + ( hash % 19 );
            const phaseOffsetMs =
                reg.placement.role === "front-patrol" ||
                reg.placement.role === "tech-ring" ||
                reg.placement.role === "supply-back"
                    ? hash % 3200
                    : 0;
            tracked.set( reg.hermesId, {
                reg,
                waypointIdx: existing?.waypointIdx ?? ( reg.placement.waypoints?.length
                    ? hash % reg.placement.waypoints.length
                    : 0 ),
                // Use a very negative sentinel so a brand-new registration
                // is always allowed to fire on its first tick — regardless
                // of how early in the process performance.now() currently is.
                // (A naive `0` collides with the cooldown gate when
                // performance.now() < cooldownMs at process start.)
                lastOrderAt: existing?.lastOrderAt ?? -1e9,
                gatherUnitId: undefined,
                registeredAt:
                    existing?.registeredAt ??
                    ( typeof performance !== "undefined" ? performance.now() : Date.now() ),
                phaseOffsetMs: existing?.phaseOffsetMs ?? phaseOffsetMs,
                dwellJitterMs: existing?.dwellJitterMs ?? ( hash % 1400 ),
                postOffsetPx: existing?.postOffsetPx ?? Math.round( Math.cos( angle ) * radius ),
                postOffsetPy: existing?.postOffsetPy ?? Math.round( Math.sin( angle ) * radius ),
                targetPx: existing?.targetPx,
                targetPy: existing?.targetPy,
            } );
        },
        unregister( hermesId ) {
            const existing = tracked.get( hermesId );
            if ( existing ) clearHermesUnitVisualAction( existing.reg.unitId );
            tracked.delete( hermesId );
        },
        tick,
        dispose() {
            stop();
            for ( const t of tracked.values() ) {
                clearHermesUnitVisualAction( t.reg.unitId );
            }
            tracked.clear();
        },
        state() {
            const roles = Object.fromEntries(
                ROLE_KEYS.map( ( k ) => [ k, 0 ] )
            ) as Record< LayoutRole, number >;
            for ( const t of tracked.values() ) {
                roles[t.reg.placement.role] = ( roles[t.reg.placement.role] ?? 0 ) + 1;
            }
            return { registered: tracked.size, roles };
        },
    };
};
