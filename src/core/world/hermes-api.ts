/**
 * Hermes Comprehensive API
 *
 * Single seam exposing every capability the deeper-RE report identified to
 * the parent dashboard. Mounted at `globalThis.__hermesAPI` inside the
 * iframe AND surfaced to the dashboard via a `hermes:api:*` postMessage
 * protocol so cross-origin React code can drive any subsystem without
 * touching the iframe's `contentWindow` directly.
 *
 * Design goals
 * ------------
 *   1. Backwards compatible. The legacy bundled `titan.wasm` only exports
 *      15 KEEPALIVE functions. Every advanced capability is feature-gated
 *      via `feature(name)` so callers can test before invoking.
 *   2. Single source of truth. No method here recomputes WASM mappings;
 *      they all delegate to existing helpers (sandbox-api, hermes-entity-
 *      bridge, openbw util_funcs).
 *   3. Safe-by-default. Every mutator wraps the WASM call in a try/catch
 *      and returns a structured `ApiResult` so the dashboard can branch on
 *      success/error without crashing on Emscripten integer exceptions.
 *   4. Discoverable. `__hermesAPI.describe()` returns a JSON manifest of
 *      every method, its params, and whether the underlying export exists
 *      so the React side can render UI conditionally.
 *
 * Hermes 2026-04 deeper rebuild.
 */

import type { OpenBW } from "@openbw/openbw";
import type { World } from "./world";
import type { Assets } from "@image/assets";
import type { PxToWorld } from "common/utils/conversions";
import type { SandboxAPI } from "@openbw/sandbox-api";
import { mixer } from "@audio/main-mixer";

// ---------------------------------------------------------------------------
//  Result shapes
// ---------------------------------------------------------------------------

export interface ApiOk<T = unknown> {
    ok: true;
    value: T;
}
export interface ApiErr {
    ok: false;
    error: string;
}
export type ApiResult<T = unknown> = ApiOk<T> | ApiErr;

const ok = <T>( value: T ): ApiOk<T> => ( { ok: true, value } );
const err = ( error: string ): ApiErr => ( { ok: false, error } );

// ---------------------------------------------------------------------------
//  Issue command opcodes (confirmed via runtime probe; see HERMES_ENGINEERING_REFERENCE.md)
// ---------------------------------------------------------------------------

export const ISSUE_COMMAND = {
    ATTACK_MOVE: 0,
    ATTACK_UNIT: 1,
    MOVE: 2,
    BUILD: 3,
    TRAIN: 4,
    RIGHT_CLICK: 5,
} as const;

// ---------------------------------------------------------------------------
//  Player controller enum (matches bwgame.h::player_t::controller_t)
// ---------------------------------------------------------------------------

export const PLAYER_CONTROLLER = {
    INACTIVE: 0,
    COMPUTER_GAME: 1,
    OCCUPIED: 2,
    RESCUE_PASSIVE: 3,
    UNUSED: 4,
    COMPUTER: 5,
    OPEN: 6,
    NEUTRAL: 7,
    CLOSED: 8,
} as const;

// ---------------------------------------------------------------------------
//  Hermes entity bridge contract (kept structural to avoid circular import)
// ---------------------------------------------------------------------------

interface InstalledBridge {
    placeEntities: ( entities: unknown[] ) => unknown;
    focusByHermesId: ( hermesId: string ) => boolean;
    state: () => unknown;
    dispose: () => void;
}

// ---------------------------------------------------------------------------
//  Buffer slot enum (as documented in HERMES_ENGINEERING_REFERENCE.md)
// ---------------------------------------------------------------------------

export const BUFFER_SLOT = {
    SOUNDS: 11,
    PLAYERS_LEGACY: 8,
    PLAYERS: 10,
    PRODUCTION: 9,
    SPRITES_ON_TILE_LINE: 1,
    PATHFINDING_REGIONS: 4,
    KILLED_UNITS_THIS_FRAME: 2,
    DELETED_SPRITES: 3,
    DELETED_IMAGES: 6,
    BULLETS: 7,
    ISCRIPT_BIN: 12,
} as const;

export const COUNT_SLOT = {
    TILE_COUNT: 0,
    LAST_ERROR: 1,
    KILLED_UNITS: 2,
    DELETED_SPRITES: 3,
    DELETED_IMAGES: 6,
    BULLETS: 7,
    SOUNDS: 13,
    SPRITES_ON_TILE_LINE: 14,
} as const;

// ---------------------------------------------------------------------------
//  Build params
// ---------------------------------------------------------------------------

