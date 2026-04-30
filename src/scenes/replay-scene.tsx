import { TRScene, TRSceneID } from "./scene";

import { CommandsStream } from "process-replay";

import Chk from "bw-chk";

import { OpenBW } from "@openbw/openbw";

import { GameTypes, unitTypes } from "common/enums";
import { log } from "@ipc/log";
import { settingsStore } from "@stores/settings-store";
import processStore from "@stores/process-store";
import { startOpenBWAndWorld } from "./start-openbw-and-world";
import { Janitor } from "three-janitor";
import { useReplayAndMapStore } from "@stores/replay-and-map-store";
// import { cleanMapTitles  } from "@utils/chk-utils";
import { preloadMapUnitsAndSpriteFiles } from "@utils/preload-map-units-and-sprites";
import gameStore from "@stores/game-store";
import { globalEvents } from "@core/global-events";
import debounce from "lodash.debounce";
import { music } from "@audio/music";
import { cleanMapTitles, createMapImage } from "@utils/chk-utils";
import { pluginsStore } from "@stores/plugins-store";
import { ValidatedReplay } from "./load-and-validate-replay";
import { GameScene } from "./game-scene/game-scene";
import { getWraithSurface } from "./home/space-scene";
import { MatchDisplay } from "./home/match-display";

export class ReplayScene implements TRScene {
    id: TRSceneID = "@replay";
    hideCursor = true;

    replay: ValidatedReplay;
    
    constructor(replay: ValidatedReplay) {
        this.replay = replay;
    }

    async preload(scene: TRScene | null) {
        if (scene && (scene.id === "@replay" || scene.id === "@map")) {
            // by returning a scene state, we dispose the previous scene before loading another one
            return {
                surface: getWraithSurface().canvas,
                component: <MatchDisplay />,
                key: "preload"
            };
        }
        return null;
    }

