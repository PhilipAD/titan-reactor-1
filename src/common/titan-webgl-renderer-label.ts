/**
 * Heuristic: UNMASKED_RENDERER_WEBGL strings that indicate CPU / software GL.
 */
export function rendererStringLooksSoftware( s: string ): boolean {
    const u = s.toLowerCase();
    return (
        u.includes( "llvmpipe" ) ||
        u.includes( "swiftshader" ) ||
        u.includes( "lavapipe" ) ||
        u.includes( "softpipe" ) ||
        u.includes( "virgl" ) ||
        u.includes( "microsoft basic render" ) ||
        u.includes( "mesa offscreen" ) ||
        u.includes( "apple software renderer" ) ||
        u.includes( "google swiftshader" ) ||
        ( u.includes( "angle (google, vulkan" ) && u.includes( "swiftshader" ) )
    );
}
