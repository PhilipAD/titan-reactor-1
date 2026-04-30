import {
    Camera,
    HalfFloatType,
    LinearSRGBColorSpace,
    Scene,
    ShaderChunk,
    SRGBColorSpace,
    Vector4,
    VSMShadowMap,
    WebGLRenderer,
} from "three";
import { EffectComposer, Pass } from "postprocessing";
import { ColorManagement } from "three";
import { globalEvents } from "../core/global-events";
import {
    forceTitanWebGLCompatForSession,
    getTitanWebGLCompatMode,
} from "common/titan-webgl-compat";

ColorManagement.enabled = true;

// modify global shadow intensity
ShaderChunk.shadowmap_pars_fragment = ShaderChunk.shadowmap_pars_fragment.replace(
    "return shadow;",
    "return max( 0.3, shadow );"
);

const applyWebglCompatToRenderer = ( renderer: WebGLRenderer, webglCompat: boolean ) => {
    renderer.debug.checkShaderErrors = process.env.NODE_ENV === "development";
    renderer.xr.enabled = !webglCompat;

    if ( webglCompat ) {
        renderer.shadowMap.enabled = false;
        renderer.shadowMap.autoUpdate = false;
        renderer.setPixelRatio( 1 );
    } else {
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = VSMShadowMap;
        renderer.shadowMap.autoUpdate = true;
    }
    renderer.sortObjects = true;
    renderer.autoClear = false;
};

let webglUnavailableError: Error | null = null;
let webglUnavailableFallbackInstalled = false;

type RendererBuildOptions = {
    compat: boolean;
    context?: WebGLRenderingContext | WebGL2RenderingContext;
    canvas?: HTMLCanvasElement;
};

const baseRendererParams = ( compat: boolean ) => ( {
    powerPreference: compat ? "default" as const : "high-performance" as const,
    preserveDrawingBuffer: false,
    antialias: false,
    stencil: false,
    depth: false,
    alpha: false,
    precision: "highp" as const,
} );

const buildRenderer = ( { compat, context, canvas }: RendererBuildOptions ) => {
    const renderer = new WebGLRenderer( {
        ...baseRendererParams( compat ),
        ...( context ? { context } : {} ),
        ...( canvas ? { canvas } : {} ),
    } );
    applyWebglCompatToRenderer( renderer, compat );
    return renderer;
};

const tryManualContextRenderer = ( compat: boolean ) => {
    const powerPreferences: WebGLPowerPreference[] = compat
        ? [ "low-power", "default", "high-performance" ]
        : [ "high-performance", "default", "low-power" ];
    const contextNames = [ "webgl2", "webgl", "experimental-webgl" ];
    const baseAttrs: WebGLContextAttributes = {
        alpha: false,
        depth: true,
        stencil: false,
        antialias: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        failIfMajorPerformanceCaveat: false,
        desynchronized: false,
    };

    console.info(
        "[Titan] Trying ultra-compatible WebGL context creation",
        { compat, contextNames, powerPreferences }
    );

    for ( const contextName of contextNames ) {
        for ( const powerPreference of powerPreferences ) {
            const canvas = document.createElement( "canvas" );
            const attrs = { ...baseAttrs, powerPreference };
            const context = canvas.getContext(
                contextName,
                attrs
            ) as WebGLRenderingContext | WebGL2RenderingContext | null;

            if ( !context ) {
                continue;
            }

            try {
                const renderer = buildRenderer( { compat, context, canvas } );
                console.info(
                    `[Titan] WebGL context created: ${contextName} (${powerPreference})`
                );
                return renderer;
            } catch {
                try {
                    context.getExtension( "WEBGL_lose_context" )?.loseContext();
                } catch {
                    /* ignore */
                }
            }
        }
    }

    console.error( "[Titan] Could not create WebGL context in ultra-compat mode" );
    return null;
};