    async load() {
        processStore().clearCompleted();

        log.info(`@replay-scene-loader/init: ${this.replay.header.gameName}`);

        await gameStore().assets?.openCascStorage();
        //todo: can we keep images?
        // gameStore().assets?.resetImagesCache();

        const janitor = new Janitor("ReplaySceneLoader");

        document.title = "Titan Reactor";

        const map = new Chk(this.replay.chk as Buffer);

        cleanMapTitles(map);

        const gameTitle = `${map.title} - ${this.replay.header.players
            .map(({ name }) => name)
            .join(", ")}`;

        log.info(`@replay-scene-loader/game: ${gameTitle}`);
        log.info(
            `@replay-scene-loader/game-type: ${GameTypes[this.replay.header.gameType]!}`
        );

        // bw-chk's minimap preview occasionally indexes past a tile buffer for
        // odd CASC graphics; the preview is decorative — skip it on failure
        // so the 3D scene still renders.
        let mapImage: HTMLCanvasElement | undefined = undefined;
        try {
            mapImage = await createMapImage(map);
        } catch (err) {
            console.warn("[replay-scene] createMapImage failed, continuing without minimap:", err);
        }
        useReplayAndMapStore.setState({
            replay: this.replay,
            map,
            mapImage,
        });
        useReplayAndMapStore.setState({ replay: this.replay, map });
        settingsStore().initSessionData("replay");
        pluginsStore().setSessionPlugins("replay");
        globalEvents.emit("replay-ready", { replay: this.replay, map });

        janitor.mop(
            () => useReplayAndMapStore.getState().reset(),
            "reset replay and map store"
        );

        const preloads = new Set<number>();
        if (settingsStore().data.graphics.preloadMapSprites) {

            for (const player of this.replay.header.players) {
                if (player.race === "zerg") {
                    preloads.add( unitTypes.hatchery );
                    preloads.add( unitTypes.drone );
                    preloads.add( unitTypes.overlord );
                    preloads.add( unitTypes.larva );
                    preloads.add( unitTypes.zergEgg );
                } else if (player.race === "terran") {
                    preloads.add( unitTypes.commandCenter );
                    preloads.add( unitTypes.scv );
                } else if (player.race === "protoss") {
                    preloads.add( unitTypes.nexus );
                    preloads.add( unitTypes.probe );
                }
            };

        }

        await preloadMapUnitsAndSpriteFiles(gameStore().assets!, map, [...preloads]);

        const commands = new CommandsStream(
            this.replay.rawCmds as Buffer,
            this.replay.stormPlayerToGamePlayer
        );
        const worldComposer = await startOpenBWAndWorld(
            janitor,
            commands,
            (openBW: OpenBW) => {
                openBW.setUnitLimits(this.replay.limits.units);
                openBW.loadReplay(this.replay.buffer);

                const mapPlayers = this.replay.header.players.map((player) => ({
                    id: player.id,
                    name: player.name,
                    color: player.color,
                    race: player.race,
                }));

                return mapPlayers;
            },
            async (worldComposer) => {
                const openBW = worldComposer.world.openBW;

                // 2026 Hermes embed: there are three ways to handle the end
                // of a replay in the embed, controlled by URL flags:
                //
                //   ?endless=1   — preferred. When we approach the replay's
                //     last frame we flip OpenBW into sandbox mode. In that
                //     mode nextFrame() calls _next_step() at 24fps instead
                //     of advancing through the replay command stream, so the
                //     simulation keeps ticking indefinitely from whatever
                //     world state we're in. No restart, no rewind — truly
                //     one continuous session. Unit AI continues naturally.
                //
                //   ?loop=1      — legacy. Rewinds the replay to frame 0.
                //
                //   (neither)    — default vanilla Titan: fire replay-complete
                //     and fall into the IngameMenuScene.
                const qs = new URLSearchParams(window.location.search);
                const endlessMode = qs.get("endless") === "1" || qs.get("endless") === "true";
                const loopMode = qs.get("loop") === "1" || qs.get("loop") === "true";

                const goEndless = () => {
                    try {
                        openBW.setSandboxMode(true);
                        openBW.setReplayFrameListener(() => {});
                        console.log(
                            "[replay-scene] endless=1 — switched OpenBW to sandbox mode; " +
                                "simulation continues forever at 24fps without replay commands"
                        );
                    } catch (err) {
                        console.warn("[replay-scene] sandbox mode switch failed:", err);
                    }
                };

                const emitComplete = debounce(() => {
                    if (endlessMode) {
                        goEndless();
                        return;
                    }
                    if (loopMode) {
                        try {
                            openBW.setCurrentReplayFrame(0);
                            openBW.setCurrentFrame(0);
                            console.log("[replay-scene] loop=1 — rewound replay to frame 0");
                        } catch (err) {
                            console.warn(
                                "[replay-scene] loop rewind failed; keeping frame listener silent:",
                                err
                            );
                        }
                        return;
                    }
                    openBW.setReplayFrameListener(() => {});
                    console.log("GG WP");
                    globalEvents.emit("replay-complete", this.replay);
                }, 1000);

                openBW.setReplayFrameListener(() => {
                    if (
                        openBW.getCurrentReplayFrame() >
                        this.replay.header.frameCount - 1000
                    ) {
                        emitComplete();
                    }
                });
                
            }
        );

        document.title = `Titan Reactor - ${gameTitle}`;

        // 2026 optimization: don't block the scene mount on the music chunked
        // download (it can take 30s+ over the CASC bridge in compat mode).
        // Additionally wait for the user's first gesture before kicking off
        // playback so Chrome's autoplay policy doesn't silently error.
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
                        // Also resolve immediately if AudioContext is already running
                        // (in case Playwright / Chromium --autoplay-policy=no-user-gesture-required)
                        try {
                            const ctx = (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
                            if (ctx) {
                                // best-effort: check via a throwaway context
                                const probe = new ctx();
                                if (probe.state === "running") {
                                    res();
                                }
                                void probe.close().catch(() => {});
                            }
                        } catch {}
                    });
                await waitForGesture();
                janitor.mop(await music.playGame());
            } catch (err) {
                console.warn("[replay-scene] music.playGame failed, continuing without audio:", err);
            }
        })();
        worldComposer.surfaceComposer.gameSurface.show();
        worldComposer.apiSession.ui.show();

        return  {
            component: <GameScene />,
            surface: worldComposer.surfaceComposer.gameSurface.canvas,
            dispose: () => {
                janitor.dispose()
            }
        }
    }
}
