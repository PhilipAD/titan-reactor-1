import { SurfaceComposer } from "@core/world/surface-composer";
import { log } from "@ipc/log";
import { Janitor } from "three-janitor";
import { DamageType, Explosion } from "common/enums";
import { PerspectiveCamera, Vector3 } from "three";
import CameraControls from "camera-controls";
import { GameViewPort } from "../../camera/game-viewport";
import { World } from "./world";
import type { SceneController } from "@plugins/scene-controller";
import { easeInCubic } from "@utils/function-utils";
import range from "common/utils/range";
import { mixer } from "@audio/main-mixer";
import { renderComposer } from "@render/index";
import { VRSceneController } from "@plugins/vr-controller";

// frequency, duration, strength multiplier
const explosionFrequencyDuration = {
    [Explosion.Splash_Radial]: [ 6, 1.25, 1 ],
    [Explosion.Splash_Enemy]: [ 8, 1.25, 1 ],
    [Explosion.SplashAir]: [ 10, 1, 1 ],
    [Explosion.CorrosiveAcid]: [ 20, 0.75, 1 ],
    [Explosion.Normal]: [ 15, 0.75, 1 ],
    [Explosion.NuclearMissile]: [ 2, 3, 2 ],
    [Explosion.YamatoGun]: [ 4, 2, 1 ],
};
// strength, xyz index
const bulletStrength = {
    [DamageType.Explosive]: [ 1, 0 ],
    [DamageType.Concussive]: [ 0.5, 1 ],
    [DamageType.Normal]: [ 0.25, 2 ],
};

export type ViewControllerComposer = ReturnType<typeof createViewControllerComposer>;
export type ViewControllerComposerApi = ViewControllerComposer["api"];

/**
 * The Scene Controller plugin is responsible for managing the game viewports.
 * This composer helps activate those plugins, as well as update the viewports and their orbiting camera controls.
 * 
 * @param world 
 * @param param1 
 * @returns 
 */