export const createWebGLRenderer = () => {
    if ( webglUnavailableError ) {
        throw webglUnavailableError;
    }

    const webglCompat = getTitanWebGLCompatMode();

    if ( webglCompat ) {
        const renderer = tryManualContextRenderer( true );
        if ( renderer ) return renderer;
        webglUnavailableError = new Error( "Titan WebGLRenderer could not be created" );
        throw webglUnavailableError;
    }

    try {
        return buildRenderer( { compat: webglCompat } );
    } catch {
        if ( !webglCompat ) {
            forceTitanWebGLCompatForSession();
            try {
                return buildRenderer( { compat: true } );
            } catch {
                const renderer = tryManualContextRenderer( true );
                if ( renderer ) return renderer;
            }
        } else {
            const renderer = tryManualContextRenderer( true );
            if ( renderer ) return renderer;
        }
        webglUnavailableError = new Error( "Titan WebGLRenderer could not be created" );
        throw webglUnavailableError;
    }
};

const installWebGLUnavailableFallback = ( error: unknown ) => {
    if ( webglUnavailableFallbackInstalled ) {
        return;
    }
    webglUnavailableFallbackInstalled = true;
    const message = error instanceof Error ? error.message : String( error );
    console.error( "[Titan] WebGL unavailable; showing fallback screen", error );

    const mount = () => {
        if ( document.getElementById( "titan-webgl-unavailable" ) ) {
            return;
        }
        const el = document.createElement( "div" );
        el.id = "titan-webgl-unavailable";
        el.setAttribute( "role", "alert" );
        el.style.cssText = [
            "position:fixed",
            "inset:0",
            "z-index:2147483647",
            "display:flex",
            "align-items:center",
            "justify-content:center",
            "background:#080d12",
            "color:#9ee7ff",
            "font:14px/1.5 monospace",
            "padding:32px",
            "box-sizing:border-box",
            "text-align:center",
        ].join( ";" );
        el.innerHTML = `
            <div style="max-width:820px;border:1px solid #1d5f7d;background:rgba(2,14,24,.94);box-shadow:0 0 40px rgba(0,180,255,.16);padding:30px">
                <div style="font-size:24px;letter-spacing:.12em;color:#ff8f8f;margin-bottom:14px">TITAN WEBGL UNAVAILABLE</div>
                <p style="font-size:16px;max-width:640px;margin:0 auto 22px;color:#d6fbff">
                    Chrome on this VM is blocking WebGL through the llvmpipe software renderer.
                </p>

                <div style="background:#07121b;border:1px solid #234f64;padding:18px;text-align:left;max-width:680px;margin:0 auto;color:#c8f5ff">
                    <strong style="color:#9fffb4">One-time fix for this Chrome profile:</strong><br /><br />
                    1. Open a new tab and go to: <strong>chrome://flags/#ignore-gpu-blocklist</strong><br />
                    2. Find <strong>Override software rendering list</strong><br />
                    3. Set it to <strong>Enabled</strong><br />
                    4. Click <strong>Relaunch</strong> at the bottom of Chrome<br />
                    5. Return here and refresh the dashboard
                </div>

                <button id="titan-open-chrome-flags" style="margin-top:22px;padding:12px 22px;font:700 15px monospace;background:#9fffb4;color:#00140a;border:0;cursor:pointer">
                    Open chrome://flags
                </button>

                <button id="titan-copy-chrome-flags" style="margin-top:22px;margin-left:10px;padding:12px 22px;font:700 15px monospace;background:#12384a;color:#d6fbff;border:1px solid #2a6e8c;cursor:pointer">
                    Copy flags URL
                </button>

                <div id="titan-flags-status" style="min-height:20px;margin-top:14px;color:#9fffb4"></div>

                <details style="margin:26px auto 0;max-width:680px;text-align:left;color:#8fb8c8">
                    <summary style="cursor:pointer;color:#d6fbff">Why does this happen?</summary>
                    <div style="margin-top:12px">
                        This VM exposes Mesa llvmpipe / virtio software OpenGL. Chrome blocks that path for WebGL unless
                        its software-rendering blocklist is overridden. The flag above is the persistent browser equivalent
                        of launching Chrome with <code>--ignore-gpu-blocklist --enable-3d-apis</code>.
                    </div>
                </details>

                <pre style="white-space:pre-wrap;text-align:left;background:#000b12;border:1px solid #12394d;padding:12px;color:#b9f1ff;overflow:auto;max-height:120px;margin-top:18px">${message.replace( /[<>&]/g, ( c ) => ( { "<": "&lt;", ">": "&gt;", "&": "&amp;" }[ c ]! ) )}</pre>
            </div>
        `;
        document.body?.appendChild( el );
        const flagsUrl = "chrome://flags/#ignore-gpu-blocklist";
        const status = document.getElementById( "titan-flags-status" );
        const setStatus = ( text: string ) => {
            if ( status ) status.textContent = text;
        };
        document.getElementById( "titan-open-chrome-flags" )?.addEventListener( "click", () => {
            const opened = window.open( flagsUrl, "_blank", "noopener,noreferrer" );
            setStatus(
                opened
                    ? "Opened chrome://flags. If Chrome blocked it, copy the URL instead."
                    : "Chrome blocked opening chrome://flags from this page. Copy the URL instead."
            );
        } );
        document.getElementById( "titan-copy-chrome-flags" )?.addEventListener( "click", async () => {
            try {
                await navigator.clipboard.writeText( flagsUrl );
                setStatus( "Copied chrome://flags/#ignore-gpu-blocklist" );
            } catch {
                setStatus( flagsUrl );
            }
        } );
    };

    if ( document.body ) {
        mount();
    } else {
        window.addEventListener( "DOMContentLoaded", mount, { once: true } );
    }
};

