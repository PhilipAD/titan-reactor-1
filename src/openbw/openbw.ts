import initializeWASM from "./titan.wasm.js";
import OpenBWFileList from "./openbw-filelist";
import { Timer } from "@utils/timer";
// import { readFileSync } from "fs";
import { OpenBWWasm, ReadFile } from "common/types";
import { mix } from "@utils/object-utils.js";
import { UnitsBufferViewIterator, destroyedUnitsIterator, killedUnitIterator } from "@openbw/structs/units-buffer-view.js";
import { SpritesBufferViewIterator, deletedSpritesIterator } from "@openbw/structs/sprites-buffer-view-iterator.js";
import { ImageBufferView, deletedImageIterator } from "@openbw/structs/images-buffer-view.js";

/**
 * @public
 */
class OpenBWIterators {
    destroyedUnitsThisFrame: () => ReturnType<typeof destroyedUnitsIterator>;
    killedUnitsThisFrame: () =>   ReturnType<typeof killedUnitIterator>;
    units: UnitsBufferViewIterator;
    deletedSpritesThisFrame:() =>  ReturnType<typeof deletedSpritesIterator>;
    deletedImagesThisFrame:() =>   ReturnType<typeof deletedImageIterator>;
    sprites: SpritesBufferViewIterator;

    constructor( openbw: OpenBW ) {
        this.destroyedUnitsThisFrame = destroyedUnitsIterator.bind( null, openbw );
        this.killedUnitsThisFrame = killedUnitIterator.bind( null, openbw );
        this.units = new UnitsBufferViewIterator( openbw );
        this.deletedSpritesThisFrame = deletedSpritesIterator.bind( null, openbw );
        this.deletedImagesThisFrame = deletedImageIterator.bind( null, openbw );
        this.sprites = new SpritesBufferViewIterator( openbw );
    }
}

class OpenBWStructViews {
    image: ImageBufferView;
    
    constructor( openbw: OpenBW ) {
        this.image = new ImageBufferView( openbw );
    }
}

/**
 * @public
 */
export interface OpenBW extends OpenBWWasm {
}

/**
 * @public
 * An interface layer between the OpenBW WASM module and the rest of the application.
 */
export class OpenBW implements OpenBW {
    #wasm!: OpenBWWasm;
    running = false;
    files?: OpenBWFileList;

    #isReplay = false;
    #isSandbox = false;
    #sandboxFrame = 0;
    #sandboxPaused = false;
    #timer = new Timer();

    unitGenerationSize = 3;

    iterators!: OpenBWIterators;
    structs!: OpenBWStructViews;

