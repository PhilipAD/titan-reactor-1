/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import { ImageBufferView } from "@openbw/structs/images-buffer-view";
import gameStore from "@stores/game-store";
import { applyCameraDirectionToImageFrame } from "@utils/camera-utils";
import {
    imageHasDirectionalFrames,
    imageIsFlipped,
    imageIsHidden,
} from "@utils/image-utils";
import { getAngle } from "@utils/unit-utils";
import { imageTypes } from "common/enums";
import { SpriteType } from "common/types";
import { Image3D } from "./image-3d";
import { ImageHD } from "./image-hd";
import { modelSetModifiers } from "./model-effects-configuration";
import { Unit } from "./unit";
import { getHermesUnitVisualAction } from "./world/hermes-visual-actions";

export const overlayEffectsMainImage: { image: Image3D | null } = { image: null };

export const applyRenderModeToSprite = (
    spriteTypeId: number,
    sprite: SpriteType,
) => {
    sprite.rotation.x = 0;
    if ( modelSetModifiers.sprites[spriteTypeId] ) {
        for ( const effect of modelSetModifiers.sprites[spriteTypeId] ) {
            switch ( effect.type ) {
                // set emissive on main image if I'm visible
                case "flat-on-ground":
                    // deprecated once we moved to shader based billboarding
                    // sprite.rotation.x = Math.PI / 2;
                    // sprite.position.y = terrainY + 0.1;
                    break;
            }
        }
    }
};

let imageTypeId: number;
export const applyOverlayEffectsToImageHD = ( imageBuffer: ImageBufferView ) => {
    imageTypeId = gameStore().assets!.refId( imageBuffer.typeId );

    if ( modelSetModifiers.images[imageTypeId] ) {
        for ( const effect of modelSetModifiers.images[imageTypeId] ) {
            switch ( effect.type ) {
                // set emissive on main image if I'm visible
                case "emissive:overlay-visible":
                    if ( overlayEffectsMainImage.image ) {
                        overlayEffectsMainImage.image.setEmissive(
                            imageIsHidden( imageBuffer ) ? 0 : 1
                        );
                    }
                    break;
            }
        }
    }
};

let _frameInfo: { frame: number; flipped: boolean } = { frame: 0, flipped: false };
let _needsUpdateFrame = false;

const visualFrameNow = () => ( typeof performance !== "undefined" ? performance.now() : Date.now() );

const resolveHermesVisualFrameInfo = (
    baseFrame: number,
    baseFlipped: boolean,
    frameCount: number,
    unitId: number | undefined,
    hasDirectionalFrames: boolean
) => {
    if ( !( globalThis as Record< string, unknown > ).__hermesCompletedRenderMode ) {
        return { frame: baseFrame, flipped: baseFlipped };
    }
    const action = getHermesUnitVisualAction( unitId );
    if ( !action || action.kind === "idle" || frameCount <= 1 ) {
        return { frame: baseFrame, flipped: baseFlipped };
    }

    const directionalLaneSize = frameCount >= 17 ? 17 : frameCount;
    const frameSets = Math.max( 1, Math.floor( frameCount / directionalLaneSize ) );
    const actionDirection32 = action.direction32;
    const directionFrame =
        hasDirectionalFrames && typeof actionDirection32 === "number"
            ? actionDirection32 > 16
                ? 32 - actionDirection32
                : actionDirection32
            : Math.abs( baseFrame ) % directionalLaneSize;
    const flipped =
        hasDirectionalFrames && typeof actionDirection32 === "number"
            ? actionDirection32 > 16
            : baseFlipped;

    // Completed-render mode does not tick OpenBW iscript, so action poses
    // need a small client-side phase driver. Most BW unit atlases are
    // arranged as 17 directional frames per pose/step.
    if ( frameSets <= 1 ) {
        return {
            frame: hasDirectionalFrames
                ? directionFrame
                : Math.floor( visualFrameNow() / 160 + action.seed ) % frameCount,
            flipped,
        };
    }

    const speedMs = action.kind === "gathering" ? 120 : 150;
    const phaseBase = Math.floor( visualFrameNow() / speedMs + action.seed );
    let phase = phaseBase % frameSets;
    if ( action.kind === "gathering" && frameSets >= 3 ) {
        phase = 1 + ( phaseBase % ( frameSets - 1 ) );
    }

    const nextFrame = directionFrame + phase * directionalLaneSize;
    return { frame: nextFrame < frameCount ? nextFrame : directionFrame, flipped };
};

