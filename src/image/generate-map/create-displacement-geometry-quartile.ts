import { BufferAttribute, InterleavedBufferAttribute, PlaneGeometry, Vector2, Vector3 } from "three";
import simplifyGeometry from "./simplify-geometry";

export const createDisplacementGeometryQuartile = (
    width: number,
    height: number,
    widthSegments: number,
    heightSegments: number,
    canvas: HTMLCanvasElement,
    displacementScale = 2,
    displacementBias = 1,
    scaleWidth = 1,
    scaleHeight = 1,
    offX = 0,
    offY = 0
) => {
    const geom = new PlaneGeometry( width, height, widthSegments, heightSegments );

    const ctx = canvas.getContext( "2d", { willReadFrequently: true } );

    if ( !ctx ) {
        throw new Error( "Could not get canvas context" );
    }

    // 2026 CPU optimization: read the whole canvas ONCE into a typed array and
    // index directly, instead of calling getImageData(x,y,1,1) per vertex. On
    // software renderers each tiny getImageData forces a CPU flush; this cuts
    // tens of thousands of per-pixel reads down to one bulk copy.
    const cw = canvas.width;
    const ch = canvas.height;
    const imgData = ctx.getImageData( 0, 0, cw, ch ).data;

    const pos = geom.getAttribute( "position" );
    const uvs = geom.getAttribute( "uv" ) as BufferAttribute;
    const nor = geom.getAttribute( "normal" );
    const p = new Vector3();
    const uv = new Vector2();
    const n = new Vector3();

    for ( let i = 0; i < pos.count; i++ ) {
        p.fromBufferAttribute( pos as BufferAttribute | InterleavedBufferAttribute, i );
        uv.fromBufferAttribute( uvs, i );
        n.fromBufferAttribute( nor as BufferAttribute | InterleavedBufferAttribute, i );

        const displacement = getDisplacement(
            imgData,
            cw,
            ch,
            uv,
            scaleWidth,
            scaleHeight,
            offX,
            offY
        );

        p.addScaledVector( n, displacement * displacementScale ).addScaledVector(
            n,
            displacementBias
        );
        (pos as BufferAttribute | InterleavedBufferAttribute).setXYZ( i, p.x, p.y, p.z );
    }

    pos.needsUpdate = true;

    const simplifiedGeom = simplifyGeometry( geom, widthSegments, heightSegments );

    return simplifiedGeom;
};

function getDisplacement(
    imgData: Uint8ClampedArray,
    canvasWidth: number,
    canvasHeight: number,
    uv: Vector2,
    scaleWidth: number,
    scaleHeight: number,
    offX: number,
    offY: number
) {
    const w = canvasWidth - 1;
    const h = canvasHeight - 1;

    const uvW = Math.floor( w * scaleWidth * uv.x ) + offX;
    const uvH = Math.floor( h * scaleHeight * ( 1 - uv.y ) ) + offY;
    let uvWnext = uvW;
    let uvHnext = uvH;

    if ( uv.x === 1.0 ) {
        uvWnext = Math.min( w, uvW + 1 );
    } else if ( uv.x === 0.0 ) {
        uvWnext = Math.max( 0, uvW - 1 );
    }

    if ( uv.y === 0.0 ) {
        uvHnext = Math.min( h, uvH + 1 );
    } else if ( uv.y === 1.0 ) {
        uvHnext = Math.max( 0, uvH - 1 );
    }

    const directIdx = ( uvH * canvasWidth + uvW ) * 4;
    const nextIdx = ( uvHnext * canvasWidth + uvWnext ) * 4;
    const direct = imgData[directIdx] / 255.0;
    const next = imgData[nextIdx] / 255.0;

    return ( direct + next ) / 2;
}