const createFallbackRenderComposer = ( error: unknown ): TitanRenderComposer => {
    installWebGLUnavailableFallback( error );
    const canvas = document.createElement( "canvas" );
    const noop = () => {};
    const fakeComposer = {
        autoRenderToScreen: false,
        multisampling: 0,
        setRenderer: noop,
        setSize: noop,
        setMainCamera: noop,
        setMainScene: noop,
        removeAllPasses: noop,
        addPass: noop,
        render: noop,
        dispose: noop,
    };
    const fakeRenderer = {
        domElement: canvas,
        xr: {
            enabled: false,
            isPresenting: false,
            addEventListener: noop,
            removeEventListener: noop,
        },
        shadowMap: { enabled: false, autoUpdate: false },
        capabilities: {
            maxSamples: 0,
            getMaxAnisotropy: () => 1,
            getMaxPrecision: () => "lowp",
        },
        extensions: {
            has: () => false,
            init: noop,
        },
        setViewport: noop,
        setAnimationLoop: noop,
        render: noop,
        dispose: noop,
        compile: noop,
        initTexture: noop,
        setScissorTest: noop,
        setScissor: noop,
        outputColorSpace: SRGBColorSpace,
        toneMappingExposure: 1,
        sortObjects: true,
        autoClear: false,
    };

    return {
        composer: fakeComposer,
        get glRenderer() {
            return fakeRenderer;
        },
        get srcCanvas() {
            return canvas;
        },
        set dstCanvas( _surface: HTMLCanvasElement ) {},
        setAnimationLoop: noop,
        render: noop,
        dispose: noop,
        preprocessStart: noop,
        preprocessEnd: noop,
    } as unknown as TitanRenderComposer;
};

export const useWebGLRenderer = async (fn: (renderer: WebGLRenderer) => any) => {
    let renderer: WebGLRenderer;
    try {
        renderer = createWebGLRenderer();
    } catch ( error ) {
        installWebGLUnavailableFallback( error );
        return;
    }
    await fn(renderer);
    renderer.dispose();
};

type BundledPasses = { passes: Pass[] };

/**
 * Manages rendering using post processing.
 */
export class TitanRenderComposer {
    #renderer!: WebGLRenderer;
    #prevBundle: any = null;
    #dstCanvas!: HTMLCanvasElement;
    #dstContext: CanvasRenderingContext2D | null = null;
    #observer?: ResizeObserver;

    composer = new EffectComposer(undefined, {
        frameBufferType: HalfFloatType,
        multisampling: 0,
        stencilBuffer: false,
        alpha: true,
        depthBuffer: true,
    });

    constructor(surface?: HTMLCanvasElement) {
        this.init();
        this.dstCanvas = surface ?? this.#renderer.domElement;
    }

