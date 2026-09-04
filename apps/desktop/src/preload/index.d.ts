import type { MunhaeApi } from "../shared/munhae-api";

declare global {
  interface Window {
    munhae: MunhaeApi;
  }
}

export {};
