import { EmscriptenPreamble } from "./emscripten";

type Callbacks = {
    js_fatal_error?: ( ptr: number ) => string;
    js_pre_main_loop?: () => void;
    js_post_main_loop?: () => void;
    js_file_size?: ( index: number ) => number;
    js_read_data?: ( index: number, dst: number, offset: number, size: number ) => void;
    js_load_done?: () => void;
    js_file_index?: ( ptr: number ) => number;
    js_on_replay_frame?: () => void;
};

/**
 * The shape of the WASM module exported by the imbateam-gg/openbw build that
 * Hermes ships in `bundled/titan.wasm`.
 *
 * The base 15 EMSCRIPTEN_KEEPALIVE exports come from
 * `imbateam-openbw/js_build.bat:23`. The Hermes 2026-04 deeper rebuild
 * adds an optional second bank of exports declared at the bottom; see
 * `tools/build-wasm.sh` for the rebuild recipe. All optional exports are
 * marked `?` so the code keeps compiling even when the legacy wasm is
 * loaded (we degrade gracefully via `__hermesAPI.feature` checks).
 */
export interface OpenBWWasm extends EmscriptenPreamble {
    _reset: () => void;
    _load_replay: ( buffer: number, length: number ) => void;
    _load_map: ( buffer: number, length: number ) => void;
    _upload_height_map: (
        buffer: number,
        length: number,
        width: number,
        height: number
    ) => void;
    _load_replay_with_height_map: (
        replayBuffer: number,
        replayLength: number,
        buffer: number,
        length: number,
        width: number,
        height: number
    ) => void;

    _next_frame: () => number;
    _next_step: () => number;
    _next_replay_step: () => number;
    _create_unit: ( unitId: number, playerId: number, x: number, y: number ) => number;

    _counts: ( index: number ) => number;
    _get_buffer: ( index: number ) => number;

    _replay_get_value: ( index: number ) => number;
    _replay_set_value: ( index: number, value: number ) => void;

    _set_player_visibility: ( playerId: number ) => void;

    _generate_frame: () => void;

    /**
     * Hermes 2026-04 deeper rebuild — optional new exports. Each is `?`
     * because the legacy `bundled/titan.wasm` doesn't have them. Always
     * feature-detect via `typeof openBW._can_place_building_at === "function"`
     * before calling.
     */
    _can_place_building_at?: (
        typeId: number,
        owner: number,
        x: number,
        y: number
    ) => number;
    _is_reachable?: ( unitId: number, x: number, y: number ) => number;
    _set_player_resources?: (
        playerId: number,
        minerals: number,
        gas: number
    ) => void;
    _set_player_controller?: ( playerId: number, controller: number ) => void;
    _image_run_anim?: ( imageAddr: number, animId: number ) => void;
    _play_sound?: (
        soundId: number,
        x: number,
        y: number,
        unitTypeId: number
    ) => void;
    _set_volume?: ( percent: number ) => void;

    /**
     * The Embind-wrapped `util_functions` class. Method set differs slightly
     * between builds:
     *   - all builds:    dump_unit, kill_unit, remove_unit, issue_command
     *   - newer builds:  get_sounds (used to be advertised in this typing
     *                    but the imbateam build does NOT bind it; calling
     *                    throws). Marked optional + nullable to make the
     *                    misuse explicit.
     */
    get_util_funcs: () => {
        dump_unit: ( unitAddr: number ) => {
            id: number;
            resourceAmount?: number;
            remainingTrainTime?: number;
            upgrade?: {
                id: number;
                level: number;
                time: number;
            };
            research?: {
                id: number;
                time: number;
            };
            loaded?: number[];
            buildQueue?: number[];
        };
        kill_unit: ( unitId: number ) => number;
        remove_unit: ( unitId: number ) => number;
        issue_command: (
            unitId: number,
            command: number,
            targetId: number,
            x: number,
            y: number,
            extra: number
        ) => boolean;
    };
    callMain: () => void;
    getExceptionMessage: ( e: unknown ) => string;

    setupCallbacks: ( callbacks: Callbacks ) => void;
    setupCallback: (key: keyof Callbacks, callback: Callbacks[keyof Callbacks]) => void;
}
