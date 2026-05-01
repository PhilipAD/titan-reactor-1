import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import sceneStore from "@stores/scene-store";
import { TRScene, TRSceneID } from "./scene";
import { MapScene } from "./map-scene";
import { LoadingScene } from "./loading-scene";

type StarCraftRace = "protoss" | "terran" | "zerg";
type BootPhase = "splash" | "race" | "loading";

const SPLASH_MS = 1800;
const SELECTED_RACE_LS_KEY = "hermes.titan.selectedRace";

const raceDisplayName: Record< StarCraftRace, string > = {
    protoss: "Protoss",
    terran: "Terran",
    zerg: "Zerg",
};

const cascAssetUrl = ( base: string, cascPath: string, png = false ) => {
    const root = base.replace( /\/$/, "" );
    const encoded = cascPath.split( "/" ).map( encodeURIComponent ).join( "/" );
    return `${root}/${encoded}${png ? "?png=1" : ""}`;
};

const getAssetServerUrl = () => {
    const params = new URLSearchParams( window.location.search );
    return (
        params.get( "assetServerUrl" ) ??
        localStorage.getItem( "assetServerUrl" ) ??
        "http://127.0.0.1:8080"
    );
};

const readSavedRace = (): StarCraftRace | null => {
    try {
        const race = localStorage.getItem( SELECTED_RACE_LS_KEY );
        return race === "protoss" || race === "terran" || race === "zerg" ? race : null;
    } catch {
        return null;
    }
};

const saveSelectedRace = ( race: StarCraftRace ) => {
    try {
        localStorage.setItem( SELECTED_RACE_LS_KEY, race );
    } catch {}
};

const shouldResetRaceSelection = () => {
    try {
        return new URLSearchParams( window.location.search ).has( "hermesResetRace" );
    } catch {
        return false;
    }
};

const clearSavedRace = () => {
    try {
        localStorage.removeItem( SELECTED_RACE_LS_KEY );
    } catch {}
};

const screenStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    overflow: "hidden",
    background: "#000",
};

const splashStageStyle: CSSProperties = {
    position: "relative",
    width: "min(100vw, 133.333vh)",
    maxWidth: 1280,
    aspectRatio: "4 / 3",
    overflow: "hidden",
    background: "#000",
};

const splashImageStyle: CSSProperties = {
    width: "100%",
    height: "100%",
    objectFit: "contain",
};

const imageStyle: CSSProperties = {
    width: "100%",
    height: "100%",
    objectFit: "cover",
};

const raceStageStyle: CSSProperties = {
    position: "relative",
    width: "min(100vw, 133.333vh)",
    maxWidth: 1280,
    aspectRatio: "4 / 3",
    overflow: "hidden",
    background: "#000",
};

const raceButtonStyle: CSSProperties = {
    position: "absolute",
    overflow: "hidden",
    border: 0,
    background: "transparent",
    cursor: "pointer",
    color: "#d9f2ff",
    fontFamily: "\"Courier New\", ui-monospace, monospace",
    zIndex: 10,
};

const raceVideoStyle: CSSProperties = {
    position: "absolute",
    left: "50%",
    bottom: 54,
    maxWidth: "115%",
    maxHeight: "86%",
    transform: "translateX(-50%)",
    transition: "opacity 120ms ease-out, filter 120ms ease-out",
};

const raceVideoXOffset: Record< StarCraftRace, number > = {
    protoss: 0,
    terran: -38,
    zerg: 0,
};

const raceLabelStyle: CSSProperties = {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 14,
    textAlign: "center",
    fontWeight: 700,
    fontSize: 22,
    letterSpacing: "0.12em",
    textShadow: "0 0 10px #00aaff, 0 2px 8px #000",
    textTransform: "uppercase",
};

const loadingPanelStyle: CSSProperties = {
    position: "absolute",
    left: "50%",
    bottom: "10%",
    transform: "translateX(-50%)",
    display: "flex",
    alignItems: "center",
    gap: 16,
    color: "#d9f2ff",
    fontFamily: "\"Courier New\", ui-monospace, monospace",
    fontWeight: 700,
    letterSpacing: "0.08em",
    textShadow: "0 0 10px #000",
};

const spinnerStyle: CSSProperties = {
    width: 34,
    height: 34,
    border: "3px solid rgba(217,242,255,0.28)",
    borderTopColor: "#d9f2ff",
    borderRadius: "50%",
    animation: "hermes-spin 0.85s linear infinite",
};

const rectStyle = ( [x, y, w, h]: [number, number, number, number] ): CSSProperties => ( {
    left: `${( x / 640 ) * 100}%`,
    top: `${( y / 480 ) * 100}%`,
    width: `${( w / 640 ) * 100}%`,
    height: `${( h / 480 ) * 100}%`,
} );

const raceSlots: Record< StarCraftRace, [number, number, number, number] > = {
    protoss: [5, 7, 238, 364],
    terran: [162, 4, 356, 278],
    zerg: [391, 41, 220, 330],
};

