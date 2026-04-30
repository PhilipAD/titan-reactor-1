export type HermesUnitVisualActionKind = "idle" | "moving" | "gathering" | "carrying";

export interface HermesUnitVisualAction {
    kind: HermesUnitVisualActionKind;
    resource?: "mineral" | "gas";
    direction8?: number;
    direction32?: number;
    updatedAtMs: number;
    seed: number;
}

const HERMES_UNIT_VISUAL_ACTIONS_KEY = "__hermesUnitVisualActions";

const nowMs = () => ( typeof performance !== "undefined" ? performance.now() : Date.now() );

export const getHermesUnitVisualActions = (): Map< number, HermesUnitVisualAction > => {
    const g = globalThis as Record< string, unknown >;
    const existing = g[HERMES_UNIT_VISUAL_ACTIONS_KEY];
    if ( existing instanceof Map ) {
        return existing as Map< number, HermesUnitVisualAction >;
    }
    const actions = new Map< number, HermesUnitVisualAction >();
    g[HERMES_UNIT_VISUAL_ACTIONS_KEY] = actions;
    return actions;
};

export const setHermesUnitVisualAction = (
    unitId: number,
    kind: HermesUnitVisualActionKind,
    resource?: "mineral" | "gas",
    direction8?: number
) => {
    const actions = getHermesUnitVisualActions();
    const prev = actions.get( unitId );
    const normalizedDirection8 =
        typeof direction8 === "number" ? ( Math.round( direction8 ) + 256 ) % 256 : prev?.direction8;
    const direction32 =
        typeof normalizedDirection8 === "number"
            ? Math.round( normalizedDirection8 / 8 ) % 32
            : prev?.direction32;
    if (
        prev?.kind === kind &&
        prev.resource === resource &&
        prev.direction8 === normalizedDirection8
    ) {
        return;
    }
    actions.set( unitId, {
        kind,
        resource,
        direction8: normalizedDirection8,
        direction32,
        updatedAtMs: nowMs(),
        seed: prev?.seed ?? ( unitId % 17 ),
    } );
};

export const clearHermesUnitVisualAction = ( unitId: number ) => {
    getHermesUnitVisualActions().delete( unitId );
};

export const getHermesUnitVisualAction = ( unitId?: number ) => {
    if ( typeof unitId !== "number" ) return undefined;
    return getHermesUnitVisualActions().get( unitId );
};

