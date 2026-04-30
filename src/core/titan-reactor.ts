import { Buffer as BufferPolyfill } from "buffer";
globalThis.Buffer = BufferPolyfill;

// 2026 Hermes embed: expose three.js on window so scripts/titan-units-diag.mjs
// can do `instanceof THREE.Scene` checks when walking the scene graph.
import * as THREE from "three";
( globalThis as Record< string, unknown > ).THREE = THREE;

// scm-extractor -> bundled readable-stream uses process.nextTick / process.env.
// Vite doesn't polyfill node `process` by default, so we do it here before any
// module that relies on it (map-scene.tsx -> loadScm -> scm-extractor) loads.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import processPolyfill from "process/browser";
if (typeof (globalThis as { process?: unknown }).process === "undefined") {
    (globalThis as { process?: unknown }).process = processPolyfill;
}

import sceneStore from "../stores/scene-store";
import { logCapabilities } from "@utils/renderer-utils";
import "../scenes/home/home-scene-ui";
import { globalEvents } from "./global-events";
import { ValidatedReplay, loadAndValidateReplay } from "../scenes/load-and-validate-replay";

import { useSettingsStore, useMacroStore} from "@stores/settings-store";
import { log } from "@ipc/log";
import { settingsStore, useGameStore, useReplayAndMapStore } from "../stores";
import gameStore from "@stores/game-store";
import { mixer } from "@audio";
import { usePluginsStore } from "@stores/plugins-store";
import { initCacheDB } from "@image/loader/indexed-db-cache";
import { supabase, SUPABASE_REPLAY_BUCKET } from "common/supabase";
import { metaVerse } from "@stores/metaverse-store";
import { PreProcessFile } from "@ipc/files";
import { HomeScene } from "../scenes/home-scene";
import { LoadingScene } from "../scenes/loading-scene";
import { MapScene } from "../scenes/map-scene";
import { HermesRaceBootScene } from "../scenes/hermes-race-boot-scene";
/**
 * ENTRY POINT FOR TITAN REACTOR
 */

performance.mark("start");

useSettingsStore.subscribe((payload) => {
    mixer.setVolumes(payload.data.audio);
});

metaVerse().events.on("load-replay", async (payload) => {
    console.log("preparing to load replay");
    const fileBuffer = await fetch(SUPABASE_REPLAY_BUCKET + payload.path).then((res) => res.arrayBuffer());
    settingsStore().lset("replayQueue.enabled", false);

    const replay = await loadAndValidateReplay(fileBuffer);

    if (settingsStore().data.replayQueue.alwaysClearReplayQueue) {
        useReplayAndMapStore.getState().clearReplayQueue();
    }

    useReplayAndMapStore.getState().addReplayToQueue(replay);

    if (settingsStore().data.replayQueue.autoplay) {
        useReplayAndMapStore.getState().loadNextReplay();
    }
});



globalEvents.on("queue-files", async ({ files: _files }) => {
    if (_files.length === 0) {
        return;
    }

    const files: PreProcessFile[] = [];

    if (metaVerse().channel && metaVerse().isOwner) {
        if (_files[0].name.endsWith(".scx") || _files[0].name.endsWith(".scm")) {
            console.warn("maps not supported yet");
            return;
        }
        settingsStore().lset("replayQueue.enabled", false);
        const file = _files[0];
        console.log(metaVerse().room + "/" + file.name)
        const { data, error } = await supabase.storage
        .from('replays')
        .upload(metaVerse().room + "/" + file.name, file.buffer, {upsert: true} );

        if (data) {
            files.push(file);
            metaVerse().channel?.send({
                type: "broadcast",
                event: "load-replay",
                payload: {
                    name: file.name,
                    path: data.path,
                },
            })
        } else if (error) {
            console.error(error);
        }
    } else {
        files.push(..._files);
    }

    if (files.length === 0) {
        console.warn("no files to load")
        return;
    };

    // google analytics - send file name only
    gtag("event", "queue-files", { "files" : files.map((f) => f.name).join(",") });
    
    //todo map stuff here
    if (files[0].name.endsWith(".scx") || files[0].name.endsWith(".scm")) {
        useReplayAndMapStore.getState().loadMap(files[0].buffer);
        return;
    }

    const replays: ValidatedReplay[] = [];
    for (const file of files) {
        try {
            replays.push(await loadAndValidateReplay(file.buffer));
        } catch (e) {
            console.error(e);
        }
    }

    if (settingsStore().data.replayQueue.alwaysClearReplayQueue) {
        useReplayAndMapStore.getState().clearReplayQueue();
    }

    useReplayAndMapStore.getState().addReplaysToQueue(replays);

    if (settingsStore().data.replayQueue.autoplay) {
        useReplayAndMapStore.getState().loadNextReplay();
    }
});

// manage total replay watch time
let _startReplayTime: number | null = 0;

globalEvents.on("replay-ready", () => {
    if (_startReplayTime) {
        const duration = performance.now() - _startReplayTime;
        useReplayAndMapStore.getState().addToTotalGameTime(duration);
    }
    _startReplayTime = performance.now();
});

globalEvents.on("replay-complete", async () => {
    const duration = performance.now() - _startReplayTime!;
    useReplayAndMapStore.getState().addToTotalGameTime(duration);
    _startReplayTime = null;

    if (settingsStore().data.replayQueue.goToHomeBetweenReplays) {
        await sceneStore().loadScene(new HomeScene(), {
            ignoreSameScene: true,
        });
    }

    if (
        settingsStore().data.replayQueue.autoplay
    ) {
        useReplayAndMapStore.getState().loadNextReplay();
    }
});