export interface CreateHermesApiParams {
    world: World;
    assets: Assets;
    pxToWorld: PxToWorld;
    pxToWorldInverse: PxToWorld;
    sandboxApi: SandboxAPI;
    bridgeRef: { current: InstalledBridge | null };
    sceneComposer?: {
        scene?: unknown;
        units?: { get?: ( id: number ) => unknown };
        selectedUnits?: {
            set?: ( units: unknown[] ) => void;
            _dangerousArray?: unknown[];
        };
    };
    viewControllerComposer?: {
        viewports?: Array<{
            orbit?: {
                moveTo?: ( x: number, y: number, z: number, animate: boolean ) => void;
                dollyTo?: ( d: number, animate: boolean ) => void;
                minDistance?: number;
                maxDistance?: number;
            } | null;
        }>;
    };
}

// ---------------------------------------------------------------------------
//  WASM extension surface
// ---------------------------------------------------------------------------

interface ExtendedOpenBWWasm {
    _can_place_building_at?: (
        typeId: number,
        owner: number,
        x: number,
        y: number
    ) => number;
    _is_reachable?: ( unitId: number, x: number, y: number ) => number;
    _set_player_resources?: ( p: number, m: number, g: number ) => void;
    _set_player_controller?: ( p: number, c: number ) => void;
    _image_run_anim?: ( imageAddr: number, animId: number ) => void;
    _play_sound?: ( soundId: number, x: number, y: number, unitTypeId: number ) => void;
    _set_volume?: ( percent: number ) => void;
    _create_unit: ( typeId: number, owner: number, x: number, y: number ) => number;
    _counts: ( idx: number ) => number;
    _get_buffer: ( idx: number ) => number;
    _set_player_visibility: ( mask: number ) => void;
    _generate_frame: () => void;
    HEAP32: Int32Array;
    HEAPU8: Uint8Array;
    HEAPU16: Uint16Array;
    HEAPF32: Float32Array;
    get_util_funcs: () => {
        kill_unit: ( id: number ) => number;
        remove_unit: ( id: number ) => number;
        issue_command: (
            unitId: number,
            cmd: number,
            target: number,
            x: number,
            y: number,
            extra: number
        ) => boolean;
        dump_unit: ( addr: number ) => unknown;
    };
}

// ---------------------------------------------------------------------------
//  Capability descriptor for `describe()`
// ---------------------------------------------------------------------------

export interface CapabilityDescriptor {
    name: string;
    domain: string;
    available: boolean;
    requires?: string;
    args?: string[];
    description: string;
}

// ---------------------------------------------------------------------------
//  Implementation
// ---------------------------------------------------------------------------

