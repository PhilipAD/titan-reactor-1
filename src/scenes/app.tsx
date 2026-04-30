import { useSceneStore } from "@stores/scene-store";

import { WrappedCanvas } from "@image/canvas/wrapped-canvas";
import { GlobalErrorState } from "./error-state";
import { LoadBar, LoadRing } from "./pre-home-scene/load-bar";
import { useProcessStore } from "@stores/process-store";
import { root } from "@render/root";
import { useEffect, useRef } from "react";

export const App = ({
    surface,
    scene,
    hideCursor,
}: {
    surface?: HTMLCanvasElement;
    scene: React.ReactNode;
    hideCursor?: boolean;
}) => {
    const error = useSceneStore((state) => state.error);
    const isLoading = useSceneStore((state) => state.status === "loading");
    const isPreHomeScene = useSceneStore((state) => state.nextScene?.id === "@loading");

    const itemsRef = useRef<HTMLPreElement>(null);

    useEffect(() => {
        return useProcessStore.subscribe((state) => {
            if (itemsRef.current) {
                const items = state.inProgress()
                    .map(
                        (process) =>
                            process.label +
                            " " +
                            Math.floor((process.current / process.max) * 100) +
                            "%"
                    )
                    .join("\n");
                itemsRef.current!.innerText = items;
            }
        });
    }, []);

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
                cursor: hideCursor ? "none" : "default",
            }}>
            {error && <GlobalErrorState error={error} action={null} />}

            {/* 2026 fix: previously this had zIndex:-1 which pushed the canvas
                behind the App container, so pointerdown events never reached
                the canvas (camera-controls listens on the canvas, so the
                camera was completely frozen for mouse input). With the
                negative z-index removed the canvas is the topmost flex item
                and pointer events flow correctly; UI overlays (Welcome,
                InGame menu) use position:absolute so they paint above. */}
            {surface && <WrappedCanvas canvas={surface} />}
            <LoadBar
                color="#64c857"
                thickness={10}
                style={{
                    marginBottom: "var(--size-10)",
                    visibility: isLoading ? "visible" : "hidden",
                }}
            />
            <div></div>
            {!error && isLoading && !isPreHomeScene &&(
                <>
                    <LoadRing />
                    <pre
                        style={{
                            color: "white",
                            position: "absolute",
                            bottom: "0",
                            right: "0",
                        }}
                        ref={itemsRef}></pre>
                </>
            )}
            {scene}
        </div>
    );
};

type SceneRenderOptions = {
    surface?: HTMLCanvasElement;
    key: string;
    scene: React.ReactNode;
    hideCursor?: boolean;
};
export const renderAppUI = ({
    surface,
    key,
    scene,
    hideCursor,
}: SceneRenderOptions) => {
    root.render(
        <App
            scene={scene}
            surface={surface}
            key={key}
            hideCursor={hideCursor ?? false}
        />
    );
};
