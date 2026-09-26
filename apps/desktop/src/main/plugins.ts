import { type TranslationSkill } from "@munhae/db-sqlite";
import { IPC_CHANNELS, type IpcChannel, type PluginsView } from "../shared/munhae-api";
import { withAuthenticatedClient } from "./auth";
import { AppError } from "./errors";
import { parsePluginName } from "./ipc-validate";
import { fetchCatalogPlugin, fetchPluginCatalog } from "./plugin-catalog";
import { installPlugin, listInstalledPlugins, removePlugin } from "./plugin-library";
import { getCurrentSummary, pickSkillFile, pluginLibraryDir, requireRepo } from "./session";

export const PLUGIN_CHANNELS: readonly IpcChannel[] = [
  IPC_CHANNELS.pluginsList,
  IPC_CHANNELS.pluginsInstall,
  IPC_CHANNELS.pluginsRemove,
  IPC_CHANNELS.pluginsApply,
  IPC_CHANNELS.pluginsCatalog,
  IPC_CHANNELS.pluginsInstallCatalog,
];

function view(): PluginsView {
  const projectOpen = getCurrentSummary() !== null;
  return {
    installed: listInstalledPlugins(pluginLibraryDir()),
    applied: projectOpen ? requireRepo().getTranslationSkill() : null,
    projectOpen,
  };
}

/** The project keeps its own copy, so removing or updating a library plugin never changes it silently. */
function apply(name: unknown): TranslationSkill | null {
  if (name === null) return requireRepo().setTranslationSkill(null);
  const pluginName = parsePluginName(name);
  const plugin = listInstalledPlugins(pluginLibraryDir()).find((item) => item.name === pluginName);
  if (!plugin) throw new AppError("not_found", "설치된 플러그인을 찾지 못했습니다.");
  return requireRepo().setTranslationSkill(plugin.content);
}

export async function dispatchPlugin(channel: IpcChannel, input: unknown): Promise<unknown> {
  switch (channel) {
    case IPC_CHANNELS.pluginsList: return view();
    case IPC_CHANNELS.pluginsInstall: {
      const content = await pickSkillFile();
      return content === null ? null : installPlugin(pluginLibraryDir(), content);
    }
    case IPC_CHANNELS.pluginsRemove: return removePlugin(pluginLibraryDir(), input as string);
    case IPC_CHANNELS.pluginsApply: return apply(input);
    case IPC_CHANNELS.pluginsCatalog: return fetchPluginCatalog(withAuthenticatedClient);
    case IPC_CHANNELS.pluginsInstallCatalog: {
      // Install what the server publishes, never content sent by the renderer.
      const plugin = await fetchCatalogPlugin(withAuthenticatedClient, parsePluginName(input));
      return installPlugin(pluginLibraryDir(), plugin.content);
    }
    default: throw new AppError("invalid_payload", "허용되지 않은 플러그인 요청입니다.");
  }
}
