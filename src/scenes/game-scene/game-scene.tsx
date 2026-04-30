import { globalEvents } from "@core/global-events";
import { useEffect, useState } from "react";
import { InGameMenuScene } from "./ingame-menu-scene";
import VRButtonReact from "@render/vr/vr-button-react";
import { renderComposer } from "@render/index";
import { Welcome } from "./welcome";



// Allow the embedder (Hermes dashboard, Playwright, etc) to suppress the
// first-run Welcome modal via URL query params:
//   ?hideWelcome=1   -> set the flag AND hide immediately
//   ?showWelcome=1   -> force the modal to appear (clears the flag)
const resolveHideWelcome = () => {
    try {
        const qs = new URLSearchParams(window.location.search);
        const hide = qs.get("hideWelcome") ?? qs.get("hidewelcome");
        const show = qs.get("showWelcome") ?? qs.get("showwelcome");
        const ls = localStorage.getItem("hideWelcome");
        // eslint-disable-next-line no-console
        console.log("[GameScene] resolveHideWelcome:", {
            url: window.location.search,
            hideParam: hide,
            showParam: show,
            ls,
        });
        if (hide === "1") {
            localStorage.setItem("hideWelcome", "true");
            return true;
        }
        if (show === "1") {
            localStorage.removeItem("hideWelcome");
            return false;
        }
        return ls === "true";
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[GameScene] resolveHideWelcome error:", err);
        return false;
    }
};

export const GameScene = () => {
    const [gameMenu, setGameMenu] = useState(false);
    const [showWelcome, setShowWelcome] = useState(!resolveHideWelcome());

    useEffect(() => {
        const off = globalEvents.on("replay-complete", async () => {
            setGameMenu(true);
        });

        const evtListener = (evt: KeyboardEvent) => {
            if (evt.key === "Escape" && document.pointerLockElement === null) {
                setGameMenu(!gameMenu);
            }
        };

        window.addEventListener("keydown", evtListener);

        // 2026 Hermes embed: listen for the dashboard's "open menu" and
        // "toggle pause" button postMessages (the iframe is cross-origin so
        // KeyboardEvent dispatch from the parent is blocked).
        const onParentMessage = (ev: MessageEvent) => {
            if (!ev.data || typeof ev.data !== "object") return;
            if (ev.data.type === "hermes:open-menu") {
                setGameMenu((prev) => !prev);
            }
        };
        window.addEventListener("message", onParentMessage);

        return () => {
            off();
            window.removeEventListener("keydown", evtListener);
            window.removeEventListener("message", onParentMessage);
        };
    }, []);

    return (
        <>
            {gameMenu && <InGameMenuScene onClose={() => setGameMenu(false)} />}
            {showWelcome && <Welcome onClose={() => {
                setShowWelcome(false);
                localStorage.setItem("hideWelcome", "true");
            }} />}
            <VRButtonReact renderer={renderComposer.glRenderer} />
        </>
    );
};
