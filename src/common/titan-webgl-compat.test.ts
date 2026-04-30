import { rendererStringLooksSoftware } from "./titan-webgl-renderer-label";

describe( "rendererStringLooksSoftware", () => {
    it( "detects llvmpipe", () => {
        expect(
            rendererStringLooksSoftware(
                "Mesa llvmpipe (LLVM 20.1.2, 256 bits)"
            )
        ).toBe( true );
    } );

    it( "detects SwiftShader in ANGLE string", () => {
        expect(
            rendererStringLooksSoftware(
                "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)))"
            )
        ).toBe( true );
    } );

    it( "does not flag NVIDIA", () => {
        expect(
            rendererStringLooksSoftware(
                "NVIDIA Corporation NVIDIA GeForce RTX 3080/PCIe/SSE2"
            )
        ).toBe( false );
    } );

    it( "does not flag AMD", () => {
        expect(
            rendererStringLooksSoftware(
                "AMD Radeon RX 6700 XT (radeonsi, navi22, LLVM 18.1.7, DRM 3.57)"
            )
        ).toBe( false );
    } );
} );
