import { OpenBW } from "@openbw/openbw";
import { Assets } from "@image/assets";
import { Janitor } from "three-janitor";
import { ApiSession } from "./api-session";
import { createSettingsSessionStore } from "./settings-session-store";
import { GameTimeApi } from "./game-time-api";
import { SimpleText } from "@render/simple-text";
import { createSandboxApi } from "@openbw/sandbox-api";
import { createSceneComposer } from "./scene-composer";
import { createPostProcessingComposer } from "./postprocessing-composer";
import { BasePlayer, Players } from "../players";
import { FogOfWar, FogOfWarEffect } from "../fogofwar";
import { createSurfaceComposer } from "./surface-composer";
import { createOpenBWComposer } from "./openbw-composer";
import { createOverlayComposer } from "./overlay-composer";
import { createCommandsComposer } from "./commands-composer";
import { createGameLoopComposer } from "./game-loop-composer";
import { createViewControllerComposer } from "./view-controller-composer";
import { TypeEmitter } from "@utils/type-emitter";
import { World } from "./world";
import { mix } from "@utils/object-utils";
import { WorldEvents } from "./world-events";
import { createInputComposer } from "./input-composer";
import { settingsStore } from "@stores/settings-store";
import { globalEvents } from "@core/global-events";
import { createSelectionDisplayComposer } from "@core/selection-objects";
import { useReplayAndMapStore } from "@stores/replay-and-map-store";
import { mixer } from "@audio/main-mixer";
import { CommandsStream } from "process-replay";
import { log } from "@ipc/log";
import { pluginsStore } from "@stores/plugins-store";
import { getTitanWebGLCompatMode } from "common/titan-webgl-compat";
import { unitTypes } from "common/enums";
import { makePxToWorld } from "common/utils/conversions";
import { getMapTiles } from "@utils/chk-utils";
import { terrainComposer } from "@image/generate-map/terrain-composer";
import { UnitTileScale } from "common/types";
import { Vector3 } from "three";
import { installHermesEntityBridge } from "./hermes-entity-bridge";
import {
    createHermesApi,
    installHermesApiPostMessageBridge,
} from "./hermes-api";
import { StdVector } from "../../openbw/structs/std-vector";

export type WorldComposer = Awaited<ReturnType<typeof createWorldComposer>>;

