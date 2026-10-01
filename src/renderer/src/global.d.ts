import type { HubApi } from "../../preload/index.ts";

declare global {
  interface Window {
    hub: HubApi;
  }
}

export {};