export const applyRenderModeToImageHD = (
    imageStruct: ImageBufferView,
    image: ImageHD,
    renderMode3D: boolean,
    direction: number,
    unitId?: number
) => {
    imageTypeId = gameStore().assets!.refId( imageStruct.typeId );

    image.material.depthTest = renderMode3D;
    image.material.depthWrite = false;

    //TODO: don't set directional on firebat flame (421) if eminating from bunker (see: bwgame.h:12513)
    const hasDirectionalFrames = !!(
        imageHasDirectionalFrames( imageStruct ) &&
        imageStruct.typeId !== imageTypes.bunkerOverlay
    );
    if ( hasDirectionalFrames ) {
        _frameInfo = applyCameraDirectionToImageFrame( direction, imageStruct );
    } else {
        _frameInfo.frame = imageStruct.frameIndex;
        _frameInfo.flipped = imageIsFlipped( imageStruct );
    }

    if ( renderMode3D && modelSetModifiers.images[imageTypeId] ) {
        for ( const effect of modelSetModifiers.images[imageTypeId] ) {
            switch ( effect.type ) {
                case "fixed-frame":
                    _frameInfo.frame = effect.frame;
                    _frameInfo.flipped = false;
                    break;
                case "hide-sprite":
                    image.visible = false;
                    break;
            }
        }
    }

    _frameInfo = resolveHermesVisualFrameInfo(
        _frameInfo.frame,
        _frameInfo.flipped,
        image.frames.length,
        unitId,
        hasDirectionalFrames
    );

    image.setFrame( _frameInfo.frame, _frameInfo.flipped );

    if ( renderMode3D ) {
        applyOverlayEffectsToImageHD( imageStruct );
    }
};

export const applyModelEffectsToImage3d = (
    imageBufferView: ImageBufferView,
    image: Image3D,
    unit: Unit | undefined
) => {
    imageTypeId = gameStore().assets!.refId( imageBufferView.typeId );
    _needsUpdateFrame = true;

    if ( unit && image === overlayEffectsMainImage.image ) {
        image.rotation.y = !image.isLooseFrame ? getAngle( unit.direction ) : 0;
    } else {
        image.rotation.y = 0;
    }

    if ( modelSetModifiers.images[imageTypeId] ) {
        for ( const effect of modelSetModifiers.images[imageTypeId] ) {
            switch ( effect.type ) {
                // set emissive to myself if I'm on the right animation frame
                case "remap-frames":
                    image.setFrame( effect.remap( imageBufferView.frameIndex ) );
                    _needsUpdateFrame = false;
                    break;

                case "rotate":
                    image.rotation.y = image.rotation.y + effect.rotation;
                    break;

                case "emissive:frames":
                    if ( image.setEmissive ) {
                        image.setEmissive(
                            effect.frames.includes( image.frameSet ) ? 1 : 0
                        );
                    }
                    break;
                case "scale":
                    image.scale.setScalar( effect.scale );
                    break;
            }
        }
    }

    if ( _needsUpdateFrame ) {
        const frameInfo = resolveHermesVisualFrameInfo(
                imageBufferView.frameIndex,
                false,
                image.frames.length,
                unit?.id,
                false
            );
        image.setFrame(
            frameInfo.frame
        );
    }
};
