const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sfscDesktop", {
  pickFolder: () => ipcRenderer.invoke("sfsc:pick-folder")
});
