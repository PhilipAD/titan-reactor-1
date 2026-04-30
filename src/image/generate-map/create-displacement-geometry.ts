import {
    BufferAttribute,
    BufferGeometry,
    PlaneGeometry,
    Vector2,
    Vector3,
} from "three";

export const createDisplacementGeometry = (
    existingGeom: BufferGeometry | null,
    width: number,
    height: number,
    widthSegments: number,
    heightSegments: number,
    canvas: HTMLCanvasElement,
    displacementScale = 2,
    displacementBias = 1
) => {
    const geom =
        existingGeom ?? new PlaneGeometry( width, height, widthSegments, heightSegments );
    const ctx = canvas.getContext( "2d", { willReadFrequently: true } );
    if ( !ctx ) {
        throw new Error( "Could not get context" );
    }

    // 2026 CPU optimization: bulk read the canvas once. Previously this called
    // getImageData(x,y,1,1) four times per vertex, which on software renderers
    // (SwiftShader/llvmpipe) forces a CPU/GPU flush per call and dominated map
    // load time.
    const cw = canvas.width;
    const ch = canvas.height;
    const imgData = ctx.getImageData( 0, 0, cw, ch ).data;

    const pos = geom.getAttribute( "position" ) as BufferAttribute;
    const uvs = geom.getAttribute( "uv" ) as BufferAttribute;
    const nor = geom.getAttribute( "normal" ) as BufferAttribute;
    const p = new Vector3();
    const uv = new Vector2();
    const n = new Vector3();

    for ( let i = 0; i < pos.count; i++ ) {
        p.fromBufferAttribute( pos, i );
        uv.fromBufferAttribute( uvs, i );
        n.fromBufferAttribute( nor, i );

        const displacement = getDisplacement( imgData, cw, ch, uv );

        p.addScaledVector( n, displacement * displacementScale ).addScaledVector(
            n,
            displacementBias
        );
        pos.setXYZ( i, p.x, p.y, p.z );
    }
    pos.needsUpdate = true;
    geom.computeVertexNormals();

    return geom;
};

function getDisplacement(
    imgData: Uint8ClampedArray,
    canvasWidth: number,
    canvasHeight: number,
    uv: Vector2
) {
    const w = canvasWidth - 1;
    const h = canvasHeight - 1;

    const uvW = Math.floor( w * uv.x );
    const uvH = Math.floor( h * ( 1 - uv.y ) );
    const uvWnext = uv.x === 1.0 ? uvW : uvW + 1;
    const uvHnext = uv.y === 0.0 ? uvH : uvH + 1;

    const uvWfract = w * uv.x - uvW;
    const uvHfract = h * ( 1 - uv.y ) - uvH;

    const d0 = imgData[( uvH * canvasWidth + uvW ) * 4] / 255.0;
    const d1 = imgData[( uvH * canvasWidth + uvWnext ) * 4] / 255.0;
    const d01 = d0 + ( d1 - d0 ) * uvWfract;

    const d2 = imgData[( uvHnext * canvasWidth + uvW ) * 4] / 255.0;
    const d3 = imgData[( uvHnext * canvasWidth + uvWnext ) * 4] / 255.0;
    const d23 = d2 + ( d3 - d2 ) * uvWfract;

    const d = d01 + ( d23 - d01 ) * uvHfract;

    return d;
}