const HermesRaceBoot = ( { mapUrl }: { mapUrl: string } ) => {
    const resetRaceSelection = shouldResetRaceSelection();
    const [phase, setPhase] = useState< BootPhase >( () => resetRaceSelection ? "race" : readSavedRace() ? "loading" : "splash" );
    const [selectedRace, setSelectedRace] = useState< StarCraftRace | null >( () => resetRaceSelection ? null : readSavedRace() );
    const [highlightedRace, setHighlightedRace] = useState< StarCraftRace | null >( null );
    const assetServerUrl = getAssetServerUrl();
    const titanReadyRef = useRef< Promise<unknown> | null >( null );

    const splashUrl = useMemo(
        () => cascAssetUrl( assetServerUrl, "SD/glue/title/title.DDS", true ),
        [assetServerUrl]
    );
    const loadingUrl = useMemo(
        () => cascAssetUrl( assetServerUrl, "SD/glue/palnl/backgnd.DDS", true ),
        [assetServerUrl]
    );
    const raceMedia = useMemo(
        () => ( {
            protoss: {
                idle: cascAssetUrl( assetServerUrl, "SD/glue/campaign/prot.webm" ),
                highlight: cascAssetUrl( assetServerUrl, "SD/glue/campaign/proton.webm" ),
            },
            terran: {
                idle: cascAssetUrl( assetServerUrl, "SD/glue/campaign/terr.webm" ),
                highlight: cascAssetUrl( assetServerUrl, "SD/glue/campaign/terron.webm" ),
            },
            zerg: {
                idle: cascAssetUrl( assetServerUrl, "SD/glue/campaign/zerg.webm" ),
                highlight: cascAssetUrl( assetServerUrl, "SD/glue/campaign/zergon.webm" ),
            },
        } ),
        [assetServerUrl]
    );
    useEffect( () => {
        if ( phase !== "splash" ) return;
        const timer = window.setTimeout( () => setPhase( "race" ), SPLASH_MS );
        return () => window.clearTimeout( timer );
    }, [phase] );

    useEffect( () => {
        if ( resetRaceSelection ) {
            clearSavedRace();
        }
    }, [resetRaceSelection] );

    useEffect( () => {
        void fetch( splashUrl, { cache: "force-cache" } ).catch( () => {} );
        void fetch( loadingUrl, { cache: "force-cache" } ).catch( () => {} );
    }, [loadingUrl, splashUrl] );

    useEffect( () => {
        titanReadyRef.current = new LoadingScene().load();
    }, [] );

    useEffect( () => {
        if ( !selectedRace ) return;
        saveSelectedRace( selectedRace );
        window.parent?.postMessage( { type: "titan:race-selected", race: selectedRace }, "*" );
    }, [selectedRace] );

    useEffect( () => {
        if ( phase !== "loading" || !selectedRace ) return;
        let cancelled = false;
        void ( async () => {
            try {
                await ( titanReadyRef.current ?? new LoadingScene().load() );
                const buffer = await fetch( mapUrl, { cache: "force-cache" } ).then( ( res ) => res.arrayBuffer() );
                if ( cancelled ) return;
                await sceneStore().loadScene( new MapScene( buffer ) );
            } catch ( err ) {
                console.error( "[hermes-race-boot] failed to load map:", err );
            }
        } )();
        return () => {
            cancelled = true;
        };
    }, [mapUrl, phase, selectedRace] );

    const selectRace = ( race: StarCraftRace ) => {
        setSelectedRace( race );
        setPhase( "loading" );
    };

    if ( phase === "splash" ) {
        return (
            <div style={screenStyle}>
                <div style={splashStageStyle}>
                    <img src={splashUrl} alt="StarCraft Remastered title splash" style={splashImageStyle} />
                </div>
            </div>
        );
    }

    if ( phase === "loading" ) {
        return (
            <div style={screenStyle}>
                <style>{"@keyframes hermes-spin { to { transform: rotate(360deg); } }"}</style>
                <img src={loadingUrl} alt="StarCraft loading background" style={imageStyle} />
                <div style={loadingPanelStyle}>
                    <div style={spinnerStyle} />
                    <div>Preparing {selectedRace ? raceDisplayName[selectedRace] : "StarCraft"} base</div>
                </div>
            </div>
        );
    }

    return (
        <div style={screenStyle}>
            <div style={raceStageStyle}>
                {( ["protoss", "terran", "zerg"] as StarCraftRace[] ).map( ( race ) => (
                    <button
                        key={race}
                        type="button"
                        onClick={() => selectRace( race )}
                        onMouseEnter={() => setHighlightedRace( race )}
                        onMouseLeave={() => setHighlightedRace( ( current ) => current === race ? null : current )}
                        onFocus={() => setHighlightedRace( race )}
                        onBlur={() => setHighlightedRace( ( current ) => current === race ? null : current )}
                        style={{
                            ...raceButtonStyle,
                            ...rectStyle( raceSlots[race] ),
                        }}
                        aria-label={`Select ${raceDisplayName[race]}`}
                    >
                        <video
                            data-race-video={`${race}-idle`}
                            src={raceMedia[race].idle}
                            autoPlay
                            muted
                            loop
                            preload="auto"
                            playsInline
                            style={{
                                ...raceVideoStyle,
                                transform: `translateX(calc(-50% + ${raceVideoXOffset[race]}px))`,
                                zIndex: 2,
                                opacity: 1,
                                filter: highlightedRace === race ? "brightness(1.1)" : "none",
                            }}
                        />
                        <video
                            data-race-video={`${race}-highlight`}
                            src={raceMedia[race].highlight}
                            autoPlay
                            muted
                            loop
                            preload="auto"
                            playsInline
                            style={{
                                ...raceVideoStyle,
                                transform: `translateX(calc(-50% + ${raceVideoXOffset[race]}px))`,
                                zIndex: 1,
                                opacity: highlightedRace === race ? 1 : 0,
                                filter: "brightness(1.18) saturate(1.15)",
                            }}
                        />
                        <span style={raceLabelStyle}>{raceDisplayName[race]}</span>
                    </button>
                ) )}
            </div>
        </div>
    );
};

export class HermesRaceBootScene implements TRScene {
    id: TRSceneID = "@hermes-race-boot";

    constructor( private readonly mapUrl: string ) {}

    async load() {
        return {
            component: <HermesRaceBoot mapUrl={this.mapUrl} />,
        };
    }
}
