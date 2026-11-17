import type { PluginServerContext } from "@getpaseo/plugin/server";
import { startHopkins } from "./server/app";

export default function hopkins(server: PluginServerContext) {
  return startHopkins(server);
}
