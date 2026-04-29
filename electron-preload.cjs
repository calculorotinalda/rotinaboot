'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /** Informação da plataforma */
  platform: process.platform,

  /** Lista as drives USB disponíveis no sistema */
  listDrives: () => ipcRenderer.invoke('list-drives'),

  /** Abre diálogo de seleção de ficheiro ISO e retorna o caminho */
  selectIso: () => ipcRenderer.invoke('select-iso'),

  /** Inicia a formatação e gravação da ISO na drive USB */
  formatAndBurn: (opts) => ipcRenderer.send('format-and-burn', opts),

  /** Cancela a operação em curso */
  cancelBurn: () => ipcRenderer.send('cancel-burn'),

  /** Regista callback para receber progresso em tempo real */
  onProgress: (callback) => {
    ipcRenderer.on('burn-progress', (_event, data) => callback(data));
  },

  /** Remove o callback de progresso */
  offProgress: (callback) => {
    ipcRenderer.removeAllListeners('burn-progress');
  },
});