logCapabilities();

(async function bootup() {
    // supabase.auth.startAutoRefresh();

    // const {
    //     data: { session },
    //     error: sessionError,
    // } = await supabase.auth.getSession();

    // if (sessionError) {
    //     log.error(sessionError);
    // }

    // if (!session) {
    //     console.log("no session");
    //     const email = prompt("Enter your blacksheepwall.tv username")!;

    //     if (email) {
    //         const res = await supabase.auth.signInWithOtp({
    //             email,
    //             options: {
    //                 emailRedirectTo: import.meta.env.BASE_URL
    //             }
    //         });

    //         if (res.error) {
    //             alert(res.error.message);
    //             return;
    //         }

    //         if (res.data.session) {
    //             alert("Check your email for a login link");
    //         }
    //     }
    // } else {
    //     console.log("session found");
    // }
    // metaVerse().setSession(session);

    try {
        await initCacheDB();
    } catch (e) {}

    const urlParams = new URLSearchParams(window.location.search);
    // 2026 Hermes embed: hide the OS cursor everywhere inside the iframe so
    // only the in-game StarCraft cursor sprite is visible. Without this the
    // user sees both the SC yellow-hoop cursor (drawn to the canvas) AND the
    // native Chrome arrow cursor. Honoured via CSS rule in styles.css.
    if (urlParams.get("hideOsCursor") === "1" || urlParams.get("hideOsCursor") === "true") {
        try { document.documentElement.setAttribute("data-hide-os-cursor", "1"); } catch {}
    }

    const hermesEmbed = (
        urlParams.get("hideWelcome") === "1" ||
        urlParams.get("hidewelcome") === "1" ||
        urlParams.has("hermesRace") ||
        urlParams.get("hermesBoot") === "1"
    );

    if (urlParams.get("map")) {
        const mapUrl = urlParams.get("map")!;
        if (urlParams.get("hermesBoot") === "1" && !urlParams.has("hermesRace")) {
            await sceneStore().loadScene(new HermesRaceBootScene(mapUrl));
            log.debug(`startup in ${performance.measure("start").duration}ms`);
            return;
        }

        await sceneStore().loadScene(new LoadingScene());

        try {
            const buffer = await fetch(mapUrl).then((res) => res.arrayBuffer());
            await sceneStore().loadScene(new MapScene(buffer));
            log.debug(`startup in ${performance.measure("start").duration}ms`);
            return;
        } catch (err) {
            console.error("[titan] ?map= failed:", err);
            if (hermesEmbed) {
                return;
            }
        }
    }

    await sceneStore().loadScene(new LoadingScene());

    await sceneStore().loadScene(new HomeScene());

    log.debug(`startup in ${performance.measure("start").duration}ms`);

    // 2026 Hermes embed: Chrome autoplay policy suspends any AudioContext
    // created before the first user gesture. Music/SFX then fail with
    // "AudioContext was not allowed to start". We install a one-shot listener
    // for pointerdown/keydown that resumes Titan's shared AudioContext.
    try {
        const unlockAudio = () => {
            try {
                const ctx = mixer.context as unknown as { state: string; resume: () => Promise<void> };
                if (ctx && ctx.state !== "running" && typeof ctx.resume === "function") {
                    void ctx.resume().catch(() => {});
                }
            } catch {}
            window.removeEventListener("pointerdown", unlockAudio);
            window.removeEventListener("keydown", unlockAudio);
            window.removeEventListener("touchstart", unlockAudio);
        };
        window.addEventListener("pointerdown", unlockAudio, { once: false });
        window.addEventListener("keydown", unlockAudio, { once: false });
        window.addEventListener("touchstart", unlockAudio, { once: false });
    } catch (err) {
        console.warn("[titan] failed to install audio-unlock listener:", err);
    }
    if (urlParams.get("replays")) {
        const replays = urlParams.get("replays")!.split(",");

        const files = [];
        for ( const file of replays ) {
            files.push({
                name: file,
                buffer: await fetch(file).then((res) => res.arrayBuffer()),
            })
        }
        globalEvents.emit( "queue-files", {
            files,
        } );
        // 2026 Hermes embed: also auto-start playing the first queued replay
        // unless the user explicitly opts out. The home scene's MatchDisplay
        // requires a manual "Play" click which is annoying for embedders that
        // just want the base to start animating.
        if (urlParams.get("autoplay") !== "0") {
            try {
                const { useReplayAndMapStore } = await import("@stores/replay-and-map-store");
                // Wait a beat for the queue-files event to drain into the store.
                setTimeout(() => {
                    useReplayAndMapStore.getState().loadNextReplay();
                }, 250);
            } catch (err) {
                console.warn("[titan] autoplay failed:", err);
            }
        }
    }


})();

window.addEventListener("wheel", (evt) => evt.preventDefault(), { passive: false });

window.addEventListener("message", (event) => {
    if (event.data.type === "control-panel:connect") {
        useGameStore.setState({ configurationWindow: event.source as Window });
        gameStore().configurationWindow!.deps = { useSettingsStore, usePluginsStore, useMacroStore };
        event.source!.postMessage(
            { type: "control-panel:connected" },
            { targetOrigin: event.origin }
        );
    }
});

window.document.title = "Titan Reactor";

window.addEventListener("beforeunload", () => {
    if (gameStore().configurationWindow) {
        gameStore().configurationWindow!.close();
    }
});

window.addEventListener("contextmenu", (evt) => {
    evt.preventDefault();
});
