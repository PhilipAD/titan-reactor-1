import { computeBaseLayout, type HermesEntityShape } from "./hermes-base-layout";

const baseCtx = {
    mapWidthTiles: 64,
    mapHeightTiles: 64,
    centerPx: 1024,
    centerPy: 1024,
    seed: 1234,
};

const tileRect = ( px: number, py: number, wTiles: number, hTiles: number ) => {
    const cTileX = Math.floor( px / 32 );
    const cTileY = Math.floor( py / 32 );
    const left = cTileX - Math.floor( wTiles / 2 );
    const top = cTileY - Math.floor( hTiles / 2 );
    return {
        left,
        right: left + wTiles - 1,
        top,
        bottom: top + hTiles - 1,
    };
};

const overlaps = (
    a: ReturnType< typeof tileRect >,
    b: ReturnType< typeof tileRect >
): boolean =>
    a.left <= b.right &&
    a.right >= b.left &&
    a.top <= b.bottom &&
    a.bottom >= b.top;

describe( "computeBaseLayout", () => {
    it( "does not place normal buildings on mineral fields", () => {
        const layout = computeBaseLayout(
            [
                { id: "cc", scType: "CommandCenter" },
                { id: "depot", scType: "SupplyDepot" },
            ],
            {
                ...baseCtx,
                resources: [
                    { px: 1024, py: 1024, type: "mineral" },
                    { px: 1024, py: 1472, type: "mineral" },
                ],
                validatePlacement: () => true,
                scTypeToUnitTypeId: {
                    CommandCenter: 0x6a,
                    SupplyDepot: 0x6d,
                },
            }
        );

        expect( layout.get( "cc" ) ).toBeDefined();
        expect( layout.get( "cc" ) ).not.toMatchObject( {
            px: 1024,
            py: 1024,
        } );
    } );

    it( "allows refinery equivalents to use gas geysers", () => {
        const entities: HermesEntityShape[] = [
            { id: "terran", scType: "Refinery" },
            { id: "zerg", scType: "Extractor" },
            { id: "protoss", scType: "Assimilator" },
        ];

        const layout = computeBaseLayout( entities, {
            ...baseCtx,
            resources: [
                { px: 704, py: 704, type: "gas" },
                { px: 1152, py: 704, type: "gas" },
                { px: 1600, py: 704, type: "gas" },
            ],
            validatePlacement: () => true,
            scTypeToUnitTypeId: {
                Refinery: 0x6e,
                Extractor: 0x95,
                Assimilator: 0x9d,
            },
        } );

        const placed = [ "terran", "zerg", "protoss" ].map( ( id ) =>
            layout.get( id )
        );
        expect( placed ).toEqual(
            expect.arrayContaining( [
                expect.objectContaining( {
                    targetResourceType: "gas",
                } ),
            ] )
        );
        expect( new Set( placed.map( ( p ) => `${p?.px},${p?.py}` ) ).size ).toBe( 3 );
    } );

    it( "keeps building footprints from overlapping", () => {
        const layout = computeBaseLayout(
            Array.from( { length: 8 }, ( _, i ) => ( {
                id: `depot-${i}`,
                scType: "SupplyDepot",
            } ) ),
            {
                ...baseCtx,
                validatePlacement: () => true,
                scTypeToUnitTypeId: {
                    SupplyDepot: 0x6d,
                },
            }
        );

        const rects = Array.from( layout.values() ).map( ( p ) =>
            tileRect( p.px, p.py, 3, 2 )
        );
        for ( let i = 0; i < rects.length; i++ ) {
            for ( let j = i + 1; j < rects.length; j++ ) {
                expect( overlaps( rects[i], rects[j] ) ).toBe( false );
            }
        }
    } );

    it( "keeps buildings away from unplaceable-edge candidates when metadata is available", () => {
        const layout = computeBaseLayout(
            [
                { id: "cc", scType: "CommandCenter" },
                { id: "depot", scType: "SupplyDepot" },
            ],
            {
                ...baseCtx,
                centerPx: 1024,
                centerPy: 1024,
                validatePlacement: () => true,
                analyzePlacement: ( { px, py } ) => ( {
                    ok: true,
                    componentId: 1,
                    edgeClearanceTiles: px === 1024 && py === 1024 ? 0 : 4,
                } ),
                scTypeToUnitTypeId: {
                    CommandCenter: 0x6a,
                    SupplyDepot: 0x6d,
                },
            }
        );

        expect( layout.get( "cc" ) ).toBeDefined();
        expect( layout.get( "cc" ) ).not.toMatchObject( { px: 1024, py: 1024 } );
    } );

    it( "prefers the same connected buildable component as the core", () => {
        const componentFor = ( px: number ) => ( px < 1100 ? 1 : 2 );
        const layout = computeBaseLayout(
            [
                { id: "cc", scType: "CommandCenter" },
                { id: "barracks-1", scType: "Barracks" },
                { id: "barracks-2", scType: "Barracks" },
                { id: "depot", scType: "SupplyDepot" },
            ],
            {
                ...baseCtx,
                centerPx: 960,
                centerPy: 1024,
                validatePlacement: () => true,
                analyzePlacement: ( { px } ) => ( {
                    ok: true,
                    componentId: componentFor( px ),
                    edgeClearanceTiles: 5,
                } ),
                scTypeToUnitTypeId: {
                    CommandCenter: 0x6a,
                    Barracks: 0x6f,
                    SupplyDepot: 0x6d,
                },
            }
        );

        const coreComponent = componentFor( layout.get( "cc" )!.px );
        for ( const id of [ "barracks-1", "barracks-2", "depot" ] ) {
            expect( componentFor( layout.get( id )!.px ) ).toBe( coreComponent );
        }
    } );

    it( "keeps a wider tile gap between non-resource buildings", () => {
        const layout = computeBaseLayout(
            Array.from( { length: 6 }, ( _, i ) => ( {
                id: `depot-${i}`,
                scType: "SupplyDepot",
            } ) ),
            {
                ...baseCtx,
                validatePlacement: () => true,
                analyzePlacement: () => ( {
                    ok: true,
                    componentId: 1,
                    edgeClearanceTiles: 6,
                } ),
                scTypeToUnitTypeId: {
                    SupplyDepot: 0x6d,
                },
            }
        );

        const rects = Array.from( layout.values() ).map( ( p ) =>
            tileRect( p.px, p.py, 3, 2 )
        );
        for ( let i = 0; i < rects.length; i++ ) {
            for ( let j = i + 1; j < rects.length; j++ ) {
                const horizontallySeparated =
                    rects[i].right + 1 < rects[j].left ||
                    rects[j].right + 1 < rects[i].left;
                const verticallySeparated =
                    rects[i].bottom + 1 < rects[j].top ||
                    rects[j].bottom + 1 < rects[i].top;
                expect( horizontallySeparated || verticallySeparated ).toBe( true );
            }
        }
    } );

    it( "spreads crowded patrols into distinct outer perimeter lanes", () => {
        const entities = Array.from( { length: 36 }, ( _, i ) => ( {
            id: `marine-${i}`,
            scType: "Marine",
        } ) );

        const layout = computeBaseLayout( entities, baseCtx );
        const placements = entities.map( ( entity ) => layout.get( entity.id )! );
        const movingPatrols = placements.filter( ( placement ) => placement.waypoints );
        const waypointSignatures = new Set(
            movingPatrols.map( ( placement ) =>
                placement.waypoints?.map( ( wp ) => `${wp.px},${wp.py}` ).join( "|" )
            )
        );
        const maxWaypointRadiusByUnit = movingPatrols.map( ( placement ) =>
            Math.max(
                ...( placement.waypoints ?? [] ).map( ( wp ) =>
                    Math.hypot( wp.px - baseCtx.centerPx, wp.py - baseCtx.centerPy )
                )
            )
        );

        expect( waypointSignatures.size ).toBe( movingPatrols.length );
        expect( movingPatrols.length ).toBeGreaterThan( 24 );
        expect( Math.min( ...maxWaypointRadiusByUnit ) ).toBeGreaterThanOrEqual( 24 * 32 - 2 );
        expect( Math.max( ...maxWaypointRadiusByUnit ) ).toBeGreaterThanOrEqual( 28 * 32 - 2 );
    } );

    it( "leaves some crowded perimeter units as static posts", () => {
        const entities = Array.from( { length: 20 }, ( _, i ) => ( {
            id: `marine-${i}`,
            scType: "Marine",
        } ) );

        const layout = computeBaseLayout( entities, baseCtx );
        const staticPosts = entities
            .map( ( entity ) => layout.get( entity.id )! )
            .filter( ( placement ) => placement.role === "static-post" );

        expect( staticPosts.length ).toBeGreaterThan( 0 );
        expect( staticPosts.every( ( placement ) => !placement.waypoints ) ).toBe( true );
    } );

    it( "keeps non-worker patrol units away from nearby resource patches", () => {
        const entities: HermesEntityShape[] = [
            { id: "marine-a", scType: "Marine" },
            { id: "marine-b", scType: "Marine" },
        ];
        const resources = [
            { px: baseCtx.centerPx + 24 * 32, py: baseCtx.centerPy, type: "mineral" as const },
            { px: baseCtx.centerPx + 28 * 32, py: baseCtx.centerPy, type: "gas" as const },
        ];

        const layout = computeBaseLayout( entities, { ...baseCtx, resources } );
        const placements = entities.map( ( entity ) => layout.get( entity.id )! );

        for ( const placement of placements ) {
            const points = [
                { px: placement.px, py: placement.py },
                ...( placement.waypoints ?? [] ),
            ];
            for ( const point of points ) {
                const nearestResourceDistance = Math.min(
                    ...resources.map( ( resource ) =>
                        Math.hypot( point.px - resource.px, point.py - resource.py )
                    )
                );
                expect( nearestResourceDistance ).toBeGreaterThanOrEqual( 8 * 32 );
            }
        }
    } );

    it( "keeps ground patrol units on the core walkable component with edge clearance", () => {
        const componentFor = ( px: number ) => ( px < 1280 ? 1 : 2 );
        const edgeClearanceFor = ( px: number, py: number ) =>
            px < 160 || py < 160 || px > 1888 || py > 1888 ? 1 : 5;
        const entities: HermesEntityShape[] = [
            { id: "cc", scType: "CommandCenter" },
            ...Array.from( { length: 8 }, ( _, i ) => ( {
                id: `marine-${i}`,
                scType: "Marine",
            } ) ),
        ];

        const layout = computeBaseLayout( entities, {
            ...baseCtx,
            validatePlacement: () => true,
            analyzePlacement: ( { px, py } ) => ( {
                ok: edgeClearanceFor( px, py ) >= 3,
                componentId: componentFor( px ),
                edgeClearanceTiles: edgeClearanceFor( px, py ),
            } ),
            scTypeToUnitTypeId: {
                CommandCenter: 0x6a,
                Marine: 0x00,
            },
        } );
        const coreComponent = componentFor( layout.get( "cc" )!.px );

        for ( const entity of entities.filter( ( e ) => e.scType === "Marine" ) ) {
            const placement = layout.get( entity.id )!;
            const points = [
                { px: placement.px, py: placement.py },
                ...( placement.waypoints ?? [] ),
            ];
            for ( const point of points ) {
                expect( componentFor( point.px ) ).toBe( coreComponent );
                expect( edgeClearanceFor( point.px, point.py ) ).toBeGreaterThanOrEqual( 3 );
            }
        }
    } );

    it( "keeps non-worker units and patrol paths clear of the core and buildings", () => {
        const entities: HermesEntityShape[] = [
            { id: "cc", scType: "CommandCenter" },
            { id: "barracks", scType: "Barracks" },
            { id: "starport", scType: "Starport" },
            { id: "worker", scType: "SCV" },
            { id: "marine", scType: "Marine" },
            { id: "wraith", scType: "Wraith" },
            { id: "science-vessel", scType: "ScienceVessel" },
        ];

        const layout = computeBaseLayout( entities, baseCtx );
        const buildings = [
            { placement: layout.get( "cc" )!, wTiles: 4, hTiles: 3, minTiles: 10 },
            { placement: layout.get( "barracks" )!, wTiles: 4, hTiles: 3, minTiles: 5 },
            { placement: layout.get( "starport" )!, wTiles: 4, hTiles: 3, minTiles: 5 },
        ];

        for ( const id of [ "marine", "wraith", "science-vessel" ] ) {
            const placement = layout.get( id )!;
            const points = [
                { px: placement.px, py: placement.py },
                ...( placement.waypoints ?? [] ),
            ];
            for ( const point of points ) {
                for ( const building of buildings ) {
                    const footprintRadius =
                        Math.hypot( building.wTiles, building.hTiles ) * 32 * 0.5;
                    expect(
                        Math.hypot(
                            point.px - building.placement.px,
                            point.py - building.placement.py
                        )
                    ).toBeGreaterThanOrEqual( building.minTiles * 32 + footprintRadius - 1 );
                }
            }
        }

        expect( layout.get( "worker" ) ).toBeDefined();
    } );

    it( "keeps non-resource buildings out of the resource-to-core corridor", () => {
        const resources = [
            { px: baseCtx.centerPx, py: baseCtx.centerPy + 18 * 32, type: "mineral" as const },
            { px: baseCtx.centerPx + 6 * 32, py: baseCtx.centerPy + 20 * 32, type: "gas" as const },
        ];
        const layout = computeBaseLayout(
            [
                { id: "hatchery", scType: "Hatchery" },
                { id: "extractor", scType: "Extractor" },
                { id: "pool", scType: "SpawningPool" },
                { id: "den", scType: "HydraliskDen" },
            ],
            {
                ...baseCtx,
                resources,
                validatePlacement: () => true,
                analyzePlacement: () => ( {
                    ok: true,
                    componentId: 1,
                    edgeClearanceTiles: 8,
                } ),
                scTypeToUnitTypeId: {
                    Hatchery: 0x83,
                    Extractor: 0x95,
                    SpawningPool: 0x8e,
                    HydraliskDen: 0x87,
                },
            }
        );

        const distancePointToSegment = (
            px: number,
            py: number,
            ax: number,
            ay: number,
            bx: number,
            by: number
        ) => {
            const dx = bx - ax;
            const dy = by - ay;
            const lenSq = dx * dx + dy * dy;
            const t = Math.max( 0, Math.min( 1, ( ( px - ax ) * dx + ( py - ay ) * dy ) / lenSq ) );
            return Math.hypot( px - ( ax + t * dx ), py - ( ay + t * dy ) );
        };

        for ( const id of [ "pool", "den" ] ) {
            const placement = layout.get( id )!;
            for ( const resource of resources ) {
                expect(
                    distancePointToSegment(
                        placement.px,
                        placement.py,
                        baseCtx.centerPx,
                        baseCtx.centerPy,
                        resource.px,
                        resource.py
                    )
                ).toBeGreaterThanOrEqual( 4 * 32 );
            }
        }
    } );

    it( "assigns animation-driving roles for every explicit Terran mobile unit", () => {
        const entities: HermesEntityShape[] = [
            { id: "marine", scType: "Marine" },
            { id: "firebat", scType: "Firebat" },
            { id: "ghost", scType: "Ghost" },
            { id: "vulture", scType: "Vulture" },
            { id: "goliath", scType: "Goliath" },
            { id: "tank", scType: "SiegeTank" },
            { id: "siege", scType: "SiegeTankSiege" },
            { id: "mine", scType: "SpiderMine" },
            { id: "wraith", scType: "Wraith" },
            { id: "dropship", scType: "Dropship" },
            { id: "science-vessel", scType: "ScienceVessel" },
            { id: "battlecruiser", scType: "Battlecruiser" },
            { id: "valkyrie", scType: "Valkyrie" },
            { id: "nuke", scType: "NuclearMissile" },
        ];

        const layout = computeBaseLayout( entities, baseCtx );

        expect( layout.get( "marine" )?.role ).toBe( "front-patrol" );
        expect( layout.get( "firebat" )?.role ).toBe( "front-patrol" );
        expect( layout.get( "ghost" )?.role ).toBe( "front-patrol" );
        expect( layout.get( "vulture" )?.role ).toBe( "front-patrol" );
        expect( layout.get( "goliath" )?.role ).toBe( "front-patrol" );
        expect( layout.get( "tank" )?.role ).toBe( "front-patrol" );
        expect( layout.get( "siege" )?.role ).toBe( "defense-perimeter" );
        expect( layout.get( "mine" )?.role ).toBe( "defense-perimeter" );
        expect( layout.get( "wraith" )?.role ).toBe( "wanderer" );
        expect( layout.get( "dropship" )?.role ).toBe( "wanderer" );
        expect( layout.get( "science-vessel" )?.role ).toBe( "wanderer" );
        expect( layout.get( "battlecruiser" )?.role ).toBe( "wanderer" );
        expect( layout.get( "valkyrie" )?.role ).toBe( "wanderer" );
        expect( layout.get( "nuke" )?.role ).toBe( "wanderer" );
    } );
} );