export const createHermesApi = ( params: CreateHermesApiParams ) => {
    const { world, assets, pxToWorld, pxToWorldInverse, sandboxApi, bridgeRef } = params;
    const openBW = world.openBW as unknown as OpenBW & ExtendedOpenBWWasm;

    const safe = <T>( fn: () => T ): ApiResult<T> => {
        try {
            return ok( fn() );
        } catch ( e ) {
            const msg =
                typeof e === "number"
                    ? openBW.getExceptionMessage( e )
                    : e instanceof Error
                    ? e.message
                    : String( e );
            return err( msg );
        }
    };

    const has = ( method: keyof ExtendedOpenBWWasm ): boolean =>
        typeof openBW[method] === "function";

    // --- feature detection ------------------------------------------------

    const features = {
        canPlaceBuilding: has( "_can_place_building_at" ),
        isReachable: has( "_is_reachable" ),
        setPlayerResources: has( "_set_player_resources" ),
        setPlayerController: has( "_set_player_controller" ),
        imageRunAnim: has( "_image_run_anim" ),
        playSound: has( "_play_sound" ),
        setVolume: has( "_set_volume" ),
        // Hermes 2026-04 spawn-anything pass: brand-new exports
        // shipped in the rebuilt titan.wasm. Lets the dashboard
        // force-spawn ANY unit / building anywhere (bypassing
        // can_place_building) and morph existing units to new types.
        createCompletedUnitAt: has( "_create_completed_unit_at" ),
        morphUnitAt: has( "_morph_unit_at" ),
    };

    // Hermes 2026-04 spawn-anything pass: dump the detected features
    // so the user can verify the dashboard sees the rebuilt wasm. The
    // HermesApiPanel will show "9/9 optional WASM exports" green pill
    // when all are present. Useful regression detector — if this drops
    // back to 0/9 you know `mix()` ran before the wasm exports were
    // wired onto Module.
    console.log(
        "[hermes-api] feature detection:",
        Object.entries( features )
            .map( ( [ k, v ] ) => `${k}=${v ? "✓" : "✗"}` )
            .join( " " )
    );

    // --- diagnostics ------------------------------------------------------

    const diagnostics = {
        getLastError: () => openBW._counts( COUNT_SLOT.LAST_ERROR ),
        getLastErrorMessage: () => openBW.getLastErrorMessage(),
        tileCount: () => openBW._counts( COUNT_SLOT.TILE_COUNT ),
        soundCount: () => openBW._counts( COUNT_SLOT.SOUNDS ),
        killedThisFrame: () => openBW._counts( COUNT_SLOT.KILLED_UNITS ),
        bulletCount: () => openBW._counts( COUNT_SLOT.BULLETS ),
        getCounts: ( idx: number ) => openBW._counts( idx ),
        getBufferAddr: ( idx: number ) => openBW._get_buffer( idx ),
    };

    // --- player control ---------------------------------------------------

    const players = {
        setResources: ( playerId: number, minerals: number, gas: number ): ApiResult => {
            // Prefer the WASM export if present (rebuilt titan.wasm) — only
            // path that actually persists across frames.
            if ( features.setPlayerResources ) {
                return safe( () => {
                    openBW._set_player_resources!( playerId, minerals, gas );
                    return { playerId, minerals, gas, via: "wasm" };
                } );
            }
            // JS fallback: write into the PLAYERS_LEGACY snapshot buffer.
            // NOTE: the engine recomputes this buffer every frame from its
            // authoritative `state_t.players[i].minerals` field, so the
            // change is only visible until generate_frame() runs again.
            // Useful for one-off display overrides; not a true cheat console.
            return safe( () => {
                const addr = openBW._get_buffer( BUFFER_SLOT.PLAYERS_LEGACY );
                const off = ( addr >> 2 ) + 7 * playerId;
                openBW.HEAP32[ off + 0 ] = minerals | 0;
                openBW.HEAP32[ off + 1 ] = gas | 0;
                return {
                    playerId,
                    minerals,
                    gas,
                    via: "heap-snapshot",
                    note: "transient: overwritten next frame; rebuild wasm with _set_player_resources for persistent changes",
                };
            } );
        },
        setController: ( playerId: number, controller: number ): ApiResult => {
            if ( features.setPlayerController ) {
                return safe( () => {
                    openBW._set_player_controller!( playerId, controller );
                    return { playerId, controller, via: "wasm" };
                } );
            }
            // JS fallback: write to player_t.controller via getPlayersAddress.
            // Layout per PlayerBufferView/PlayerBufferViewIterator in
            // src/openbw/structs/player-buffer-view.ts: stride 5*4 bytes,
            // first slot at offset 5*4 from base, controller at addr32+0.
            return safe( () => {
                const getPlayersAddress = (
                    openBW as unknown as { getPlayersAddress?: () => number }
                ).getPlayersAddress;
                if ( typeof getPlayersAddress !== "function" ) {
                    throw new Error( "getPlayersAddress not available" );
                }
                let addr = getPlayersAddress.call( openBW );
                addr = addr + ( ( playerId + 1 ) * 5 << 2 );
                openBW.HEAP32[ addr >> 2 ] = controller | 0;
                return { playerId, controller, via: "heap" };
            } );
        },
        setVisibility: ( playerMask: number ): ApiResult => {
            return safe( () => {
                openBW._set_player_visibility( playerMask );
                return { playerMask };
            } );
        },
        list: () =>
            world.players.map( ( p ) => ( {
                id: p.id,
                name: p.name,
                race: p.race,
                vision: p.vision,
            } ) ),
        readResources: ( playerId: number ): ApiResult => {
            return safe( () => {
                const addr = openBW._get_buffer( BUFFER_SLOT.PLAYERS_LEGACY );
                const off = ( addr >> 2 ) + 7 * playerId;
                return {
                    minerals: openBW.HEAP32[ off + 0 ] ?? 0,
                    vespeneGas: openBW.HEAP32[ off + 1 ] ?? 0,
                    supply: openBW.HEAP32[ off + 2 ] ?? 0,
                    supplyMax: openBW.HEAP32[ off + 3 ] ?? 0,
                    workerSupply: openBW.HEAP32[ off + 4 ] ?? 0,
                    armySupply: openBW.HEAP32[ off + 5 ] ?? 0,
                    apm: openBW.HEAP32[ off + 6 ] ?? 0,
                };
            } );
        },
    };

    // --- units ------------------------------------------------------------

    const units = {
        create: (
            typeId: number,
            owner: number,
            xPx: number,
            yPx: number
        ): ApiResult => {
            return safe( () => {
                const addr = openBW._create_unit( typeId, owner, xPx, yPx );
                if ( addr === 0 ) {
                    const msg =
                        openBW.getLastErrorMessage() ?? "create_unit returned 0";
                    throw new Error( msg );
                }
                return { address: addr };
            } );
        },
        kill: ( unitId: number ): ApiResult => {
            return safe( () => openBW.get_util_funcs().kill_unit( unitId ) );
        },
        remove: ( unitId: number ): ApiResult => {
            return safe( () => openBW.get_util_funcs().remove_unit( unitId ) );
        },
        issueCommand: (
            unitId: number,
            commandType: number,
            targetUnitId = 0,
            x = 0,
            y = 0,
            extra = 0
        ): ApiResult => {
            return safe( () =>
                openBW
                    .get_util_funcs()
                    .issue_command(
                        unitId,
                        commandType,
                        targetUnitId,
                        x,
                        y,
                        extra
                    )
            );
        },
        canPlaceBuilding: (
            typeId: number,
            owner: number,
            xPx: number,
            yPx: number
        ): ApiResult<boolean> => {
            if ( !features.canPlaceBuilding ) {
                return err(
                    "_can_place_building_at not exported (legacy wasm). Rebuild required."
                );
            }
            return safe(
                () => openBW._can_place_building_at!( typeId, owner, xPx, yPx ) !== 0
            );
        },
        isReachable: (
            unitId: number,
            xPx: number,
            yPx: number
        ): ApiResult<boolean> => {
            if ( !features.isReachable ) {
                return err(
                    "_is_reachable not exported (legacy wasm). Rebuild required."
                );
            }
            return safe( () => openBW._is_reachable!( unitId, xPx, yPx ) !== 0 );
        },
        // High-level wrappers (delegate to sandboxApi)
        attackMove: sandboxApi.orderUnitAttackMove.bind( sandboxApi ),
        move: sandboxApi.orderUnitMove.bind( sandboxApi ),
        attackUnit: sandboxApi.orderUnitAttackUnit.bind( sandboxApi ),
        rightClick: sandboxApi.orderUnitRightClick.bind( sandboxApi ),
        train: sandboxApi.orderUnitTrain.bind( sandboxApi ),
        build: sandboxApi.orderUnitBuild.bind( sandboxApi ),

        // Hermes 2026-04 spawn-anything pass: force-spawn ANY unit /
        // building anywhere inside the map. Bypasses
        // `can_place_building` via the new `_create_completed_unit_at`
        // C++ shim shipped in the rebuilt titan.wasm. Returns the
        // resulting unit pointer (cast to a number) on success, an
        // error if the wasm rebuild isn't loaded.
        forceSpawnAt: (
            typeId: number,
            owner: number,
            xPx: number,
            yPx: number
        ): ApiResult<number> => {
            if ( !features.createCompletedUnitAt ) {
                return err(
                    "_create_completed_unit_at not exported (legacy wasm). Rebuild required."
                );
            }
            return safe( () =>
                openBW._create_completed_unit_at!( typeId, owner, xPx, yPx )
            );
        },

        // Hermes 2026-04 spawn-anything pass: morph a unit to a new
        // type id in place. Wraps C++ `state_functions::morph_unit`.
        // Returns 1 on success, 0 on failure.
        morphAt: (
            unitId: number,
            newTypeId: number
        ): ApiResult<number> => {
            if ( !features.morphUnitAt ) {
                return err(
                    "_morph_unit_at not exported (legacy wasm). Rebuild required."
                );
            }
            return safe( () =>
                openBW._morph_unit_at!( unitId, newTypeId )
            );
        },

        // Hermes 2026-04 spawn-anything pass: search for a valid tile
        // within `searchRadiusTiles` (default 4) of (xPx, yPx) using
        // `_can_place_building_at`. Returns the first valid tile
        // (xPx, yPx) found, or null if none. Useful for the dashboard
        // to find polite placements before falling back to forceSpawnAt.
        findPlacement: (
            typeId: number,
            owner: number,
            xPx: number,
            yPx: number,
            searchRadiusTiles: number = 4
        ): ApiResult<{ xPx: number; yPx: number } | null> => {
            if ( !features.canPlaceBuilding ) {
                return err(
                    "_can_place_building_at not exported (legacy wasm). Rebuild required."
                );
            }
            return safe( () => {
                const TILE = 32;
                for ( let r = 0; r <= searchRadiusTiles; r++ ) {
                    for ( let dy = -r; dy <= r; dy++ ) {
                        for ( let dx = -r; dx <= r; dx++ ) {
                            if ( r > 0 && Math.abs( dx ) !== r && Math.abs( dy ) !== r ) continue;
                            const tx = xPx + dx * TILE;
                            const ty = yPx + dy * TILE;
                            if ( openBW._can_place_building_at!( typeId, owner, tx, ty ) === 1 ) {
                                return { xPx: tx, yPx: ty };
                            }
                        }
                    }
                }
                return null;
            } );
        },
    };

    // --- audio ------------------------------------------------------------

    const audio = {
        loadCascAudio: ( filename: string ) => mixer.loadCascAudio( filename ),
        loadCascAudioById: ( soundId: number ) =>
            mixer.loadCascAudioById( soundId ),
        playReadyById: async ( unitTypeId: number ): Promise<ApiResult> => {
            try {
                const ud = assets.bwDat?.units?.[ unitTypeId ];
                if ( !ud || !ud.readySound ) {
                    return err( `unit ${unitTypeId} has no readySound` );
                }
                const buf = await mixer.loadCascAudioById( ud.readySound );
                const src = mixer.context.createBufferSource();
                src.buffer = buf;
                src.connect( mixer.sound );
                src.start();
                return ok( { soundId: ud.readySound } );
            } catch ( e ) {
                return err(
                    e instanceof Error ? e.message : String( e )
                );
            }
        },
        playWhatById: async ( unitTypeId: number ): Promise<ApiResult> => {
            try {
                const ud = assets.bwDat?.units?.[ unitTypeId ];
                if ( !ud || !ud.whatSound || ud.whatSound.length === 0 ) {
                    return err( `unit ${unitTypeId} has no whatSound` );
                }
                const id = ud.whatSound[ Math.floor( Math.random() * ud.whatSound.length ) ];
                const buf = await mixer.loadCascAudioById( id );
                const src = mixer.context.createBufferSource();
                src.buffer = buf;
                src.connect( mixer.sound );
                src.start();
                return ok( { soundId: id } );
            } catch ( e ) {
                return err( e instanceof Error ? e.message : String( e ) );
            }
        },
        playYesById: async ( unitTypeId: number ): Promise<ApiResult> => {
            try {
                const ud = assets.bwDat?.units?.[ unitTypeId ];
                if ( !ud || !ud.yesSound || ud.yesSound.length === 0 ) {
                    return err( `unit ${unitTypeId} has no yesSound` );
                }
                const id = ud.yesSound[ Math.floor( Math.random() * ud.yesSound.length ) ];
                const buf = await mixer.loadCascAudioById( id );
                const src = mixer.context.createBufferSource();
                src.buffer = buf;
                src.connect( mixer.sound );
                src.start();
                return ok( { soundId: id } );
            } catch ( e ) {
                return err( e instanceof Error ? e.message : String( e ) );
            }
        },
        playPissById: async ( unitTypeId: number ): Promise<ApiResult> => {
            try {
                const ud = assets.bwDat?.units?.[ unitTypeId ];
                if ( !ud || !ud.pissSound || ud.pissSound.length === 0 ) {
                    return err( `unit ${unitTypeId} has no pissSound` );
                }
                const id = ud.pissSound[ Math.floor( Math.random() * ud.pissSound.length ) ];
                const buf = await mixer.loadCascAudioById( id );
                const src = mixer.context.createBufferSource();
                src.buffer = buf;
                src.connect( mixer.sound );
                src.start();
                return ok( { soundId: id } );
            } catch ( e ) {
                return err( e instanceof Error ? e.message : String( e ) );
            }
        },
        playFile: async ( filename: string ): Promise<ApiResult> => {
            try {
                const buf = await mixer.loadCascAudio( filename );
                const src = mixer.context.createBufferSource();
                src.buffer = buf;
                src.connect( mixer.sound );
                src.start();
                return ok( { filename } );
            } catch ( e ) {
                return err( e instanceof Error ? e.message : String( e ) );
            }
        },
        playInGame: async (
            soundId: number,
            xPx: number,
            yPx: number,
            unitTypeId = -1
        ): Promise<ApiResult> => {
            // Prefer engine-side positional audio when the rebuilt wasm is
            // available — it routes through bwgame's sound mixer with proper
            // per-listener falloff.
            if ( features.playSound ) {
                return safe( () => {
                    openBW._play_sound!( soundId, xPx, yPx, unitTypeId );
                    return { soundId, xPx, yPx, via: "wasm" };
                } );
            }
            // JS fallback: use the JS-side mixer + bwDat.sounds entry's
            // CASC filename. We don't have positional audio here yet, but
            // the sound DOES play, and the dashboard can render the
            // positional cue separately.
            try {
                const buf = await mixer.loadCascAudioById( soundId );
                const src = mixer.context.createBufferSource();
                src.buffer = buf;
                src.connect( mixer.sound );
                src.start();
                return ok( { soundId, xPx, yPx, via: "mixer" } );
            } catch ( e ) {
                return err( e instanceof Error ? e.message : String( e ) );
            }
        },
        setMasterVolume: ( percent: number ) => {
            mixer.masterVolume = percent / 100;
            if ( features.setVolume ) {
                try {
                    openBW._set_volume!( percent );
                } catch {
                    /* non-fatal */
                }
            }
            return ok( { percent } );
        },
    };

    // --- camera & viewport ------------------------------------------------

    const camera = {
        focusOnTile: ( xPx: number, yPx: number, animate = true ): ApiResult => {
            if ( ( globalThis as Record< string, unknown > ).__hermesCameraLocked ) {
                return err( "camera is locked" );
            }
            const vp = params.viewControllerComposer?.viewports?.[ 0 ];
            const orbit = vp?.orbit;
            if ( !orbit?.moveTo ) return err( "no orbit camera available" );
            return safe( () => {
                const tmp = { x: 0, y: 0, z: 0 };
                pxToWorld.xyz( xPx, yPx, tmp as never );
                orbit.moveTo!.call( orbit, tmp.x, tmp.y, tmp.z, animate );
                return { xPx, yPx };
            } );
        },
        zoom: ( distance: number, animate = true ): ApiResult => {
            const vp = params.viewControllerComposer?.viewports?.[ 0 ];
            const orbit = vp?.orbit;
            if ( !orbit?.dollyTo ) return err( "no orbit camera available" );
            return safe( () => {
                const minDistance = orbit.minDistance ?? distance;
                const maxDistance = orbit.maxDistance ?? distance;
                const clampedDistance = Math.max(
                    minDistance,
                    Math.min( maxDistance, distance )
                );
                orbit.dollyTo!.call( orbit, clampedDistance, animate );
                return { distance: clampedDistance, requestedDistance: distance };
            } );
        },
    };

    // --- bwDat surface ----------------------------------------------------

    const bwDat = {
        units: () => assets.bwDat?.units ?? [],
        unit: ( id: number ) => assets.bwDat?.units?.[ id ] ?? null,
        weapons: () => assets.bwDat?.weapons ?? [],
        sounds: () => assets.bwDat?.sounds ?? [],
        upgrades: () => assets.bwDat?.upgrades ?? [],
        tech: () => assets.bwDat?.tech ?? [],
        orders: () => assets.bwDat?.orders ?? [],
        portraits: () => assets.bwDat?.portraits ?? [],
        strings: () => assets.bwDat?.strings ?? [],
        stringAt: ( id: number ) => assets.bwDat?.strings?.[ id ] ?? null,
        unitName: ( typeId: number ) => assets.bwDat?.units?.[ typeId ]?.name ?? null,
    };

    // --- entity bridge passthrough ---------------------------------------

    const entities = {
        place: ( payload: unknown[] ) => {
            const b = bridgeRef.current;
            if ( !b ) return err( "entity bridge not installed" );
            return safe( () => b.placeEntities( payload ) );
        },
        focus: ( hermesId: string ) => {
            const b = bridgeRef.current;
            if ( !b ) return err( "entity bridge not installed" );
            return safe( () => b.focusByHermesId( hermesId ) );
        },
        snapshot: () => {
            const b = bridgeRef.current;
            if ( !b ) return err( "entity bridge not installed" );
            return safe( () => b.state() );
        },
    };

    // --- map / coords -----------------------------------------------------

    const map = {
        info: () => ( {
            title: world.map?.title ?? null,
            tileset: world.map?.tileset ?? null,
            size: world.map?.size ?? [ 0, 0 ],
            description: world.map?.description ?? null,
        } ),
        pxToWorld: ( xPx: number, yPx: number ) => {
            const out = { x: 0, y: 0, z: 0 };
            pxToWorld.xyz( xPx, yPx, out as never );
            return out;
        },
        worldToPx: ( wx: number, wz: number ) => {
            const out = { x: 0, y: 0, z: 0 };
            pxToWorldInverse.xyz( wx, wz, out as never );
            return out;
        },
    };

    // --- frame / playback control ----------------------------------------

    const frame = {
        getCurrentFrame: () => openBW.getCurrentFrame(),
        getReplayFrame: () => openBW.getCurrentReplayFrame(),
        setPaused: ( paused: boolean ) => safe( () => openBW.setPaused( paused ) ),
        isPaused: () => openBW.isPaused(),
        setGameSpeed: ( speed: number ) =>
            safe( () => openBW.setGameSpeed( speed ) ),
        getGameSpeed: () => openBW.getGameSpeed(),
        nextFrame: () => safe( () => openBW.nextFrame() ),
        nextStep: () => safe( () => openBW.nextStep() ),
        generateFrame: () => safe( () => openBW.generateFrame() ),
        isSandbox: () => openBW.isSandboxMode(),
        setSandbox: ( enabled: boolean ) =>
            safe( () => openBW.setSandboxMode( enabled ) ),
    };

    // --- describe ---------------------------------------------------------

    const describe = (): CapabilityDescriptor[] => [
        // diagnostics
        { name: "diagnostics.getLastError", domain: "diagnostics", available: true, description: "Last error code from a failed _create_unit call (uses fixed _counts(1) slot)" },
        { name: "diagnostics.getLastErrorMessage", domain: "diagnostics", available: true, description: "Human-readable message for the last error code" },
        // players
        { name: "players.list", domain: "players", available: true, description: "List of all players with id/name/race/vision" },
        { name: "players.readResources", domain: "players", available: true, args: ["playerId"], description: "Live mineral/gas/supply/APM for a player from buffer slot 8" },
        { name: "players.setVisibility", domain: "players", available: true, args: ["playerMask"], description: "Set per-player visibility bitmask (bit i = player i visible)" },
        { name: "players.setResources", domain: "players", available: true, requires: features.setPlayerResources ? undefined : "JS fallback writes to snapshot buffer (transient — overwritten next frame). Rebuild wasm for persistence.", args: ["playerId", "minerals", "gas"], description: "Cheat console: set a player's mineral/gas resources" },
        { name: "players.setController", domain: "players", available: true, requires: features.setPlayerController ? undefined : "JS fallback (direct HEAP32 write to player_t)", args: ["playerId", "controller"], description: "Flip a player slot between human/computer/neutral/closed" },
        // units
        { name: "units.create", domain: "units", available: true, args: ["typeId", "owner", "xPx", "yPx"], description: "Spawn a unit at the given pixel coords. Returns the unit's WASM address." },
        { name: "units.kill", domain: "units", available: true, args: ["unitId"], description: "Kill a unit by id" },
        { name: "units.remove", domain: "units", available: true, args: ["unitId"], description: "Remove a unit (no death animation)" },
        { name: "units.issueCommand", domain: "units", available: true, args: ["unitId", "commandType", "targetUnitId", "x", "y", "extra"], description: "Issue a raw OpenBW command (see ISSUE_COMMAND enum)" },
        { name: "units.canPlaceBuilding", domain: "units", available: features.canPlaceBuilding, requires: "_can_place_building_at WASM export", args: ["typeId", "owner", "xPx", "yPx"], description: "Real SC building placement validation (terrain/creep/psi/collision)" },
        { name: "units.isReachable", domain: "units", available: features.isReachable, requires: "_is_reachable WASM export", args: ["unitId", "xPx", "yPx"], description: "Pathfinding pre-flight check" },
        // audio
        { name: "audio.playReadyById", domain: "audio", available: true, args: ["unitTypeId"], description: "Play the unit's 'ready' voice line (e.g. 'Marine ready')" },
        { name: "audio.playWhatById", domain: "audio", available: true, args: ["unitTypeId"], description: "Play one of the unit's 'what' voice lines" },
        { name: "audio.playYesById", domain: "audio", available: true, args: ["unitTypeId"], description: "Play one of the unit's 'yes' (acknowledgement) voice lines" },
        { name: "audio.playPissById", domain: "audio", available: true, args: ["unitTypeId"], description: "Play one of the unit's 'pissed' voice lines" },
        { name: "audio.playFile", domain: "audio", available: true, args: ["filename"], description: "Play a CASC sound file by relative path (e.g. 'sound/Misc/Buzz.wav')" },
        { name: "audio.playInGame", domain: "audio", available: true, requires: features.playSound ? undefined : "JS fallback via CASC mixer (no positional falloff)", args: ["soundId", "xPx", "yPx", "unitTypeId"], description: "Programmatic in-engine SFX. WASM path adds positional audio." },
        { name: "audio.setMasterVolume", domain: "audio", available: true, args: ["percent"], description: "Set master volume (0-100)" },
        // camera
        { name: "camera.focusOnTile", domain: "camera", available: true, args: ["xPx", "yPx", "animate"], description: "Pan the camera to a tile coordinate" },
        { name: "camera.zoom", domain: "camera", available: true, args: ["distance", "animate"], description: "Set the camera dolly distance" },
        // entities
        { name: "entities.place", domain: "entities", available: true, args: ["payload"], description: "Spawn / update / kill Hermes entities (mirrors postMessage flow)" },
        { name: "entities.focus", domain: "entities", available: true, args: ["hermesId"], description: "Pan camera to the given Hermes entity and select the underlying SC unit" },
        { name: "entities.snapshot", domain: "entities", available: true, description: "Live count of installed entities and their type breakdown" },
        // bwDat
        { name: "bwDat.unit", domain: "bwDat", available: true, args: ["id"], description: "Get a UnitDAT entry by typeId" },
        { name: "bwDat.units", domain: "bwDat", available: true, description: "All UnitDAT entries (228 unit types)" },
        { name: "bwDat.weapons", domain: "bwDat", available: true, description: "All WeaponDAT entries" },
        { name: "bwDat.sounds", domain: "bwDat", available: true, description: "All SoundDAT entries" },
        { name: "bwDat.upgrades", domain: "bwDat", available: true, description: "All UpgradeDAT entries" },
        { name: "bwDat.tech", domain: "bwDat", available: true, description: "All TechDataDAT entries" },
        { name: "bwDat.orders", domain: "bwDat", available: true, description: "All OrderDAT entries" },
        { name: "bwDat.portraits", domain: "bwDat", available: ( assets.bwDat?.portraits?.length ?? 0 ) > 0, description: "Talking-portrait entries from arr/portdata.dat (220 portraits)" },
        { name: "bwDat.strings", domain: "bwDat", available: ( assets.bwDat?.strings?.length ?? 0 ) > 0, description: "Master string table from rez/stat_txt.tbl (~3000 entries)" },
        // map
        { name: "map.info", domain: "map", available: true, description: "Loaded map metadata (title/tileset/size)" },
        { name: "map.pxToWorld", domain: "map", available: true, args: ["xPx", "yPx"], description: "Convert SC pixel coords to Three.js world coords" },
        { name: "map.worldToPx", domain: "map", available: true, args: ["wx", "wz"], description: "Convert Three.js world coords back to SC pixel coords" },
        // frame
        { name: "frame.getCurrentFrame", domain: "frame", available: true, description: "Current OpenBW game frame number" },
        { name: "frame.setPaused", domain: "frame", available: true, args: ["paused"], description: "Pause/resume the game loop" },
        { name: "frame.setGameSpeed", domain: "frame", available: true, args: ["speed"], description: "Set game speed multiplier (1=normal, 8=fastest)" },
        { name: "frame.setSandbox", domain: "frame", available: true, args: ["enabled"], description: "Toggle sandbox mode (only effective during replay playback)" },
        // engine
        { name: "engine.features", domain: "engine", available: true, description: "Bitmap of which optional WASM exports are present" },
    ];

    return {
        version: "1.0.0",
        builtAt: "2026-04-27",
        features,
        diagnostics,
        players,
        units,
        audio,
        camera,
        entities,
        bwDat,
        map,
        frame,
        describe,
        ISSUE_COMMAND,
        PLAYER_CONTROLLER,
        BUFFER_SLOT,
        COUNT_SLOT,
    };
};