    /**
     * Load the WASM module and initialize the OpenBW instance.
     */
    async init() {

        this.#wasm = ( await initializeWASM( {
            locateFile: ( path: string ) => path.endsWith( ".wasm" ) ? `/${path}` : path,
        } ) ) as OpenBWWasm;

        mix( this, this.#wasm );

        // Hermes 2026-04 spawn-anything pass: with Emscripten 5.x the
        // wasm memory grows whenever we _create_completed_unit_at /
        // _create_unit a lot of new units in a single bridge batch.
        // When that happens, `wasmMemory.buffer` is detached and a NEW
        // ArrayBuffer is allocated, so the OLD HEAP{8,16,32,U8,U16,U32,
        // F32,F64} typed-array views become stale (any read returns 0,
        // any write throws "Invalid array length" because the detached
        // buffer has length 0).
        //
        // The rebuilt titan.wasm.js's `updateMemoryViews()` re-assigns
        // the local HEAP* + Module["HEAP*"] on every grow (see our
        // patch in src/openbw/titan.wasm.js). But `mix(this, this.#wasm)`
        // above takes a SNAPSHOT of the descriptor — so `this.HEAPU32`
        // is frozen to whichever Uint32Array existed at init time.
        //
        // Fix: redefine each HEAP property on `this` as a live getter
        // that always reads from the underlying `this.#wasm` (which
        // points at the live, post-grow Module). Now every consumer
        // (IntrusiveList, UnitsBufferView, scene-composer) gets the
        // current heap view automatically.
        const heapKeys: ( keyof OpenBWWasm )[] = [
            "HEAP8" as keyof OpenBWWasm,
            "HEAP16" as keyof OpenBWWasm,
            "HEAP32" as keyof OpenBWWasm,
            "HEAPU8" as keyof OpenBWWasm,
            "HEAPU16" as keyof OpenBWWasm,
            "HEAPU32" as keyof OpenBWWasm,
            "HEAPF32" as keyof OpenBWWasm,
            "HEAPF64" as keyof OpenBWWasm,
        ];
        for ( const k of heapKeys ) {
            const wasm = this.#wasm as unknown as Record< string, unknown >;
            Object.defineProperty( this, k, {
                configurable: true,
                enumerable: true,
                get: () => wasm[k as string],
            } );
        }
    }

    #withOpenBWError( e: unknown ) {
        if ( typeof e === "number" ) {
            throw new Error( this.#wasm.getExceptionMessage( e ) );
        } else if (
            // Hermes 2026-04 spawn-anything pass: Emscripten 5.x's
            // C++ exception machinery throws an opaque object
            // `{ name: "CppException", ptr: <heap_addr> }` instead of
            // an integer like Emscripten 1.x did. Translate it into
            // a real Error with the C++ what() string so the dev
            // console shows "place_completed_unit failed" instead of
            // an opaque "Uncaught CppException(esoPtr: 24495288)".
            e &&
            typeof e === "object" &&
            "ptr" in ( e as Record< string, unknown > ) &&
            typeof ( e as { ptr: unknown } ).ptr === "number"
        ) {
            const ptr = ( e as { ptr: number } ).ptr;
            const msg = this.#wasm.getExceptionMessage( ptr );
            throw new Error( `OpenBW C++ exception: ${msg}` );
        } else {
            throw e;
        }
    }

    isReplay() {
        return this.#isReplay;
    }

    isSandboxMode() {
        return this.#isSandbox;
    }

    setSandboxMode = ( sandbox: boolean ) => {
        // Hermes 2026-04 base-layout fix: previously gated to replays
        // only, so on a melee-map run (the Hermes embed default) sandbox
        // mode could never be enabled, which caused the unit-behavior
        // loop's gather/patrol orders + sandboxApi.createUnit to all
        // silently no-op. Now we honor the request unconditionally so
        // the Hermes bridge can spawn / order units on map runs.
        return ( this.#isSandbox = sandbox );
    };

    /**
     * @param buffer the replay file buffer
     */
    loadReplay( buffer: Buffer ) {
        this.#isReplay = true;
        this.#isSandbox = false;

        try {
            const buf = this.#wasm.allocate( buffer, this.#wasm.ALLOC_NORMAL );
            this.#wasm._load_replay( buf, buffer.length );
            this.#wasm._free( buf );
        } catch ( e ) {
            this.#withOpenBWError( e );
        }
    }

    /**
     * OpenBW uses the height map to determine Y coordinates for units so that we don't have to.
     *
     * @param data the greyscale height map data
     * @param width width in px
     * @param height height inpx
     */
    uploadHeightMap = ( data: Uint8ClampedArray, width: number, height: number ) => {
        try {
            const heightMapBuf = this.#wasm.allocate( data, this.#wasm.ALLOC_NORMAL );
            this.#wasm._upload_height_map( heightMapBuf, data.length, width, height );
            this.#wasm._free( heightMapBuf );
        } catch ( e ) {
            this.#withOpenBWError( e );
        }
    };

    /**
     * @param buffer the map file buffer
     */
    loadMap( buffer: Buffer ) {
        this.#isReplay = false;
        this.#isSandbox = true;
        this.#sandboxFrame = 0;
        this.#sandboxPaused = false;

        try {
            const buf = this.#wasm.allocate( buffer, this.#wasm.ALLOC_NORMAL );
            this.#wasm._load_map( buf, buffer.length );
            this.#wasm._free( buf );
        } catch ( e ) {
            this.#withOpenBWError( e );
        }
    }

    /**
     * Called after init() to call main() and provide data files.
     */
    async start( readFile: ReadFile ) {
        if ( this.running ) return;

        this.files = new OpenBWFileList( this.#wasm );
        await this.files.loadBuffers( readFile );
        try {
            this.#wasm.callMain();
            this.iterators = new OpenBWIterators( this );
            this.structs = new OpenBWStructViews( this );

            this.running = true;
        } catch ( e ) {
            this.#withOpenBWError( e );
        }
    }

    setReplayFrameListener = (fn: () => void) => {
        this.setupCallback("js_on_replay_frame", fn);
    }

    /**
     * Increments the game frame where openbw will run until the next frame.
     * If the game is in sandbox mode, the game will run at 24 fps.
     * @returns the game frame number
     */
    /**
     * Hermes 2026-04 spawn-anything pass: tally of fatal C++ errors
     * surfaced from the engine. Used by the next-frame wrapper to
     * stop spamming the console once we've reported the same error
     * many times in a row (the world loop calls `_next_frame` 60+
     * times per second so an unguarded throw was filling the log).
     */
    #nextFrameErrorCount = 0;

    nextFrame = () => {
        // Hermes 2026-04 deeper RE: ALL paths here are now in a try/catch
        // — sandbox-mode nextStep()/getCurrentFrame() and non-sandbox
        // _next_frame() — so the world's render loop never gets an
        // uncaught wasm OOB pageerror that kills the iframe.
        try {
            if ( !this.#isReplay && this.#sandboxPaused ) {
                return this.#sandboxFrame;
            }
            if ( this.#isSandbox ) {
                if ( this.isPaused() ) {
                    return this.#sandboxFrame;
                }
                this.#timer.update();
                if ( this.#timer.getElapsed() > 42 ) {
                    this.#timer.resetElapsed();
                    this.#sandboxFrame = this.nextStep();
                    return this.#sandboxFrame;
                }
                return this.#sandboxFrame;
            }
            return this.#wasm._next_frame();
        } catch ( e ) {
            this.#nextFrameErrorCount++;
            if ( this.#nextFrameErrorCount <= 5 ) {
                let msg = String( e );
                try {
                    if ( typeof e === "number" ) {
                        msg = this.#wasm.getExceptionMessage( e );
                    } else if ( e && typeof e === "object" ) {
                        const maybePtr =
                            "ptr" in ( e as Record< string, unknown > ) &&
                            typeof ( e as { ptr: unknown } ).ptr === "number"
                                ? ( e as { ptr: number } ).ptr
                                : "excPtr" in ( e as Record< string, unknown > ) &&
                                  typeof ( e as { excPtr: unknown } ).excPtr === "number"
                                ? ( e as { excPtr: number } ).excPtr
                                : undefined;
                        if ( maybePtr !== undefined ) {
                            msg = this.#wasm.getExceptionMessage( maybePtr );
                        }
                    }
                } catch {
                    /* swallow getExceptionMessage failures */
                }
                console.warn(
                    `[openbw] _next_frame threw (${this.#nextFrameErrorCount}/5): ${msg}`
                );
            }
            // CRITICAL: getCurrentFrame can ALSO OOB right after a
            // failed _next_frame (heap may be corrupt). If we don't
            // catch it here too the exception escapes as an uncaught
            // pageerror that kills the iframe's render loop forever.
            try {
                return this.getCurrentFrame();
            } catch {
                return 0;
            }
        }
    };

    nextFrameSafe = () => {
        try {
            return this.nextFrame();
        } catch ( e ) {
            this.#withOpenBWError( e );
            return 0;
        }
    };

    nextStep() {
        return this.#wasm._next_step();
    }

    nextReplayStep() {
        try {
            return this.#wasm._next_replay_step();
        } catch ( e ) {
            this.#withOpenBWError( e );
            return 0;
        }
    }

    setGameSpeed( speed: number ) {
        return this.#wasm._replay_set_value( 0, speed );
    }
    getGameSpeed() {
        return this.#wasm._replay_get_value( 0 );
    }

    setCurrentFrame( frame: number ) {
        return this.#wasm._replay_set_value( 2, frame );
    }
    getCurrentFrame() {
        return this.#wasm._replay_get_value( 2 );
    }

    setCurrentReplayFrame( frame: number ) {
        return this.#wasm._replay_set_value( 3, frame );
    }
    getCurrentReplayFrame() {
        return this.#wasm._replay_get_value( 3 );
    }

    isPaused() {
        if ( !this.#isReplay ) {
            return this.#sandboxPaused;
        }
        try {
            return this.#wasm._replay_get_value( 1 ) === 1;
        } catch {
            return false;
        }
    }
    setPaused( paused: boolean ) {
        if ( !this.#isReplay ) {
            this.#sandboxPaused = paused;
            return paused ? 1 : 0;
        }
        try {
            return this.#wasm._replay_set_value( 1, paused ? 1 : 0 );
        } catch {
            return 0;
        }
    }

    getPlayersAddress() {
        return this.#wasm._get_buffer( 10 );
    }

    setUnitLimits( unitLimits: number ) {
        this.unitGenerationSize = unitLimits === 1700 ? 5 : 3;
    }

    /**
     * Updates fog of war and creep data.
     *
     * Hermes 2026-04 deeper RE: `_generate_frame` is the engine's
     * sprite/fow/creep renderer — it iterates EVERY active unit and
     * builds the per-frame sprite list. If any unit has half-init or
     * out-of-bounds state (commonly because a Hermes-spawned unit
     * landed on unbuildable terrain or got destroyed mid-iteration),
     * the iteration walks past the unit_finder vector boundary and
     * the engine throws "memory access out of bounds".
     *
     * Without this catch the throw escapes as an uncaught pageerror
     * (it's called from openbw-composer's update loop, which has no
     * guard) and kills the iframe's render loop.
     */
    #generateFrameErrorCount = 0;
    #bufferReadErrorCount = 0;

    #safeCount( idx: number, label: string ) {
        try {
            return this.#wasm._counts( idx );
        } catch ( e ) {
            this.#bufferReadErrorCount++;
            if ( this.#bufferReadErrorCount <= 10 ) {
                console.warn(
                    `[openbw] ${label} count read threw (${this.#bufferReadErrorCount}/10): ${e instanceof Error ? e.message : String( e )}`
                );
            }
            return 0;
        }
    }

    #safeBuffer( idx: number, label: string ) {
        try {
            return this.#wasm._get_buffer( idx );
        } catch ( e ) {
            this.#bufferReadErrorCount++;
            if ( this.#bufferReadErrorCount <= 10 ) {
                console.warn(
                    `[openbw] ${label} buffer read threw (${this.#bufferReadErrorCount}/10): ${e instanceof Error ? e.message : String( e )}`
                );
            }
            return 0;
        }
    }

    generateFrame() {
        try {
            this.#wasm._generate_frame();
        } catch ( e ) {
            this.#generateFrameErrorCount++;
            if ( this.#generateFrameErrorCount <= 5 ) {
                console.warn(
                    `[openbw] generate_frame threw (${this.#generateFrameErrorCount}/5): ${e instanceof Error ? e.message : String( e )}`
                );
            }
        }
    }

    getFowSize() {
        return this.#safeCount( 10, "fow" );
    }
    getFowPtr() {
        return this.#safeBuffer( 16, "fow" );
    }

    setPlayerVisibility( visibility: number ) {
        try {
            this.#wasm._set_player_visibility( visibility );
        } catch {
            /* visibility is best-effort */
        }
    }

    getCreepSize() {
        return this.#safeCount( 2, "creep" );
    }

    getCreepPtr() {
        return this.#safeBuffer( 14, "creep" );
    }

    getCreepEdgesSize() {
        return this.#safeCount( 3, "creepEdges" );
    }
    getCreepEdgesPtr() {
        return this.#safeBuffer( 15, "creepEdges" );
    }

    getTilesPtr() {
        return this.#safeBuffer( 0, "tiles" );
    }

    getTilesSize() {
        return this.#safeCount( 0, "tiles" );
    }

    /**
     * @deprecated Hermes 2026-04 deeper RE: the imbateam-gg/openbw build
     * does NOT bind `get_sounds()` in its EMSCRIPTEN_BINDINGS block, so
     * calling this throws "BindingError: get_sounds is not a function".
     * Read sounds via `_get_buffer(11)` + `_counts(13)` + `SoundStruct`
     * mapping instead. Left as a no-op so legacy callers don't crash.
     */
    getSoundObjects() {
        try {
            const utils = this.#wasm.get_util_funcs() as unknown as {
                get_sounds?: () => unknown[];
            };
            return typeof utils.get_sounds === "function" ? utils.get_sounds() : [];
        } catch {
            return [];
        }
    }

    /**
     * Returns the last error code from a failed _create_unit call.
     *
     * NOTE (2026-04 Hermes deeper RE): _counts(0) is the static tile count
     * (mapW*mapH = 4096 for 64x64 maps). The actual last_error slot is
     * _counts(1). The previous index was a copy-paste bug that meant every
     * failed _create_unit was silently swallowed by getLastErrorMessage().
     */
    getLastError() {
        return this.#wasm._counts( 1 );
    }

    getLastErrorMessage() {
        switch ( this.getLastError() ) {
            case 60:
                return "Terrain displaces unit";
            case 61:
                return "Cannot create more units";
            case 62:
                return "Unable to create unit";
        }
        return null;
    }

    getSpritesOnTileLineSize() {
        return this.#safeCount( 14, "spritesOnTileLine" );
    }
    getSpritesOnTileLineAddress() {
        return this.#safeBuffer( 1, "spritesOnTileLine" );
    }

    getUnitsAddr() {
        return this.#safeBuffer( 2, "units" );
    }

    getBulletsAddress() {
        return this.#safeBuffer( 6, "bullets" );
    }
    getBulletsDeletedCount() {
        return this.#safeCount( 18, "bulletsDeleted" );
    }
    getBulletsDeletedAddress() {
        return this.#safeBuffer( 7, "bulletsDeleted" );
    }

    getSoundsAddress() {
        return this.#safeBuffer( 11, "sounds" );
    }
    getSoundsCount() {
        return this.#safeCount( 6, "sounds" );
    }

    getIScriptProgramDataSize() {
        return this.#safeCount( 12, "iscriptProgramData" );
    }

    getIScriptProgramDataAddress() {
        return this.#safeBuffer( 12, "iscriptProgramData" );
    }

    
}
