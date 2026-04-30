// import { showFolderDialog } from "@ipc";
import { useProcessStore } from "@stores/process-store";
import { useEffect } from "react";
import titanReactorLogo from "@image/assets/logo.png";
import { StoreApi, UseBoundStore } from "zustand";
import { LoadingSceneStore } from "../loading-scene";

const styleCenterText: React.CSSProperties = {
    position: "absolute",
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
    cursor: "wait",
    color: "#ffeedd",
    fontFamily: "Conthrax",
    display: "flex",
    flexDirection: "column",
    textAlign: "center"
};

// const requestLogin = async () => {
//     const res = await supabase.auth.signInWithOtp({
//         email,
//         options: {
//             emailRedirectTo: import.meta.env.BASE_URL
//         }
//     });

//     if (res.error) {
//         alert(res.error.message);
//         return;
//     }

//     if (res.data.session) {
//         alert("Check your email for a login link");
//     }
// }

// Hermes 2026-04 viewport-blur fix: when the loading scene runs inside
// the Hermes dashboard iframe (or any embedder), the desktop-style
// `body.backdropFilter = blur(20px) brightness(0)` overlay causes the
// main viewport to render fully black/blurry — even AFTER the loading
// scene unmounts, because the subscription callback fires once more
// with `progress === 1` (so `brightness === 0`) right around the
// unmount race window. Detect the embedder via `?hideWelcome=1` and
// skip the body backdrop entirely in that mode.
const isEmbedderMode = () => {
    try {
        const qs = new URLSearchParams( window.location.search );
        if ( qs.get( "hideWelcome" ) === "1" || qs.get( "hidewelcome" ) === "1" ) {
            return true;
        }
        if ( window.self !== window.top ) return true;
    } catch {
        return true;
    }
    return false;
};

const clearBodyBackdrop = () => {
    document.body.style.backdropFilter = "";
    document.body.style.background = "";
    ( document.body.style as unknown as { webkitBackdropFilter?: string } ).webkitBackdropFilter = "";
};

export const LoadingSceneUI = ( {useStore} : {useStore: UseBoundStore<StoreApi<LoadingSceneStore>> }  ) => {

    const {  pluginsReady, assetServerReady } = useStore( state => state );

    useEffect( () => {
        if ( isEmbedderMode() ) {
            clearBodyBackdrop();
            return;
        }
        let mounted = true;
        const unsubscribe = useProcessStore.subscribe( ( store ) => {
            if ( !mounted ) return;
            const b = ( 1 - store.getTotalProgress() ) * 0.2;
            document.body.style.backdropFilter = `blur(20px) grayscale(0.2) contrast(0.5) brightness(${b})`;
        } );
        return () => {
            mounted = false;
            unsubscribe();
            clearBodyBackdrop();
        };
    }, [] );

    useEffect( () => {
        if ( isEmbedderMode() ) {
            clearBodyBackdrop();
            return () => clearBodyBackdrop();
        }
        document.body.style.backdropFilter =
            "blur(20px) grayscale(0.2) contrast(0.5) brightness(0.2)";
        document.body.style.background = `url(${titanReactorLogo}) center center / cover`;
        return () => {
            clearBodyBackdrop();
        };
    }, [] );

    const waitingFor = [];
    if (!assetServerReady) waitingFor.push("local asset server");
    if (!pluginsReady) waitingFor.push("plugin server");

    return (
        <div
            style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: "100%",
                height: "100%",
                display: "flex",
                flexDirection: "column",
            }}>
            <div style={styleCenterText}>
                {waitingFor.length === 0 && (
                    <p>Preparing Your Journey</p>
                )}
                {(waitingFor.length > 0) && (
                    <>
                        <p>Waiting for: {waitingFor.join(", ")}</p>
                    </>
                )}
                {!assetServerReady && <a href="https://github.com/alexpineda/cascbridge/releases/latest" target="_blank" style={{color: "var(--blue-400)", fontFamily: "sans-serif", marginTop:"3rem"}}> (You may need to download CASCBridge - Local Asset Server)</a>}
            </div>
        </div>
    );
};
