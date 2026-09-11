import type { MunhaeApi } from "../shared/munhae-api";
import type { StartupApi } from "../shared/startup-api";

declare global {
  interface Window {
    munhae: MunhaeApi;
    munhaeStartup?: StartupApi;
  }
}

export {};