export const createViewControllerComposer = (
    world: World,
    { gameSurface }: SurfaceComposer,
    initialStartLocation: Vector3
) => {
    let activating = false;

    // for when no scene controller is loaded initially
    const initViewport = new GameViewPort( gameSurface, true );
    initViewport.fullScreen();
    // 2026 Hermes embed: lock the camera target by default. The dashboard
    // boots centered on the Command Center; users can zoom in/out, but cannot
    // pan, drag, rotate, minimap-pan, or edge-pan away from that CC target.
    // We keep a slight tilt (polar=0.42 rad) instead of
    // 0 so the SD sprite billboards still look right (perfect overhead would
    // make units paper-thin and the heightmap unreadable).
    //
    // Override with ?camera3d=1 to restore the free-orbit isometric camera.
    let useClassic = true;
    try {
        const qs = new URLSearchParams( globalThis.location?.search ?? "" );
        if ( qs.get( "camera3d" ) === "1" || qs.get( "camera3d" ) === "true" ) {
            useClassic = false;
        }
    } catch {
        /* no-op for non-DOM contexts */
    }

    const CLASSIC_POLAR = 0.42;
    const CLASSIC_DISTANCE = 180;
    const CLASSIC_MIN_DISTANCE = 120;
    const CLASSIC_MAX_DISTANCE = 280;
    const HERMES_CAMERA_LOCKED = true;

    if ( useClassic ) {
        // Top-down looking straight down at the start location at distance 60
        // The polar angle is fixed below.
        initViewport.orbit.setLookAt(
            initialStartLocation.x,
            initialStartLocation.y + CLASSIC_DISTANCE * Math.cos( CLASSIC_POLAR ),
            initialStartLocation.z + CLASSIC_DISTANCE * Math.sin( CLASSIC_POLAR ),
            initialStartLocation.x,
            initialStartLocation.y,
            initialStartLocation.z,
            false
        );
    } else {
        initViewport.orbit.setLookAt(
            initialStartLocation.x,
            Math.max( 30, initialStartLocation.y + 30 ),
            initialStartLocation.z + 30,
            initialStartLocation.x,
            initialStartLocation.y,
            initialStartLocation.z,
            false
        );
    }
    try {
        if ( useClassic ) {
            // CLASSIC locked mode: panning/rotation gestures are disabled,
            // but wheel zoom remains enabled and always dollies around the
            // current CC target.
            // Left-click remains available to unit selection because
            // CameraControls receives ACTION.NONE for drag mouse/touch paths.
            initViewport.orbit.mouseButtons.left = CameraControls.ACTION.NONE;
            initViewport.orbit.mouseButtons.right = CameraControls.ACTION.NONE;
            initViewport.orbit.mouseButtons.middle = CameraControls.ACTION.NONE;
            initViewport.orbit.mouseButtons.wheel = CameraControls.ACTION.DOLLY;
            initViewport.orbit.touches.one = CameraControls.ACTION.NONE;
            initViewport.orbit.touches.two = CameraControls.ACTION.TOUCH_DOLLY;
            initViewport.orbit.touches.three = CameraControls.ACTION.NONE;
            initViewport.orbit.minDistance = CLASSIC_MIN_DISTANCE;
            initViewport.orbit.maxDistance = CLASSIC_MAX_DISTANCE;
            // Lock the angle so the camera stays at the classic SC tilt.
            initViewport.orbit.minPolarAngle = CLASSIC_POLAR;
            initViewport.orbit.maxPolarAngle = CLASSIC_POLAR;
            initViewport.orbit.minAzimuthAngle = 0;
            initViewport.orbit.maxAzimuthAngle = 0;
            initViewport.orbit.azimuthRotateSpeed = 0;
            initViewport.orbit.polarRotateSpeed = 0;
            initViewport.orbit.dollySpeed = 1.4;
            initViewport.orbit.dollyToCursor = false;
            initViewport.orbit.truckSpeed = 0;
        } else {
            initViewport.orbit.mouseButtons.left = CameraControls.ACTION.ROTATE;
            initViewport.orbit.mouseButtons.right = CameraControls.ACTION.TRUCK;
            initViewport.orbit.mouseButtons.middle = CameraControls.ACTION.DOLLY;
            initViewport.orbit.mouseButtons.wheel = CameraControls.ACTION.DOLLY;
            initViewport.orbit.touches.one = CameraControls.ACTION.TOUCH_ROTATE;
            initViewport.orbit.touches.two = CameraControls.ACTION.TOUCH_TRUCK;
            initViewport.orbit.touches.three = CameraControls.ACTION.TOUCH_DOLLY;
            initViewport.orbit.minDistance = 8;
            initViewport.orbit.maxDistance = 200;
            initViewport.orbit.minPolarAngle = 0.25;
            initViewport.orbit.maxPolarAngle = Math.PI * 0.46;
            initViewport.orbit.azimuthRotateSpeed = 1.6;
            initViewport.orbit.polarRotateSpeed = 1.6;
            initViewport.orbit.dollySpeed = 1.6;
            initViewport.orbit.truckSpeed = 4.0;
        }
        // Snappy response — default 0.25s damping makes the iframe feel sluggish.
        initViewport.orbit.smoothTime = 0.08;
        initViewport.orbit.draggingSmoothTime = 0.04;
        // Expose the orbit on window so tests / dashboard scripts can verify
        // the camera actually moves in response to gestures. Cheap and only
        // assigned in this fallback path.
        ( globalThis as Record<string, unknown> ).__hermesInitOrbit =
            initViewport.orbit;
        ( globalThis as Record<string, unknown> ).__hermesInitCameraMode =
            useClassic ? "classic" : "orbit";
        ( globalThis as Record<string, unknown> ).__hermesCameraLocked =
            HERMES_CAMERA_LOCKED;
        ( globalThis as Record<string, unknown> ).__hermesCameraZoomEnabled =
            useClassic;
    } catch ( err ) {
        log.warn( "@view-composer/init viewport mouse controls unavailable: " + String( err ) );
    }
    const viewports: GameViewPort[] = [initViewport]

    const createViewports = (n = 4) => range( 0, n ).map( i => new GameViewPort( gameSurface, i === 0 ) );

    let sceneController: SceneController | null = null;

    const _target = new Vector3();
    const _position = new Vector3();
    const _audioPosition = new Vector3();

    const janitor = new Janitor( "ViewInputComposer" );

    // 2026 Hermes embed: classic StarCraft edge-of-screen camera pan.
    // We track the mouse position on the canvas and, every frame, if the
    // cursor sits in the EDGE_THICKNESS-pixel margin, we call orbit.truck()
    // to pan the camera in that direction. Speed scales linearly with how
    // close the mouse is to the edge so corners pan diagonally fast.
    const EDGE_THICKNESS = 36; // px from edge that triggers pan
    const EDGE_PAN_SPEED = 28; // base world units / second at full edge
    let __hermesEdgeMouseX = -1;
    let __hermesEdgeMouseY = -1;
    let __hermesEdgeInside = false;
    let __hermesEdgePanEnabled = false;
    try {
        const qs = new URLSearchParams( globalThis.location?.search ?? "" );
        if ( qs.get( "edgePan" ) === "0" || qs.get( "edgePan" ) === "false" ) {
            __hermesEdgePanEnabled = false;
        }
        // Camera lock intentionally ignores edgePan=1; unit selection remains
        // active, but no user input is allowed to move the camera.
    } catch {
        /* no-op */
    }
    if ( __hermesEdgePanEnabled && typeof window !== "undefined" ) {
        const onMove = ( ev: MouseEvent ) => {
            __hermesEdgeMouseX = ev.clientX;
            __hermesEdgeMouseY = ev.clientY;
            __hermesEdgeInside = true;
        };
        const onLeave = () => {
            __hermesEdgeInside = false;
        };
        window.addEventListener( "mousemove", onMove, { passive: true } );
        window.addEventListener( "mouseleave", onLeave, { passive: true } );
        window.addEventListener( "blur", onLeave );
        janitor.mop( () => {
            window.removeEventListener( "mousemove", onMove );
            window.removeEventListener( "mouseleave", onLeave );
            window.removeEventListener( "blur", onLeave );
        }, "edge-pan-listeners" );
    }
    ( globalThis as Record< string, unknown > ).__hermesEdgePanEnabled =
        __hermesEdgePanEnabled;
    const __hermesUpdateEdgePan = ( delta: number ) => {
        if ( !__hermesEdgePanEnabled || !__hermesEdgeInside ) return;
        const w = gameSurface.bufferWidth;
        const h = gameSurface.bufferHeight;
        if ( w <= 0 || h <= 0 ) return;
        const x = __hermesEdgeMouseX;
        const y = __hermesEdgeMouseY;
        if ( x < 0 || y < 0 || x > w || y > h ) return;
        let dx = 0;
        let dy = 0;
        if ( x < EDGE_THICKNESS ) dx = -( EDGE_THICKNESS - x ) / EDGE_THICKNESS;
        else if ( x > w - EDGE_THICKNESS )
            dx = ( x - ( w - EDGE_THICKNESS ) ) / EDGE_THICKNESS;
        if ( y < EDGE_THICKNESS ) dy = -( EDGE_THICKNESS - y ) / EDGE_THICKNESS;
        else if ( y > h - EDGE_THICKNESS )
            dy = ( y - ( h - EDGE_THICKNESS ) ) / EDGE_THICKNESS;
        if ( dx === 0 && dy === 0 ) return;
        const dt = Math.max( 0, delta ) / 1000;
        const speed = EDGE_PAN_SPEED * dt;
        // Note: orbit.truck(x, y) pans in screen-aligned axes — y down on
        // screen = forward in world for our top-down camera, so we negate
        // dy so the camera moves "up" (toward map top) when the mouse is at
        // the top edge.
        const orbit = viewports[0]?.orbit;
        if ( orbit && typeof orbit.truck === "function" ) {
            try {
                orbit.truck( dx * speed, dy * speed, false );
            } catch {
                /* swallow — camera-controls sometimes throws on init */
            }
        }
    };
    ( globalThis as Record< string, unknown > ).__hermesUpdateEdgePan =
        __hermesUpdateEdgePan;

    world.events.on( "resize", ( ) => {
        for ( const viewport of viewports ) {
            if ( viewport.camera instanceof PerspectiveCamera ) {
                viewport.camera.aspect = viewport.aspect;
            }
            viewport.camera.updateProjectionMatrix();
        }
    } );

    world.events.on( "dispose", () => {
        janitor.dispose();
    } );

    return {
        api: {
            get viewport() {
                return viewports[0];
            },
            get secondViewport() {
                return viewports[1];
            },
            viewports,
        },
        update( delta: number ) {
            // Camera is intentionally locked in the Hermes embed.
            if ( !( globalThis as Record<string, unknown> ).__hermesCameraLocked ) {
                __hermesUpdateEdgePan( delta );
            }

            if ( !sceneController ) {
                return;
            }

            sceneController.viewport.orbit.getTarget( _target );
            sceneController.viewport.orbit.getPosition( _position );

            _audioPosition.copy(
                sceneController.onUpdateAudioMixerLocation( _target, _position )
            );

            mixer.update(
                _audioPosition,
                sceneController.onUpdateAudioMixerOrientation(),
                delta
            );
            
        },

        get viewports() {
            return viewports;
        },

        deactivate() {
            sceneController = null;
        },

        /**
         * Activates a scene controller plugin. 
         * Runs events on the previous scene controller if it exists.
         * Resets all viewports.
         * 
         * @param newController 
         * @param globalData 
         * @returns 
         */
        async activate(
            newController: SceneController,
        ) {
            if ( activating ) {
                return;
            }
            activating = true;

            let prevData = this.generatePrevData() 

            if ( sceneController?.onExitScene ) {
                try {
                    world.events.emit( "scene-controller-exit", sceneController.name );
                    const _prevData = sceneController.onExitScene( prevData );
                    if (_prevData) {
                        prevData = _prevData;
                    }
                } catch ( e ) {
                    log.error( e );
                }
            }

            if (sceneController) {
                sceneController.parent.removeFromParent();
            }

            if ( sceneController?.isWebXR ) {
                (sceneController as VRSceneController).viewerPosition.removeFromParent();
            }

            sceneController = null;
            gameSurface.togglePointerLock( false );
            
            for (const viewport of viewports) {
                viewport.dispose();
            }

            viewports.length = 0;
            viewports.push(...createViewports(newController.viewportsCount));

            if (newController.isWebXR) {
                const vrController = newController as VRSceneController;
                vrController.setupXR( renderComposer.glRenderer.xr );
                newController.scene.add( vrController.viewerPosition );
                vrController.viewerPosition.add( vrController.viewport.camera );
            }

            newController.scene.add( newController.parent );

            world.settings.vars.input.unitSelection.set(true);
            world.settings.vars.input.cursorVisible.set(true);
            await newController.onEnterScene( prevData );
            sceneController = newController;
        
            world.events.emit( "scene-controller-enter", newController.name );

            activating = false;
        },

        /**
         * Primary viewport is necessary because audio will require a camera position, and depth of field will only apply in one viewport for performance.
         */
        get primaryViewport(): GameViewPort  {
            return viewports[0];
        },

        set aspect( val: number ) {
            for ( const viewport of this.viewports ) {
                if ( viewport.aspect !== val ) {
                    viewport.aspect = val;
                }
            }
        },

        get sceneController() {
            return sceneController;
        },

        get primaryCamera() {
            return this.primaryViewport?.camera;
        },

        get primaryRenderMode3D() {
            return this.primaryViewport?.renderMode3D ?? false;
        },

        changeRenderMode( renderMode3D?: boolean ) {
            this.primaryViewport!.renderMode3D =
                renderMode3D ?? !this.primaryViewport!.renderMode3D;
        },

        generatePrevData() {
            return  viewports[0].generatePrevData();
        },

        doShakeCalculation(
            explosionType: Explosion,
            damageType: DamageType,
            spritePos: Vector3
        ) {
            const exp =
                explosionFrequencyDuration[
                    explosionType as keyof typeof explosionFrequencyDuration
                ];
            const _bulletStrength =
                bulletStrength[damageType as keyof typeof bulletStrength];

            if (
                _bulletStrength &&
                !(
                    exp === undefined ||
                    damageType === DamageType.IgnoreArmor ||
                    damageType === DamageType.Independent
                )
            ) {
                for ( const v of viewports ) {
                    if ( !v.enabled || !v.cameraShake.enabled ) {
                        continue;
                    }
                    const distance = v.camera.position.distanceTo( spritePos );
                    if ( distance < v.cameraShake.maxShakeDistance ) {
                        const calcStrength =
                            _bulletStrength[0] *
                            easeInCubic( 1 - distance / v.cameraShake.maxShakeDistance ) *
                            exp[2];
                        if (
                            calcStrength >
                            v.shakeCalculation.strength.getComponent( _bulletStrength[1] )
                        ) {
                            v.shakeCalculation.strength.setComponent(
                                _bulletStrength[1],
                                calcStrength
                            );
                            v.shakeCalculation.duration.setComponent(
                                _bulletStrength[1],
                                exp[1] * 1000
                            );
                            v.shakeCalculation.frequency.setComponent(
                                _bulletStrength[1],
                                exp[0]
                            );
                            v.shakeCalculation.needsUpdate = true;
                        }
                    }
                }
            }
        },
    };
};