export const createWorldComposer = async (
    openBW: OpenBW,
    assets: Assets,
    //todo: rename to Map Player
    basePlayers: BasePlayer[],
    commands: CommandsStream
) => {
    const janitor = new Janitor( "WorldComposer" );
    const events = janitor.mop( new TypeEmitter<WorldEvents>(), "events" );
    const settings = janitor.mop( createSettingsSessionStore( events ) );

    const map = useReplayAndMapStore.getState().map!;
    const replay = useReplayAndMapStore.getState().replay;

    const fogOfWarEffect = janitor.mop( new FogOfWarEffect(), "FogOfWarEffect" );
    const fogOfWar = new FogOfWar( map.size[0], map.size[1], openBW, fogOfWarEffect );

    const world: World = {
        openBW,
        map,
        players: new Players( basePlayers ),
        commands,
        fogOfWar,
        fogOfWarEffect,
        settings,
        janitor,
        events,
        reset: () => {
            frameResetRequested = true;
        },
    };
    let frameResetRequested = false;

    log.info( "creating composers" );

    // Compat mode (runtime-detected software GL or VITE_TITAN_WEBGL_COMPAT=1)
    // downgrades terrain tile textures from HD (128px/tile) to SD (32px/tile).
    const webglCompat = getTitanWebGLCompatMode();
    const tileRes = webglCompat ? UnitTileScale.SD : UnitTileScale.HD;
    log.info( `creating terrain at ${webglCompat ? "SD" : "HD"} (${tileRes}x) due to WEBGL_COMPAT=${webglCompat ? "1" : "0"}` );

    const { terrain, ...terrainExtra } = janitor.mop(
        await terrainComposer(
            ...world.map.size,
            world.map.tileset,
            getMapTiles( world.map ),
            tileRes
        ),
        "terrain"
    );
    const pxToWorld = makePxToWorld( ...world.map.size, terrain.getTerrainY );
    const pxToWorldFlat = makePxToWorld( ...world.map.size, () => 0);
    const pxToWorldInverse = makePxToWorld( ...world.map.size, terrain.getTerrainY, true );

    const startLocations = world.map.units
    .filter( ( u ) => u.unitId === unitTypes.startLocation )
    .map( ( u ) => {
        const location = pxToWorld.xyz( u.x, u.y, new Vector3() );

        const player = world.players.find( ( p ) => p.id === u.player );
        if ( player ) {
            player.startLocation = (new Vector3).copy( location );
        }

        return location
    })   

    const playerWithStartLocation = world.players.find(p => p.startLocation);
    let initialStartLocation = playerWithStartLocation ? playerWithStartLocation.startLocation ?? new Vector3() : startLocations[0] ?? new Vector3();

    // 2026 Hermes embed: when ?hermesCenter=1 (default ON in the embed) the
    // camera should boot looking at the MAP CENTER so the user immediately
    // sees their Hermes "Command Center" (placed at world 0,0,0 by
    // hermes-entity-bridge.ts) rather than an empty corner start location.
    try {
        const qs = new URLSearchParams( window.location?.search ?? "" );
        const center = qs.get( "hermesCenter" );
        if ( center !== "0" && center !== "false" ) {
            const yAtCenter = terrain.getTerrainY( 0, 0 );
            initialStartLocation = new Vector3( 0, yAtCenter, 0 );
        }
    } catch {
        /* non-fatal */
    }

    const gameLoopComposer = createGameLoopComposer( events );
    const surfaceComposer = createSurfaceComposer( map, events );
    const viewControllerComposer = createViewControllerComposer( world, surfaceComposer, initialStartLocation );
    const sceneComposer = await createSceneComposer( world, assets, viewControllerComposer, { terrain, heightMaps: terrainExtra.heightMaps, pxToWorld } );
    const commandsComposer = createCommandsComposer( events, commands );
    const inputsComposer = createInputComposer( world, sceneComposer );
    const sandboxApi = createSandboxApi( world, pxToWorldInverse );
    const openBwComposer = createOpenBWComposer(
        world,
        pxToWorld,
        terrainExtra.creep,
        viewControllerComposer
    );

    const postProcessingComposer = createPostProcessingComposer(
        world,
        sceneComposer,
        viewControllerComposer,
        terrain,
        assets
    );
    const overlayComposer = createOverlayComposer(
        world,
        sceneComposer,
        surfaceComposer,
        inputsComposer,
        postProcessingComposer,
        viewControllerComposer,
        terrainExtra.creep,
        terrainExtra.minimapTex,
        assets
    );

    const unitSelectionComposer = createSelectionDisplayComposer( assets );
    sceneComposer.scene.add( unitSelectionComposer.group );

    // 2026 Hermes embed: expose the live scene + openBW + sceneComposer to
    // window so the diagnostic harness (scripts/titan-units-diag.mjs) can
    // walk the Three.js graph and probe game state without going through a
    // cross-origin iframe boundary. No-op outside of debugging.
    try {
        const g = globalThis as Record< string, unknown >;
        g.__hermesScene = sceneComposer.scene;
        g.__hermesSceneComposer = sceneComposer;
        g.__hermesOpenBW = world.openBW;
        g.__hermesUnits = sceneComposer.units;
        g.__hermesSprites = sceneComposer.sprites;
        g.__hermesImages = sceneComposer.images;
        g.__hermesPlayers = world.players;
        g.__hermesPostProcessing = postProcessingComposer;
        g.__hermesOverlay = overlayComposer;
        g.__hermesViewports = viewControllerComposer;
        g.__hermesInputs = inputsComposer;
        // Reverse-engineering surface (read-only): the deep probe needs the
        // raw World ( map / players / fogOfWar ), the bwDat tables that drive
        // every unit's placement footprint / cost / flags, and the px<->world
        // conversion used to put units on screen. Without these we can't
        // compute building placement or fog of war from the dashboard side.
        g.__hermesWorld = world;
        g.__hermesPxToWorld = pxToWorld;
        g.__hermesPxToWorldFlat = pxToWorldFlat;
        g.__hermesPxToWorldInverse = pxToWorldInverse;
        g.__hermesAssets = assets;
        g.__hermesTerrain = terrain;
    } catch {
        /* non-fatal */
    }

    // 2026 Hermes embed: when no scene controller plugin is loaded the
    // selection-box's camera is never wired up and clicks miss every unit.
    // Bind the init viewport's camera so the user can click units immediately.
    if ( viewControllerComposer.primaryCamera ) {
        inputsComposer.unitSelectionBox.camera = viewControllerComposer.primaryCamera;
    }

    // 2026 Hermes embed: install the Hermes -> Titan entity bridge so the
    // dashboard can `postMessage({ type: 'hermes:entities', entities: [...] })`
    // and have those entities materialise as live OpenBW units on the loaded
    // map. Driven entirely by the parent window — no replay required.
    //
    // This is the key seam that makes http://127.0.0.1:9120/?titan=1 actually
    // represent the user's Hermes agent state on top of the StarCraft map.
    const bridgeRef: { current: ReturnType<typeof installHermesEntityBridge> | null } = {
        current: null,
    };
    const hermesBridgeDisabled =
        new URLSearchParams( globalThis.location?.search ?? "" )
            .get( "disableHermesBridge" ) === "1";
    const hermesTraceEnabled =
        new URLSearchParams( globalThis.location?.search ?? "" ).has( "trace" );
    let hermesTraceUpdateCount = 0;
    if ( hermesBridgeDisabled ) {
        try {
            openBW.setSandboxMode( false );
            openBW.setPaused( true );
        } catch {
            // Best-effort only: this flag is for deterministic visual tests.
        }
    }

    // Hermes 2026-04 base-layout fix: pick the Hermes player's start
    // location IN CHK PIXEL COORDS (not world coords). The melee-map
    // engine already auto-spawns a Command Center + 4 SCVs there on a
    // buildable plateau next to the mineral line, so anchoring the
    // Hermes layout at that spot guarantees:
    //   1. The user actually sees a CC (and surrounding buildings get a
    //      buildable foundation to spawn on).
    //   2. SCVs spawn next to real mineral patches and can gather.
    //   3. The base looks like a base, not a heap of units in the middle
    //      of the map on a cliff.
    // Falls back to map center only if no start-location marker exists
    // for player 0 (e.g. UMS map).
    const hermesStartLocUnit = ( world.map.units ?? [] ).find(
        ( u ) => u.unitId === unitTypes.startLocation && u.player === 0
    );
    const hermesStartLocAny =
        hermesStartLocUnit ??
        ( world.map.units ?? [] ).find(
            ( u ) => u.unitId === unitTypes.startLocation
        );
    const hermesAnchorPx = hermesStartLocAny?.x;
    const hermesAnchorPy = hermesStartLocAny?.y;
    if ( hermesStartLocAny ) {
        console.log(
            `[hermes-entity-bridge] start-location anchor: player=${hermesStartLocAny.player ?? "?"} px=${hermesAnchorPx} py=${hermesAnchorPy}`
        );
    } else {
        console.log(
            "[hermes-entity-bridge] no start-location unit found in CHK; falling back to map-center anchor"
        );
    }

    // Hermes 2026-04 base-layout fix: the unit-behavior loop
    // (hermes-unit-behavior.ts) is gated by openBW.isSandboxMode(). On a
    // pure map run (not a replay) sandbox mode is OFF by default, so
    // SCVs never get gather orders, marines never patrol, etc. Force it
    // ON here so the Hermes-driven base actually feels alive.
    try {
        ( openBW as unknown as { setSandboxMode?: ( v: boolean ) => boolean } )
            .setSandboxMode?.( true );
        console.log(
            "[hermes-entity-bridge] forced sandbox mode ON so unit-behavior loop can issue gather/patrol orders"
        );
    } catch ( err ) {
        console.warn(
            "[hermes-entity-bridge] failed to force sandbox mode:",
            err
        );
    }

    try {
        if ( hermesBridgeDisabled ) {
            console.log( "[hermes-entity-bridge] disabled by URL param" );
        } else {
            const hermesBridge = installHermesEntityBridge( {
                world,
                mapWidthTiles: world.map.size[0],
                mapHeightTiles: world.map.size[1],
                hermesPlayerId: 0,
                anchorPx: hermesAnchorPx,
                anchorPy: hermesAnchorPy,
                // worldToTile omitted -> layout auto-fits the entity bounding
                // box to the loaded map with a 4-tile margin.
                pxToWorld,
                viewControllerComposer,
                sceneComposer,
                creep: terrainExtra.creep,
            } );
            bridgeRef.current = hermesBridge;
            ( globalThis as Record< string, unknown > ).__hermesEntityBridge = hermesBridge;
            janitor.mop( () => hermesBridge.dispose(), "hermes-entity-bridge" );
        }

        // Hermes 2026-04 deeper rebuild: install the master Hermes API +
        // postMessage bridge. Gives the React dashboard a single seam
        // (`globalThis.__hermesAPI` inside the iframe; `hermes:api:invoke`
        // postMessage outside) to drive every WASM capability — sandbox
        // unit creation, voice lines, camera, player resources, building
        // placement validation (when the rebuilt wasm is present), etc.
        try {
            const hermesApi = createHermesApi( {
                world,
                assets,
                pxToWorld,
                pxToWorldInverse,
                sandboxApi,
                bridgeRef,
                sceneComposer,
                viewControllerComposer,
            } );
            ( globalThis as Record< string, unknown > ).__hermesAPI = hermesApi;
            const disposeApi = installHermesApiPostMessageBridge( hermesApi );
            janitor.mop( disposeApi, "hermes-api-postmessage" );
        } catch ( apiErr ) {
            console.warn( "[hermes-api] failed to install:", apiErr );
        }

        // 2026 Hermes embed: enable fog of war on the minimap by limiting
        // vision to the Hermes-owned player only. Without this every player
        // is "vision: true" by default which means the minimap renders as
        // fully visible (no fog). Now everything outside player 0's units'
        // sight radius is fogged on the minimap exactly like a real game.
        try {
            const qs = new URLSearchParams( window.location.search );
            const fowParam = qs.get( "fogOfWar" );
            const enableFow = fowParam !== "0" && fowParam !== "false";
            if ( enableFow ) {
                for ( const player of world.players ) {
                    if ( player.id !== 0 ) {
                        player.vision = false;
                    }
                }
                world.fogOfWar.forceInstantUpdate = true;
                console.log(
                    "[hermes-entity-bridge] fog of war enabled (player 0 vision only)"
                );
            }
        } catch ( err ) {
            console.warn(
                "[hermes-entity-bridge] failed to configure fog of war:",
                err
            );
        }
    } catch ( err ) {
        console.warn(
            "[hermes-entity-bridge] failed to install:",
            err
        );
    }

    // 2026 Hermes embed: forward "world ready" so the parent knows it can
    // start streaming entity updates. This lets us avoid races where the
    // dashboard posts entities before the iframe has booted OpenBW.
    try {
        window.parent?.postMessage( { type: "titan:world-ready" }, "*" );
    } catch {
        /* non-fatal */
    }

    // 2026 Hermes embed: forward unit selection to the parent window so the
    // dashboard can show a description popup. We keep the payload small &
    // serialisable (postMessage cannot clone the full Unit object).
    events.on( "selected-units-changed", ( units ) => {
        try {
            const unitToEntity = ( globalThis as unknown as {
                __hermesUnitToEntity?: Record< number, string >;
            } ).__hermesUnitToEntity ?? {};
            const payload = units.map( ( u ) => ( {
                id: u.id,
                hermesId: unitToEntity[u.id] ?? null,
                typeId: u.typeId,
                owner: u.owner,
                x: u.x,
                y: u.y,
                hp: u.hp,
                shields: u.shields,
                energy: u.energy,
                typeName: u.extras?.dat?.name ?? null,
                isBuilding: u.extras?.dat?.isBuilding ?? false,
                isResourceContainer: u.extras?.dat?.isResourceContainer ?? false,
            } ) );
            window.parent?.postMessage(
                { type: "titan:selected-units", units: payload },
                "*"
            );
        } catch ( err ) {
            console.warn( "[world-composer] failed to forward unit selection:", err );
        }
    } );

    // 2026 Hermes embed: forward HUD data (frame, game speed, paused state,
    // per-player resources/supply/APM) to the parent window every second.
    // The dashboard renders a native-styled SC HUD from this (resources bar,
    // command card, supply counters). Reads the same OpenBW HEAP32 buffer
    // that plugin-system-ui's #onProduction() reads.
    let _hudLastPost = 0;
    const postHud = ( currentFrame: number, elapsed: number ) => {
        if ( elapsed - _hudLastPost < 500 ) return;
        _hudLastPost = elapsed;
        try {
            const openBw = world.openBW as unknown as {
                _get_buffer: ( slot: number ) => number;
                HEAP32: Int32Array;
                getGameSpeed: () => number;
                isPaused: () => boolean;
                isSandboxMode: () => boolean;
            };
            const playerDataAddr = openBw._get_buffer( 8 );
            const playerData = openBw.HEAP32.slice(
                playerDataAddr >> 2,
                ( playerDataAddr >> 2 ) + 7 * 8
            );
            const players = world.players.map( ( p ) => {
                const off = 7 * p.id;
                // p.color is a three.js Color; stringify it
                const colorAny = p.color as unknown as {
                    getHexString?: () => string;
                    isColor?: boolean;
                };
                const colorHex =
                    typeof colorAny.getHexString === "function"
                        ? "#" + colorAny.getHexString()
                        : String( p.color );
                return {
                    id: p.id,
                    name: p.name,
                    color: colorHex,
                    race: p.race,
                    minerals: playerData[off + 0] ?? 0,
                    vespeneGas: playerData[off + 1] ?? 0,
                    supply: playerData[off + 2] ?? 0,
                    supplyMax: playerData[off + 3] ?? 0,
                    workerSupply: playerData[off + 4] ?? 0,
                    armySupply: playerData[off + 5] ?? 0,
                    apm: playerData[off + 6] ?? 0,
                };
            } );
            const seconds = Math.floor( ( currentFrame * 42 ) / 1000 );
            const m = Math.floor( seconds / 60 );
            const s = seconds % 60;
            const friendlyTime = `${m}:${String( s ).padStart( 2, "0" )}`;

            let production:
                | {
                      units: number[][];
                      upgrades: number[][];
                      research: number[][];
                  }
                | undefined;
            try {
                const prodAddr = openBw._get_buffer( 9 );
                if ( prodAddr ) {
                    const productionData = new StdVector(
                        openBw.HEAP32,
                        prodAddr
                    );
                    const units: number[][] = [];
                    const upgrades: number[][] = [];
                    const research: number[][] = [];
                    for ( let player = 0; player < 8; player++ ) {
                        units.push( Array.from( productionData.copyData() ) );
                        productionData.address += 3;
                        upgrades.push( Array.from( productionData.copyData() ) );
                        productionData.address += 3;
                        research.push( Array.from( productionData.copyData() ) );
                        productionData.address += 3;
                    }
                    production = { units, upgrades, research };
                }
            } catch {
                production = undefined;
            }

            window.parent?.postMessage(
                {
                    type: "titan:hud",
                    frame: currentFrame,
                    friendlyTime,
                    gameSpeed: openBw.getGameSpeed(),
                    isPaused: openBw.isPaused(),
                    isSandbox: openBw.isSandboxMode(),
                    mapName: map.title,
                    mapSize: map.size,
                    players,
                    production,
                },
                "*"
            );
        } catch ( err ) {
            // non-fatal: the WASM may not yet expose the buffer slot
            if ( _hudLastPost === elapsed ) {
                console.warn( "[world-composer] HUD postMessage failed:", err );
            }
        }
    };

    let apiSession = new ApiSession();

    events.on( "settings-changed", ( { settings } ) => mixer.setVolumes( settings.audio ) );

    const _setSceneController = async ( controllername: string, isWebXR: boolean  ) => {
        const sceneController = apiSession.native
            .getAllSceneControllers()
            .find( ( handler ) => handler.name === controllername && handler.isWebXR === isWebXR );

        if ( sceneController ) {
            apiSession.native.activateSceneController( sceneController );
            if (viewControllerComposer.sceneController) {
                apiSession.ui.deactivatePlugin( viewControllerComposer.sceneController.name );
            }
            await viewControllerComposer.activate( sceneController);
            apiSession.ui.activatePlugins( pluginsStore().plugins.filter( p => p.name === sceneController.name ) );
            inputsComposer.unitSelectionBox.camera =
                viewControllerComposer.primaryCamera!;
        }
    };

    const unsetSceneController = () => {
        apiSession.native.activateSceneController( undefined );
        viewControllerComposer.deactivate();
    };

    events.on( "settings-changed", ( { settings, rhs } ) => {
        if (
            rhs.input?.sceneController &&
            rhs.input.sceneController !== viewControllerComposer.sceneController?.name
        ) {
            if ( !viewControllerComposer.sceneController?.isWebXR) {
                postProcessingComposer.startTransition( () => {
                    setTimeout(
                        () => _setSceneController( settings.input.sceneController, false ),
                        0
                    );
                } );
            }
        }

        if (
            rhs.input?.vrController &&
            rhs.input.vrController !== viewControllerComposer.sceneController?.name
        ) {
            if ( viewControllerComposer.sceneController?.isWebXR ) {
                _setSceneController( settings.input.vrController, true )
            }
        }
    } );

    janitor.mop(
        globalEvents.on( "xr-session-start", async () => {
            console.log("xr-session-start")
            _setSceneController( settingsStore().data.input.vrController, true );
        } )
    );

    janitor.mop(
        globalEvents.on( "xr-session-end",  () => {
            postProcessingComposer.startTransition( () => {
                setTimeout(
                    () => _setSceneController( settingsStore().data.input.sceneController, false ),
                    0
                );
            } );
        } )
    )


    const simpleText = janitor.mop( new SimpleText(), "simple-text" );

    log.info( "creating GameTimeApi" );

    /**
     * The api that is passed to the plugins and macros.
     */
    const gameTimeApi: GameTimeApi = mix(
        {
            map,
            replay,
            getCommands() {
                return commands.copy();
            },
            assets,
            exitScene() {
                setTimeout( () => {
                    settings.vars.input.sceneController.reset();
                }, 0 );
            },
            sandboxApi,
            refreshScene: () => ( frameResetRequested = true ),
            simpleMessage( val: string ) {
                simpleText.set( val );
            },
            initialStartLocation,
            startLocations,
            pxToWorld,
            pxToWorldFlat,
            pxToWorldInverse,
            terrain,
            terrainExtra
        },
        surfaceComposer.api,
        sceneComposer.api,
        openBwComposer.api,
        inputsComposer.api,
        viewControllerComposer.api,
        postProcessingComposer.api,
        overlayComposer.api,
        gameLoopComposer.api
    ) as GameTimeApi;

    log.info( "world created" );

    return {
        world,
        apiSession,

        /**
         * Must be called before any other calls on world composer.
         */
        async init() {
            surfaceComposer.resize( true );

            gameLoopComposer.onUpdate( this.update.bind( this ) );

            janitor.mop(
                globalEvents.on( "reload-all-plugins", async () => {
                    await settingsStore().init();
                    this.activate( true );
                } )
            );

            await apiSession.activate( world, gameTimeApi );
        },

        /**
         * Activate the world and start the game loop.
         *
         * @param reloadPlugins
         */
        async activate(
            reloadPlugins: boolean
        ) {
            const completedRenderMode = !!( globalThis as Record< string, unknown > )
                .__hermesCompletedRenderMode;
            console.log( `[world-composer][activate] start completedRenderMode=${completedRenderMode}` );
            if ( !completedRenderMode ) {
                try { openBW.setGameSpeed( 1 ); } catch ( e ) { console.warn( "[world-composer][activate] setGameSpeed threw:", e ); }
                try { openBW.setPaused( false ); } catch ( e ) { console.warn( "[world-composer][activate] setPaused(false) threw:", e ); }
            } else {
                console.log( "[world-composer][activate] skipped setGameSpeed/setPaused(false) for completed render mode" );
            }
            gameLoopComposer.stop();
            console.log( "[world-composer][activate] gameLoop stopped" );

            if ( reloadPlugins ) {
                events.emit( "world-end" );
                unsetSceneController();

                apiSession.dispose();
                apiSession = new ApiSession();

                await apiSession.activate( world, gameTimeApi );
                console.log( "[world-composer][activate] reloadPlugins apiSession activated" );
            }

            console.log( "[world-composer][activate] before _setSceneController" );
            try {
                await _setSceneController( settingsStore().data.input.sceneController, false );
                console.log( "[world-composer][activate] after _setSceneController" );
            } catch ( e ) {
                console.warn( "[world-composer][activate] _setSceneController threw:", e );
            }

            console.log( "[world-composer][activate] before openBwComposer.precompile" );
            if ( completedRenderMode ) {
                console.log( "[world-composer][activate] skipped openBwComposer.precompile for completed render mode" );
            } else {
                try { openBwComposer.precompile(); } catch ( e ) { console.warn( "[world-composer][activate] openBwComposer.precompile threw:", e ); }
                console.log( "[world-composer][activate] after openBwComposer.precompile" );
            }
            if ( completedRenderMode ) {
                console.log( "[world-composer][activate] skipped postProcessing.precompile for completed render mode" );
            } else {
                try { postProcessingComposer.precompile( viewControllerComposer.primaryCamera ); } catch ( e ) { console.warn( "[world-composer][activate] postProcessing.precompile threw:", e ); }
                console.log( "[world-composer][activate] after postProcessing.precompile" );
            }

            console.log( "[world-composer][activate] before resize event" );
            events.emit( "resize", surfaceComposer.gameSurface );
            console.log( "[world-composer][activate] after resize event" );

            console.log( "[world-composer][activate] before settings-changed event" );
            events.emit( "settings-changed", {
                settings: settings.getState(),
                rhs: settings.getState(),
            } );
            console.log( "[world-composer][activate] after settings-changed event" );

            console.log( "[world-composer][activate] before world-start event" );
            events.emit( "world-start" );
            console.log( "[world-composer][activate] after world-start event" );

            if ( completedRenderMode ) {
                try {
                    world.openBW.setSandboxMode( true );
                    world.openBW.setPaused( true );
                } catch ( e ) {
                    console.warn( "[world-composer][activate] re-pause threw:", e );
                }
                console.log( "[world-composer][activate] re-paused OpenBW after startup for completed render mode" );
            }

            if ( window.gc ) {
                window.gc();
            }

            console.log( "[world-composer][activate] before gameLoopComposer.start" );
            gameLoopComposer.start();
            console.log( "[world-composer][activate] after gameLoopComposer.start" );
        },

        surfaceComposer,
        sceneComposer,

        dispose: () => {
            events.emit( "world-end" );
            events.emit( "dispose" );
            apiSession.dispose();
            janitor.dispose();
        },

        /**
         * Runs every render frame
         * @param delta ms since last frame
         * @param elapsed ms since game start
         * @returns
         */
        update( delta: number, elapsed: number ) {
            if ( frameResetRequested ) {
                events.emit( "frame-reset", world.openBW.getCurrentReplayFrame() );
                frameResetRequested = false;
            }

            viewControllerComposer.update( delta );

            overlayComposer.update( delta );

            inputsComposer.update(
                delta,
                elapsed,
                viewControllerComposer,
                overlayComposer
            );

            if (
                hermesBridgeDisabled &&
                !( globalThis as Record< string, unknown > ).__hermesVisualAllowOpenBWUpdate
            ) {
                return;
            }

            const traceThisFrame = hermesTraceUpdateCount < 5;
            if ( traceThisFrame ) {
                hermesTraceUpdateCount++;
                console.log(
                    `[world-composer][update#${hermesTraceUpdateCount}] before openBW.nextFrame paused=${world.openBW.isPaused()} sandbox=${world.openBW.isSandboxMode()}`
                );
            }
            let nextBwFrame = 0;
            try {
                nextBwFrame = world.openBW.nextFrame();
            } catch ( e ) {
                console.warn( "[world-composer][update] openBW.nextFrame threw:", e );
            }
            if ( traceThisFrame ) {
                console.log(
                    `[world-composer][update#${hermesTraceUpdateCount}] after openBW.nextFrame frame=${nextBwFrame}`
                );
            }
            let openBwUpdated = false;
            try {
                openBwUpdated = openBwComposer.update( elapsed, nextBwFrame );
            } catch ( e ) {
                console.warn( "[world-composer][update] openBwComposer.update threw:", e );
            }
            if ( traceThisFrame ) {
                console.log(
                    `[world-composer][update#${hermesTraceUpdateCount}] after openBwComposer.update updated=${openBwUpdated}`
                );
            }

            if ( openBwUpdated ) {
                if ( traceThisFrame ) {
                    console.log(
                        `[world-composer][update#${hermesTraceUpdateCount}] before sceneComposer.onFrame`
                    );
                }
                try {
                    sceneComposer.onFrame(
                        delta,
                        viewControllerComposer.primaryViewport.renderMode3D
                    );
                } catch ( e ) {
                    console.warn( "[world-composer][update] sceneComposer.onFrame threw:", e );
                }
                if ( traceThisFrame ) {
                    console.log(
                        `[world-composer][update#${hermesTraceUpdateCount}] after sceneComposer.onFrame`
                    );
                    console.log( `[world-composer][update#${hermesTraceUpdateCount}] before unitSelectionComposer.update` );
                }
                try {
                    unitSelectionComposer.update(
                        sceneComposer.sprites,
                        openBwComposer.completedUpgrades,
                        sceneComposer.selectedUnits._dangerousArray
                    );
                } catch ( e ) {
                    console.warn( "[world-composer][update] unitSelectionComposer.update threw:", e );
                }
                if ( traceThisFrame ) console.log( `[world-composer][update#${hermesTraceUpdateCount}] after unitSelectionComposer.update` );

                if ( traceThisFrame ) console.log( `[world-composer][update#${hermesTraceUpdateCount}] before overlayComposer.onFrame` );
                try { overlayComposer.onFrame(); } catch ( e ) { console.warn( "[world-composer][update] overlayComposer.onFrame threw:", e ); }
                if ( traceThisFrame ) console.log( `[world-composer][update#${hermesTraceUpdateCount}] after overlayComposer.onFrame` );

                const completedRenderModeFrame = !!( globalThis as Record< string, unknown > )
                    .__hermesCompletedRenderMode;
                if ( completedRenderModeFrame ) {
                    if ( traceThisFrame ) console.log( `[world-composer][update#${hermesTraceUpdateCount}] skipped apiSession.ui.onFrame (completed render mode)` );
                } else {
                    try {
                        apiSession.ui.onFrame(
                            openBwComposer.currentFrame,
                            sceneComposer.selectedUnits._dangerousArray
                        );
                    } catch ( e ) {
                        console.warn(
                            `[world-composer] apiSession.ui.onFrame threw: ${e instanceof Error ? e.message : String( e )}`
                        );
                    }
                    if ( traceThisFrame ) console.log( `[world-composer][update#${hermesTraceUpdateCount}] after apiSession.ui.onFrame` );
                }

                try { commandsComposer.onFrame( openBwComposer.currentFrame ); } catch ( e ) { console.warn( "[world-composer][update] commandsComposer.onFrame threw:", e ); }
                if ( traceThisFrame ) console.log( `[world-composer][update#${hermesTraceUpdateCount}] after commandsComposer.onFrame` );

                if ( completedRenderModeFrame ) {
                    if ( traceThisFrame ) console.log( `[world-composer][update#${hermesTraceUpdateCount}] skipped native.hook_onFrame (completed render mode)` );
                } else {
                    try {
                        apiSession.native.hook_onFrame(
                            openBwComposer.currentFrame,
                            commandsComposer.commandsThisFrame
                        );
                    } catch ( e ) {
                        console.warn(
                            `[world-composer] native hook_onFrame threw: ${e instanceof Error ? e.message : String( e )}`
                        );
                    }
                    if ( traceThisFrame ) console.log( `[world-composer][update#${hermesTraceUpdateCount}] after native.hook_onFrame` );
                }

                if ( completedRenderModeFrame ) {
                    if ( traceThisFrame ) console.log( `[world-composer][update#${hermesTraceUpdateCount}] skipped postHud (completed render mode)` );
                } else {
                    try { postHud( openBwComposer.currentFrame, elapsed ); } catch ( e ) { console.warn( "[world-composer][update] postHud threw:", e ); }
                    if ( traceThisFrame ) console.log( `[world-composer][update#${hermesTraceUpdateCount}] after postHud` );
                }
            }

            if ( ( globalThis as Record< string, unknown > ).__hermesCompletedRenderMode ) {
                if ( traceThisFrame ) console.log( `[world-composer][update#${hermesTraceUpdateCount}] skipped native.hook_onTick (completed render mode)` );
            } else {
                try {
                    apiSession.native.hook_onTick(
                        delta,
                        elapsed
                    )
                } catch ( e ) {
                    console.warn(
                        `[world-composer] native hook_onTick threw: ${e instanceof Error ? e.message : String( e )}`
                    );
                }
            }

            if ( traceThisFrame ) {
                console.log(
                    `[world-composer][update#${hermesTraceUpdateCount}] before postProcessing.render`
                );
            }
            try {
                postProcessingComposer.render( delta, elapsed );
            } catch ( e ) {
                console.warn( "[world-composer][update] postProcessing.render threw:", e );
            }
            if ( traceThisFrame ) {
                console.log(
                    `[world-composer][update#${hermesTraceUpdateCount}] after postProcessing.render`
                );
            }

            inputsComposer.reset();
        },

        preRunObject: {
            frame: 0,
            commands: [] as unknown[],
        },
        // the game is run once through openbw at 64x speed for analysis plugins
        preRunFrame() {
            commandsComposer.onFrame( world.openBW.getCurrentReplayFrame() );

            this.preRunObject.frame = openBwComposer.currentFrame;
            this.preRunObject.commands = commandsComposer.commandsThisFrame;

            world.events.emit( "pre-run:frame", this.preRunObject );
        },

        preRunComplete() {
            commandsComposer.reset();
            world.events.emit( "pre-run:complete" );
        },

    };
};
