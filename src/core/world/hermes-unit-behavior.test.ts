import { installBehaviorLoop, type BehaviorOpenBW } from "./hermes-unit-behavior";
import { getHermesUnitVisualAction } from "./hermes-visual-actions";

const makeOpenBW = (
    units: BehaviorOpenBW["iterators"]["units"]
): BehaviorOpenBW & {
    issued: Array< { unitId: number; commandType: number; targetUnitId: number } >;
    issuedTargets: Array< { unitId: number; commandType: number; targetUnitId: number; x: number; y: number } >;
} => {
    const issued: Array< { unitId: number; commandType: number; targetUnitId: number } > = [];
    const issuedTargets: Array< { unitId: number; commandType: number; targetUnitId: number; x: number; y: number } > = [];
    return {
        issued,
        issuedTargets,
        isSandboxMode: () => true,
        iterators: { units },
        get_util_funcs: () => ( {
            issue_command: ( unitId, commandType, targetUnitId, x, y ) => {
                issued.push( { unitId, commandType, targetUnitId } );
                issuedTargets.push( { unitId, commandType, targetUnitId, x, y } );
            },
        } ),
    };
};

const attachTileFlags = (
    openBW: BehaviorOpenBW,
    mapWidthTiles: number,
    mapHeightTiles: number,
    blockedTiles: Array< { tx: number; ty: number } >
) => {
    const ptr = 64;
    const offset = ptr >> 1;
    const tileCount = mapWidthTiles * mapHeightTiles;
    const heap = new Uint16Array( offset + tileCount * 2 + 8 );
    for ( const { tx, ty } of blockedTiles ) {
        const tilePos = ty * mapWidthTiles + tx;
        heap[offset + tilePos * 2 + 1] = 0x80;
    }
    openBW.HEAPU16 = heap;
    openBW.getTilesPtr = () => ptr;
    openBW.getTilesSize = () => tileCount;
};

