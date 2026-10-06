/// <reference types="vite/client" />

/** The demo build (`--mode demo`): its own data on this computer, no Firebase (see vite.shared.ts). */
declare const __DEMO__: boolean;

declare global {
  interface Window {
    /** The site's smooth scroll (Lenis), which the shared site components stop while a picture is open larger — never running in the app */
    __lenis?: { stop?: () => void; start?: () => void };
  }
}

export {};
