import { MouseInput } from "@input/mouse-input";
import { ArrowKeyInput } from "@input/arrow-key-input";
import { Janitor } from "three-janitor";
import { expose } from "@utils/object-utils";
import { World } from "./world";
import { createUnitSelectionBox } from "@input/create-unit-selection";
import { SceneComposer } from "./scene-composer";
import { Object3D } from "three";
import { Unit } from "@core/unit";
import { isImage3d, isImageHd } from "@utils/image-utils";
import { canSelectUnit } from "@utils/unit-utils";
import { ViewControllerComposer } from "./view-controller-composer";
import { OverlayComposer } from "./overlay-composer";

export type InputsComposer = ReturnType<typeof createInputComposer>;
export type InputsComposerApi = InputsComposer["api"];

const _getSelectionUnit =
    ( images: SceneComposer["images"] ) =>
    ( object: Object3D ): Unit | null => {
        if ( isImageHd( object ) || isImage3d( object ) ) {
            return canSelectUnit( images.getUnit( object ) );
        } else if ( object.parent ) {
            return _getSelectionUnit( images )( object.parent );
        }

        return null;
    };

/**
 * Hanndles user input including unit selection events ( which is then sent through the message bus for other handlers to use ).
 */

export const createInputComposer = (
    world: World,
    { images, scene, imageQuadrants }: SceneComposer
) => {
    const janitor = new Janitor( "InputComposer" );
    const mouseInput = janitor.mop( new MouseInput( document.body ), "mouseInput" );
    const arrowKeyInput = janitor.mop(
        new ArrowKeyInput( document.body ),
        "arrowKeyInput"
    );

    const unitSelectionBox = createUnitSelectionBox(
        world.events,
        mouseInput,
        scene,
        imageQuadrants,
        _getSelectionUnit( images )
    );

    return {
        get mouse() {
            return mouseInput;
        },
        get keyboard() {
            return arrowKeyInput;
        },
        get unitSelectionBox() {
            return unitSelectionBox;
        },
        reset() {
            mouseInput.reset();
        },
        dispose: () => janitor.dispose(),
        update(
            delta: number,
            elapsed: number,
            viewControllerComposer: ViewControllerComposer,
            overlay: OverlayComposer
        ) {
            const { sceneController } = viewControllerComposer;
            const hermesCameraLocked = !!( globalThis as Record< string, unknown > )
                .__hermesCameraLocked;
            // 2026 Hermes embed: when no scene controller plugin is loaded the
            // user still needs to be able to click units / drag a selection
            // box. We process the unit-selection path even without a scene
            // controller and only skip the controller-specific camera /
            // minimap callbacks below.

            // send the mouse click event and cancel any further input handling if the event was cancelled by a listener
            if ( mouseInput.clicked ) {
                if ( world.events.emit( "mouse-click", mouseInput.event ) === false ) {
                    unitSelectionBox.enabled = false;
                    return;
                }
            }

            unitSelectionBox.enabled =
                world.settings.getState().input.unitSelection &&
                ( unitSelectionBox.isActive || !overlay.insideMinimap );

            unitSelectionBox.update();

            // 2026 Hermes embed: classic StarCraft minimap click-to-pan. When
            // there is no scene controller plugin loaded (the default state of
            // our embed), Titan would never wire any onMinimapDragUpdate
            // callback, leaving the minimap visually present but inert. Hook
            // the click+drag against the init viewport's orbit camera so the
            // map view jumps to wherever the user clicks on the minimap.
            if (
                !hermesCameraLocked &&
                overlay.insideMinimap &&
                overlay.minimapUv &&
                ( mouseInput.clicked || mouseInput.move.z > -1 ) &&
                !unitSelectionBox.isActive &&
                ( ( globalThis as Record< string, unknown > )
                    .__hermesClassicMinimap === true ||
                    !sceneController )
            ) {
                const orbit = viewControllerComposer.viewports[0]?.orbit;
                if ( orbit && typeof orbit.moveTo === "function" ) {
                    try {
                        // overlay.minimapUv is a (x,z) world-space target on
                        // the ground plane; pass it to the orbit controls so
                        // the camera glides there (enableTransition=true).
                        orbit.moveTo(
                            overlay.minimapUv.x,
                            ( orbit as unknown as { _targetEnd: { y: number } } )
                                ._targetEnd?.y ?? 0,
                            overlay.minimapUv.y,
                            true
                        );
                    } catch {
                        /* swallow — camera-controls not yet ready */
                    }
                }
            }

            if ( !sceneController ) {
                return;
            }

            if ( hermesCameraLocked ) {
                return;
            }

            if (
                !unitSelectionBox.isActive &&
                overlay.insideMinimap &&
                mouseInput.move.z > -1
            ) {
                sceneController.onMinimapDragUpdate &&
                    sceneController.onMinimapDragUpdate(
                        overlay.minimapUv!,
                        !!mouseInput.clicked,
                        mouseInput.move.z
                    );
            }

            sceneController.onCameraMouseUpdate &&
                sceneController.onCameraMouseUpdate(
                    delta / 1000,
                    elapsed,
                    mouseInput.mouseScrollY,
                    mouseInput.screenDrag,
                    mouseInput.lookAt,
                    mouseInput.move,
                    mouseInput.clientX,
                    mouseInput.clientY,
                    mouseInput.clicked,
                    mouseInput.modifiers
                );

            sceneController.onCameraKeyboardUpdate &&
                sceneController.onCameraKeyboardUpdate(
                    delta / 1000,
                    elapsed,
                    arrowKeyInput.vector
                );
        },
        api: {
            getHoveredUnit() {
                return unitSelectionBox.getHoveredUnit();
            },
            mouse: expose(
                new WeakRef(mouseInput),
                [
                    "mouseScrollY",
                    "screenDrag",
                    "lookAt",
                    "move",
                    "modifiers",
                    "clientX",
                    "clientY",
                    "clicked",
                ]
            ),
        },
    };
};
