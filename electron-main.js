const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 550,
    height: 800,
    resizable: false, // Para manter o aspeto do Rufus
    webPreferences: {
      nodeIntegration: true
    }
  });

  // Em desenvolvimento usa o servidor local, em produção o ficheiro index.html
  const isDev = process.env.NODE_ENV === 'development';
  win.loadURL(isDev ? 'http://localhost:3000' : `file://${path.join(__dirname, 'dist/index.html')}`);
}

app.whenReady().then(createWindow);