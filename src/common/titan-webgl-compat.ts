/**
 * Runtime WebGL "compat" mode for Titan: software renderers (llvmpipe, SwiftShader,
 * lavapipe, etc.) and optional VITE_TITAN_WEBGL_COMPAT=1 build override.
 *
 * Compat reduces shadows, post-processing passes, terrain resolution, and uses
 * powerPreference "default" so normal Chrome works on VMs / RDP without flags.
 */

import { rendererStringLooksSoftware } from "./titan-webgl-renderer-label";

let resolvedCompat: boolean | null = null;

const DEBUG_INFO = "WEBGL_debug_renderer_info";

function readUnmaskedRenderer( gl: WebGLRenderingContext ): string | null {
    try {
        const ext = gl.getExtension( DEBUG_INFO );
        if ( !ext ) {
            return null;
        }
        const vendor = gl.getParameter( ext.UNMASKED_VENDOR_WEBGL ) as string | null;
        const renderer = gl.getParameter( ext.UNMASKED_RENDERER_WEBGL ) as string | null;
        if ( typeof vendor === "string" && typeof renderer === "string" ) {
            return `${vendor} ${renderer}`;
        }
        if ( typeof renderer === "string" ) {
            return renderer;
        }
    } catch {
        return null;
    }
    return null;
}

/**
 * Match Three.js WebGLRenderer context attributes as closely as possible
 * (see node_modules/three/src/renderers/WebGLRenderer.js).
 */
function releaseProbeContext( gl: WebGL2RenderingContext ) {
    try {
        gl.getExtension( "WEBGL_lose_context" )?.loseContext();
    } catch {
        /* ignore */
    }
}

function probeWebGL2( powerPreference: WebGLPowerPreference ): WebGL2RenderingContext | null {
    if ( typeof document === "undefined" ) {
        return null;
    }
    const canvas = document.createElement( "canvas" );
    const attrs: WebGLContextAttributes = {
        alpha: true,
        depth: false,
        stencil: false,
        antialias: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        powerPreference,
        failIfMajorPerformanceCaveat: false,
    };
    return canvas.getContext( "webgl2", attrs );
}

function probePreferCompatFromGpu(): boolean {
    const prefs: WebGLPowerPreference[] = [ "high-performance", "default", "low-power" ];
    for ( const pref of prefs ) {
        const gl = probeWebGL2( pref );
        if ( !gl ) {
            continue;
        }
        const label = readUnmaskedRenderer( gl );
        releaseProbeContext( gl );
        if ( label && rendererStringLooksSoftware( label ) ) {
            return true;
        }
        if ( label && !rendererStringLooksSoftware( label ) ) {
            return false;
        }
    }
    return true;
}

function urlForcesCompat(): boolean {
    if ( typeof window === "undefined" ) {
        return false;
    }
    const params = new URLSearchParams( window.location.search );
    const value = params.get( "webglCompat" ) ?? params.get( "titanWebglCompat" );
    return value === "1" || value === "true";
}

function computeResolvedCompat(): boolean {
    if ( import.meta.env.VITE_TITAN_WEBGL_COMPAT === "1" || urlForcesCompat() ) {
        return true;
    }
    return probePreferCompatFromGpu();
}

/**
 * True when Titan should use the reduced-cost rendering path (VMs, software GL,
 * or VITE_TITAN_WEBGL_COMPAT=1).
 */
export function getTitanWebGLCompatMode(): boolean {
    if ( resolvedCompat === null ) {
        resolvedCompat = computeResolvedCompat();
    }
    return resolvedCompat;
}

/**
 * If the first WebGLRenderer construction fails (e.g. ANGLE BindToCurrentSequence
 * on llvmpipe with high-performance), force compat for the rest of the session.
 */
export function forceTitanWebGLCompatForSession(): void {
    resolvedCompat = true;
}