    init() {
        const renderer = (this.#renderer = createWebGLRenderer());

        this.composer.setRenderer(renderer);
        this.composer.autoRenderToScreen = false;

        renderer.domElement.addEventListener("webglcontextlost", (evt) => {
            evt.preventDefault();
            globalEvents.emit("webglcontextlost");
        });

        renderer.domElement.addEventListener("webglcontextrestored", () => {
            globalEvents.emit("webglcontextrestored");
        });

        renderer.xr.addEventListener("sessionstart", () => {
            globalEvents.emit("xr-session-start");
        });

        renderer.xr.addEventListener("sessionend", () => {
            globalEvents.emit("xr-session-end");
        });
    }

    get glRenderer() {
        return this.#renderer;
    }

    get srcCanvas() {
        return this.#renderer.domElement;
    }

    setAnimationLoop(fn: Parameters<WebGLRenderer["setAnimationLoop"]>[0]) {
        this.#renderer.setAnimationLoop(fn);
    }

    #setBundledPasses(bundle: BundledPasses) {
        if (bundle === this.#prevBundle) {
            return;
        }
        this.#prevBundle = bundle;

        this.composer.removeAllPasses();
        let lastPass: any = null;
        for (const pass of bundle.passes) {
            pass.renderToScreen = false;
            this.composer.addPass(pass);
            if (pass.enabled) {
                lastPass = pass;
            }
        }
        lastPass.renderToScreen = true;
    }

    set dstCanvas(surface: HTMLCanvasElement) {
        if (this.#observer) {
            this.#observer.disconnect();
        }
        this.#dstCanvas = surface;
        this.#renderer.setViewport(new Vector4(0, 0, surface.width, surface.height));

        this.#dstContext = null;

        if (surface !== this.#renderer.domElement) {
            this.#dstContext = surface.getContext("2d");
            if (!this.#dstContext) {
                throw new Error("Could not get canvas context");
            }
        }

        this.composer.setSize(surface.width, surface.height, false);
        this.#observer = new ResizeObserver(() => {
            this.composer.setSize(surface.width, surface.height, false);
        });
        this.#observer.observe(surface);
    }

    /**
     * Renders the scene to the screen.
     * If a viewport is provided, only that part of the screen will be rendered to.
     */
    render(
        delta: number,
        scene: Scene,
        camera: Camera,
        viewport: Vector4 | null,
        bundledPasses: BundledPasses | null
    ) {
        this.composer.setMainCamera( camera );
        this.composer.setMainScene( scene );

        this.#renderer.setViewport(
            0,
            0,
            this.#dstCanvas.width,
            this.#dstCanvas.height
        );

        // Render the scene using the post-processing pipeline.
        if (bundledPasses && this.#renderer.xr.isPresenting === false) {

            this.#setBundledPasses(bundledPasses);
            // If a viewport is provided, we need to enable the scissor test so that only that part of the screen is rendered to.
            if (viewport) {
                this.#renderer!.setScissorTest(true);
                this.#renderer!.setViewport(viewport);
                this.#renderer!.setScissor(viewport);
            }

            this.composer.render(delta);

            // If a viewport is provided, we need to disable the scissor test so that the rest of the screen is rendered to as well.
            if (viewport) {
                this.#renderer!.setScissorTest(false);
            }
        } else {
            this.#renderer.render( scene, camera );
        }

        if (this.#dstContext) {
            this.#copySrcToDst();
        }
    }

    /**
     * Copies the contents of the renderer to the target surface.
     */
    #copySrcToDst() {
        const surface = this.#dstCanvas;

        if (surface === this.#renderer!.domElement) {
            return;
        }

        if (this.#dstContext) {
            this.#dstContext.drawImage(
                this.#renderer!.domElement,
                0,
                this.#renderer!.domElement.height - surface!.height,
                surface!.width,
                surface!.height,
                0,
                0,
                surface!.width,
                surface!.height
            );
        } else {
            console.warn("context error");
        }
    }

    dispose() {
        this.#renderer.setAnimationLoop(null);
        this.#renderer.dispose();
        this.composer.dispose();
        this.#dstContext = null;
        this.#observer?.disconnect();
    }

    // for rendering atlases ahead of time like terrain textures, icons, etc.
    preprocessStart() {
        this.#renderer!.autoClear = false;
        this.#renderer!.outputColorSpace = LinearSRGBColorSpace;
    }

    preprocessEnd() {
        this.#renderer!.autoClear = false;
        this.#renderer!.outputColorSpace = SRGBColorSpace;
    }
}

export const renderComposer = (() => {
    try {
        return new TitanRenderComposer();
    } catch ( error ) {
        return createFallbackRenderComposer( error );
    }
})();
