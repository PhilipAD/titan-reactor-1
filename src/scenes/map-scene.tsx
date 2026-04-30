import loadScm from "@utils/load-scm";
import { log } from "@ipc/log";
import processStore from "@stores/process-store";
import { OpenBW } from "@openbw/openbw";

import { useReplayAndMapStore } from "@stores/replay-and-map-store";
import gameStore from "@stores/game-store";
import { Janitor } from "three-janitor";
import { startOpenBWAndWorld } from "./start-openbw-and-world";
import { settingsStore } from "@stores/settings-store";
import { preloadMapUnitsAndSpriteFiles } from "@utils/preload-map-units-and-sprites";
import {
    PlayerBufferViewIterator,
    PlayerController,
} from "@openbw/structs/player-buffer-view";
import { BasePlayer } from "@core/players";
import { playerColors } from "common/enums";
import { raceToString } from "@utils/string-utils";
import { globalEvents } from "@core/global-events";
import { music } from "@audio/music";
import { ChkDowngrader, CommandsStream } from "process-replay";
import Chk from "bw-chk";
import { cleanMapTitles, createMapImage } from "@utils/chk-utils";
import { pluginsStore } from "@stores/plugins-store";
import { TRScene, TRSceneID } from "./scene";
import { GameScene } from "./game-scene/game-scene";
// import { openFile } from "@ipc/files";

const updateWindowTitle = ( title: string ) => {
    document.title = `Titan Reactor - ${title}`;
};

export class MapScene implements TRScene {
    id: TRSceneID = "@map";
    #fileBuffer: ArrayBuffer;
    constructor(fileBuffer: ArrayBuffer) {
        this.#fileBuffer = fileBuffer;
    }
    async load() {

        console.log( this.#fileBuffer )
        await gameStore().assets?.openCascStorage();
        gameStore().assets?.resetImagesCache();

        processStore().clearCompleted();
        const process = processStore().create( "map", 3 );
        log.debug( "loading chk" );

        const janitor = new Janitor( "MapSceneLoader" );
        const chkBuffer = await loadScm( Buffer.from( this.#fileBuffer ) );

        const chkDowngrader = new ChkDowngrader();
        const dBuffer = chkDowngrader.downgrade( chkBuffer );
        const map = new Chk( dBuffer );

        cleanMapTitles( map );
        updateWindowTitle( map.title );

        // bw-chk's minimap preview generator occasionally runs past a tile buffer
        // (e.g. missing or unusual CASC graphics for a tileset). This preview is
        // decorative — if it fails, keep the map and boot OpenBW anyway so the
        // 3D terrain still renders.
        let mapImage: HTMLCanvasElement | undefined = undefined;
        try {
            mapImage = await createMapImage( map );
        } catch ( err ) {
            console.warn( "[map-scene] createMapImage failed, continuing without minimap:", err );
        }
        useReplayAndMapStore.setState( { map, mapImage } );
        settingsStore().initSessionData( "map" );
        pluginsStore().setSessionPlugins( "replay" );
        globalEvents.emit( "map-ready", { map } );

        janitor.mop( () => useReplayAndMapStore.getState().reset(), "reset replayMapStore" );

        process.increment();

        log.debug( "initializing scene" );

        process.increment();

        if ( settingsStore().data.graphics.preloadMapSprites ) {
            await preloadMapUnitsAndSpriteFiles( gameStore().assets!, map );
        }

        const worldComposer = await startOpenBWAndWorld(
            janitor,
            new CommandsStream(),
            ( openBW: OpenBW ) => {
                openBW.setUnitLimits( 1700 );
                openBW.loadMap( dBuffer );
                openBW.setReplayFrameListener(() => {});
                const disableHermesBridge =
                    new URLSearchParams( globalThis.location?.search ?? "" )
                        .get( "disableHermesBridge" ) === "1";
                if ( disableHermesBridge ) {
                    openBW.setSandboxMode( false );
                    openBW.setPaused( true );
                }

                const mapPlayers: BasePlayer[] = [];
                if ( disableHermesBridge ) {
                    mapPlayers.push( {
                        id: 0,
                        color: playerColors[0]!.hex,
                        name: "Player 0",
                        race: "terran",
                    } );
                    return mapPlayers;
                }

                const p = new PlayerBufferViewIterator( openBW );

                let id = 0;

                for ( const player of p ) {
                    if ( player.controller === PlayerController.Occupied ) {
                        mapPlayers.push( {
                            id: id,
                            color: playerColors[id]!.hex,
                            name: `Player ${id}`,
                            race: raceToString( player.race ),
                        } );

                        id++;
                    }
                }

                return mapPlayers;
            }
        );

        // Music load goes through the CASC HTTP bridge + ResourceIncrementalLoader.
        // In WebGL compat / headless / stripped environments that path can fail
        // ("Array buffer allocation failed") and that must NOT block the map
        // from rendering. A missing soundtrack is much better than no terrain.
        //
        // 2026 optimization: even when it SUCCEEDS, `music.playGame` chunks a
        // large .ogg over HTTP which can take 30+ seconds on the CASC bridge.
        // That blocks the GameScene mount. Fire-and-forget so the scene shows
        // immediately and audio arrives whenever it arrives.
        void (async () => {
            try {
                const waitForGesture = () =>
                    new Promise<void>((res) => {
                        const done = () => {
                            window.removeEventListener("pointerdown", done);
                            window.removeEventListener("keydown", done);
                            res();
                        };
                        window.addEventListener("pointerdown", done, { once: true });
                        window.addEventListener("keydown", done, { once: true });
                    });
                await waitForGesture();
                const stop = await music.playGame();
                janitor.mop( stop );
            } catch ( err ) {
                console.warn( "[map-scene] music.playGame failed, continuing without audio:", err );
            }
        })();
        worldComposer.surfaceComposer.gameSurface.show();
        worldComposer.apiSession.ui.show();
        return {
            component: <GameScene />,
            surface: worldComposer.surfaceComposer.gameSurface.canvas,
            dispose: () => janitor.dispose(),
        }
    }
}