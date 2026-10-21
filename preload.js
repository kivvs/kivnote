'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('native', {
  isElectron: true,

  /* 文件 */
  open:        ()        => ipcRenderer.invoke('file:open'),
  openPath:    (p)       => ipcRenderer.invoke('file:openPath', p),
  chunk:       (p, off, len, mode) => ipcRenderer.invoke('file:chunk', { path: p, offset: off, length: len, mode }),
  save:        (p, c)    => ipcRenderer.invoke('file:save', { path: p, content: c }),
  writeBytes:  (p, pat)  => ipcRenderer.invoke('file:writeBytes', { path: p, patches: pat }),
  readAll:     (p)       => ipcRenderer.invoke('file:readAll', p),
  writeBase64: (p, d)    => ipcRenderer.invoke('file:writeBase64', { path: p, data: d }),
  pdfText:     (p)       => ipcRenderer.invoke('pdf:text', p),
  help:        ()        => ipcRenderer.invoke('app:help'),
  docParts:    (p)       => ipcRenderer.invoke('doc:parts', p),
  convert:     (p)       => ipcRenderer.invoke('doc:convert', p),
  loConvert:   (src, to) => ipcRenderer.invoke('lo:convert', { src: src, to: to }),
  loAvailable: ()        => ipcRenderer.invoke('lo:available'),
  cancelConvert:()       => ipcRenderer.invoke('lo:cancel'),
  patchXlsx:   (o)       => ipcRenderer.invoke('xlsx:patchCells', o),
  pptParts:    (p)       => ipcRenderer.invoke('ppt:parts', p),
  pptRender:   (p)       => ipcRenderer.invoke('ppt:renderNative', p),
  saveAs:      (c, name) => ipcRenderer.invoke('file:saveAs', { content: c, name }),
  systemOpen:  (p)       => ipcRenderer.invoke('file:systemOpen', p),
  reveal:      (p)       => ipcRenderer.invoke('file:reveal', p),
  pathForFile: (f)       => { try { return webUtils.getPathForFile(f); } catch (e) { return ''; } },
  cliArg:      ()        => ipcRenderer.invoke('cli:arg'),
  newWindow:   (p)       => ipcRenderer.invoke('win:new', p || null),
  backup:      (p)       => ipcRenderer.invoke('file:backup', p),
  saveAsBinary:(d, n)    => ipcRenderer.invoke('file:saveAsBinary', { data: d, name: n }),
  writeClipboard: (t)    => ipcRenderer.invoke('clip:write', t),

  /* 窗口 */
  win: {
    min:        () => ipcRenderer.send('win:min'),
    toggleMax:  () => ipcRenderer.invoke('win:toggleMax'),
    isMax:      () => ipcRenderer.invoke('win:isMax'),
    close:      () => ipcRenderer.send('win:close'),
    forceClose: () => ipcRenderer.send('win:forceClose')
  },

  setDirty: (v) => ipcRenderer.send('win:dirty', v),

  onMax: (cb) => ipcRenderer.on('win:max', (e, v) => cb(v)),
  onCmd: (cb) => ipcRenderer.on('app:cmd', (e, c) => cb(c))
});