describe( "installBehaviorLoop worker gathering", () => {
    afterEach( () => {
        jest.useRealTimers();
    } );

    it( "right-clicks mineral patches for mineral workers", () => {
        const openBW = makeOpenBW( [
            { id: 10, typeId: 0x07, owner: 0, x: 100, y: 100 },
            { id: 20, typeId: 0xb0, owner: 11, x: 104, y: 104 },
        ] );
        const behavior = installBehaviorLoop( { openBW, intervalMs: 60_000 } );

        behavior.register( {
            hermesId: "worker",
            unitId: 10,
            typeId: 0x07,
            placement: {
                px: 100,
                py: 100,
                role: "worker-near-resource",
                targetResourcePx: 104,
                targetResourcePy: 104,
                targetResourceType: "mineral",
            },
        } );
        behavior.tick();
        behavior.dispose();

        expect( openBW.issued ).toContainEqual( {
            unitId: 10,
            commandType: 5,
            targetUnitId: 20,
        } );
    } );

    it( "right-clicks each race's gas building for gas workers", () => {
        const gasTypeIds = [ 0x6e, 0x95, 0x9d ];

        for ( const gasTypeId of gasTypeIds ) {
            const openBW = makeOpenBW( [
                { id: 10, typeId: 0x07, owner: 0, x: 100, y: 100 },
                { id: 30, typeId: gasTypeId, owner: 0, x: 112, y: 112 },
            ] );
            const behavior = installBehaviorLoop( { openBW, intervalMs: 60_000 } );

            behavior.register( {
                hermesId: `worker-${gasTypeId}`,
                unitId: 10,
                typeId: 0x07,
                placement: {
                    px: 100,
                    py: 100,
                    role: "worker-near-resource",
                    targetResourcePx: 112,
                    targetResourcePy: 112,
                    targetResourceType: "gas",
                },
            } );
            behavior.tick();
            behavior.dispose();

            expect( openBW.issued ).toContainEqual( {
                unitId: 10,
                commandType: 5,
                targetUnitId: 30,
            } );
        }
    } );

    it( "sets mineral carry state while dwelling at a mineral patch", () => {
        jest.useFakeTimers();
        const heap = new Int32Array(4096);
        const workerAddress = 0x1000;
        const unitAddr32 = ( workerAddress >> 2 ) + 2;
        const openBW = makeOpenBW( [
            { id: 10, typeId: 0x07, owner: 0, x: 104, y: 104, _address: workerAddress },
            { id: 20, typeId: 0xb0, owner: 11, x: 104, y: 104 },
            { id: 30, typeId: 0x6a, owner: 0, x: 80, y: 80 },
        ] );
        openBW.HEAP32 = heap;
        const behavior = installBehaviorLoop( { openBW, intervalMs: 60_000 } );

        behavior.register( {
            hermesId: "worker",
            unitId: 10,
            typeId: 0x07,
            placement: {
                px: 104,
                py: 104,
                role: "worker-near-resource",
                targetResourcePx: 104,
                targetResourcePy: 104,
                targetResourceType: "mineral",
            },
        } );

        jest.advanceTimersByTime( 2_100 );
        expect( getHermesUnitVisualAction( 10 ) ).toMatchObject( {
            kind: "gathering",
            resource: "mineral",
        } );
        behavior.dispose();

        expect( heap[unitAddr32 + 114] ).toBe( 1 );
        expect( heap[unitAddr32 + 113] & 0x800000 ).toBe( 0x800000 );
    } );

    it( "sets gas carry state while dwelling at a gas building", () => {
        jest.useFakeTimers();
        const heap = new Int32Array(4096);
        const workerAddress = 0x1200;
        const unitAddr32 = ( workerAddress >> 2 ) + 2;
        const openBW = makeOpenBW( [
            { id: 10, typeId: 0x07, owner: 0, x: 112, y: 112, _address: workerAddress },
            { id: 20, typeId: 0x9d, owner: 0, x: 112, y: 112 },
            { id: 30, typeId: 0x9a, owner: 0, x: 80, y: 80 },
        ] );
        openBW.HEAP32 = heap;
        const behavior = installBehaviorLoop( { openBW, intervalMs: 60_000 } );

        behavior.register( {
            hermesId: "worker",
            unitId: 10,
            typeId: 0x40,
            placement: {
                px: 112,
                py: 112,
                role: "worker-near-resource",
                targetResourcePx: 112,
                targetResourcePy: 112,
                targetResourceType: "gas",
            },
        } );

        jest.advanceTimersByTime( 2_100 );
        expect( getHermesUnitVisualAction( 10 ) ).toMatchObject( {
            kind: "gathering",
            resource: "gas",
        } );
        behavior.dispose();

        expect( heap[unitAddr32 + 114] ).toBe( 2 );
        expect( heap[unitAddr32 + 113] & 0x800000 ).toBe( 0x800000 );
    } );

    it( "updates worker facing while moving between resource and depot", () => {
        jest.useFakeTimers();
        const heap32 = new Int32Array(4096);
        const heap8 = new Int8Array(heap32.buffer);
        const workerAddress = 0x1400;
        const unitAddr8 = workerAddress + ( 2 << 2 );
        const openBW = makeOpenBW( [
            { id: 10, typeId: 0x07, owner: 0, x: 96, y: 96, _address: workerAddress },
            { id: 20, typeId: 0xb0, owner: 11, x: 160, y: 96 },
            { id: 30, typeId: 0x6a, owner: 0, x: 80, y: 96 },
        ] );
        openBW.HEAP32 = heap32;
        openBW.HEAP8 = heap8;
        const behavior = installBehaviorLoop( { openBW, intervalMs: 60_000 } );

        behavior.register( {
            hermesId: "worker",
            unitId: 10,
            typeId: 0x07,
            placement: {
                px: 96,
                py: 96,
                role: "worker-near-resource",
                targetResourcePx: 160,
                targetResourcePy: 96,
                targetResourceType: "mineral",
            },
        } );

        jest.advanceTimersByTime( 1_950 );
        const firstDirection = heap8[unitAddr8 + ( 11 << 2 )] & 0xff;
        jest.advanceTimersByTime( 3_500 );
        const returnDirection = heap8[unitAddr8 + ( 11 << 2 )] & 0xff;
        const action = getHermesUnitVisualAction( 10 );
        behavior.dispose();

        expect( firstDirection ).toBe( 64 );
        expect( returnDirection ).not.toBe( firstDirection );
        expect( action?.direction32 ).toBeDefined();
    } );

    it( "stagger-shifts patrol orders and gives clumped units distinct local targets", () => {
        jest.useFakeTimers();
        const openBW = makeOpenBW( [
            { id: 101, typeId: 0x00, owner: 0, x: 500, y: 500 },
            { id: 102, typeId: 0x00, owner: 0, x: 500, y: 500 },
            { id: 103, typeId: 0x00, owner: 0, x: 500, y: 500 },
        ] );
        const behavior = installBehaviorLoop( { openBW, intervalMs: 60_000 } );
        const waypoints = [
            { px: 640, py: 500 },
            { px: 640, py: 640 },
            { px: 500, py: 640 },
            { px: 500, py: 500 },
        ];

        for ( const unitId of [ 101, 102, 103 ] ) {
            behavior.register( {
                hermesId: `patrol-${unitId}`,
                unitId,
                typeId: 0x00,
                placement: {
                    px: 500,
                    py: 500,
                    role: "front-patrol",
                    waypoints,
                },
            } );
        }

        jest.advanceTimersByTime( 3_500 );
        behavior.tick();
        behavior.dispose();

        const orderedTargets = new Set(
            openBW.issued.map( ( issue ) => `${issue.targetUnitId}:${issue.commandType}` )
        );
        const targetPositions = new Set( openBW.issuedTargets.map( ( issue ) => `${issue.x},${issue.y}` ) );
        expect( orderedTargets ).toEqual( new Set( [ "0:2" ] ) );
        expect( targetPositions.size ).toBeGreaterThan( 1 );
    } );

    it( "keeps completed-render behavior visual-only without engine order or pathing calls", () => {
        jest.useFakeTimers();
        const openBW = makeOpenBW( [
            { id: 101, typeId: 0x00, owner: 0, x: 500, y: 500 },
        ] );
        openBW._is_reachable = () => {
            throw new Error( "should not path in visual-only mode" );
        };
        openBW.get_util_funcs = () => ( {
            issue_command: () => {
                throw new Error( "should not issue commands in visual-only mode" );
            },
        } );
        const behavior = installBehaviorLoop( {
            openBW,
            intervalMs: 500,
            engineOrders: false,
        } );

        behavior.register( {
            hermesId: "visual-only-patrol",
            unitId: 101,
            typeId: 0x00,
            placement: {
                px: 500,
                py: 500,
                role: "front-patrol",
                waypoints: [
                    { px: 640, py: 500 },
                    { px: 640, py: 640 },
                ],
            },
        } );

        expect( () => jest.advanceTimersByTime( 2_000 ) ).not.toThrow();
        behavior.dispose();
        expect( openBW.issuedTargets ).toHaveLength( 0 );
    } );

    it( "does not visually move ground patrol units across non-walkable tiles", () => {
        jest.useFakeTimers();
        const heap32 = new Int32Array(4096);
        const unitAddress = 0x1600;
        const unitAddr32 = ( unitAddress >> 2 ) + 2;
        const openBW = makeOpenBW( [
            { id: 101, typeId: 0x00, owner: 0, x: 48, y: 48, _address: unitAddress },
        ] );
        openBW.HEAP32 = heap32;
        attachTileFlags(
            openBW,
            5,
            5,
            Array.from( { length: 5 }, ( _, ty ) => ( { tx: 2, ty } ) )
        );
        const behavior = installBehaviorLoop( {
            openBW,
            intervalMs: 500,
            engineOrders: false,
            mapWidthTiles: 5,
            mapHeightTiles: 5,
        } );

        behavior.register( {
            hermesId: "blocked-patrol",
            unitId: 101,
            typeId: 0x00,
            placement: {
                px: 48,
                py: 48,
                role: "front-patrol",
                waypoints: [ { px: 144, py: 48 } ],
            },
        } );

        jest.advanceTimersByTime( 2_000 );
        behavior.dispose();

        expect( heap32[unitAddr32 + 16] ).toBeLessThan( 64 );
    } );

    it( "allows flying units to visually cross non-walkable tiles", () => {
        jest.useFakeTimers();
        const heap32 = new Int32Array(4096);
        const unitAddress = 0x1800;
        const unitAddr32 = ( unitAddress >> 2 ) + 2;
        const openBW = makeOpenBW( [
            { id: 102, typeId: 0x08, owner: 0, x: 48, y: 48, _address: unitAddress },
        ] );
        openBW.HEAP32 = heap32;
        attachTileFlags(
            openBW,
            5,
            5,
            Array.from( { length: 5 }, ( _, ty ) => ( { tx: 2, ty } ) )
        );
        const behavior = installBehaviorLoop( {
            openBW,
            intervalMs: 500,
            engineOrders: false,
            mapWidthTiles: 5,
            mapHeightTiles: 5,
        } );

        behavior.register( {
            hermesId: "flying-patrol",
            unitId: 102,
            typeId: 0x08,
            placement: {
                px: 48,
                py: 48,
                role: "front-patrol",
                waypoints: [ { px: 144, py: 48 } ],
            },
        } );

        jest.advanceTimersByTime( 2_000 );
        behavior.dispose();

        expect( heap32[unitAddr32 + 16] ).toBeGreaterThan( 64 );
    } );
} );
