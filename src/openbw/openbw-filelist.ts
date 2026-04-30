
import { log } from "@ipc/log";

import filepaths from "./extra/filepaths";
import { OpenBWWasm } from "common/types";
// A wrapper around file buffers that openbw wasm needs
export default class OpenBWFileList {
    private buffers: Int8Array[] = [];
    private index: Record<string, number> = {};
    unused: number[] = [];
    private _cleared = false;

    normalize( path: string ) {
        return path.toLowerCase().replace( /\//g, "\\" );
    }

    constructor( openBw: OpenBWWasm ) {
        openBw.setupCallbacks( {
            js_fatal_error: ( ptr ) => {
                // Hermes 2026-04 spawn-anything pass: surface the
                // actual C++ error string in the dev console so we
                // can diagnose `state_functions::error()` calls
                // (place_completed_unit failed, attempt to create
                // unit of null type, fixme rescue passive, etc).
                // Without this log the user sees a raw "throw" with
                // an opaque ptr offset, which makes debugging the
                // force-spawn paths nearly impossible.
                const msg = openBw.UTF8ToString( ptr );
                console.error( "[openbw] js_fatal_error:", msg );
                throw new Error( msg );
            },
            js_pre_main_loop: () => {},
            js_post_main_loop: () => {},
            js_file_size: ( index: number ) => {
                return this.buffers[index].byteLength; // get file size: ;
            },
            js_read_data: (
                index: number,
                dst: number,
                offset: number,
                size: number
            ) => {
                // get file buffer
                const data = this.buffers[index];
                for ( let i2 = 0; i2 != size; ++i2 ) {
                    openBw.HEAP8[dst + i2] = data[offset + i2];
                }
            },
            js_load_done: () => {
                this.clear(); // done loading, openbw has its own memory now
                log.debug( "@openbw-filelist: complete" );
                log.debug( `@openbw-filelist: ${this.unused.length} unused assets` );
            },
            js_file_index: ( ptr: number ) => {
                const filepath = openBw.UTF8ToString( ptr );
                if ( filepath === undefined ) {
                    throw new Error( "Filename is undefined" );
                }
                const index = this.index[this.normalize( filepath )];
                this.unused.splice( this.unused.indexOf( index ), 1 );
                return index >= 0 ? index : 9999;
            },
            js_on_replay_frame: () => {
                // log.debug( "frame" );
            }
        } );
    }

    async loadBuffers( readFile: ( filename: string ) => Promise<Buffer | Uint8Array> ) {
        if ( this._cleared ) {
            throw new Error( "File list already cleared" );
        }

        for ( const filepath of filepaths ) {
            const buffer = await readFile( filepath );

            let int8 = Int8Array.from( buffer.subarray( 0, buffer.byteLength / 8 ) );

            this.buffers.push( int8 );
            this.index[this.normalize( filepath )] = this.buffers.length - 1;
            this.unused.push( this.buffers.length - 1 );
        }
    }


    clear() {
        this.buffers = [];
        this._cleared = true;
    }
}