export type HermesAPI = ReturnType<typeof createHermesApi>;

// ---------------------------------------------------------------------------
//  postMessage protocol — let cross-origin React drive the API
// ---------------------------------------------------------------------------

/**
 * Install a window-level postMessage listener that proxies any
 * { type: "hermes:api:invoke", reqId, path, args } message into a method
 * call on the API and replies with { type: "hermes:api:reply", reqId, result }.
 *
 * `path` is dot-separated (e.g. "audio.playReadyById"). Arguments are passed
 * as an array. Async results are awaited automatically. All replies are
 * structured `ApiResult` so the dashboard never has to guess what failed.
 */
export const installHermesApiPostMessageBridge = ( api: HermesAPI ) => {
    const lookup = ( path: string ): unknown => {
        const segs = path.split( "." );
        let node: unknown = api;
        for ( const seg of segs ) {
            if ( node && typeof node === "object" && seg in ( node as Record<string, unknown> ) ) {
                node = ( node as Record<string, unknown> )[ seg ];
            } else {
                return undefined;
            }
        }
        return node;
    };

    const onMessage = async ( ev: MessageEvent ) => {
        const data = ev.data as
            | { type?: string; reqId?: string; path?: string; args?: unknown[] }
            | null;
        if ( !data || typeof data !== "object" ) return;
        if ( data.type !== "hermes:api:invoke" ) return;
        const { reqId, path, args } = data;
        if ( typeof reqId !== "string" || typeof path !== "string" ) return;
        const target = lookup( path );
        let reply: ApiResult;
        if ( typeof target !== "function" ) {
            reply = err( `unknown api method: ${path}` );
        } else {
            try {
                const result = await ( target as ( ...a: unknown[] ) => unknown ).apply(
                    null,
                    Array.isArray( args ) ? args : []
                );
                // If the method already returned an ApiResult, pass through.
                if (
                    result &&
                    typeof result === "object" &&
                    "ok" in ( result as Record<string, unknown> )
                ) {
                    reply = result as ApiResult;
                } else {
                    reply = ok( result );
                }
            } catch ( e ) {
                reply = err( e instanceof Error ? e.message : String( e ) );
            }
        }
        try {
            const target =
                ev.source && typeof ( ev.source as Window ).postMessage === "function"
                    ? ( ev.source as Window )
                    : window.parent;
            target.postMessage(
                { type: "hermes:api:reply", reqId, result: reply },
                "*"
            );
        } catch {
            /* non-fatal */
        }
    };

    window.addEventListener( "message", onMessage );

    // Announce the API to the parent so the dashboard can render
    // discoverability UI without polling.
    try {
        window.parent?.postMessage(
            {
                type: "hermes:api:ready",
                version: api.version,
                features: api.features,
                manifest: api.describe(),
            },
            "*"
        );
    } catch {
        /* non-fatal */
    }

    return () => window.removeEventListener( "message", onMessage );
};
