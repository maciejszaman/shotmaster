const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
  openVideo: () => ipcRenderer.invoke("open-video"),
  pathForFile: (file) => webUtils.getPathForFile(file),
  probe: (file) => ipcRenderer.invoke("probe", file),
  exportVideo: (opts) => ipcRenderer.invoke("export", opts),
  compress: (opts) => ipcRenderer.invoke("compress", opts),
  cancel: () => ipcRenderer.invoke("cancel"),
  listRecent: () => ipcRenderer.invoke("list-recent"),
  thumb: (file) => ipcRenderer.invoke("thumb", file),
  showInFolder: (file) => ipcRenderer.invoke("show-in-folder", file),
  onProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("progress", listener);
    return () => ipcRenderer.removeListener("progress", listener);
  },
});
