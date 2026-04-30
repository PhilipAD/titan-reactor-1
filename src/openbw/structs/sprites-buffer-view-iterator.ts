import { OpenBW } from "@openbw/openbw";
import { IntrusiveList } from "./intrusive-list";
import { SpritesBufferView } from "./sprites-buffer-view";

export class SpritesBufferViewIterator {
    #openBWRef: WeakRef<OpenBW>;
    #sprites: SpritesBufferView;

    get #openBW() {
        return this.#openBWRef.deref();
    }

    constructor( openBW: OpenBW ) {
        this.#openBWRef = new WeakRef( openBW );
        this.#sprites = new SpritesBufferView( openBW );
    }

    *[Symbol.iterator]() {
        // Hermes 2026-04 spawn-anything pass: see units-buffer-view.ts
        // for why we pass a getter instead of the raw typed-array.
        // Switched to walk() for the same reason -- the legacy iter
        // terminates one node early and silently drops one sprite per
        // tile line (with self-referencing sentinels at pairOffset=0,
        // it's the tail/oldest sprite on each line that gets skipped).
        const _bw = this.#openBW!;
        const spriteList = new IntrusiveList( () => _bw.HEAPU32 );
        const spriteTileLineSize = this.#openBW!.getSpritesOnTileLineSize();
        const spritetileAddr = this.#openBW!.getSpritesOnTileLineAddress();
        for ( let l = 0; l < spriteTileLineSize; l++ ) {
            spriteList.addr = spritetileAddr + ( l << 3 );
            for ( const spriteAddr of spriteList.walk() ) {
                if ( spriteAddr === 0 ) {
                    continue;
                }
                yield this.#sprites.get( spriteAddr );
            }
        }
    }

    getSprite( addr: number ) {
        return this.#sprites.get( addr );
    }
}

export function* deletedSpritesIterator( openBW: OpenBW ) {
    const deletedSpriteCount = openBW._counts( 16 );
    const deletedSpriteAddr = openBW._get_buffer( 4 );

    for ( let i = 0; i < deletedSpriteCount; i++ ) {
        yield openBW.HEAP32[( deletedSpriteAddr >> 2 ) + i];
    }
}
