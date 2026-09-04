/// <reference path="./index.d.ts" />

import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type MunhaeApi } from "../shared/munhae-api";

const api = {
  app: {
    getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.appGetVersion),
    getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.appGetConfig),
    setConfig: (patch) => ipcRenderer.invoke(IPC_CHANNELS.appSetConfig, patch),
    probeAgents: () => ipcRenderer.invoke(IPC_CHANNELS.appProbeAgents),
    quit: () => ipcRenderer.invoke(IPC_CHANNELS.appQuit),
    openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.appOpenExternal, url),
    onCommand: (handler) => {
      const listen = (_event: unknown, id: unknown) => {
        if (typeof id === "string") handler(id);
      };
      ipcRenderer.on(IPC_CHANNELS.menuCommand, listen);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.menuCommand, listen);
      };
    },
  },
  project: {
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectCreate, input),
    open: (packagePath) => ipcRenderer.invoke(IPC_CHANNELS.projectOpen, packagePath),
    close: () => ipcRenderer.invoke(IPC_CHANNELS.projectClose),
    getCurrent: () => ipcRenderer.invoke(IPC_CHANNELS.projectGetCurrent),
    listRecent: () => ipcRenderer.invoke(IPC_CHANNELS.projectListRecent),
    backup: () => ipcRenderer.invoke(IPC_CHANNELS.projectBackup),
    createFromPaste: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectCreateFromPaste, input),
    seedDemo: () => ipcRenderer.invoke(IPC_CHANNELS.projectSeedDemo),
  },
  home: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.homeGet),
    createDocument: (input) => ipcRenderer.invoke(IPC_CHANNELS.documentCreate, input),
    pickTextFile: () => ipcRenderer.invoke(IPC_CHANNELS.documentPickText),
  },
  editor: {
    get: (documentNodeId) => ipcRenderer.invoke(IPC_CHANNELS.editorGet, documentNodeId),
    saveDraft: (input) => ipcRenderer.invoke(IPC_CHANNELS.editorSaveDraft, input),
    confirm: (input) => ipcRenderer.invoke(IPC_CHANNELS.editorConfirm, input),
    revise: (documentNodeId, stage) =>
      ipcRenderer.invoke(IPC_CHANNELS.editorRevise, documentNodeId, stage),
    mergeBlocks: (input) => ipcRenderer.invoke(IPC_CHANNELS.editorMergeBlocks, input),
    splitBlock: (input) => ipcRenderer.invoke(IPC_CHANNELS.editorSplitBlock, input),
  },
  knowledge: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.knowledgeGet),
    upsertGlossary: (entry) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeUpsertGlossary, entry),
    upsertPerson: (person) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeUpsertPerson, person),
    upsertPlace: (place) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeUpsertPlace, place),
  },
  context: {
    preview: (input) => ipcRenderer.invoke(IPC_CHANNELS.contextPreview, input),
  },
} satisfies MunhaeApi;

contextBridge.exposeInMainWorld("munhae", api);
