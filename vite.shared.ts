import aliases from "./build/aliases";
import { UserConfigExport } from "vite";
import path from "path";
import { createRequire } from "module";
import tsConfig from "./tsconfig.json";

const require = createRequire(import.meta.url);

const alias = Object.entries(aliases).reduce(
    (acc, [key, aliasPath]) => {
        acc[key] = path.resolve(aliasPath);
        return acc;
    },
    {
        common: path.resolve("./src/common"),
        // Node built-in shims for scm-extractor / bl / readable-stream which
        // call util.inherits, require("events"), etc. at module-load time.
        // Note: we intentionally don't alias "process" itself because the npm
        // `process` package's browser entry is already `process/browser`.
        util: require.resolve("util/"),
        events: require.resolve("events/"),
        stream: require.resolve("stream-browserify"),
    }
);

const SHIM = path.resolve("./build/optimize-deps-shim.js");

export const sharedViteConfig: () => UserConfigExport = () => ({
    // titan-reactor is the subfolder in the black-sheep-wall public dir
    resolve: {
        alias,
    },
    // Node-style modules bundled through optimizeDeps (scm-extractor, bw-chk,
    // readable-stream, bl, implode-decoder, ...) reference bare `process` /
    // `Buffer` at module-load time. Inject a shim that sets globalThis.process
    // and globalThis.Buffer before any of that runs.
    optimizeDeps: {
        include: [
            "process/browser",
            "buffer",
            "util",
            "events",
            "stream-browserify",
            "scm-extractor",
            "concat-stream",
        ],
        esbuildOptions: {
            target: tsConfig.compilerOptions.target,
            define: {
                global: "globalThis",
            },
            supported: {
                bigint: true,
            },
            inject: [SHIM],
        },
    },
});
