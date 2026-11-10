/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WEBBOARD_PROBE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
