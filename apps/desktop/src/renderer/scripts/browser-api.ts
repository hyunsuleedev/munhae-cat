import { IPC_CHANNELS, type IpcChannel, type MunhaeApi } from "../../shared/munhae-api";

const BRIDGE_URL = "/__munhae/api";

async function invoke<T>(channel: IpcChannel, ...args: unknown[]): Promise<T> {
  const response = await fetch(BRIDGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, args }),
  });
  const payload = await response.json() as { value?: T; error?: string };
  if (!response.ok) throw new Error(payload.error ?? "Electron 브리지에 연결할 수 없습니다.");
  return payload.value as T;
}

export function createBrowserApi(): MunhaeApi {
  return {
    app: {
      getVersion: () => invoke(IPC_CHANNELS.appGetVersion),
      getConfig: () => invoke(IPC_CHANNELS.appGetConfig),
      setConfig: (patch) => invoke(IPC_CHANNELS.appSetConfig, patch),
      probeAgents: () => invoke(IPC_CHANNELS.appProbeAgents),
      quit: () => invoke(IPC_CHANNELS.appQuit),
      openExternal: (url) => invoke(IPC_CHANNELS.appOpenExternal, url),
      onCommand: () => () => undefined,
    },
    project: {
      create: (input) => invoke(IPC_CHANNELS.projectCreate, input),
      open: (packagePath) => invoke(IPC_CHANNELS.projectOpen, packagePath),
      close: () => invoke(IPC_CHANNELS.projectClose),
      getCurrent: () => invoke(IPC_CHANNELS.projectGetCurrent),
      listRecent: () => invoke(IPC_CHANNELS.projectListRecent),
      backup: () => invoke(IPC_CHANNELS.projectBackup),
      createFromPaste: (input) => invoke(IPC_CHANNELS.projectCreateFromPaste, input),
      seedDemo: () => invoke(IPC_CHANNELS.projectSeedDemo),
    },
    home: {
      get: () => invoke(IPC_CHANNELS.homeGet),
      createDocument: (input) => invoke(IPC_CHANNELS.documentCreate, input),
      pickTextFile: () => invoke(IPC_CHANNELS.documentPickText),
    },
    editor: {
      get: (documentNodeId) => invoke(IPC_CHANNELS.editorGet, documentNodeId),
      saveDraft: (input) => invoke(IPC_CHANNELS.editorSaveDraft, input),
      confirm: (input) => invoke(IPC_CHANNELS.editorConfirm, input),
      revise: (documentNodeId, stage) => invoke(IPC_CHANNELS.editorRevise, documentNodeId, stage),
      mergeBlocks: (input) => invoke(IPC_CHANNELS.editorMergeBlocks, input),
      splitBlock: (input) => invoke(IPC_CHANNELS.editorSplitBlock, input),
    },
    knowledge: {
      get: () => invoke(IPC_CHANNELS.knowledgeGet),
      upsertGlossary: (entry) => invoke(IPC_CHANNELS.knowledgeUpsertGlossary, entry),
      upsertPerson: (person) => invoke(IPC_CHANNELS.knowledgeUpsertPerson, person),
      upsertPlace: (place) => invoke(IPC_CHANNELS.knowledgeUpsertPlace, place),
    },
    context: {
      preview: (input) => invoke(IPC_CHANNELS.contextPreview, input),
    },
  };
}
