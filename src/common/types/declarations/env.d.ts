/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_PLUGINS_RUNTIME_ENTRY: string
    readonly VITE_OFFICIAL_PLUGINS_SERVER_URL: string
    readonly VITE_PLUGINS_RUNTIME_ENTRY_URL: string
    /** Set to "1" on VMs / llvmpipe / RDP where WebGL context creation fails with ANGLE defaults. */
    readonly VITE_TITAN_WEBGL_COMPAT?: string
    // more env variables...
  }
  
  interface ImportMeta {
    readonly env: ImportMetaEnv
  }